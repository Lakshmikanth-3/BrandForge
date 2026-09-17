import { describe, expect, it } from "vitest";
import { MAINNET, TESTNET, networkConfig } from "./networks.js";

describe("network constants", () => {
  it("keeps testnet and mainnet fully distinct", () => {
    expect(TESTNET.caip2).not.toBe(MAINNET.caip2);
    expect(TESTNET.usdcAsaId).not.toBe(MAINNET.usdcAsaId);
  });

  it("pins the known USDC asset ids", () => {
    expect(TESTNET.usdcAsaId).toBe("10458941");
    expect(MAINNET.usdcAsaId).toBe("31566704");
  });

  it("resolves by name", () => {
    expect(networkConfig("mainnet").name).toBe("mainnet");
    expect(networkConfig("testnet").name).toBe("testnet");
  });
});

/**
 * Contract test (PRD §19): our assumptions about the facilitator, asserted against
 * the facilitator. Fails loudly if GoPlausible changes a chain id or fee payer,
 * rather than letting us silently settle on the wrong network.
 */
describe("facilitator contract: /supported", () => {
  it("still advertises both Algorand networks with the fee payer we expect", async () => {
    const res = await fetch("https://facilitator.goplausible.xyz/supported");
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      kinds: { network: string; scheme: string; extra?: { feePayer?: string } }[];
    };

    for (const net of [TESTNET, MAINNET]) {
      const kind = body.kinds.find((k) => k.network === net.caip2 && k.scheme === "exact");
      expect(kind, `facilitator no longer supports ${net.name} (${net.caip2})`).toBeDefined();
      expect(kind?.extra?.feePayer).toBe(net.feePayer);
    }
  }, 30_000);
});
