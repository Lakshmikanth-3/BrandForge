# End-to-end TestNet report

Run: 2026-09-20T17:55:59.048Z  ·  Target: https://sentry402-ecru.vercel.app  ·  Network: testnet

**10/11 steps passed.**

> Test traffic from a throwaway account we control. Not customer volume.

- PASS — 1. throwaway customer account, funded and opted in: 7KRDA5KVYV2VMB7TASFSJKQ5M44PLWMJT45FYUWXVGIJWGFNIH23G36SPY  USDC 0.42
- PASS — 2. both paid routes answer 402 with a v2 challenge: 402 + payment-required on /v1/orchestrate and /v1/trust
- PASS — 3. customer pays $0.02 for a trust record, settles on chain: HTTP 200, customer USDC -0.02 exactly, keys: resourceUrl,score,verdict,observations,successRate,paidNothingCount,medianLatencyMs,schemaConformance,coldStartCount,clientErrorCount,lastSeenAt,basis,cached
- PASS — 4. replaying the same payment proof does not get a second answer: replay refused with HTTP 402
- PASS — 5. failure-injection routes are live and misbehave on purpose: index 200, /vanished 404
- PASS — 6. MCP over stdio: list tools, read budget, make a real paid call: 8 tools; paid call ok: { "result": { "protocol": "folks", "timestamp": "2026-09-20T17:50:54.828Z", "as_of": "2026-09-20T17:50:49.260Z", "source
- PASS — 7. kill switch: halted call moves no money, resumes after: refused while halted (payer balance unchanged), paid again after resume
- PASS — 8. reconciliation: chain and records agree: clean, 62 matched
- PASS — 9. GoPlausible Doctor: BAZAAR and HACKATHON badges: BAZAAR true, HACKATHON true (18 checks left today)
- FAIL — 10. client pays $0.05, our backend pays downstream, synthesized result returned: no downstream transaction id in the receipt
- PASS — 11. a refused target does not charge the client: HTTP 400, customer balance unchanged
