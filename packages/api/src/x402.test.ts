import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, CHALLENGE_TAG, TESTNET } from "@sentry402/shared";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { createApp } from "./app.js";
import { Store } from "./db.js";

const env = {
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
  PAYER_MNEMONIC: Array.from({ length: 25 }, (_, i) => `word${i}`).join(" "),
} satisfies NodeJS.ProcessEnv;

const config = loadConfig(env);

function app() {
  return createApp(config, ":memory:");
}

interface Challenge {
  x402Version: number;
  accepts: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: { tag?: string; asset?: string; feePayer?: string };
  }[];
  resource?: { url?: string; description?: string };
}

function challengeOf(res: Response): Challenge {
  // x402 v2 carries the challenge in the `payment-required` header, base64 JSON.
  // The response body is intentionally empty.
  const header = res.headers.get("payment-required");
  expect(header, "402 must carry a payment-required header").toBeTruthy();
  return JSON.parse(Buffer.from(String(header), "base64").toString("utf8")) as Challenge;
}

describe("protocol conformance: POST /v1/orchestrate", () => {
  it("returns 402 to an unpaid request", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    expect(res.status).toBe(402);
  });

  it("advertises exactly one accepts entry for the configured network", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    const challenge = challengeOf(res);
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]!.scheme).toBe("exact");
    expect(challenge.accepts[0]!.network).toBe(TESTNET.caip2);
  });

  it("uses the FULL genesis-hash CAIP-2, not the truncated spec form", async () => {
    // The ALGORAND_*_CAIP2 constants in @x402/avm are 32-char-truncated and do
    // not match the facilitator. Regression guard: this difference breaks settlement.
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    const network = challengeOf(res).accepts[0]!.network;
    expect(network).toBe("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");
    expect(network.length).toBe(53);
  });

  it("resolves $0.05 to the correct USDC asset and base units", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    const accept = challengeOf(res).accepts[0]!;
    expect(accept.asset).toBe("10458941");
    expect(accept.amount).toBe("50000");
    expect(Number(accept.amount) / 1e6).toBeCloseTo(0.05, 6);
  });

  it("carries the challenge tag, without which settlements do not count", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    expect(challengeOf(res).accepts[0]!.extra?.tag).toBe(CHALLENGE_TAG);
  });

  it("pays to the configured merchant address", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    expect(challengeOf(res).accepts[0]!.payTo).toBe(env.MERCHANT_ADDRESS);
  });

  it("advertises the route description that becomes the Bazaar listing", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    const description = challengeOf(res).resource?.description ?? "";
    expect(description.length).toBeGreaterThan(80);
    expect(description).toMatch(/Algorand/);
  });

  it("rejects a malformed payment header without settling", async () => {
    const res = await app().app.request("/v1/orchestrate", {
      method: "POST",
      headers: { "X-PAYMENT": "not-a-valid-payment" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  it("never returns the paid payload to an unpaid caller", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    expect(await res.text()).not.toMatch(/Payment path live/);
  });
});

describe("protocol conformance: GET /v1/brand-kit (the product)", () => {
  const path = "/v1/brand-kit?name=Northwind&industry=fintech&vibe=modern,bold";

  it("returns 402 to an unpaid request", async () => {
    const res = await app().app.request(path);
    expect(res.status).toBe(402);
  });

  it("prices the kit at $0.03 in USDC with the challenge tag", async () => {
    const accept = challengeOf(await app().app.request(path)).accepts[0]!;
    expect(accept.amount).toBe("30000");
    expect(accept.asset).toBe("10458941");
    expect(accept.payTo).toBe(env.MERCHANT_ADDRESS);
    expect(accept.extra?.tag).toBe(CHALLENGE_TAG);
  });

  it("advertises a Bazaar listing that names what the caller gets", async () => {
    const description = challengeOf(await app().app.request(path)).resource?.description ?? "";
    expect(description.length).toBeGreaterThan(80);
    expect(description).toMatch(/brand kit/i);
    expect(description).toMatch(/palette/i);
  });

  it("never leaks the kit to an unpaid caller", async () => {
    const res = await app().app.request(path);
    // A real kit body carries hex colours; the 402 must not.
    expect(await res.text()).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

describe("tracing reflects what actually happened", () => {
  it("records an unpaid request as challenge-ok and the rest skipped", async () => {
    const parts = app();
    await parts.app.request("/v1/orchestrate", { method: "POST" });

    const trace = parts.hub.recent(1)[0]!;
    expect(trace.state).toBe("ok");
    const byId = Object.fromEntries(trace.steps.map((s) => [s.id, s.state]));
    expect(byId["request"]).toBe("ok");
    expect(byId["challenge"]).toBe("ok");
    // Not "failed": a 402 to an unpaid caller is correct protocol behaviour.
    expect(byId["payment"]).toBe("skipped");
    expect(byId["settle"]).toBe("skipped");
    expect(byId["receipt"]).toBe("skipped");
  });

  it("marks the failing step and keeps real outcomes before it", async () => {
    const parts = app();
    await parts.app.request("/v1/orchestrate", {
      method: "POST",
      headers: { "X-PAYMENT": "garbage" },
    });

    const trace = parts.hub.recent(1)[0]!;
    expect(trace.state).toBe("failed");
    const settle = trace.steps.find((s) => s.id === "settle")!;
    expect(settle.state).toBe("failed");
    expect(settle.detail).toBeTruthy();
    expect(trace.steps.find((s) => s.id === "request")!.state).toBe("ok");
    expect(trace.steps.find((s) => s.id === "payment")!.state).toBe("ok");
  });

  it("writes no receipt when nothing settled", async () => {
    const parts = app();
    await parts.app.request("/v1/orchestrate", { method: "POST" });
    await parts.app.request("/v1/orchestrate", {
      method: "POST",
      headers: { "X-PAYMENT": "garbage" },
    });
    expect(parts.store.stats().settleCount).toBe(0);
  });
});

describe("read API returns real zeros, never samples", () => {
  it("reports an empty store honestly", async () => {
    const res = await app().app.request("/api/stats");
    const body = await res.json();
    expect(body).toMatchObject({
      settleCount: 0,
      totalUsdc: 0,
      distinctPayers: 0,
      firstSettledAt: null,
    });
  });

  it("serves the flow shape so the UI can render before any traffic", async () => {
    const res = await app().app.request("/api/flow");
    const body = await res.json();
    expect(body.steps.map((s: { id: string }) => s.id)).toEqual([
      "request",
      "challenge",
      "payment",
      "settle",
      "deliver",
      "receipt",
    ]);
    expect(body.prices.orchestrate).toBe("$0.05");
  });
});

describe("receipt store", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  const receipt = (over: Partial<Parameters<Store["putReceipt"]>[0]> = {}) => ({
    txId: "TX1",
    direction: "in" as const,
    route: "/v1/orchestrate",
    payer: "PAYER_A",
    payee: env.MERCHANT_ADDRESS,
    amountBase: 50_000,
    assetId: "10458941",
    network: "testnet",
    confirmedRound: 100,
    settledAt: "2026-09-18T00:00:00.000Z",
    traceId: null,
    latencyMs: 900,
    ...over,
  });

  it("is idempotent by transaction id", () => {
    expect(store.putReceipt(receipt())).toBe(true);
    expect(store.putReceipt(receipt())).toBe(false);
    expect(store.stats().settleCount).toBe(1);
  });

  it("counts distinct payers, not payments", () => {
    store.putReceipt(receipt({ txId: "A", payer: "P1" }));
    store.putReceipt(receipt({ txId: "B", payer: "P1" }));
    store.putReceipt(receipt({ txId: "C", payer: "P2" }));
    const s = store.stats();
    expect(s.settleCount).toBe(3);
    expect(s.distinctPayers).toBe(2);
  });

  it("keeps money in integer base units", () => {
    store.putReceipt(receipt({ txId: "A", amountBase: 50_000 }));
    store.putReceipt(receipt({ txId: "B", amountBase: 20_000 }));
    expect(store.stats().totalBase).toBe(70_000);
  });

  it("separates inbound from outbound volume", () => {
    store.putReceipt(receipt({ txId: "A", direction: "in", amountBase: 50_000 }));
    store.putReceipt(receipt({ txId: "B", direction: "out", amountBase: 15_000 }));
    const s = store.stats();
    expect(s.settleCount).toBe(1);
    expect(s.outboundCount).toBe(1);
    expect(s.outboundBase).toBe(15_000);
    // Outbound must not inflate inbound volume.
    expect(s.totalBase).toBe(50_000);
  });
});

describe("domain metadata the facilitator reads", () => {
  // Merchant identity is derived from OpenGraph tags, llms.txt or
  // agent-card.json — not an MCP manifest. Accuracy matters: the enrichment pass
  // runs at most daily, so a wrong price propagates into the Bazaar listing.
  it("serves llms.txt as plain text naming the route and its price", async () => {
    const res = await app().app.request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);

    const body = await res.text();
    expect(body).toMatch(/BrandForge/);
    // The brand-kit product is the headline listing, with its price.
    expect(body).toMatch(/GET .*\/v1\/brand-kit/);
    expect(body).toMatch(/\$0\.03/);
    expect(body).toMatch(/POST .*\/v1\/orchestrate/);
    expect(body).toMatch(/\$0\.05/);
    expect(body).toContain("10458941");
    expect(body).toContain("facilitator.goplausible.xyz");
  });

  it("serves an agent card advertising exactly the live routes", async () => {
    // This assertion was inverted when the trust route shipped: while it was
    // unbuilt, advertising it would have been a false claim, and the test enforced
    // that. Now it is live, so the card must carry it.
    const res = await app().app.request("/.well-known/agent-card.json");
    expect(res.status).toBe(200);

    const card = await res.json();
    expect(card.name).toBe("BrandForge");
    expect(card.payment.x402Version).toBe(2);
    expect(card.payment.network).toBe(TESTNET.caip2);
    expect(card.payment.asset).toBe("10458941");

    expect(card.payment.routes).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/v1/brand-kit", price: "$0.03" },
        { method: "POST", path: "/v1/orchestrate", price: "$0.05" },
        { method: "GET", path: "/v1/trust", price: "$0.02" },
      ]),
    );
    expect(card.payment.routes).toHaveLength(3);
    expect(card.skills.map((s: { id: string }) => s.id).sort()).toEqual([
      "brand-kit",
      "orchestrate",
      "trust",
    ]);
  });

  it("advertises the trust route in llms.txt with its price", async () => {
    const body = await (await app().app.request("/llms.txt")).text();
    expect(body).toMatch(/GET .*\/v1\/trust\?url=/);
    expect(body).toMatch(/\$0\.02/);
    expect(body).toMatch(/unrated/);
  });

  it("never leaks key material in domain metadata", async () => {
    for (const path of ["/llms.txt", "/.well-known/agent-card.json"]) {
      const text = await (await app().app.request(path)).text();
      expect(text).not.toContain("word0");
      expect(text.toLowerCase()).not.toContain("mnemonic");
    }
  });
});

describe("discovery declaration (BAZAAR badge)", () => {
  it("includes the bazaar extension in the 402, without which nothing is catalogued", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    const challenge = challengeOf(res) as unknown as {
      extensions?: { bazaar?: { info?: unknown; schema?: unknown } };
    };
    expect(challenge.extensions?.bazaar).toBeDefined();
    expect(challenge.extensions?.bazaar?.info).toBeDefined();
    expect(challenge.extensions?.bazaar?.schema).toBeDefined();
  });

  it("declares the input schema an agent needs to call us", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    const challenge = challengeOf(res) as unknown as {
      extensions?: { bazaar?: { info?: { input?: { method?: string; body?: unknown } } } };
    };
    const input = challenge.extensions?.bazaar?.info?.input;
    expect(input?.method).toBe("POST");
    expect(input?.body).toMatchObject({ target: expect.any(String) });
  });
});

describe("the discovery declaration is valid per the CURRENT spec", () => {
  // Discovery is the most commonly reported failure in this competition, and the
  // declaration builder used to come from @x402-avm/extensions 2.6.1 (March) while the
  // maintained package is @x402/extensions 2.26.0. Worse, the payment middleware
  // auto-registers the bazaar extension from the current package only when the server
  // does not already have one, so registering the stale extension suppressed it.
  //
  // These assertions run the package's own validator over what the endpoint actually
  // emits, because the declaration and what the facilitator receives are different
  // facts and only the second one matters.
  const bazaarOf = (res: Response) => {
    const challenge = challengeOf(res) as unknown as {
      extensions?: { bazaar?: unknown };
    };
    expect(challenge.extensions?.bazaar, "extensions.bazaar must be present").toBeDefined();
    return challenge.extensions!.bazaar;
  };

  it("emits a spec-valid declaration for the orchestration route", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    expect(validateDiscoveryExtension(bazaarOf(res))).toMatchObject({ valid: true });
  });

  it("emits a spec-valid declaration for the trust route", async () => {
    const res = await app().app.request("/v1/trust?url=https%3A%2F%2Fexample.test%2Fx");
    expect(validateDiscoveryExtension(bazaarOf(res))).toMatchObject({ valid: true });
  });

  it("carries the method the middleware injects from the route key", async () => {
    // declareDiscoveryExtension is called WITHOUT a method, because the type omits it
    // and the middleware fills it in. If that ever stops happening the declaration
    // becomes invalid, and this is the test that catches it.
    const post = challengeOf(
      await app().app.request("/v1/orchestrate", { method: "POST" }),
    ) as unknown as { extensions: { bazaar: { info: { input: { method: string } } } } };
    expect(post.extensions.bazaar.info.input.method).toBe("POST");

    const get = challengeOf(
      await app().app.request("/v1/trust?url=https%3A%2F%2Fexample.test%2Fx"),
    ) as unknown as { extensions: { bazaar: { info: { input: { method: string } } } } };
    expect(get.extensions.bazaar.info.input.method).toBe("GET");
  });

  it("declares a GET route by query parameters, not a body", async () => {
    const get = challengeOf(
      await app().app.request("/v1/trust?url=https%3A%2F%2Fexample.test%2Fx"),
    ) as unknown as {
      extensions: { bazaar: { info: { input: { queryParams?: unknown; body?: unknown } } } };
    };
    expect(get.extensions.bazaar.info.input.queryParams).toBeDefined();
    expect(get.extensions.bazaar.info.input.body).toBeUndefined();
  });
});

describe("the advertised resource URL is the public one, whatever the proxy says", () => {
  // Behind a hosting proxy the container sees plain http on an internal host, so a URL
  // built from the request is wrong -- and the facilitator catalogs whatever is advertised,
  // permanently, against a payTo we cannot rotate. Found by simulating the proxy headers:
  // even with X-Forwarded-Proto: https the advertised URL said http://.
  const resourceUrlOf = (res: Response) =>
    (challengeOf(res) as unknown as { resource: { url: string } }).resource.url;

  it("advertises https and the configured origin for the orchestration route", async () => {
    const res = await app().app.request("/v1/orchestrate", { method: "POST" });
    expect(resourceUrlOf(res)).toBe("https://example.test/v1/orchestrate");
  });

  it("ignores an http request URL and a spoofed forwarded host", async () => {
    const res = await app().app.request("http://internal.container:4021/v1/orchestrate", {
      method: "POST",
      headers: { Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" },
    });
    expect(resourceUrlOf(res)).toBe("https://example.test/v1/orchestrate");
  });

  it("keeps the query string on the paid trust route", async () => {
    // The endpoint being looked up rides in the query, so dropping it would catalog a
    // different resource than the one that was requested.
    const res = await app().app.request("/v1/trust?url=https%3A%2F%2Fa.test%2Fx");
    expect(resourceUrlOf(res)).toBe("https://example.test/v1/trust?url=https%3A%2F%2Fa.test%2Fx");
  });

  it("never advertises localhost or a non-https scheme when a public url is configured", async () => {
    for (const [path, method] of [["/v1/orchestrate", "POST"], ["/v1/trust", "GET"]] as const) {
      const url = resourceUrlOf(await app().app.request(path, { method }));
      expect(url).toMatch(/^https:\/\//);
      expect(url).not.toMatch(/localhost|127\.0\.0\.1|internal/);
    }
  });

  it("does not disturb the payment challenge itself", async () => {
    const challenge = challengeOf(await app().app.request("/v1/orchestrate", { method: "POST" }));
    expect(challenge.accepts[0]!.amount).toBe("50000");
    expect(challenge.accepts[0]!.payTo).toBe(env.MERCHANT_ADDRESS);
  });
});
