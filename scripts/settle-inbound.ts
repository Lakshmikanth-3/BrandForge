/**
 * Bootstrap settlement: pays our own paid route so a merchant record exists.
 *
 * This is the step that closes Phases 1, 2 and 5 at once. The facilitator creates a
 * merchant record on the first settled payment and auto-catalogs the route into the
 * Bazaar at the same moment, which is what makes `bazaar: true` true.
 *
 * ── Why this refuses to run against localhost ──────────────────────────────────
 *
 * The 402 challenge embeds `resource.url`, derived from the request's own host. The
 * facilitator catalogs that URL. Settling from a local server would therefore publish
 * `http://127.0.0.1:4021/...` as our Bazaar listing, permanently attached to a payTo
 * address the rules forbid us from rotating. A wrong listing is worse than no listing,
 * so the public URL has to be real before the first settlement — not after.
 *
 * ── What this payment is, and is not ──────────────────────────────────────────
 *
 * It is our own payer paying our own merchant. That is a legitimate bootstrap: the
 * PRD plans for exactly one such payment at cutover, because discovery cannot
 * activate without it. It is NOT third-party volume, it must never be counted as a
 * distinct payer, and it is labelled `bootstrap` in the receipt route so it can be
 * excluded from any payer claim later.
 *
 * Usage:
 *   npm run settle:inbound                # orchestration route, refuses on localhost
 *   npm run settle:inbound -- --route trust   # the trust route, catalogued on its own payment
 *   npm run settle:inbound -- --confirm   # required when NETWORK=mainnet
 */
import algosdk from "algosdk";
import { config as loadDotenv } from "dotenv";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { loadConfig } from "@sentry402/shared";
import { Store } from "../packages/api/src/db.js";
import { SettlementListener } from "../packages/api/src/listener.js";
import { accountStatus } from "../packages/api/src/chain.js";

loadDotenv();
const config = loadConfig();
const confirmed = process.argv.includes("--confirm");
/**
 * Each paid route is catalogued by the facilitator on ITS OWN first settled payment, so a
 * route that has never been paid is not in the Bazaar however many others have. Paying only
 * the orchestration route left the trust route unlisted.
 */
const ROUTES = {
  orchestrate: { path: "/v1/orchestrate", method: "POST", priceBase: 50_000 },
  trust: {
    path: "/v1/trust?url=" + encodeURIComponent("https://api-testnet-production-a3ec.up.railway.app/metric/folks/tvl"),
    method: "GET",
    priceBase: 20_000,
  },
} as const;
const routeFlag = process.argv.indexOf("--route");
const routeName = (routeFlag === -1 ? "orchestrate" : process.argv[routeFlag + 1]) as string;
if (routeName !== "orchestrate" && routeName !== "trust") {
  console.error(`
✗ unknown route "${routeName}". Use: orchestrate | trust
`);
  process.exit(1);
}
const routeSpec = ROUTES[routeName];
const route = routeSpec.path;
const target = `${config.publicBaseUrl}${route}`;

function refuse(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// ── Guard: the URL the facilitator will catalog must be the real one ───────────
const host = (() => {
  try {
    return new URL(config.publicBaseUrl).hostname;
  } catch {
    return "";
  }
})();

if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "") {
  refuse(
    `PUBLIC_BASE_URL is ${config.publicBaseUrl}.\n\n` +
      `  The facilitator catalogs the resource URL from the 402 challenge, so settling\n` +
      `  now would publish a localhost address as our Bazaar listing, bound to a payTo\n` +
      `  we are not allowed to rotate. Deploy first, set PUBLIC_BASE_URL to the public\n` +
      `  HTTPS domain, and run this again.`,
  );
}

if (!config.publicBaseUrl.startsWith("https://")) {
  refuse(
    `PUBLIC_BASE_URL is not HTTPS (${config.publicBaseUrl}).\n` +
      `  The facilitator probes over HTTPS and the listing would be wrong.`,
  );
}

if (config.network.name === "mainnet" && !confirmed) {
  refuse(
    `NETWORK=mainnet. This spends real USDC and creates the permanent merchant\n` +
      `  record. Re-run with --confirm when you mean it.`,
  );
}

// ── Guard: the payer must actually be able to pay ──────────────────────────────
const payerState = await accountStatus(config.network, config.payerAddress);
if (!payerState.usdcOptedIn) {
  refuse(`payer ${config.payerAddress} is not opted into USDC ${config.network.usdcAsaId}.`);
}

const priceBase: number = routeSpec.priceBase;
if ((payerState.usdc ?? 0) * 1e6 < priceBase) {
  refuse(
    `payer holds ${(payerState.usdc ?? 0).toFixed(6)} USDC, needs at least ` +
      `${(priceBase / 1e6).toFixed(6)}.`,
  );
}

console.log(`
bootstrap settlement
  network   ${config.network.name}
  paying    ${target}
  from      ${config.payerAddress}
  to        ${config.merchantAddress}
  amount    ${(priceBase / 1e6).toFixed(6)} USDC
`);

// ── Pay ───────────────────────────────────────────────────────────────────────
if (config.secrets.payerMnemonic === null) {
  refuse("PAYER_MNEMONIC is not set. This script pays from the payer, so it needs the key.");
}
const account = algosdk.mnemonicToSecretKey(config.secrets.payerMnemonic);
if (account.addr.toString() !== config.payerAddress) {
  refuse("PAYER_MNEMONIC does not derive PAYER_ADDRESS.");
}

const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
const paidFetch = wrapFetchWithPayment(fetch, client);

const startedAt = Date.now();
let res: Response;
try {
  res = await paidFetch(target, {
    method: routeSpec.method,
    ...(routeSpec.method === "POST"
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrap: true }) }
      : {}),
    signal: AbortSignal.timeout(60_000),
  });
} catch (err) {
  refuse(`payment failed: ${err instanceof Error ? err.message : "unknown error"}`);
}

const elapsed = Date.now() - startedAt;
const body = await res.text();

if (res.status !== 200) {
  console.error(`✗ HTTP ${res.status} after ${elapsed}ms`);
  console.error(`  ${body.slice(0, 300)}\n`);
  process.exit(1);
}

/** The facilitator's settlement receipt, base64 in a response header. */
const settlementHeader = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
let txId: string | null = null;
if (settlementHeader) {
  try {
    const decoded = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf8")) as {
      transaction?: string;
      txId?: string;
      txid?: string;
    };
    txId = decoded.transaction ?? decoded.txId ?? decoded.txid ?? null;
  } catch {
    txId = null;
  }
}

console.log(`✓ paid and served in ${elapsed}ms`);
console.log(`  response ${body.slice(0, 160)}`);
console.log(`  tx       ${txId ?? "not returned in the header; the chain is authoritative"}`);
if (txId) console.log(`  explorer ${config.network.explorerTxBase}${txId}`);

// ── Confirm against the chain, which is the authority ──────────────────────────
const store = new Store("data/sentry402.sqlite");
const listener = new SettlementListener(
  config.network,
  store,
  config.merchantAddress,
  "bootstrap",
  config.payerAddress,
);

console.log(`\nconfirming against the indexer (it lags the round it is confirming)…`);
let written = 0;
for (let i = 1; i <= 6; i += 1) {
  const result = await listener.poll();
  written += result.written;
  if (result.error) console.log(`  pass ${i}: ${result.error}`);
  else console.log(`  pass ${i}: scanned ${result.scanned}, wrote ${result.written}`);
  if (store.stats().settleCount > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

const stats = store.stats();
console.log(`
  inbound receipts  ${stats.settleCount}  (${(stats.totalBase / 1e6).toFixed(6)} USDC)
  receipts written  ${written}
`);

if (stats.settleCount === 0) {
  console.error(
    `✗ no inbound receipt yet. The payment may still be confirming — re-run\n` +
      `  npm run receipts:sync in a minute, then npm run reconcile.\n`,
  );
  store.close();
  process.exit(1);
}

console.log(`Next:
  1. npm run reconcile                     receipts must match the chain
  2. Run the Doctor against ${target}
  3. Check the merchant record and the Bazaar listing:
       ${config.facilitatorUrl}/discovery/merchants
       ${config.facilitatorUrl}/discovery/resources
  4. curl ${config.publicBaseUrl}/api/verification   rows should start turning green

  This payment is a bootstrap, not a customer. It must not be counted as a
  distinct payer; its receipts carry the route "bootstrap" so they can be excluded.
`);

store.close();
