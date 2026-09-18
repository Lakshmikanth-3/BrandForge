/**
 * Phase 0 exit gate: asserts both accounts exist, hold ALGO, and are opted into
 * USDC. Exits non-zero so CI or a pre-phase check can depend on it.
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@sentry402/shared";
import { accountStatus } from "../packages/api/src/chain.js";

loadDotenv();
const config = loadConfig();

const results = await Promise.all(
  (
    [
      ["merchant", config.merchantAddress],
      ["payer", config.payerAddress],
    ] as const
  ).map(async ([label, address]) => ({
    label,
    status: await accountStatus(config.network, address),
  })),
);

console.log(`\nnetwork: ${config.network.name}  USDC ASA ${config.network.usdcAsaId}\n`);
let failed = false;

for (const { label, status } of results) {
  const problems: string[] = [];
  if (!status.funded) problems.push("holds no ALGO — fund it first");
  if (status.spendableAlgo <= 0) problems.push("no spendable ALGO above min-balance");
  if (!status.usdcOptedIn) problems.push(`not opted into USDC ${config.network.usdcAsaId}`);

  const mark = problems.length === 0 ? "✓" : "✗";
  console.log(
    `${mark} ${label.padEnd(9)} ${status.address}\n` +
      `    ALGO ${status.algo.toFixed(6)} (spendable ${status.spendableAlgo.toFixed(6)})  ` +
      `USDC ${status.usdc === null ? "— not opted in" : status.usdc.toFixed(6)}`,
  );
  for (const p of problems) console.log(`    → ${p}`);
  if (problems.length > 0) failed = true;
}

console.log(failed ? "\n✗ Phase 0 account gate NOT met.\n" : "\n✓ Phase 0 account gate met.\n");
process.exit(failed ? 1 : 0);
