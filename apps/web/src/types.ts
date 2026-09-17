/** Mirrors the API shapes in packages/api. Nothing here is invented client-side. */

export type StepId = "request" | "challenge" | "payment" | "settle" | "deliver" | "receipt";

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
  routes: { orchestrate: string; trust: string };
  prices: { orchestrate: string; trust: string };
  network: string;
  explorerTxBase: string;
}

/** Connection state of the live stream. Drives the "is this real" indicator. */
export type StreamState = "connecting" | "live" | "down";
