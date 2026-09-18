# Sentry402

**An agent discovers, verifies, and pays for any x402 service on Algorand — per call, under budget, without ever seeing a wallet.**

Entry type: **Orchestrator** — Algorand Global x402 Challenge.

One MCP server turns the Algorand x402 Bazaar into native agent tools. An agent can
discover any live x402 service, check whether it actually delivers before paying it,
and settle per call in USDC on Algorand under a developer-set budget. The reliability
record the bridge builds from its own routed traffic is itself sold as a paid x402
endpoint.

> Status: **Phase 2 code complete** — paid route, trace engine, live flow UI, Bazaar
> discovery declared, domain metadata served, catalog ingester with 6 curated and
> probe-verified downstream services. Not yet on MainNet; badge confirmation needs
> the public endpoint.

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
packages/api      Hono server: paid x402 route, trace engine, receipt store,
                  settlement listener, read API + SSE stream
packages/mcp      MCP server exposing catalog services as tools (Phase 3)
apps/web          React + Vite dashboard: live flow visualiser, receipts, counters
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
| `packages/api/src/x402.test.ts` | 402 conformance, ASA/base units, challenge tag, tracing, receipt idempotency |
| `packages/api/src/trace.test.ts` | Stall detection, halt-point marking, persistence |
| `packages/api/src/catalog.test.ts` | Catalog normalisation, probe verdicts, drift, curation, staleness |

### Discovery and the catalog (Phase 2)

`declareDiscoveryExtension` is declared per route and `bazaarResourceServerExtension`
is registered on the resource server. Both are required: without them the endpoint
takes payments and is never catalogued. The first settled payment then auto-catalogs
it — there is no separate registration step.

Domain metadata is served at the root, because the facilitator probes the domain:

- `GET /llms.txt`
- `GET /.well-known/agent-card.json`

The facilitator derives merchant identity from OpenGraph tags, `llms.txt` or
`agent-card.json`. It does **not** read an MCP manifest — worth stating because the
opposite is easy to assume.

**The HACKATHON badge requires MainNet routes**, so on TestNet only BAZAAR is
reachable. That is expected, not a failure.

#### What the live catalog is actually like

Measured against the real listing on 2026-09-18 (`npm run catalog:ingest`):

| | |
| --- | --- |
| Routes in the catalog | 2,087 |
| Payable on TestNet (USDC, exact) | 233 |
| Skipped as not-for-us or malformed | 1,854 |
| Curated and probe-verified | 6 |

Three things the ingester exists to handle, all observed rather than assumed:

1. **Entries go stale.** Of the ten busiest TestNet services, three answered 400 or
   404. A catalog entry is a claim, so nothing becomes a tool until a live probe
   confirms a spec-compliant 402.
2. **Prices drift.** Two verified services charged a different amount than the
   catalog advertised — one 5x, one 8.5x. The probe records the live price and
   surfaces the mismatch rather than paying it silently.
3. **A first-call timeout is usually a cold start.** Four services timed out at 20s
   and then answered in ~1.5s once warm. Probes retry once before recording
   unreachable; without that the trust engine would condemn most of the ecosystem
   for being on a free tier.

Curation is by **exact URL, not host**: one vendor publishes 30 routes and another 19,
so a host allowlist produced 59 tools from 5 vendors. Excluded despite answering 402 —
one MainNet-only service, one plain-http service, and one vendor whose every route
drifted 4-5x.

### The paid route

`POST /v1/orchestrate` — $0.05 USDC. Unpaid requests get a spec-compliant 402 whose
challenge is carried in the `payment-required` header, base64 JSON (x402 v2 puts it in
the header, not the body):

```
network  algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=
amount   "50000"            # $0.05 resolved to USDC base units
asset    "10458941"
extra    { tag: "x402-global-challenge", feePayer: "ZMFK2OI7...RA22AA" }
```

**CAIP-2 warning.** Use the full 44-char genesis hash from `packages/shared`, not
`ALGORAND_*_CAIP2` from `@x402/avm` — those are truncated to 32 chars per the CAIP-2
spec and do not match what the facilitator advertises. A test pins this.

### Live flow, and why it is trustworthy

Every payment attempt produces a **trace**: per-step state (`pending`, `active`, `ok`,
`failed`, `skipped`, `stalled`) with real timings, streamed to the browser over SSE at
`/api/stream`. The UI renders only what a trace reports, so it shows where a payment
actually is — including which step it stopped or stalled on. `stalled` fires when a step
exceeds its budget (settle: 8s, against ~3s Algorand finality) and can still resolve to
`ok`, because slow is not the same as broken. If the stream drops, the flow freezes and
says "stream down" rather than continuing to animate.

Verify and settle are reported as one step. From inside the resource server they are one
facilitator round trip, so splitting them would mean inventing a timing. Phase 3 splits
them, where we are the paying client and genuinely observe both.

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
