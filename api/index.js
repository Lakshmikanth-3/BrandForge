/**
 * Vercel serverless entry point.
 *
 * A function starts for a request and may be frozen or discarded when it responds, so this
 * differs from packages/api/src/server.ts in the ways that matter:
 *
 *   - no listen(), no background timer: createApp runs in serverless mode, which syncs
 *     receipts from the chain on demand and reports the live stream as unavailable
 *   - the only writable filesystem is /tmp, so the SQLite file lives there and is rebuilt on
 *     every cold start from the snapshots and the chain
 *   - no catalog ingest at startup: rehydrate(store, null, ...) restores from snapshots only,
 *     because a cold start cannot afford probes that take a minute
 *
 * It is plain JavaScript importing the compiled output on purpose. Vercel builds TypeScript
 * functions with its own toolchain, and a TypeScript monorepo with project references is
 * exactly where that goes wrong; the build step (npm run build) already produced dist/.
 *
 * Static files never reach this function: Vercel serves apps/web/dist first and only falls
 * through to here for everything else.
 *
 * The boot is instrumented on purpose. The facilitator's own Doctor reported HTTP 500 from
 * both paid routes while identical requests from a warm client returned 402, which is the
 * signature of a cold-start fault. A log line per boot phase, and handlers that turn a crash
 * into a log line, are what make that diagnosable instead of a guess.
 */
import { loadConfig } from "../packages/shared/dist/index.js";
import { createApp } from "../packages/api/dist/app.js";
import { rehydrate } from "../packages/api/dist/rehydrate.js";
import { vercelHandler } from "../packages/api/dist/vercel.js";

const bootStartedAt = Date.now();
console.log(`[boot] modules loaded, process uptime ${Math.round(process.uptime() * 1000)}ms`);

// A crash that Vercel reports only as "500" or "502" must say WHY in the log.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err instanceof Error ? err.stack : err);
});

const config = loadConfig();
const appStartedAt = Date.now();
const { app, store } = createApp(config, "/tmp/sentry402.sqlite", { serverless: true });
console.log(`[boot] createApp ${Date.now() - appStartedAt}ms`);

// Top-level await: the first request waits for the snapshots to load (a few local file reads),
// so it never sees an empty registry or an unrated trust record.
const rehydrateStartedAt = Date.now();
await rehydrate(store, null, config.network.name);
console.log(
  `[boot] rehydrate ${Date.now() - rehydrateStartedAt}ms, total boot ${Date.now() - bootStartedAt}ms`,
);

// Our own adapter, not @hono/node-server/vercel: Vercel pre-parses the body, which leaves the
// stock adapter waiting forever on a stream that is already drained (see packages/api/src/vercel.ts).
const inner = vercelHandler(app.fetch);

/** Logs any request that is slow or that throws, with its path, so a 500 has a cause. */
export default async function handler(req, res) {
  const startedAt = Date.now();
  try {
    await inner(req, res);
  } catch (err) {
    console.error(`[handler] ${req.method} ${req.url} threw:`, err instanceof Error ? err.stack : err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "internal error" }));
    }
  } finally {
    const took = Date.now() - startedAt;
    if (took > 3_000) console.warn(`[slow] ${req.method} ${req.url} took ${took}ms`);
  }
}
