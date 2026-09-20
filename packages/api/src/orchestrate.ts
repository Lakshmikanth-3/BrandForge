import type { Context } from "hono";
import type { AppConfig } from "@sentry402/shared";
import type { Store } from "./db.js";
import type { DownstreamPayer } from "./payer.js";
import type { TrustEngine } from "./trust.js";
import { CURATED, samplePayloadFor, type CuratedService } from "./catalog.js";

/**
 * The paid orchestration route: the client has paid us, and now WE pay the downstream service.
 *
 * Two rules shape every branch below.
 *
 *  1. Only a curated, allowlisted service can be called. A body that names an arbitrary URL
 *     would let any caller spend our wallet on any endpoint they like, so an unknown target is
 *     refused rather than trusted.
 *  2. Anything that is not a success answers 4xx or 5xx. The x402 middleware settles the
 *     client's payment only for a response below 400, so a refusal, a budget stop or a failed
 *     downstream call costs the client nothing. The customer pays for a delivered result, not
 *     for an attempt.
 *
 * The downstream call goes through the same trust gate, price check, budget guard and route-around
 * as the MCP path. There is one payment path, not two.
 */
interface Deps {
  config: AppConfig;
  store: Store;
  payer: DownstreamPayer | null;
  trust: TrustEngine;
}

function resolveTarget(body: unknown): CuratedService | null {
  if (typeof body !== "object" || body === null) return null;
  const target = (body as { target?: unknown }).target;
  if (typeof target !== "string") return null;
  return CURATED.find((s) => s.url === target || s.label === target) ?? null;
}

export function orchestrateHandler({ config, store, payer, trust }: Deps) {
  return async (c: Context) => {
    const body: unknown = await c.req.json().catch(() => null);
    const service = resolveTarget(body);

    if (!service) {
      return c.json(
        {
          ok: false,
          error: "unknown target",
          hint: "target must be the url or label of a curated service",
          available: CURATED.map((s) => s.label),
        },
        400,
      );
    }
    if (!payer) {
      return c.json({ ok: false, error: "downstream payer is not configured on this server" }, 503);
    }

    const row = store
      .services({ allowlistedOnly: true, network: config.network.caip2 })
      .find((s) => s.resourceUrl === service.url);
    const priceBase = row ? (row.probeLiveAmount ?? row.amountBase) : null;
    if (priceBase === null) {
      return c.json({ ok: false, error: "no verified price on record for this service" }, 503);
    }

    const requested = (body as { payload?: unknown }).payload;
    const payload = requested ?? samplePayloadFor(store, service.url);

    const alternatives = (service.alternatives ?? []).flatMap((label) => {
      const alt = CURATED.find((s) => s.label === label);
      const altRow = alt
        ? store
            .services({ allowlistedOnly: true, network: config.network.caip2 })
            .find((s) => s.resourceUrl === alt.url)
        : undefined;
      return alt && altRow
        ? [{ service: alt, priceBase: altRow.probeLiveAmount ?? altRow.amountBase }]
        : [];
    });

    const outcome = await payer.payWithRouteAround(service, priceBase, payload, alternatives);
    const record = trust.recordFor(service.url);

    if (!outcome.ok) {
      // 4xx/5xx: the middleware will not settle the client's payment for this.
      const status = outcome.refusedByTrust || outcome.refusedByPriceAnomaly ? 422 : 502;
      return c.json(
        {
          ok: false,
          target: service.label,
          error: outcome.error ?? "downstream call failed",
          refusedByTrust: outcome.refusedByTrust ?? false,
          trust: { score: record.score, verdict: record.verdict, observations: record.observations },
          charged: false,
        },
        status,
      );
    }

    return c.json({
      ok: true,
      target: outcome.substituted?.to ?? service.label,
      routedAround: outcome.substituted ?? null,
      trust: { score: record.score, verdict: record.verdict, observations: record.observations },
      result: outcome.result,
      receipt: {
        txId: outcome.txId,
        amountUsdc: outcome.amountBase === null ? null : outcome.amountBase / 1e6,
        network: config.network.name,
        latencyMs: outcome.latencyMs,
      },
    });
  };
}
