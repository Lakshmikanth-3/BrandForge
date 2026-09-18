/**
 * Trust engine — deliberately thin.
 *
 * No ML, no staking, no on-chain reputation contract, no weighted consensus. The
 * score is computed from outcomes the bridge already observes while routing real
 * traffic, which is what makes it different from a pre-spend readiness check: it
 * answers "did this endpoint deliver when we paid it", not "is it reachable now".
 *
 * Three rules come from what the live catalog actually did when probed:
 *
 *  1. A cold start is not unreliability. Four services timed out at 20s and then
 *     answered in ~1.5s once warm. So a call that succeeded only after a retry
 *     counts as a success, and its latency is excluded from the latency signal
 *     entirely — that number measured a host waking up, not the service working.
 *     Without this the engine would condemn most of this ecosystem for being on a
 *     free tier.
 *  2. Paying and getting nothing is the worst outcome, worse than a call that
 *     failed before any money moved. It is scored separately and weighted hardest,
 *     because it is the only failure that costs the operator.
 *  3. Too few observations means `unrated`, never a number. A score from 4 calls
 *     must not look like a score from 400.
 *  4. A failure caused by our own bad request is not the service's failure. Sending
 *     a POST endpoint an empty body earned a 400 from a service that works fine;
 *     scoring that against it would have made the record measure our bugs. Those
 *     outcomes are excluded from the window and counted separately.
 *  5. A refusal must not be permanent. Refusing a service stops new observations,
 *     which freezes its score, which keeps it refused: without a way back, one bad
 *     run condemns an endpoint forever. That is exactly what happened -- a service
 *     was driven to 0.44 by our own malformed requests and could never recover,
 *     because the gate prevented the very calls that would have cleared it. So the
 *     gate is a circuit breaker with a half-open state: after a cooldown, a refused
 *     service gets one probationary call to earn its way back.
 */
import type { Store } from "./db.js";

export interface Outcome {
  resourceUrl: string;
  at: string;
  /** The call returned a usable response. */
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  /** A payment settled for this call, whether or not it delivered. */
  settled: boolean;
  /** Null when the service advertises no output schema to check against. */
  schemaOk: boolean | null;
  /** The call only succeeded after a retry, i.e. the host was asleep. */
  coldStart: boolean;
  /**
   * The call failed because OUR request was invalid, not because the service
   * misbehaved. Excluded from scoring entirely.
   */
  clientError?: boolean;
  failureReason: string | null;
}

export type Verdict = "pass" | "warn" | "refuse" | "unrated";

export interface TrustRecord {
  resourceUrl: string;
  /** True when a refused service is being allowed one probationary call. */
  onParole?: boolean;
  /** Null when unrated. Never a fabricated number. */
  score: number | null;
  verdict: Verdict;
  observations: number;
  successRate: number | null;
  /** Calls where money moved but nothing usable came back. */
  paidNothingCount: number;
  medianLatencyMs: number | null;
  schemaConformance: number | null;
  coldStartCount: number;
  /** Failures attributable to our own malformed requests, excluded from the score. */
  clientErrorCount: number;
  lastSeenAt: string | null;
  /** Stated plainly so a caller can judge how much the score is worth. */
  basis: string;
}

/** Below this many observations a service is unrated, not badly rated. */
export const MIN_OBSERVATIONS = 5;

/** Rolling window. Older behaviour still counts, but weighted down by recency. */
export const WINDOW = 50;

export interface TrustPolicy {
  /** Refuse to pay below this score. */
  refuseBelow: number;
  /** Warn between refuseBelow and this. */
  warnBelow: number;
}

export const DEFAULT_POLICY: TrustPolicy = { refuseBelow: 0.6, warnBelow: 0.8 };

/**
 * How long a refused service waits before it is allowed one probationary call.
 *
 * Long enough that a genuinely broken endpoint is not paid repeatedly, short enough
 * that a service which was fixed, or which we wronged, is not stuck for a day.
 */
export const PAROLE_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Latency reference point. A service answering in under this is not penalised;
 * beyond it the latency signal decays. Set against observed reality: the verified
 * curated services answer in 280-680ms warm.
 */
const LATENCY_GOOD_MS = 1_000;
const LATENCY_BAD_MS = 10_000;

/**
 * Recency weight for an outcome at position `i` from newest (0-based).
 *
 * Geometric decay. A service that was bad and is now good recovers over roughly a
 * window, rather than being permanently condemned by old failures.
 */
function recencyWeight(i: number): number {
  return Math.pow(0.94, i);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Maps a latency to [0,1]. Linear between the good and bad reference points. */
function latencyScore(ms: number | null): number {
  if (ms === null) return 1;
  if (ms <= LATENCY_GOOD_MS) return 1;
  if (ms >= LATENCY_BAD_MS) return 0;
  return 1 - (ms - LATENCY_GOOD_MS) / (LATENCY_BAD_MS - LATENCY_GOOD_MS);
}

/**
 * Computes a record from outcomes, newest first.
 *
 * Deterministic: same input, same output. No clock, no randomness — a test pins
 * this, because a score that drifts between runs cannot be sold or trusted.
 */
export function computeRecord(resourceUrl: string, outcomes: Outcome[]): TrustRecord {
  // Our own bad requests are not evidence about the service.
  const clientErrorCount = outcomes.filter((o) => o.clientError === true).length;
  const window = outcomes.filter((o) => o.clientError !== true).slice(0, WINDOW);
  const observations = window.length;

  const paidNothingCount = window.filter((o) => o.settled && !o.ok).length;
  const coldStartCount = window.filter((o) => o.coldStart).length;
  const lastSeenAt = window[0]?.at ?? null;

  if (observations < MIN_OBSERVATIONS) {
    return {
      resourceUrl,
      score: null,
      verdict: "unrated",
      observations,
      successRate: null,
      paidNothingCount,
      medianLatencyMs: null,
      schemaConformance: null,
      coldStartCount,
      clientErrorCount,
      lastSeenAt,
      basis: `unrated: ${observations} observation${observations === 1 ? "" : "s"}, ` +
        `${MIN_OBSERVATIONS} needed`,
    };
  }

  let weightTotal = 0;
  let successWeighted = 0;
  let paidNothingWeighted = 0;

  window.forEach((o, i) => {
    const w = recencyWeight(i);
    weightTotal += w;
    if (o.ok) successWeighted += w;
    if (o.settled && !o.ok) paidNothingWeighted += w;
  });

  const successRate = successWeighted / weightTotal;
  const paidNothingRate = paidNothingWeighted / weightTotal;

  // Cold-start latencies measure the host waking, not the service. Excluded.
  const latencies = window
    .filter((o) => o.ok && !o.coldStart && o.latencyMs !== null)
    .map((o) => o.latencyMs as number);
  const medianLatencyMs = median(latencies);

  const schemaChecked = window.filter((o) => o.schemaOk !== null);
  const schemaConformance =
    schemaChecked.length === 0
      ? null
      : schemaChecked.filter((o) => o.schemaOk === true).length / schemaChecked.length;

  // Weights: delivery dominates, then not-paying-for-nothing, then schema, then
  // speed. Slow but correct beats fast and wrong.
  const parts: { value: number; weight: number }[] = [
    { value: successRate, weight: 0.5 },
    { value: 1 - paidNothingRate, weight: 0.3 },
    { value: latencyScore(medianLatencyMs), weight: 0.1 },
  ];
  if (schemaConformance !== null) {
    parts.push({ value: schemaConformance, weight: 0.1 });
  }

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const raw = parts.reduce((sum, p) => sum + p.value * p.weight, 0) / totalWeight;
  const score = Math.max(0, Math.min(1, raw));

  return {
    resourceUrl,
    score,
    verdict: verdictFor(score, DEFAULT_POLICY),
    observations,
    successRate,
    paidNothingCount,
    medianLatencyMs,
    schemaConformance,
    coldStartCount,
    clientErrorCount,
    lastSeenAt,
    basis:
      `${observations} observation${observations === 1 ? "" : "s"}, ` +
      `recency-weighted over the last ${WINDOW}`,
  };
}

export function verdictFor(score: number | null, policy = DEFAULT_POLICY): Verdict {
  if (score === null) return "unrated";
  if (score < policy.refuseBelow) return "refuse";
  if (score < policy.warnBelow) return "warn";
  return "pass";
}

export class TrustEngine {
  constructor(
    private readonly store: Store,
    private readonly policy: TrustPolicy = DEFAULT_POLICY,
    private readonly now: () => number = Date.now,
    private readonly paroleCooldownMs: number = PAROLE_COOLDOWN_MS,
  ) {}

  get currentPolicy(): TrustPolicy {
    return this.policy;
  }

  record(outcome: Outcome): void {
    this.store.putOutcome(outcome);
  }

  recordFor(resourceUrl: string): TrustRecord {
    const outcomes = this.store.outcomes(resourceUrl, WINDOW);
    const record = computeRecord(resourceUrl, outcomes);
    return { ...record, verdict: verdictFor(record.score, this.policy) };
  }

  /**
   * The payment gate. `unrated` is not a refusal — it is a warning passed to the
   * agent, because refusing everything new would mean the bridge could never build
   * a record in the first place.
   */
  gate(resourceUrl: string): { allow: boolean; record: TrustRecord; reason: string } {
    const record = this.recordFor(resourceUrl);

    if (record.verdict === "refuse") {
      // Half-open: after the cooldown, one call is allowed so the service can earn
      // its way back. Without this a refusal is permanent by construction, because
      // refusing prevents the observations that would clear it.
      if (this.paroleDue(record)) {
        return {
          allow: true,
          record: { ...record, onParole: true },
          reason:
            `probationary call: score ${record.score?.toFixed(2)} is below the ` +
            `${this.policy.refuseBelow} threshold, but the cooldown has elapsed so the ` +
            `service gets one chance to recover`,
        };
      }

      return {
        allow: false,
        record,
        reason:
          `trust score ${record.score?.toFixed(2)} is below the ${this.policy.refuseBelow} ` +
          `threshold (${record.basis})`,
      };
    }

    if (record.verdict === "unrated") {
      return { allow: true, record, reason: record.basis };
    }

    if (record.verdict === "warn") {
      return {
        allow: true,
        record,
        reason: `trust score ${record.score?.toFixed(2)} is low but above the refusal threshold`,
      };
    }

    return { allow: true, record, reason: `trust score ${record.score?.toFixed(2)}` };
  }

  /** True when a refused service has waited out its cooldown. */
  private paroleDue(record: TrustRecord): boolean {
    if (record.lastSeenAt === null) return true;
    const lastSeen = Date.parse(record.lastSeenAt);
    if (Number.isNaN(lastSeen)) return true;
    return this.now() - lastSeen >= this.paroleCooldownMs;
  }

  /**
   * Picks an alternative when a service is refused.
   *
   * Only ever returns something strictly better than the refused service, and
   * never an `unrated` one: swapping a known-bad endpoint for an unknown endpoint
   * is not an improvement the agent asked for.
   */
  alternativeTo(
    refused: string,
    candidates: readonly string[],
  ): { url: string; record: TrustRecord } | null {
    const ranked = candidates
      .filter((url) => url !== refused)
      .map((url) => ({ url, record: this.recordFor(url) }))
      .filter((c) => c.record.score !== null && c.record.verdict !== "refuse")
      .sort((a, b) => (b.record.score as number) - (a.record.score as number));

    return ranked[0] ?? null;
  }
}
