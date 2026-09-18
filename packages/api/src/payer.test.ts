import { beforeEach, describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { loadConfig, TESTNET } from "@sentry402/shared";
import { Store } from "./db.js";
import { BudgetGuard } from "./budget.js";
import { TraceHub } from "./trace.js";
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

  beforeEach(() => {
    store = new Store(":memory:");
    guard = new BudgetGuard(store);
    hub = new TraceHub(store, "testnet");
  });

  /** Replaces the payment-wrapped fetch so no real payment is attempted. */
  function payerWith(impl: typeof fetch) {
    const payer = new DownstreamPayer(configFor(), store, guard, hub);
    Reflect.set(payer, "paidFetch", impl);
    return payer;
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
    const payer = payerWith(async () => {
      throw new Error("ECONNREFUSED");
    });

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

  it("records trust as skipped rather than inventing a score", async () => {
    // Phase 4 supplies the real score. Until then the UI must not show one.
    const payer = payerWith(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "x-payment-response": settlementHeader("TXOUT4") },
        }),
    );
    await payer.pay(service, 5_000, null);

    const trust = hub.recent(1)[0]!.steps.find((s) => s.id === "trust")!;
    expect(trust.state).toBe("skipped");
    expect(trust.detail).toMatch(/Phase 4/);
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
