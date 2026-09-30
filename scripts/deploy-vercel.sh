#!/usr/bin/env bash
# Deploy BrandForge to Vercel production, injecting env from a local env file.
#
# Why --env: the Vercel CLI (50.9.x) mangled `vercel env add` values piped via
# echo (trailing newline), which broke strict validation (NETWORK, addresses).
# Passing --env at deploy time overrides the stored project vars with clean
# values, so the deploy is reproducible regardless of what's stored server-side.
#
# Usage:
#   bash scripts/deploy-vercel.sh            # uses .env (TestNet)
#   bash scripts/deploy-vercel.sh .env.mainnet   # MainNet cutover
set -euo pipefail

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "✗ env file not found: $ENV_FILE"; exit 1; }

# Read a value: take everything after the first '=', strip an inline "# comment",
# trim surrounding whitespace, and drop any stray CR/LF.
val() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- \
    | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
    | tr -d '\r\n'
}

NETWORK=$(val NETWORK)
PUBLIC_BASE_URL=$(val PUBLIC_BASE_URL)
FACILITATOR_URL=$(val FACILITATOR_URL)
MERCHANT_ADDRESS=$(val MERCHANT_ADDRESS)
PAYER_ADDRESS=$(val PAYER_ADDRESS)
PAYER_MNEMONIC=$(val PAYER_MNEMONIC)

echo "Deploying: network=$NETWORK  base=$PUBLIC_BASE_URL  merchant=${MERCHANT_ADDRESS:0:8}…"

vercel --prod --yes \
  --env "NETWORK=$NETWORK" \
  --env "PUBLIC_BASE_URL=$PUBLIC_BASE_URL" \
  --env "FACILITATOR_URL=$FACILITATOR_URL" \
  --env "MERCHANT_ADDRESS=$MERCHANT_ADDRESS" \
  --env "PAYER_ADDRESS=$PAYER_ADDRESS" \
  --env "PAYER_MNEMONIC=$PAYER_MNEMONIC"
