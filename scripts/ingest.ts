/**
 * Runs one catalog ingest and probes the allowlisted services.
 * Phase 2 exit evidence: shows what the catalog claims and what actually answers.
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@sentry402/shared";
import { Store } from "../packages/api/src/db.js";
import { CatalogIngester } from "../packages/api/src/catalog.js";

loadDotenv();
const config = loadConfig();
const store = new Store("data/sentry402.sqlite");
const ingester = new CatalogIngester(config.network, store, config.facilitatorUrl);

console.log(`\ningesting catalog for ${config.network.name}…`);
const result = await ingester.ingest();
console.log(result);

console.log(`\nprobing allowlisted services (free — an unpaid request must be refused):`);
const probes = await ingester.verifyAllowlisted();
for (const { url, result: p } of probes) {
  const mark = p.verdict === "ok" ? "OK  " : "FAIL";
  const drift =
    p.priceDriftRatio !== null && Math.abs(p.priceDriftRatio - 1) > 0.01
      ? ` drift x${p.priceDriftRatio.toFixed(2)}`
      : "";
  console.log(
    `  ${mark} ${p.verdict.padEnd(13)} ${String(p.latencyMs).padStart(6)}ms` +
      `${p.coldStart ? " cold" : "     "}${drift}  ${new URL(url).host}`,
  );
  if (p.detail) console.log(`       ${p.detail}`);
}

const usable = probes.filter((p) => p.result.verdict === "ok").length;
console.log(`\n${usable}/${probes.length} allowlisted services confirmed payable.\n`);
store.close();
