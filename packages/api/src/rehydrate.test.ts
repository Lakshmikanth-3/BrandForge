import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.js";
import { TrustEngine, type Outcome } from "./trust.js";
import { CatalogIngester } from "./catalog.js";
import { TESTNET } from "@sentry402/shared";
import { importSeedOutcomes, isSeedFile, rehydrate, type SeedFile } from "./rehydrate.js";

/**
 * Rebuilding state on a host that loses its disk.
 *
 * The hosted server runs on an ephemeral filesystem, so every restart begins with an
 * empty database. These tests are about what that server looks like in the first seconds
 * of that life: does it get its trust record back, does it refuse to overwrite live data,
 * and does one failing step leave the others alone.
 */

const URL_A = "https://a.test/x";

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  resourceUrl: URL_A,
  at: "2026-09-18T00:00:00.000Z",
  ok: true,
  httpStatus: 200,
  latencyMs: 300,
  settled: true,
  schemaOk: null,
  coldStart: false,
  failureReason: null,
  ...over,
});

const seedOf = (outcomes: Outcome[], network = "testnet"): SeedFile => ({
  version: 1,
  exportedAt: "2026-09-19T00:00:00.000Z",
  network,
  outcomes,
});

describe("importSeedOutcomes", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("imports into an empty table", () => {
    const result = importSeedOutcomes(store, seedOf([outcome(), outcome()]), "testnet");
    expect(result.imported).toBe(2);
    expect(store.outcomeCount()).toBe(2);
  });

  it("never overwrites live data with a stale snapshot", () => {
    // The safety property: on a durable disk, or once the server has recorded anything of
    // its own, an old file must not be layered over it.
    store.putOutcome({ ...outcome({ at: "2026-09-19T12:00:00.000Z" }), clientError: false });
    const result = importSeedOutcomes(store, seedOf([outcome(), outcome()]), "testnet");
    expect(result.imported).toBe(0);
    expect(result.reason).toMatch(/not overwriting/);
    expect(store.outcomeCount()).toBe(1);
  });

  it("refuses a snapshot from another network", () => {
    // Observations from TestNet describe TestNet endpoints and prices.
    const result = importSeedOutcomes(store, seedOf([outcome()], "mainnet"), "testnet");
    expect(result.imported).toBe(0);
    expect(result.reason).toMatch(/mainnet.*testnet/);
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["an object with no version", { outcomes: [] }],
    ["a future version", { version: 2, network: "testnet", outcomes: [] }],
    ["outcomes that are not an array", { version: 1, network: "testnet", outcomes: "x" }],
  ])("ignores %s without throwing", (_label, bad) => {
    expect(() => importSeedOutcomes(store, bad, "testnet")).not.toThrow();
    expect(importSeedOutcomes(store, bad, "testnet").imported).toBe(0);
  });

  it("skips a malformed row but keeps the good ones", () => {
    const seed = seedOf([
      outcome(),
      { ...outcome(), resourceUrl: 5 as unknown as string },
      outcome(),
    ]);
    expect(importSeedOutcomes(store, seed, "testnet").imported).toBe(2);
  });

  it("preserves recency, which the trust score depends on", () => {
    // A score weights recent behaviour above old, so importing in the wrong order would
    // quietly change every score. The newest observation must still read as newest.
    importSeedOutcomes(
      store,
      seedOf([
        outcome({ at: "2026-09-18T00:00:03.000Z", latencyMs: 3 }),
        outcome({ at: "2026-09-18T00:00:01.000Z", latencyMs: 1 }),
        outcome({ at: "2026-09-18T00:00:02.000Z", latencyMs: 2 }),
      ]),
      "testnet",
    );
    expect(store.outcomes(URL_A).map((o) => o.latencyMs)).toEqual([3, 2, 1]);
  });

  it("carries the client-error flag, so a service is not re-condemned for our bugs", () => {
    importSeedOutcomes(
      store,
      seedOf([
        ...Array.from({ length: 10 }, () =>
          outcome({ ok: false, settled: false, clientError: true }),
        ),
        ...Array.from({ length: 6 }, () => outcome()),
      ]),
      "testnet",
    );
    const record = new TrustEngine(store).recordFor(URL_A);
    expect(record.observations).toBe(6);
    expect(record.clientErrorCount).toBe(10);
    expect(record.verdict).not.toBe("refuse");
  });

  it("yields the same score before and after a round trip through the file", () => {
    const original = new Store(":memory:");
    for (let i = 0; i < 12; i += 1) {
      original.putOutcome({
        ...outcome({ at: `2026-09-18T00:00:${String(i).padStart(2, "0")}.000Z`, ok: i % 4 !== 0 }),
        clientError: false,
      });
    }
    const before = new TrustEngine(original).recordFor(URL_A);

    const seed = seedOf(original.allOutcomes());
    const revived = new Store(":memory:");
    importSeedOutcomes(revived, JSON.parse(JSON.stringify(seed)), "testnet");
    const after = new TrustEngine(revived).recordFor(URL_A);

    // A record that changes when the server restarts would be a record nobody could trust.
    expect(after.score).toBe(before.score);
    expect(after.observations).toBe(before.observations);
    expect(after.verdict).toBe(before.verdict);
  });
});

describe("isSeedFile", () => {
  it("accepts a well-formed file", () => expect(isSeedFile(seedOf([]))).toBe(true));
  it("rejects garbage", () => {
    expect(isSeedFile(undefined)).toBe(false);
    expect(isSeedFile(42)).toBe(false);
    expect(isSeedFile({ version: 1 })).toBe(false);
  });
});

describe("rehydrate", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "sentry402-seed-"));

  /** An ingester whose network calls are stubbed, so no real catalog is touched. */
  const ingesterWith = (store: Store, behaviour: "ok" | "catalog-down" | "throws") => {
    const ingester = new CatalogIngester(TESTNET, store, "https://facilitator.example");
    Reflect.set(ingester, "ingest", async () => {
      if (behaviour === "throws") throw new Error("boom");
      if (behaviour === "catalog-down") {
        return {
          fetched: 0,
          normalised: 0,
          skipped: 0,
          allowlisted: 0,
          markedInactive: 0,
          error: "HTTP 503",
        };
      }
      return { fetched: 100, normalised: 40, skipped: 60, allowlisted: 6, markedInactive: 0 };
    });
    Reflect.set(ingester, "verifyAllowlisted", async () => [
      { url: "a", result: { verdict: "ok" } },
      { url: "b", result: { verdict: "wrong_network" } },
    ]);
    return ingester;
  };

  it("restores the trust snapshot and the catalog into a brand new database", async () => {
    // The whole scenario: the host wiped its disk, and this is the first boot after.
    const path = join(dir(), "outcomes.json");
    writeFileSync(path, JSON.stringify(seedOf(Array.from({ length: 8 }, () => outcome()))));

    const store = new Store(":memory:");
    const result = await rehydrate(store, ingesterWith(store, "ok"), "testnet", {
      seedPath: path,
      servicesSeedPath: join(dir(), "absent-services.json"),
    });

    expect(result.seedImported).toBe(8);
    expect(result.catalog).toMatchObject({ normalised: 40, allowlisted: 6 });
    expect(result.probesOk).toBe(1);
    expect(result.probesTotal).toBe(2);
    expect(result.errors).toEqual([]);
    // The record is real again the moment the server is up, not `unrated`.
    expect(new TrustEngine(store).recordFor(URL_A).verdict).toBe("pass");
  });

  it("still loads the trust snapshot when the catalog is unreachable", async () => {
    // Independent steps: an unreachable facilitator must not cost us the trust record.
    const path = join(dir(), "outcomes.json");
    writeFileSync(path, JSON.stringify(seedOf(Array.from({ length: 8 }, () => outcome()))));

    const store = new Store(":memory:");
    const result = await rehydrate(store, ingesterWith(store, "catalog-down"), "testnet", {
      seedPath: path,
      servicesSeedPath: join(dir(), "absent-services.json"),
    });

    expect(result.seedImported).toBe(8);
    expect(result.errors.join(" ")).toMatch(/catalog: HTTP 503/);
  });

  it("survives an ingester that throws", async () => {
    const store = new Store(":memory:");
    const result = await rehydrate(store, ingesterWith(store, "throws"), "testnet", {
      seedPath: join(dir(), "absent.json"),
      servicesSeedPath: join(dir(), "absent-services.json"),
    });
    expect(result.errors.join(" ")).toMatch(/boom/);
  });

  it("boots fine with no seed file at all", async () => {
    const store = new Store(":memory:");
    const result = await rehydrate(store, ingesterWith(store, "ok"), "testnet", {
      seedPath: join(dir(), "absent.json"),
      servicesSeedPath: join(dir(), "absent-services.json"),
    });
    expect(result.seedImported).toBe(0);
    expect(result.seedReason).toBe("no seed file");
    expect(result.catalog).not.toBeNull();
  });

  it("reports a corrupt seed file instead of crashing the boot", async () => {
    const path = join(dir(), "outcomes.json");
    writeFileSync(path, "{ this is not json");
    const store = new Store(":memory:");
    const result = await rehydrate(store, ingesterWith(store, "ok"), "testnet", {
      seedPath: path,
      servicesSeedPath: join(dir(), "absent-services.json"),
    });
    expect(result.seedImported).toBe(0);
    expect(result.errors.join(" ")).toMatch(/seed:/);
    // The catalog step still ran.
    expect(result.catalog).not.toBeNull();
  });

  it("is safe to run twice, so a restart loop cannot double the record", async () => {
    const path = join(dir(), "outcomes.json");
    writeFileSync(path, JSON.stringify(seedOf(Array.from({ length: 6 }, () => outcome()))));
    const store = new Store(":memory:");
    const ingester = ingesterWith(store, "ok");

    await rehydrate(store, ingester, "testnet", {
      seedPath: path,
      servicesSeedPath: join(dir(), "absent-services.json"),
    });
    const second = await rehydrate(store, ingester, "testnet", {
      seedPath: path,
      servicesSeedPath: join(dir(), "absent-services.json"),
    });

    expect(second.seedImported).toBe(0);
    expect(store.outcomeCount()).toBe(6);
  });
});

describe("the committed seed file", () => {
  it("is a valid snapshot of real observations", () => {
    if (!existsSync("seed/outcomes.json")) return; // a fresh clone before the first export
    const parsed: unknown = JSON.parse(readFileSync("seed/outcomes.json", "utf8"));
    expect(isSeedFile(parsed)).toBe(true);
    const seed = parsed as SeedFile;
    expect(seed.outcomes.length).toBeGreaterThan(0);
    // Real calls, so real timestamps: nothing in the future, nothing dated before this
    // project existed.
    for (const o of seed.outcomes) {
      expect(Date.parse(o.at)).toBeGreaterThan(Date.parse("2026-09-01"));
      expect(Date.parse(o.at)).toBeLessThan(Date.now() + 86_400_000);
    }
  });

  it("carries nothing that looks like key material", () => {
    if (!existsSync("seed/outcomes.json")) return;
    const text = readFileSync("seed/outcomes.json", "utf8");
    expect(text).not.toMatch(/\b([a-z]+ ){24}[a-z]+\b/); // a 25-word phrase
    expect(text.toLowerCase()).not.toContain("mnemonic");
  });
});
