import { describe, expect, it } from "vitest";
import { loadConfig, publicConfig, EnvError } from "./env.js";
import { MAINNET, TESTNET } from "./networks.js";

const ADDR_A = "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4".slice(0, 58);
const ADDR_B = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const MNEMONIC = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");

const base = {
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: ADDR_A,
  PAYER_ADDRESS: ADDR_B,
  PAYER_MNEMONIC: MNEMONIC,
} satisfies NodeJS.ProcessEnv;

describe("loadConfig — NETWORK switch", () => {
  it("accepts testnet and derives testnet constants", () => {
    const c = loadConfig({ ...base });
    expect(c.network.name).toBe("testnet");
    expect(c.network.usdcAsaId).toBe(TESTNET.usdcAsaId);
    expect(c.network.caip2).toBe(TESTNET.caip2);
  });

  it("accepts mainnet and derives mainnet constants from the same one variable", () => {
    const c = loadConfig({ ...base, NETWORK: "mainnet" });
    expect(c.network.usdcAsaId).toBe(MAINNET.usdcAsaId);
    expect(c.network.caip2).toBe(MAINNET.caip2);
    expect(c.network.usdcAsaId).not.toBe(TESTNET.usdcAsaId);
  });

  it("rejects a missing NETWORK", () => {
    const { NETWORK: _drop, ...noNetwork } = base;
    expect(() => loadConfig(noNetwork)).toThrow(EnvError);
  });

  it("rejects an invalid NETWORK rather than defaulting to one", () => {
    expect(() => loadConfig({ ...base, NETWORK: "betanet" })).toThrow(/NETWORK must be one of/);
  });
});

describe("loadConfig — validation", () => {
  it.each([
    ["MERCHANT_ADDRESS", "too-short"],
    ["PAYER_ADDRESS", "lowercase" + "a".repeat(49)],
    ["PUBLIC_BASE_URL", "not-a-url"],
    ["FACILITATOR_URL", "also-not-a-url"],
  ])("rejects a bad %s", (key, value) => {
    expect(() => loadConfig({ ...base, [key]: value })).toThrow(EnvError);
  });

  it("rejects a mnemonic that is not 25 words", () => {
    expect(() => loadConfig({ ...base, PAYER_MNEMONIC: "only three words" })).toThrow(
      /25 words/,
    );
  });

  it("reports every problem at once, not just the first", () => {
    try {
      loadConfig({ ...base, MERCHANT_ADDRESS: "bad", PUBLIC_BASE_URL: "bad" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as EnvError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("prefers Railway's commit sha over BUILD_SHA when present", () => {
    const c = loadConfig({ ...base, BUILD_SHA: "local", RAILWAY_GIT_COMMIT_SHA: "abc123" });
    expect(c.buildSha).toBe("abc123");
  });
});

describe("publicConfig — secret containment", () => {
  it("never serialises the payer mnemonic", () => {
    const c = loadConfig({ ...base });
    const serialised = JSON.stringify(publicConfig(c));
    expect(serialised).not.toContain("word0");
    expect(serialised).not.toContain("mnemonic");
    expect(Object.keys(publicConfig(c))).not.toContain("secrets");
  });
});
