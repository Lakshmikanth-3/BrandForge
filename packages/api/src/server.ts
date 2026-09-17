import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { EnvError, loadConfig } from "@sentry402/shared";
import { createApp } from "./app.js";

/**
 * Anchor every path to the repo root, not to cwd. `npm run -w` sets cwd to the
 * package directory, so cwd-relative paths silently miss .env and the web assets.
 * dist layout: <root>/packages/api/dist/server.js
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// serveStatic resolves `root` against cwd, so pin cwd once instead of sprinkling
// absolute paths. Everything below can then use plain relative paths.
process.chdir(REPO_ROOT);

loadDotenv();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof EnvError) {
    console.error(`\n✗ Sentry402 refused to start.\n${err.message}\n`);
    console.error("Copy .env.example to .env and fill it in. Run: npm run accounts:create -- --write\n");
    process.exit(1);
  }
  throw err;
}

const { app, listener } = createApp(config);

// One Railway service owns the whole root domain: API paths plus the static site.
// The Foundation's one-root-domain-per-payTo rule means these must not be split.
// Built Vite output. `npm run build` produces it; a missing dist just means the
// API serves 404 for the page, not that the API is down.
app.use("/*", serveStatic({ root: "./apps/web/dist" }));

listener.start();

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`✓ Sentry402 api  network=${config.network.name}  port=${config.port}`);
  console.log(`  merchant ${config.merchantAddress}`);
  console.log(`  payer    ${config.payerAddress}`);
  console.log(`  health   ${config.publicBaseUrl}/healthz`);
  console.log(`  paid     POST ${config.publicBaseUrl}/v1/orchestrate  ($0.05 USDC)`);
});
