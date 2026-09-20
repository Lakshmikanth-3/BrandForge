import { describe, expect, it } from "vitest";
import { SYNC_BEFORE_PATHS, ThrottledSync } from "./sync.js";

/**
 * On-demand chain sync for hosts with no background timer.
 *
 * The properties that matter are the ones that protect the indexer and the request: many
 * requests must not become many syncs, a failing indexer must not take the read API down, and
 * a slow one must not make every dashboard poll hang.
 */

/** A controllable clock, so "inside the window" is exact rather than timing-dependent. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("ThrottledSync", () => {
  it("runs a sync on the first request", async () => {
    let runs = 0;
    const sync = new ThrottledSync(async () => {
      runs += 1;
      return {};
    });
    await sync.ensureFresh();
    expect(runs).toBe(1);
  });

  it("serves every request inside the window from one sync", async () => {
    // A dashboard polling every few seconds must not become a request to the indexer every
    // few seconds.
    const c = clock();
    let runs = 0;
    const sync = new ThrottledSync(async () => (runs += 1, {}), 15_000, 8_000, 5_000, c.now);

    await sync.ensureFresh();
    c.advance(5_000);
    await sync.ensureFresh();
    c.advance(9_000);
    await sync.ensureFresh();
    expect(runs).toBe(1);
  });

  it("syncs again once the window has passed", async () => {
    const c = clock();
    let runs = 0;
    const sync = new ThrottledSync(async () => (runs += 1, {}), 15_000, 8_000, 5_000, c.now);

    await sync.ensureFresh();
    c.advance(15_001);
    await sync.ensureFresh();
    expect(runs).toBe(2);
  });

  it("coalesces simultaneous requests into one in-flight sync", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sync = new ThrottledSync(async () => {
      runs += 1;
      await gate;
      return {};
    });

    const all = Promise.all(Array.from({ length: 10 }, () => sync.ensureFresh()));
    release();
    await all;
    expect(runs).toBe(1);
  });

  it("retries sooner after a failure than after a success, but not immediately", async () => {
    const c = clock();
    let runs = 0;
    const sync = new ThrottledSync(
      async () => {
        runs += 1;
        return { error: "indexer down" };
      },
      15_000,
      8_000,
      5_000,
      c.now,
    );

    await sync.ensureFresh();
    expect(runs).toBe(1);
    // Immediately after a failure it must not hammer a struggling indexer.
    await sync.ensureFresh();
    expect(runs).toBe(1);
    // But it does not wait a whole success-window either.
    c.advance(5_001);
    await sync.ensureFresh();
    expect(runs).toBe(2);
  });

  it("records the error instead of throwing it into the request", async () => {
    const sync = new ThrottledSync(async () => ({ error: "HTTP 503" }));
    await expect(sync.ensureFresh()).resolves.toBeUndefined();
    expect(sync.lastError).toBe("HTTP 503");
  });

  it("survives a sync that throws outright", async () => {
    // A read endpoint must never be taken down by the sync that precedes it.
    const sync = new ThrottledSync(async () => {
      throw new Error("kaboom");
    });
    await expect(sync.ensureFresh()).resolves.toBeUndefined();
    expect(sync.lastError).toBe("kaboom");
  });

  it("clears a recorded error after a later success", async () => {
    const c = clock();
    let fail = true;
    const sync = new ThrottledSync(
      async () => (fail ? { error: "down" } : {}),
      15_000,
      8_000,
      5_000,
      c.now,
    );
    await sync.ensureFresh();
    expect(sync.lastError).toBe("down");
    fail = false;
    c.advance(5_001);
    await sync.ensureFresh();
    expect(sync.lastError).toBeNull();
    expect(sync.lastSyncedAt).not.toBeNull();
  });

  it("answers with what it has when the sync is slow, instead of hanging the request", async () => {
    const sync = new ThrottledSync(
      () => new Promise(() => {}), // never resolves
      15_000,
      50, // wait at most 50ms
    );
    const startedAt = Date.now();
    await sync.ensureFresh();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("does not start a second sync while a slow one is still running", async () => {
    let runs = 0;
    const sync = new ThrottledSync(
      () => {
        runs += 1;
        return new Promise(() => {});
      },
      15_000,
      30,
    );
    await sync.ensureFresh();
    await sync.ensureFresh();
    expect(runs).toBe(1);
  });
});

describe("SYNC_BEFORE_PATHS", () => {
  // /v1/orchestrate is included because it SPENDS: the daily cap reads today's outbound payments
  // from chain-derived receipts, so they must be fresh before the guard decides.
  it.each(["/api/stats", "/api/receipts", "/api/receipts.csv", "/api/reconcile", "/v1/orchestrate"])(
    "syncs before %s, which reads receipts",
    (path) => expect(SYNC_BEFORE_PATHS.test(path)).toBe(true),
  );

  it.each([
    "/api/services",
    "/api/flow",
    "/api/budget",
    "/api/traces",
    "/api/verification",
    "/api/trust",
    "/v1/trust",
    "/livez",
    "/api/statsx",
  ])("does not sync before %s", (path) => expect(SYNC_BEFORE_PATHS.test(path)).toBe(false));
});
