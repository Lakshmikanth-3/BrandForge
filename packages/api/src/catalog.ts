/**
 * Catalog ingester and curation layer.
 *
 * Pulls the facilitator's discovery listing, normalises it into a local registry,
 * and gates which services may become agent tools.
 *
 * Three behaviours here are driven by what the live catalog actually does, not by
 * theory — all three were observed against the real listing on 2026-09-18:
 *
 *  1. Entries go stale. Of the ten busiest TestNet services, three answered 400
 *     or 404: the catalog still lists routes their owners have changed or removed.
 *     So a catalog entry is a claim, not a fact, and nothing becomes a tool until
 *     a live probe confirms a spec-compliant 402.
 *  2. Advertised prices drift. Two of the verified services charged a different
 *     amount than the catalog said (one 5x, one 8.5x). The probe records the live
 *     price, and a mismatch is surfaced rather than silently paid.
 *  3. A first-call timeout usually means a cold start, not a dead service. Four
 *     services timed out at 20s and then answered in ~1.5s once warm. A probe
 *     that fails is therefore retried once with a longer budget before being
 *     recorded as unreachable, otherwise the trust engine would condemn most of
 *     the ecosystem for being hosted on a free tier.
 */
import type { NetworkConfig } from "@sentry402/shared";
import type { Store } from "./db.js";

export interface CatalogEntry {
  resourceUrl: string;
  method: string;
  description: string;
  payTo: string;
  network: string;
  /** Advertised price in USDC base units, as the catalog reports it. */
  amountBase: number;
  assetId: string;
  settleCount: number;
  lastSeen: string;
  hasDiscoveryInfo: boolean;
  /** The request body the service publishes as its input example, if any. */
  discoveryInput: unknown;
}

export type ProbeVerdict =
  | "ok"
  | "no_challenge"
  | "wrong_status"
  | "wrong_network"
  | "unreachable";

export interface ProbeResult {
  verdict: ProbeVerdict;
  httpStatus: number | null;
  latencyMs: number;
  /** Price the endpoint actually asked for, which may differ from the catalog. */
  liveAmountBase: number | null;
  priceDriftRatio: number | null;
  coldStart: boolean;
  detail: string | null;
}

interface RawItem {
  resourceUrl?: string;
  method?: string;
  description?: string;
  settleCount?: number;
  lastSeen?: string;
  discoveryInfo?: { input?: { body?: unknown; queryParams?: unknown } };
  accepts?: {
    scheme?: string;
    network?: string;
    amount?: string;
    asset?: string;
    payTo?: string;
    extra?: { asset?: string; tag?: string };
  }[];
}

/**
 * Normalises one raw listing item for a given network. Returns null rather than
 * throwing on anything malformed — a bad entry from someone else's endpoint must
 * never break our ingest.
 */
export function normaliseEntry(item: unknown, network: NetworkConfig): CatalogEntry | null {
  if (typeof item !== "object" || item === null) return null;
  const raw = item as RawItem;

  if (typeof raw.resourceUrl !== "string" || raw.resourceUrl.length === 0) return null;
  try {
    new URL(raw.resourceUrl);
  } catch {
    return null;
  }

  const accepts = Array.isArray(raw.accepts) ? raw.accepts : [];
  const match = accepts.find((a) => a?.network === network.caip2 && a?.scheme === "exact");
  if (!match) return null;

  const amount = Number(match.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (typeof match.payTo !== "string" || match.payTo.length === 0) return null;

  const assetId = match.asset ?? match.extra?.asset;
  if (typeof assetId !== "string") return null;
  // Only USDC on the configured network is payable by us.
  if (assetId !== network.usdcAsaId) return null;

  return {
    resourceUrl: raw.resourceUrl,
    method: (raw.method ?? "GET").toUpperCase(),
    description: typeof raw.description === "string" ? raw.description : "",
    payTo: match.payTo,
    network: network.caip2,
    amountBase: amount,
    assetId,
    settleCount: Number(raw.settleCount ?? 0),
    lastSeen: typeof raw.lastSeen === "string" ? raw.lastSeen : new Date().toISOString(),
    hasDiscoveryInfo: raw.discoveryInfo !== undefined && raw.discoveryInfo !== null,
    discoveryInput: raw.discoveryInfo?.input?.body ?? null,
  };
}

/** Parses a base64 `payment-required` header into its accepts list. */
export function parseChallenge(
  header: string | null,
): { network: string; amount: string; asset?: string }[] | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8")) as {
      accepts?: { network?: string; amount?: string; asset?: string }[];
    };
    if (!Array.isArray(decoded.accepts)) return null;
    return decoded.accepts.filter(
      (a): a is { network: string; amount: string; asset?: string } =>
        typeof a?.network === "string" && typeof a?.amount === "string",
    );
  } catch {
    return null;
  }
}

/**
 * Confirms a catalog entry is really payable by asking it for a 402.
 *
 * Costs nothing: an unpaid request is supposed to be refused. Retries once on a
 * transport failure because the first call to a free-tier host is a cold start.
 */
export async function probeService(
  entry: CatalogEntry,
  network: NetworkConfig,
  opts: { firstTimeoutMs?: number; retryTimeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProbeResult> {
  const firstTimeoutMs = opts.firstTimeoutMs ?? 15_000;
  const retryTimeoutMs = opts.retryTimeoutMs ?? 60_000;
  const doFetch = opts.fetchImpl ?? fetch;

  const attempt = async (timeoutMs: number) => {
    const startedAt = Date.now();
    const res = await doFetch(entry.resourceUrl, {
      method: entry.method,
      signal: AbortSignal.timeout(timeoutMs),
      ...(entry.method === "POST"
        ? { headers: { "content-type": "application/json" }, body: "{}" }
        : {}),
    });
    return { res, latencyMs: Date.now() - startedAt };
  };

  let coldStart = false;
  let outcome: { res: Response; latencyMs: number };
  try {
    outcome = await attempt(firstTimeoutMs);
  } catch (first) {
    // Treat as a cold start and give it a second, longer chance.
    coldStart = true;
    try {
      outcome = await attempt(retryTimeoutMs);
    } catch (second) {
      return {
        verdict: "unreachable",
        httpStatus: null,
        latencyMs: retryTimeoutMs,
        liveAmountBase: null,
        priceDriftRatio: null,
        coldStart: true,
        detail: `unreachable after retry: ${
          second instanceof Error ? second.message : String(first)
        }`,
      };
    }
  }

  const { res, latencyMs } = outcome;

  if (res.status !== 402) {
    return {
      verdict: "wrong_status",
      httpStatus: res.status,
      latencyMs,
      liveAmountBase: null,
      priceDriftRatio: null,
      coldStart,
      detail: `expected 402, got ${res.status} — catalog entry is stale`,
    };
  }

  const accepts = parseChallenge(res.headers.get("payment-required"));
  if (!accepts || accepts.length === 0) {
    return {
      verdict: "no_challenge",
      httpStatus: 402,
      latencyMs,
      liveAmountBase: null,
      priceDriftRatio: null,
      coldStart,
      detail: "402 without a parseable payment-required header",
    };
  }

  const onOurNetwork = accepts.find((a) => a.network === network.caip2);
  if (!onOurNetwork) {
    return {
      verdict: "wrong_network",
      httpStatus: 402,
      latencyMs,
      liveAmountBase: null,
      priceDriftRatio: null,
      coldStart,
      detail: `advertises ${accepts[0]?.network ?? "unknown"}, not ${network.name}`,
    };
  }

  const liveAmountBase = Number(onOurNetwork.amount);
  const driftRatio =
    Number.isFinite(liveAmountBase) && entry.amountBase > 0
      ? liveAmountBase / entry.amountBase
      : null;

  return {
    verdict: "ok",
    httpStatus: 402,
    latencyMs,
    liveAmountBase: Number.isFinite(liveAmountBase) ? liveAmountBase : null,
    priceDriftRatio: driftRatio,
    coldStart,
    detail:
      driftRatio !== null && Math.abs(driftRatio - 1) > 0.01
        ? `price drift: catalog ${entry.amountBase}, live ${liveAmountBase}`
        : null,
  };
}

/**
 * Curation allowlist — exact URLs, not hosts.
 *
 * A host allowlist was the first attempt and it was wrong: one vendor here
 * publishes 30 routes and another 19, so allowlisting by host produced 59 tools
 * from five vendors. The PRD is explicit that this ships 4-6 curated services
 * (§22) — a bridge to six good things beats a broken bridge to everything — so
 * the unit of curation is a single verified endpoint.
 *
 * Every entry below was probed on 2026-09-18 and returned a spec-compliant 402
 * advertising USDC on Algorand TestNet. Latency is the observed cold-path figure.
 *
 * Deliberately excluded despite answering 402:
 *  - prism-99h2.onrender.com, inquvia, validex, captre, x402-mesh-gateway —
 *    MainNet only, so unpayable from a TestNet payer. The probe reports
 *    `wrong_network`.
 *  - algorandx402-joke.onrender.com — plain http, no TLS. Not sending payment
 *    material over an unencrypted hop, however cheap the call.
 *  - gateway-x402.vercel.app — every route drifted 4-5x from its catalog price.
 *    Kept out of the trusted set, but it is the natural fixture for the
 *    price-anomaly test.
 *  - recourse-api, api.iomarkets.ai — listed in the catalog but answer 404.
 *
 * This list decays, and faster than expected. finality-x402-backend.onrender.com
 * held three curated entries in the morning and had migrated to MainNet at $0.70 by
 * the afternoon, which the probe caught as `wrong_network` rather than paying it.
 * Re-running the ingest is maintenance, not setup.
 */
export interface CuratedService {
  url: string;
  method: "GET" | "POST";
  /** Short label for the agent-facing tool name. */
  label: string;
  /** What the caller actually gets, for the MCP tool description. */
  summary: string;
}

export const CURATED: readonly CuratedService[] = [
  {
    url: "https://api-testnet-production-a3ec.up.railway.app/metric/folks/tvl",
    method: "GET",
    label: "folks_tvl",
    summary:
      "Total value locked in Folks Finance, in USD, as a single standardised KPI.",
  },
  {
    url: "https://api-testnet-production-a3ec.up.railway.app/metric/tinyman/gross_fees_24h",
    method: "GET",
    label: "tinyman_gross_fees",
    summary: "Gross protocol fees earned by Tinyman over the last 24 hours, in USD.",
  },
  {
    url: "https://api-testnet-production-a3ec.up.railway.app/metric/pact/pool_count",
    method: "GET",
    label: "pact_pool_count",
    summary: "Number of liquidity pools live on Pact.",
  },
  {
    url: "https://hashlock.pronodealgo.xyz/api/timestamp",
    method: "POST",
    label: "proof_of_existence",
    summary:
      "Anchors a document hash on Algorand and returns a proof-of-existence timestamp.",
  },
  {
    url: "https://sachet-x402.vercel.app/secrets",
    method: "POST",
    label: "secret_scan",
    summary: "Scans supplied file contents for leaked credentials and secrets.",
  },
  {
    url: "https://hacknite-36hr.onrender.com/run",
    method: "POST",
    label: "pr_review",
    summary: "Reviews a GitHub pull request and returns findings, under a spend ceiling.",
  },
];

const CURATED_URLS = new Set(CURATED.map((c) => c.url));

/**
 * The body to send a curated service, taken from what it publishes via discovery.
 *
 * Sending a POST endpoint a body it did not ask for earns a 4xx that looks exactly
 * like the service failing. The protocol already publishes the right shape, so this
 * uses it rather than guessing.
 */
export function samplePayloadFor(store: Store, url: string): unknown {
  const row = store.services({ activeOnly: false }).find((s) => s.resourceUrl === url);
  return row?.discoveryInput ?? null;
}

export function isAllowlisted(resourceUrl: string): boolean {
  return CURATED_URLS.has(resourceUrl);
}

export interface IngestResult {
  fetched: number;
  normalised: number;
  skipped: number;
  allowlisted: number;
  markedInactive: number;
  error?: string;
}

export class CatalogIngester {
  constructor(
    private readonly net: NetworkConfig,
    private readonly store: Store,
    private readonly facilitatorUrl: string,
  ) {}

  async ingest(limit = 5_000): Promise<IngestResult> {
    let items: unknown[];
    try {
      const res = await fetch(`${this.facilitatorUrl}/discovery/resources?limit=${limit}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return {
          fetched: 0,
          normalised: 0,
          skipped: 0,
          allowlisted: 0,
          markedInactive: 0,
          error: `HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as { items?: unknown[] };
      items = Array.isArray(body.items) ? body.items : [];
    } catch (err) {
      return {
        fetched: 0,
        normalised: 0,
        skipped: 0,
        allowlisted: 0,
        markedInactive: 0,
        error: err instanceof Error ? err.message : "discovery unreachable",
      };
    }

    const seenUrls: string[] = [];
    let normalised = 0;
    let skipped = 0;
    let allowlisted = 0;

    for (const item of items) {
      const entry = normaliseEntry(item, this.net);
      if (!entry) {
        skipped += 1;
        continue;
      }
      normalised += 1;
      seenUrls.push(entry.resourceUrl);
      const allowed = isAllowlisted(entry.resourceUrl);
      if (allowed) allowlisted += 1;
      this.store.upsertService(entry, allowed);
    }

    // Anything we knew about that the catalog no longer lists goes inactive
    // rather than being deleted, so its trust history survives.
    const markedInactive = this.store.markMissingInactive(seenUrls, this.net.caip2);

    return { fetched: items.length, normalised, skipped, allowlisted, markedInactive };
  }

  /** Probes every allowlisted service and records the result. */
  async verifyAllowlisted(): Promise<{ url: string; result: ProbeResult }[]> {
    const services = this.store.services({ allowlistedOnly: true, network: this.net.caip2 });
    const out: { url: string; result: ProbeResult }[] = [];
    for (const service of services) {
      const result = await probeService(service, this.net);
      this.store.recordProbe(service.resourceUrl, result);
      out.push({ url: service.resourceUrl, result });
    }
    return out;
  }
}
