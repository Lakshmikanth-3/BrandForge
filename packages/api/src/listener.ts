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
 *
 * Both directions are scanned, and the outbound half is not optional. The first
 * real bridged call paid a downstream service that returned no transaction id in
 * its settlement header, so the request path had nothing to key a receipt on. With
 * only the merchant address watched, that payment would have stayed invisible to the
 * books forever while reconciliation flagged it as missing. Deriving outbound
 * receipts from the payer's own on-chain history closes that hole, and it is the
 * more trustworthy source anyway.
 */
import type { NetworkConfig } from "@sentry402/shared";
import type { Store } from "./db.js";

const CURSOR_KEYS = { in: "inbound_min_round", out: "outbound_min_round" } as const;

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
    private readonly payerAddress: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** One pass over both directions. */
  async poll(): Promise<ListenerResult> {
    const inbound = await this.scan("in");
    if (inbound.error) return inbound;

    if (!this.payerAddress || this.payerAddress === this.merchantAddress) return inbound;

    const outbound = await this.scan("out");
    if (outbound.error) {
      // Inbound work is already committed; report the outbound failure honestly.
      return { ...inbound, error: outbound.error };
    }

    return {
      scanned: inbound.scanned + outbound.scanned,
      written: inbound.written + outbound.written,
      latestRound: Math.max(inbound.latestRound ?? 0, outbound.latestRound ?? 0) || null,
    };
  }

  /** One direction. `in` is USDC arriving at the merchant, `out` is the payer spending. */
  private async scan(direction: "in" | "out"): Promise<ListenerResult> {
    const address = direction === "in" ? this.merchantAddress : (this.payerAddress as string);
    const cursorKey = CURSOR_KEYS[direction];
    const cursor = this.store.getCursor(cursorKey);

    const params = new URLSearchParams({
      "asset-id": this.net.usdcAsaId,
      "tx-type": "axfer",
      limit: "100",
    });
    if (cursor) params.set("min-round", cursor);

    const url = `${this.net.indexerUrl}/v2/accounts/${address}/transactions?${params.toString()}`;

    let body: { transactions?: IndexerTxn[]; "current-round"?: number };
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
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
      if (!transfer) continue;
      if (String(transfer["asset-id"]) !== this.net.usdcAsaId) continue;
      if (transfer.amount <= 0) continue;
      if (typeof txn.id !== "string") continue;

      // Direction is decided by which side we are on, not by which account we
      // queried: the same transaction appears in both accounts' histories.
      if (direction === "in" && transfer.receiver !== this.merchantAddress) continue;
      if (direction === "out") {
        if (txn.sender !== this.payerAddress) continue;
        // Paying ourselves is money received, and the inbound scan already has it.
        if (transfer.receiver === this.merchantAddress) continue;
      }

      const round = Number(txn["confirmed-round"]);
      maxRound = Math.max(maxRound, round);

      const inserted = this.store.putReceipt({
        txId: txn.id,
        direction,
        route: direction === "in" ? this.route : "downstream",
        payer: direction === "in" ? txn.sender : (this.payerAddress as string),
        payee: direction === "in" ? this.merchantAddress : transfer.receiver,
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
    if (maxRound > 0) this.store.setCursor(cursorKey, String(maxRound));

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
