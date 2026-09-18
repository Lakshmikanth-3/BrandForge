import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import algosdk from "algosdk";
import { loadConfig } from "@sentry402/shared";
import { Store } from "./db.js";
import { BudgetGuard } from "./budget.js";
import { TraceHub } from "./trace.js";
import { TrustEngine } from "./trust.js";
import { DownstreamPayer } from "./payer.js";
import { INJECT_EXPECTED_BASE, mountInjectRoutes } from "./inject.js";
import type { CuratedService } from "./catalog.js";
import { Hono } from "hono";

/**
 * Failure-injection suite (PRD §19).
 *
 * Drives the real payer over real HTTP against deliberately broken endpoints. Not
 * a mocked fetch: the point is to exercise the code path an actual downstream
 * failure takes, including timeouts and header parsing.
 *
 * Every store here is in-memory, so nothing these broken endpoints return can land
 * in the real receipt or outcome tables.
 */

const account = algosdk.generateAccount();
let baseUrl = "";
let server: ReturnType<typeof serve>;

function configFor(publicBaseUrl: string) {
  return loadConfig({
    NETWORK: "testnet",
    PUBLIC_BASE_URL: publicBaseUrl,
    FACILITATOR_URL: "https://facilitator.goplausible.xyz",
    MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
    PAYER_ADDRESS: account.addr.toString(),
    PAYER_MNEMONIC: algosdk.secretKeyToMnemonic(account.sk),
  });
}

beforeAll(async () => {
  const bootConfig = configFor("http://127.0.0.1:0");
  const app = new Hono();
  const inject = mountInjectRoutes(bootConfig);
  if (!inject) throw new Error("injection routes must exist on testnet");
  app.route("/__inject", inject);

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      baseUrl = `http://127.0.0.1:${(info as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe("injection endpoints exist only on TestNet", () => {
  it("is null on mainnet, because a route that misbehaves has no place on the probed domain", () => {
    const mainnet = loadConfig({
      NETWORK: "mainnet",
      PUBLIC_BASE_URL: "https://example.test",
      FACILITATOR_URL: "https://facilitator.goplausible.xyz",
      MERCHANT_ADDRESS: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
      PAYER_ADDRESS: account.addr.toString(),
      PAYER_MNEMONIC: algosdk.secretKeyToMnemonic(account.sk),
    });
    expect(mountInjectRoutes(mainnet)).toBeNull();
  });

  it("is mounted on testnet", () => {
    expect(mountInjectRoutes(configFor("https://example.test"))).not.toBeNull();
  });
});

describe("failure injection: the bridge against broken downstreams", () => {
  let store: Store;
  let guard: BudgetGuard;
  let hub: TraceHub;
  let trust: TrustEngine;
  let payer: DownstreamPayer;

  beforeEach(() => {
    store = new Store(":memory:");
    guard = new BudgetGuard(store);
    hub = new TraceHub(store, "testnet");
    trust = new TrustEngine(store);
    payer = new DownstreamPayer(configFor(baseUrl), store, guard, hub, trust);
  });

  const broken = (behaviour: string, method: "GET" | "POST" = "POST"): CuratedService => ({
    url: `${baseUrl}/__inject/${behaviour}`,
    method,
    label: `inject_${behaviour.replace(/-/g, "_")}`,
    summary: `Deliberately broken: ${behaviour}`,
  });

  const stepState = (id: string) =>
    hub.recent(1)[0]!.steps.find((s) => s.id === id)!.state;

  it("sends no payment when the downstream errors before quoting a price", async () => {
    const outcome = await payer.pay(broken("error-before-402"), INJECT_EXPECTED_BASE, {});

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/expected 402 before paying, got HTTP 500/);
    // No money moved and no headroom stays consumed.
    expect(guard.status().committedTodayBase).toBe(0);
    expect(store.receipts({ direction: "out" })).toHaveLength(0);
    expect(store.outcomes(broken("error-before-402").url)[0]!.settled).toBe(false);
    expect(stepState("challenge")).toBe("failed");
    expect(stepState("payment")).toBe("skipped");
  });

  it("refuses a price that jumped since the registry was built", async () => {
    const service = broken("price-jump");
    const outcome = await payer.pay(service, INJECT_EXPECTED_BASE, {});

    expect(outcome.ok).toBe(false);
    expect(outcome.refusedByPriceAnomaly).toBe(true);
    expect(outcome.error).toMatch(/price anomaly/);
    expect(outcome.error).toMatch(/x8\.00/);
    expect(guard.status().committedTodayBase).toBe(0);
    expect(stepState("challenge")).toBe("failed");
  });

  it("refuses a price that dropped just as readily", async () => {
    // A quarter of the expected price is equally a sign the registry is wrong.
    const outcome = await payer.pay(broken("price-drop"), INJECT_EXPECTED_BASE, {});
    expect(outcome.refusedByPriceAnomaly).toBe(true);
    expect(outcome.error).toMatch(/x0\.25/);
  });

  it("refuses a 402 whose challenge cannot be parsed", async () => {
    const outcome = await payer.pay(broken("malformed-challenge"), INJECT_EXPECTED_BASE, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no price for our network/);
    expect(guard.status().committedTodayBase).toBe(0);
  });

  it("treats a vanished route as a failure without paying", async () => {
    const outcome = await payer.pay(broken("vanished"), INJECT_EXPECTED_BASE, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/got HTTP 404/);
    expect(store.receipts({ direction: "out" })).toHaveLength(0);
  });

  it("times out on a service that never responds, without hanging the agent", async () => {
    const service = broken("slow");
    const startedAt = Date.now();
    const outcome = await payer.pay(service, INJECT_EXPECTED_BASE, {});
    const elapsed = Date.now() - startedAt;

    expect(outcome.ok).toBe(false);
    // The pre-flight budget is 30s; the endpoint sleeps 90s. The agent must not wait.
    expect(elapsed).toBeLessThan(45_000);
    expect(guard.status().committedTodayBase).toBe(0);
    expect(store.outcomes(service.url)[0]!.ok).toBe(false);
  }, 60_000);

  it("records a failure on every broken path, so the score reflects reality", async () => {
    for (const behaviour of ["error-before-402", "vanished", "price-jump"]) {
      await payer.pay(broken(behaviour), INJECT_EXPECTED_BASE, {});
    }
    // Three distinct services, one observation each.
    for (const behaviour of ["error-before-402", "vanished", "price-jump"]) {
      const recorded = store.outcomes(broken(behaviour).url);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.ok).toBe(false);
      expect(recorded[0]!.failureReason).toBeTruthy();
    }
  });

  it("degrades a repeatedly broken endpoint until the trust gate refuses it", async () => {
    // The whole point of the engine: a deliberately broken endpoint ends up refused
    // from its own record, with no manual intervention.
    const service = broken("vanished");
    for (let i = 0; i < 6; i += 1) {
      await payer.pay(service, INJECT_EXPECTED_BASE, {});
    }

    const record = trust.recordFor(service.url);
    expect(record.observations).toBeGreaterThanOrEqual(5);
    expect(record.verdict).toBe("refuse");

    const blocked = await payer.pay(service, INJECT_EXPECTED_BASE, {});
    expect(blocked.refusedByTrust).toBe(true);
    // A refusal costs nothing: no further observation, no network call.
    expect(stepState("trust")).toBe("failed");
  }, 30_000);

  it("keeps a broken endpoint out of the real tables", async () => {
    // These stores are in-memory; the assertion documents the intent.
    await payer.pay(broken("vanished"), INJECT_EXPECTED_BASE, {});
    expect(store.stats().settleCount).toBe(0);
    expect(store.stats().outboundCount).toBe(0);
  });
});
