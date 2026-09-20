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

describe("running on a host that injects its own URL, without a payer key", () => {
  // The public server never pays anyone: it sells the paid routes and serves the site.
  // Requiring the payer's mnemonic meant a deployed server had to hold a funded wallet's
  // secret on a free third-party host for no reason.
  const withoutMnemonic = (() => {
    const { PAYER_MNEMONIC: _drop, ...rest } = base;
    return rest;
  })();

  it("boots without a PAYER_MNEMONIC", () => {
    const c = loadConfig({ ...withoutMnemonic });
    expect(c.secrets.payerMnemonic).toBeNull();
  });

  it("treats an empty PAYER_MNEMONIC as absent rather than as a bad key", () => {
    expect(loadConfig({ ...base, PAYER_MNEMONIC: "" }).secrets.payerMnemonic).toBeNull();
  });

  it("still rejects a mnemonic that is set but the wrong length", () => {
    expect(() => loadConfig({ ...base, PAYER_MNEMONIC: "only three words" })).toThrow(
      /25 words when set/,
    );
  });

  it("still never serialises a mnemonic that IS set", () => {
    const c = loadConfig({ ...base });
    expect(JSON.stringify(publicConfig(c))).not.toContain("word0");
  });

  it("takes PUBLIC_BASE_URL from RENDER_EXTERNAL_URL when it is not set", () => {
    // The domain only exists after the first deploy, so it cannot be pasted in first.
    const { PUBLIC_BASE_URL: _drop, ...rest } = base;
    const c = loadConfig({ ...rest, RENDER_EXTERNAL_URL: "https://sentry402.onrender.com" });
    expect(c.publicBaseUrl).toBe("https://sentry402.onrender.com");
  });

  it("lets an explicit PUBLIC_BASE_URL win, which is what a custom domain uses", () => {
    const c = loadConfig({
      ...base,
      PUBLIC_BASE_URL: "https://sentry402.example",
      RENDER_EXTERNAL_URL: "https://sentry402.onrender.com",
    });
    expect(c.publicBaseUrl).toBe("https://sentry402.example");
  });

  it("still requires SOME public url", () => {
    const { PUBLIC_BASE_URL: _drop, ...rest } = base;
    expect(() => loadConfig({ ...rest })).toThrow(EnvError);
  });
});

describe("on Vercel", () => {
  const { PUBLIC_BASE_URL: _drop, ...noUrl } = base;

  it("takes the public url from VERCEL_PROJECT_PRODUCTION_URL, adding the scheme", () => {
    // Vercel injects a bare host with no scheme.
    const c = loadConfig({ ...noUrl, VERCEL_PROJECT_PRODUCTION_URL: "sentry402.vercel.app" });
    expect(c.publicBaseUrl).toBe("https://sentry402.vercel.app");
  });

  it("lets an explicit PUBLIC_BASE_URL win, which a custom domain will use", () => {
    const c = loadConfig({
      ...base,
      PUBLIC_BASE_URL: "https://sentry402.example",
      VERCEL_PROJECT_PRODUCTION_URL: "sentry402.vercel.app",
    });
    expect(c.publicBaseUrl).toBe("https://sentry402.example");
  });

  it("uses the PRODUCTION alias, not the per-deployment URL", () => {
    // VERCEL_URL names the specific deployment, and a preview URL must never be the one the
    // facilitator catalogs.
    const c = loadConfig({
      ...noUrl,
      VERCEL_URL: "sentry402-abc123-someone.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "sentry402.vercel.app",
    });
    expect(c.publicBaseUrl).toBe("https://sentry402.vercel.app");
    expect(c.publicBaseUrl).not.toContain("abc123");
  });

  it("does not invent a url from VERCEL_URL alone", () => {
    expect(() => loadConfig({ ...noUrl, VERCEL_URL: "sentry402-abc123.vercel.app" })).toThrow(
      EnvError,
    );
  });
});
