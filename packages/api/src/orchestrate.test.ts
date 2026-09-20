import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { loadConfig } from "@sentry402/shared";
import { Store } from "./db.js";
import { TrustEngine } from "./trust.js";
import { CURATED } from "./catalog.js";
import type { DownstreamPayer, PayOutcome } from "./payer.js";
import { orchestrateHandler } from "./orchestrate.js";

const config = loadConfig({
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
});

const TARGET = CURATED[0]!;

const ok = (): PayOutcome => ({
  ok: true, status: 200, result: { tvl: 1 }, txId: "TX1", amountBase: 5_000,
  latencyMs: 120, traceId: "t",
});

describe("paid orchestration route", () => {
  let store: Store;
  let calls: { url: string; price: number }[];

  const appWith = (payer: Partial<DownstreamPayer> | null, seedService = true) => {
    if (seedService) {
      store.upsertService(
        {
          resourceUrl: TARGET.url, method: TARGET.method, description: "d", payTo: "PAYTO",
          network: config.network.caip2, amountBase: 5_000, assetId: "10458941", settleCount: 1,
          lastSeen: new Date().toISOString(), hasDiscoveryInfo: true,
        },
        true,
      );
    }
    const app = new Hono();
    app.post(
      "/v1/orchestrate",
      orchestrateHandler({ config, store, payer: payer as DownstreamPayer | null, trust: new TrustEngine(store) }),
    );
    return app;
  };

  const post = (app: Hono, body: unknown) =>
    app.request("/v1/orchestrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    store = new Store(":memory:");
    calls = [];
  });

  const payerReturning = (o: PayOutcome) => ({
    payWithRouteAround: async (s: { url: string }, price: number) => {
      calls.push({ url: s.url, price });
      return o;
    },
  });

  it("refuses a target that is not curated, and pays nobody", async () => {
    const app = appWith(payerReturning(ok()));
    const res = await post(app, { target: "https://evil.test/drain" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refuses a body with no target", async () => {
    const res = await post(appWith(payerReturning(ok())), {});
    expect(res.status).toBe(400);
  });

  it("answers 503 when the server has no payer", async () => {
    const res = await post(appWith(null), { target: TARGET.label });
    expect(res.status).toBe(503);
  });

  it("pays the downstream and returns the result with a receipt", async () => {
    const res = await post(appWith(payerReturning(ok())), { target: TARGET.label });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ tvl: 1 });
    expect(body.receipt).toMatchObject({ txId: "TX1", amountUsdc: 0.005, network: "testnet" });
    expect(calls).toEqual([{ url: TARGET.url, price: 5_000 }]);
  });

  it("answers 422 on a trust refusal, so the client is not charged", async () => {
    const refused: PayOutcome = {
      ok: false, refusedByTrust: true, status: null, result: null, txId: null,
      amountBase: null, latencyMs: 1, traceId: "t", error: "refused by trust",
    };
    const res = await post(appWith(payerReturning(refused)), { target: TARGET.label });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { charged: boolean }).charged).toBe(false);
  });

  it("answers 502 when the downstream fails, never 200", async () => {
    const failed: PayOutcome = {
      ok: false, status: 500, result: null, txId: null, amountBase: null,
      latencyMs: 1, traceId: "t", error: "HTTP 500",
    };
    const res = await post(appWith(payerReturning(failed)), { target: TARGET.label });
    expect(res.status).toBe(502);
  });
});
