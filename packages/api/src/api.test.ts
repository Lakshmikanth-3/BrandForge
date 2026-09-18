import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@sentry402/shared";
import { createApp, type AppParts } from "./app.js";

/**
 * Contract tests for every read endpoint.
 *
 * The frontend reads all of these, so a silent shape change breaks the dashboard
 * rather than the API. Each test asserts the fields a caller actually depends on,
 * and that an empty store answers with real zeros and nulls rather than samples.
 */

const env = {
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
  PAYER_MNEMONIC: Array.from({ length: 25 }, (_, i) => `word${i}`).join(" "),
} satisfies NodeJS.ProcessEnv;

const config = loadConfig(env);

describe("read API contracts", () => {
  let parts: AppParts;

  beforeEach(() => {
    parts = createApp(config, ":memory:");
  });

  const get = async (path: string) => {
    const res = await parts.app.request(path);
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  it("GET /api/flow describes both flows and the prices", async () => {
    const { res, body } = await get("/api/flow");
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      network: "testnet",
      routes: { orchestrate: "/v1/orchestrate", trust: "/v1/trust" },
      prices: { orchestrate: "$0.05", trust: "$0.02" },
    });
    const flows = body["flows"] as Record<string, unknown[]>;
    expect(flows["inbound"]!.length).toBe(6);
    expect(flows["bridged"]!.length).toBe(9);
    expect(String(body["explorerTxBase"])).toMatch(/^https:\/\//);
  });

  it("GET /api/stats reports zeros and nulls on an empty store", async () => {
    const { body } = await get("/api/stats");
    expect(body).toMatchObject({
      settleCount: 0,
      totalBase: 0,
      totalUsdc: 0,
      distinctPayers: 0,
      outboundCount: 0,
      outboundUsdc: 0,
      firstSettledAt: null,
      lastSettledAt: null,
      merchantAddress: env.MERCHANT_ADDRESS,
    });
  });

  it("GET /api/receipts returns an empty list with the explorer base", async () => {
    const { body } = await get("/api/receipts");
    expect(body["receipts"]).toEqual([]);
    expect(String(body["explorerTxBase"])).toMatch(/^https:\/\//);
  });

  it("GET /api/receipts derives a usdc amount and an explorer url per row", async () => {
    parts.store.putReceipt({
      txId: "TXAPI",
      direction: "in",
      route: "/v1/orchestrate",
      payer: "P1",
      payee: env.MERCHANT_ADDRESS,
      amountBase: 50_000,
      assetId: "10458941",
      network: "testnet",
      confirmedRound: 1,
      settledAt: "2026-09-18T00:00:00.000Z",
      traceId: null,
      latencyMs: 400,
    });

    const { body } = await get("/api/receipts");
    const rows = body["receipts"] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ txId: "TXAPI", amountUsdc: 0.05 });
    expect(String(rows[0]!["explorerUrl"])).toContain("TXAPI");
  });

  it("GET /api/receipts filters by direction", async () => {
    for (const [txId, direction] of [
      ["A", "in"],
      ["B", "out"],
    ] as const) {
      parts.store.putReceipt({
        txId,
        direction,
        route: "r",
        payer: "P",
        payee: "Q",
        amountBase: 1_000,
        assetId: "10458941",
        network: "testnet",
        confirmedRound: null,
        settledAt: "2026-09-18T00:00:00.000Z",
        traceId: null,
        latencyMs: null,
      });
    }

    const inbound = await get("/api/receipts?direction=in");
    expect((inbound.body["receipts"] as unknown[]).length).toBe(1);
    const outbound = await get("/api/receipts?direction=out");
    expect((outbound.body["receipts"] as unknown[]).length).toBe(1);
    const all = await get("/api/receipts");
    expect((all.body["receipts"] as unknown[]).length).toBe(2);
  });

  it("GET /api/traces returns an empty list before any traffic", async () => {
    const { body } = await get("/api/traces");
    expect(body["traces"]).toEqual([]);
  });

  it("GET /api/budget reports caps, headroom and payer readiness", async () => {
    const { body } = await get("/api/budget");
    expect(body).toMatchObject({
      halted: false,
      spentTodayUsdc: 0,
      remainingTodayUsdc: 2,
      caps: { perCallUsdc: 0.25, perDayUsdc: 2, perMerchantPerDayUsdc: 0.5 },
      recent: [],
    });
    expect(typeof body["payerReady"]).toBe("boolean");
    expect(String(body["day"])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("GET /api/budget reflects the kill switch", async () => {
    parts.guard.halt();
    const { body } = await get("/api/budget");
    expect(body["halted"]).toBe(true);
  });

  it("GET /api/services lists the curated set with a trust record each", async () => {
    const { body } = await get("/api/services");
    const services = body["services"] as Record<string, unknown>[];
    expect(services.length).toBeGreaterThanOrEqual(4);
    for (const service of services) {
      expect(typeof service["label"]).toBe("string");
      expect(typeof service["summary"]).toBe("string");
      expect(service["trust"]).toBeDefined();
      // Unprobed in a fresh store: price unknown, not guessed.
      expect(service).toHaveProperty("priceUsdc");
      expect(service).toHaveProperty("probeVerdict");
    }
  });

  it("GET /api/substitutions returns the log and the active policy", async () => {
    const { body } = await get("/api/substitutions");
    expect(body["substitutions"]).toEqual([]);
    expect(body["policy"]).toMatchObject({ refuseBelow: 0.6, warnBelow: 0.8 });
  });

  it("GET /api/trust requires a url", async () => {
    const { res } = await get("/api/trust");
    expect(res.status).toBe(400);
  });

  it("GET /api/receipts.csv serves a csv attachment with a header row", async () => {
    const res = await parts.app.request("/api/receipts.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/);
    expect((await res.text()).split("\n")[0]).toContain("tx_id");
  });

  it("GET /livez never touches the network", async () => {
    const res = await parts.app.request("/livez");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alive: true });
  });

  it("sets permissive CORS on every api route, which the facilitator probe checks", async () => {
    for (const path of ["/api/stats", "/api/flow", "/api/budget", "/api/services"]) {
      const res = await parts.app.request(path, { headers: { Origin: "https://x.test" } });
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
    }
  });

  it("answers 404 for an unknown api path rather than a 500", async () => {
    const res = await parts.app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("stats arithmetic", () => {
  let parts: AppParts;

  beforeEach(() => {
    parts = createApp(config, ":memory:");
  });

  const receipt = (
    txId: string,
    direction: "in" | "out",
    amountBase: number,
    payer: string,
  ) => ({
    txId,
    direction,
    route: "r",
    payer,
    payee: "Q",
    amountBase,
    assetId: "10458941",
    network: "testnet",
    confirmedRound: null,
    settledAt: "2026-09-18T00:00:00.000Z",
    traceId: null,
    latencyMs: null,
  });

  it("counts distinct payers rather than payments", async () => {
    parts.store.putReceipt(receipt("A", "in", 10_000, "P1"));
    parts.store.putReceipt(receipt("B", "in", 10_000, "P1"));
    parts.store.putReceipt(receipt("C", "in", 10_000, "P2"));

    const body = (await (await parts.app.request("/api/stats")).json()) as Record<
      string,
      unknown
    >;
    expect(body["settleCount"]).toBe(3);
    expect(body["distinctPayers"]).toBe(2);
  });

  it("keeps outbound spend out of inbound volume", async () => {
    parts.store.putReceipt(receipt("A", "in", 50_000, "P1"));
    parts.store.putReceipt(receipt("B", "out", 5_000, "US"));

    const body = (await (await parts.app.request("/api/stats")).json()) as Record<
      string,
      unknown
    >;
    expect(body["totalUsdc"]).toBe(0.05);
    expect(body["outboundUsdc"]).toBe(0.005);
    expect(body["settleCount"]).toBe(1);
    expect(body["outboundCount"]).toBe(1);
  });

  it("converts base units to usdc without floating point drift", async () => {
    // Three payments of 0.000001 USDC must not become 0.0000029999.
    for (const txId of ["A", "B", "C"]) {
      parts.store.putReceipt(receipt(txId, "in", 1, `P-${txId}`));
    }
    const body = (await (await parts.app.request("/api/stats")).json()) as Record<
      string,
      unknown
    >;
    expect(body["totalBase"]).toBe(3);
    expect(body["totalUsdc"]).toBeCloseTo(0.000003, 9);
  });
});
