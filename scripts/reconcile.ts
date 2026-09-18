/**
 * Reconciliation gate. Exits non-zero on any discrepancy, so it can run in CI or
 * as a pre-cutover check rather than only being read by a human.
 *
 * Usage: npm run reconcile [-- --from-round N]
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@sentry402/shared";
import { Store } from "../packages/api/src/db.js";
import { Reconciler } from "../packages/api/src/reconcile.js";

loadDotenv();
const config = loadConfig();
const store = new Store("data/sentry402.sqlite");

const flagIndex = process.argv.indexOf("--from-round");
const fromRound = flagIndex === -1 ? null : Number(process.argv[flagIndex + 1]);

const reconciler = new Reconciler(
  config.network,
  store,
  config.merchantAddress,
  config.payerAddress,
);

const report = await reconciler.run(Number.isFinite(fromRound) ? fromRound : null);

console.log(`\nreconciliation · ${report.network} · ${report.checkedAt}`);
console.log(`  on-chain transfers touching our addresses: ${report.chainTransfers}`);
console.log(`  receipts examined:                        ${report.receipts}`);
console.log(`  matched:                                  ${report.matched}`);

if (report.error) {
  console.error(`\n✗ could not verify: ${report.error}`);
  console.error("  An unreachable indexer proves nothing. This is not a clean result.\n");
  store.close();
  process.exit(1);
}

if (report.discrepancies.length > 0) {
  console.error(`\n✗ ${report.discrepancies.length} discrepancy(ies):\n`);
  for (const d of report.discrepancies) {
    console.error(`  [${d.kind}] ${d.txId}`);
    console.error(`      ${d.detail}`);
  }
  console.error("\n  Every number on the frontend is suspect until this is clean.\n");
  store.close();
  process.exit(1);
}

console.log("\n✓ receipts and chain agree in both directions.\n");
store.close();
