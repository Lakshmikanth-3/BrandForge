/**
 * Buy ONE brand kit over x402, for the demo.
 *
 * Pays the real /v1/brand-kit endpoint with a throwaway TestNet account we control,
 * so a genuine inbound settlement lands in the "Recent brand kit payments" panel.
 * This is TEST TRAFFIC from an account we own — it is NOT customer volume.
 *
 * Defaults to the local server (http://localhost:4021) so the receipt shows up in the
 * dashboard you are watching. Pass a URL to target a deployment instead.
 *
 *   npx tsx scripts/pay-brand-kit.ts
 *   npx tsx scripts/pay-brand-kit.ts http://localhost:4021
 */
import algosdk from "algosdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { loadConfig } from "@sentry402/shared";

loadDotenv();
const config = loadConfig();
if (config.network.name !== "testnet") {
  console.error("✗ pay-brand-kit runs on TestNet only. Set NETWORK=testnet.");
  process.exit(1);
}

const BASE = (process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:4021").replace(/\/$/, "");
const algod = new algosdk.Algodv2("", config.network.algodUrl, "");
const USDC = Number(config.network.usdcAsaId);
const CUSTOMER_FILE = "data/e2e-customer.json";

const payerMnemonic = process.env["PAYER_MNEMONIC"];
if (!payerMnemonic) {
  console.error("✗ PAYER_MNEMONIC is needed to fund the throwaway customer.");
  process.exit(1);
}
const payer = algosdk.mnemonicToSecretKey(payerMnemonic);

async function send(txn: algosdk.Transaction, sk: Uint8Array): Promise<string> {
  const { txid } = await algod.sendRawTransaction(txn.signTxn(sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 8);
  return txid;
}

async function usdcOf(address: string): Promise<number> {
  const info = await algod.accountInformation(address).do();
  const held = (info.assets ?? []).find((a) => Number(a.assetId) === USDC);
  return held ? Number(held.amount) : 0;
}

function decodeTxId(header: string | null): string | null {
  if (!header) return null;
  try {
    const j = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      transaction?: string;
      txId?: string;
      txid?: string;
    };
    return j.transaction ?? j.txId ?? j.txid ?? null;
  } catch {
    return null;
  }
}

async function main() {
  // 1. Throwaway customer — reuse if present, otherwise create, fund and opt in.
  mkdirSync("data", { recursive: true });
  let customer: algosdk.Account;
  if (existsSync(CUSTOMER_FILE)) {
    customer = algosdk.mnemonicToSecretKey(JSON.parse(readFileSync(CUSTOMER_FILE, "utf8")).mnemonic);
  } else {
    customer = algosdk.generateAccount();
    writeFileSync(
      CUSTOMER_FILE,
      JSON.stringify({ address: customer.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(customer.sk) }),
    );
  }
  const addr = customer.addr.toString();
  const sp = await algod.getTransactionParams().do();
  const info = await algod.accountInformation(addr).do();

  if (Number(info.amount) < 400_000) {
    const tx = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: payer.addr, receiver: addr, amount: 500_000, suggestedParams: sp,
    });
    console.log(`  funded ALGO: ${await send(tx, payer.sk)}`);
  }
  if (!(info.assets ?? []).some((a) => Number(a.assetId) === USDC)) {
    const optin = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: addr, receiver: addr, assetIndex: USDC, amount: 0, suggestedParams: sp,
    });
    console.log(`  opted in USDC: ${await send(optin, customer.sk)}`);
  }
  if ((await usdcOf(addr)) < 100_000) {
    const tx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: payer.addr, receiver: addr, assetIndex: USDC, amount: 500_000, suggestedParams: sp,
    });
    console.log(`  funded USDC: ${await send(tx, payer.sk)}`);
  }
  console.log(`  customer ${addr}  USDC ${(await usdcOf(addr)) / 1e6}`);

  // 2. Pay the brand-kit endpoint over x402.
  const signer = toClientAvmSigner(Buffer.from(customer.sk).toString("base64"));
  const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
  const pay = wrapFetchWithPayment(fetch, client);

  const url = `${BASE}/v1/brand-kit?name=Northwind&industry=fintech&vibe=modern,bold`;
  console.log(`\n  paying ${url} …`);

  const before = await usdcOf(addr);
  const res = await pay(url);
  const after = await usdcOf(addr);
  const body = (await res.json()) as {
    name?: string;
    tagline?: string;
    palette?: { primary?: string };
    meta?: { version?: string };
  };
  const txId = decodeTxId(res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE"));

  console.log(`\n✓ HTTP ${res.status}`);
  console.log(`  kit v${body.meta?.version}: ${body.name} — "${body.tagline}"  primary ${body.palette?.primary}`);
  console.log(`  sections returned: ${Object.keys(body).join(", ")}`);
  console.log(`  customer USDC moved: ${(before - after) / 1e6} (expected 0.03)`);
  if (txId) {
    console.log(`  settlement tx: ${txId}`);
    console.log(`  explorer: ${config.network.explorerTxBase}${txId}`);
  }
  console.log(`\n  The dashboard polls every 15s — the payment will appear in "Recent brand kit payments".`);
}

main().catch((err) => {
  console.error("✗ failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
