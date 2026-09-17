/**
 * Read API for the frontend. Every value comes from the store or the trace hub;
 * nothing is synthesised, and an empty store returns zeros rather than samples.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppConfig } from "@sentry402/shared";
import type { Store } from "./db.js";
import { STEPS, type Trace, type TraceHub } from "./trace.js";
import { PRICES, ROUTE_PATHS } from "./x402.js";

export function apiRoutes(config: AppConfig, store: Store, hub: TraceHub): Hono {
  const api = new Hono();

  /** Static shape of the flow, so the UI can render the pipeline before traffic. */
  api.get("/flow", (c) =>
    c.json({
      steps: STEPS,
      routes: ROUTE_PATHS,
      prices: PRICES,
      network: config.network.name,
      explorerTxBase: config.network.explorerTxBase,
    }),
  );

  api.get("/stats", (c) => {
    const s = store.stats();
    return c.json({
      ...s,
      totalUsdc: s.totalBase / 1e6,
      outboundUsdc: s.outboundBase / 1e6,
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

  /**
   * Live trace stream. The animation subscribes here; each event is one real
   * state change on one real request. If the stream drops, the UI says so
   * rather than continuing to animate.
   */
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
