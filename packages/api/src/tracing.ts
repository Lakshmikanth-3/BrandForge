/**
 * Hono middleware that turns a real request through the paid route into a trace.
 *
 * Runs outside the x402 middleware so it can see both the unpaid case (402
 * issued) and the paid case (settled), and reports whichever actually happened.
 * Nothing here decides an outcome — it only records what the payment middleware
 * and the facilitator did.
 */
import type { MiddlewareHandler } from "hono";
import type { AppConfig } from "@sentry402/shared";
import type { Store } from "./db.js";
import type { StepId, TraceHub } from "./trace.js";

/** The settlement receipt the facilitator returns, base64 in a response header. */
interface PaymentResponse {
  success?: boolean;
  transaction?: string;
  txId?: string;
  txid?: string;
  payer?: string;
  network?: string;
  errorReason?: string;
}

function decodePaymentResponse(header: string | undefined): PaymentResponse | null {
  if (!header) return null;
  for (const decode of [
    () => JSON.parse(Buffer.from(header, "base64").toString("utf8")),
    () => JSON.parse(header),
  ]) {
    try {
      const parsed = decode();
      if (parsed && typeof parsed === "object") return parsed as PaymentResponse;
    } catch {
      // try the next encoding
    }
  }
  return null;
}

function txIdOf(r: PaymentResponse | null): string | null {
  return r?.transaction ?? r?.txId ?? r?.txid ?? null;
}

export function traceMiddleware(
  hub: TraceHub,
  store: Store,
  config: AppConfig,
  priceBase: number,
): MiddlewareHandler {
  return async (c, next) => {
    const trace = hub.start(c.req.path);
    const id = trace.id;
    const skip = (steps: StepId[], detail: string) => {
      for (const s of steps) hub.end(id, s, "skipped", detail);
    };

    hub.begin(id, "request");
    hub.end(id, "request", "ok", `${c.req.method} ${c.req.path}`);

    const paymentHeader = c.req.header("X-PAYMENT");

    if (!paymentHeader) {
      // Unpaid request: the correct protocol outcome is a 402, not an error.
      hub.begin(id, "challenge");
      await next();

      if (c.res.status === 402) {
        hub.end(id, "challenge", "ok", `402 issued · ${(priceBase / 1e6).toFixed(6)} USDC`);
        skip(["payment", "settle", "deliver", "receipt"], "awaiting payment from client");
        hub.complete(id);
      } else {
        hub.fail(id, "challenge", `expected 402, got ${c.res.status}`);
      }
      return;
    }

    hub.end(id, "challenge", "skipped", "client already held payment requirements");
    hub.begin(id, "payment");
    hub.end(id, "payment", "ok", `${paymentHeader.length} byte header`);

    // Verify and settle happen inside next() as one facilitator round trip.
    hub.begin(id, "settle");
    const startedAt = Date.now();
    await next();
    const settleMs = Date.now() - startedAt;

    const settlement = decodePaymentResponse(c.res.headers.get("PAYMENT-RESPONSE") ?? c.res.headers.get("X-PAYMENT-RESPONSE") ?? undefined);
    const txId = txIdOf(settlement);
    const paid = c.res.status < 400;

    if (!paid) {
      hub.fail(
        id,
        "settle",
        settlement?.errorReason ?? `payment rejected · HTTP ${c.res.status}`,
      );
      return;
    }

    hub.end(id, "settle", "ok", txId ? `tx ${txId}` : `settled in ${settleMs}ms`);
    hub.annotate(id, {
      txId,
      amountBase: priceBase,
      ...(settlement?.payer ? { payer: settlement.payer } : {}),
    });

    hub.begin(id, "deliver");
    hub.end(id, "deliver", "ok", `HTTP ${c.res.status}`);

    // The receipt written here is provisional: the listener rewrites it from the
    // indexer, which is authoritative. Same tx id, so the insert is idempotent.
    hub.begin(id, "receipt");
    if (txId) {
      try {
        store.putReceipt({
          txId,
          direction: "in",
          route: c.req.path,
          payer: settlement?.payer ?? "unknown",
          payee: config.merchantAddress,
          amountBase: priceBase,
          assetId: config.network.usdcAsaId,
          network: config.network.name,
          confirmedRound: null,
          settledAt: new Date().toISOString(),
          traceId: id,
          latencyMs: settleMs,
        });
        hub.end(id, "receipt", "ok", "recorded, pending indexer confirmation");
      } catch (err) {
        hub.end(id, "receipt", "failed", err instanceof Error ? err.message : "write failed");
      }
    } else {
      // Settled but no tx id to key on — the listener will pick it up from chain.
      hub.end(id, "receipt", "skipped", "no tx id in settlement header; listener will reconcile");
    }

    hub.complete(id);
  };
}
