import { beforeEach, describe, expect, it } from "vitest";
import { TESTNET } from "@sentry402/shared";
import { Store } from "./db.js";
import { Reconciler, receiptsAsCsv, type ChainTransfer } from "./reconcile.js";
import { SettlementListener } from "./listener.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const MERCHANT = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const PAYER = "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4";
const STRANGER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** An indexer response containing the given transfers. */
function indexerReturning(perAddress: Record<string, ChainTransfer[]>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const address = Object.keys(perAddress).find((a) => url.includes(a));
    const transfers = address ? (perAddress[address] ?? []) : [];
    return new Response(
      JSON.stringify({
        transactions: transfers.map((t) => ({
          id: t.txId,
          sender: t.sender,
          "confirmed-round": t.confirmedRound,
          "round-time": t.roundTime,
          "asset-transfer-transaction": {
            "asset-id": Number(TESTNET.usdcAsaId),
            amount: t.amountBase,
            receiver: t.receiver,
          },
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const transfer = (over: Partial<ChainTransfer> = {}): ChainTransfer => ({
  txId: "TX1",
  sender: PAYER,
  receiver: MERCHANT,
  amountBase: 50_000,
  confirmedRound: 1_000,
  roundTime: 1_789_000_000,
  ...over,
});

describe("reconciliation", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const receipt = (over: Partial<Parameters<Store["putReceipt"]>[0]> = {}) => ({
    txId: "TX1",
    direction: "in" as const,
    route: "/v1/orchestrate",
    payer: PAYER,
    payee: MERCHANT,
    amountBase: 50_000,
    assetId: TESTNET.usdcAsaId,
    network: "testnet",
    confirmedRound: 1_000,
    settledAt: "2026-09-18T00:00:00.000Z",
    traceId: null,
    latencyMs: 900,
    ...over,
  });

  const reconciler = (fetchImpl: typeof fetch) =>
    new Reconciler(TESTNET, store, MERCHANT, PAYER, fetchImpl);

  it("reconciles an empty window cleanly, and says what it checked", async () => {
    // Meaningful before any traffic exists: nothing on chain, nothing in the books.
    const report = await reconciler(indexerReturning({})).run();
    expect(report.clean).toBe(true);
    expect(report.chainTransfers).toBe(0);
    expect(report.receipts).toBe(0);
    expect(report.matched).toBe(0);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.error).toBeNull();
  });

  it("matches a receipt to its on-chain transfer", async () => {
    store.putReceipt(receipt());
    const report = await reconciler(indexerReturning({ [MERCHANT]: [transfer()] })).run();
    expect(report.clean).toBe(true);
    expect(report.matched).toBe(1);
  });

  it("flags an on-chain transfer with no receipt", async () => {
    // Real money moved and our books do not know about it.
    const report = await reconciler(indexerReturning({ [MERCHANT]: [transfer()] })).run();
    expect(report.clean).toBe(false);
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      kind: "missing_receipt",
      txId: "TX1",
      chainAmountBase: 50_000,
      receiptAmountBase: null,
    });
  });

  it("flags a receipt with nothing behind it", async () => {
    // A phantom: a number on the dashboard no money backs.
    store.putReceipt(receipt({ txId: "GHOST" }));
    const report = await reconciler(indexerReturning({})).run();
    expect(report.clean).toBe(false);
    expect(report.discrepancies[0]).toMatchObject({
      kind: "phantom_receipt",
      txId: "GHOST",
      chainAmountBase: null,
    });
  });

  it("flags an amount that does not agree with the chain", async () => {
    store.putReceipt(receipt({ amountBase: 20_000 }));
    const report = await reconciler(indexerReturning({ [MERCHANT]: [transfer()] })).run();
    expect(report.discrepancies[0]).toMatchObject({
      kind: "amount_mismatch",
      chainAmountBase: 50_000,
      receiptAmountBase: 20_000,
    });
    expect(report.matched).toBe(0);
  });

  it("flags a receipt recorded in the wrong direction", async () => {
    store.putReceipt(receipt({ direction: "out" }));
    const report = await reconciler(indexerReturning({ [MERCHANT]: [transfer()] })).run();
    expect(report.discrepancies[0]!.kind).toBe("direction_mismatch");
  });

  it("reconciles outbound payments from the payer address", async () => {
    store.putReceipt(
      receipt({
        txId: "TXOUT",
        direction: "out",
        payer: PAYER,
        payee: STRANGER,
        amountBase: 5_000,
      }),
    );
    const report = await reconciler(
      indexerReturning({
        [PAYER]: [
          transfer({ txId: "TXOUT", sender: PAYER, receiver: STRANGER, amountBase: 5_000 }),
        ],
      }),
    ).run();

    expect(report.clean).toBe(true);
    expect(report.matched).toBe(1);
  });

  it("ignores transfers where we are not a counterparty", async () => {
    // A transfer between two strangers is not our business, even if the query
    // happens to surface it.
    const report = await reconciler(
      indexerReturning({
        [MERCHANT]: [transfer({ txId: "OTHER", sender: STRANGER, receiver: STRANGER })],
      }),
    ).run();
    expect(report.chainTransfers).toBe(0);
    expect(report.clean).toBe(true);
  });

  it("does not report clean when the indexer is unreachable", async () => {
    // Reporting clean here would be the exact lie this suite exists to catch.
    const broken = (async () => {
      throw new Error("ENOTFOUND indexer");
    }) as unknown as typeof fetch;

    const report = await reconciler(broken).run();
    expect(report.clean).toBe(false);
    expect(report.error).toMatch(/ENOTFOUND/);
    expect(report.matched).toBe(0);
  });

  it("does not report clean when the indexer errors", async () => {
    const failing = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const report = await reconciler(failing).run();
    expect(report.clean).toBe(false);
    expect(report.error).toMatch(/503/);
  });

  it("does not call a receipt phantom when it predates the window", async () => {
    // Absence outside the queried range proves nothing about it.
    store.putReceipt(receipt({ txId: "OLD", confirmedRound: 10 }));
    const report = await reconciler(indexerReturning({})).run(1_000);
    expect(report.clean).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  it("finds discrepancies in both directions at once", async () => {
    store.putReceipt(receipt({ txId: "GHOST" }));
    const report = await reconciler(
      indexerReturning({ [MERCHANT]: [transfer({ txId: "ONCHAIN" })] }),
    ).run();

    const kinds = report.discrepancies.map((d) => d.kind).sort();
    expect(kinds).toEqual(["missing_receipt", "phantom_receipt"]);
    expect(report.clean).toBe(false);
  });

  it("counts every receipt it examined, matched or not", async () => {
    store.putReceipt(receipt({ txId: "A" }));
    store.putReceipt(receipt({ txId: "B" }));
    const report = await reconciler(
      indexerReturning({ [MERCHANT]: [transfer({ txId: "A" })] }),
    ).run();
    expect(report.receipts).toBe(2);
    expect(report.matched).toBe(1);
  });
});

describe("receipt export", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const base = {
    direction: "in" as const,
    route: "/v1/orchestrate",
    payer: PAYER,
    payee: MERCHANT,
    amountBase: 50_000,
    assetId: TESTNET.usdcAsaId,
    network: "testnet",
    confirmedRound: 1_000,
    settledAt: "2026-09-18T00:00:00.000Z",
    traceId: null,
    latencyMs: 900,
  };

  it("emits a header even with no rows", () => {
    const csv = receiptsAsCsv(store, TESTNET.explorerTxBase);
    expect(csv.split("\n")[0]).toContain("tx_id");
    expect(csv.trim().split("\n")).toHaveLength(1);
  });

  it("gives every line a transaction id and an explorer url", () => {
    store.putReceipt({ ...base, txId: "TXA" });
    const lines = receiptsAsCsv(store, TESTNET.explorerTxBase).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("TXA");
    expect(lines[1]).toContain(TESTNET.explorerTxBase + "TXA");
  });

  it("writes amounts from the integer base units, not a float", () => {
    store.putReceipt({ ...base, txId: "TXB", amountBase: 1 });
    const line = receiptsAsCsv(store, TESTNET.explorerTxBase).trim().split("\n")[1]!;
    expect(line).toContain("0.000001");
    expect(line).toContain(",1,");
  });

  it("escapes a field containing a comma or a quote", () => {
    store.putReceipt({ ...base, txId: "TXC", route: 'weird,"route"' });
    const csv = receiptsAsCsv(store, TESTNET.explorerTxBase);
    expect(csv).toContain('"weird,""route"""');
    // Still one row: the escaping must not introduce a line break.
    expect(csv.trim().split("\n")).toHaveLength(2);
  });

  it("exports one row per receipt with no phantom rows", () => {
    for (const txId of ["A", "B", "C"]) store.putReceipt({ ...base, txId });
    const rows = receiptsAsCsv(store, TESTNET.explorerTxBase).trim().split("\n").slice(1);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.split(",")[0])).size).toBe(3);
  });
});

describe("schema migration", () => {
  it("adds a column missing from a database created by an older build", () => {
    // CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so it silently
    // skips new columns. This is not theoretical: adding traces.flow left deployed
    // databases without it, and the first real paid call failed to persist its
    // trace AFTER the payment had settled.
    const file = join(
      mkdtempSync(join(tmpdir(), "sentry402-migrate-")),
      "old.sqlite",
    );

    // Build the pre-flow schema by hand, the way the old release left it.
    const require_ = createRequire(import.meta.url);
    const { DatabaseSync } = require_("node:sqlite") as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE traces (
      id TEXT PRIMARY KEY, route TEXT NOT NULL, network TEXT NOT NULL,
      state TEXT NOT NULL, payer TEXT, tx_id TEXT, total_ms INTEGER,
      created_at TEXT NOT NULL, steps_json TEXT NOT NULL)`);
    raw.close();

    const store = new Store(file);
    expect(store.columnsOf("traces")).toContain("flow");

    // And it can actually be written to now.
    store.saveTrace({
      id: "T1",
      flow: "bridged",
      route: "folks_tvl",
      network: "testnet",
      state: "ok",
      payer: null,
      txId: null,
      totalMs: 10,
      createdAt: "2026-09-18T00:00:00.000Z",
      steps: [],
    });
    expect(store.recentTraces(1)).toHaveLength(1);
    store.close();
  });

  it("is idempotent across repeated opens", () => {
    const file = join(mkdtempSync(join(tmpdir(), "sentry402-migrate-")), "db.sqlite");
    new Store(file).close();
    const second = new Store(file);
    expect(second.columnsOf("traces").filter((c) => c === "flow")).toHaveLength(1);
    second.close();
  });
});

describe("settlement listener, both directions", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const txn = (over: Record<string, unknown> = {}) => ({
    id: "TXL1",
    sender: PAYER,
    "confirmed-round": 500,
    "round-time": 1_789_000_000,
    "asset-transfer-transaction": {
      "asset-id": Number(TESTNET.usdcAsaId),
      amount: 5_000,
      receiver: MERCHANT,
    },
    ...over,
  });

  const indexer = (byAddress: Record<string, unknown[]>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      const key = Object.keys(byAddress).find((a) => url.includes(a));
      return Response.json({ transactions: key ? byAddress[key] : [] });
    }) as unknown as typeof fetch;

  it("records an outbound payment the request path could not key a receipt for", async () => {
    // Exactly what happened on the first real bridged call: the downstream returned
    // no transaction id, so only the chain knows about the payment.
    const listener = new SettlementListener(
      TESTNET,
      store,
      MERCHANT,
      "/v1/orchestrate",
      PAYER,
      indexer({
        [PAYER]: [
          txn({ id: "TXOUT", sender: PAYER, "asset-transfer-transaction": {
            "asset-id": Number(TESTNET.usdcAsaId), amount: 5_000, receiver: STRANGER } }),
        ],
      }),
    );

    const result = await listener.poll();
    expect(result.written).toBe(1);

    const receipts = store.receipts({ direction: "out" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      txId: "TXOUT",
      direction: "out",
      payer: PAYER,
      payee: STRANGER,
      amountBase: 5_000,
    });
    expect(receipts[0]!.confirmedRound).toBe(500);
  });

  it("records inbound payments to the merchant", async () => {
    const listener = new SettlementListener(
      TESTNET,
      store,
      MERCHANT,
      "/v1/orchestrate",
      PAYER,
      indexer({ [MERCHANT]: [txn({ id: "TXIN", sender: STRANGER })] }),
    );
    await listener.poll();
    expect(store.receipts({ direction: "in" })).toHaveLength(1);
  });

  it("does not double-count a self-payment as both directions", async () => {
    // The same transaction appears in both accounts' histories.
    const self = txn({ id: "TXSELF", sender: PAYER });
    const listener = new SettlementListener(
      TESTNET,
      store,
      MERCHANT,
      "/v1/orchestrate",
      PAYER,
      indexer({ [MERCHANT]: [self], [PAYER]: [self] }),
    );
    await listener.poll();
    const all = store.receipts({ limit: 10 });
    expect(all).toHaveLength(1);
    // Paying ourselves is money received.
    expect(all[0]!.direction).toBe("in");
  });

  it("is idempotent across repeated polls", async () => {
    const listener = new SettlementListener(
      TESTNET,
      store,
      MERCHANT,
      "/v1/orchestrate",
      PAYER,
      indexer({ [MERCHANT]: [txn({ id: "TXIN", sender: STRANGER })] }),
    );
    await listener.poll();
    const second = await listener.poll();
    expect(second.written).toBe(0);
    expect(store.receipts({ limit: 10 })).toHaveLength(1);
  });

  it("surfaces an outbound indexer failure instead of reporting success", async () => {
    const listener = new SettlementListener(
      TESTNET,
      store,
      MERCHANT,
      "/v1/orchestrate",
      PAYER,
      (async (input: string | URL | Request) => {
        if (String(input).includes(PAYER)) return new Response("no", { status: 503 });
        return Response.json({ transactions: [] });
      }) as unknown as typeof fetch,
    );
    const result = await listener.poll();
    expect(result.error).toMatch(/503/);
  });
});

describe("money that comes back", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  const paid = (txId: string, payee: string, amountBase = 60_000) =>
    store.putReceipt({
      txId,
      direction: "out",
      route: "pr_review",
      payer: PAYER,
      payee,
      amountBase,
      assetId: TESTNET.usdcAsaId,
      network: "testnet",
      confirmedRound: 500,
      settledAt: "2026-09-18T00:00:00.000Z",
      traceId: null,
      latencyMs: null,
    });

  const txn = (over: Record<string, unknown> = {}) => ({
    id: "TXIN1",
    sender: STRANGER,
    "confirmed-round": 600,
    "round-time": 1_789_000_000,
    "asset-transfer-transaction": {
      "asset-id": Number(TESTNET.usdcAsaId),
      amount: 55_000,
      receiver: PAYER,
    },
    ...over,
  });

  const indexer = (byAddress: Record<string, unknown[]>): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      const key = Object.keys(byAddress).find((a) => url.includes(a));
      return Response.json({ transactions: key ? byAddress[key] : [] });
    }) as unknown as typeof fetch;

  const listener = (fetchImpl: typeof fetch) =>
    new SettlementListener(TESTNET, store, MERCHANT, "/v1/orchestrate", PAYER, fetchImpl);

  it("classifies money from a service we paid as a refund", async () => {
    // Observed live: a service takes 0.06, does the work, and returns 0.055 of it.
    paid("TXOUT1", STRANGER);
    await listener(indexer({ [PAYER]: [txn()] })).poll();

    const rows = store.inflows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "refund", amountBase: 55_000, fromAddress: STRANGER });
  });

  it("classifies money from a stranger as funding, not a refund", async () => {
    // A faucet top-up does not reduce what a call cost.
    await listener(indexer({ [PAYER]: [txn({ sender: "FAUCETADDRESS" })] })).poll();
    expect(store.inflows()[0]!.kind).toBe("funding");
  });

  it("subtracts refunds from spend but not funding", async () => {
    paid("TXOUT1", STRANGER, 60_000);
    await listener(
      indexer({
        [PAYER]: [
          txn({ id: "REFUND", sender: STRANGER }),
          txn({ id: "TOPUP", sender: "FAUCETADDRESS", "asset-transfer-transaction": {
            "asset-id": Number(TESTNET.usdcAsaId), amount: 20_000_000, receiver: PAYER } }),
        ],
      }),
    ).poll();

    const stats = store.stats();
    expect(stats.outboundBase).toBe(60_000);
    expect(stats.refundBase).toBe(55_000);
    // What the call actually cost, which is the number that matters.
    expect(stats.netOutboundBase).toBe(5_000);
  });

  it("is idempotent, so repeated polls do not double-count a refund", async () => {
    paid("TXOUT1", STRANGER);
    const l = listener(indexer({ [PAYER]: [txn()] }));
    await l.poll();
    await l.poll();
    expect(store.inflows()).toHaveLength(1);
    expect(store.stats().refundBase).toBe(55_000);
  });

  it("does not treat our own spending as an inflow", async () => {
    await listener(
      indexer({
        [PAYER]: [
          txn({ id: "OURS", sender: PAYER, "asset-transfer-transaction": {
            "asset-id": Number(TESTNET.usdcAsaId), amount: 5_000, receiver: STRANGER } }),
        ],
      }),
    ).poll();
    expect(store.inflows()).toHaveLength(0);
  });

  it("flags an on-chain inflow that has no record", async () => {
    // This is the case the suite used to miss entirely, while reporting clean.
    const report = await new Reconciler(
      TESTNET,
      store,
      MERCHANT,
      PAYER,
      indexerReturning({
        [PAYER]: [
          transfer({ txId: "UNRECORDED", sender: STRANGER, receiver: PAYER, amountBase: 55_000 }),
        ],
      }),
    ).run();

    expect(report.clean).toBe(false);
    expect(report.discrepancies[0]).toMatchObject({
      kind: "missing_receipt",
      txId: "UNRECORDED",
    });
    expect(report.discrepancies[0]!.detail).toMatch(/inflow/);
  });

  it("matches a recorded inflow against the chain", async () => {
    store.putInflow({
      txId: "REFUND1",
      fromAddress: STRANGER,
      amountBase: 55_000,
      assetId: TESTNET.usdcAsaId,
      network: "testnet",
      kind: "refund",
      confirmedRound: 600,
      receivedAt: "2026-09-18T00:00:00.000Z",
    });

    const report = await new Reconciler(
      TESTNET,
      store,
      MERCHANT,
      PAYER,
      indexerReturning({
        [PAYER]: [
          transfer({ txId: "REFUND1", sender: STRANGER, receiver: PAYER, amountBase: 55_000 }),
        ],
      }),
    ).run();

    expect(report.clean).toBe(true);
    expect(report.matched).toBe(1);
  });

  it("flags an inflow recorded for the wrong amount", async () => {
    store.putInflow({
      txId: "REFUND1",
      fromAddress: STRANGER,
      amountBase: 1,
      assetId: TESTNET.usdcAsaId,
      network: "testnet",
      kind: "refund",
      confirmedRound: 600,
      receivedAt: "2026-09-18T00:00:00.000Z",
    });

    const report = await new Reconciler(
      TESTNET,
      store,
      MERCHANT,
      PAYER,
      indexerReturning({
        [PAYER]: [
          transfer({ txId: "REFUND1", sender: STRANGER, receiver: PAYER, amountBase: 55_000 }),
        ],
      }),
    ).run();

    expect(report.discrepancies[0]!.kind).toBe("amount_mismatch");
  });
});

describe("listener pagination", () => {
  // The listener used to read only the first page of 100 transfers, which silently
  // truncated history. On a host whose database is rebuilt from the chain on every
  // restart, that is not an edge case: it is the whole recovery path.
  const pageOf = (start: number, count: number, next?: string) => ({
    transactions: Array.from({ length: count }, (_, i) => ({
      id: `TXP${start + i}`,
      sender: STRANGER,
      "confirmed-round": 1_000 + start + i,
      "round-time": 1_789_000_000,
      "asset-transfer-transaction": {
        "asset-id": Number(TESTNET.usdcAsaId),
        amount: 1_000,
        receiver: MERCHANT,
      },
    })),
    ...(next ? { "next-token": next } : {}),
  });

  it("follows next-token and records every page", async () => {
    const store = new Store(":memory:");
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      seen.push(url.searchParams.get("next") ?? "(first)");
      const next = url.searchParams.get("next");
      if (!next) return Response.json(pageOf(0, 100, "P2"));
      if (next === "P2") return Response.json(pageOf(100, 100, "P3"));
      return Response.json(pageOf(200, 37));
    }) as unknown as typeof fetch;

    const listener = new SettlementListener(TESTNET, store, MERCHANT, "/v1/orchestrate", null, fetchImpl);
    const result = await listener.poll();

    expect(seen).toEqual(["(first)", "P2", "P3"]);
    expect(result.written).toBe(237);
    expect(store.stats().settleCount).toBe(237);
  });

  it("stops on an empty page even if a token is still offered", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json(calls === 1 ? pageOf(0, 5, "MORE") : { transactions: [], "next-token": "MORE" });
    }) as unknown as typeof fetch;

    await new SettlementListener(TESTNET, store, MERCHANT, "/v1/orchestrate", null, fetchImpl).poll();
    expect(calls).toBe(2);
    expect(store.stats().settleCount).toBe(5);
  });

  it("is bounded, so a token that never ends cannot loop forever", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json(pageOf(calls * 10, 3, "FOREVER"));
    }) as unknown as typeof fetch;

    await new SettlementListener(TESTNET, store, MERCHANT, "/v1/orchestrate", null, fetchImpl).poll();
    expect(calls).toBeLessThanOrEqual(50);
  });

  it("reports a failure on a later page instead of pretending it read everything", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return Response.json(pageOf(0, 10, "P2"));
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    const result = await new SettlementListener(TESTNET, store, MERCHANT, "/v1/orchestrate", null, fetchImpl).poll();
    expect(result.error).toMatch(/503/);
  });
});
