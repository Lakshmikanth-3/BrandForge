/**
 * Failure-injection endpoints (PRD §19).
 *
 * Deliberately broken x402 services, served by this app so the bridge can be
 * driven against them over real HTTP rather than a mocked fetch. Every row of the
 * failure-injection table in the test strategy has an endpoint here.
 *
 * Two safety properties:
 *
 *  1. Refused outright on MainNet. These routes exist to misbehave, and a
 *     misbehaving route on the domain the facilitator probes would be a liability.
 *     `mountInjectRoutes` returns null unless the network is TestNet.
 *  2. They advertise 402 challenges but are NOT registered with the facilitator
 *     and are not in the curated allowlist, so they can never become agent tools
 *     and their responses can never land in the real receipt or outcome tables
 *     through normal operation. The failure-injection suite drives them with an
 *     isolated in-memory store.
 *
 * The challenge they return is shaped like a real one but points at our own
 * merchant address, so if a payment were ever attempted it would settle to us
 * rather than to a stranger.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppConfig } from "@sentry402/shared";
import { CHALLENGE_TAG } from "@sentry402/shared";

export const INJECT_PREFIX = "/__inject";

/** Every injected behaviour, keyed by the path segment that serves it. */
export const INJECTED = {
  /** Takes payment and returns an empty body. The only failure that costs money. */
  "paid-empty": "settles, then returns nothing",
  /** Returns a 200 whose body does not match the advertised shape. */
  "wrong-schema": "settles, then returns a body of the wrong shape",
  /** Holds the connection open past any sane timeout. */
  slow: "never responds within the client timeout",
  /** Fails before quoting a price, so no payment should be sent. */
  "error-before-402": "returns 500 instead of a 402 challenge",
  /** Quotes far more than the registry says it costs. */
  "price-jump": "quotes 8x the expected price",
  /** Quotes far less, which is equally an anomaly. */
  "price-drop": "quotes a quarter of the expected price",
  /** Gone, as if the owner removed the route. */
  vanished: "returns 404 as though the route was removed",
  /** A 402 with no parseable challenge. */
  "malformed-challenge": "returns 402 with an unparseable header",
} as const;

export type InjectedBehaviour = keyof typeof INJECTED;

/** The price the registry would believe these endpoints cost. */
export const INJECT_EXPECTED_BASE = 5_000; // $0.005

function challengeHeader(config: AppConfig, amountBase: number, resourceUrl: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      error: "Payment required",
      resource: { url: resourceUrl, mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: config.network.caip2,
          amount: String(amountBase),
          asset: config.network.usdcAsaId,
          payTo: config.merchantAddress,
          maxTimeoutSeconds: 300,
          extra: { asset: config.network.usdcAsaId, tag: CHALLENGE_TAG },
        },
      ],
    }),
  ).toString("base64");
}

/** A settlement header shaped like the facilitator's, for the paid-but-broken cases. */
function fakeSettlementHeader(txId: string): string {
  return Buffer.from(JSON.stringify({ success: true, transaction: txId })).toString("base64");
}

export function injectUrl(config: AppConfig, behaviour: InjectedBehaviour): string {
  return `${config.publicBaseUrl}${INJECT_PREFIX}/${behaviour}`;
}

/**
 * Returns the injection router, or null on MainNet where it must not exist.
 */
export function mountInjectRoutes(config: AppConfig): Hono | null {
  if (config.network.name !== "testnet") return null;

  const inject = new Hono();

  // Answer both /__inject and /__inject/ so a trailing slash is not a 404.
  const index = (c: Context) =>
    c.json({
      warning: "Deliberately broken endpoints for failure-injection testing. TestNet only.",
      expectedPriceBase: INJECT_EXPECTED_BASE,
      behaviours: INJECTED,
    });
  inject.get("/", index);
  inject.get("", index);

  const quoted = (behaviour: InjectedBehaviour): number => {
    if (behaviour === "price-jump") return INJECT_EXPECTED_BASE * 8;
    if (behaviour === "price-drop") return Math.round(INJECT_EXPECTED_BASE / 4);
    return INJECT_EXPECTED_BASE;
  };

  const handler = async (c: Context) => {
    const behaviour = c.req.param("behaviour") as InjectedBehaviour;
    if (!(behaviour in INJECTED)) return c.json({ error: "unknown behaviour" }, 404);

    const paid = c.req.header("X-PAYMENT") !== undefined;
    const url = `${config.publicBaseUrl}${INJECT_PREFIX}/${behaviour}`;

    switch (behaviour) {
      case "error-before-402":
        // Fails before quoting, so a correct bridge sends no payment at all.
        return c.json({ error: "internal failure before quoting a price" }, 500);

      case "vanished":
        return c.json({ error: "not found" }, 404);

      case "slow": {
        // Longer than any client timeout the bridge sets.
        await new Promise((resolve) => setTimeout(resolve, 90_000));
        return c.json({ never: "reached" });
      }

      case "malformed-challenge":
        c.header("payment-required", "this-is-not-base64-json");
        return c.body(null, 402);

      default:
        break;
    }

    if (!paid) {
      c.header("payment-required", challengeHeader(config, quoted(behaviour), url));
      c.header("cache-control", "no-store");
      return c.body(null, 402);
    }

    // Paid branch. These are the cases where money moved and the caller is still
    // left with nothing usable.
    c.header("x-payment-response", fakeSettlementHeader(`INJECT-${behaviour.toUpperCase()}`));

    if (behaviour === "paid-empty") return c.body("", 200);
    if (behaviour === "wrong-schema") {
      return c.json({ unexpected: true, note: "not the advertised shape" });
    }
    return c.json({ ok: true, behaviour });
  };

  inject.all("/:behaviour", handler);

  return inject;
}
