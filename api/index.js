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
 */
import { handle } from "@hono/node-server/vercel";
import { loadConfig } from "../packages/shared/dist/index.js";
import { createApp } from "../packages/api/dist/app.js";
import { rehydrate } from "../packages/api/dist/rehydrate.js";

const config = loadConfig();
const { app, store } = createApp(config, "/tmp/sentry402.sqlite", { serverless: true });

// Top-level await: the first request waits for the snapshots to load (a few local file reads),
// so it never sees an empty registry or an unrated trust record.
await rehydrate(store, null, config.network.name);

export default handle(app);
