/** Mirrors the API shapes in packages/api. Nothing here is invented client-side. */

export type StepId =
  | "request"
  | "challenge"
  | "payment"
  | "settle"
  | "deliver"
  | "receipt"
  | "resolve"
  | "trust"
  | "budget"
  | "confirm";

export type FlowId = "inbound" | "bridged";

export type StepState = "pending" | "active" | "ok" | "failed" | "skipped" | "stalled";

export type TraceState = "running" | "ok" | "failed" | "stalled";

export interface Step {
  id: StepId;
  label: string;
  hint: string;
  state: StepState;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  detail: string | null;
}

export interface Trace {
  id: string;
  flow: FlowId;
  route: string;
  network: string;
  state: TraceState;
  payer: string | null;
  txId: string | null;
  amountBase: number | null;
  createdAt: string;
  startedAtMs: number;
  totalMs: number | null;
  steps: Step[];
}

export interface Stats {
  settleCount: number;
  totalBase: number;
  totalUsdc: number;
  distinctPayers: number;
  outboundCount: number;
  outboundUsdc: number;
  firstSettledAt: string | null;
  lastSettledAt: string | null;
  network: string;
  merchantAddress: string;
}

export interface Receipt {
  txId: string;
  direction: "in" | "out";
  route: string;
  payer: string;
  payee: string;
  amountBase: number;
  amountUsdc: number;
  assetId: string;
  network: string;
  confirmedRound: number | null;
  settledAt: string;
  traceId: string | null;
  latencyMs: number | null;
  explorerUrl: string;
}

export interface FlowShape {
  steps: { id: StepId; label: string; hint: string }[];
  flows: Record<FlowId, { id: StepId; label: string; hint: string }[]>;
  routes: { orchestrate: string; trust: string };
  prices: { orchestrate: string; trust: string };
  network: string;
  explorerTxBase: string;
}

/** Connection state of the live stream. Drives the "is this real" indicator. */
export type StreamState = "connecting" | "live" | "down";

export interface Budget {
  halted: boolean;
  day: string;
  spentTodayUsdc: number;
  remainingTodayUsdc: number;
  caps: { perCallUsdc: number; perDayUsdc: number; perMerchantPerDayUsdc: number };
  payerReady: boolean;
  payerAddress: string | null;
  recent: {
    id: string;
    merchant: string;
    route: string;
    amountUsdc: number;
    state: string;
    txId: string | null;
    createdAt: string;
  }[];
}

export interface Service {
  label: string;
  summary: string;
  url: string;
  method: string;
  priceUsdc: number | null;
  catalogPriceUsdc: number | null;
  probeVerdict: string | null;
  probeLatencyMs: number | null;
  /** Live price divided by catalog price. 1 means they agree. */
  priceDrift: number | null;
  active: boolean;
  probedAt: string | null;
  trust: TrustRecord;
}

export type Verdict = "pass" | "warn" | "refuse" | "unrated";

export interface TrustRecord {
  resourceUrl: string;
  /** Null when unrated. The UI must render that as unrated, never as zero. */
  score: number | null;
  verdict: Verdict;
  observations: number;
  successRate: number | null;
  paidNothingCount: number;
  medianLatencyMs: number | null;
  schemaConformance: number | null;
  coldStartCount: number;
  lastSeenAt: string | null;
  basis: string;
}

export interface Substitution {
  at: string;
  refusedUrl: string;
  refusedScore: number | null;
  chosenUrl: string | null;
  chosenScore: number | null;
  reason: string;
}

export type CheckStatus = "pass" | "fail" | "pending" | "manual";

export interface VerificationRow {
  id: string;
  claim: string;
  status: CheckStatus;
  detail: string;
  link: string | null;
  /** True when the row was read from a third party rather than from us. */
  external: boolean;
}

export interface VerificationReport {
  network: string;
  checkedAt: string;
  rows: VerificationRow[];
  passing: number;
  failing: number;
  merchantRecord: unknown;
  bazaarEntries: unknown[];
}

export interface ReconcileReport {
  network: string;
  checkedAt: string;
  chainTransfers: number;
  receipts: number;
  matched: number;
  clean: boolean;
  error: string | null;
  discrepancies: {
    kind: string;
    txId: string;
    detail: string;
  }[];
}
