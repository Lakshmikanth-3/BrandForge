/**
 * Settlement listener.
 *
 * The chain is the source of truth, not our request path. A payment can settle
 * while our process is restarting, so receipts are written from what the indexer
 * reports about the merchant address — not from what the handler believed
 * happened. This is what makes the reconciliation suite (PRD §19) meaningful:
 * both sides derive from the same place.
 *
 * Idempotent by transaction id, and cursored so a restart neither rescans from
 * genesis nor skips rounds.
 */
import type { NetworkConfig } from "@sentry402/shared";
import type { Store } from "./db.js";

const CURSOR_KEY = "inbound_min_round";

interface IndexerTxn {
  id: string;
  "confirmed-round": number;
  sender: string;
  "round-time": number;
  "asset-transfer-transaction"?: {
    "asset-id": number;
    amount: number;
    receiver: string;
  };
}

export interface ListenerResult {
  scanned: number;
  written: number;
  latestRound: number | null;
  error?: string;
}

export class SettlementListener {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly net: NetworkConfig,
    private readonly store: Store,
    private readonly merchantAddress: string,
    private readonly route = "inbound",
  ) {}

  /** One pass. Returns what it did so a test or /healthz can assert on it. */
  async poll(): Promise<ListenerResult> {
    const cursor = this.store.getCursor(CURSOR_KEY);
    const params = new URLSearchParams({
      "asset-id": this.net.usdcAsaId,
      "tx-type": "axfer",
      limit: "100",
    });
    if (cursor) params.set("min-round", cursor);

    const url =
      `${this.net.indexerUrl}/v2/accounts/${this.merchantAddress}/transactions?` +
      params.toString();

    let body: { transactions?: IndexerTxn[]; "current-round"?: number };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return { scanned: 0, written: 0, latestRound: null, error: `HTTP ${res.status}` };
      body = (await res.json()) as typeof body;
    } catch (err) {
      return {
        scanned: 0,
        written: 0,
        latestRound: null,
        error: err instanceof Error ? err.message : "indexer unreachable",
      };
    }

    const txns = body.transactions ?? [];
    let written = 0;
    let maxRound = cursor ? Number(cursor) : 0;

    for (const txn of txns) {
      const transfer = txn["asset-transfer-transaction"];
      // Only incoming USDC to us counts as a settlement of one of our routes.
      if (!transfer) continue;
      if (String(transfer["asset-id"]) !== this.net.usdcAsaId) continue;
      if (transfer.receiver !== this.merchantAddress) continue;
      if (transfer.amount <= 0) continue;

      const round = Number(txn["confirmed-round"]);
      maxRound = Math.max(maxRound, round);

      const inserted = this.store.putReceipt({
        txId: txn.id,
        direction: "in",
        route: this.route,
        payer: txn.sender,
        payee: this.merchantAddress,
        amountBase: transfer.amount,
        assetId: this.net.usdcAsaId,
        network: this.net.name,
        confirmedRound: round,
        settledAt: new Date(Number(txn["round-time"]) * 1000).toISOString(),
        traceId: null,
        latencyMs: null,
      });
      if (inserted) written += 1;
    }

    // Advance only past rounds we fully processed, and re-read the newest round
    // next time so a transaction arriving later in the same round is not lost.
    if (maxRound > 0) this.store.setCursor(CURSOR_KEY, String(maxRound));

    return { scanned: txns.length, written, latestRound: maxRound || null };
  }

  start(intervalMs = 6_000): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      const result = await this.poll();
      if (result.error) console.error("settlement listener:", result.error);
      else if (result.written > 0) console.log(`settlement listener: +${result.written} receipt(s)`);
    };
    void tick();
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }
}
