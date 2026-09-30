/**
 * Paid x402 routes — Phase 1.
 *
 * Adapted from the Foundation's x402-demo/x402-examples/server/bazaar-integration.
 *
 * Two deliberate departures from the demo:
 *  1. `network` uses the FULL genesis-hash CAIP-2 from shared/networks.ts, not
 *     @x402/avm's ALGORAND_*_CAIP2 constants. Those are truncated to 32 chars per
 *     the CAIP-2 spec, while the facilitator and every live Bazaar route use the
 *     full 44-char hash. The demo's bazaar example hardcodes it for the same reason.
 *  2. `extra.tag` carries the challenge tag. Labelling only — it never affects the
 *     payment, but without it a settlement does not count for the leaderboard.
 */
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
// @x402/extensions, not @x402-avm/extensions. Same exports, but 2.26.0 against 2.6.1
// from March, and the middleware auto-registers the bazaar extension from THIS package
// when a route needs it -- so registering the stale one made hasExtension("bazaar")
// true and suppressed the current one. Discovery is the most commonly reported failure
// in this competition; running it on a six-month-old declaration builder is not worth
// the risk.
//
// input.method is deliberately NOT passed below: the type omits it and the payment
// middleware injects it from the route key ("GET /v1/trust" -> method GET). A test
// validates the LIVE 402 against this package's own spec validator, which is the only
// check that matters -- the declaration and what the facilitator receives are
// different facts.
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import { avmPaywall, createPaywall } from "@x402/paywall";
import type { ResourceServerExtension } from "@x402/core/types";
import type { MiddlewareHandler } from "hono";
import { CHALLENGE_TAG, type AppConfig } from "@sentry402/shared";

/** Price points. brandKit is the product; orchestrate/trust remain as infrastructure. */
export const PRICES = {
  brandKit: "$0.03",
  orchestrate: "$0.05",
  trust: "$0.02",
} as const;

export const ROUTE_PATHS = {
  brandKit: "/v1/brand-kit",
  orchestrate: "/v1/orchestrate",
  trust: "/v1/trust",
} as const;

/**
 * Retries a facilitator call that failed at the socket, before any HTTP response existed.
 *
 * On a serverless host the first request after a cold start opens a fresh TLS connection to
 * the facilitator, and that connection is sometimes closed from the far side ("other side
 * closed"). The x402 middleware then answers that request with a 500, which is exactly what
 * the GoPlausible Doctor reported. Nothing was wrong with the route; one handshake was. A
 * response with a status is never retried: only a network-level failure is.
 */
export function retryTransient<T extends object>(
  target: T,
  method: keyof T & string,
  attempts = 3,
  delayMs = 300,
): void {
  const original = (target[method] as unknown as (...a: unknown[]) => Promise<unknown>).bind(target);
  (target as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    let last: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await original(...args);
      } catch (err) {
        last = err;
        const transient = err instanceof TypeError || /fetch failed|socket|ECONN|ETIMEDOUT/i.test(String(err));
        if (!transient || i === attempts - 1) break;
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
    throw last;
  };
}

export function buildResourceServer(config: AppConfig) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  retryTransient(facilitatorClient, "getSupported");

  // Registered against the "algorand:*" glob rather than one exact chain id.
  // @x402/avm changed its CAIP-2 constants to the 32-char reference form in
  // 2.20.0 while the facilitator still advertises the full genesis hash, so a
  // single exact registration can miss depending on which side changes first.
  // The glob accepts either. What we ADVERTISE is still the full form, because
  // that is what the facilitator and every live Bazaar route use.
  const server = new x402ResourceServer(facilitatorClient).register(
    "algorand:*",
    new ExactAvmScheme(),
  );

  // Required for the BAZAAR badge: without this extension the endpoint takes
  // payments but is never catalogued. The first settled payment then
  // auto-catalogs it — there is no separate registration step.
  server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

  return server;
}

/**
 * Discovery metadata for the orchestration route. This is what an agent reads
 * from the Bazaar to know how to call us, so the example must be real shape.
 */
const trustDiscovery = declareDiscoveryExtension({
  input: { url: "https://api.example.com/resource" },
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The x402 endpoint whose reliability record you want",
      },
    },
    required: ["url"],
  },
  output: {
    example: {
      resourceUrl: "https://api.example.com/resource",
      score: 0.94,
      verdict: "pass",
      observations: 128,
      successRate: 0.96,
      paidNothingCount: 2,
      medianLatencyMs: 410,
      coldStartCount: 7,
      lastSeenAt: "2026-09-18T00:00:00.000Z",
      basis: "128 observations, recency-weighted over the last 50",
    },
  },
});

/**
 * Discovery metadata for the brand-kit product. This is the Bazaar listing an agent
 * reads to know how to call it, so the example is the real request/response shape.
 */
const brandKitDiscovery = declareDiscoveryExtension({
  input: {
    name: "Northwind",
    industry: "fintech",
    vibe: "modern,bold",
  },
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The brand name" },
      industry: {
        type: "string",
        description: "What the brand does, e.g. 'specialty coffee' (optional)",
      },
      vibe: {
        type: "string",
        description:
          "Comma-separated vibe words, e.g. 'modern,bold' or 'luxury,elegant' (optional)",
      },
    },
    required: ["name"],
  },
  output: {
    example: {
      name: "Northwind",
      seed: 2853712049,
      scheme: "complementary",
      palette: {
        primary: "#2f6bf7",
        secondary: "#16305f",
        accent: "#f7a52f",
        dark: "#12131a",
        light: "#f3f5fb",
        muted: "#8b93a6",
      },
      fonts: {
        heading: { family: "Space Grotesk", category: "sans-serif", weights: [500, 700] },
        body: { family: "Inter", category: "sans-serif", weights: [400, 500] },
        googleFontsUrl: "https://fonts.googleapis.com/css2?family=Space+Grotesk...",
      },
      tagline: "Northwind. Modern by design.",
      voice: ["clear", "confident"],
      cssVariables: ":root { --brand-primary: #2f6bf7; ... }",
    },
  },
});

const orchestrateDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    target: "https://api.example.com/resource",
    payload: { query: "optional request body for the downstream service" },
  },
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "URL of the x402 service to call on the agent's behalf",
      },
      payload: {
        type: "object",
        description: "Request body forwarded to the downstream service",
      },
    },
    required: ["target"],
  },
  output: {
    example: {
      ok: true,
      target: "https://api.example.com/resource",
      trust: { score: 0.94, observations: 128, verdict: "pass" },
      result: { "...": "the downstream service's response, verbatim" },
      receipt: {
        txId: "ABC123...",
        amountUsdc: 0.02,
        network: "algorand-mainnet",
      },
    },
  },
});

/**
 * Phase 1 ships the orchestration route only, returning a stub payload. Phase 3
 * replaces the handler body with the real bridged call; the payment wiring here
 * does not change. The trust route lands in Phase 5.
 */
export function paidRoutes(config: AppConfig) {
  const accepts = [
    {
      scheme: "exact" as const,
      price: PRICES.orchestrate,
      network: config.network.caip2 as `${string}:${string}`,
      payTo: config.merchantAddress,
      extra: {
        asset: config.network.usdcAsaId,
        tag: CHALLENGE_TAG,
      },
    },
  ];

  // Literal key: RoutesConfig is keyed by exact route strings, so a computed key
  // widens to an index signature and stops type-checking the value.
  return {
    "GET /v1/brand-kit": {
      accepts: [
        {
          scheme: "exact" as const,
          price: PRICES.brandKit,
          network: config.network.caip2 as `${string}:${string}`,
          payTo: config.merchantAddress,
          extra: { asset: config.network.usdcAsaId, tag: CHALLENGE_TAG },
        },
      ],
      // This description IS the Bazaar listing for the product. Name what the caller gets.
      description:
        "Generate a complete brand kit from a short brief. Pass ?name= (and optionally " +
        "?industry= and ?vibe=modern,bold) and receive strategy, an SVG logo set, a colour " +
        "system (palette, 50–900 ramps, WCAG contrast), typography with a type scale, visual " +
        "language, imagery direction, a UI system, voice & tone, social and marketing templates, " +
        "brand guidelines, and paste-ready exports (CSS, Tailwind, Figma tokens). Deterministic: " +
        "the same brief always returns the same kit. No API key, no account — pay per kit in USDC on Algorand.",
      mimeType: "application/json",
      extensions: brandKitDiscovery,
    },
    "POST /v1/orchestrate": {
      accepts,
      // This description IS the Bazaar listing. Name what the caller gets.
      description:
        "Route an agent's request to a verified x402 service on Algorand and return " +
        "the paid result. Checks the target's reliability record before paying it, " +
        "settles the downstream call in USDC on the agent's behalf, and returns the " +
        "response plus a receipt with the settlement transaction id. No API key, no " +
        "account, no wallet in the agent.",
      mimeType: "application/json",
      extensions: orchestrateDiscovery,
    },
    "GET /v1/trust": {
      accepts: [
        {
          scheme: "exact" as const,
          price: PRICES.trust,
          network: config.network.caip2 as `${string}:${string}`,
          payTo: config.merchantAddress,
          extra: {
            asset: config.network.usdcAsaId,
            tag: CHALLENGE_TAG,
          },
        },
      ],
      // This description IS the Bazaar listing for the trust product.
      description:
        "Reliability record for any x402 endpoint on Algorand, built from calls this " +
        "bridge actually routed and paid for. Returns a composite score in [0,1], the " +
        "observation count behind it, success rate, how often the endpoint took payment " +
        "and returned nothing, median latency, and cold-start count. An endpoint with " +
        "too few observations is reported as unrated rather than given a misleading " +
        "number. Pass ?url= the endpoint you are about to pay.",
      mimeType: "application/json",
      extensions: trustDiscovery,
    },
    "GET /v1/weather": {
      accepts: [
        {
          scheme: "exact" as const,
          price: "$0.005" as const,
          network: config.network.caip2 as `${string}:${string}`,
          payTo: config.merchantAddress,
          extra: { asset: config.network.usdcAsaId, tag: CHALLENGE_TAG },
        },
      ],
      description:
        "Live current weather data (temperature, windspeed, conditions) sourced in real-time " +
        "from Open-Meteo's free public API. No API key required. Settled in USDC on Algorand.",
      mimeType: "application/json",
    },
    "GET /v1/token/price": {
      accepts: [
        {
          scheme: "exact" as const,
          price: "$0.002" as const,
          network: config.network.caip2 as `${string}:${string}`,
          payTo: config.merchantAddress,
          extra: { asset: config.network.usdcAsaId, tag: CHALLENGE_TAG },
        },
      ],
      description:
        "Live ALGO/USDT token price fetched from the Binance public ticker API. " +
        "Returns real market price and timestamp. Settled in USDC on Algorand.",
      mimeType: "application/json",
    },
    "POST /v1/ai/image": {
      accepts: [
        {
          scheme: "exact" as const,
          price: "$0.015" as const,
          network: config.network.caip2 as `${string}:${string}`,
          payTo: config.merchantAddress,
          extra: { asset: config.network.usdcAsaId, tag: CHALLENGE_TAG },
        },
      ],
      description:
        "AI image generation powered by Pollinations.ai. POST a text prompt and receive " +
        "a URL to a real AI-generated image. No API key required. Settled in USDC on Algorand.",
      mimeType: "application/json",
    },
  };
}


/**
 * Browser paywall.
 *
 * A machine that hits a paid route gets a 402 and pays it. A person who hits the same
 * route in a browser gets a bare 402 and nothing to do with it, which makes every
 * paid endpoint here unusable by the humans most likely to try one — and distinct
 * payer addresses is the metric the Foundation explicitly asks to see proof of.
 *
 * The official paywall renders a payment page with Pera, Defly and Lute, so a
 * developer who reads the README can become a real payer in a browser instead of
 * writing a client first.
 */
const paywall = createPaywall()
  .withNetwork(avmPaywall)
  .withConfig({
    appName: "BrandForge",
    testnet: true,
  })
  .build();

/**
 * Pins the URL the payment middleware advertises to PUBLIC_BASE_URL.
 *
 * The 402 challenge embeds resource.url, the facilitator catalogs that URL, and it is
 * bound to a payTo we may never rotate -- so it has to be exactly right. The middleware
 * builds it from the incoming request, which behind a hosting proxy is wrong in a way
 * that only shows up after deploy: the proxy terminates HTTPS and forwards plain HTTP to
 * the container, so the request URL says http:// even though every real caller used
 * https://. Sending X-Forwarded-Proto did not help; the middleware reads the request URL
 * directly. Left alone, a settled payment would have catalogued an http:// listing
 * permanently.
 *
 * Only the origin is replaced. Path and query are kept, because the paid trust route puts
 * the endpoint being looked up in the query string.
 */
export function publicUrlMiddleware(config: AppConfig): MiddlewareHandler {
  const origin = new URL(config.publicBaseUrl).origin;
  return async (c, next) => {
    const incoming = new URL(c.req.url);
    // HonoRequest exposes url as a prototype getter over the raw request, so an own
    // property on this instance shadows it for everything that reads c.req.url.
    Object.defineProperty(c.req, "url", {
      value: `${origin}${incoming.pathname}${incoming.search}`,
      configurable: true,
    });
    await next();
  };
}

export function x402Middleware(config: AppConfig): MiddlewareHandler {
  const server = buildResourceServer(config);
  return paymentMiddleware(
    paidRoutes(config),
    server,
    { testnet: config.network.name === "testnet" },
    paywall,
  ) as MiddlewareHandler;
}
