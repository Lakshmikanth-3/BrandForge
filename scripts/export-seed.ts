/**
 * Exports the trust observations to seed/outcomes.json.
 *
 * A free host with an ephemeral filesystem loses its SQLite file on every restart, and
 * trust outcomes are the one piece of state that cannot be re-derived: they are
 * observations of what a service returned when we paid it, and no chain records that. So
 * the operator's payer -- which is where the calls actually happen -- exports them, and the
 * hosted server imports them when its own table is empty.
 *
 * This is real data from real paid calls, not a fixture. It is a snapshot, refreshed by
 * running this again and redeploying; the hosted server does not pay anyone, so it does
 * not generate new observations of its own.
 *
 * Usage:  npm run trust:export
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@sentry402/shared";
import { Store } from "../packages/api/src/db.js";
import { SEED_PATH, type SeedFile } from "../packages/api/src/rehydrate.js";
import { TrustEngine } from "../packages/api/src/trust.js";
import { CURATED } from "../packages/api/src/catalog.js";

loadDotenv();
const config = loadConfig();
const store = new Store("data/sentry402.sqlite");

const outcomes = store.allOutcomes();
if (outcomes.length === 0) {
  console.error("\n✗ no outcomes in the local database, so there is nothing to export.\n");
  store.close();
  process.exit(1);
}

const seed: SeedFile = {
  version: 1,
  exportedAt: new Date().toISOString(),
  network: config.network.name,
  outcomes,
};

mkdirSync(dirname(SEED_PATH), { recursive: true });
writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2) + "\n", "utf8");

const trust = new TrustEngine(store);
console.log(`\n✓ wrote ${SEED_PATH}: ${outcomes.length} observations (${config.network.name})\n`);
for (const service of CURATED) {
  const r = trust.recordFor(service.url);
  console.log(
    `  ${service.label.padEnd(20)} ${r.score === null ? "unrated" : r.score.toFixed(3)}  ` +
      `n=${r.observations}` +
      (r.clientErrorCount > 0 ? `  (${r.clientErrorCount} of ours excluded)` : ""),
  );
}
console.log(`\n  Commit this file so a redeploy carries the record with it.\n`);
store.close();
