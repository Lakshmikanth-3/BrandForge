/**
 * Trace engine — the data behind the flow animation.
 *
 * The frontend animation renders ONLY what a trace reports. There is no canned
 * sequence and no client-side fabrication: if a step stalls, the trace says
 * stalled and the UI shows stalled. That is the whole point (PRD §15: no mock
 * data anywhere, at any time; §16: if data is unavailable the animation stops
 * and says so, it never invents a frame).
 *
 * Phase 1 covers the inbound 402 lifecycle on our own paid route. Phases 3-4
 * extend the same STEPS list to the nine-step bridged call and the route-around
 * without changing this engine.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";

export interface StepDef {
  readonly id: StepId;
  readonly label: string;
  readonly hint: string;
}

/**
 * Two flows, because the bridge sits on both sides of x402.
 *
 * `inbound` is an agent paying us. `bridged` is us paying a downstream service on
 * an agent's behalf — the nine-step call from PRD §5.
 *
 * Note on verify/settle: they are never split. The facilitator performs both
 * inside one call, and neither the resource server nor the paying client observes
 * the two round trips separately. An earlier note here claimed Phase 3 would
 * split them because we would be the client; that was wrong — as the payer we see
 * less, not more. Reporting two timings would mean inventing one.
 */
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

const INBOUND_STEPS: readonly StepDef[] = [
  { id: "request", label: "Request", hint: "Agent calls the paid route" },
  { id: "challenge", label: "402 Challenge", hint: "Payment requirements returned" },
  { id: "payment", label: "X-PAYMENT", hint: "Signed payment header received" },
  { id: "settle", label: "Verify & settle", hint: "Facilitator settles USDC on Algorand" },
  { id: "deliver", label: "Deliver", hint: "Paid response returned" },
  { id: "receipt", label: "Receipt", hint: "Settlement recorded and reconciled" },
];

const BRIDGED_STEPS: readonly StepDef[] = [
  { id: "resolve", label: "Resolve", hint: "Tool mapped to a curated service and price" },
  { id: "trust", label: "Trust gate", hint: "Reliability record checked before paying" },
  { id: "budget", label: "Budget guard", hint: "Spend reserved against the caps" },
  { id: "request", label: "Request", hint: "Downstream service called" },
  { id: "challenge", label: "402 Challenge", hint: "Downstream states its price" },
  { id: "payment", label: "Pay", hint: "Payment signed and sent in X-PAYMENT" },
  { id: "settle", label: "Verify & settle", hint: "Facilitator settles USDC on Algorand" },
  { id: "confirm", label: "Confirm", hint: "Settlement confirmed against the indexer" },
  { id: "deliver", label: "Deliver", hint: "Result returned to the agent" },
];

export const FLOWS: Record<FlowId, readonly StepDef[]> = {
  inbound: INBOUND_STEPS,
  bridged: BRIDGED_STEPS,
};

/** Kept for the inbound path and the existing /api/flow contract. */
export const STEPS = INBOUND_STEPS;

/**
 * `stalled` is a first-class state, not an error: it means the step is still
 * running but has exceeded its budget. It can still resolve to ok.
 */
export type StepState = "pending" | "active" | "ok" | "failed" | "skipped" | "stalled";
export type TraceState = "running" | "ok" | "failed" | "stalled";

/** Per-step budget in ms. Exceeding it flips the step to `stalled` and emits. */
const STEP_BUDGET_MS: Record<StepId, number> = {
  resolve: 1_000,
  trust: 2_000,
  budget: 1_000,
  request: 20_000, // a cold free-tier downstream can legitimately take this long
  challenge: 1_000,
  payment: 30_000, // waiting on a client to pay — long by nature
  settle: 8_000, // Algorand finality is ~3s; 8s means something is wrong
  confirm: 15_000, // indexer lags the round it is confirming
  deliver: 5_000,
  receipt: 10_000,
};

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

function freshSteps(flow: FlowId): Step[] {
  return FLOWS[flow].map((s) => ({
    id: s.id,
    label: s.label,
    hint: s.hint,
    state: "pending" as StepState,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    detail: null,
  }));
}

export interface TraceHubEvents {
  trace: (trace: Trace) => void;
}

/**
 * Holds live traces, emits on every state change, persists terminal ones.
 * Keeps a bounded ring of recent traces so a page load has something to show
 * without waiting for the next payment.
 */
export class TraceHub extends EventEmitter {
  private readonly live = new Map<string, Trace>();
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();
  private ring: Trace[] = [];

  constructor(
    private readonly store: Store,
    private readonly network: string,
    private readonly ringSize = 50,
  ) {
    super();
    this.setMaxListeners(0); // one listener per SSE client
  }

  start(route: string, flow: FlowId = "inbound"): Trace {
    const trace: Trace = {
      id: randomUUID(),
      flow,
      route,
      network: this.network,
      state: "running",
      payer: null,
      txId: null,
      amountBase: null,
      createdAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      totalMs: null,
      steps: freshSteps(flow),
    };
    this.live.set(trace.id, trace);
    this.publish(trace);
    return trace;
  }

  /** Marks a step active and arms its stall watchdog. */
  begin(id: string, step: StepId, detail?: string): void {
    const trace = this.live.get(id);
    if (!trace) return;
    const s = trace.steps.find((x) => x.id === step);
    if (!s) return;

    s.state = "active";
    s.startedAt = Date.now();
    if (detail !== undefined) s.detail = detail;

    this.clearWatchdog(id);
    const timer = setTimeout(() => {
      const t = this.live.get(id);
      const cur = t?.steps.find((x) => x.id === step);
      if (!t || !cur || cur.state !== "active") return;
      cur.state = "stalled";
      cur.detail = `no progress in ${STEP_BUDGET_MS[step]}ms`;
      t.state = "stalled";
      this.publish(t);
    }, STEP_BUDGET_MS[step]);
    timer.unref?.();
    this.watchdogs.set(id, timer);

    this.publish(trace);
  }

  /** Resolves a step. A stalled step that finishes is still ok. */
  end(
    id: string,
    step: StepId,
    state: Extract<StepState, "ok" | "failed" | "skipped">,
    detail?: string,
  ): void {
    const trace = this.live.get(id);
    if (!trace) return;
    const s = trace.steps.find((x) => x.id === step);
    if (!s) return;

    s.state = state;
    s.endedAt = Date.now();
    s.durationMs = s.startedAt === null ? null : s.endedAt - s.startedAt;
    if (detail !== undefined) s.detail = detail;

    this.clearWatchdog(id);

    if (state === "failed") {
      trace.state = "failed";
      // Everything not yet reached is skipped, so the UI shows where it stopped.
      for (const other of trace.steps) {
        if (other.state === "pending") other.state = "skipped";
      }
      this.finish(trace);
      return;
    }

    if (trace.state === "stalled") trace.state = "running";
    this.publish(trace);
  }

  annotate(
    id: string,
    patch: Partial<Pick<Trace, "payer" | "txId" | "amountBase">>,
  ): void {
    const trace = this.live.get(id);
    if (!trace) return;
    Object.assign(trace, patch);
    this.publish(trace);
  }

  /** Completes a trace successfully and persists it. */
  complete(id: string): void {
    const trace = this.live.get(id);
    if (!trace) return;
    trace.state = trace.steps.some((s) => s.state === "failed") ? "failed" : "ok";
    this.finish(trace);
  }

  fail(id: string, step: StepId, detail: string): void {
    this.end(id, step, "failed", detail);
  }

  private finish(trace: Trace): void {
    trace.totalMs = Date.now() - trace.startedAtMs;
    this.clearWatchdog(trace.id);
    this.live.delete(trace.id);
    this.persist(trace);
    this.publish(trace);
  }

  private clearWatchdog(id: string): void {
    const t = this.watchdogs.get(id);
    if (t) {
      clearTimeout(t);
      this.watchdogs.delete(id);
    }
  }

  private persist(trace: Trace): void {
    try {
      this.store.saveTrace({
        id: trace.id,
        flow: trace.flow,
        route: trace.route,
        network: trace.network,
        state: trace.state,
        payer: trace.payer,
        txId: trace.txId,
        totalMs: trace.totalMs,
        createdAt: trace.createdAt,
        steps: trace.steps,
      });
    } catch (err) {
      // A storage failure must never break a payment that already settled.
      console.error("trace persist failed", err);
    }
  }

  private publish(trace: Trace): void {
    const snapshot = structuredClone(trace);
    this.ring = [snapshot, ...this.ring.filter((t) => t.id !== trace.id)].slice(0, this.ringSize);
    this.emit("trace", snapshot);
  }

  /** Live traces first, then recent finished ones. */
  recent(limit = 20): Trace[] {
    return this.ring.slice(0, limit);
  }

  hydrate(): void {
    if (this.ring.length > 0) return;
    try {
      this.ring = this.store.recentTraces(this.ringSize) as Trace[];
    } catch {
      this.ring = [];
    }
  }
}
