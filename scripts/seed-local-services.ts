/**
 * Seeds the three local x402 services (weather, token price, AI image)
 * directly into the SQLite DB as allowlisted entries, then probes them.
 *
 * These are first-party services hosted by this bridge, so they never
 * appear in the external Bazaar catalog. This script is the equivalent
 * of catalog:ingest but for our own endpoints.
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@sentry402/shared";
import { Store } from "../packages/api/src/db.js";
import { probeService } from "../packages/api/src/catalog.js";
import type { CatalogEntry } from "../packages/api/src/catalog.js";

loadDotenv();
const config = loadConfig();
const store = new Store("data/sentry402.sqlite");
const net = config.network;

// Each entry must look like a real CatalogEntry so the prober can verify it.
const LOCAL_SERVICES: CatalogEntry[] = [
  {
    resourceUrl: `http://127.0.0.1:${config.port}/v1/weather`,
    method: "GET",
    description: "Live current weather (temperature, windspeed) from Open-Meteo. Real data.",
    payTo: config.merchantAddress,
    network: net.caip2,
    amountBase: 5_000,    // $0.005 USDC
    assetId: net.usdcAsaId,
    settleCount: 0,
    lastSeen: new Date().toISOString(),
    hasDiscoveryInfo: false,
    discoveryInput: null,
  },
  {
    resourceUrl: `http://127.0.0.1:${config.port}/v1/token/price`,
    method: "GET",
    description: "Live ALGO/USDT price from Binance public ticker. Real market data.",
    payTo: config.merchantAddress,
    network: net.caip2,
    amountBase: 2_000,    // $0.002 USDC
    assetId: net.usdcAsaId,
    settleCount: 0,
    lastSeen: new Date().toISOString(),
    hasDiscoveryInfo: false,
    discoveryInput: null,
  },
  {
    resourceUrl: `http://127.0.0.1:${config.port}/v1/ai/image`,
    method: "POST",
    description: "Generate a real AI image via Pollinations.ai. POST a prompt, get an image URL.",
    payTo: config.merchantAddress,
    network: net.caip2,
    amountBase: 15_000,   // $0.015 USDC
    assetId: net.usdcAsaId,
    settleCount: 0,
    lastSeen: new Date().toISOString(),
    hasDiscoveryInfo: false,
    discoveryInput: null,
  },
];

console.log(`\nSeeding ${LOCAL_SERVICES.length} local x402 services into DB…`);

for (const entry of LOCAL_SERVICES) {
  store.upsertService(entry, true /* allowlisted */);
  console.log(`  ✓ seeded  ${entry.resourceUrl}`);
}

console.log(`\nProbing local services…`);
for (const entry of LOCAL_SERVICES) {
  const result = await probeService(entry, net, { firstTimeoutMs: 5_000 });
  store.recordProbe(entry.resourceUrl, result);
  const mark = result.verdict === "ok" ? "✓ OK  " : "✗ FAIL";
  console.log(`  ${mark}  ${result.verdict.padEnd(13)} ${String(result.latencyMs).padStart(5)}ms  ${new URL(entry.resourceUrl).pathname}`);
  if (result.detail) console.log(`         ${result.detail}`);
}

store.close();
console.log("\nDone. Local services are now active in the catalog.\n");
