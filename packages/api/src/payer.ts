/**
 * Downstream payer — the side of the bridge that spends.
 *
 * Wraps fetch with x402 payment so a 402 from a downstream service is answered
 * automatically. The agent never sees a wallet and never holds key material: the
 * mnemonic lives only in this process, is converted to a signer once at startup,
 * and is never logged, serialised or forwarded.
 *
 * Every payment passes the budget guard first. The order is deliberate — reserve,
 * then attempt, then settle or release — so a crash mid-flight leaves a
 * reservation that expires rather than an unrecorded spend.
 */
import algosdk from "algosdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import type { AppConfig } from "@sentry402/shared";
import type { Store } from "./db.js";
import type { BudgetGuard } from "./budget.js";
import type { CuratedService } from "./catalog.js";
import type { TraceHub } from "./trace.js";
import type { TrustEngine } from "./trust.js";

export interface PayOutcome {
  ok: boolean;
  /** Set when the trust gate refused this service. */
  refusedByTrust?: boolean;
  /** Set when the live price diverged from the expected price beyond tolerance. */
  refusedByPriceAnomaly?: boolean;
  /** The step the call stopped at, when it did not complete. */
  failedAt?: string;
  /** Set when a different service answered because the requested one was refused. */
  substituted?: { from: string; to: string; reason: string };
  status: number | null;
  /** The downstream service's response body, verbatim when it parsed as JSON. */
  result: unknown;
  txId: string | null;
  amountBase: number | null;
  latencyMs: number;
  traceId: string;
  error: string | null;
}

interface SettlementHeader {
  success?: boolean;
  transaction?: string;
  txId?: string;
  txid?: string;
  payer?: string;
  errorReason?: string;
}

function decodeSettlement(header: string | null): SettlementHeader | null {
  if (!header) return null;
  for (const decode of [
    () => JSON.parse(Buffer.from(header, "base64").toString("utf8")),
    () => JSON.parse(header),
  ]) {
    try {
      const parsed = decode();
      if (parsed && typeof parsed === "object") return parsed as SettlementHeader;
    } catch {
      // try the next encoding
    }
  }
  return null;
}

/** Reads the advertised price from a 402 without paying it. */
function priceFromChallenge(header: string | null, caip2: string): number | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8")) as {
      accepts?: { network?: string; amount?: string }[];
    };
    const match = (decoded.accepts ?? []).find((a) => a.network === caip2);
    const amount = Number(match?.amount);
    return Number.isFinite(amount) ? amount : null;
  } catch {
    return null;
  }
}

/**
 * How far the live price may drift from the expected price before the call is
 * refused. Not zero: a service may legitimately reprice slightly, and refusing on
 * a one-base-unit difference would make the bridge useless. Not generous either:
 * two live services were found advertising 5x and 8.5x their catalog price.
 */
const PRICE_DRIFT_TOLERANCE = 0.25;

export class DownstreamPayer {
  private readonly paidFetch: typeof fetch;
  /** Unwrapped fetch, for the pre-flight that must NOT pay. */
  private readonly plainFetch: typeof fetch;
  readonly address: string;
  /**
   * Only the non-secret slice of the config is retained. TypeScript's `private`
   * is compile-time only, so holding the whole AppConfig would leave the payer
   * mnemonic enumerable and it would appear in any JSON.stringify of this
   * instance — an error dump, a log line, a crash report. A test pins this.
   */
  private readonly network: AppConfig["network"];

  constructor(
    config: AppConfig,
    private readonly store: Store,
    private readonly guard: BudgetGuard,
    private readonly hub: TraceHub,
    private readonly trust: TrustEngine,
  ) {
    this.network = config.network;
    // mnemonicToSecretKey gives the 64-byte seed||pubkey form the signer wants.
    // algosdk is already a dependency, so this avoids a second key-handling path.
    if (config.secrets.payerMnemonic === null) {
      // Not an error to log loudly: the public server is meant to run without a key.
      throw new Error("no PAYER_MNEMONIC configured -- this instance cannot pay");
    }
    const account = algosdk.mnemonicToSecretKey(config.secrets.payerMnemonic);
    this.address = account.addr.toString();

    if (this.address !== config.payerAddress) {
      // Catching this at startup beats discovering it when a payment fails.
      throw new Error(
        "PAYER_MNEMONIC does not derive PAYER_ADDRESS — refusing to start the payer",
      );
    }

    this.plainFetch = fetch;
    const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
    // Glob registration, for the same CAIP-2 form mismatch noted in x402.ts.
    const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
    this.paidFetch = wrapFetchWithPayment(fetch, client);
  }

  /**
   * Pays a curated service and returns its response.
   *
   * The trust gate runs before the budget guard and before any network call, so a
   * refusal costs nothing. Enforcement is here at the payment layer rather than in
   * the UI: a gate that only colours a badge is not a gate.
   */
  async pay(
    service: CuratedService,
    advertisedAmountBase: number,
    payload: unknown,
  ): Promise<PayOutcome> {
    const trace = this.hub.start(service.label, "bridged");
    const id = trace.id;
    const startedAt = Date.now();

    const fail = (step: Parameters<TraceHub["fail"]>[1], detail: string): PayOutcome => {
      this.hub.fail(id, step, detail);
      return {
        ok: false,
        failedAt: step,
        status: null,
        result: null,
        txId: null,
        amountBase: null,
        latencyMs: Date.now() - startedAt,
        traceId: id,
        error: detail,
      };
    };

    this.hub.begin(id, "resolve");
    this.hub.end(id, "resolve", "ok", `${service.method} ${new URL(service.url).host}`);

    this.hub.begin(id, "trust");
    const gate = this.trust.gate(service.url);
    if (!gate.allow) {
      this.hub.fail(id, "trust", gate.reason);
      return {
        ok: false,
        refusedByTrust: true,
        failedAt: "trust",
        status: null,
        result: null,
        txId: null,
        amountBase: null,
        latencyMs: Date.now() - startedAt,
        traceId: id,
        error: `refused by trust gate: ${gate.reason}`,
      };
    }
    this.hub.end(
      id,
      "trust",
      gate.record.verdict === "unrated" ? "skipped" : "ok",
      gate.reason,
    );

    this.hub.begin(id, "budget");
    // Belt and braces alongside busy_timeout: if reserving still fails -- a lock held
    // longer than the timeout, a disk error -- that is a refusal, not a crash. An
    // exception here would escape pay() and surface to the agent as a broken tool
    // instead of an honest "could not reserve".
    let decision;
    try {
      decision = this.guard.reserve({
        merchant: service.url,
        route: service.label,
        amountBase: advertisedAmountBase,
      });
    } catch (err) {
      return fail(
        "budget",
        `could not reserve spend: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!decision.allowed) {
      return fail("budget", `${decision.reason}: ${decision.detail}`);
    }
    this.hub.end(
      id,
      "budget",
      "ok",
      `reserved ${(advertisedAmountBase / 1e6).toFixed(6)} USDC · ` +
        `${(decision.remainingDayBase / 1e6).toFixed(6)} left today`,
    );

    // Pre-flight: ask for the price without paying it.
    //
    // wrapFetchWithPayment satisfies a 402 automatically, so there is no point
    // inside the paid call where the advertised amount can be inspected before the
    // money commits. An unpaid request is free -- being refused is the documented
    // behaviour -- and it also warms a sleeping host, which matters on free tiers.
    this.hub.begin(id, "challenge");
    let quoted: number | null = null;
    try {
      const preflight = await this.plainFetch(service.url, {
        method: service.method,
        signal: AbortSignal.timeout(30_000),
        ...(service.method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload ?? {}),
            }
          : {}),
      });

      if (preflight.status !== 402) {
        // Not a 402 means no payment is owed, so nothing should be sent. A 500
        // here is the downstream failing before it ever quoted a price.
        this.guard.release(decision.reservationId);
        const reason = `expected 402 before paying, got HTTP ${preflight.status}`;
        this.recordOutcome(service.url, {
          ok: false,
          httpStatus: preflight.status,
          latencyMs: Date.now() - startedAt,
          settled: false,
          failureReason: reason,
        });
        return fail("challenge", reason);
      }

      quoted = priceFromChallenge(
        preflight.headers.get("payment-required"),
        this.network.caip2,
      );
    } catch (err) {
      this.guard.release(decision.reservationId);
      const reason = err instanceof Error ? err.message : "downstream unreachable";
      this.recordOutcome(service.url, {
        ok: false,
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        settled: false,
        failureReason: reason,
      });
      return fail("challenge", reason);
    }

    if (quoted === null) {
      this.guard.release(decision.reservationId);
      const reason = "402 carried no price for our network";
      this.recordOutcome(service.url, {
        ok: false,
        httpStatus: 402,
        latencyMs: Date.now() - startedAt,
        settled: false,
        failureReason: reason,
      });
      return fail("challenge", reason);
    }

    const drift = quoted / advertisedAmountBase;
    if (Math.abs(drift - 1) > PRICE_DRIFT_TOLERANCE) {
      // Anomaly refusal: the price moved since the registry was built. Surfaced
      // rather than silently paid, whichever direction it moved.
      this.guard.release(decision.reservationId);
      const reason =
        `price anomaly: expected ${usdc(advertisedAmountBase)}, ` +
        `endpoint asked ${usdc(quoted)} (x${drift.toFixed(2)})`;
      this.recordOutcome(service.url, {
        ok: false,
        httpStatus: 402,
        latencyMs: Date.now() - startedAt,
        settled: false,
        failureReason: reason,
      });
      this.hub.fail(id, "challenge", reason);
      return {
        ok: false,
        refusedByPriceAnomaly: true,
        failedAt: "challenge",
        status: 402,
        result: null,
        txId: null,
        amountBase: null,
        latencyMs: Date.now() - startedAt,
        traceId: id,
        error: reason,
      };
    }

    this.hub.end(id, "challenge", "ok", `quoted ${usdc(quoted)}`);

    this.hub.begin(id, "request");
    let res: Response;
    try {
      res = await this.paidFetch(service.url, {
        method: service.method,
        signal: AbortSignal.timeout(60_000),
        ...(service.method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload ?? {}),
            }
          : {}),
      });
    } catch (err) {
      // Nothing settled, so the headroom goes back.
      this.guard.release(decision.reservationId);
      const reason = err instanceof Error ? err.message : "downstream unreachable";
      // The payment wrapper already retried internally; reaching here means the
      // service failed warm as well, so this is a real failure, not a cold start.
      this.recordOutcome(service.url, {
        ok: false,
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        settled: false,
        failureReason: reason,
      });
      return fail("request", reason);
    }

    this.hub.end(id, "request", "ok", `HTTP ${res.status}`);

    const settlement = decodeSettlement(
      // x402 v2 names it PAYMENT-RESPONSE; v1 used X-PAYMENT-RESPONSE. Reading only the old one
      // silently dropped the tx id from every v2 downstream, which then looked unsettled.
      res.headers.get("payment-response") ?? res.headers.get("x-payment-response"),
    );
    const txId = settlement?.transaction ?? settlement?.txId ?? settlement?.txid ?? null;

    // A 402 still standing means the wrapper could not satisfy the challenge.
    if (res.status === 402 || !res.ok) {
      this.guard.release(decision.reservationId);
      const reason =
        settlement?.errorReason ?? `downstream returned HTTP ${res.status} after payment attempt`;
      // A 4xx that is not a 402 means the service rejected OUR request -- a body it
      // did not ask for, a missing field. That is our bug, not its unreliability,
      // and scoring it against the service would make the record measure our bugs.
      // 5xx, timeouts and paid-for-nothing remain the service's failures.
      const clientError = res.status >= 400 && res.status < 500 && res.status !== 402;
      this.recordOutcome(service.url, {
        ok: false,
        httpStatus: res.status,
        latencyMs: Date.now() - startedAt,
        settled: txId !== null,
        clientError,
        failureReason: clientError ? `our request was rejected: ${reason}` : reason,
      });
      return fail("payment", reason);
    }

    this.hub.end(id, "payment", "ok", "X-PAYMENT accepted");
    this.hub.end(id, "settle", txId ? "ok" : "skipped", txId ? `tx ${txId}` : "no tx id returned");

    const latencyMs = Date.now() - startedAt;
    this.guard.settle(decision.reservationId, txId);
    this.hub.annotate(id, { txId, amountBase: advertisedAmountBase });

    // Outbound receipt. Confirm against the indexer is a separate step because
    // the indexer lags; an unconfirmed receipt is still recorded, then reconciled.
    if (txId) {
      try {
        this.store.putReceipt({
          txId,
          direction: "out",
          route: service.label,
          payer: this.address,
          payee: service.url,
          amountBase: advertisedAmountBase,
          assetId: this.network.usdcAsaId,
          network: this.network.name,
          confirmedRound: null,
          settledAt: new Date().toISOString(),
          traceId: id,
          latencyMs,
        });
      } catch {
        // A storage failure must not fail a payment that already settled.
      }
      this.hub.end(id, "confirm", "skipped", "pending indexer confirmation");
    } else {
      this.hub.end(id, "confirm", "skipped", "nothing to confirm without a tx id");
    }

    let result: unknown;
    const text = await res.text();
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }

    // A paid response with an empty body is a delivery failure, not a success:
    // the operator paid and the agent got nothing usable.
    const delivered = text.trim().length > 0;
    this.recordOutcome(service.url, {
      ok: delivered,
      httpStatus: res.status,
      latencyMs,
      settled: txId !== null,
      failureReason: delivered ? null : "paid response had an empty body",
    });

    this.hub.begin(id, "deliver");
    if (delivered) {
      this.hub.end(id, "deliver", "ok", `${text.length} bytes returned`);
      this.hub.complete(id);
    } else {
      this.hub.fail(id, "deliver", "paid response had an empty body");
      return {
        ok: false,
        status: res.status,
        result: null,
        txId,
        amountBase: advertisedAmountBase,
        latencyMs,
        traceId: id,
        error: "downstream took payment and returned an empty body",
      };
    }

    return {
      ok: true,
      status: res.status,
      result,
      txId,
      amountBase: advertisedAmountBase,
      latencyMs,
      traceId: id,
      error: null,
    };
  }

  /**
   * Pays a service, routing around it when it is refused BEFORE any money moves.
   *
   * The rule that makes this safe is when it is allowed to act. It substitutes only for a
   * failure where nothing was paid: a trust refusal, a price anomaly, or a service that could
   * not even quote a price. It never substitutes after money moved, because paying a second
   * service for the same request would be a double spend. And it never routes around the
   * budget guard or the kill switch: those apply to every service, so an alternative would fail
   * for the same reason, and bypassing a halt is exactly what a halt exists to prevent.
   *
   * It also refuses to substitute an unrated or refused service for a refused one. Swapping a
   * known-bad endpoint for an unknown one is not an improvement anyone asked for, so with no
   * scored alternative the honest answer is the original refusal, and that refusal is logged.
   */
  async payWithRouteAround(
    primary: CuratedService,
    primaryPriceBase: number,
    payload: unknown,
    alternatives: readonly { service: CuratedService; priceBase: number; payload?: unknown }[],
  ): Promise<PayOutcome> {
    const first = await this.pay(primary, primaryPriceBase, payload);
    if (first.ok || !this.canRouteAround(first)) return first;

    const at = new Date().toISOString();
    const refusedScore = this.trust.recordFor(primary.url).score;
    const reason = first.error ?? "refused before payment";
    const pick = this.trust.alternativeTo(
      primary.url,
      alternatives.map((a) => a.service.url),
    );

    if (!pick) {
      // The refusal with nowhere to go is the outcome most worth recording.
      this.store.putSubstitution({
        at,
        refusedUrl: primary.url,
        refusedScore,
        chosenUrl: null,
        chosenScore: null,
        reason: `${reason}; no alternative with a passing record was available`,
      });
      return first;
    }

    const alt = alternatives.find((a) => a.service.url === pick.url)!;
    this.store.putSubstitution({
      at,
      refusedUrl: primary.url,
      refusedScore,
      chosenUrl: pick.url,
      chosenScore: pick.record.score,
      reason,
    });

    const outcome = await this.pay(alt.service, alt.priceBase, alt.payload ?? payload);
    return {
      ...outcome,
      substituted: { from: primary.label, to: alt.service.label, reason },
    };
  }

  /** True only when no money moved and the cause is specific to this one service. */
  private canRouteAround(outcome: PayOutcome): boolean {
    // Money moved: substituting would mean paying twice for one request.
    if (outcome.txId !== null) return false;
    return (
      outcome.refusedByTrust === true ||
      outcome.refusedByPriceAnomaly === true ||
      // The service could not quote a price at all: unreachable, or answered something
      // other than a 402. Budget and kill-switch refusals fail at "budget", not here.
      outcome.failedAt === "challenge"
    );
  }

  /** Appends one observation for the trust engine. Never throws into a payment. */
  private recordOutcome(
    resourceUrl: string,
    o: {
      ok: boolean;
      httpStatus: number | null;
      latencyMs: number | null;
      settled: boolean;
      failureReason: string | null;
      clientError?: boolean;
    },
  ): void {
    try {
      this.trust.record({
        resourceUrl,
        at: new Date().toISOString(),
        ok: o.ok,
        httpStatus: o.httpStatus,
        latencyMs: o.latencyMs,
        settled: o.settled,
        // Schema checking needs the advertised output schema from discovery; not
        // every curated service publishes one, so this stays null until it does.
        schemaOk: null,
        coldStart: false,
        clientError: o.clientError ?? false,
        failureReason: o.failureReason,
      });
    } catch {
      // A scoring write must never fail a payment that already happened.
    }
  }
}

function usdc(base: number): string {
  return `$${(base / 1e6).toFixed(6)}`;
}
