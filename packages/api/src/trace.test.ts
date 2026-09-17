import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { TraceHub, type Trace } from "./trace.js";

describe("TraceHub", () => {
  let store: Store;
  let hub: TraceHub;
  let emitted: Trace[];

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(":memory:");
    hub = new TraceHub(store, "testnet");
    emitted = [];
    hub.on("trace", (t) => emitted.push(t));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits on every state change so the UI never polls for progress", () => {
    const t = hub.start("/v1/orchestrate");
    const before = emitted.length;
    hub.begin(t.id, "request");
    hub.end(t.id, "request", "ok");
    expect(emitted.length).toBeGreaterThan(before + 1);
  });

  it("flips a step to stalled once it exceeds its budget", () => {
    const t = hub.start("/v1/orchestrate");
    hub.begin(t.id, "settle");

    // settle budget is 8s; Algorand finality is ~3s, so this is a real anomaly.
    vi.advanceTimersByTime(8_001);

    const latest = emitted.at(-1)!;
    const settle = latest.steps.find((s) => s.id === "settle")!;
    expect(settle.state).toBe("stalled");
    expect(settle.detail).toMatch(/no progress/);
    expect(latest.state).toBe("stalled");
  });

  it("does not stall a step that finished in time", () => {
    const t = hub.start("/v1/orchestrate");
    hub.begin(t.id, "settle");
    vi.advanceTimersByTime(2_000);
    hub.end(t.id, "settle", "ok");
    vi.advanceTimersByTime(30_000);

    const settle = emitted.at(-1)!.steps.find((s) => s.id === "settle")!;
    expect(settle.state).toBe("ok");
  });

  it("lets a stalled step still resolve successfully", () => {
    // Slow is not the same as broken. A stalled step that lands is ok.
    const t = hub.start("/v1/orchestrate");
    hub.begin(t.id, "settle");
    vi.advanceTimersByTime(8_001);
    expect(emitted.at(-1)!.state).toBe("stalled");

    hub.end(t.id, "settle", "ok");
    const after = emitted.at(-1)!;
    expect(after.steps.find((s) => s.id === "settle")!.state).toBe("ok");
    expect(after.state).toBe("running");
  });

  it("marks unreached steps skipped on failure, so the halt point is unambiguous", () => {
    const t = hub.start("/v1/orchestrate");
    hub.begin(t.id, "request");
    hub.end(t.id, "request", "ok");
    hub.begin(t.id, "settle");
    hub.fail(t.id, "settle", "facilitator rejected");

    const final = emitted.at(-1)!;
    expect(final.state).toBe("failed");
    const byId = Object.fromEntries(final.steps.map((s) => [s.id, s.state]));
    expect(byId["request"]).toBe("ok");
    expect(byId["settle"]).toBe("failed");
    expect(byId["deliver"]).toBe("skipped");
    expect(byId["receipt"]).toBe("skipped");
    // Exactly one failed step: the UI reads it as "stopped at".
    expect(final.steps.filter((s) => s.state === "failed")).toHaveLength(1);
  });

  it("persists a terminal trace and drops it from the live set", () => {
    const t = hub.start("/v1/orchestrate");
    hub.begin(t.id, "request");
    hub.end(t.id, "request", "ok");
    hub.complete(t.id);

    expect(store.recentTraces(5)).toHaveLength(1);
    // Further updates to a finished trace are ignored rather than resurrecting it.
    hub.begin(t.id, "settle");
    expect(emitted.at(-1)!.state).toBe("ok");
  });

  it("records total duration only once finished", () => {
    const t = hub.start("/v1/orchestrate");
    expect(emitted.at(-1)!.totalMs).toBeNull();
    vi.advanceTimersByTime(1_500);
    hub.complete(t.id);
    expect(emitted.at(-1)!.totalMs).toBeGreaterThanOrEqual(1_500);
  });

  it("keeps the recent ring newest-first without duplicating a trace", () => {
    const a = hub.start("/v1/orchestrate");
    hub.complete(a.id);
    const b = hub.start("/v1/orchestrate");
    hub.complete(b.id);

    const recent = hub.recent(10);
    expect(recent[0]!.id).toBe(b.id);
    expect(recent.filter((t) => t.id === a.id)).toHaveLength(1);
  });

  it("ignores updates for an unknown trace id rather than throwing", () => {
    expect(() => hub.begin("no-such-trace", "settle")).not.toThrow();
    expect(() => hub.end("no-such-trace", "settle", "ok")).not.toThrow();
    expect(() => hub.complete("no-such-trace")).not.toThrow();
  });
});
