# Sentry402

**An agent discovers, verifies, and pays for any x402 service on Algorand — per call, under budget, without ever seeing a wallet.**

Entry type: **Orchestrator** — Algorand Global x402 Challenge.

One MCP server turns the Algorand x402 Bazaar into native agent tools. An agent can
discover any live x402 service, check whether it actually delivers before paying it,
and settle per call in USDC on Algorand under a developer-set budget. The reliability
record the bridge builds from its own routed traffic is itself sold as a paid x402
endpoint.

> Status: **Phase 0 complete** — foundation, TestNet accounts, health surface, deploy config.
> Not yet on MainNet. See `PRD — Agentic x402 Bridge + Trust Layer` for the full plan.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node 22 + TypeScript (strict, ESM) |
| HTTP | Hono + `@hono/node-server` |
| x402 server | `@x402/hono`, `@x402/core`, `@x402/avm` |
| x402 client | `@x402/axios` |
| Discovery | `@x402-avm/extensions` (`declareDiscoveryExtension`, `bazaarResourceServerExtension`) |
| Chain reads | `algosdk` → algod + indexer |
| MCP | Official MCP TypeScript SDK |
| Facilitator | GoPlausible — `https://facilitator.goplausible.xyz` |

The `@x402/*` packages are the current namespace (2.26.x). The older `@x402-avm/express`
family is pinned at 2.6.1 from March 2026 and is **not** used, except for
`@x402-avm/extensions`, which is where the Bazaar discovery helpers still live — the
same split the Foundation's own demo uses.

## Layout

```
packages/shared   network constants + validated env schema (the NETWORK switch)
packages/api      Hono server: /healthz, /livez, static site, paid routes (Phase 1)
packages/mcp      MCP server exposing catalog services as tools (Phase 3)
apps/web          status page / dashboard, live from /healthz
scripts           account creation and the Phase 0 account gate
skills            Algorand agent skills (algorand-devrel/algorand-agent-skills)
```

## Network constants

|  | TestNet | MainNet |
| --- | --- | --- |
| USDC ASA | `10458941` | `31566704` |
| CAIP-2 | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |

Verified against the facilitator's `/supported` by a contract test that fails loudly
if either changes. `NETWORK` is the only switch; nothing reads a chain literal directly.

## Local setup

```bash
npm install
npm run accounts:create -- --write   # generates 2 TestNet accounts into .env
```

Then fund both accounts — each needs ALGO before it can opt into USDC:

1. ALGO: <https://lora.algokit.io/testnet/fund>
2. USDC: <https://faucet.circle.com> → Algorand TestNet
3. Opt both into USDC ASA `10458941`

```bash
npm run accounts:check    # Phase 0 exit gate; non-zero until both are opted in
npm run build && npm run dev
```

`/healthz` returns `503 degraded` until both accounts are funded and opted in. That is
correct behaviour, not a bug — an account that cannot hold USDC breaks every payment.

## Tests

```bash
npm test        # unit + contract + /healthz contract
npm run typecheck
```

| Suite | Covers |
| --- | --- |
| `packages/shared/src/env.test.ts` | NETWORK switch, env rejection, secret containment |
| `packages/shared/src/networks.test.ts` | Live contract test against facilitator `/supported` |
| `packages/api/src/app.test.ts` | `/healthz` + `/livez` shape, CORS, no key leakage |

## Deploy

Railway, single service, `railway.json` committed. One service owns the whole root
domain — the Foundation requires one root domain per `payTo` address, so the API and
the site must not be split, and routes differentiate by **path**, never subdomain.

Required Railway variables: `NETWORK`, `PUBLIC_BASE_URL`, `FACILITATOR_URL`,
`MERCHANT_ADDRESS`, `PAYER_ADDRESS`, `PAYER_MNEMONIC`. `BUILD_SHA` is taken from
`RAILWAY_GIT_COMMIT_SHA` automatically.

## MainNet evidence

Not yet applicable — no MainNet transaction has been made. This section will carry the
merchant address, `bazaar`/`challenge` flags, settle count and sample transaction ids
after cutover.
