/**
 * The kill switch: halts all outbound payments immediately.
 *
 * It was implemented and tested from the start and then never wired to anything a
 * human could reach — `halt()` was called only from its own tests. A safety control
 * nobody can trigger is not a safety control, so this is the handle.
 *
 * ── Why a CLI and not an endpoint ─────────────────────────────────────────────
 *
 * There is no authentication on this service. An unauthenticated HTTP route that
 * halts our spending would let anyone disable the bridge, and one that resumes it
 * would let anyone re-enable spending we had deliberately stopped. Neither belongs on
 * a public domain. The state lives in the database, so this reaches it directly and
 * the running server picks it up on its next reservation — no restart, no deploy.
 *
 * Usage:
 *   npm run kill-switch            # status
 *   npm run kill-switch -- on      # halt outbound payments
 *   npm run kill-switch -- off     # resume
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@sentry402/shared";
import { Store } from "../packages/api/src/db.js";
import { BudgetGuard } from "../packages/api/src/budget.js";

loadDotenv();
const config = loadConfig();

const arg = process.argv.slice(2).find((a) => !a.startsWith("-"))?.toLowerCase();
if (arg !== undefined && arg !== "on" && arg !== "off" && arg !== "status") {
  console.error(`\n✗ unknown argument "${arg}". Use: on | off | status\n`);
  process.exit(1);
}

const store = new Store("data/sentry402.sqlite");
const guard = new BudgetGuard(store);

function report(): void {
  const status = guard.status();
  const state = status.halted ? "HALTED" : "armed";
  console.log(`
  kill switch   ${state}
  network       ${config.network.name}
  spent today   ${(status.committedTodayBase / 1e6).toFixed(6)} USDC
  remaining     ${(status.remainingDayBase / 1e6).toFixed(6)} USDC of ${(
    status.limits.perDayBase / 1e6
  ).toFixed(2)}
`);
}

if (arg === "on") {
  guard.halt();
  console.log(`
✓ outbound payments HALTED.

  Takes effect on the next reservation, so a payment already in flight completes and
  nothing is left half-done. Inbound payments are unaffected: people can still pay us,
  we just stop paying anyone.

  The state is in the database, so it survives a restart and a redeploy. Nothing
  resumes it automatically -- run "npm run kill-switch -- off" when you mean to.`);
  report();
} else if (arg === "off") {
  const wasHalted = guard.isHalted();
  guard.resume();
  console.log(
    wasHalted
      ? `\n✓ outbound payments resumed.`
      : `\n  already armed; nothing to resume.`,
  );
  report();
} else {
  report();
  if (guard.isHalted()) {
    console.log(`  Outbound payments are stopped. "npm run kill-switch -- off" resumes them.\n`);
  }
}

store.close();
