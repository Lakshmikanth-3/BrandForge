/**
 * Library surface. `server.ts` is the bootstrap and starts listening on import,
 * so anything reusing these pieces (the MCP server, scripts) imports from here.
 */
export { Store } from "./db.js";
export type { ReceiptRow, ServiceRow, Stats, Direction } from "./db.js";
export { BudgetGuard, DEFAULT_LIMITS, utcDay } from "./budget.js";
export type { BudgetLimits, BudgetDecision } from "./budget.js";
export { TraceHub, FLOWS, STEPS } from "./trace.js";
export type { Trace, Step, StepId, FlowId } from "./trace.js";
export { DownstreamPayer } from "./payer.js";
export { TrustEngine, computeRecord, verdictFor, DEFAULT_POLICY, MIN_OBSERVATIONS } from "./trust.js";
export type { Outcome, TrustRecord, Verdict, TrustPolicy } from "./trust.js";
export type { PayOutcome } from "./payer.js";
export {
  CatalogIngester,
  CURATED,
  isAllowlisted,
  probeService,
  samplePayloadFor,
  fillPlaceholders,
} from "./catalog.js";
export type { CuratedService, CatalogEntry, ProbeResult } from "./catalog.js";
export { SettlementListener } from "./listener.js";
export { rehydrate, importSeedOutcomes, isSeedFile, SEED_PATH } from "./rehydrate.js";
export type { SeedFile, RehydrateResult } from "./rehydrate.js";
export { Reconciler, receiptsAsCsv } from "./reconcile.js";
export { Verifier, REPO_URL } from "./verification.js";
export type { VerificationReport, VerificationRow, CheckStatus } from "./verification.js";
export type { ReconcileReport, Discrepancy } from "./reconcile.js";
export { PRICES, ROUTE_PATHS } from "./x402.js";
export { TtlCache, RateLimiter, TRUST_CACHE_TTL_MS } from "./trustcache.js";
export {
  mountInjectRoutes,
  injectUrl,
  INJECTED,
  INJECT_PREFIX,
  INJECT_EXPECTED_BASE,
} from "./inject.js";
export type { InjectedBehaviour } from "./inject.js";
export { createApp } from "./app.js";
export type { AppParts } from "./app.js";
