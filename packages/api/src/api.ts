/**
 * Read API for the frontend. Every value comes from the store or the trace hub;
 * nothing is synthesised, and an empty store returns zeros rather than samples.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppConfig } from "@sentry402/shared";
import type { Store } from "./db.js";
import { FLOWS, STEPS, type Trace, type TraceHub } from "./trace.js";
import { PRICES, ROUTE_PATHS } from "./x402.js";
import type { BudgetGuard } from "./budget.js";
import type { DownstreamPayer } from "./payer.js";
import type { TrustEngine } from "./trust.js";
import { CURATED } from "./catalog.js";
import { RateLimiter } from "./trustcache.js";
import { Reconciler, receiptsAsCsv } from "./reconcile.js";
import { Verifier } from "./verification.js";

export function apiRoutes(
  config: AppConfig,
  store: Store,
  hub: TraceHub,
  guard: BudgetGuard,
  trust: TrustEngine,
  payer: DownstreamPayer | null,
  options: { live?: boolean } = {},
): Hono {
  /** False on a serverless host, which cannot hold an event stream open. */
  const live = options.live !== false;
  const api = new Hono();

  // The free lookup is what the UI and a curious judge use. Payment limits the paid
  // route; nothing limits a free one, so this does.
  const lookupLimiter = new RateLimiter();
  const verifier = new Verifier(config);

  /** Static shape of the flow, so the UI can render the pipeline before traffic. */
  api.get("/flow", (c) =>
    c.json({
      steps: STEPS,
      flows: FLOWS,
      routes: ROUTE_PATHS,
      prices: PRICES,
      network: config.network.name,
      explorerTxBase: config.network.explorerTxBase,
      // Tells the dashboard whether the live stream exists, so it can poll instead of
      // reconnecting forever to something that will never answer.
      stream: live,
    }),
  );

  api.get("/stats", (c) => {
    const s = store.stats();
    return c.json({
      ...s,
      totalUsdc: s.totalBase / 1e6,
      outboundUsdc: s.outboundBase / 1e6,
      refundUsdc: s.refundBase / 1e6,
      // What the calls actually cost. Gross overstated spend by more than half once a
      // service started refunding the unused portion of its ceiling.
      netOutboundUsdc: s.netOutboundBase / 1e6,
      network: config.network.name,
      merchantAddress: config.merchantAddress,
    });
  });

  api.get("/receipts", (c) => {
    const dir = c.req.query("direction");
    const direction = dir === "in" || dir === "out" ? dir : undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    const rows = store.receipts({
      ...(direction ? { direction } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({
      receipts: rows.map((r) => ({
        ...r,
        amountUsdc: r.amountBase / 1e6,
        explorerUrl: config.network.explorerTxBase + r.txId,
      })),
      explorerTxBase: config.network.explorerTxBase,
    });
  });

  api.get("/traces", (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json({ traces: hub.recent(Number.isFinite(limit) ? limit : 20) });
  });

  /** Budget panel: caps, spend against them, and whether outbound is halted. */
  api.get("/budget", (c) => {
    const status = guard.status();
    return c.json({
      halted: status.halted,
      day: status.day,
      spentTodayUsdc: status.committedTodayBase / 1e6,
      remainingTodayUsdc: status.remainingDayBase / 1e6,
      caps: {
        perCallUsdc: status.limits.perCallBase / 1e6,
        perDayUsdc: status.limits.perDayBase / 1e6,
        perMerchantPerDayUsdc: status.limits.perMerchantPerDayBase / 1e6,
      },
      payerReady: payer !== null,
      payerAddress: payer?.address ?? null,
      recent: store.spendLog(25).map((r) => ({
        ...r,
        amountUsdc: r.amountBase / 1e6,
      })),
    });
  });

  /**
   * Trust record for any endpoint. This is the shape Phase 5 sells as a paid
   * route, served free here so the number the UI shows and the number the gate
   * uses cannot diverge.
   */
  api.get("/trust", (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "url query parameter required" }, 400);

    const key =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";
    const verdict = lookupLimiter.check(key);
    if (!verdict.allowed) {
      c.header("retry-after", String(verdict.retryAfterSec));
      return c.json(
        {
          error: "rate limited",
          retryAfterSec: verdict.retryAfterSec,
          hint: "The paid route at /v1/trust is not rate limited.",
        },
        429,
      );
    }

    // Identical to what /v1/trust sells and what the payment gate acts on.
    return c.json(trust.recordFor(url));
  });

  /**
   * Two-way reconciliation against the indexer. Exposed because a dashboard that
   * cannot be checked against the chain is just a claim.
   */
  api.get("/reconcile", async (c) => {
    const fromRound = Number(c.req.query("fromRound"));
    const reconciler = new Reconciler(
      config.network,
      store,
      config.merchantAddress,
      payer?.address ?? config.payerAddress,
    );
    const report = await reconciler.run(Number.isFinite(fromRound) ? fromRound : null);
    // A dirty report is a 409, so a monitor notices without parsing the body.
    return c.json(report, report.clean ? 200 : 409);
  });

  /**
   * Verification panel. Each row is read live from the source that would disprove
   * it, and a failing row is returned as failing.
   */
  api.get("/verification", async (c) => c.json(await verifier.report()));

  /** Receipt export. Every line carries a transaction id. */
  api.get("/receipts.csv", (c) => {
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="sentry402-receipts.csv"');
    return c.body(receiptsAsCsv(store, config.network.explorerTxBase));
  });

  /** Every time the bridge routed around a refused service, and why. */
  api.get("/substitutions", (c) =>
    c.json({ substitutions: store.substitutions(50), policy: trust.currentPolicy }),
  );

  /** The curated services and their last probe result. */
  api.get("/services", (c) => {
    const rows = store.services({ allowlistedOnly: true, network: config.network.caip2 });
    return c.json({
      services: CURATED.map((service) => {
        const row = rows.find((r) => r.resourceUrl === service.url);
        return {
          label: service.label,
          summary: service.summary,
          url: service.url,
          method: service.method,
          priceUsdc: row ? (row.probeLiveAmount ?? row.amountBase) / 1e6 : null,
          catalogPriceUsdc: row ? row.amountBase / 1e6 : null,
          probeVerdict: row?.probeVerdict ?? null,
          probeLatencyMs: row?.probeLatencyMs ?? null,
          priceDrift: row?.probeDrift ?? null,
          active: row?.active ?? false,
          probedAt: row?.probedAt ?? null,
          trust: trust.recordFor(service.url),
        };
      }),
    });
  });

  /**
   * Live trace stream. The animation subscribes here; each event is one real
   * state change on one real request. If the stream drops, the UI says so
   * rather than continuing to animate.
   */
  api.get("/stream", (c, next) => {
    if (!live) {
      // Say so plainly. An event stream needs a process that outlives the request, and a
      // serverless function does not have one; the dashboard polls /api/traces instead.
      return c.json(
        { live: false, reason: "serverless host: no long-lived process to hold a stream" },
        501,
      );
    }
    return next();
  });

  api.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });

      // Replay recent traces so a fresh page is not blank.
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify({ traces: hub.recent(20), stats: store.stats() }),
      });

      const queue: Trace[] = [];
      const onTrace = (t: Trace) => queue.push(t);
      hub.on("trace", onTrace);

      try {
        while (open) {
          while (queue.length > 0 && open) {
            const t = queue.shift() as Trace;
            await stream.writeSSE({ event: "trace", data: JSON.stringify(t) });
          }
          // Heartbeat doubles as liveness for the UI's "stream up" indicator.
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
          await stream.sleep(1_000);
        }
      } finally {
        hub.off("trace", onTrace);
      }
    }),
  );

  return api;
}
