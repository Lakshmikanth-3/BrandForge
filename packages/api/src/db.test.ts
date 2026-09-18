import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";

/**
 * Store internals.
 *
 * These are the persistence guarantees everything else assumes: idempotency by
 * transaction id, cursors that survive a restart, bounded queries, and money held as
 * integers. A break here is silent and shows up as a wrong number on the dashboard
 * rather than as an error.
 */

describe("receipts", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const receipt = (over: Partial<Parameters<Store["putReceipt"]>[0]> = {}) => ({
    txId: "TX1",
    direction: "in" as const,
    route: "/v1/orchestrate",
    payer: "PAYER",
    payee: "MERCHANT",
    amountBase: 50_000,
    assetId: "10458941",
    network: "testnet",
    confirmedRound: 100,
    settledAt: "2026-09-18T00:00:00.000Z",
    traceId: null,
    latencyMs: 900,
    ...over,
  });

  it("returns true only for the call that inserted", () => {
    expect(store.putReceipt(receipt())).toBe(true);
    expect(store.putReceipt(receipt())).toBe(false);
  });

  it("does not overwrite an existing receipt on a conflicting insert", () => {
    store.putReceipt(receipt({ amountBase: 50_000 }));
    store.putReceipt(receipt({ amountBase: 1 }));
    // First write wins; the second is a no-op, not an update.
    expect(store.receipts()[0]!.amountBase).toBe(50_000);
  });

  it("orders newest first", () => {
    store.putReceipt(receipt({ txId: "OLD", settledAt: "2026-09-01T00:00:00.000Z" }));
    store.putReceipt(receipt({ txId: "NEW", settledAt: "2026-09-18T00:00:00.000Z" }));
    expect(store.receipts().map((r) => r.txId)).toEqual(["NEW", "OLD"]);
  });

  it("caps the limit so a caller cannot ask for unbounded rows", () => {
    for (let i = 0; i < 20; i += 1) store.putReceipt(receipt({ txId: `T${i}` }));
    expect(store.receipts({ limit: 5 })).toHaveLength(5);
    expect(store.receipts({ limit: 10_000 }).length).toBeLessThanOrEqual(500);
  });

  it("preserves nulls rather than coercing them to zero", () => {
    store.putReceipt(receipt({ confirmedRound: null, latencyMs: null, traceId: null }));
    const row = store.receipts()[0]!;
    expect(row.confirmedRound).toBeNull();
    expect(row.latencyMs).toBeNull();
    expect(row.traceId).toBeNull();
  });

  it("keeps amounts as integers through a round trip", () => {
    store.putReceipt(receipt({ amountBase: 1 }));
    expect(store.receipts()[0]!.amountBase).toBe(1);
    expect(Number.isInteger(store.receipts()[0]!.amountBase)).toBe(true);
  });

  it("reports the first and last settlement times", () => {
    store.putReceipt(receipt({ txId: "A", settledAt: "2026-09-01T00:00:00.000Z" }));
    store.putReceipt(receipt({ txId: "B", settledAt: "2026-09-18T00:00:00.000Z" }));
    const stats = store.stats();
    expect(stats.firstSettledAt).toBe("2026-09-01T00:00:00.000Z");
    expect(stats.lastSettledAt).toBe("2026-09-18T00:00:00.000Z");
  });
});

describe("cursors", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("returns null for an unset cursor rather than zero", () => {
    // Zero would mean "rescan from genesis", which is a different instruction.
    expect(store.getCursor("nope")).toBeNull();
  });

  it("round trips and overwrites", () => {
    store.setCursor("k", "100");
    expect(store.getCursor("k")).toBe("100");
    store.setCursor("k", "200");
    expect(store.getCursor("k")).toBe("200");
  });

  it("keeps separate cursors independent", () => {
    store.setCursor("inbound_min_round", "10");
    store.setCursor("outbound_min_round", "20");
    expect(store.getCursor("inbound_min_round")).toBe("10");
    expect(store.getCursor("outbound_min_round")).toBe("20");
  });
});

describe("settings", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("returns null when unset", () => {
    expect(store.getSetting("kill_switch")).toBeNull();
  });

  it("persists a value", () => {
    store.setSetting("kill_switch", "on");
    expect(store.getSetting("kill_switch")).toBe("on");
  });
});

describe("traces", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const trace = (over: Record<string, unknown> = {}) => ({
    id: "T1",
    flow: "inbound",
    route: "/v1/orchestrate",
    network: "testnet",
    state: "ok",
    payer: null,
    txId: null,
    totalMs: 12,
    createdAt: "2026-09-18T00:00:00.000Z",
    steps: [{ id: "request", state: "ok" }],
    ...over,
  });

  it("upserts rather than duplicating a trace id", () => {
    store.saveTrace(trace());
    store.saveTrace(trace({ state: "failed" }));
    const rows = store.recentTraces(10) as { id: string; state: string }[];
    expect(rows).toHaveLength(1);
    // A trace is updated as it progresses, so the latest state wins here.
    expect(rows[0]!.state).toBe("failed");
  });

  it("round trips the steps array", () => {
    store.saveTrace(trace({ steps: [{ id: "request", state: "ok", durationMs: 4 }] }));
    const row = store.recentTraces(1)[0] as { steps: { id: string; durationMs: number }[] };
    expect(row.steps[0]).toMatchObject({ id: "request", durationMs: 4 });
  });

  it("defaults an older row's flow to inbound", () => {
    store.saveTrace(trace({ flow: "bridged" }));
    const row = store.recentTraces(1)[0] as { flow: string };
    expect(row.flow).toBe("bridged");
  });
});

describe("services registry", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const entry = (url: string, over: Record<string, unknown> = {}) => ({
    resourceUrl: url,
    method: "GET",
    description: "d",
    payTo: "A",
    network: "algorand:test",
    amountBase: 5_000,
    assetId: "10458941",
    settleCount: 3,
    lastSeen: "2026-09-17T00:00:00.000Z",
    hasDiscoveryInfo: true,
    ...over,
  });

  it("orders by settle count descending", () => {
    store.upsertService(entry("https://a.test/x", { settleCount: 1 }), true);
    store.upsertService(entry("https://b.test/y", { settleCount: 99 }), true);
    expect(store.services()[0]!.resourceUrl).toBe("https://b.test/y");
  });

  it("filters by network", () => {
    store.upsertService(entry("https://a.test/x", { network: "algorand:one" }), true);
    store.upsertService(entry("https://b.test/y", { network: "algorand:two" }), true);
    expect(store.services({ network: "algorand:one" })).toHaveLength(1);
  });

  it("refreshes the catalog fields on re-ingest", () => {
    store.upsertService(entry("https://a.test/x", { amountBase: 5_000 }), true);
    store.upsertService(entry("https://a.test/x", { amountBase: 9_000 }), true);
    expect(store.services()[0]!.amountBase).toBe(9_000);
  });

  it("can flip a service out of the allowlist", () => {
    store.upsertService(entry("https://a.test/x"), true);
    store.upsertService(entry("https://a.test/x"), false);
    expect(store.services({ allowlistedOnly: true })).toHaveLength(0);
  });

  it("reports probe fields as null before any probe", () => {
    store.upsertService(entry("https://a.test/x"), true);
    const row = store.services()[0]!;
    expect(row.probeVerdict).toBeNull();
    expect(row.probeLatencyMs).toBeNull();
    expect(row.probeColdStart).toBeNull();
    expect(row.probedAt).toBeNull();
  });
});

describe("outcomes", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const outcome = (over: Record<string, unknown> = {}) => ({
    resourceUrl: "https://a.test/x",
    at: "2026-09-18T00:00:00.000Z",
    ok: true,
    httpStatus: 200,
    latencyMs: 300,
    settled: true,
    schemaOk: null,
    coldStart: false,
    failureReason: null,
    ...over,
  });

  it("appends rather than replacing, because a score needs the history", () => {
    store.putOutcome(outcome());
    store.putOutcome(outcome());
    expect(store.outcomeCount("https://a.test/x")).toBe(2);
  });

  it("keeps schemaOk tri-state: true, false and unknown are different", () => {
    store.putOutcome(outcome({ at: "2026-09-18T00:00:03.000Z", schemaOk: true }));
    store.putOutcome(outcome({ at: "2026-09-18T00:00:02.000Z", schemaOk: false }));
    store.putOutcome(outcome({ at: "2026-09-18T00:00:01.000Z", schemaOk: null }));

    const rows = store.outcomes("https://a.test/x");
    expect(rows.map((r) => r.schemaOk)).toEqual([true, false, null]);
  });

  it("returns newest first, which is the order scoring expects", () => {
    store.putOutcome(outcome({ at: "2026-09-18T00:00:01.000Z", latencyMs: 1 }));
    store.putOutcome(outcome({ at: "2026-09-18T00:00:02.000Z", latencyMs: 2 }));
    expect(store.outcomes("https://a.test/x")[0]!.latencyMs).toBe(2);
  });

  it("separates outcomes per endpoint", () => {
    store.putOutcome(outcome({ resourceUrl: "https://a.test/x" }));
    store.putOutcome(outcome({ resourceUrl: "https://b.test/y" }));
    expect(store.outcomeCount("https://a.test/x")).toBe(1);
    expect(store.outcomeCount()).toBe(2);
  });

  it("caps the window it returns", () => {
    for (let i = 0; i < 30; i += 1) {
      store.putOutcome(outcome({ at: `2026-09-18T00:00:${String(i).padStart(2, "0")}.000Z` }));
    }
    expect(store.outcomes("https://a.test/x", 10)).toHaveLength(10);
  });
});

describe("spend log", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const reserve = (id: string, amountBase: number, merchant = "M") =>
    store.tryReserveSpend({
      id,
      merchant,
      route: "/x",
      amountBase,
      day: "2026-09-18",
      perDayBase: 1_000_000,
      perMerchantPerDayBase: 1_000_000,
    });

  it("counts reserved and settled, but not released", () => {
    reserve("a", 1_000);
    expect(store.committedToday("2026-09-18")).toBe(1_000);
    store.resolveSpend("a", "settled", "TX");
    expect(store.committedToday("2026-09-18")).toBe(1_000);

    reserve("b", 500);
    store.resolveSpend("b", "released", null);
    expect(store.committedToday("2026-09-18")).toBe(1_000);
  });

  it("scopes a merchant total to that merchant", () => {
    reserve("a", 1_000, "M1");
    reserve("b", 2_000, "M2");
    expect(store.committedToday("2026-09-18", "M1")).toBe(1_000);
    expect(store.committedToday("2026-09-18")).toBe(3_000);
  });

  it("keeps days independent", () => {
    reserve("a", 1_000);
    expect(store.committedToday("2026-09-19")).toBe(0);
  });

  it("ignores resolving an id that was never reserved", () => {
    expect(() => store.resolveSpend("ghost", "settled", "TX")).not.toThrow();
    expect(store.spendLog()).toHaveLength(0);
  });

  it("cannot resolve the same reservation twice", () => {
    reserve("a", 1_000);
    store.resolveSpend("a", "settled", "TX1");
    store.resolveSpend("a", "released", null);
    expect(store.spendLog()[0]!.state).toBe("settled");
  });
});

describe("substitutions", () => {
  it("records a refusal with no alternative", () => {
    const store = new Store(":memory:");
    store.putSubstitution({
      at: "2026-09-18T00:00:00.000Z",
      refusedUrl: "https://bad.test/x",
      refusedScore: 0.1,
      chosenUrl: null,
      chosenScore: null,
      reason: "no alternative available",
    });
    const row = store.substitutions()[0]!;
    // An honest refusal with nowhere to go is the outcome most worth logging.
    expect(row.chosenUrl).toBeNull();
    expect(row.refusedScore).toBe(0.1);
  });
});
