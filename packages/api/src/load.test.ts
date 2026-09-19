import { beforeEach, describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { loadConfig } from "@sentry402/shared";
import { createApp, type AppParts } from "./app.js";
import { Store } from "./db.js";
import { BudgetGuard } from "./budget.js";
import { TraceHub } from "./trace.js";
import { TrustEngine } from "./trust.js";
import { DownstreamPayer } from "./payer.js";
import { RateLimiter } from "./trustcache.js";
import type { CuratedService } from "./catalog.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Load and concurrency (PRD §19, "before cutover").
 *
 * Not throughput benchmarking — the questions here are the ones that only go wrong
 * under contention and then go wrong with money. Can two callers reserve the same
 * headroom. Can parallel writes duplicate a receipt. Does a trace get another trace's
 * steps. Does anything leak between simultaneous requests.
 *
 * Every assertion is about correctness under parallelism, not speed, so these stay
 * meaningful on a slow machine.
 */

const account = algosdk.generateAccount();

const env = {
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: account.addr.toString(),
  PAYER_MNEMONIC: algosdk.secretKeyToMnemonic(account.sk),
} satisfies NodeJS.ProcessEnv;

const config = loadConfig(env);

describe("concurrent inbound requests", () => {
  let parts: AppParts;

  beforeEach(() => {
    parts = createApp(config, ":memory:");
  });

  it("answers 50 simultaneous unpaid requests with 50 correct 402s", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => parts.app.request("/v1/orchestrate", { method: "POST" })),
    );

    expect(results).toHaveLength(50);
    for (const res of results) {
      expect(res.status).toBe(402);
      expect(res.headers.get("payment-required")).toBeTruthy();
    }
  });

  it("gives every concurrent request its own trace, with no shared steps", async () => {
    await Promise.all(
      Array.from({ length: 25 }, () => parts.app.request("/v1/orchestrate", { method: "POST" })),
    );

    const traces = parts.hub.recent(25);
    const ids = new Set(traces.map((t) => t.id));
    // No two requests may share a trace id, and none may be missing steps.
    expect(ids.size).toBe(traces.length);
    for (const trace of traces) {
      expect(trace.steps.length).toBe(6);
      expect(trace.steps.filter((s) => s.id === "request")).toHaveLength(1);
    }
  });

  it("writes no receipts under a burst of unpaid requests", async () => {
    await Promise.all(
      Array.from({ length: 40 }, () => parts.app.request("/v1/orchestrate", { method: "POST" })),
    );
    expect(parts.store.stats().settleCount).toBe(0);
  });

  it("keeps the challenge identical across concurrent callers", async () => {
    // A per-request race in building the challenge would show up as differing terms.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => parts.app.request("/v1/orchestrate", { method: "POST" })),
    );

    const terms = results.map((res) => {
      const header = String(res.headers.get("payment-required"));
      const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
        accepts: { amount: string; asset: string; payTo: string; network: string }[];
      };
      const a = challenge.accepts[0]!;
      return `${a.amount}|${a.asset}|${a.payTo}|${a.network}`;
    });

    expect(new Set(terms).size).toBe(1);
  });

  it("serves mixed paid-route and read-API traffic without cross-contamination", async () => {
    const mixed = await Promise.all([
      ...Array.from({ length: 10 }, () => parts.app.request("/v1/orchestrate", { method: "POST" })),
      ...Array.from({ length: 10 }, () => parts.app.request("/api/stats")),
      ...Array.from({ length: 10 }, () => parts.app.request("/livez")),
    ]);

    const statuses = mixed.map((r) => r.status);
    expect(statuses.filter((s) => s === 402)).toHaveLength(10);
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
  });
});

describe("concurrent writes to the store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const receipt = (txId: string) => ({
    txId,
    direction: "in" as const,
    route: "/v1/orchestrate",
    payer: "P",
    payee: "M",
    amountBase: 50_000,
    assetId: "10458941",
    network: "testnet",
    confirmedRound: 1,
    settledAt: "2026-09-18T00:00:00.000Z",
    traceId: null,
    latencyMs: null,
  });

  it("inserts the same transaction id exactly once under parallel writes", async () => {
    // The listener polls while the request path writes; both can see one settlement.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve(store.putReceipt(receipt("SAME")))),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(store.stats().settleCount).toBe(1);
  });

  it("keeps the total exact across many parallel distinct writes", async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        Promise.resolve(store.putReceipt(receipt(`TX${i}`))),
      ),
    );

    const stats = store.stats();
    expect(stats.settleCount).toBe(100);
    // 100 × 50_000 with no drift, because money is held as integers.
    expect(stats.totalBase).toBe(5_000_000);
  });

  it("records one inflow per transaction id under parallel writes", async () => {
    await Promise.all(
      Array.from({ length: 15 }, () =>
        Promise.resolve(
          store.putInflow({
            txId: "REFUND",
            fromAddress: "S",
            amountBase: 55_000,
            assetId: "10458941",
            network: "testnet",
            kind: "refund",
            confirmedRound: 1,
            receivedAt: "2026-09-18T00:00:00.000Z",
          }),
        ),
      ),
    );
    expect(store.inflows()).toHaveLength(1);
    expect(store.stats().refundBase).toBe(55_000);
  });
});

describe("the budget guard under contention", () => {
  let store: Store;
  let guard: BudgetGuard;

  beforeEach(() => {
    store = new Store(":memory:");
    guard = new BudgetGuard(store, {
      perCallBase: 100_000,
      perDayBase: 500_000,
      perMerchantPerDayBase: 200_000,
    });
  });

  it("admits exactly the number of calls the daily cap allows, and no more", async () => {
    // 20 callers at 100_000 against a 500_000 cap: exactly five may pass.
    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve(guard.reserve({ merchant: `M${i}`, route: "/x", amountBase: 100_000 })),
      ),
    );

    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
    expect(guard.status().committedTodayBase).toBe(500_000);
  });

  it("never commits beyond a merchant cap however many callers race", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve(guard.reserve({ merchant: "SAME", route: "/x", amountBase: 50_000 })),
      ),
    );

    expect(decisions.filter((d) => d.allowed)).toHaveLength(4); // 200_000 cap
    expect(store.committedToday(new Date().toISOString().slice(0, 10), "SAME")).toBe(200_000);
  });

  it("returns headroom correctly when many reservations are released at once", async () => {
    const decisions = Array.from({ length: 5 }, (_, i) =>
      guard.reserve({ merchant: `M${i}`, route: "/x", amountBase: 100_000 }),
    );
    expect(guard.status().committedTodayBase).toBe(500_000);

    await Promise.all(
      decisions.map((d) => Promise.resolve(d.allowed && guard.release(d.reservationId))),
    );
    expect(guard.status().committedTodayBase).toBe(0);
  });

  it("halts mid-burst, and nothing after the halt is admitted", async () => {
    const first = guard.reserve({ merchant: "M", route: "/x", amountBase: 10_000 });
    expect(first.allowed).toBe(true);

    guard.halt();

    const after = await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve(guard.reserve({ merchant: "M", route: "/x", amountBase: 10_000 })),
      ),
    );
    expect(after.filter((d) => d.allowed)).toHaveLength(0);
  });
});

describe("the payer under contention", () => {
  let store: Store;
  let guard: BudgetGuard;
  let hub: TraceHub;
  let trust: TrustEngine;

  const service: CuratedService = {
    url: "https://downstream.test/x",
    method: "GET",
    label: "load_target",
    summary: "A target for the load suite.",
  };

  beforeEach(() => {
    store = new Store(":memory:");
    guard = new BudgetGuard(store);
    hub = new TraceHub(store, "testnet");
    trust = new TrustEngine(store);
  });

  function payerWith(settleTxId: (n: number) => string | null) {
    const payer = new DownstreamPayer(config, store, guard, hub, trust);
    let n = 0;
    const quote = (async () =>
      new Response(null, {
        status: 402,
        headers: {
          "payment-required": Buffer.from(
            JSON.stringify({
              accepts: [{ network: config.network.caip2, amount: "5000" }],
            }),
          ).toString("base64"),
        },
      })) as unknown as typeof fetch;

    Reflect.set(payer, "plainFetch", quote);
    Reflect.set(payer, "paidFetch", (async () => {
      n += 1;
      const txId = settleTxId(n);
      return new Response(JSON.stringify({ n }), {
        status: 200,
        headers: txId
          ? {
              "x-payment-response": Buffer.from(
                JSON.stringify({ success: true, transaction: txId }),
              ).toString("base64"),
            }
          : {},
      });
    }) as unknown as typeof fetch);
    return payer;
  }

  it("produces one receipt per settlement across 20 parallel calls", async () => {
    const payer = payerWith((n) => `TXLOAD${n}`);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => payer.pay(service, 5_000, null)),
    );

    const paid = outcomes.filter((o) => o.ok);
    expect(paid.length).toBeGreaterThan(0);
    // Every settled call has exactly one receipt; none is duplicated or lost.
    expect(store.receipts({ direction: "out" }).length).toBe(paid.length);
    expect(new Set(paid.map((o) => o.txId)).size).toBe(paid.length);
  });

  it("gives every parallel call its own bridged trace", async () => {
    const payer = payerWith((n) => `TXTRACE${n}`);
    await Promise.all(Array.from({ length: 15 }, () => payer.pay(service, 5_000, null)));

    const traces = hub.recent(20).filter((t) => t.flow === "bridged");
    expect(new Set(traces.map((t) => t.id)).size).toBe(traces.length);
    for (const trace of traces) expect(trace.steps.length).toBe(9);
  });

  it("records one outcome per call, so the score is not inflated by concurrency", async () => {
    const payer = payerWith((n) => `TXOUT${n}`);
    await Promise.all(Array.from({ length: 12 }, () => payer.pay(service, 5_000, null)));
    expect(store.outcomeCount(service.url)).toBe(12);
  });

  it("does not let parallel calls exceed the per-merchant cap", async () => {
    // Default merchant cap is $0.50; 20 calls at $0.10 would be $2.00.
    const payer = payerWith((n) => `TXCAP${n}`);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => payer.pay(service, 100_000, null)),
    );

    expect(outcomes.filter((o) => o.ok).length).toBeLessThanOrEqual(5);
    expect(guard.status().committedTodayBase).toBeLessThanOrEqual(500_000);
  });

  it("keeps spend accounting exact when settlements return no transaction id", async () => {
    // No tx id means no receipt to key on, but the spend still committed.
    const payer = payerWith(() => null);
    await Promise.all(Array.from({ length: 10 }, () => payer.pay(service, 5_000, null)));

    expect(store.receipts({ direction: "out" })).toHaveLength(0);
    expect(guard.status().committedTodayBase).toBe(50_000);
  });
});

describe("the rate limiter under a burst", () => {
  it("admits exactly the limit and refuses the rest", () => {
    let now = 0;
    const limiter = new RateLimiter(10, 60_000, () => now);
    const results = Array.from({ length: 100 }, () => limiter.check("one-ip"));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("does not let one caller's burst exhaust another's allowance", () => {
    let now = 0;
    const limiter = new RateLimiter(5, 60_000, () => now);
    Array.from({ length: 50 }, () => limiter.check("noisy"));
    expect(limiter.check("quiet").allowed).toBe(true);
  });

  it("stays bounded when every request comes from a different caller", () => {
    let now = 0;
    const limiter = new RateLimiter(5, 60_000, () => now);
    for (let i = 0; i < 500; i += 1) expect(limiter.check(`ip-${i}`).allowed).toBe(true);
  });
});

describe("the trace hub under many traces", () => {
  it("bounds the ring rather than growing without limit", () => {
    const store = new Store(":memory:");
    const hub = new TraceHub(store, "testnet", 10);
    for (let i = 0; i < 200; i += 1) {
      const trace = hub.start("/v1/orchestrate");
      hub.complete(trace.id);
    }
    expect(hub.recent(500).length).toBeLessThanOrEqual(10);
  });

  it("does not mix steps between interleaved traces", () => {
    const store = new Store(":memory:");
    const hub = new TraceHub(store, "testnet");

    const a = hub.start("/v1/orchestrate");
    const b = hub.start("/v1/orchestrate");
    hub.begin(a.id, "request");
    hub.begin(b.id, "challenge");
    hub.end(a.id, "request", "ok", "for a");
    hub.end(b.id, "challenge", "failed", "for b");

    const traceA = hub.recent(5).find((t) => t.id === a.id)!;
    const traceB = hub.recent(5).find((t) => t.id === b.id)!;
    expect(traceA.steps.find((s) => s.id === "request")!.detail).toBe("for a");
    expect(traceB.steps.find((s) => s.id === "challenge")!.detail).toBe("for b");
    expect(traceA.steps.find((s) => s.id === "challenge")!.state).toBe("pending");
  });

  it("emits one event per state change, not one per listener", () => {
    const store = new Store(":memory:");
    const hub = new TraceHub(store, "testnet");
    const seen: string[][] = [[], [], []];
    seen.forEach((bucket, i) => hub.on("trace", (t) => seen[i]!.push(t.id)));

    const trace = hub.start("/v1/orchestrate");
    hub.complete(trace.id);

    // Every listener sees the same sequence: no listener starves another.
    expect(seen[0]!.length).toBe(seen[1]!.length);
    expect(seen[1]!.length).toBe(seen[2]!.length);
  });
});

describe("real concurrency: separate processes, one database", () => {
  // The tests above use Promise.all, which in single-threaded JavaScript serialises the
  // synchronous store calls — they would pass even if the guard were advisory. In
  // production the API server, the prober and the MCP server all open the same SQLite
  // file at once, so this spawns genuine parallel processes to show BEGIN IMMEDIATE
  // actually holds.
  it("admits exactly the cap when 12 processes race for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sentry402-race-"));
    const dbPath = join(dir, "race.sqlite");

    // Seed the schema and the caps every worker will read.
    const seed = new Store(dbPath);
    seed.setSetting("test_per_call", "100000");
    seed.setSetting("test_per_day", "500000"); // exactly five calls of 100_000
    seed.setSetting("test_per_merchant", "500000");
    seed.close();

    const worker = join(process.cwd(), "scripts", "reserve-worker.ts");
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        (_, i) =>
          new Promise<{ code: number | null; out: string }>((resolve) => {
            const child = spawn(
              process.platform === "win32" ? "npx.cmd" : "npx",
              ["tsx", worker, dbPath, `M${i}`, "100000"],
              { cwd: process.cwd(), shell: process.platform === "win32" },
            );
            let out = "";
            child.stdout.on("data", (d: Buffer) => (out += d.toString()));
            child.on("close", (code) => resolve({ code, out: out.trim() }));
          }),
      ),
    );

    // The database is the authority, not stdout: a child's output can be lost to
    // process plumbing, but what it committed cannot.
    const after = new Store(dbPath);
    const committed = after.committedToday(new Date().toISOString().slice(0, 10));
    const admitted = after.spendLog(100).length;
    after.close();

    // The property under test: the cap is never exceeded, whoever wins the race.
    expect(committed).toBeLessThanOrEqual(500_000);
    expect(committed).toBe(500_000);
    expect(admitted).toBe(5);

    // And no writer may die on a locked database. Before PRAGMA busy_timeout, one
    // process in twelve exited non-zero with "database is locked" -- in production that
    // is a reservation throwing and taking a payment attempt down with it.
    const crashed = results.filter((r) => r.code !== 0);
    expect(crashed, `workers crashed: ${JSON.stringify(crashed)}`).toHaveLength(0);
  }, 180_000);
});
