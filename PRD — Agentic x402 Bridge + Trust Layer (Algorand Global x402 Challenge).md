# PRD — Agentic x402 Bridge + Trust Layer

### Algorand Global x402 Challenge · Orchestrator entry

2026-09-18 · @Someone

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

| Must be true | Owned by |
| --- | --- |
| Merchant record shows `bazaar: true` | Phase 2 |
| Merchant record shows `challenge: true` | Phase 1 |
| At least one real MainNet settlement | Cutover phase |
| Settled volume inside top 50 | Phases 3–6 + October traffic |

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

- [ ] Live on Algorand MainNet at a public HTTPS endpoint
- [ ] GoPlausible facilitator wired, Bazaar discovery declared
- [ ] `x402-global-challenge` tag present on MainNet routes
- [ ] At least one real MainNet payment settled and USDC received
- [ ] Visible in Bazaar and on the competition leaderboard
- [ ] Project submitted via the Algorand form
- [ ] Public GitHub repo submitted to Electric Capital
- [ ] Frontend live with verification links and pitch
- [ ] Full test suite green on TestNet before any MainNet transaction

## 4. Users and payers

Judges asked explicitly for proof of who is paying. This section must be answerable with real distinct addresses by early October, not retrofitted.

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

> **Data needed from you:** which developer communities you can realistically reach in October (Algorand Discord, an MCP community, a college/club network, your own network). This determines whether the payer story is credible. See Section 7.

## 5. System architecture

### Components

| Component | Responsibility |
| --- | --- |
| **Merchant API** | The paid x402 endpoints the bridge sells: orchestration and trust queries |
| **Catalog service** | Ingests and caches the Bazaar catalog; curates the active service list |
| **MCP server** | Exposes catalog services as agent tools over the MCP protocol |
| **Payer wallet service** | Holds the downstream payer account; signs x402 payments |
| **Trust engine** | Records every routed outcome, computes reliability scores, gates payments |
| **Budget guard** | Enforces per-agent, per-day, per-merchant limits before any spend |
| **Receipt store** | Durable log of every settlement in and out, with tx ids |
| **Frontend** | Live dashboard, workflow animation, verification panel, pitch |

### Flow of a single bridged call

1. Agent invokes an MCP tool exposed by the bridge.
2. Bridge resolves the tool to a catalog service and its current price.
3. **Trust engine** returns the service's reliability score. Below threshold, the bridge routes to an alternative or refuses.
4. **Budget guard** checks the call against the agent's remaining limits.
5. Bridge calls the downstream endpoint; receives HTTP 402 with payment requirements.
6. Bridge constructs the payment, sends it in the `X-PAYMENT` header.
7. Downstream server forwards to the GoPlausible facilitator, which verifies and settles on Algorand.
8. Paid response returns. Bridge records the outcome in the trust engine and writes a receipt.
9. Result returns to the agent as an ordinary MCP tool result. No wallet UI at any point.

### Why this produces volume in both directions

Step 7 settles a payment where the bridge is the payer — that counts toward the bridge's leaderboard total and toward the downstream merchant's. Separately, the bridge's own orchestration and trust endpoints receive payments as a merchant. The same architecture therefore feeds the leaderboard from three sides, and lifts other entrants while doing it.

## 6. Tech stack

### Backend

| Layer | Choice | Note |
| --- | --- | --- |
| Runtime | Node.js + TypeScript | The x402 AVM packages are TS-first |
| HTTP | Express | `paymentMiddlewareFromConfig(routes, facilitatorClient)` |
| x402 middleware | `@x402-avm/express` | Wraps routes as paid |
| x402 core | `@x402-avm/core/server` | `HTTPFacilitatorClient` |
| Chain binding | `@x402-avm/avm` | CAIP-2 network ids |
| MCP | Official MCP TypeScript SDK | Server exposing tools over stdio and HTTP |
| Chain reads | Algorand Indexer + Algod | Settlement confirmation |
| Storage | SQLite (dev) → Postgres (prod) | Trust records, receipts, budgets |

### Network constants

|  | TestNet | MainNet |
| --- | --- | --- |
| USDC ASA id | `10458941` | `31566704` |
| CAIP-2 | `ALGORAND_TESTNET_CAIP2` | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| Merchant address | Throwaway, rotate freely | **Fixed forever — never rotate** |

Prices may be written as `price: "$0.01"`; the middleware resolves the dollar string to the network's USDC ASA and base units automatically. The spec-exact alternative is pinning `asset` and `amount` directly.

### Critical constraints

- **Discovery is separate from settlement.** Payments can settle perfectly and the endpoint still never appears in the Bazaar. `declareDiscoveryExtension` must be called. This is the single most common reported failure.
- **Never rotate the MainNet payTo address.** Discovery, dashboards, receipts and rankings all key on the receiving address; rotating fragments history across accounts.
- **The facilitator probes your domain** for `llms.txt` and agent well-knowns including an MCP manifest. The landing page is an input to the directory listing, refreshed at most once a day.
- **GoPlausible Doctor** validates a live endpoint from the facilitator's side, free, 20 checks/day, and explains exactly why a BAZAAR or HACKATHON badge is missing. Use it as the gate on Phases 1 and 2.
- **Minimum balance:** 0.1 ALGO base + 0.1 ALGO USDC opt-in stays locked per account. The facilitator currently pays transaction fees.

### Frontend

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | React + Vite + TypeScript | Fast, standard, easy to host |
| Styling | Tailwind | Speed; tokens for light/dark |
| Animation | Framer Motion + inline SVG | State-driven, not decorative |
| Charts | Lightweight custom SVG | Avoids heavy chart deps for a few sparklines |
| Live data | Polling `/api/*` (SSE if time allows) | Receipt stream and counters |
| Hosting | Static host + API on same domain | Facilitator must reach the domain over HTTPS |

## 7. Data needed from you — blocking

Nothing below is invented. Each item blocks a specific phase and must come from you or from a live lookup we do together. **Do not let me guess these.**

### Blocks Phase 0

1. **Project name.** Used in the repo, the domain, the Bazaar listing, and the pitch. Not yet chosen.
2. **Domain.** Do you have one, or should the plan assume a subdomain of a host's default domain? The facilitator probes this domain, so it must be real and HTTPS.
3. **Hosting.** Where will the API run — a VPS, Railway/Render/Fly, or something you already pay for? Determines the deploy steps.
4. **Existing registration details.** You said you already registered. Which email and which project name did you register under? The submission must match.

### Blocks Phase 1

5. **MainNet merchant address.** Must be created, opted into USDC, and then never changed. Do you already have an Algorand account you intend to use, or do we create a fresh one?
6. **Price points.** What do you want to charge for an orchestration call and for a trust query? My suggestion is $0.005–$0.01 orchestration and $0.002–$0.005 per trust query, but this is your revenue and your call.

### Blocks Phase 2

7. **Live Bazaar catalog.** We need the actual current list of challenge-tagged services with their prices and schemas. I have not fetched this. We should pull it together from the facilitator's discovery endpoint before writing the catalog ingester, because the curated list depends on what is genuinely alive.

### Blocks Phase 3

8. **Downstream payer wallet funding.** How much real USDC are you willing to hold in the payer account for MainNet operation? This caps downstream volume and must be a number you are comfortable with.
9. **Which MCP client** you will demo in — Claude Code, Claude Desktop, Cursor? Affects the config format shown in docs.

### Blocks Phase 4

10. **Trust threshold policy.** At what score should the bridge refuse to pay an endpoint? Suggested start: refuse below 0.6, warn 0.6–0.8. Your call.

### Blocks the payer story

11. **Which developer communities can you actually reach** in October? Be honest about reach — the entire proof-of-payer argument depends on it.

### Blocks the frontend

12. **Any brand preference** — colour, name treatment, or none. Absent a preference I will specify a dark instrumentation aesthetic (Section 15).
13. **Do you want to use an external frontend builder** (a design tool, a component library, a template) or build it plain in React? You mentioned openness to plugins or external sources; tell me which and I will spec against it.

## Phase 0 — Foundation

**Goal.** A repo, two funded TestNet accounts, and a deployed empty frontend, so that every later phase has somewhere to land.

**Blocked by:** items 1–4 in Section 7.

### Backend work

- Monorepo scaffold: `packages/api`, `packages/mcp`, `packages/shared`, `apps/web`
- TypeScript strict, ESLint, Prettier, Vitest configured
- `.env` schema with explicit `NETWORK` switch (`testnet` | `mainnet`) — a single variable that everything derives from, so cutover is one change
- Two TestNet accounts created: **merchant** (receives) and **payer** (spends), both opted into USDC `10458941`
- Funded from the TestNet dispenser and the Circle USDC faucet
- Health endpoint `/healthz` returning network, addresses, and build sha
- GitHub repo public from commit one, with real incremental commit history

### Frontend integration for this phase

A deployed page — ugly is fine — showing: network badge (TESTNET), merchant address, payer address, both balances, build sha, and a green/red dot per backend service. This proves the deploy pipeline works before anything depends on it.

### Tests

- Env schema validation rejects a missing or invalid `NETWORK`
- Account opt-in status asserted for both accounts
- `/healthz` contract test

### Exit criteria

- [ ] Public repo live, CI green
- [ ] Both TestNet accounts funded and USDC-opted-in
- [ ] Frontend deployed at the real domain over HTTPS
- [ ] `/healthz` reachable from the public internet

**Do not start Phase 1 until every box above is ticked.**

## Phase 1 — Paid merchant endpoint on TestNet

**Goal.** The bridge can be paid. One x402 route, live, settling real TestNet USDC through the GoPlausible facilitator.

**Blocked by:** items 5–6 in Section 7.

### Backend work

- Wire `HTTPFacilitatorClient` to the GoPlausible facilitator URL
- Define the first paid route via `paymentMiddlewareFromConfig` — the orchestration endpoint, initially returning a stub payload
- Price expressed as a dollar string; verify the 402 challenge advertises the correct ASA id and base units
- Add the `x402-global-challenge` tag field to the route config (labeling only — it never affects the payment)
- Settlement listener: confirm via Indexer that USDC actually landed in the merchant address
- Persist every inbound settlement as a receipt: tx id, payer address, amount, timestamp, route

### Frontend integration for this phase

- **Live receipt stream** — settlements appear as they land, monospace, with payer address, amount, latency, tx id linked to an explorer
- **Counters** — total settles, total USDC, distinct payers
- A **"Pay me" demo button** that walks a visitor through paying the endpoint on TestNet, so a judge can generate a settlement themselves and watch it appear

### Tests

- Unprotected request returns a spec-compliant HTTP 402 with correct challenge shape
- Challenge advertises correct ASA id and base-unit amount for the price
- Valid payment header yields the paid response exactly once
- Replayed payment header is rejected
- Malformed, underpaid, wrong-asset and wrong-network payments each rejected with the right error
- Receipt written exactly once per settlement; idempotent under duplicate webhook/poll
- Facilitator unreachable → graceful failure, no silent success

### Exit criteria

- [ ] Real TestNet USDC settled into the merchant address through the facilitator
- [ ] Receipt visible in the frontend stream within seconds
- [ ] All Phase 1 tests green
- [ ] Doctor probe passes on the TestNet endpoint

**Do not start Phase 2 until every box above is ticked.**

## Phase 2 — Discovery and catalog

**Goal.** The bridge is discoverable, and it can see what else is out there. This is the phase that makes `bazaar: true` true — the single most common failure point in the whole competition.

**Blocked by:** item 7 in Section 7 (we must fetch the live catalog together).

### Backend work

- Call `declareDiscoveryExtension` so the endpoint is catalogued. **Discovery is separate from settlement** — payments settling is not sufficient
- Publish domain metadata the facilitator probes: `llms.txt`, an MCP manifest, and an x402 well-known descriptor. Keep pricing and endpoints accurate; the enrichment engine refreshes at most once a day, so treat this as part of the API contract
- Catalog ingester: pull the Bazaar discovery listing on a schedule, normalise into a local service registry (url, network, asset, price, schema, payTo, tags)
- **Curation layer:** a manually reviewed allowlist of services verified to actually return value. Ship with 4–6, not 150
- Staleness handling: services that disappear from the catalog are marked inactive, not deleted

### Frontend integration for this phase

- **Catalog browser** — the curated services as cards: what it does, price, schema, last seen
- **Badge panel** — live `bazaar` and `challenge` booleans for our own merchant record, read from the facilitator, shown as pass/fail. This is a judge-facing proof that we qualify
- Link out to our own Bazaar listing and to the Doctor result

### Tests

- Discovery declaration asserted present in the facilitator's view of our endpoint
- Catalog ingester parses a live response and a fixture without loss
- Unknown or malformed catalog entries are skipped, not crashed on
- Inactive detection fires when a service vanishes
- Allowlist gating: a non-allowlisted service never becomes a tool

### Exit criteria

- [ ] Doctor reports both BAZAAR and HACKATHON badges satisfied
- [ ] Our endpoint visible in the Bazaar catalog
- [ ] 4–6 curated downstream services in the registry, each manually verified to work
- [ ] Badge panel live in the frontend

**Do not start Phase 3 until every box above is ticked.**

## Phase 3 — MCP server and downstream payment

**Goal.** The product exists. An agent can call a paid service through the bridge and never see a wallet. **This is the phase that clears Gate 1.**

**Blocked by:** items 8–9 in Section 7.

### Backend work

- MCP server exposing each curated catalog service as a tool, with input schema derived from the catalog entry
- Tool descriptions written for an agent to read — what it does, what it costs, what it returns
- Downstream x402 client: handle the 402 challenge, construct and sign the payment from the payer account, send in `X-PAYMENT`, parse the paid response
- Payer key handling: keys live in the process's own secure store and are never exposed to downstream services or to the agent
- Outcome recording for every downstream call: success, latency, schema match, settle confirmation, failure reason. This is the raw data Phase 4 consumes — **it must be recorded from the very first call**
- Receipts for outbound payments alongside inbound ones

### Frontend integration for this phase

- **Flow visualiser** — a live trace of the nine-step bridged call from Section 5, each step lighting as it happens
- **Outbound receipt stream** alongside the inbound one, so both volume directions are visible
- **Install snippet** — the MCP config block a developer copies to install the bridge. This is the conversion surface for real payers; it belongs above the fold

### Tests

- End-to-end: MCP tool call → 402 → payment → paid response → MCP result, against a real TestNet downstream service
- Downstream returns non-402 error → surfaced cleanly, no payment sent
- Downstream takes payment but returns garbage → recorded as failure, agent gets an honest error
- Payment fails mid-flight → no partial state, no double-spend
- Payer account underfunded → refuses before attempting, clear message
- Concurrency: parallel tool calls do not double-spend or interleave receipts
- Key material never appears in logs, responses, or MCP output

### Exit criteria

- [ ] An agent in a real MCP client completes a paid call end to end on TestNet
- [ ] Both inbound and outbound receipts visible in the frontend
- [ ] Outcome records accumulating for every call
- [ ] Install snippet live and verified by a second person

**Do not start Phase 4 until every box above is ticked.**

## Phase 4 — Trust engine

**Goal.** The bridge knows which endpoints actually deliver, and refuses to pay the ones that don't. This is the merge point where Idea B becomes part of Idea A.

**Blocked by:** item 10 in Section 7.

### Scoring model — deliberately thin

No ML, no staking, no on-chain reputation contract, no weighted consensus. The score is computed from outcomes the bridge already observes:

| Signal | Meaning |
| --- | --- |
| Success rate | Paid calls that returned a valid response, last N calls |
| Schema conformance | Response matched the advertised schema |
| Latency | Median response time |
| Settlement integrity | Payment settled and response arrived |
| Recency | Recent behaviour weighted above old behaviour |

Composite score in `[0,1]`. Gating policy per item 10 — suggested: refuse below 0.6, warn 0.6–0.8, pass above.

**Cold start:** a service with too few observations returns `unrated` rather than a misleading number. `unrated` is not a refusal; it is a warning surfaced to the agent.

### Backend work

- Outcome store (already populated since Phase 3) → rolling score computation
- Score gate inserted before every downstream payment
- Route-around logic: when a service scores below threshold and an alternative exists in the catalog, prefer the alternative and record the substitution
- Score history retained so the frontend can draw a trend

### Frontend integration for this phase

- **Score badge** on every catalog card, with its trend sparkline
- **The route-around moment** made visible in the flow visualiser: low score → the agent visibly declines that endpoint and takes another. This is the single most important animation in the whole project (Section 16)
- **Substitution log** — every time the bridge routed around a bad endpoint, with the reason

### Tests

- Score computation is deterministic for a fixed outcome fixture
- Cold start returns `unrated`, never a fabricated score
- Recency weighting behaves: a service that was bad and is now good recovers over N calls
- Gate blocks a payment below threshold — asserted at the payment layer, not just the UI
- Route-around picks a valid alternative and records the substitution
- No alternative available → honest refusal to the agent, no payment sent

### Exit criteria

- [ ] Scores computed from real TestNet traffic, not seeded fixtures
- [ ] A deliberately broken test endpoint is correctly refused
- [ ] Route-around demonstrated end to end
- [ ] Score badges and substitution log live in the frontend

**Do not start Phase 5 until every box above is ticked.**

## Phase 5 — Trust as a paid endpoint

**Goal.** The reliability record becomes a product any agent can buy, whether or not it uses the bridge. This is the third volume surface and the Erster pattern — pay-per-evaluation trust check — which was the only approach to win twice at the Berlin hackathon.

**Blocked by:** price point from item 6.

### Backend work

- New paid x402 route: given an endpoint url, return its reliability record — score, observation count, success rate, median latency, last seen, and whether it is `unrated`
- Same challenge tag, same facilitator, same merchant address
- Declare this route in the discovery extension too, so it appears in the Bazaar as its own service
- Rate limiting and caching so the endpoint stays cheap to serve
- **Honesty constraint:** the response states observation count plainly. A score from 4 calls must not look like a score from 400

### Frontend integration for this phase

- **Public trust lookup** — a judge can paste any endpoint url and see what the service would return, free, as a demo of the paid product
- The endpoint's own listing shown in the catalog browser, so the product is visibly dogfooding itself

### Tests

- Paid trust query returns a well-formed record for a known service
- Unknown endpoint returns `unrated` with zero observations, not an error and not a guess
- Unpaid request returns 402 with the correct challenge
- Cache does not serve a stale score past its TTL
- The record returned matches the internal score used for gating — no divergence between what we sell and what we use

### Exit criteria

- [ ] Trust endpoint settling real TestNet payments
- [ ] Listed in the Bazaar as its own service
- [ ] Public lookup live in the frontend

**Do not start Phase 6 until every box above is ticked.**

## Phase 6 — Budget guard and receipts

**Goal.** A developer can let an agent spend without fear. This closes the third leg of the problem statement and is what makes the product defensible rather than a convenience.

### Backend work

- Limit model: per-agent, per-day, per-merchant, per-call caps, all configurable by the developer
- Pre-flight check before any downstream payment; refusal is cheap and explicit
- Anomaly refusal: an unusual burst against one merchant, or a price that has moved sharply since catalog ingest, is refused and surfaced rather than silently paid
- Receipt export: a developer can pull their full spend history as JSON or CSV, every line with a tx id
- Kill switch: one setting halts all outbound payments immediately

### Frontend integration for this phase

- **Budget panel** — limits, spend against them, time to reset
- **Receipt explorer** — filterable, every row linking to the on-chain transaction
- **Refusal log** — what was blocked and why. A refusal is a feature, and showing them demonstrates the guard actually works

### Tests

- Each limit type independently blocks at its boundary, and one over
- Limits reset correctly across a day boundary and across timezones
- Anomaly detection fires on a price jump and on a burst
- Kill switch halts outbound payments within one call
- Receipt export matches the on-chain record exactly — no missing rows, no phantom rows
- Concurrent calls cannot race past a limit

### Exit criteria

- [ ] All limit types enforced and tested
- [ ] Receipt export reconciles against the Indexer
- [ ] Kill switch verified
- [ ] Budget panel, receipt explorer and refusal log live in the frontend

**This is the last feature phase. Everything after is hardening, cutover and submission.**

## 15. Frontend architecture and design direction

### Two surfaces, different jobs

**Surface 1 — the domain metadata.** Machine-read by the facilitator, feeds the Bazaar listing. Accuracy beats beauty absolutely. Covered in Phase 2.

**Surface 2 — the site.** Human-read by judges. This is what Sections 15–18 specify.

### Visual direction

The audience invented x402. A marketing-site aesthetic — gradient hero, floating blobs, testimonial cards — will actively hurt. **The site should look like instrumentation:** a dashboard, a trace viewer, a terminal. Dense, dark, monospace numerals, one accent colour reserved exclusively for money moving.

| Element | Direction |
| --- | --- |
| Palette | Dark base, muted greys, one accent for settlement events only |
| Type | Monospace for all numbers, addresses, tx ids; clean sans for prose |
| Density | High. Whitespace is not the goal; legibility at density is |
| Borders | Thin, functional dividers rather than cards-on-cards |
| Motion | Only on state change. Never ambient |

### Page structure

1. **Header** — network badge, merchant address, live counters (settles, USDC, distinct payers)
2. **The pitch** — Section 18, above the fold, three short blocks
3. **Install snippet** — the MCP config to copy. The conversion surface
4. **Live flow visualiser** — Section 16, the centrepiece
5. **Catalog browser** — curated services with trust badges
6. **Receipt streams** — inbound and outbound, side by side
7. **Trust lookup** — paste a url, see a record
8. **Budget and refusal log**
9. **Verification panel** — Section 17

### Non-negotiables

- Responsive: relative units, flex/grid, wide tables scroll in their own container so the body never scrolls sideways
- Theme-aware: colour tokens on `:root`, dark-mode redefinitions, explicit background on `body`
- Every number on screen is real and live. **No mock data anywhere, at any time.** A judge who spots one fabricated figure discounts everything else
- Loading states must be shorter than an actual settlement, or they undercut the speed claim

## 16. Workflow animation spec

The thing that must be dramatised is **the absence of friction**. The Berlin recap names it exactly: the most important part was what users did not see — no wallet pop-up, no manual checkout, no extra payment step, just payment embedded into the action itself. Showing *nothing happening* is hard. These animations make the invisible visible.

### A. The 402 handshake loop — three beats

The core metaphor, and almost nobody else will build it.

| Beat | Visual | Duration |
| --- | --- | --- |
| 1. Request | Agent node emits a packet toward the service | 300ms |
| 2. Wall | Service returns 402; a barrier appears, packet stops | 250ms |
| 3. Pay and pass | Payment token crosses, barrier dissolves, response flows back | 450ms |

Runs on real traffic, loops on idle. Inline SVG, state-driven.

### B. The route-around beat — the money shot

The single most important two seconds in the pitch, because it shows discovery, trust and payment as one motion.

1. Agent surveys the catalog — several service nodes visible
2. Trust scores resolve on each node
3. One node scores low and **visibly dims and is declined**
4. Agent redirects to the alternative
5. Payment, settlement, response

No judge has watched an agent shop before. This beat is the merged thesis of Idea A and Idea B rendered in a way that needs no explanation.

### C. Settlement timer

A live millisecond counter running during a **real** settlement. Algorand's sub-three-second finality is the entire chain-choice argument; a real counter proves it in a way a slide cannot. Never pre-recorded, never simulated.

### D. Receipt stream

Terminal aesthetic, monospace, rows scrolling in as settlements land: payer address, amount, latency, tx id. Reads as operational rather than as a mockup, and doubles as evidence of payer diversity.

### E. Payer constellation

Distinct payer addresses over time as a growing point field. This is the pre-emptive answer to *proof of who is paying for it* — the question judges explicitly asked — answered before it is asked.

### Motion rules

- 150–250ms transitions, ease-out
- Animation only on state change; nothing ambient, nothing decorative
- `prefers-reduced-motion` respected: states still change, transitions become instant
- If data is unavailable, the animation stops and says so. It never invents a frame

## 17. Verification panel

**Purpose.** A judge should be able to confirm every qualifying claim without taking our word for anything, in under two minutes, by clicking. Nothing in this panel is a screenshot; every row is a live link out to a third party.

### Required rows

| Claim | Verified by linking to |
| --- | --- |
| Live on MainNet at a public HTTPS endpoint | The endpoint itself, returning a real 402 |
| Uses the GoPlausible facilitator | Our merchant record on the facilitator dashboard |
| Bazaar discovery enabled | Our listing in the Bazaar catalog |
| `x402-global-challenge` tag present | The merchant record showing `challenge: true` |
| Real MainNet payment completed | The settlement transaction on an Algorand explorer |
| Appears on the competition leaderboard | Our row on the leaderboard |
| Endpoint is spec-compliant | The GoPlausible Doctor result for our url |
| Code is public | The GitHub repository |
| Repo submitted to Electric Capital | The submission record or PR |

### Behaviour

- Each row shows a live pass/fail read from the source where the source exposes one — not a hardcoded tick
- A failing row shows as failing. **Do not hide a red row.** A panel that can show red is evidence the green ones are real
- Raw merchant-record JSON available behind a toggle for a judge who wants the underlying data
- Every transaction id anywhere on the site links to the explorer

> **Data needed:** the exact facilitator dashboard, Bazaar listing and leaderboard URLs for our merchant record — available only once Phase 2 completes and our record exists.

## 18. The pitch, rendered in the UI

Three blocks, above the fold, short enough to read standing up. No explanation of what x402 is — the judges invented it.

### Block 1 — the problem

> An agent that needs a live service today has to sign up, store a key, and manage a subscription for something it may use twice. x402 fixed the billing. It did not fix discovery, and it did not fix trust. Paying a stranger's endpoint is a leap of faith with money you cannot get back. So the services exist, and nobody calls them.

### Block 2 — what this is

> One MCP server. Your agent discovers every live x402 service on Algorand, checks whether each one actually delivers before paying it, and settles per call in USDC under a budget you set. Install once. Your agent never sees a wallet.

### Block 3 — why Algorand, and why this matters here

> Payments worth fractions of a cent need sub-cent fees and sub-three-second finality. An agent deciding in 200ms cannot wait on settlement or pay more in fees than the data costs.
>
> **Every call routed through this bridge is volume for another entrant's endpoint. This project does not only compete on the leaderboard — it feeds it.**

### Notes on delivery

That last line is the one to make sure a judge reads. It is structurally true given how orchestrator volume is counted, it is unusual, and it speaks directly to what the Foundation is actually trying to buy with this competition: a marketplace that is alive, not another listing in an empty directory.

For the live pitch, the compounding argument is the strongest sustained-potential claim available: a bridge is useful on day one; a bridge with a reliability history is more useful in month three.

## 19. Test strategy

**Rule: every transaction used in testing is a TestNet transaction.** MainNet is touched exactly once, at cutover, after everything below is green. No exploratory MainNet calls, no "just checking it works" on MainNet.

### Layers

| Layer | Scope | Runs |
| --- | --- | --- |
| Unit | Pure logic: scoring, budget arithmetic, catalog parsing | Every commit |
| Contract | Our assumptions about the facilitator's shapes, against fixtures | Every commit |
| Integration | Service-to-service inside our system, real DB | Every commit |
| Protocol conformance | x402 challenge and payment shapes against the spec | Every commit |
| End-to-end TestNet | Real settlements, real Indexer confirmation | Nightly + pre-phase-exit |
| Failure injection | Deliberately broken downstream services | Pre-phase-exit |
| Load | Concurrency and rate behaviour | Before cutover |

### Protocol conformance suite

- Unpaid request returns 402 with correct challenge shape
- Challenge advertises correct ASA id and base units for the stated price
- CORS headers correct — the facilitator's probe checks these
- 402-first behaviour on every paid route
- Valid payment yields the response exactly once; replay rejected
- Underpayment, wrong asset, wrong network, expired payment each rejected distinctly

### Failure injection suite

Stand up deliberately broken TestNet endpoints and assert the bridge behaves:

| Broken behaviour | Expected bridge response |
| --- | --- |
| Takes payment, returns nothing | Recorded as failure, score drops, agent gets honest error |
| Returns wrong schema | Schema mismatch recorded, score drops |
| Very slow | Latency recorded, timeout enforced, no hung agent |
| Returns 500 before 402 | No payment sent |
| Price changed since catalog ingest | Anomaly refusal |
| Disappears mid-session | Marked inactive, routed around |

### Reconciliation suite

The most important test in the project: **our receipts must match the chain.** For a window of TestNet activity, assert every receipt has a confirmed on-chain transaction, and every on-chain transaction to our addresses has a receipt. No phantom rows in either direction. If this ever fails, every number on the frontend is suspect.

### Coverage targets

- Payment path, scoring and budget logic: near-total coverage, no exceptions
- Everything else: pragmatic
- A phase cannot exit with a failing or skipped test in its own suite

## 20. TestNet → MainNet cutover

This is a one-way gate. It happens once, deliberately, after everything below passes.

### Pre-cutover gate — all must be true

- [ ] Phases 0–6 exit criteria all ticked
- [ ] Full test suite green, including failure injection and reconciliation
- [ ] At least 48 hours of continuous TestNet operation with no unexplained failure
- [ ] Reconciliation clean over that whole window
- [ ] Kill switch tested under load
- [ ] MainNet merchant account created, opted into USDC `31566704`, and **this address recorded as permanent**
- [ ] MainNet payer account funded with the amount agreed in item 8, not more
- [ ] Rollback plan written: how to halt if something is wrong

### Cutover procedure

1. Flip `NETWORK` to `mainnet` — the single variable everything derives from
2. Point `AVM_ADDRESS` at the MainNet merchant account. Everything else in the route config stays identical
3. Confirm the challenge tag is present on MainNet routes
4. Re-run `declareDiscoveryExtension` against MainNet
5. Run Doctor against the MainNet url; confirm BAZAAR and HACKATHON badges
6. Execute **one** real MainNet payment. Confirm USDC received at the merchant address
7. Confirm the merchant record shows `bazaar: true`, `challenge: true`, settles ≥ 1
8. Confirm the row appears in the Bazaar and on the leaderboard
9. Populate the verification panel with the now-real URLs
10. Begin controlled downstream operation within budget limits

### Hard rules after cutover

- **The MainNet payTo address is never rotated.** Discovery, dashboards, receipts and rankings all key on it; rotating fragments history across accounts and destroys the leaderboard position
- TestNet remains the environment for every subsequent change. New features go through the same phase discipline and only reach MainNet after TestNet proof
- The measurement window in October is unannounced, so uptime from cutover onward matters continuously — there is no safe window to be down

## 21. Submission checklist

Two separate submissions. Both are required; the Electric Capital one is described as part of the qualification process and appears in neither the Official Rules PDF nor the website checklist, so it is easy to miss.

### A. Algorand challenge submission

| Requirement | Satisfied by |
| --- | --- |
| Live on MainNet, public HTTPS endpoint | Cutover step 1–2 |
| GoPlausible facilitator with Bazaar discovery | Phase 2 + cutover step 4 |
| `x402-global-challenge` tag | Phase 1 + cutover step 3 |
| At least one real MainNet payment | Cutover step 6 |
| Appears in Bazaar and on leaderboard | Cutover step 8 |
| Project details: what the payment unlocks, proof of who is paying | Section 4 + payer constellation data |

### B. Electric Capital repository submission

This feeds the Crypto Ecosystems dataset that measures developer activity per chain. It implies the repo is read by humans as part of qualification, and that commit activity itself is the point.

- [ ] Repository public from the start
- [ ] Contains the actual Algorand and x402 code — not a stub, not a pointer elsewhere
- [ ] Real incremental commit history rather than one squashed dump
- [ ] README carries the written pitch: what the payment unlocks, who pays, and mainnet evidence — merchant record state, settle count, tx ids
- [ ] Submitted via the Electric Capital process referenced in the Foundation's email

### README structure

Mirror the pattern other entrants use — document the merchant record, settle counts and mainnet evidence directly in the README so a reviewer can verify without leaving the page:

1. One-liner and entry type
2. Problem and solution, four paragraphs maximum
3. MainNet evidence: merchant address, `bazaar`/`challenge` flags, settle count, sample tx ids
4. Architecture diagram
5. Local setup and TestNet run instructions
6. MCP install snippet
7. Test suite instructions and what each suite covers
8. Links: live site, Bazaar listing, leaderboard row, Doctor result

## 22. Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Downstream services are dead** — the catalog is mostly inactive entries, so there is nothing worth paying for | High | Curate hard: 4–6 verified services, not 150. Verify manually in Phase 2. A bridge to six good things beats a broken bridge to everything |
| **No real payers materialise in October** | High | This is the one that decides the outcome. Section 7 item 11 must be answered honestly, and outreach must start the day Phase 3 lands — not in October |
| **Discovery never activates** — `bazaar: true` stays false | High | Doctor is the Phase 2 exit gate. Do not proceed on the assumption it worked |
| **Volume looks self-generated** | High | Distinct payers is the headline metric, not gross volume. The bridge paying downstream services is legitimate operation; the trust endpoint consuming its own data is a real product dependency. Never fabricate inbound payments to ourselves |
| **Scope creep on the trust layer** | Medium | It is explicitly thin: success rate + recency, nothing more. No staking, no disputes, no consensus, no on-chain reputation contract |
| **MainNet mistake burns real money** | Medium | The cutover gate in Section 20, and the budget guard shipped before large-scale operation |
| **Facilitator behaviour changes** | Medium | Contract tests against fixtures fail loudly rather than silently mis-parsing. Their docs are the source of truth over any guide |
| **Downtime during the unannounced measurement window** | Medium | Uptime monitoring from cutover; the window is deliberately unannounced so there is no safe time to be down |
| **Facilitator stops covering transaction fees** | Low | Keep a small ALGO balance in both accounts against the possibility |

### The honest summary

The build is achievable. The field looks shallow — one observed entry sat at rank 145 of 147 with 0.001 USDC of volume — so qualifying for the top 50 is realistic. What separates a top-50 finish from a finalist spot is whether real, distinct people pay for this in October. Every hour spent polishing after Phase 6 is worth less than an hour spent getting one more genuine payer.

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

### Proposed build schedule

Today is September 18. Eleven days to the submission deadline.

| Days | Work |
| --- | --- |
| Sept 18–19 | Phase 0 — foundation, accounts, deploy pipeline |
| Sept 19–21 | Phase 1 — paid endpoint settling on TestNet |
| Sept 21–22 | Phase 2 — discovery, catalog, Doctor green |
| Sept 22–24 | Phase 3 — MCP server and downstream payment |
| Sept 24–25 | **Cutover gate → MainNet.** Qualifying entry exists |
| Sept 25–26 | Phase 4 — trust engine |
| Sept 26–27 | Phase 5 — trust as paid endpoint |
| Sept 27–28 | Phase 6 — budget guard, frontend polish, animations |
| Sept 28–29 | README, Electric Capital, Algorand submission |
| Oct 1 onward | **Real payers.** The part that actually decides it |

### Two things about this schedule

**Cutover is scheduled before the feature work finishes.** Reaching MainNet by around Sept 24 means a qualifying, ranked entry exists while there is still a week of runway. If Phases 4–6 slip, the entry survives. If cutover slips to the 28th, one bad day ends the attempt.

**The Sept 29 deadline is paperwork, not the finish line.** Volume is measured in October over a window nobody has announced. Submission closes the door on entry; it does not close the door on scoring. Plan for steady, continuous traffic from cutover through early October — a single burst risks missing the window entirely and looks like manipulation if it lands.
