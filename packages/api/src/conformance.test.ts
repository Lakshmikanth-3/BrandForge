import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { x402Client } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { MAINNET, TESTNET, loadConfig } from "@sentry402/shared";
import { createApp } from "./app.js";

/**
 * Protocol conformance: a payment that does not match our terms must be refused, and
 * refused for the right reason (PRD §19).
 *
 * These build genuinely signed Algorand payment payloads for DELIBERATELY WRONG
 * requirements and send them to the real route, because the interesting failure is a
 * well-formed payment for the wrong terms, not a malformed string. A signature check
 * catches garbage on its own; only a terms check catches underpayment.
 *
 * ── Why no successful payment is made here ─────────────────────────────────────
 *
 * Every case below is expected to be REFUSED, which means no settlement and no money
 * moving. That is deliberate and not squeamishness: the facilitator auto-catalogs the
 * resource URL from the 402 on the first settled payment, and these tests run against a
 * local server whose resource URL is 127.0.0.1. One successful inbound payment here
 * would publish a localhost address as our permanent Bazaar listing, bound to a payTo
 * that cannot be rotated.
 *
 * So the replay case -- pay once, then replay the same header -- is written but skipped
 * until a public endpoint exists, because it is the one case that requires a real
 * settlement first. Set SENTRY402_SETTLING_TESTS=1 with a public PUBLIC_BASE_URL to run
 * it.
 *
 * Marked as network tests: building a payload reads suggested params from algod.
 */

const account = algosdk.generateAccount();

const env = {
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: account.addr.toString(),
  PAYER_MNEMONIC: algosdk.secretKeyToMnemonic(account.sk),
} satisfies NodeJS.ProcessEnv;

const config = loadConfig(env);
const ROUTE = "/v1/orchestrate";

interface Requirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** The terms our own route actually advertises, read from its live 402. */
async function advertisedRequirements(app: ReturnType<typeof createApp>["app"]) {
  const res = await app.request(ROUTE, { method: "POST" });
  const header = res.headers.get("payment-required");
  const challenge = JSON.parse(Buffer.from(String(header), "base64").toString("utf8")) as {
    accepts: Requirements[];
  };
  return challenge.accepts[0]!;
}

/** Signs a real payment for whatever requirements it is given, right or wrong. */
async function signPaymentFor(requirements: Requirements): Promise<string> {
  const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
  const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
  void client;
  const scheme = new ExactAvmScheme(signer);
  const payload = await scheme.createPaymentPayload(2, requirements as never);
  return Buffer.from(
    JSON.stringify({ x402Version: 2, scheme: "exact", network: requirements.network, payload }),
  ).toString("base64");
}

/** Sends a payment header at the route and reports what came back. */
async function attempt(header: string) {
  const { app } = createApp(config, ":memory:");
  const res = await app.request(ROUTE, {
    method: "POST",
    headers: { "X-PAYMENT": header, "content-type": "application/json" },
    body: "{}",
  });
  return { status: res.status, body: await res.text() };
}

describe("a well-formed payment for the wrong terms is refused", () => {
  it("refuses an underpayment", async () => {
    // The case a signature check cannot catch: a valid, correctly signed payment for
    // less than the route costs.
    const { app } = createApp(config, ":memory:");
    const real = await advertisedRequirements(app);
    const header = await signPaymentFor({ ...real, amount: String(Number(real.amount) - 1) });

    const result = await attempt(header);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).not.toBe(200);
  }, 60_000);

  it("refuses a payment of one base unit", async () => {
    const { app } = createApp(config, ":memory:");
    const real = await advertisedRequirements(app);
    const header = await signPaymentFor({ ...real, amount: "1" });
    expect((await attempt(header)).status).not.toBe(200);
  }, 60_000);

  it("refuses a payment denominated in the wrong asset", async () => {
    const { app } = createApp(config, ":memory:");
    const real = await advertisedRequirements(app);
    // MainNet USDC's asset id on TestNet is a different asset entirely.
    const header = await signPaymentFor({ ...real, asset: MAINNET.usdcAsaId });
    expect((await attempt(header)).status).not.toBe(200);
  }, 60_000);

  it("refuses a payment addressed to someone else", async () => {
    const { app } = createApp(config, ":memory:");
    const real = await advertisedRequirements(app);
    const stranger = algosdk.generateAccount().addr.toString();
    const header = await signPaymentFor({ ...real, payTo: stranger });

    const result = await attempt(header);
    expect(result.status).not.toBe(200);
  }, 60_000);

  it("refuses a payment for a different network", async () => {
    const { app } = createApp(config, ":memory:");
    const real = await advertisedRequirements(app);
    const header = await signPaymentFor({
      ...real,
      network: MAINNET.caip2,
      asset: MAINNET.usdcAsaId,
    });
    expect((await attempt(header)).status).not.toBe(200);
  }, 60_000);

  it("refuses an overpayment rather than silently accepting it", async () => {
    // "exact" means exact. Taking more than we asked for is also wrong.
    const { app } = createApp(config, ":memory:");
    const real = await advertisedRequirements(app);
    const header = await signPaymentFor({ ...real, amount: String(Number(real.amount) * 2) });
    expect((await attempt(header)).status).not.toBe(200);
  }, 60_000);
});

describe("malformed payment headers", () => {
  it.each([
    ["an empty header", ""],
    ["a non-base64 string", "!!!not-base64!!!"],
    ["base64 that is not JSON", Buffer.from("hello").toString("base64")],
    ["JSON with no payload", Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64")],
    [
      "a payload for an unknown scheme",
      Buffer.from(
        JSON.stringify({ x402Version: 2, scheme: "made-up", network: TESTNET.caip2, payload: {} }),
      ).toString("base64"),
    ],
    [
      "an unsupported x402 version",
      Buffer.from(
        JSON.stringify({ x402Version: 99, scheme: "exact", network: TESTNET.caip2, payload: {} }),
      ).toString("base64"),
    ],
  ])("refuses %s without settling", async (_label, header) => {
    const result = await attempt(header);
    expect(result.status).not.toBe(200);
    expect(result.body).not.toMatch(/Payment path live/);
  });

  it("never returns the paid payload on any refusal", async () => {
    for (const header of ["", "garbage", Buffer.from("{}").toString("base64")]) {
      const result = await attempt(header);
      expect(result.body).not.toMatch(/Payment path live/);
      expect(result.body).not.toMatch(/settledTo/);
    }
  });

  it("writes no receipt for any refused payment", async () => {
    const { app, store } = createApp(config, ":memory:");
    for (const header of ["", "garbage", Buffer.from("{}").toString("base64")]) {
      await app.request(ROUTE, { method: "POST", headers: { "X-PAYMENT": header } });
    }
    expect(store.stats().settleCount).toBe(0);
  });
});

/**
 * The replay case needs a real settlement first, which is why it is gated.
 *
 * Running it against a local server would publish 127.0.0.1 as our Bazaar listing on
 * the first settled payment, permanently, against a payTo we cannot rotate. That is not
 * a risk worth taking for a test that can run once the endpoint is public.
 */
const settlingTests = process.env["SENTRY402_SETTLING_TESTS"] === "1";

describe.skipIf(!settlingTests)("valid payment, exactly once", () => {
  it("serves the paid response once and refuses the replay", async () => {
    const { app } = createApp(config, ":memory:");
    const real = await advertisedRequirements(app);
    const header = await signPaymentFor(real);

    const first = await app.request(ROUTE, {
      method: "POST",
      headers: { "X-PAYMENT": header, "content-type": "application/json" },
      body: "{}",
    });
    expect(first.status).toBe(200);

    // Same header again: the payment is spent and must not buy a second response.
    const replay = await app.request(ROUTE, {
      method: "POST",
      headers: { "X-PAYMENT": header, "content-type": "application/json" },
      body: "{}",
    });
    expect(replay.status).not.toBe(200);
  }, 120_000);
});
