/**
 * Opts both accounts into USDC.
 *
 * An Algorand account cannot hold an ASA it has not opted into, so without this the
 * merchant cannot receive a payment at all — inbound settlements fail rather than
 * arriving. The opt-in is a zero-amount asset transfer from the account to itself,
 * which is a real transaction: it pays a fee and it locks another 0.1 ALGO of
 * minimum balance, which is why ALGO has to be in place first.
 *
 * Idempotent. An account already opted in is skipped rather than re-sent, so this
 * is safe to re-run after a partial failure.
 *
 * On MainNet it requires --confirm. The merchant opt-in genuinely is needed at
 * cutover, so this is not refused outright the way account *creation* is, but it
 * should never happen by accident.
 *
 * Usage:
 *   npm run accounts:optin
 *   npm run accounts:optin -- --confirm     (required when NETWORK=mainnet)
 */
import algosdk from "algosdk";
import { config as loadDotenv } from "dotenv";
import { loadConfig, MIN_BALANCE_MICROALGOS } from "@sentry402/shared";

loadDotenv();
const config = loadConfig();
const confirmed = process.argv.includes("--confirm");

if (config.network.name === "mainnet" && !confirmed) {
  console.error(
    "\n✗ NETWORK=mainnet. Re-run with --confirm if you really mean to opt in on MainNet.\n",
  );
  process.exit(1);
}

const merchantMnemonic = process.env["MERCHANT_MNEMONIC"];
if (!merchantMnemonic) {
  console.error(`
✗ MERCHANT_MNEMONIC is not set.

  The server never needs the merchant key, so accounts:create wrote it to .env as a
  comment. This script does need it, to sign the merchant's own opt-in.

  Uncomment this line in .env:

      # MERCHANT_MNEMONIC=...

  Re-comment it afterwards if you prefer; nothing else reads it.
`);
  process.exit(1);
}

const algod = new algosdk.Algodv2("", config.network.algodUrl, "");
const assetId = Number(config.network.usdcAsaId);

interface Target {
  label: string;
  account: algosdk.Account;
}

if (config.secrets.payerMnemonic === null) {
  console.error("\n\u2717 PAYER_MNEMONIC is not set, so the payer cannot sign its opt-in.\n");
  process.exit(1);
}

const targets: Target[] = [
  { label: "merchant", account: algosdk.mnemonicToSecretKey(merchantMnemonic.trim()) },
  { label: "payer", account: algosdk.mnemonicToSecretKey(config.secrets.payerMnemonic) },
];

for (const { label, account } of targets) {
  const address = account.addr.toString();

  // Guard the derivation: a mnemonic that does not match the configured address
  // would opt in the wrong account and look like it worked.
  const expected = label === "merchant" ? config.merchantAddress : config.payerAddress;
  if (address !== expected) {
    console.error(
      `✗ ${label}: mnemonic derives ${address} but .env says ${expected}. Refusing.`,
    );
    process.exit(1);
  }

  let info: Awaited<ReturnType<ReturnType<algosdk.Algodv2["accountInformation"]>["do"]>>;
  try {
    info = await algod.accountInformation(address).do();
  } catch {
    console.error(`✗ ${label} ${address}\n    not found on chain — it needs ALGO first.`);
    process.exit(1);
  }

  const micro = Number(info.amount ?? 0);
  const assets = (info.assets ?? []) as { assetId?: bigint | number }[];

  if (assets.some((a) => Number(a.assetId) === assetId)) {
    console.log(`✓ ${label.padEnd(9)} ${address}\n    already opted into USDC ${assetId}`);
    continue;
  }

  // Needs the existing minimum plus another 0.1 ALGO for the new asset, plus a fee.
  const needed = MIN_BALANCE_MICROALGOS + 100_000 + 1_000;
  if (micro < needed) {
    console.error(
      `✗ ${label.padEnd(9)} ${address}\n` +
        `    has ${(micro / 1e6).toFixed(6)} ALGO, needs about ${(needed / 1e6).toFixed(6)} ` +
        `to opt in.\n    Fund it at https://bank.testnet.algorand.network first.`,
    );
    process.exit(1);
  }

  const suggestedParams = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address, // self-transfer of zero is what an opt-in is
    assetIndex: assetId,
    amount: 0,
    suggestedParams,
  });

  const signed = txn.signTxn(account.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txid, 10);

  console.log(
    `✓ ${label.padEnd(9)} ${address}\n` +
      `    opted into USDC ${assetId}\n` +
      `    ${config.network.explorerTxBase}${txid}`,
  );
}

console.log(`
Next:
  1. USDC for the payer only, from https://faucet.circle.com (Algorand Testnet).
     The merchant needs the opt-in so it can receive, not a balance.
  2. npm run accounts:check
`);
