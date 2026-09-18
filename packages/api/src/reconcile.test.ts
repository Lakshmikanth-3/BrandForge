import { beforeEach, describe, expect, it } from "vitest";
import { TESTNET } from "@sentry402/shared";
import { Store } from "./db.js";
import { Reconciler, receiptsAsCsv, type ChainTransfer } from "./reconcile.js";

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
