# PRD — BrandForge

### Algorand Global x402 Challenge · Pay-per-kit service entry

2026-09-18 (original plan, as *Agentic x402 Bridge*) · updated 2026-09-23 (bridge as-built) · **pivoted 2026-09-30 to BrandForge** · @Lakshmikanth

> **2026-09-30 — Product pivot.** The project shipped as an agentic x402 *bridge + txrust layer* (see the archived sections from "As-Built Status" onward). That was infrastructure that *facilitated* other people's services — it had no end-user product of its own. This document now leads with **BrandForge**, an actual paid service built on the same x402 payment rails. The bridge/trust endpoints are retained as secondary infrastructure. The original bridge PRD is preserved below the divider for history.

---

## 0. BrandForge — the product (2026-09-30)

### 0.1 Summary

**BrandForge** is a pay-per-kit brand-identity generator. A user submits a short brief — a brand **name**, optionally an **industry** and a few **vibe** words — and receives a complete brand kit: a colour palette with named roles, a Google-Fonts pairing, brand-voice words, taglines, and paste-ready CSS variables. Each kit is paid for once, in **USDC over the x402 protocol on Algorand** — no account, no API key, no subscription.

**One-liner.** *


**Entry type.** Resource server / paid merchant endpoint. The product *is* the paid resource: the value the buyer receives is a self-contained deliverable, not a routed call to someone else.

**Why this is a real use case.** The deliverable is concrete and worth the price; the price ($0.03) is micro — exactly the scale traditional card/subscription billing cannot serve; it needs no account or key; and the *same* endpoint works for a human (browser wallet paywall) and for an AI agent (query params + the 402 flow).

### 0.2 Problem

Anyone starting a project, a store, a side-hustle, or a hackathon demo needs a basic visual identity — colours, fonts, a tagline — but the options are poor: hire a designer (expensive, slow), use a bloated SaaS tool (sign-up + monthly subscription for a one-off need), or hand-pick colours and fonts yourself (time, and it rarely looks cohesive). None of these fit a *small, one-off* need. x402 makes a fourth option viable: **pay a few cents, once, and get a coherent kit instantly** — because HTTP-native micropayments finally make a sub-cent-margin digital good sellable without the overhead of accounts and billing.

### 0.3 The paid endpoint

| Field | Value |
| --- | --- |
| Route | `GET /v1/brand-kit` |
| Price | **$0.03** (30 000 USDC base units, 6 decimals) |
| Asset | USDC — ASA `10458941` (TestNet) |
| Network | Algorand TestNet — CAIP-2 `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` |
| Scheme | x402 v2, `exact` |
| Merchant (payTo) | `7CIF7QT56P2S2XBG65INSFOYYK6DJHQ4LUPVJXVZB2VR4SSGO423AZTROA` |
| Challenge tag | `x402-global-challenge` |
| Facilitator | GoPlausible (`facilitator.goplausible.xyz`) — covers the Algorand fee |
| Discovery | declares a Bazaar discovery extension, so a first settled payment catalogs it |

**Input** (query params): `name` (required), `industry` (optional), `vibe` (optional, comma-separated, e.g. `modern,bold`). Query params are used deliberately so the whole brief fits in a URL the browser paywall can pay.

**Output** (JSON): `palette` (6 named roles — primary, secondary, accent, dark, light, muted), `swatches` (roles + hex + readable text colour), `fonts` (heading + body Google-Fonts pairing with a ready `<link>` URL), `voice`, `tagline` + `taglines`, and `cssVariables` (a paste-ready `:root { … }`).

### 0.4 How a kit is generated — deterministic, no AI, no keys

Generation is **pure and deterministic** (`packages/shared/src/brandkit.ts`): the same brief always produces the same kit, with no clock, no randomness source, no network call, and **no AI API key of any kind**. It works as follows:

- an **FNV-1a hash** of the normalised brief → a 32-bit seed;
- **vibe words** (with synonyms — "sleek"→modern, "premium"→luxury, "earthy"→warm, …) steer the hue family, saturation, colour scheme, and typography;
- the palette is built with **colour theory** (complementary / analogous / triadic) so the brand colours actually relate;
- a **curated set of Google-Fonts pairings** is scored against the vibe and chosen deterministically;
- taglines and voice are templated from the brief.

This determinism is load-bearing for two reasons: (1) it is the **single source of truth** — the module is imported by the API (Node) and by the web app (browser, via the `@brandkit` build alias), so the **free live preview and the paid result are byte-identical**; (2) it makes the output **reproducible** — a returning customer re-enters their brand and gets the same kit back. An optional AI copy/rationale layer could be added later behind an `ANTHROPIC_API_KEY`, falling back to the deterministic engine when absent; it is not required and is not shipped.

### 0.5 Payment flow

```
Human:  brief → "Generate & pay" → 402 → wallet paywall (Pera/Defly/Lute)
        → USDC settles via facilitator → kit JSON returned
Agent:  GET /v1/brand-kit?name=… → 402 + payment-required → sign & pay
        → retry with X-PAYMENT → kit JSON returned
```

The x402 middleware serves an interactive **wallet paywall** to a browser (Pera, Defly, Lute) and a machine-readable 402 to an agent — the same route, two callers.

### 0.6 The builder UI

`apps/web` was rebuilt as the BrandForge builder (the old bridge dashboard was removed as the primary UI):

- **Brief form** — name, industry, vibe chips.
- **Live preview** — regenerates as you type, using the same generator the paid endpoint runs (free; the "try before you buy").
- **Pay panel** — "Generate & pay via x402" (opens the wallet paywall) and "Show the 402 challenge" (fires the real request and shows the parsed price / network / asset / merchant).
- **Export** — copy CSS variables, download the kit as JSON.
- **Live proof strip** — real on-chain figures from `/api/stats`: payments settled, distinct paying wallets, USDC received, network.
- **Recent brand kit payments** — inbound settlements for `/v1/brand-kit` only, each linked to its Algorand transaction.

### 0.7 What was kept vs. changed

- **Kept (secondary infrastructure):** `/v1/orchestrate` and `/v1/trust` still exist and settle; the catalog/trust engine, budget guard, receipts, reconciliation, and settlement listener are unchanged.
- **Changed:** added `GET /v1/brand-kit`; added the deterministic generator in `packages/shared`; rebuilt the web app as the builder; rebranded public identity (`llms.txt`, `.well-known/agent-card.json`, paywall app name) to **BrandForge**; the agent card now advertises the `brand-kit` skill first.
- **Internal package names** remain `@sentry402/*` to avoid churn.

### 0.8 As-built status (2026-09-30)

- `GET /v1/brand-kit` returns a spec-compliant **402** with the correct price/asset/network/tag and a Bazaar discovery declaration — **verified live**.
- Deterministic generator: **verified** (same brief → identical kit; vibe words visibly change palette + typography).
- **No AI API keys** anywhere in the source — **verified by audit**.
- Tests: **node suite green (514 passed, 1 skipped)**, **web suite green (7 passed)**; TypeScript strict, zero type errors; web production build passes.
- Runs locally: API on `:4021`, Vite on `:5173` (proxying `/api` and `/v1`).
- **Remaining:** a live brand-kit purchase on TestNet to seed the first inbound `/v1/brand-kit` receipt; MainNet cutover (configuration switch) for a qualifying submission; record demo video.

---

> **Archived below — original bridge PRD (2026-09-18 → 2026-09-23).** Retained for history. The product described from here on ("Sentry402", the agentic bridge + trust layer) is the prior direction, now demoted to secondary infrastructure by the pivot above.

---

## As-Built Status — 2026-09-23

> This section was added on 2026-09-23 and records what actually shipped.
> The planning sections below are preserved for reference, with checkboxes and tech-stack notes corrected in place.

### Summary

All feature phases (0–6) are **complete on TestNet**. The codebase is clean (TypeScript strict, zero type errors). The e2e script passes **11/11** against the live Vercel deployment. The only remaining gate to a qualifying entry is **MainNet cutover**.

### Phase completion

| Phase | Status |
| --- | --- |
| Phase 0 — Foundation | ✅ Done |
| Phase 1 — Paid merchant endpoint | ✅ Done. `/v1/orchestrate` ($0.05) and `/v1/trust` ($0.02) both settling TestNet USDC |
| Phase 2 — Discovery and catalog | ✅ Done. Doctor reports `BAZAAR: true`, `HACKATHON: true` (TestNet) |
| Phase 3 — MCP server and downstream payment | ✅ Done. 8 tools exposed over stdio, real paid downstream call proven in e2e step 6 |
| Phase 4 — Trust engine | ✅ Done. Scores built from 55 real observations, 5 of 6 services scored |
| Phase 5 — Trust as a paid endpoint | ✅ Done. `/v1/trust` is itself listed in the Bazaar |
| Phase 6 — Budget guard and receipts | ✅ Done. Kill switch proven in e2e step 7; reconciliation clean |
| MainNet cutover | ❌ Not done — blocking submission |

### On-chain evidence (TestNet)

| Metric | Value |
| --- | --- |
| Bridged calls paid | 36 |
| USDC sent downstream | 0.440000 |
| USDC refunded by services | 0.275000 |
| **Net cost** | **0.165000** |
| Inbound settlements to merchant | 2 (0.07 USDC) |
| Reconciliation | 43 transfers, 43 records, 43 matched, clean |
| Services with a real trust score | 5 of 6 |

```
folks_tvl            0.915  pass     n=11
tinyman_gross_fees   0.920  pass     n=10
pact_pool_count      0.921  pass     n=5
secret_scan          0.926  pass     n=5
pr_review            0.889  pass     n=5
proof_of_existence   unrated         n=4
```

### End-to-end test result (2026-09-20, target: https://sentry402-ecru.vercel.app)

**11/11 steps passed.**

- PASS — 1. throwaway customer account funded and opted in
- PASS — 2. both paid routes answer 402 with a v2 challenge
- PASS — 3. $0.02 trust record purchased and settled on chain; USDC deducted exactly
- PASS — 4. replay of same payment proof refused (HTTP 402)
- PASS — 5. failure-injection routes live and misbehaving on purpose
- PASS — 6. MCP over stdio: 8 tools; real paid call succeeds
- PASS — 7. kill switch: halts spend; resumes cleanly
- PASS — 8. reconciliation: 68 matched, clean
- PASS — 9. Doctor: `BAZAAR: true`, `HACKATHON: true`
- PASS — 10. $0.05 orchestration: client pays, backend pays downstream, tx id returned
- PASS — 11. refused target does not charge the client

### What remains

1. **Push** the 3 local commits ahead of `origin/main`
2. **MainNet cutover** — flip `NETWORK=mainnet`, fund MainNet merchant + payer with real USDC, re-run e2e against MainNet URL
3. **Record demo video**
4. **Fill in submission form** (`docs/SUBMISSION-DRAFTS.md`) with MainNet merchant address and video link
5. **Submit** Algorand challenge form + Electric Capital PR

### Corrections to the original plan

| Plan said | As built |
| --- | --- |
| HTTP layer: Express | **Hono** + `@hono/node-server` |
| x402 middleware: `@x402-avm/express` | **`@x402/hono`**, `@x402/core`, `@x402/avm` |
| Storage: SQLite (dev) → Postgres (prod) | **SQLite only** (persisted in Vercel `/tmp`, rehydrated from seed on cold start) |
| Frontend styling: Tailwind | **Vanilla CSS** |
| Frontend animation: Framer Motion | **Inline SVG + CSS transitions** |
| Live data: polling (SSE if time allows) | **Both**: polling + SSE stream (`/api/stream`) |
| Packages: `@x402-avm/*` | **`@x402/*`** (2.26.x); `@x402-avm/extensions` still used for discovery helpers |

---

## 1. Executive summary

**Product.** A single MCP server that turns the Algorand x402 Bazaar into native tools for an AI agent. The developer installs it once; their agent can then discover any live x402 service, check whether that service actually delivers before paying it, and settle per call in USDC on Algorand — under a budget the developer set, with a full receipt trail, and without ever seeing a wallet. The reliability record the bridge builds from its own routed traffic is itself sold as a paid x402 endpoint, so any agent can check a service before paying it whether or not it uses the bridge.

**One-liner.** *An agent discovers, verifies, and pays for any x402 service on Algorand — per call, under budget, without ever seeing a wallet.*

**Entry type.** Orchestrator — a service that coordinates and pays other x402 endpoints as part of its workflow. This is the decisive structural choice: every downstream payment the bridge makes counts as volume for the bridge and for the merchant it paid, so the project accumulates leaderboard volume from operating, not only from selling.

**Three volume surfaces.**

| Surface | Direction | Counts as |
| --- | --- | --- |
| Downstream service calls | Bridge pays out | Bridge payer volume + merchant's volume |
| Orchestration fee on bridged calls | Bridge receives | Bridge merchant volume |
| Trust score queries | Bridge receives | Bridge merchant volume |

**Build principle.** Everything is built, integrated and proven on TestNet first. MainNet is a configuration switch taken only after the full suite passes end to end.

## 2. Problem statement

A developer's AI agent needs a live service — a price feed, a forecast, a compute job, a verification. Today that means signing up, storing an API key, and maintaining a subscription for something the agent might use twice. x402 fixes the billing model: the agent pays per call over HTTP, no account, no key. But three problems remain unsolved, and together they are why the services exist and nobody calls them.

**Discover.** An agent has no native way to know what x402 services exist. The Bazaar catalogs them, but consuming that catalog means a developer hand-writing an integration per service.

**Trust.** Even once found, an agent has no way to know whether a service will actually deliver. Paying a stranger's endpoint is a leap of faith with real money, and the payment is irreversible. The Algorand Foundation names this itself: before an agent sends money it needs to know whether the other side is reliable, whether the service will be delivered, and whether there is a record if something goes wrong. Reputation is listed as a future feature on the facilitator — it does not exist yet.

**Spend safely.** An agent spending autonomously cannot un-spend. Without limits and a receipt trail, most developers will not let an agent hold money at all.

**The ecosystem consequence.** The result is a supply-heavy, demand-empty marketplace. Roughly 150 entries are listed and most appear to sit near zero volume — one observed entry ranked 145 of 147 with a total volume of 0.001 USDC. Every other entrant is adding more supply. This project adds buyers.

**Why Algorand specifically.** Per-call payments worth fractions of a cent are only viable on a chain with sub-cent fees and sub-three-second finality. An agent making a decision in 200ms cannot wait on settlement, and cannot pay more in fees than the data costs. The GoPlausible facilitator currently covers the Algorand transaction fee entirely, so neither the bridge nor its users need to hold ALGO for gas.

## 3. Goals and success criteria

The competition has two gates that are scored by completely different things. The PRD is organised so that Gate 1 is cleared by the end of Phase 3, leaving everything after it as score improvement rather than survival.

### Gate 1 — mechanical filter (no human reads anything)

The facilitator reads the merchant record and ranks by settled USDC volume. Top 50 pass.

| Must be true | Owned by | Status |
| --- | --- | --- |
| Merchant record shows `bazaar: true` | Phase 2 | ✅ TestNet |
| Merchant record shows `challenge: true` | Phase 1 | ✅ TestNet |
| At least one real MainNet settlement | Cutover phase | ❌ Pending |
| Settled volume inside top 50 | Phases 3–6 + October traffic | ❌ Pending |

A project with a perfect build and false flags is invisible. This is why Phase 1 and Phase 2 come before any product feature.

### Gate 2 — human judging

Four evenly weighted criteria. How this project answers each:

| Criterion | This project's answer |
| --- | --- |
| Volume | Three surfaces; orchestrator downstream payments count twice |
| Use case quality | x402 is load-bearing in both directions — the product pays with it and charges with it |
| Sustained potential | Trust data compounds: the bridge is more useful in month three than on day one |
| Innovation | The consumer side of x402 does not exist; nor does reputation |

### Definition of done

- [x] Live on Algorand TestNet at a public HTTPS endpoint (https://sentry402-ecru.vercel.app)
- [x] GoPlausible facilitator wired, Bazaar discovery declared
- [x] `x402-global-challenge` tag present on TestNet routes
- [x] At least one real TestNet payment settled and USDC received
- [x] Visible in Bazaar and on the competition leaderboard (TestNet)
- [ ] **Live on MainNet** — pending cutover
- [ ] **At least one real MainNet payment settled**
- [ ] **Project submitted via the Algorand form**
- [ ] **Public GitHub repo submitted to Electric Capital**
- [x] Frontend live with verification links and pitch
- [x] Full test suite green on TestNet before any MainNet transaction

## 4. Users and payers

### Primary user

A developer using an MCP-capable agent — Claude Code, Claude Desktop, Cursor, or any MCP client. They install the bridge once via their MCP config. Their agent gains the ability to call paid services.

### Who pays what

| Payer | Pays | For | Unit |
| --- | --- | --- | --- |
| Developer's agent | Orchestration fee | A bridged call, routed and verified | Per call |
| Developer's agent | Downstream price | The underlying service | Per call, passed through |
| Any third-party agent | Trust query fee | Reliability record for an endpoint | Per query |
| The bridge itself | Downstream price | Calling services on the user's behalf | Per call |

### Proof-of-payer strategy

The metric that matters to judges is **distinct payer addresses**, not gross volume. Ten thousand payments from three addresses reads as manipulation; four hundred payments from ninety addresses reads as a product. The frontend surfaces distinct-payer count as a first-class number for exactly this reason.

## 5. System architecture

### Components

| Component | Responsibility |
| --- | --- |
| **Merchant API** | The paid x402 endpoints the bridge sells: orchestration and trust queries |
| **Catalog service** | Ingests and caches the Bazaar catalog; curates the active service list |
| **MCP server** | Exposes catalog services as agent tools over the MCP protocol |
| **Payer wallet service** | Holds the downstream payer account; signs x402 payments |
| **Trust engine** | Records every routed outcome, computes reliability scores, gates payments |
| **Budget guard** | Enforces per-call, per-day, per-merchant limits before any spend |
| **Receipt store** | Durable log of every settlement in and out, with tx ids |
| **Frontend** | Live dashboard, workflow animation, verification panel, pitch |

### Flow of a single bridged call

1. Agent invokes an MCP tool exposed by the bridge.
2. Bridge resolves the tool to a catalog service and its current price.
3. **Trust engine** returns the service's reliability score. Below threshold, the bridge routes to an alternative or refuses.
4. **Budget guard** checks the call against the agent's remaining limits.
5. Bridge calls the downstream endpoint; receives HTTP 402 with payment requirements.
6. Bridge constructs the payment, sends it in the `PAYMENT-SIGNATURE` header.
7. Downstream server forwards to the GoPlausible facilitator, which verifies and settles on Algorand.
8. Paid response returns. Bridge records the outcome in the trust engine and writes a receipt.
9. Result returns to the agent as an ordinary MCP tool result. No wallet UI at any point.

### Why this produces volume in both directions

Step 7 settles a payment where the bridge is the payer — that counts toward the bridge's leaderboard total and toward the downstream merchant's. Separately, the bridge's own orchestration and trust endpoints receive payments as a merchant. The same architecture therefore feeds the leaderboard from three sides, and lifts other entrants while doing it.

## 6. Tech stack

### Backend

| Layer | Choice | Note |
| --- | --- | --- |
| Runtime | Node 22 + TypeScript (strict, ESM) | |
| HTTP | **Hono** + `@hono/node-server` | *(plan said Express)* |
| x402 middleware | **`@x402/hono`**, `@x402/core`, `@x402/avm` | *(plan said `@x402-avm/express` — superseded namespace)* |
| Discovery | `@x402-avm/extensions` (`declareDiscoveryExtension`, `bazaarResourceServerExtension`) | Still current for discovery helpers |
| Chain reads | `algosdk` → algod + indexer | |
| MCP | Official MCP TypeScript SDK | Server over stdio |
| Facilitator | GoPlausible — `https://facilitator.goplausible.xyz` | |
| Storage | SQLite (persisted in Vercel `/tmp`; rehydrated from seed on cold start) | *(plan said Postgres for prod — not needed)* |

### Network constants

|  | TestNet | MainNet |
| --- | --- | --- |
| USDC ASA id | `10458941` | `31566704` |
| CAIP-2 | `ALGORAND_TESTNET_CAIP2` | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| Merchant address | Throwaway, rotate freely | **Fixed forever — never rotate** |

Prices may be written as `price: "$0.01"`; the middleware resolves the dollar string to the network's USDC ASA and base units automatically.

### Critical constraints

- **Discovery is separate from settlement.** Payments can settle perfectly and the endpoint still never appears in the Bazaar. `declareDiscoveryExtension` must be called. This is the single most common reported failure.
- **Never rotate the MainNet payTo address.** Discovery, dashboards, receipts and rankings all key on the receiving address; rotating fragments history across accounts.
- **The facilitator probes your domain** for `llms.txt` and agent well-knowns including an MCP manifest. The landing page is an input to the directory listing, refreshed at most once a day.
- **GoPlausible Doctor** validates a live endpoint from the facilitator's side, free, 20 checks/day, and explains exactly why a BAZAAR or HACKATHON badge is missing.
- **Minimum balance:** 0.1 ALGO base + 0.1 ALGO USDC opt-in stays locked per account. The facilitator currently pays transaction fees.

### Frontend

| Layer | Choice |
| --- | --- |
| Framework | React + Vite + TypeScript |
| Styling | Vanilla CSS |
| Animation | Inline SVG + CSS transitions |
| Live data | Both polling `/api/*` and SSE stream (`/api/stream`) |
| Hosting | Vercel (static + serverless function on same domain) |

## Phase 0 — Foundation ✅ Done

**Goal.** A repo, two funded TestNet accounts, and a deployed empty frontend, so that every later phase has somewhere to land.

### Exit criteria

- [x] Public repo live, CI green
- [x] Both TestNet accounts funded and USDC-opted-in
- [x] Frontend deployed at the real domain over HTTPS
- [x] `/healthz` reachable from the public internet

## Phase 1 — Paid merchant endpoint on TestNet ✅ Done

**Goal.** The bridge can be paid. One x402 route, live, settling real TestNet USDC through the GoPlausible facilitator.

### What was built

- Hono + `@x402/hono` paywall on `/v1/orchestrate` ($0.05) and `/v1/trust` ($0.02)
- `x402-global-challenge` tag on both routes
- Settlement listener confirms USDC via Indexer; writes receipts
- Replay refusal working (proven in e2e step 4)

### Exit criteria

- [x] Real TestNet USDC settled into the merchant address through the facilitator
- [x] Receipt visible in the frontend stream within seconds
- [x] All Phase 1 tests green
- [x] Doctor probe passes on the TestNet endpoint

## Phase 2 — Discovery and catalog ✅ Done

**Goal.** The bridge is discoverable, and it can see what else is out there.

### What was built

- `declareDiscoveryExtension` called; `bazaarResourceServerExtension` registered
- `llms.txt`, MCP manifest, and x402 well-known published
- Catalog ingester pulls and normalises the Bazaar listing into a local service registry
- Curation allowlist: 6 services manually verified
- Staleness handling: services marked inactive when missing from catalog

### Exit criteria

- [x] Doctor reports both BAZAAR and HACKATHON badges satisfied
- [x] Our endpoint visible in the Bazaar catalog
- [x] 6 curated downstream services in the registry, each manually verified
- [x] Badge panel live in the frontend

## Phase 3 — MCP server and downstream payment ✅ Done

**Goal.** The product exists. An agent can call a paid service through the bridge and never see a wallet.

### What was built

- MCP server (`packages/mcp`) exposing 8 tools over stdio
- `@x402/axios` client handles the 402 handshake, signs from the payer key, sends `PAYMENT-SIGNATURE` header
- Price anomaly refusal: rejects when live price is >25% above catalog
- Outcome recording from the first call: success, latency, schema match, settlement confirmation
- Inbound and outbound receipts in the DB
- Orchestrate route syncs before spending; trust route does not

### Exit criteria

- [x] An agent in a real MCP client completes a paid call end to end on TestNet
- [x] Both inbound and outbound receipts visible in the frontend
- [x] Outcome records accumulating for every call
- [x] Install snippet live

## Phase 4 — Trust engine ✅ Done

**Goal.** The bridge knows which endpoints actually deliver, and refuses to pay the ones that don't.

### What was built

- Composite score `[0,1]`: success rate, schema conformance, latency, settlement integrity, recency weighting
- Cold-start: `unrated` when fewer than 5 observations — not a refusal, a warning
- Score gate before every downstream payment
- Route-around: if a service is below threshold and an alternative exists, prefer it
- Parole / half-open state: a refused service can recover once it starts passing again
- Price-anomaly refusal integrated into payer layer (>25% threshold)

### Real trust data (55 observations)

```
folks_tvl            0.915  pass     n=11
tinyman_gross_fees   0.920  pass     n=10
pact_pool_count      0.921  pass     n=5
secret_scan          0.926  pass     n=5
pr_review            0.889  pass     n=5
proof_of_existence   unrated         n=4
```

### Exit criteria

- [x] Scores computed from real TestNet traffic, not seeded fixtures
- [x] A deliberately broken test endpoint is correctly refused (e2e step 11)
- [x] Route-around built and tested
- [x] Score badges live in the frontend

## Phase 5 — Trust as a paid endpoint ✅ Done

**Goal.** The reliability record becomes a product any agent can buy.

### What was built

- `GET /v1/trust?url=` ($0.02) returns: `score`, `verdict`, `observations`, `successRate`, `paidNothingCount`, `medianLatencyMs`, `schemaConformance`, `coldStartCount`, `clientErrorCount`, `lastSeenAt`, `basis`, `cached`
- Listed in the Bazaar as its own service
- Cache with TTL; honesty constraint: observation count always shown
- Public trust lookup in the dashboard

### Exit criteria

- [x] Trust endpoint settling real TestNet payments (e2e step 3)
- [x] Listed in the Bazaar as its own service
- [x] Public lookup live in the frontend

## Phase 6 — Budget guard and receipts ✅ Done

**Goal.** A developer can let an agent spend without fear.

### What was built

- Per-call ($0.02), per-day ($1.00), per-merchant caps; reserve/settle/release in one DB transaction (no concurrency races)
- Kill switch: halts all outbound payments immediately; proven in e2e step 7
- Reconciliation (`npm run reconcile`): chain vs records both directions; refunds classified separately from funding; net cost closes exactly against on-chain balance
- Receipt store: every settlement in and out, with tx ids
- Verification panel: live claims checked against the facilitator

### Exit criteria

- [x] All limit types enforced and tested
- [x] Receipt export reconciles against the Indexer (43 transfers, 43 records, clean)
- [x] Kill switch verified (e2e step 7)
- [x] Budget panel and refusal log live in the frontend

---

## 15. Frontend architecture and design direction

### Visual direction

Dark base, monospace numerals, one accent for settlement events only. Dense — whitespace is not the goal. Animation only on state change, never ambient.

| Element | Direction |
| --- | --- |
| Palette | Dark base, muted greys, one accent for settlement events only |
| Type | Monospace for all numbers, addresses, tx ids; clean sans for prose |
| Density | High. Legibility at density, not whitespace |
| Motion | Only on state change; `prefers-reduced-motion` respected |

### Page structure (as built)

1. Hero — one-liner, protocol walkthrough animation, constellation
2. Live flow visualiser — nine-step bridged call lighting in real time
3. Receipt streams — inbound and outbound via SSE
4. Verification panel — live pass/fail checked against the facilitator

## 16. Workflow animation spec

### A. The 402 handshake loop — implemented

Inline SVG, state-driven. Three beats: request → 402 wall → pay and pass.

### B. The route-around beat — built and tested

Route-around is built and tested at the code level. No curated service currently declares an equivalent alternative, so the live animation does not yet fire in normal traffic — the substitution is available if a suitable pair of services is added to the catalog.

### C. Settlement timer — implemented

Live millisecond counter during real settlements.

### D. Receipt stream — implemented

Terminal aesthetic, monospace, SSE-driven rows as settlements land.

### E. Payer constellation — implemented

Distinct payer addresses over time as a growing point field, fed from real TestNet receipts.

## 17. Verification panel

Live pass/fail for every qualifying claim, checked against the facilitator. Currently shows TestNet state. Rows with no machine-readable source report `manual`. A failing row shows as failing — a panel that can show red is the only reason to believe the green.

**Pending MainNet cutover:** the MainNet merchant address, settle count, and sample tx id rows will populate after step 6 of the cutover procedure.

## 18. The pitch, rendered in the UI

Three blocks, above the fold, short enough to read standing up.

### Block 1 — the problem

> An agent that needs a live service today has to sign up, store a key, and manage a subscription for something it may use twice. x402 fixed the billing. It did not fix discovery, and it did not fix trust. Paying a stranger's endpoint is a leap of faith with money you cannot get back. So the services exist, and nobody calls them.

### Block 2 — what this is

> One MCP server. Your agent discovers every live x402 service on Algorand, checks whether each one actually delivers before paying it, and settles per call in USDC under a budget you set. Install once. Your agent never sees a wallet.

### Block 3 — why Algorand, and why this matters here

> Payments worth fractions of a cent need sub-cent fees and sub-three-second finality. An agent deciding in 200ms cannot wait on settlement or pay more in fees than the data costs.
>
> **Every call routed through this bridge is volume for another entrant's endpoint. This project does not only compete on the leaderboard — it feeds it.**

## 19. Test strategy

**Rule: every transaction used in testing is a TestNet transaction.** MainNet is touched exactly once, at cutover, after everything below is green.

### Layers

| Layer | Scope | Runs |
| --- | --- | --- |
| Unit | Pure logic: scoring, budget arithmetic, catalog parsing | Every commit |
| Contract | Facilitator shapes against fixtures | Every commit |
| Integration | Service-to-service inside our system, real DB | Every commit |
| Protocol conformance | x402 challenge and payment shapes against the spec | Every commit |
| End-to-end TestNet | Real settlements, real Indexer confirmation | Pre-phase-exit |
| Failure injection | Deliberately broken downstream services | Pre-phase-exit |

### Protocol conformance suite ✅ Passing

- Unpaid request returns 402 with correct challenge shape
- Challenge advertises correct ASA id and base units for the stated price
- CORS headers correct
- Valid payment yields the response exactly once; replay rejected
- Underpayment, wrong asset, wrong network, expired payment each rejected distinctly

### Failure injection suite ✅ Passing

| Broken behaviour | Bridge response |
| --- | --- |
| Takes payment, returns nothing | Recorded as failure, score drops, agent gets honest error |
| Returns wrong schema | Schema mismatch recorded, score drops |
| Returns 500 before 402 | No payment sent |
| Price changed since catalog ingest | Anomaly refusal (>25% threshold) |
| Disappears mid-session | Marked inactive, routed around |

### Reconciliation suite ✅ Passing

43 chain transfers, 43 records, 43 matched. Refunds classified apart from funding; net cost closes exactly against the on-chain balance.

## 20. TestNet → MainNet cutover

This is a one-way gate. It happens once, deliberately, after everything below passes.

### Pre-cutover gate

- [x] Phases 0–6 exit criteria all ticked
- [x] Full test suite green, including failure injection and reconciliation
- [x] At least 48 hours of continuous TestNet operation with no unexplained failure
- [x] Reconciliation clean over that whole window
- [x] Kill switch tested under load
- [ ] MainNet merchant account created, opted into USDC `31566704`, and **this address recorded as permanent**
- [ ] MainNet payer account funded
- [ ] Rollback plan written

### Cutover procedure

1. Flip `NETWORK` to `mainnet`
2. Set `MERCHANT_ADDRESS` to the MainNet merchant account (permanent — never rotate)
3. Confirm the challenge tag is present on MainNet routes
4. Re-run `declareDiscoveryExtension` against MainNet
5. Run Doctor against the MainNet url; confirm BAZAAR and HACKATHON badges
6. Execute **one** real MainNet payment. Confirm USDC received at the merchant address
7. Confirm the merchant record shows `bazaar: true`, `challenge: true`, settles ≥ 1
8. Confirm the row appears in the Bazaar and on the leaderboard
9. Populate the verification panel with the now-real URLs
10. Begin controlled downstream operation within budget limits

### Hard rules after cutover

- **The MainNet payTo address is never rotated.**
- TestNet remains the environment for every subsequent change.
- The measurement window in October is unannounced — uptime from cutover onward matters continuously.

## 21. Submission checklist

### A. Algorand challenge submission

| Requirement | Status |
| --- | --- |
| Live on MainNet, public HTTPS endpoint | ❌ Pending cutover |
| GoPlausible facilitator with Bazaar discovery | ✅ TestNet / ❌ MainNet pending |
| `x402-global-challenge` tag | ✅ TestNet / ❌ MainNet pending |
| At least one real MainNet payment | ❌ Pending cutover |
| Appears in Bazaar and on leaderboard | ✅ TestNet / ❌ MainNet pending |
| Project details: what the payment unlocks, proof of who is paying | ✅ README + dashboard |
| Demo video | ❌ Not recorded |

Submission draft ready at `docs/SUBMISSION-DRAFTS.md`. Do not submit until MainNet cutover is done.

### B. Electric Capital repository submission

- [x] Repository public from the start
- [x] Contains the actual Algorand and x402 code — not a stub
- [x] Real incremental commit history
- [x] README carries the written pitch, merchant record state, settle counts
- [ ] Submitted via the Electric Capital process

### README structure ✅ Done

1. One-liner and entry type
2. Problem and solution
3. TestNet evidence (MainNet section present but pending)
4. Architecture diagrams (mermaid in `docs/PROJECT.md`)
5. Local setup and TestNet run instructions
6. MCP install snippet
7. Test suite instructions
8. Links: live site, Bazaar listing, Doctor result

## 22. Risks and mitigations

| Risk | Severity | Mitigation | Status |
| --- | --- | --- | --- |
| **Downstream services are dead** | High | Curate hard: 6 verified services | ✅ Done — 1 vendor migrated to MainNet at $0.70 mid-project; payer refused the wrong network |
| **No real payers materialise in October** | High | Outreach must start now, not in October | ⚠️ Pending |
| **Discovery never activates** | High | Doctor is the Phase 2 exit gate | ✅ Cleared (TestNet) |
| **Volume looks self-generated** | High | Distinct payers is the headline metric | ⚠️ Current settlements are test traffic; MainNet independent payers needed |
| **Scope creep on the trust layer** | Medium | Thin: success rate + recency only | ✅ Held |
| **MainNet mistake burns real money** | Medium | Cutover gate + budget guard | ✅ Budget guard proven |
| **Facilitator behaviour changes** | Medium | Contract tests fail loudly | ✅ Covered |
| **Downtime during unannounced window** | Medium | Uptime monitoring from cutover | ⚠️ Starts at cutover |
| **Advertised prices drift** | Observed | >25% anomaly refusal in payer layer | ✅ Resolved — two services charged 5× and 8.5× catalog price |
| **Refusal must not be permanent** | Observed | Half-open / parole state in trust engine | ✅ Resolved |
| **Refunds overcounted as spend** | Observed | Refunds classified apart from funding in reconcile | ✅ Resolved |

### The honest summary

The build is done. The field looks shallow — one observed entry sat at rank 145 of 147 with 0.001 USDC of volume — so qualifying for the top 50 is realistic. What separates a top-50 finish from a finalist spot is whether real, distinct people pay for this in October. Every hour spent on features after cutover is worth less than an hour spent getting one more genuine payer.

## 23. Timeline

### Fixed external dates

| Date | Event |
| --- | --- |
| **Sept 29, 2026** | Final Presentation registration closes — project details due |
| **Sept 30 – Oct 8** | Shortlist window |
| **Early October** | Leaderboard volume measured over an **unannounced** window |
| **Oct 9** | Finalists notified |
| **Nov 2** | Final Presentation, Devcon 8 India |
| **By Nov 12** | Winners announced |

### Actual build timeline (completed)

| Dates | Work | Status |
| --- | --- | --- |
| Sept 18–19 | Phase 0 — foundation, accounts, deploy pipeline | ✅ |
| Sept 19–21 | Phase 1 — paid endpoint settling on TestNet | ✅ |
| Sept 21–22 | Phase 2 — discovery, catalog, Doctor green | ✅ |
| Sept 22–23 | Phase 3 — MCP server and downstream payment | ✅ |
| Sept 23 | Phase 4 — trust engine | ✅ |
| Sept 23 | Phase 5 — trust as paid endpoint | ✅ |
| Sept 23 | Phase 6 — budget guard, reconciliation, verification panel, dashboard | ✅ |
| **Sept 24** | **Cutover gate → MainNet** | ❌ Next step |
| Sept 24–29 | README, Electric Capital, Algorand submission | ⏳ |
| Oct 1 onward | **Real payers. The part that actually decides it.** | ⏳ |

### Critical path — right now

The project is **3 commits ahead of `origin/main`** (not yet pushed). Then the only work standing between this and a qualifying entry is:

1. Push local commits to GitHub
2. Create and fund the MainNet merchant + payer accounts
3. Flip `NETWORK=mainnet` and redeploy
4. Run Doctor → confirm badges
5. Execute one real MainNet payment → confirm receipt
6. Record demo video
7. Submit
