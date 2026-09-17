import { describe, expect, it } from "vitest";
import { loadConfig } from "@sentry402/shared";
import { createApp } from "./app.js";

const env = {
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
  PAYER_MNEMONIC: Array.from({ length: 25 }, (_, i) => `word${i}`).join(" "),
  BUILD_SHA: "test-sha",
} satisfies NodeJS.ProcessEnv;

const { app } = createApp(loadConfig(env), ":memory:");

describe("/livez", () => {
  it("answers without touching the network", async () => {
    const res = await app.request("/livez");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alive: true, buildSha: "test-sha" });
  });
});

describe("/healthz contract", () => {
  it("returns the documented shape", async () => {
    const res = await app.request("/healthz");
    expect([200, 503]).toContain(res.status);

    const body = await res.json();
    expect(body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded)$/),
      config: {
        network: "testnet",
        usdcAsaId: "10458941",
        merchantAddress: env.MERCHANT_ADDRESS,
        payerAddress: env.PAYER_ADDRESS,
        buildSha: "test-sha",
      },
      accounts: {
        merchant: { address: env.MERCHANT_ADDRESS, funded: expect.any(Boolean), usdcOptedIn: expect.any(Boolean) },
        payer: { address: env.PAYER_ADDRESS, funded: expect.any(Boolean), usdcOptedIn: expect.any(Boolean) },
      },
    });
    expect(Array.isArray(body.dependencies)).toBe(true);
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
  }, 30_000);

  it("never leaks key material", async () => {
    const res = await app.request("/healthz");
    const text = await res.text();
    expect(text).not.toContain("word0");
    expect(text.toLowerCase()).not.toContain("mnemonic");
  }, 30_000);

  it("sets the CORS header the facilitator probe checks", async () => {
    const res = await app.request("/healthz", { headers: { Origin: "https://x.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  }, 30_000);
});
