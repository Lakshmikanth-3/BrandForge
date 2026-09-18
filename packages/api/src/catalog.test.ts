import { beforeEach, describe, expect, it } from "vitest";
import { TESTNET, MAINNET } from "@sentry402/shared";
import { Store } from "./db.js";
import {
  CURATED,
  isAllowlisted,
  normaliseEntry,
  parseChallenge,
  probeService,
  type CatalogEntry,
} from "./catalog.js";

/** A realistic catalog item, shaped like the live listing. */
function item(over: Record<string, unknown> = {}) {
  return {
    resourceUrl: "https://example.test/metric/tvl",
    method: "GET",
    description: "A KPI",
    settleCount: 12,
    lastSeen: "2026-09-17T00:00:00.000Z",
    discoveryInfo: { input: {}, output: {} },
    accepts: [
      {
        scheme: "exact",
        network: TESTNET.caip2,
        amount: "5000",
        asset: "10458941",
        payTo: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
        extra: { asset: "10458941", tag: "x402-global-challenge" },
      },
    ],
    ...over,
  };
}

describe("normaliseEntry", () => {
  it("parses a well-formed entry for the configured network", () => {
    const entry = normaliseEntry(item(), TESTNET)!;
    expect(entry.resourceUrl).toBe("https://example.test/metric/tvl");
    expect(entry.amountBase).toBe(5000);
    expect(entry.assetId).toBe("10458941");
    expect(entry.hasDiscoveryInfo).toBe(true);
  });

  it("ignores an entry that only accepts a different network", () => {
    // 1855 of the 2087 live routes are MainNet. A TestNet payer cannot use them.
    expect(normaliseEntry(item(), MAINNET)).toBeNull();
  });

  it("picks the matching accepts entry from a multi-network listing", () => {
    const multi = item({
      accepts: [
        { scheme: "exact", network: MAINNET.caip2, amount: "1", asset: "31566704", payTo: "A" },
        {
          scheme: "exact",
          network: TESTNET.caip2,
          amount: "7000",
          asset: "10458941",
          payTo: "B",
        },
      ],
    });
    const entry = normaliseEntry(multi, TESTNET)!;
    expect(entry.amountBase).toBe(7000);
    expect(entry.payTo).toBe("B");
  });

  it("rejects a non-USDC asset", () => {
    const other = item({
      accepts: [
        {
          scheme: "exact",
          network: TESTNET.caip2,
          amount: "5000",
          asset: "999999",
          payTo: "A",
        },
      ],
    });
    expect(normaliseEntry(other, TESTNET)).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["missing resourceUrl", item({ resourceUrl: undefined })],
    ["a non-URL resourceUrl", item({ resourceUrl: "not a url" })],
    ["no accepts array", item({ accepts: undefined })],
    ["an empty accepts array", item({ accepts: [] })],
    ["a zero amount", item({ accepts: [{ scheme: "exact", network: TESTNET.caip2, amount: "0", asset: "10458941", payTo: "A" }] })],
    ["a non-numeric amount", item({ accepts: [{ scheme: "exact", network: TESTNET.caip2, amount: "abc", asset: "10458941", payTo: "A" }] })],
  ])("skips %s rather than throwing", (_label, bad) => {
    // A malformed entry belongs to someone else's endpoint. It must never break ingest.
    expect(() => normaliseEntry(bad, TESTNET)).not.toThrow();
    expect(normaliseEntry(bad, TESTNET)).toBeNull();
  });

  it("falls back to GET and normalises method case", () => {
    expect(normaliseEntry(item({ method: undefined }), TESTNET)!.method).toBe("GET");
    expect(normaliseEntry(item({ method: "post" }), TESTNET)!.method).toBe("POST");
  });
});

describe("parseChallenge", () => {
  it("decodes a base64 payment-required header", () => {
    const header = Buffer.from(
      JSON.stringify({ accepts: [{ network: TESTNET.caip2, amount: "5000" }] }),
    ).toString("base64");
    expect(parseChallenge(header)).toEqual([{ network: TESTNET.caip2, amount: "5000" }]);
  });

  it.each([
    ["null", null],
    ["garbage", "!!!not-base64!!!"],
    ["valid base64 that is not JSON", Buffer.from("hello").toString("base64")],
    ["JSON without accepts", Buffer.from(JSON.stringify({ x: 1 })).toString("base64")],
  ])("returns null for %s", (_label, header) => {
    expect(parseChallenge(header as string | null)).toBeNull();
  });
});

describe("curation", () => {
  it("ships a handful of services, not the whole catalog", () => {
    // PRD §22: a bridge to six good things beats a broken bridge to everything.
    expect(CURATED.length).toBeGreaterThanOrEqual(4);
    expect(CURATED.length).toBeLessThanOrEqual(6);
  });

  it("curates exact URLs, so one vendor cannot flood the tool list", () => {
    // An earlier host-based allowlist produced 59 tools from 5 vendors.
    for (const c of CURATED) {
      expect(isAllowlisted(c.url)).toBe(true);
      // A different path on the same host must not be allowlisted by association.
      expect(isAllowlisted(new URL("/some/other/path", c.url).toString())).toBe(false);
    }
  });

  it("requires TLS on every curated endpoint", () => {
    // Payment material never travels over an unencrypted hop.
    for (const c of CURATED) expect(new URL(c.url).protocol).toBe("https:");
  });

  it("gives every curated service an agent-readable label and summary", () => {
    for (const c of CURATED) {
      expect(c.label).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(c.summary.length).toBeGreaterThan(20);
    }
    expect(new Set(CURATED.map((c) => c.label)).size).toBe(CURATED.length);
  });

  it("does not allowlist an arbitrary catalog url", () => {
    expect(isAllowlisted("https://evil.test/anything")).toBe(false);
    expect(isAllowlisted("not a url")).toBe(false);
  });
});

describe("probeService", () => {
  const entry: CatalogEntry = {
    resourceUrl: "https://example.test/x",
    method: "GET",
    description: "",
    payTo: "A",
    network: TESTNET.caip2,
    amountBase: 5000,
    assetId: "10458941",
    settleCount: 0,
    lastSeen: "2026-09-17T00:00:00.000Z",
    hasDiscoveryInfo: false,
  };

  const challengeHeader = (network: string, amount: string) =>
    Buffer.from(JSON.stringify({ accepts: [{ network, amount }] })).toString("base64");

  const respond = (status: number, header?: string) =>
    new Response(null, {
      status,
      headers: header ? { "payment-required": header } : {},
    });

  it("confirms a service that answers 402 on our network", async () => {
    const result = await probeService(entry, TESTNET, {
      fetchImpl: async () => respond(402, challengeHeader(TESTNET.caip2, "5000")),
    });
    expect(result.verdict).toBe("ok");
    expect(result.liveAmountBase).toBe(5000);
    expect(result.priceDriftRatio).toBe(1);
    expect(result.detail).toBeNull();
  });

  it("reports price drift when the live amount differs from the catalog", async () => {
    // Observed live: one service listed at $0.01 charged $0.05.
    const result = await probeService(entry, TESTNET, {
      fetchImpl: async () => respond(402, challengeHeader(TESTNET.caip2, "25000")),
    });
    expect(result.verdict).toBe("ok");
    expect(result.priceDriftRatio).toBe(5);
    expect(result.detail).toMatch(/price drift/);
  });

  it("flags a stale catalog entry that no longer returns 402", async () => {
    const result = await probeService(entry, TESTNET, {
      fetchImpl: async () => respond(404),
    });
    expect(result.verdict).toBe("wrong_status");
    expect(result.httpStatus).toBe(404);
    expect(result.detail).toMatch(/stale/);
  });

  it("flags a 402 with no parseable challenge", async () => {
    const result = await probeService(entry, TESTNET, {
      fetchImpl: async () => respond(402),
    });
    expect(result.verdict).toBe("no_challenge");
  });

  it("flags a service that only accepts a different network", async () => {
    // Observed live: a TestNet-listed service advertising MainNet only.
    const result = await probeService(entry, TESTNET, {
      fetchImpl: async () => respond(402, challengeHeader(MAINNET.caip2, "5000")),
    });
    expect(result.verdict).toBe("wrong_network");
    expect(result.detail).toMatch(/not testnet/);
  });

  it("retries once before calling a service unreachable, because of cold starts", async () => {
    // Four live services timed out at 20s then answered in ~1.5s once warm.
    let calls = 0;
    const result = await probeService(entry, TESTNET, {
      firstTimeoutMs: 10,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("timeout");
        return respond(402, challengeHeader(TESTNET.caip2, "5000"));
      },
    });
    expect(calls).toBe(2);
    expect(result.verdict).toBe("ok");
    expect(result.coldStart).toBe(true);
  });

  it("gives up after the retry also fails", async () => {
    let calls = 0;
    const result = await probeService(entry, TESTNET, {
      firstTimeoutMs: 10,
      retryTimeoutMs: 10,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("econnrefused");
      },
    });
    expect(calls).toBe(2);
    expect(result.verdict).toBe("unreachable");
    expect(result.detail).toMatch(/after retry/);
  });
});

describe("service registry", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  const entry = (url: string): CatalogEntry => ({
    resourceUrl: url,
    method: "GET",
    description: "d",
    payTo: "A",
    network: TESTNET.caip2,
    amountBase: 5000,
    assetId: "10458941",
    settleCount: 3,
    lastSeen: "2026-09-17T00:00:00.000Z",
    hasDiscoveryInfo: true,
  });

  it("upserts without duplicating a service", () => {
    store.upsertService(entry("https://a.test/x"), true);
    store.upsertService(entry("https://a.test/x"), true);
    expect(store.services()).toHaveLength(1);
  });

  it("filters to allowlisted services only", () => {
    store.upsertService(entry("https://a.test/x"), true);
    store.upsertService(entry("https://b.test/y"), false);
    expect(store.services({ allowlistedOnly: true })).toHaveLength(1);
    expect(store.services()).toHaveLength(2);
  });

  it("marks a vanished service inactive instead of deleting its history", () => {
    store.upsertService(entry("https://a.test/x"), true);
    store.upsertService(entry("https://b.test/y"), true);

    const inactive = store.markMissingInactive(["https://a.test/x"], TESTNET.caip2);
    expect(inactive).toBe(1);
    expect(store.services({ activeOnly: true })).toHaveLength(1);
    // The row survives, so trust observations are not lost.
    expect(store.services({ activeOnly: false })).toHaveLength(2);
  });

  it("reactivates a service that returns to the catalog", () => {
    store.upsertService(entry("https://a.test/x"), true);
    store.markMissingInactive([], TESTNET.caip2);
    expect(store.services({ activeOnly: true })).toHaveLength(0);

    store.upsertService(entry("https://a.test/x"), true);
    expect(store.services({ activeOnly: true })).toHaveLength(1);
  });

  it("records a probe result against the service", () => {
    store.upsertService(entry("https://a.test/x"), true);
    store.recordProbe("https://a.test/x", {
      verdict: "ok",
      httpStatus: 402,
      latencyMs: 412,
      liveAmountBase: 5000,
      priceDriftRatio: 1,
      coldStart: false,
      detail: null,
    });

    const service = store.services()[0]!;
    expect(service.probeVerdict).toBe("ok");
    expect(service.probeLatencyMs).toBe(412);
    expect(service.probedAt).toBeTruthy();
  });

  it("keeps the last probe result across a re-ingest", () => {
    // An ingest tells us what the catalog claims, not whether the service works.
    store.upsertService(entry("https://a.test/x"), true);
    store.recordProbe("https://a.test/x", {
      verdict: "ok",
      httpStatus: 402,
      latencyMs: 100,
      liveAmountBase: 5000,
      priceDriftRatio: 1,
      coldStart: false,
      detail: null,
    });
    store.upsertService(entry("https://a.test/x"), true);
    expect(store.services()[0]!.probeVerdict).toBe("ok");
  });
});
