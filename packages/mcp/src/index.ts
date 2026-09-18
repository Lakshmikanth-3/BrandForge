#!/usr/bin/env node
/**
 * Sentry402 MCP server.
 *
 * Exposes each curated x402 service as an agent tool. The agent calls a tool; the
 * bridge checks the budget, pays the service in USDC on Algorand, and returns the
 * result. No wallet, no key, no 402 handling in the agent.
 *
 * Two deliberate restrictions:
 *
 *  - Tool descriptions state the price. An agent choosing between tools should be
 *    able to see what a call costs before it makes one.
 *  - The kill switch is NOT exposed as a tool. An agent must not be able to
 *    disable the guard that limits its own spending. Budget status is readable so
 *    the agent can reason about headroom, but only the operator can halt or
 *    resume, via the API.
 */
import { config as loadDotenv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, EnvError, type AppConfig } from "@sentry402/shared";
import {
  BudgetGuard,
  CURATED,
  DownstreamPayer,
  Store,
  TraceHub,
  TrustEngine,
  type CuratedService,
} from "@sentry402/api";

loadDotenv();

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof EnvError) {
    // stderr, never stdout: stdout is the MCP transport and must stay clean JSON-RPC.
    console.error(`Sentry402 MCP could not start.\n${err.message}`);
    process.exit(1);
  }
  throw err;
}

const store = new Store(process.env["SENTRY402_DB"] ?? "data/sentry402.sqlite");
const guard = new BudgetGuard(store);
const hub = new TraceHub(store, config.network.name);
const trust = new TrustEngine(store);
const payer = new DownstreamPayer(config, store, guard, hub, trust);

/**
 * Advertised price per curated service, in USDC base units.
 *
 * Read from the local registry, which the ingester keeps current, and falls back
 * to refusing rather than guessing. Paying an amount we did not verify is exactly
 * the failure the price-drift check exists to prevent.
 */
function priceFor(service: CuratedService): number | null {
  const row = store
    .services({ allowlistedOnly: true, network: config.network.caip2 })
    .find((s) => s.resourceUrl === service.url);
  if (!row) return null;
  // Prefer the price the endpoint actually asked for when we have probed it.
  return row.probeLiveAmount ?? row.amountBase;
}

const server = new McpServer({ name: "sentry402", version: "0.1.0" });

for (const service of CURATED) {
  const priceHint = (() => {
    const base = priceFor(service);
    return base === null ? "price unknown until the catalog is ingested" : `$${(base / 1e6).toFixed(4)} USDC per call`;
  })();

  server.tool(
    service.label,
    `${service.summary} Paid per call on Algorand (${priceHint}). ` +
      `Settles from the bridge's payer wallet under the operator's budget; ` +
      `returns the service's response plus the settlement transaction id.`,
    // The SDK wants a Zod raw shape, not a JSON Schema object.
    service.method === "POST"
      ? {
          payload: z
            .record(z.unknown())
            .optional()
            .describe("Request body forwarded to the service"),
        }
      : {},
    async (args: { payload?: Record<string, unknown> }) => {
      const amountBase = priceFor(service);
      if (amountBase === null) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Refusing to call ${service.label}: no verified price on record. ` +
                `Run the catalog ingest first — paying an unverified amount is the ` +
                `failure the price check exists to prevent.`,
            },
          ],
        };
      }

      const outcome = await payer.pay(service, amountBase, args.payload ?? null);

      if (!outcome.ok) {
        // An honest error, including a refusal by the budget guard.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `${service.label} failed: ${outcome.error ?? "unknown error"}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                result: outcome.result,
                paid: {
                  amountUsdc: (outcome.amountBase ?? 0) / 1e6,
                  txId: outcome.txId,
                  network: config.network.name,
                  explorerUrl: outcome.txId
                    ? config.network.explorerTxBase + outcome.txId
                    : null,
                },
                latencyMs: outcome.latencyMs,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

server.tool(
  "sentry402_budget",
  "Report the bridge's remaining spend allowance for today, its caps, and whether " +
    "outbound payments are currently halted. Read-only: an agent cannot raise its " +
    "own limits or disable the guard.",
  {},
  async () => {
    const status = guard.status();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              halted: status.halted,
              day: status.day,
              spentTodayUsdc: status.committedTodayBase / 1e6,
              remainingTodayUsdc: status.remainingDayBase / 1e6,
              caps: {
                perCallUsdc: status.limits.perCallBase / 1e6,
                perDayUsdc: status.limits.perDayBase / 1e6,
                perMerchantPerDayUsdc: status.limits.perMerchantPerDayBase / 1e6,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "sentry402_services",
  "List the x402 services this bridge can call, with their verified prices and the " +
    "last probe result for each.",
  {},
  async () => {
    const rows = store.services({ allowlistedOnly: true, network: config.network.caip2 });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            CURATED.map((service) => {
              const row = rows.find((r) => r.resourceUrl === service.url);
              return {
                tool: service.label,
                summary: service.summary,
                priceUsdc: row ? (row.probeLiveAmount ?? row.amountBase) / 1e6 : null,
                lastProbe: row?.probeVerdict ?? "not probed",
                active: row?.active ?? false,
              };
            }),
            null,
            2,
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `sentry402 mcp ready · ${config.network.name} · ${CURATED.length} services · payer ${payer.address}`,
);
