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
import type { MiddlewareHandler } from "hono";
import { CHALLENGE_TAG, type AppConfig } from "@sentry402/shared";

/** Price points per PRD §7 item 6, set against a $0.02 catalog median. */
export const PRICES = {
  orchestrate: "$0.05",
  trust: "$0.02",
} as const;

export const ROUTE_PATHS = {
  orchestrate: "/v1/orchestrate",
  trust: "/v1/trust",
} as const;

export function buildResourceServer(config: AppConfig) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  // caip2 is a plain string in shared/ so the constants stay data, not types.
  return new x402ResourceServer(facilitatorClient).register(
    config.network.caip2 as `${string}:${string}`,
    new ExactAvmScheme(),
  );
}

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
    },
  };
}

export function x402Middleware(config: AppConfig): MiddlewareHandler {
  const server = buildResourceServer(config);
  return paymentMiddleware(paidRoutes(config), server) as MiddlewareHandler;
}
