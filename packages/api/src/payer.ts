/**
 * Downstream payer — the side of the bridge that spends.
 *
 * Wraps fetch with x402 payment so a 402 from a downstream service is answered
 * automatically. The agent never sees a wallet and never holds key material: the
 * mnemonic lives only in this process, is converted to a signer once at startup,
 * and is never logged, serialised or forwarded.
 *
 * Every payment passes the budget guard first. The order is deliberate — reserve,
 * then attempt, then settle or release — so a crash mid-flight leaves a
 * reservation that expires rather than an unrecorded spend.
 */
import algosdk from "algosdk";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import type { AppConfig } from "@sentry402/shared";
import type { Store } from "./db.js";
import type { BudgetGuard } from "./budget.js";
import type { CuratedService } from "./catalog.js";
import type { TraceHub } from "./trace.js";
import type { TrustEngine } from "./trust.js";

export interface PayOutcome {
  ok: boolean;
  /** Set when the trust gate refused this service. */
  refusedByTrust?: boolean;
  status: number | null;
  /** The downstream service's response body, verbatim when it parsed as JSON. */
  result: unknown;
  txId: string | null;
  amountBase: number | null;
  latencyMs: number;
  traceId: string;
  error: string | null;
}

interface SettlementHeader {
  success?: boolean;
  transaction?: string;
  txId?: string;
  txid?: string;
  payer?: string;
  errorReason?: string;
}

function decodeSettlement(header: string | null): SettlementHeader | null {
  if (!header) return null;
  for (const decode of [
    () => JSON.parse(Buffer.from(header, "base64").toString("utf8")),
    () => JSON.parse(header),
  ]) {
    try {
      const parsed = decode();
      if (parsed && typeof parsed === "object") return parsed as SettlementHeader;
    } catch {
      // try the next encoding
    }
  }
  return null;
}

/** Reads the advertised price from a 402 without paying it. */
function priceFromChallenge(header: string | null, caip2: string): number | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8")) as {
      accepts?: { network?: string; amount?: string }[];
    };
    const match = (decoded.accepts ?? []).find((a) => a.network === caip2);
    const amount = Number(match?.amount);
    return Number.isFinite(amount) ? amount : null;
  } catch {
    return null;
  }
}

export class DownstreamPayer {
  private readonly paidFetch: typeof fetch;
  readonly address: string;
  /**
   * Only the non-secret slice of the config is retained. TypeScript's `private`
   * is compile-time only, so holding the whole AppConfig would leave the payer
   * mnemonic enumerable and it would appear in any JSON.stringify of this
   * instance — an error dump, a log line, a crash report. A test pins this.
   */
  private readonly network: AppConfig["network"];

  constructor(
    config: AppConfig,
    private readonly store: Store,
    private readonly guard: BudgetGuard,
    private readonly hub: TraceHub,
    private readonly trust: TrustEngine,
  ) {
    this.network = config.network;
    // mnemonicToSecretKey gives the 64-byte seed||pubkey form the signer wants.
    // algosdk is already a dependency, so this avoids a second key-handling path.
    const account = algosdk.mnemonicToSecretKey(config.secrets.payerMnemonic);
    this.address = account.addr.toString();

    if (this.address !== config.payerAddress) {
      // Catching this at startup beats discovering it when a payment fails.
      throw new Error(
        "PAYER_MNEMONIC does not derive PAYER_ADDRESS — refusing to start the payer",
      );
    }

    const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
    // Glob registration, for the same CAIP-2 form mismatch noted in x402.ts.
    const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
    this.paidFetch = wrapFetchWithPayment(fetch, client);
  }

  /**
   * Pays a curated service and returns its response.
   *
   * The trust gate runs before the budget guard and before any network call, so a
   * refusal costs nothing. Enforcement is here at the payment layer rather than in
   * the UI: a gate that only colours a badge is not a gate.
   */
  async pay(
    service: CuratedService,
    advertisedAmountBase: number,
    payload: unknown,
  ): Promise<PayOutcome> {
    const trace = this.hub.start(service.label, "bridged");
    const id = trace.id;
    const startedAt = Date.now();

    const fail = (step: Parameters<TraceHub["fail"]>[1], detail: string): PayOutcome => {
      this.hub.fail(id, step, detail);
      return {
        ok: false,
        status: null,
        result: null,
        txId: null,
        amountBase: null,
        latencyMs: Date.now() - startedAt,
        traceId: id,
        error: detail,
      };
    };

    this.hub.begin(id, "resolve");
    this.hub.end(id, "resolve", "ok", `${service.method} ${new URL(service.url).host}`);

    this.hub.begin(id, "trust");
    const gate = this.trust.gate(service.url);
    if (!gate.allow) {
      this.hub.fail(id, "trust", gate.reason);
      return {
        ok: false,
        refusedByTrust: true,
        status: null,
        result: null,
        txId: null,
        amountBase: null,
        latencyMs: Date.now() - startedAt,
        traceId: id,
        error: `refused by trust gate: ${gate.reason}`,
      };
    }
    this.hub.end(
      id,
      "trust",
      gate.record.verdict === "unrated" ? "skipped" : "ok",
      gate.reason,
    );

    this.hub.begin(id, "budget");
    const decision = this.guard.reserve({
      merchant: service.url,
      route: service.label,
      amountBase: advertisedAmountBase,
    });
    if (!decision.allowed) {
      return fail("budget", `${decision.reason}: ${decision.detail}`);
    }
    this.hub.end(
      id,
      "budget",
      "ok",
      `reserved ${(advertisedAmountBase / 1e6).toFixed(6)} USDC · ` +
        `${(decision.remainingDayBase / 1e6).toFixed(6)} left today`,
    );

    this.hub.begin(id, "request");
    let res: Response;
    try {
      res = await this.paidFetch(service.url, {
        method: service.method,
        signal: AbortSignal.timeout(60_000),
        ...(service.method === "POST"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload ?? {}),
            }
          : {}),
      });
    } catch (err) {
      // Nothing settled, so the headroom goes back.
      this.guard.release(decision.reservationId);
      const reason = err instanceof Error ? err.message : "downstream unreachable";
      // The payment wrapper already retried internally; reaching here means the
      // service failed warm as well, so this is a real failure, not a cold start.
      this.recordOutcome(service.url, {
        ok: false,
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        settled: false,
        failureReason: reason,
      });
      return fail("request", reason);
    }

    this.hub.end(id, "request", "ok", `HTTP ${res.status}`);

    const settlement = decodeSettlement(res.headers.get("x-payment-response"));
    const txId = settlement?.transaction ?? settlement?.txId ?? settlement?.txid ?? null;
    const livePrice = priceFromChallenge(
      res.headers.get("payment-required"),
      this.network.caip2,
    );

    // A 402 still standing means the wrapper could not satisfy the challenge.
    if (res.status === 402 || !res.ok) {
      this.guard.release(decision.reservationId);
      this.hub.end(
        id,
        "challenge",
        "ok",
        livePrice !== null ? `asked ${(livePrice / 1e6).toFixed(6)} USDC` : "402 returned",
      );
      const reason =
        settlement?.errorReason ?? `downstream returned HTTP ${res.status} after payment attempt`;
      // settled here means money moved and nothing usable came back, which the
      // scoring model weights hardest.
      this.recordOutcome(service.url, {
        ok: false,
        httpStatus: res.status,
        latencyMs: Date.now() - startedAt,
        settled: txId !== null,
        failureReason: reason,
      });
      return fail("payment", reason);
    }

    this.hub.end(id, "challenge", "ok", "requirements satisfied by the payer");
    this.hub.end(id, "payment", "ok", "X-PAYMENT accepted");
    this.hub.end(id, "settle", txId ? "ok" : "skipped", txId ? `tx ${txId}` : "no tx id returned");

    const latencyMs = Date.now() - startedAt;
    this.guard.settle(decision.reservationId, txId);
    this.hub.annotate(id, { txId, amountBase: advertisedAmountBase });

    // Outbound receipt. Confirm against the indexer is a separate step because
    // the indexer lags; an unconfirmed receipt is still recorded, then reconciled.
    if (txId) {
      try {
        this.store.putReceipt({
          txId,
          direction: "out",
          route: service.label,
          payer: this.address,
          payee: service.url,
          amountBase: advertisedAmountBase,
          assetId: this.network.usdcAsaId,
          network: this.network.name,
          confirmedRound: null,
          settledAt: new Date().toISOString(),
          traceId: id,
          latencyMs,
        });
      } catch {
        // A storage failure must not fail a payment that already settled.
      }
      this.hub.end(id, "confirm", "skipped", "pending indexer confirmation");
    } else {
      this.hub.end(id, "confirm", "skipped", "nothing to confirm without a tx id");
    }

    let result: unknown;
    const text = await res.text();
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }

    // A paid response with an empty body is a delivery failure, not a success:
    // the operator paid and the agent got nothing usable.
    const delivered = text.trim().length > 0;
    this.recordOutcome(service.url, {
      ok: delivered,
      httpStatus: res.status,
      latencyMs,
      settled: txId !== null,
      failureReason: delivered ? null : "paid response had an empty body",
    });

    this.hub.begin(id, "deliver");
    if (delivered) {
      this.hub.end(id, "deliver", "ok", `${text.length} bytes returned`);
      this.hub.complete(id);
    } else {
      this.hub.fail(id, "deliver", "paid response had an empty body");
      return {
        ok: false,
        status: res.status,
        result: null,
        txId,
        amountBase: advertisedAmountBase,
        latencyMs,
        traceId: id,
        error: "downstream took payment and returned an empty body",
      };
    }

    return {
      ok: true,
      status: res.status,
      result,
      txId,
      amountBase: advertisedAmountBase,
      latencyMs,
      traceId: id,
      error: null,
    };
  }

  /** Appends one observation for the trust engine. Never throws into a payment. */
  private recordOutcome(
    resourceUrl: string,
    o: {
      ok: boolean;
      httpStatus: number | null;
      latencyMs: number | null;
      settled: boolean;
      failureReason: string | null;
    },
  ): void {
    try {
      this.trust.record({
        resourceUrl,
        at: new Date().toISOString(),
        ok: o.ok,
        httpStatus: o.httpStatus,
        latencyMs: o.latencyMs,
        settled: o.settled,
        // Schema checking needs the advertised output schema from discovery; not
        // every curated service publishes one, so this stays null until it does.
        schemaOk: null,
        coldStart: false,
        failureReason: o.failureReason,
      });
    } catch {
      // A scoring write must never fail a payment that already happened.
    }
  }
}
