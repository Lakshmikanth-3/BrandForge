import { beforeEach, describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { loadConfig, TESTNET } from "@sentry402/shared";
import { Store } from "./db.js";
import { BudgetGuard } from "./budget.js";
import { TraceHub } from "./trace.js";
import { TrustEngine, type Outcome } from "./trust.js";
import { DownstreamPayer } from "./payer.js";
import type { CuratedService } from "./catalog.js";

/** A real keypair, so the payer's address check exercises real derivation. */
const account = algosdk.generateAccount();
const MNEMONIC = algosdk.secretKeyToMnemonic(account.sk);
const ADDRESS = account.addr.toString();

function configFor(over: Record<string, string> = {}) {
  return loadConfig({
    NETWORK: "testnet",
    PUBLIC_BASE_URL: "https://example.test",
    FACILITATOR_URL: "https://facilitator.goplausible.xyz",
    MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
    PAYER_ADDRESS: ADDRESS,
    PAYER_MNEMONIC: MNEMONIC,
    ...over,
  });
}

const service: CuratedService = {
  url: "https://downstream.test/metric/tvl",
  method: "GET",
  label: "folks_tvl",
  summary: "Total value locked in Folks Finance.",
};

describe("DownstreamPayer construction", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const build = (config = configFor()) =>
    new DownstreamPayer(
      config,
      store,
      new BudgetGuard(store),
      new TraceHub(store, "testnet"),
      new TrustEngine(store),
    );

  it("derives the payer address from the mnemonic", () => {
    expect(build().address).toBe(ADDRESS);
  });

  it("refuses to start when the mnemonic does not match PAYER_ADDRESS", () => {
    // Better to fail at startup than to discover it when a payment fails.
    const other = algosdk.generateAccount().addr.toString();
    expect(() => build(configFor({ PAYER_ADDRESS: other }))).toThrow(
      /does not derive PAYER_ADDRESS/,
    );
  });

  it("never exposes the mnemonic on the instance", () => {
    const payer = build();
    expect(JSON.stringify(payer)).not.toContain(MNEMONIC.split(" ")[0]!);
    expect(Object.keys(payer)).not.toContain("mnemonic");
  });
});

describe("DownstreamPayer.pay", () => {
  let store: Store;
  let guard: BudgetGuard;
  let hub: TraceHub;
  let trust: TrustEngine;

  beforeEach(() => {
    store = new Store(":memory:");
    guard = new BudgetGuard(store);
    hub = new TraceHub(store, "testnet");
    trust = new TrustEngine(store);
  });

  /**
   * Replaces both fetches so no real network call happens.
   *
   * `plainFetch` serves the pre-flight, which must quote a price before the paid
   * call is attempted. It defaults to quoting exactly the expected amount, so a
   * test only overrides it when the quote itself is what is under test.
   */
  function payerWith(impl: typeof fetch, plain?: typeof fetch) {
    const payer = new DownstreamPayer(configFor(), store, guard, hub, trust);
    Reflect.set(payer, "paidFetch", impl);
    Reflect.set(payer, "plainFetch", plain ?? quoting(5_000));
    return payer;
  }

  /** A pre-flight response quoting `amountBase`, shaped like a real 402. */
  function quoting(amountBase: number): typeof fetch {
    return (async () =>
      new Response(null, {
        status: 402,
        headers: {
          "payment-required": Buffer.from(
            JSON.stringify({
              accepts: [{ network: TESTNET.caip2, amount: String(amountBase) }],
            }),
          ).toString("base64"),
        },
      })) as unknown as typeof fetch;
  }

  const settlementHeader = (txId: string) =>
    Buffer.from(JSON.stringify({ success: true, transaction: txId })).toString("base64");

  const challengeHeader = (amount: string) =>
    Buffer.from(
      JSON.stringify({ accepts: [{ network: TESTNET.caip2, amount }] }),
    ).toString("base64");

  it("returns the downstream result and records an outbound receipt", async () => {
    const payer = payerWith(
      async () =>
        new Response(JSON.stringify({ tvl: 1234 }), {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXOUT1") },
        }),
    );

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({ tvl: 1234 });
    expect(outcome.txId).toBe("TXOUT1");

    const receipts = store.receipts({ direction: "out" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      txId: "TXOUT1",
      direction: "out",
      amountBase: 5_000,
      payer: ADDRESS,
      payee: service.url,
    });
  });

  it("does not count outbound spend as inbound volume", async () => {
    const payer = payerWith(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXOUT2") },
        }),
    );
    await payer.pay(service, 5_000, null);

    const stats = store.stats();
    expect(stats.outboundCount).toBe(1);
    expect(stats.settleCount).toBe(0);
    expect(stats.totalBase).toBe(0);
  });

  it("refuses before calling the downstream when the budget says no", async () => {
    let called = false;
    const payer = payerWith(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    // Default per-call cap is $0.25; ask for $1.00.
    const outcome = await payer.pay(service, 1_000_000, null);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/per_call/);
    expect(called).toBe(false);
  });

  it("refuses immediately when the kill switch is on", async () => {
    guard.halt();
    let called = false;
    const payer = payerWith(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/kill_switch/);
    expect(called).toBe(false);
  });

  it("marks the budget step as where it stopped", async () => {
    guard.halt();
    const payer = payerWith(async () => new Response("{}", { status: 200 }));
    await payer.pay(service, 5_000, null);

    const trace = hub.recent(1)[0]!;
    expect(trace.flow).toBe("bridged");
    expect(trace.state).toBe("failed");
    expect(trace.steps.find((s) => s.id === "budget")!.state).toBe("failed");
    expect(trace.steps.find((s) => s.id === "request")!.state).toBe("skipped");
  });

  it("releases the reservation when the downstream is unreachable", async () => {
    // Unreachable is now detected by the pre-flight, before any payment.
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const payer = payerWith(dead, dead);

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(false);
    // Nothing settled, so the headroom must come back.
    expect(guard.status().committedTodayBase).toBe(0);
    expect(store.receipts({ direction: "out" })).toHaveLength(0);
  });

  it("releases the reservation when the downstream takes payment but errors", async () => {
    const payer = payerWith(async () => new Response("boom", { status: 500 }));

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(false);
    expect(guard.status().committedTodayBase).toBe(0);
  });

  it("treats a standing 402 as a failed payment, not a success", async () => {
    // The wrapper could not satisfy the challenge — e.g. payer underfunded.
    const payer = payerWith(
      async () =>
        new Response(null, {
          status: 402,
          headers: { "payment-required": challengeHeader("5000") },
        }),
    );

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(false);
    const trace = hub.recent(1)[0]!;
    expect(trace.steps.find((s) => s.id === "payment")!.state).toBe("failed");
    expect(guard.status().committedTodayBase).toBe(0);
  });

  it("keeps the spend committed once a payment settles", async () => {
    const payer = payerWith(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXOUT3") },
        }),
    );
    await payer.pay(service, 5_000, null);
    expect(guard.status().committedTodayBase).toBe(5_000);
  });

  it("marks trust as skipped while a service is unrated", async () => {
    // Unrated is not a refusal, but the UI must not show a score that does not exist.
    const payer = payerWith(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXOUT4") },
        }),
    );
    await payer.pay(service, 5_000, null);

    const step = hub.recent(1)[0]!.steps.find((s) => s.id === "trust")!;
    expect(step.state).toBe("skipped");
    expect(step.detail).toMatch(/unrated/);
  });

  it("returns a non-JSON body as text rather than failing", async () => {
    const payer = payerWith(
      async () =>
        new Response("plain text answer", {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXOUT5") },
        }),
    );

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe("plain text answer");
  });

  it("settles without a tx id but records nothing it cannot key on", async () => {
    const payer = payerWith(async () => new Response("{}", { status: 200 }));

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(true);
    expect(outcome.txId).toBeNull();
    // No tx id means no receipt to key; the listener reconciles from chain.
    expect(store.receipts({ direction: "out" })).toHaveLength(0);
    expect(hub.recent(1)[0]!.steps.find((s) => s.id === "confirm")!.state).toBe("skipped");
  });

  it("does not double-spend when the same service is called in parallel", async () => {
    let calls = 0;
    const payer = payerWith(async () => {
      calls += 1;
      return new Response("{}", {
        status: 200,
        headers: { "x-payment-response": settlementHeader(`TXP${calls}`) },
      });
    });

    // Default per-merchant daily cap is $0.50; ten calls at $0.10 exceed it.
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => payer.pay(service, 100_000, null)),
    );
    const paid = outcomes.filter((o) => o.ok);
    expect(paid.length).toBeLessThanOrEqual(5);
    expect(guard.status().committedTodayBase).toBeLessThanOrEqual(500_000);
  });
});

describe("trust gate enforcement at the payment layer", () => {
  let store: Store;
  let guard: BudgetGuard;
  let hub: TraceHub;
  let trust: TrustEngine;

  beforeEach(() => {
    store = new Store(":memory:");
    guard = new BudgetGuard(store);
    hub = new TraceHub(store, "testnet");
    trust = new TrustEngine(store);
  });

  function payerWith(impl: typeof fetch) {
    const payer = new DownstreamPayer(configFor(), store, guard, hub, trust);
    Reflect.set(payer, "paidFetch", impl);
    Reflect.set(
      payer,
      "plainFetch",
      (async () =>
        new Response(null, {
          status: 402,
          headers: {
            "payment-required": Buffer.from(
              JSON.stringify({ accepts: [{ network: TESTNET.caip2, amount: "5000" }] }),
            ).toString("base64"),
          },
        })) as unknown as typeof fetch,
    );
    return payer;
  }

  const settlementHeader = (txId: string) =>
    Buffer.from(JSON.stringify({ success: true, transaction: txId })).toString("base64");

  /** Poisons a service's record so the gate refuses it. */
  const poison = (url: string, n = 20) => {
    for (let i = 0; i < n; i += 1) {
      const o: Outcome = {
        resourceUrl: url,
        at: new Date(Date.now() - i * 1000).toISOString(),
        ok: false,
        httpStatus: 200,
        latencyMs: 300,
        settled: true,
        schemaOk: null,
        coldStart: false,
        failureReason: "took payment, returned nothing",
      };
      trust.record(o);
    }
  };

  it("blocks the payment before any network call", async () => {
    // Asserted at the payment layer, not the UI: a gate that only colours a badge
    // is not a gate.
    poison(service.url);
    let called = false;
    const payer = payerWith(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(false);
    expect(outcome.refusedByTrust).toBe(true);
    expect(called).toBe(false);
  });

  it("reserves no budget when trust refuses", async () => {
    poison(service.url);
    const payer = payerWith(async () => new Response("{}", { status: 200 }));
    await payer.pay(service, 5_000, null);
    expect(guard.status().committedTodayBase).toBe(0);
  });

  it("marks trust as the step where it stopped", async () => {
    poison(service.url);
    const payer = payerWith(async () => new Response("{}", { status: 200 }));
    await payer.pay(service, 5_000, null);

    const trace = hub.recent(1)[0]!;
    expect(trace.state).toBe("failed");
    expect(trace.steps.find((s) => s.id === "trust")!.state).toBe("failed");
    expect(trace.steps.find((s) => s.id === "budget")!.state).toBe("skipped");
    expect(trace.steps.find((s) => s.id === "request")!.state).toBe("skipped");
  });

  it("records an outcome for every completed call, so the score is built from real traffic", async () => {
    const payer = payerWith(
      async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXG1") },
        }),
    );
    await payer.pay(service, 5_000, null);
    expect(store.outcomeCount(service.url)).toBe(1);
    expect(store.outcomes(service.url)[0]!.ok).toBe(true);
  });

  it("records a failure when the downstream is unreachable", async () => {
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const payer = payerWith(dead);
    Reflect.set(payer, "plainFetch", dead);
    await payer.pay(service, 5_000, null);

    const recorded = store.outcomes(service.url)[0]!;
    expect(recorded.ok).toBe(false);
    // No money moved, so this must not be scored as paid-for-nothing.
    expect(recorded.settled).toBe(false);
  });

  it("treats a paid empty body as a delivery failure, not a success", async () => {
    // The operator paid and the agent got nothing usable.
    const payer = payerWith(
      async () =>
        new Response("   ", {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXG2") },
        }),
    );

    const outcome = await payer.pay(service, 5_000, null);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/empty body/);

    const recorded = store.outcomes(service.url)[0]!;
    expect(recorded.ok).toBe(false);
    expect(recorded.settled).toBe(true);

    const trace = hub.recent(1)[0]!;
    expect(trace.steps.find((s) => s.id === "deliver")!.state).toBe("failed");
  });

  it("degrades a service to refused after enough paid-nothing calls", async () => {
    // End to end: real outcomes accumulate and eventually close the gate.
    const payer = payerWith(
      async () =>
        new Response("", {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXG3") },
        }),
    );

    for (let i = 0; i < 6; i += 1) await payer.pay(service, 5_000, null);

    expect(trust.recordFor(service.url).verdict).toBe("refuse");
    const blocked = await payer.pay(service, 5_000, null);
    expect(blocked.refusedByTrust).toBe(true);
  });
});
