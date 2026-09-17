/**
 * MCP server — Phase 3.
 *
 * Adapted from x402-demo/x402-examples/client/mcp: an McpServer over
 * StdioServerTransport whose tools call downstream x402 endpoints through
 * `wrapAxiosWithPayment`, so the agent never handles a payment itself.
 *
 * Deliberately empty until Phase 2 lands the curated catalog that defines the
 * tool set. Phase 0 only reserves the package boundary.
 */
import { networkConfig, type NetworkName } from "@sentry402/shared";

export function plannedToolNamespace(network: NetworkName): string {
  return `sentry402.${networkConfig(network).name}`;
}
