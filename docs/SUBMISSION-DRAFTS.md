# Submission drafts (for you to review and paste; nothing has been submitted)

Do not submit until MainNet cutover is done. On TestNet the Doctor says "MainNet boards, receipts and the
Challenge won't count this."

## Algorand challenge form

**Project name:** Sentry402

**One-line description:** An MCP server that checks an x402 service's reliability record, enforces a spending
budget, then pays it on Algorand, and sells that trust record as a paid endpoint.

**Track:** Orchestrator

**Live endpoint:** https://sentry402-ecru.vercel.app/v1/orchestrate (POST, $0.05 USDC)
**Second paid route:** https://sentry402-ecru.vercel.app/v1/trust?url= (GET, $0.02 USDC)

**Repository:** https://github.com/Lakshmikanth-3/Sentry402

**Contact:** lakshmikanth.27csb@licet.ac.in

**What it does (long):**
An agent that pays for APIs has three problems: it can pay a service that then fails, it can overspend, and
it cannot tell a good service from a bad one. Sentry402 is an MCP server that solves them. Before paying, it
consults a trust record built from real paid calls (success rate, latency, whether a payment returned nothing).
It reserves funds under per-call, per-day and per-merchant caps, with a kill switch. It then pays over x402 on
Algorand and returns the result with the settlement transaction id. The same trust record is sold as a paid
endpoint.

**Evidence (all checkable):** live 402 with the `x402-global-challenge` tag; Bazaar-catalogued routes; Doctor
reports BAZAAR listed; on-chain receipts reconciled both directions; a public verification panel; an
end-to-end TestNet script (9/9 steps).

**Honest limits:** runs on TestNet at time of writing; TestNet settlements are our own test traffic, not customer
volume; the hosted trust record is a snapshot of real observations, refreshed by re-export.

_Fill in before submitting:_ MainNet URL if it changes, MainNet merchant address, demo video link.

## Electric Capital crypto-ecosystems pull request

**Title:** Add Sentry402

**Body:**
> Adds Sentry402, an open-source MCP server and paid API for trust-checked, budget-guarded x402 payments on
> Algorand.
> Repository: https://github.com/Lakshmikanth-3/Sentry402
> Ecosystem: Algorand. Licence: see repository.

_Check the repo's `CONTRIBUTING`/migration format before opening the PR; the entry format has changed over
time and I have not verified the current one._
