/**
 * Creates the two Phase 0 accounts.
 *
 * Default: prints them once to stdout, writes nothing.
 * `--write`: fills a fresh .env from .env.example so the mnemonic lands in a
 *            gitignored file rather than a terminal scrollback. Refuses to
 *            overwrite an existing .env.
 *
 * Refuses outright on mainnet — the mainnet merchant address is permanent
 * (PRD §20) and must not be produced by a convenience script.
 */
import algosdk from "algosdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (process.env["NETWORK"] === "mainnet") {
  console.error("✗ Refusing to generate mainnet accounts. Create them deliberately.");
  process.exit(1);
}

const write = process.argv.includes("--write");

function make() {
  const account = algosdk.generateAccount();
  return { address: account.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(account.sk) };
}

const merchant = make();
const payer = make();

if (write) {
  if (existsSync(".env")) {
    console.error("✗ .env already exists — refusing to overwrite. Remove it first.");
    process.exit(1);
  }
  const env =
    readFileSync(".env.example", "utf8")
      .replace("MERCHANT_ADDRESS=", `MERCHANT_ADDRESS=${merchant.address}`)
      .replace("PAYER_ADDRESS=", `PAYER_ADDRESS=${payer.address}`)
      .replace("PAYER_MNEMONIC=", `PAYER_MNEMONIC=${payer.mnemonic}`) +
    `\n# Merchant mnemonic — the server never needs it. Keep a copy somewhere safe.\n` +
    `# MERCHANT_MNEMONIC=${merchant.mnemonic}\n`;
  writeFileSync(".env", env);
  console.log("✓ .env written (gitignored). Mnemonics are in the file, not in this output.\n");
} else {
  console.log("\n=== Sentry402 TestNet accounts ===\n");
  console.log(`merchant (RECEIVES — address only on the server)`);
  console.log(`  address:  ${merchant.address}\n  mnemonic: ${merchant.mnemonic}\n`);
  console.log(`payer (SPENDS — needs the mnemonic)`);
  console.log(`  address:  ${payer.address}\n  mnemonic: ${payer.mnemonic}\n`);
  console.log("Re-run with --write to place these into .env instead.\n");
}

console.log(`merchant  ${merchant.address}`);
console.log(`payer     ${payer.address}`);
console.log(`
--- fund BOTH accounts (each needs ALGO before it can opt into USDC) ---
1. ALGO:  https://lora.algokit.io/testnet/fund   (or https://bank.testnet.algorand.network)
2. USDC:  https://faucet.circle.com  → Algorand TestNet
3. Opt both accounts into USDC ASA 10458941, then: npm run accounts:check
`);
