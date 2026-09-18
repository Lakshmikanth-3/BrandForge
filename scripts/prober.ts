/**
 * Paced prober.
 *
 * Calls each curated service on an interval, paying for real, to build the
 * observation history the trust engine scores. This is the mechanism that makes a
 * trust score possible at all: the record has to come from calls the bridge
 * actually routed and paid for, not from a synthetic fixture.
 *
 * Pacing is deliberate and not a throttle for safety. Thirty calls in ninety seconds
 * and thirty calls over fifteen minutes cost the same and yield the same data, but
 * only one of them reads like a service operating when someone looks at the
 * timestamps later. Those timestamps are permanent.
 *
 * Every call goes through the same payer the MCP server uses, so it passes the trust
 * gate and the budget guard like any other. If the guard refuses, the prober reports
 * it and keeps going rather than exiting: a refusal is a valid observation.
 *
 * Usage:
 *   npm run prober -- --calls 30 --interval 25
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@sentry402/shared";
import { Store } from "../packages/api/src/db.js";
import { BudgetGuard } from "../packages/api/src/budget.js";
import { TraceHub } from "../packages/api/src/trace.js";
import { TrustEngine } from "../packages/api/src/trust.js";
import { DownstreamPayer } from "../packages/api/src/payer.js";
import { CURATED, samplePayloadFor } from "../packages/api/src/catalog.js";

loadDotenv();
const config = loadConfig();

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const totalCalls = arg("calls", 30);
const intervalSec = arg("interval", 25);

const store = new Store("data/sentry402.sqlite");
const guard = new BudgetGuard(store);
const hub = new TraceHub(store, config.network.name);
const trust = new TrustEngine(store);
const payer = new DownstreamPayer(config, store, guard, hub, trust);

/** Price from the registry, preferring what the endpoint actually quoted. */
function priceFor(url: string): number | null {
  const row = store
    .services({ allowlistedOnly: true, network: config.network.caip2 })
    .find((s) => s.resourceUrl === url);
  if (!row) return null;
  return row.probeLiveAmount ?? row.amountBase;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(
  `\nprober · ${config.network.name} · ${totalCalls} calls across ${CURATED.length} ` +
    `services, one every ${intervalSec}s\n` +
    `  estimated duration ${Math.round((totalCalls * intervalSec) / 60)} min\n`,
);

let ok = 0;
let failed = 0;
let spentBase = 0;

for (let i = 0; i < totalCalls; i += 1) {
  const service = CURATED[i % CURATED.length]!;
  const amountBase = priceFor(service.url);

  if (amountBase === null) {
    console.log(`  ${pad(i + 1)} ${service.label.padEnd(20)} SKIP  no verified price on record`);
    failed += 1;
  } else {
    const startedAt = Date.now();
    // The body the service publishes via discovery, not a guess.
    const payload = samplePayloadFor(store, service.url);
    const outcome = await payer.pay(service, amountBase, payload);
    const elapsed = Date.now() - startedAt;

    if (outcome.ok) {
      ok += 1;
      spentBase += outcome.amountBase ?? 0;
      console.log(
        `  ${pad(i + 1)} ${service.label.padEnd(20)} OK    ${String(elapsed).padStart(6)}ms  ` +
          `${((outcome.amountBase ?? 0) / 1e6).toFixed(6)} USDC  ` +
          `${outcome.txId ? outcome.txId.slice(0, 10) : "no tx id"}`,
      );
    } else {
      failed += 1;
      console.log(
        `  ${pad(i + 1)} ${service.label.padEnd(20)} FAIL  ${String(elapsed).padStart(6)}ms  ` +
          `${(outcome.error ?? "").slice(0, 60)}`,
      );
    }
  }

  // No wait after the final call.
  if (i < totalCalls - 1) await sleep(intervalSec * 1_000);
}

console.log(`\n  ${ok} ok · ${failed} failed · ${(spentBase / 1e6).toFixed(6)} USDC spent`);
console.log(`  budget remaining today: ${guard.status().remainingDayBase / 1e6} USDC\n`);

console.log("trust records now:");
for (const service of CURATED) {
  const record = trust.recordFor(service.url);
  console.log(
    `  ${service.label.padEnd(20)} ${
      record.score === null ? "unrated" : record.score.toFixed(3)
    }  ${String(record.verdict).padEnd(8)} n=${record.observations}`,
  );
}
console.log();

store.close();

function pad(n: number): string {
  return String(n).padStart(3);
}
