/**
 * Pulls receipts from the chain for both addresses.
 *
 * The API server does this on a timer, but the prober and the MCP server run without
 * it, and a downstream that returns no transaction id leaves the request path nothing
 * to key a receipt on. This is the catch-up pass.
 *
 * Several polls, because the indexer pages and lags the newest round.
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "@sentry402/shared";
import { Store } from "../packages/api/src/db.js";
import { SettlementListener } from "../packages/api/src/listener.js";

loadDotenv();
const config = loadConfig();
const store = new Store("data/sentry402.sqlite");

const listener = new SettlementListener(
  config.network,
  store,
  config.merchantAddress,
  "/v1/orchestrate",
  config.payerAddress,
);

const passes = 4;
for (let i = 1; i <= passes; i += 1) {
  const result = await listener.poll();
  console.log(
    `  pass ${i}: scanned ${result.scanned}, wrote ${result.written}` +
      `${result.error ? `, error ${result.error}` : ""}`,
  );
  if (result.written === 0 && !result.error) break;
}

const stats = store.stats();
console.log(
  `\n  inbound  ${stats.settleCount} receipts, ${(stats.totalBase / 1e6).toFixed(6)} USDC` +
    `\n  outbound ${stats.outboundCount} receipts, ${(stats.outboundBase / 1e6).toFixed(6)} USDC\n`,
);
store.close();
