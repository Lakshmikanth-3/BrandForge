/**
 * End-to-end test against the LIVE TestNet deployment.
 *
 * Every step talks to the real public URL, the real facilitator and the real chain. Nothing
 * is mocked. It is TestNet only and refuses to run otherwise, and the settlements it makes
 * are test traffic from a throwaway account we control: they are NOT customer volume and
 * must never be presented as such.
 *
 * Usage:
 *   npm run e2e:testnet
 *   npm run e2e:testnet -- https://your-host.vercel.app
 */
import algosdk from "algosdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "@sentry402/shared";

loadDotenv();
const config = loadConfig();
if (config.network.name !== "testnet") {
  console.error("✗ e2e-testnet runs on TestNet only. Set NETWORK=testnet.");
  process.exit(1);
}

const BASE =
  process.argv.slice(2).find((a) => a.startsWith("http"))?.replace(/\/$/, "") ??
  config.publicBaseUrl;
if (!BASE.startsWith("https://")) {
  console.error("✗ The e2e test targets the deployed HTTPS URL, not a local server.");
  process.exit(1);
}

const algod = new algosdk.Algodv2("", config.network.algodUrl, "");
const USDC = Number(config.network.usdcAsaId);
const CUSTOMER_FILE = "data/e2e-customer.json";

interface Result {
  step: string;
  pass: boolean;
  detail: string;
}
const results: Result[] = [];
const record = (step: string, pass: boolean, detail: string) => {
  results.push({ step, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${step}\n    ${detail}`);
};
const guarded = async (step: string, fn: () => Promise<string>) => {
  try {
    record(step, true, await fn());
  } catch (err) {
    record(step, false, err instanceof Error ? err.message : String(err));
  }
};

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

// ───────────── 1. throwaway customer ─────────────
let customer: algosdk.Account;
await guarded("1. throwaway customer account, funded and opted in", async () => {
  mkdirSync("data", { recursive: true });
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
  const notes: string[] = [];

  if (Number(info.amount) < 400_000) {
    const tx = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: payer.addr, receiver: addr, amount: 500_000, suggestedParams: sp,
    });
    notes.push(`ALGO ${await send(tx, payer.sk)}`);
  }
  if (!(info.assets ?? []).some((a) => Number(a.assetId) === USDC)) {
    const optin = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: addr, receiver: addr, assetIndex: USDC, amount: 0, suggestedParams: sp,
    });
    notes.push(`opt-in ${await send(optin, customer.sk)}`);
  }
  if ((await usdcOf(addr)) < 300_000) {
    const tx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: payer.addr, receiver: addr, assetIndex: USDC, amount: 500_000, suggestedParams: sp,
    });
    notes.push(`USDC ${await send(tx, payer.sk)}`);
  }
  return `${addr}  USDC ${(await usdcOf(addr)) / 1e6}${notes.length ? `  [${notes.join(", ")}]` : ""}`;
});

// ───────────── 2. unpaid requests get a real 402 ─────────────
await guarded("2. both paid routes answer 402 with a v2 challenge", async () => {
  for (const [method, path] of [["POST", "/v1/orchestrate"], ["GET", "/v1/trust?url=https://example.test"]] as const) {
    const res = await fetch(`${BASE}${path}`, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
    if (res.status !== 402) throw new Error(`${path} returned ${res.status}`);
    if (!res.headers.get("payment-required")) throw new Error(`${path}: no payment-required header`);
  }
  return "402 + payment-required on /v1/orchestrate and /v1/trust";
});

// ───────────── 3. a customer pays for real, capturing the proof ─────────────
let capturedProof: string | null = null;
await guarded("3. customer pays $0.02 for a trust record, settles on chain", async () => {
  if (!customer) throw new Error("no customer");
  const signer = toClientAvmSigner(Buffer.from(customer.sk).toString("base64"));
  const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
  const spy: typeof fetch = async (input, init) => {
    // The client hands over either a Request (headers live on it) or a url plus init.
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const proof = h.get("payment-signature") ?? h.get("x-payment");
    if (proof) capturedProof = proof;
    return fetch(input, init);
  };
  const before = await usdcOf(customer.addr.toString());
  const res = await wrapFetchWithPayment(spy, client)(`${BASE}/v1/trust?url=${encodeURIComponent("https://example.test/x")}`);
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as Record<string, unknown>;
  const after = await usdcOf(customer.addr.toString());
  if (before - after !== 20_000) throw new Error(`customer USDC moved ${before - after}, expected 20000`);
  return `HTTP 200, customer USDC -0.02 exactly, keys: ${Object.keys(body).join(",")}`;
});

// ───────────── 4. replay is refused ─────────────
await guarded("4. replaying the same payment proof does not get a second answer", async () => {
  if (!capturedProof) throw new Error("no proof captured in step 3");
  const res = await fetch(`${BASE}/v1/trust?url=${encodeURIComponent("https://example.test/x")}`, {
    headers: { "payment-signature": capturedProof, "x-payment": capturedProof },
  });
  if (res.status === 200) throw new Error("REPLAY ACCEPTED: a spent proof returned 200");
  return `replay refused with HTTP ${res.status}`;
});

// ───────────── 5. failure injection over real HTTPS ─────────────
await guarded("5. failure-injection routes are live and misbehave on purpose", async () => {
  const index = await fetch(`${BASE}/__inject`);
  if (index.status !== 200) throw new Error(`index ${index.status}`);
  const gone = await fetch(`${BASE}/__inject/vanished`);
  if (gone.status !== 404) throw new Error(`/vanished returned ${gone.status}, expected 404`);
  return "index 200, /vanished 404";
});

// ───────────── 6. MCP server over stdio, real paid call ─────────────
const mcp = new Client({ name: "e2e", version: "1" });
await guarded("6. MCP over stdio: list tools, read budget, make a real paid call", async () => {
  await mcp.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "packages/mcp/src/index.ts"], env: process.env as Record<string, string> }));
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  if (!tools.includes("sentry402_budget") || !tools.includes("folks_tvl")) throw new Error(`tools: ${tools.join(",")}`);
  const call = (await mcp.callTool({ name: "folks_tvl", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
  const text = call.content[0]?.text ?? "";
  if (call.isError) throw new Error(`paid call refused: ${text.slice(0, 200)}`);
  return `${tools.length} tools; paid call ok: ${text.replace(/\s+/g, " ").slice(0, 120)}`;
});

// ───────────── 7. kill switch halts real spending ─────────────
await guarded("7. kill switch: halted call moves no money, resumes after", async () => {
  const ks = (arg?: string) => execFileSync("npx", ["tsx", "scripts/kill-switch.ts", ...(arg ? [arg] : [])], { encoding: "utf8", shell: true });
  const balance = () => usdcOf(payer.addr.toString());
  try {
    ks("on");
    const before = await balance();
    const call = (await mcp.callTool({ name: "folks_tvl", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    if (!call.isError) throw new Error("call succeeded while halted");
    if ((await balance()) !== before) throw new Error("money moved while halted");
  } finally {
    ks("off");
  }
  const resumed = (await mcp.callTool({ name: "folks_tvl", arguments: {} })) as { isError?: boolean };
  if (resumed.isError) throw new Error("did not resume after switch off");
  return "refused while halted (payer balance unchanged), paid again after resume";
});
await mcp.close().catch(() => undefined);

// ───────────── 8. reconciliation and 9. Doctor ─────────────
await guarded("8. reconciliation: chain and records agree", async () => {
  const res = await fetch(`${BASE}/api/reconcile`);
  const r = (await res.json()) as { clean?: boolean; matched?: number; onChain?: number; discrepancies?: unknown[] };
  if (!r.clean) throw new Error(`not clean: ${JSON.stringify(r).slice(0, 300)}`);
  return `clean, ${r.matched ?? "?"} matched`;
});

await guarded("9. GoPlausible Doctor: BAZAAR and HACKATHON badges", async () => {
  const res = await fetch("https://facilitator.goplausible.xyz/data/doctor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${BASE}/v1/orchestrate`, method: "POST" }),
  });
  const j = (await res.json()) as { ok?: boolean; badges?: { bazaar: { present: boolean }; hackathon: { present: boolean } }; remaining?: number };
  if (!j.ok || !j.badges) throw new Error("doctor returned no badges");
  if (!j.badges.bazaar.present) throw new Error("BAZAAR not listed");
  return `BAZAAR ${j.badges.bazaar.present}, HACKATHON ${j.badges.hackathon.present} (${j.remaining} checks left today)`;
});

// ───────────── report ─────────────
const passed = results.filter((r) => r.pass).length;
const report = [
  `# End-to-end TestNet report`,
  ``,
  `Run: ${new Date().toISOString()}  ·  Target: ${BASE}  ·  Network: testnet`,
  ``,
  `**${passed}/${results.length} steps passed.**`,
  ``,
  `> Test traffic from a throwaway account we control. Not customer volume.`,
  ``,
  ...results.map((r) => `- ${r.pass ? "PASS" : "FAIL"} — ${r.step}: ${r.detail}`),
  ``,
].join("\n");
mkdirSync("docs", { recursive: true });
writeFileSync("docs/e2e-testnet-report.md", report);
console.log(`\n${passed}/${results.length} passed. Report: docs/e2e-testnet-report.md`);
process.exit(passed === results.length ? 0 : 1);
