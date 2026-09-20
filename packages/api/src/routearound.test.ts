import { beforeEach, describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { loadConfig, TESTNET } from "@sentry402/shared";
import { Store } from "./db.js";
import { BudgetGuard } from "./budget.js";
import { TraceHub } from "./trace.js";
import { TrustEngine } from "./trust.js";
import { DownstreamPayer } from "./payer.js";
import type { CuratedService } from "./catalog.js";

const account = algosdk.generateAccount();

const svc = (label: string): CuratedService => ({
  url: `https://${label}.test/x`,
  method: "GET",
  label,
  summary: label,
});
const PRIMARY = svc("primary");
const ALT = svc("alt");

const config = loadConfig({
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: account.addr.toString(),
  PAYER_MNEMONIC: algosdk.secretKeyToMnemonic(account.sk),
});

const quote = (amount: number) =>
  new Response(null, {
    status: 402,
    headers: {
      "payment-required": Buffer.from(
        JSON.stringify({ accepts: [{ network: TESTNET.caip2, amount: String(amount) }] }),
      ).toString("base64"),
    },
  });

const paid = (tx: string) =>
  new Response(JSON.stringify({ v: 1 }), {
    status: 200,
    headers: {
      "x-payment-response": Buffer.from(JSON.stringify({ success: true, transaction: tx })).toString(
        "base64",
      ),
    },
  });

describe("route-around", () => {
  let store: Store;
  let trust: TrustEngine;
  let paidUrls: string[];
  let payer: DownstreamPayer;

  const seed = (url: string, ok: boolean, n: number) => {
    for (let i = 0; i < n; i += 1) {
      store.putOutcome({
        resourceUrl: url,
        at: new Date(Date.now() - i * 1000).toISOString(),
        ok,
        httpStatus: ok ? 200 : 500,
        latencyMs: 200,
        settled: ok,
        schemaOk: null,
        coldStart: false,
        failureReason: ok ? null : "http_500",
        clientError: false,
      });
    }
  };

  /** `quotes` maps url -> quoted amount; anything unlisted is unreachable. */
  const build = (quotes: Record<string, number>) => {
    payer = new DownstreamPayer(config, store, new BudgetGuard(store), new TraceHub(store, "testnet"), trust);
    Reflect.set(payer, "plainFetch", async (u: string) => {
      const q = quotes[String(u)];
      if (q === undefined) throw new Error("ECONNREFUSED");
      return quote(q);
    });
    Reflect.set(payer, "paidFetch", async (u: string) => {
      paidUrls.push(String(u));
      return paid(`TX_${paidUrls.length}`);
    });
  };

  beforeEach(() => {
    store = new Store(":memory:");
    trust = new TrustEngine(store);
    paidUrls = [];
  });

  const alts = [{ service: ALT, priceBase: 5_000 }];

  it("routes to a scored alternative when the primary is refused by trust", async () => {
    seed(PRIMARY.url, false, 12);
    seed(ALT.url, true, 12);
    build({ [PRIMARY.url]: 5_000, [ALT.url]: 5_000 });

    const out = await payer.payWithRouteAround(PRIMARY, 5_000, null, alts);
    expect(out.ok).toBe(true);
    expect(paidUrls).toEqual([ALT.url]);
    expect(out.substituted).toMatchObject({ from: "primary", to: "alt" });
    expect(store.substitutions()).toHaveLength(1);
    expect(store.substitutions()[0]!.chosenUrl).toBe(ALT.url);
  });

  it("returns the honest refusal, and logs it, when no alternative has a record", async () => {
    seed(PRIMARY.url, false, 12); // ALT is unrated: not a trustworthy substitute
    build({ [PRIMARY.url]: 5_000, [ALT.url]: 5_000 });

    const out = await payer.payWithRouteAround(PRIMARY, 5_000, null, alts);
    expect(out.ok).toBe(false);
    expect(out.refusedByTrust).toBe(true);
    expect(out.substituted).toBeUndefined();
    expect(paidUrls).toEqual([]);
    expect(store.substitutions()[0]!.chosenUrl).toBeNull();
  });

  it("routes around a price anomaly, since nothing was paid", async () => {
    seed(PRIMARY.url, true, 12);
    seed(ALT.url, true, 12);
    build({ [PRIMARY.url]: 50_000, [ALT.url]: 5_000 }); // primary quotes 10x

    const out = await payer.payWithRouteAround(PRIMARY, 5_000, null, alts);
    expect(out.ok).toBe(true);
    expect(paidUrls).toEqual([ALT.url]);
  });

  it("does not substitute after money moved", async () => {
    seed(PRIMARY.url, true, 12);
    seed(ALT.url, true, 12);
    build({ [PRIMARY.url]: 5_000, [ALT.url]: 5_000 });
    // Paid, then the downstream fails: the tx exists, so a second payment would double spend.
    Reflect.set(payer, "paidFetch", async (u: string) => {
      paidUrls.push(String(u));
      return new Response("boom", {
        status: 500,
        headers: {
          "x-payment-response": Buffer.from(
            JSON.stringify({ success: true, transaction: "TXPAID" }),
          ).toString("base64"),
        },
      });
    });

    const out = await payer.payWithRouteAround(PRIMARY, 5_000, null, alts);
    expect(out.ok).toBe(false);
    expect(paidUrls).toEqual([PRIMARY.url]);
    expect(store.substitutions()).toHaveLength(0);
  });

  it("does not route around a budget refusal", async () => {
    seed(PRIMARY.url, true, 12);
    seed(ALT.url, true, 12);
    build({ [PRIMARY.url]: 5_000, [ALT.url]: 5_000 });

    const out = await payer.payWithRouteAround(PRIMARY, 999_999_000, null, alts);
    expect(out.ok).toBe(false);
    expect(paidUrls).toEqual([]);
    expect(store.substitutions()).toHaveLength(0);
  });
});
