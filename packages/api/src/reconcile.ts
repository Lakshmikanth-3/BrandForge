/**
 * Reconciliation — the most important test in the project (PRD §19).
 *
 * Our receipts must match the chain, in both directions:
 *
 *  - Every receipt has a confirmed on-chain transaction. A receipt without one is
 *    a phantom: a number on the dashboard that no money backs.
 *  - Every on-chain USDC transfer touching our addresses has a receipt. One
 *    without is a miss: real money moved and our books do not know.
 *
 * Either failure invalidates every figure the frontend shows, which is why this
 * runs as a gate rather than a diagnostic. It is deliberately built to be
 * meaningful on an empty window too: zero receipts and zero transactions
 * reconcile cleanly, and the report says so rather than claiming success vacuously.
 *
 * The indexer is the authority here, never the store. Comparing the store against
 * itself would prove nothing.
 */
import type { NetworkConfig } from "@sentry402/shared";
import type { Direction, Store } from "./db.js";

export interface ChainTransfer {
  txId: string;
  sender: string;
  receiver: string;
  amountBase: number;
  confirmedRound: number;
  roundTime: number;
}

export type DiscrepancyKind =
  | "missing_receipt"
  | "phantom_receipt"
  | "amount_mismatch"
  | "direction_mismatch";

export interface Discrepancy {
  kind: DiscrepancyKind;
  txId: string;
  detail: string;
  chainAmountBase: number | null;
  receiptAmountBase: number | null;
}

export interface ReconcileReport {
  network: string;
  checkedAt: string;
  /** Inclusive lower bound on rounds examined, null when unbounded. */
  fromRound: number | null;
  chainTransfers: number;
  receipts: number;
  matched: number;
  discrepancies: Discrepancy[];
  clean: boolean;
  /** Set when the indexer could not be reached; the report proves nothing then. */
  error: string | null;
}

interface IndexerTxn {
  id?: string;
  sender?: string;
  "confirmed-round"?: number;
  "round-time"?: number;
  "asset-transfer-transaction"?: {
    "asset-id"?: number;
    amount?: number;
    receiver?: string;
  };
}

export class Reconciler {
  constructor(
    private readonly net: NetworkConfig,
    private readonly store: Store,
    private readonly merchantAddress: string,
    private readonly payerAddress: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Every USDC transfer the indexer reports for one address. */
  private async transfersFor(
    address: string,
    fromRound: number | null,
  ): Promise<ChainTransfer[] | { error: string }> {
    const params = new URLSearchParams({
      "asset-id": this.net.usdcAsaId,
      "tx-type": "axfer",
      limit: "1000",
    });
    if (fromRound !== null) params.set("min-round", String(fromRound));

    const url = `${this.net.indexerUrl}/v2/accounts/${address}/transactions?${params.toString()}`;

    let body: { transactions?: IndexerTxn[] };
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { error: `indexer HTTP ${res.status} for ${address}` };
      body = (await res.json()) as typeof body;
    } catch (err) {
      return { error: err instanceof Error ? err.message : "indexer unreachable" };
    }

    const out: ChainTransfer[] = [];
    for (const txn of body.transactions ?? []) {
      const transfer = txn["asset-transfer-transaction"];
      if (!transfer) continue;
      if (String(transfer["asset-id"]) !== this.net.usdcAsaId) continue;
      const amount = Number(transfer.amount ?? 0);
      if (amount <= 0) continue;
      if (typeof txn.id !== "string") continue;

      out.push({
        txId: txn.id,
        sender: String(txn.sender ?? ""),
        receiver: String(transfer.receiver ?? ""),
        amountBase: amount,
        confirmedRound: Number(txn["confirmed-round"] ?? 0),
        roundTime: Number(txn["round-time"] ?? 0),
      });
    }
    return out;
  }

  /**
   * Runs a full two-way reconciliation.
   *
   * Only transfers where we are a counterparty count. A transfer between two
   * strangers that happens to appear in a shared query is not our business.
   */
  async run(fromRound: number | null = null): Promise<ReconcileReport> {
    const checkedAt = new Date().toISOString();

    const [inbound, outbound] = await Promise.all([
      this.transfersFor(this.merchantAddress, fromRound),
      this.payerAddress === this.merchantAddress
        ? Promise.resolve([] as ChainTransfer[])
        : this.transfersFor(this.payerAddress, fromRound),
    ]);

    for (const result of [inbound, outbound]) {
      if ("error" in result) {
        return {
          network: this.net.name,
          checkedAt,
          fromRound,
          chainTransfers: 0,
          receipts: 0,
          matched: 0,
          discrepancies: [],
          // Not clean: an unreachable indexer means we verified nothing. Reporting
          // clean here would be the exact lie this suite exists to catch.
          clean: false,
          error: result.error,
        };
      }
    }

    const chain = new Map<string, { transfer: ChainTransfer; direction: Direction }>();
    for (const transfer of inbound as ChainTransfer[]) {
      if (transfer.receiver !== this.merchantAddress) continue;
      chain.set(transfer.txId, { transfer, direction: "in" });
    }
    for (const transfer of outbound as ChainTransfer[]) {
      if (transfer.sender !== this.payerAddress) continue;
      // An inbound record wins: a self-payment is money we received.
      if (!chain.has(transfer.txId)) chain.set(transfer.txId, { transfer, direction: "out" });
    }

    const receipts = this.store.receipts({ limit: 500 });
    const byTxId = new Map(receipts.map((r) => [r.txId, r]));

    const discrepancies: Discrepancy[] = [];
    let matched = 0;

    // Direction one: the chain is the authority, so start from it.
    for (const [txId, { transfer, direction }] of chain) {
      const receipt = byTxId.get(txId);
      if (!receipt) {
        discrepancies.push({
          kind: "missing_receipt",
          txId,
          detail:
            `on-chain ${direction === "in" ? "receipt of" : "payment of"} ` +
            `${(transfer.amountBase / 1e6).toFixed(6)} USDC in round ` +
            `${transfer.confirmedRound} has no receipt`,
          chainAmountBase: transfer.amountBase,
          receiptAmountBase: null,
        });
        continue;
      }

      if (receipt.amountBase !== transfer.amountBase) {
        discrepancies.push({
          kind: "amount_mismatch",
          txId,
          detail:
            `receipt says ${(receipt.amountBase / 1e6).toFixed(6)} USDC, ` +
            `chain says ${(transfer.amountBase / 1e6).toFixed(6)}`,
          chainAmountBase: transfer.amountBase,
          receiptAmountBase: receipt.amountBase,
        });
        continue;
      }

      if (receipt.direction !== direction) {
        discrepancies.push({
          kind: "direction_mismatch",
          txId,
          detail: `receipt says ${receipt.direction}, chain says ${direction}`,
          chainAmountBase: transfer.amountBase,
          receiptAmountBase: receipt.amountBase,
        });
        continue;
      }

      matched += 1;
    }

    // Direction two: a receipt with nothing behind it.
    for (const receipt of receipts) {
      if (chain.has(receipt.txId)) continue;
      // Below the window we queried, so absence proves nothing about it.
      if (fromRound !== null && receipt.confirmedRound !== null && receipt.confirmedRound < fromRound) {
        continue;
      }
      discrepancies.push({
        kind: "phantom_receipt",
        txId: receipt.txId,
        detail:
          `receipt for ${(receipt.amountBase / 1e6).toFixed(6)} USDC has no ` +
          `matching on-chain transfer`,
        chainAmountBase: null,
        receiptAmountBase: receipt.amountBase,
      });
    }

    return {
      network: this.net.name,
      checkedAt,
      fromRound,
      chainTransfers: chain.size,
      receipts: receipts.length,
      matched,
      discrepancies,
      clean: discrepancies.length === 0,
      error: null,
    };
  }
}

/** Receipt export. Every line carries a transaction id, per PRD §6. */
export function receiptsAsCsv(store: Store, explorerTxBase: string): string {
  const header = [
    "tx_id",
    "direction",
    "route",
    "payer",
    "payee",
    "amount_usdc",
    "amount_base",
    "asset_id",
    "network",
    "confirmed_round",
    "settled_at",
    "latency_ms",
    "explorer_url",
  ].join(",");

  const rows = store.receipts({ limit: 500 }).map((r) =>
    [
      r.txId,
      r.direction,
      r.route,
      r.payer,
      r.payee,
      (r.amountBase / 1e6).toFixed(6),
      String(r.amountBase),
      r.assetId,
      r.network,
      r.confirmedRound === null ? "" : String(r.confirmedRound),
      r.settledAt,
      r.latencyMs === null ? "" : String(r.latencyMs),
      explorerTxBase + r.txId,
    ]
      .map(csvCell)
      .join(","),
  );

  return [header, ...rows].join("\n") + "\n";
}

/** Quotes only when needed, and escapes embedded quotes. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
