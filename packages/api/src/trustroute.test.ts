import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, CHALLENGE_TAG, TESTNET } from "@sentry402/shared";
import { createApp } from "./app.js";
import { Store } from "./db.js";
import { TrustEngine, type Outcome } from "./trust.js";
import { RateLimiter, TtlCache } from "./trustcache.js";
import { PRICES, ROUTE_PATHS } from "./x402.js";

const env = {
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
  PAYER_MNEMONIC: Array.from({ length: 25 }, (_, i) => `word${i}`).join(" "),
} satisfies NodeJS.ProcessEnv;

const config = loadConfig(env);
const TARGET = "https://downstream.test/metric/tvl";

interface Challenge {
  accepts: {
    amount: string;
    asset: string;
    network: string;
    payTo: string;
    extra?: { tag?: string };
  }[];
  resource?: { description?: string };
  extensions?: { bazaar?: { info?: unknown; schema?: unknown } };
}

function challengeOf(res: Response): Challenge {
  const header = res.headers.get("payment-required");
  expect(header, "402 must carry a payment-required header").toBeTruthy();
  return JSON.parse(Buffer.from(String(header), "base64").toString("utf8")) as Challenge;
}

describe("GET /v1/trust — the paid product", () => {
  it("returns 402 to an unpaid request", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request(`${ROUTE_PATHS.trust}?url=${encodeURIComponent(TARGET)}`);
    expect(res.status).toBe(402);
  });

  it("prices the query at $0.02 in USDC base units", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request(ROUTE_PATHS.trust);
    const accept = challengeOf(res).accepts[0]!;
    expect(PRICES.trust).toBe("$0.02");
    expect(accept.amount).toBe("20000");
    expect(accept.asset).toBe("10458941");
    expect(accept.network).toBe(TESTNET.caip2);
  });

  it("settles to the same merchant address as the orchestration route", async () => {
    // One payTo per root domain, per the Foundation's rule.
    const { app } = createApp(config, ":memory:");
    const trustAccept = challengeOf(await app.request(ROUTE_PATHS.trust)).accepts[0]!;
    const orchAccept = challengeOf(
      await app.request(ROUTE_PATHS.orchestrate, { method: "POST" }),
    ).accepts[0]!;
    expect(trustAccept.payTo).toBe(orchAccept.payTo);
    expect(trustAccept.payTo).toBe(env.MERCHANT_ADDRESS);
  });

  it("carries the challenge tag so its settlements also count", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request(ROUTE_PATHS.trust);
    expect(challengeOf(res).accepts[0]!.extra?.tag).toBe(CHALLENGE_TAG);
  });

  it("declares discovery so it is listed in the Bazaar as its own service", async () => {
    const { app } = createApp(config, ":memory:");
    const challenge = challengeOf(await app.request(ROUTE_PATHS.trust));
    expect(challenge.extensions?.bazaar?.info).toBeDefined();
    expect(challenge.extensions?.bazaar?.schema).toBeDefined();
  });

  it("describes what the caller gets, including that unrated is possible", async () => {
    const { app } = createApp(config, ":memory:");
    const description = challengeOf(await app.request(ROUTE_PATHS.trust)).resource
      ?.description;
    expect(description).toMatch(/unrated/);
    expect(description).toMatch(/observation count/);
  });

  it("does not leak the record to an unpaid caller", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request(`${ROUTE_PATHS.trust}?url=${encodeURIComponent(TARGET)}`);
    const body = await res.text();
    expect(body).not.toMatch(/observations/);
    expect(body).not.toMatch(/verdict/);
  });
});

describe("what we sell cannot diverge from what we act on", () => {
  let store: Store;
  let engine: TrustEngine;

  beforeEach(() => {
    store = new Store(":memory:");
    engine = new TrustEngine(store);
  });

  const feed = (url: string, n: number, over: Partial<Outcome> = {}) => {
    for (let i = 0; i < n; i += 1) {
      engine.record({
        resourceUrl: url,
        at: new Date(Date.now() - i * 1_000).toISOString(),
        ok: true,
        httpStatus: 200,
        latencyMs: 400,
        settled: true,
        schemaOk: null,
        coldStart: false,
        failureReason: null,
        ...over,
      });
    }
  };

  it("serves the same record the payment gate consumes", async () => {
    // The most important property of this phase: selling a different number than
    // the one we act on would make both worthless.
    const { app, trust } = createApp(config, ":memory:");
    const parts = app;
    const internal = trust.recordFor(TARGET);

    const res = await parts.request(`/api/trust?url=${encodeURIComponent(TARGET)}`);
    const sold = await res.json();

    expect(sold).toMatchObject({
      resourceUrl: internal.resourceUrl,
      score: internal.score,
      verdict: internal.verdict,
      observations: internal.observations,
      basis: internal.basis,
    });
  });

  it("gates on the same verdict it reports", () => {
    feed(TARGET, 20, { ok: false, settled: true });
    const reported = engine.recordFor(TARGET);
    const gate = engine.gate(TARGET);
    expect(gate.record.verdict).toBe(reported.verdict);
    expect(gate.allow).toBe(reported.verdict !== "refuse");
  });
});

describe("honesty of the sold record", () => {
  it("reports an unknown endpoint as unrated with zero observations, not an error", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request(
      `/api/trust?url=${encodeURIComponent("https://never-seen.test/x")}`,
    );

    expect(res.status).toBe(200);
    const record = await res.json();
    expect(record.verdict).toBe("unrated");
    expect(record.score).toBeNull();
    expect(record.observations).toBe(0);
    // Not a guess, not a default, not zero-as-a-score.
    expect(record.successRate).toBeNull();
  });

  it("states the observation count plainly, so 4 calls cannot look like 400", async () => {
    const { app, trust } = createApp(config, ":memory:");
    for (let i = 0; i < 4; i += 1) {
      trust.record({
        resourceUrl: TARGET,
        at: new Date(Date.now() - i * 1_000).toISOString(),
        ok: true,
        httpStatus: 200,
        latencyMs: 300,
        settled: true,
        schemaOk: null,
        coldStart: false,
        failureReason: null,
      });
    }

    const res = await app.request(`/api/trust?url=${encodeURIComponent(TARGET)}`);
    const record = await res.json();
    expect(record.observations).toBe(4);
    expect(record.basis).toMatch(/4 observations, 5 needed/);
  });

  it("requires a url rather than inventing a default", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request("/api/trust");
    expect(res.status).toBe(400);
  });
});

describe("TtlCache", () => {
  it("serves a value inside its TTL", () => {
    let now = 1_000;
    const cache = new TtlCache<string>(5_000, () => now);
    cache.set("k", "v");
    now += 4_999;
    expect(cache.get("k")).toBe("v");
  });

  it("does not serve a stale value past its TTL", () => {
    // A trust score that lags reality undermines the thing being sold.
    let now = 1_000;
    const cache = new TtlCache<string>(5_000, () => now);
    cache.set("k", "v");
    now += 5_001;
    expect(cache.get("k")).toBeUndefined();
  });

  it("drops the expired entry rather than keeping it around", () => {
    let now = 0;
    const cache = new TtlCache<string>(100, () => now);
    cache.set("k", "v");
    now = 200;
    cache.get("k");
    expect(cache.size).toBe(0);
  });

  it("is bounded, so a one-off lookup cannot pin memory forever", () => {
    const cache = new TtlCache<number>(60_000, () => 0, 3);
    for (let i = 0; i < 10; i += 1) cache.set(`k${i}`, i);
    expect(cache.size).toBeLessThanOrEqual(3);
  });

  it("returns undefined for a key it never held", () => {
    expect(new TtlCache<string>().get("nope")).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit inside a window", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1_000, () => now);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(false);
  });

  it("reports how long to wait", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 10_000, () => now);
    limiter.check("ip");
    const refused = limiter.check("ip");
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.retryAfterSec).toBeGreaterThan(0);
    expect(refused.retryAfterSec).toBeLessThanOrEqual(10);
  });

  it("resets on the next window", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(false);
    now = 1_001;
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("limits each caller independently", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("rate limits the free lookup but says the paid route is not limited", async () => {
    const { app } = createApp(config, ":memory:");
    let limited: Response | null = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await app.request(`/api/trust?url=${encodeURIComponent(TARGET)}`, {
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.headers.get("retry-after")).toBeTruthy();
    const body = await limited!.json();
    expect(body.hint).toMatch(/\/v1\/trust is not rate limited/);
  });
});

describe("browser paywall", () => {
  // A machine that hits a paid route pays it. A person who hits the same route in a
  // browser previously got a bare 402 and nothing to do with it, which made every paid
  // endpoint here unusable by the humans most likely to try one. Distinct payer
  // addresses is the metric the Foundation asks for proof of, so that gap mattered.
  const asBrowser = {
    Accept: "text/html",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  it("serves a wallet payment page to a browser", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request(`${ROUTE_PATHS.trust}?url=https%3A%2F%2Fexample.test%2Fx`, {
      headers: asBrowser,
    });

    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);

    const html = await res.text();
    // The wallets a person on Algorand actually has.
    for (const wallet of ["Pera", "Defly", "Lute"]) expect(html).toContain(wallet);
    expect(html).toContain("BrandForge");
  });

  it("still serves JSON to a machine, which must not change", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request(`${ROUTE_PATHS.trust}?url=https%3A%2F%2Fexample.test%2Fx`);
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("payment-required")).toBeTruthy();
  });

  it("requires both a browser Accept header and a browser user agent", async () => {
    // The condition is Accept containing text/html AND a Mozilla user agent. Getting
    // this wrong is how an earlier attempt concluded the paywall was broken.
    const { app } = createApp(config, ":memory:");

    const acceptOnly = await app.request(ROUTE_PATHS.trust, {
      headers: { Accept: "text/html" },
    });
    expect(acceptOnly.headers.get("content-type")).toMatch(/application\/json/);

    const uaOnly = await app.request(ROUTE_PATHS.trust, {
      headers: { "User-Agent": asBrowser["User-Agent"] },
    });
    expect(uaOnly.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("puts a paywall on the orchestration route too", async () => {
    const { app } = createApp(config, ":memory:");
    const res = await app.request(ROUTE_PATHS.orchestrate, {
      method: "POST",
      headers: asBrowser,
    });
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});
