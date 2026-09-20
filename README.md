# Sentry402

**An agent discovers, verifies, and pays for any x402 service on Algorand — per call, under budget, without ever seeing a wallet.**

Entry type: **Orchestrator** — Algorand Global x402 Challenge.

```
┌─ your agent ──────────────┐
│  MCP client               │   install once, no wallet, no keys, no 402 handling
└────────────┬──────────────┘
             │ MCP tool call
┌────────────▼──────────────────────────────────────────────────────────┐
│ Sentry402                                                             │
│                                                                       │
│  resolve → trust gate → budget guard → pay → settle → confirm → serve │
│              │              │                                         │
│   record of what actually   caps + kill switch                        │
│   delivered when we paid    enforced before spend                     │
└────────────┬──────────────────────────────────────────────────────────┘
             │ x402 · USDC on Algorand · GoPlausible facilitator
┌────────────▼──────────────┐     ┌──────────────────────────────┐
│ curated x402 services     │     │ GET /v1/trust  ($0.02)       │
│ (other entrants' endpoints)│     │ the reliability record, sold │
└───────────────────────────┘     └──────────────────────────────┘
```

## What the payment unlocks

Two paid endpoints, both settling USDC on Algorand through the GoPlausible
facilitator, both carrying the `x402-global-challenge` tag.

| Route | Price | What the caller gets |
| --- | --- | --- |
| `POST /v1/orchestrate` | $0.05 | The bridge calls a verified x402 service on the agent's behalf and returns its response plus a settlement receipt. The agent never holds a key or handles a 402. |
| `GET /v1/trust?url=` | $0.02 | The reliability record for any x402 endpoint, built from calls this bridge actually routed and paid for: composite score, observation count, success rate, how often the endpoint took payment and returned nothing, median latency, cold starts. `unrated` when the evidence is too thin to score. |

## Who pays

| Payer | Pays for | Unit |
| --- | --- | --- |
| A developer's agent | An orchestrated call, routed and trust-checked | Per call |
| Any third-party agent | A reliability lookup before it spends | Per query |
| **This bridge** | The downstream service, on the agent's behalf | Per call |

That third row is the point of the entry type. Every routed call is a payment to
another entrant's endpoint — this project is a buyer in a marketplace that has many
sellers and few customers.

## What is claimed, and what is not

Relays and pre-spend checkers already exist on MainNet: AgentMesh pays endpoints on
your behalf, 402Signal checks routes before spending, Agent402 sells a seller
dossier. Claiming to have invented agent-side x402 or reputation would be
disprovable in one catalog search, so this does not claim it.

What is actually unclaimed, and what this leads with:

- **No catalog entry is an MCP server.** Install once and every curated service
  becomes a native agent tool.
- **Nothing advertises an enforced spend cap with a kill switch.** Caps are checked
  and reserved inside one transaction, so concurrent calls cannot race past them.
- **A record of what delivered, not a readiness check.** 402Signal answers "is this
  endpoint reachable now". This answers "did it deliver when we paid it", which is a
  different and harder question, and only answerable by an operator that pays.

## Evidence from operating on TestNet

Real settled payments, not fixtures. Reproduce with `npm run reconcile`.

| | |
| --- | --- |
| Bridged calls paid | 36 |
| USDC sent downstream | 0.440000 |
| USDC refunded by services | 0.275000 |
| **Net cost of 36 paid calls** | **0.165000** |
| Reconciliation | 42 on-chain transfers, 42 records, 42 matched, clean |
| Services with a real trust score | 5 of 6 |

```
folks_tvl            0.915  pass     n=11
tinyman_gross_fees   0.920  pass     n=10
pact_pool_count      0.921  pass     n=5
secret_scan          0.926  pass     n=5
pr_review            0.889  pass     n=5
proof_of_existence   unrated         n=4    (its only failures were our fault)
```

Three things operating taught us that testing could not:

- **The curated list decays.** One vendor held three curated entries in the morning
  and had migrated to MainNet at $0.70 by the afternoon. The payer refused to pay the
  wrong network rather than sending money. Re-ingesting is maintenance, not setup.
- **Advertised prices drift.** Two live services charged 5× and 8.5× their catalog
  price. Payment is pre-flighted and refused on a drift beyond 25%.
- **A refusal must not be permanent.** Refusing a service stops the observations that
  would clear it. The gate now has a half-open state, because without one, a service
  we wronged could never recover.
- **Money comes back.** One service takes $0.06, does the work and returns $0.055 of it.
  Reconciliation reported clean while six real transfers to our addresses had no record,
  because it only examined money we sent — so the books overstated spend by more than
  half. Refunds are now classified apart from funding, and net cost closes exactly
  against the on-chain balance.

## MainNet evidence

> Not yet applicable. No MainNet transaction has been made; the entry is still on
> TestNet. Cutover is a single change of `NETWORK`, and this section is filled from
> the facilitator's own record rather than from our claims.

| Claim | Value |
| --- | --- |
| Merchant address (permanent once set) | _pending cutover_ |
| `bazaar` | _pending_ |
| `challenge` | _pending_ |
| Settle count | _pending_ |
| Sample transaction ids | _pending_ |
| Bazaar listing | _pending_ |
| Leaderboard row | _pending_ |

A live version of this table, with each row checked against the source that would
disprove it, is served at `/api/verification` and rendered in the site's verification
panel. Rows with no machine-readable source report `manual` rather than claiming to
pass, and failing rows are shown failing — a panel that can show red is the only
reason to believe the green.

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

## MCP install

Build the repo, then point your MCP client at the built server. It runs over stdio and
exposes each curated service as a tool, plus read-only budget and service listings.

```json
{
  "mcpServers": {
    "sentry402": {
      "command": "node",
      "args": ["/absolute/path/to/Sentry402/packages/mcp/dist/index.js"],
      "env": { "NETWORK": "testnet" }
    }
  }
}
```

It points at a local build because the npm package is not published yet; a snippet a
developer copies and cannot run is worse than no snippet.

Two deliberate restrictions. The kill switch is **not** exposed as a tool — an agent
must not be able to disable the guard limiting its own spending, so halting stays with
the operator. And a tool refuses rather than guessing when it has no verified price on
record, because two live services already advertise prices 5× and 8.5× off their
catalog entry.

## Tests

```bash
npm test          # node suites, then the web render suite
npm run typecheck # packages, scripts and the web app
```

**433 tests across 19 files.** Every suite runs on every commit except the ones that
reach the live facilitator and indexer, which are marked below.

| Suite | Covers |
| --- | --- |
| `shared/env.test.ts` | The `NETWORK` switch, env rejection, secret containment |
| `shared/networks.test.ts` | **Live**: chain ids and fee payer still match the facilitator |
| `api/app.test.ts` | `/healthz` and `/livez` shape, CORS, no key leakage |
| `api/api.test.ts` | Contract of every read endpoint; stats arithmetic |
| `api/db.test.ts` | Persistence guarantees: idempotency, cursors, tri-state nulls, bounds |
| `api/x402.test.ts` | 402 conformance, ASA and base units, challenge tag, domain metadata |
| `api/trace.test.ts` | Stall detection, halt-point marking, both flow shapes |
| `api/catalog.test.ts` | Normalisation, probe verdicts, price drift, curation, template filling |
| `api/budget.test.ts` | Each cap at its boundary, UTC reset, kill switch, concurrency races |
| `api/payer.test.ts` | Reserve/settle/release, secret containment, parallel spend |
| `api/trust.test.ts` | Scoring determinism, cold starts, client errors, recovery, parole |
| `api/trustroute.test.ts` | The paid route, and that what we sell matches what we gate on |
| `api/inject.test.ts` | **Real HTTP**: eight deliberately broken downstream behaviours |
| `api/reconcile.test.ts` | Two-way reconciliation, schema migration, listener both directions |
| `api/verification.test.ts` | Each proof row against its source; failing rows stay failing |
| `web/App.test.tsx` | Render smoke: empty backend, dead backend, real data |

The suites worth knowing about:

- **Reconciliation** is the one that protects every number on the site. Every receipt
  must have an on-chain transaction and every on-chain transfer touching our addresses
  must have a receipt. An unreachable indexer reports *not clean*, never clean.
- **Failure injection** stands up eight broken endpoints and drives the real payer at
  them over real HTTP: settles-then-returns-nothing, wrong shape, never responds, 500
  before quoting, 8× price jump, quarter-price drop, vanished route, unparseable
  challenge. Its closing test is the whole point of the trust engine — a repeatedly
  broken endpoint accumulates its own record until the gate refuses it, with no
  fixture and no manual step.

### Operator scripts

```bash
npm run accounts:create -- --write   # generate two TestNet accounts into .env
npm run accounts:optin               # opt both into USDC (idempotent)
npm run accounts:check               # the Phase 0 gate; non-zero until both are ready
npm run catalog:ingest               # pull the Bazaar catalog, probe the curated set
npm run prober -- --calls 30 --interval 25   # paced real calls, builds trust history
npm run receipts:sync                # pull receipts from chain for both addresses
npm run reconcile                    # receipts against the chain; non-zero on any gap
npm run settle:inbound               # bootstrap settlement (refuses on localhost)
npm run trust:export                 # snapshot trust observations into seed/outcomes.json
npm run kill-switch -- on|off|status # halt or resume outbound payments (CLI, not an endpoint)
npm run check:endpoint -- <url>      # 12 checks on a live 402, before spending the bootstrap payment
```

`settle:inbound` refuses to run unless `PUBLIC_BASE_URL` is a public HTTPS domain. The
facilitator catalogs the resource URL from the 402 challenge, so settling from a local
server would publish a localhost address as the Bazaar listing, permanently bound to a
`payTo` the rules forbid rotating. A wrong listing is worse than no listing.

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

The public server runs on **Render's free tier** from `render.yaml` and the `Dockerfile`.
One service owns the whole root domain: the Foundation requires one root domain per `payTo`
address, so the API and the site must not be split, and routes differentiate by **path**,
never subdomain.

Free hosting has three constraints, and the design is built around each rather than
pretending they are not there.

| Constraint | Consequence | What was done |
| --- | --- | --- |
| Spins down after 15 minutes without traffic | The facilitator's probe could hit a cold service | An external pinger requests `/livez` every 5 minutes |
| The filesystem is ephemeral | The SQLite file is lost on every restart and redeploy | State is rebuilt on boot, below |
| 750 free hours per workspace per month | A second free service can exhaust the budget and suspend this one | Run only this one free service in the workspace |

**The hosted server holds no secret key.** It never pays anyone: it sells the paid routes
and serves the site. Outbound payments come from the MCP server and the prober running on the
operator's own machine, so `PAYER_MNEMONIC` is optional and is absent from `render.yaml`. The
addresses in that file are public on-chain. `PUBLIC_BASE_URL` is taken from the
`RENDER_EXTERNAL_URL` the host injects, so the domain does not have to be guessed before the
service exists.

### State on an ephemeral disk

Each kind of state is restored from the place that still has it.

| State | Restored from |
| --- | --- |
| Receipts, inbound and outbound | The chain. The settlement listener re-derives every transfer from the indexer, following its pagination |
| Service registry | The Bazaar catalog, by re-running the ingest and the probes |
| Trust outcomes | `seed/outcomes.json`, imported only when the table is empty |

Trust outcomes are the one thing that cannot be re-derived: they are observations of what a
service returned when we paid it, and no chain records that. So they are exported from the
operator's payer (`npm run trust:export`) and committed.

**What that means for the hosted trust record, stated plainly:** it is a *snapshot* of real
observations from real paid calls, refreshed by re-exporting and redeploying. The hosted
server has no payer key and generates no new observations of its own. The data is real, not a
fixture, but it is not live. A test proves a score is identical before and after a round trip
through the file, since a record that changes on restart is one nobody could trust.

### The advertised URL

The 402 challenge embeds the resource URL and the facilitator catalogs it permanently. Behind
a hosting proxy the request URL says `http://` even when every caller used `https://`, so the
advertised URL is pinned to `PUBLIC_BASE_URL` rather than derived from the request. It ignores
`Host` and `X-Forwarded-*`, so a spoofed header cannot change what gets listed.

## Links

| | |
| --- | --- |
| Repository | <https://github.com/Lakshmikanth-3/Sentry402> |
| Live site | _pending deploy_ |
| Paid orchestration route | _pending deploy_ — `POST /v1/orchestrate` |
| Paid trust route | _pending deploy_ — `GET /v1/trust?url=` |
| Bazaar listing | _pending first settlement_ |
| Merchant record | <https://facilitator.goplausible.xyz/discovery/merchants> |
| Bazaar catalog | <https://facilitator.goplausible.xyz/discovery/resources> |
| Facilitator guide and Doctor | <https://facilitator.goplausible.xyz/guide> |
| Leaderboard row | _pending first settlement_ |
| Electric Capital submission | _pending_ |

The pending rows are filled after cutover, from the facilitator's record rather than
from our own assertions. The live equivalent is `/api/verification`, which checks each
row against its source on request.

## Licence

MIT.
