/**
 * A single reservation attempt, in its own process.
 *
 * Exists for the multi-process concurrency test. In production the API server, the
 * prober and the MCP server all open the same SQLite file at once, so the budget guard's
 * BEGIN IMMEDIATE transaction is defending against genuinely parallel writers. An
 * in-process Promise.all cannot demonstrate that, because single-threaded JavaScript
 * serialises the synchronous calls anyway — it would pass even if the guard were
 * advisory.
 *
 * Usage (internal): tsx scripts/reserve-worker.ts <dbPath> <merchant> <amountBase>
 * Prints "allowed" or "refused:<reason>" and exits 0.
 */
import { Store } from "../packages/api/src/db.js";
import { BudgetGuard } from "../packages/api/src/budget.js";

const [dbPath, merchant, amount] = process.argv.slice(2);
if (!dbPath || !merchant || !amount) {
  console.error("usage: reserve-worker <dbPath> <merchant> <amountBase>");
  process.exit(2);
}

const store = new Store(dbPath);
// Caps are passed through the database by the test, so every worker agrees on them.
const guard = new BudgetGuard(store, {
  perCallBase: Number(store.getSetting("test_per_call") ?? 100_000),
  perDayBase: Number(store.getSetting("test_per_day") ?? 500_000),
  perMerchantPerDayBase: Number(store.getSetting("test_per_merchant") ?? 500_000),
});

const decision = guard.reserve({ merchant, route: "/load", amountBase: Number(amount) });
console.log(decision.allowed ? "allowed" : `refused:${decision.reason}`);
store.close();
