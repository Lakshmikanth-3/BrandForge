/**
 * Domain metadata the facilitator reads.
 *
 * Per the facilitator's own guide, merchant identity is derived from the
 * endpoint's domain metadata when the x402-merchant extension is not declared:
 * OpenGraph tags, llms.txt, or agent-card.json. Note this is NOT an MCP manifest
 * — that was an assumption worth checking, and it was wrong.
 *
 * Accuracy beats presentation here: this feeds the Bazaar listing, the enrichment
 * pass runs at most daily, and a wrong price or URL propagates into the directory.
 * Treat it as part of the API contract.
 */
import { Hono } from "hono";
import type { AppConfig } from "@sentry402/shared";
import { PRICES, ROUTE_PATHS } from "./x402.js";

const NAME = "Sentry402";
const SUMMARY =
  "Agentic x402 bridge and trust layer on Algorand. Discovers x402 services, " +
  "verifies they deliver before paying, and settles per call in USDC under a budget.";

export function metadataRoutes(config: AppConfig): Hono {
  const meta = new Hono();
  const base = config.publicBaseUrl;

  meta.get("/llms.txt", (c) => {
    c.header("content-type", "text/plain; charset=utf-8");
    return c.body(
      [
        `# ${NAME}`,
        "",
        `> ${SUMMARY}`,
        "",
        "## Paid endpoints",
        "",
        `- POST ${base}${ROUTE_PATHS.orchestrate} (${PRICES.orchestrate} USDC) — route an`,
        `  agent's request to a verified x402 service and return the paid result with a receipt.`,
        `- GET ${base}${ROUTE_PATHS.trust}?url=<endpoint> (${PRICES.trust} USDC) — the`,
        `  reliability record for any x402 endpoint, built from calls this bridge routed`,
        `  and paid for. Endpoints with too few observations are reported as unrated.`,
        "",
        "## Payment",
        "",
        `- Protocol: x402 (version 2), scheme "exact"`,
        `- Network: ${config.network.name} (CAIP-2 ${config.network.caip2})`,
        `- Asset: USDC, ASA ${config.network.usdcAsaId}`,
        `- Facilitator: ${config.facilitatorUrl}`,
        "- No API key and no account. Send the request, receive HTTP 402, pay, retry.",
        "",
        "## Notes",
        "",
        "- Reliability records are built only from calls this bridge actually routed.",
        "- An unrated service is reported as unrated rather than given a made-up score.",
        "",
      ].join("\n"),
    );
  });

  /**
   * A2A-style agent card. Kept minimal and truthful: it advertises only what is
   * live, so a phase that has not shipped is not listed.
   */
  meta.get("/.well-known/agent-card.json", (c) =>
    c.json({
      name: NAME,
      description: SUMMARY,
      url: base,
      version: "0.1.0",
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [
        {
          id: "trust",
          name: "Check whether an endpoint actually delivers",
          description:
            "Given an x402 endpoint url, return its reliability record: a composite " +
            "score, the observation count behind it, success rate, how often it took " +
            "payment and returned nothing, and median latency. Unrated when there is " +
            "not enough evidence to score it.",
          tags: ["x402", "algorand", "reputation", "reliability"],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
        {
          id: "orchestrate",
          name: "Pay an x402 service on my behalf",
          description:
            "Given a target x402 endpoint, check its reliability record, pay it in " +
            "USDC on Algorand, and return the response with a settlement receipt.",
          tags: ["x402", "algorand", "payments", "orchestrator"],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
      ],
      payment: {
        protocol: "x402",
        x402Version: 2,
        network: config.network.caip2,
        asset: config.network.usdcAsaId,
        facilitator: config.facilitatorUrl,
        routes: [
          {
            method: "POST",
            path: ROUTE_PATHS.orchestrate,
            price: PRICES.orchestrate,
          },
          {
            method: "GET",
            path: ROUTE_PATHS.trust,
            price: PRICES.trust,
          },
        ],
      },
    }),
  );

  return meta;
}
