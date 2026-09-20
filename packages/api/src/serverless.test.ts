import { describe, expect, it } from "vitest";
import { loadConfig } from "@sentry402/shared";
import { createApp } from "./app.js";
import { Store } from "./db.js";
import { importSeedServices, rehydrate, type ServicesSeedFile } from "./rehydrate.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Serverless mode: no process that outlives the request.
 *
 * A function has no background timer and cannot hold an event stream open, so the app runs a
 * different way there. These tests pin the differences, and that ordinary mode is unchanged.
 */

const env = {
  NETWORK: "testnet",
  PUBLIC_BASE_URL: "https://example.test",
  FACILITATOR_URL: "https://facilitator.goplausible.xyz",
  MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  PAYER_ADDRESS: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
} satisfies NodeJS.ProcessEnv;

const config = loadConfig(env);

/** Replaces the listener's poll so no real indexer is touched, and counts calls. */
function countPolls(parts: ReturnType<typeof createApp>) {
  const calls = { n: 0 };
  Reflect.set(parts.listener, "poll", async () => {
    calls.n += 1;
    return { scanned: 0, written: 0, latestRound: null };
  });
  return calls;
}

describe("serverless mode", () => {
  it("reports the live stream as unavailable in /api/flow", async () => {
    const { app } = createApp(config, ":memory:", { serverless: true });
    const flow = (await (await app.request("/api/flow")).json()) as { stream: boolean };
    expect(flow.stream).toBe(false);
  });

  it("answers /api/stream with an honest 501 instead of holding a connection open", async () => {
    const { app } = createApp(config, ":memory:", { serverless: true });
    const res = await app.request("/api/stream");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { live: boolean; reason: string };
    expect(body.live).toBe(false);
    expect(body.reason).toMatch(/serverless/);
  });

  it("syncs from the chain before the endpoints that read receipts", async () => {
    const parts = createApp(config, ":memory:", { serverless: true });
    const calls = countPolls(parts);

    await parts.app.request("/api/stats");
    expect(calls.n).toBe(1);
  });

  it("does not sync before endpoints that do not read receipts", async () => {
    const parts = createApp(config, ":memory:", { serverless: true });
    const calls = countPolls(parts);

    for (const path of ["/api/services", "/api/flow", "/api/budget", "/api/traces"]) {
      await parts.app.request(path);
    }
    expect(calls.n).toBe(0);
  });

  it("throttles repeated dashboard polls into a single sync", async () => {
    const parts = createApp(config, ":memory:", { serverless: true });
    const calls = countPolls(parts);

    for (let i = 0; i < 6; i += 1) await parts.app.request("/api/stats");
    await parts.app.request("/api/receipts");
    expect(calls.n).toBe(1);
  });

  it("still answers when the chain sync fails", async () => {
    const parts = createApp(config, ":memory:", { serverless: true });
    Reflect.set(parts.listener, "poll", async () => ({
      scanned: 0,
      written: 0,
      latestRound: null,
      error: "indexer HTTP 503",
    }));

    const res = await parts.app.request("/api/stats");
    expect(res.status).toBe(200);
  });

  it("does not affect the paid routes", async () => {
    const parts = createApp(config, ":memory:", { serverless: true });
    const calls = countPolls(parts);
    expect((await parts.app.request("/v1/orchestrate", { method: "POST" })).status).toBe(402);
    expect(calls.n).toBe(0);
  });
});

describe("ordinary mode is unchanged", () => {
  it("reports the stream as available", async () => {
    const { app } = createApp(config, ":memory:");
    const flow = (await (await app.request("/api/flow")).json()) as { stream: boolean };
    expect(flow.stream).toBe(true);
  });

  it("does not sync on read, because a long-lived process has its own timer", async () => {
    const parts = createApp(config, ":memory:");
    const calls = countPolls(parts);
    await parts.app.request("/api/stats");
    expect(calls.n).toBe(0);
  });
});

describe("importSeedServices", () => {
  const seed = (over: Partial<ServicesSeedFile> = {}): ServicesSeedFile => ({
    version: 1,
    exportedAt: "2026-09-20T00:00:00.000Z",
    network: "testnet",
    services: [
      {
        resourceUrl: "https://a.test/x",
        method: "GET",
        description: "d",
        payTo: "PAY",
        network: "algorand:test",
        amountBase: 5_000,
        assetId: "10458941",
        settleCount: 3,
        lastSeen: "2026-09-19T00:00:00.000Z",
        hasDiscoveryInfo: true,
        discoveryInput: { hash: "x" },
        active: true,
        probeVerdict: "ok",
        probeStatus: 402,
        probeLatencyMs: 412,
        probeLiveAmount: 5_000,
        probeDrift: 1,
        probeColdStart: false,
        probeDetail: null,
        probedAt: "2026-09-19T12:34:56.000Z",
      },
    ],
    ...over,
  });

  it("restores the registry into an empty database", () => {
    const store = new Store(":memory:");
    expect(importSeedServices(store, seed(), "testnet").imported).toBe(1);
    const row = store.services({ activeOnly: false })[0]!;
    expect(row.resourceUrl).toBe("https://a.test/x");
    expect(row.allowlisted).toBe(true);
    expect(row.probeVerdict).toBe("ok");
    expect(row.discoveryInput).toEqual({ hash: "x" });
  });

  it("keeps the ORIGINAL probe time rather than stamping it as just run", () => {
    // Showing a day-old probe as fresh would be a false claim about how current the
    // verification is.
    const store = new Store(":memory:");
    importSeedServices(store, seed(), "testnet");
    expect(store.services({ activeOnly: false })[0]!.probedAt).toBe("2026-09-19T12:34:56.000Z");
  });

  it("never overwrites a populated registry", () => {
    const store = new Store(":memory:");
    importSeedServices(store, seed(), "testnet");
    const second = importSeedServices(store, seed(), "testnet");
    expect(second.imported).toBe(0);
    expect(second.reason).toMatch(/not overwriting/);
  });

  it("refuses a seed for another network", () => {
    const store = new Store(":memory:");
    expect(importSeedServices(store, seed({ network: "mainnet" }), "testnet").imported).toBe(0);
  });

  it.each([null, "x", {}, { version: 2, network: "testnet", services: [] }])(
    "ignores a malformed seed (%j) without throwing",
    (bad) => {
      const store = new Store(":memory:");
      expect(() => importSeedServices(store, bad, "testnet")).not.toThrow();
      expect(importSeedServices(store, bad, "testnet").imported).toBe(0);
    },
  );

  it("leaves probe fields empty for a service that was never probed", () => {
    const store = new Store(":memory:");
    const base = seed();
    base.services[0]!.probeVerdict = null;
    importSeedServices(store, base, "testnet");
    expect(store.services({ activeOnly: false })[0]!.probeVerdict).toBeNull();
  });
});

describe("rehydrate without an ingester", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "sentry402-sl-"));

  it("restores from snapshots only, touching no network", async () => {
    const d = dir();
    const servicesPath = join(d, "services.json");
    writeFileSync(
      servicesPath,
      JSON.stringify({
        version: 1,
        exportedAt: "2026-09-20T00:00:00.000Z",
        network: "testnet",
        services: [],
      }),
    );

    const store = new Store(":memory:");
    const result = await rehydrate(store, null, "testnet", {
      seedPath: join(d, "absent.json"),
      servicesSeedPath: servicesPath,
    });

    expect(result.catalog).toBeNull();
    expect(result.probesTotal).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("reports a corrupt services seed without failing the boot", async () => {
    const d = dir();
    const servicesPath = join(d, "services.json");
    writeFileSync(servicesPath, "{ not json");
    const store = new Store(":memory:");
    const result = await rehydrate(store, null, "testnet", {
      seedPath: join(d, "absent.json"),
      servicesSeedPath: servicesPath,
    });
    expect(result.errors.join(" ")).toMatch(/services seed/);
  });
});

describe("the committed services seed", () => {
  it("is a valid snapshot of the curated set", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync("seed/services.json")) return;
    const parsed = JSON.parse(readFileSync("seed/services.json", "utf8")) as ServicesSeedFile;
    expect(parsed.version).toBe(1);
    expect(parsed.services.length).toBeGreaterThanOrEqual(4);
    for (const s of parsed.services) expect(s.resourceUrl).toMatch(/^https:\/\//);
  });
});
