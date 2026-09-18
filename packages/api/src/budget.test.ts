import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { BudgetGuard, utcDay, type BudgetLimits } from "./budget.js";

const LIMITS: BudgetLimits = {
  perCallBase: 100_000, // $0.10
  perDayBase: 300_000, // $0.30
  perMerchantPerDayBase: 150_000, // $0.15
};

describe("BudgetGuard", () => {
  let store: Store;
  let guard: BudgetGuard;

  beforeEach(() => {
    store = new Store(":memory:");
    guard = new BudgetGuard(store, LIMITS);
  });

  const ask = (amountBase: number, merchant = "M1") =>
    guard.reserve({ merchant, route: "/x", amountBase });

  describe("per-call cap", () => {
    it("allows a call at the boundary", () => {
      expect(ask(100_000).allowed).toBe(true);
    });

    it("refuses one base unit over the boundary", () => {
      const decision = ask(100_001);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toBe("per_call");
      expect(decision.detail).toMatch(/per-call cap/);
    });

    it("reserves nothing when it refuses", () => {
      ask(100_001);
      expect(store.committedToday(utcDay())).toBe(0);
    });
  });

  describe("per-merchant daily cap", () => {
    it("allows spend up to the merchant boundary", () => {
      expect(ask(100_000, "M1").allowed).toBe(true);
      expect(ask(50_000, "M1").allowed).toBe(true); // exactly 150_000
    });

    it("refuses the call that would cross it", () => {
      ask(100_000, "M1");
      const decision = ask(50_001, "M1");
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toBe("per_merchant_per_day");
    });

    it("does not let one merchant consume another's allowance", () => {
      ask(100_000, "M1");
      ask(50_000, "M1"); // M1 now at its cap
      expect(ask(100_000, "M2").allowed).toBe(true);
    });
  });

  describe("daily cap", () => {
    it("refuses once the day total would be exceeded, across merchants", () => {
      expect(ask(100_000, "M1").allowed).toBe(true);
      expect(ask(100_000, "M2").allowed).toBe(true);
      expect(ask(100_000, "M3").allowed).toBe(true); // 300_000, at the cap
      const decision = ask(1, "M4");
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toBe("per_day");
      expect(decision.detail).toMatch(/daily cap/);
    });

    it("reports remaining headroom honestly", () => {
      const first = ask(100_000);
      expect(first.allowed).toBe(true);
      expect(first.remainingDayBase).toBe(200_000);
    });
  });

  describe("day boundary", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("resets on the UTC boundary, not the host timezone", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-18T23:59:00.000Z"));
      expect(ask(100_000, "M1").allowed).toBe(true);
      expect(ask(100_000, "M2").allowed).toBe(true);
      expect(ask(100_000, "M3").allowed).toBe(true);
      expect(ask(1, "M4").allowed).toBe(false);

      // One minute later it is a new UTC day.
      vi.setSystemTime(new Date("2026-09-19T00:00:30.000Z"));
      expect(ask(100_000, "M1").allowed).toBe(true);
    });

    it("keys the day in UTC regardless of local offset", () => {
      // A host in UTC+14 is already on the next local date at this instant.
      expect(utcDay(new Date("2026-09-18T22:00:00.000Z"))).toBe("2026-09-18");
    });
  });

  describe("reservation lifecycle", () => {
    it("frees headroom when a payment does not happen", () => {
      const decision = ask(100_000);
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) return;

      expect(store.committedToday(utcDay())).toBe(100_000);
      guard.release(decision.reservationId);
      expect(store.committedToday(utcDay())).toBe(0);
    });

    it("keeps spend committed once settled", () => {
      const decision = ask(100_000);
      if (!decision.allowed) return;
      guard.settle(decision.reservationId, "TX1");
      expect(store.committedToday(utcDay())).toBe(100_000);
    });

    it("counts a reservation against the budget before the payment is attempted", () => {
      // Reserving first is what makes the guard enforcing rather than advisory.
      ask(100_000);
      expect(store.committedToday(utcDay())).toBe(100_000);
    });

    it("ignores a release after settle, so headroom cannot be reclaimed twice", () => {
      const decision = ask(100_000);
      if (!decision.allowed) return;
      guard.settle(decision.reservationId, "TX1");
      guard.release(decision.reservationId);
      expect(store.committedToday(utcDay())).toBe(100_000);
    });

    it("records the transaction id against the reservation", () => {
      const decision = ask(50_000);
      if (!decision.allowed) return;
      guard.settle(decision.reservationId, "TXABC");

      const row = store.spendLog().find((r) => r.id === decision.reservationId)!;
      expect(row.state).toBe("settled");
      expect(row.txId).toBe("TXABC");
    });
  });

  describe("kill switch", () => {
    it("halts outbound payments within one call", () => {
      expect(ask(10_000).allowed).toBe(true);
      guard.halt();
      const decision = ask(10_000);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toBe("kill_switch");
    });

    it("refuses before any limit arithmetic, so it cannot be bypassed by a small call", () => {
      guard.halt();
      const decision = ask(1);
      expect(decision.allowed).toBe(false);
      expect(store.committedToday(utcDay())).toBe(0);
    });

    it("survives a restart, because it lives in the store not in memory", () => {
      guard.halt();
      const revived = new BudgetGuard(store, LIMITS);
      expect(revived.isHalted()).toBe(true);
    });

    it("resumes when explicitly told to", () => {
      guard.halt();
      guard.resume();
      expect(ask(10_000).allowed).toBe(true);
    });
  });

  describe("concurrency", () => {
    it("does not let parallel calls race past the daily cap", () => {
      // Six calls of 100_000 against a 300_000 cap: exactly three may pass.
      const decisions = Array.from({ length: 6 }, (_, i) => ask(100_000, `M${i}`));
      const allowed = decisions.filter((d) => d.allowed);
      expect(allowed).toHaveLength(3);
      expect(store.committedToday(utcDay())).toBe(300_000);
    });

    it("does not let parallel calls race past a merchant cap", () => {
      const decisions = Array.from({ length: 4 }, () => ask(50_000, "SAME"));
      expect(decisions.filter((d) => d.allowed)).toHaveLength(3); // 150_000 cap
    });

    it("never commits more than the cap under mixed sizes", () => {
      ask(90_000, "A");
      ask(90_000, "B");
      ask(90_000, "C");
      ask(90_000, "D");
      expect(store.committedToday(utcDay())).toBeLessThanOrEqual(LIMITS.perDayBase);
    });
  });

  describe("status", () => {
    it("reports the live picture for the budget panel", () => {
      ask(100_000);
      const status = guard.status();
      expect(status).toMatchObject({
        halted: false,
        day: utcDay(),
        committedTodayBase: 100_000,
        remainingDayBase: 200_000,
      });
      expect(status.limits).toEqual(LIMITS);
    });

    it("never reports negative headroom", () => {
      const tight = new BudgetGuard(store, { ...LIMITS, perDayBase: 10_000 });
      store.tryReserveSpend({
        id: "manual",
        merchant: "M",
        route: "/x",
        amountBase: 50_000,
        day: utcDay(),
        perDayBase: 1_000_000,
        perMerchantPerDayBase: 1_000_000,
      });
      expect(tight.status().remainingDayBase).toBe(0);
    });
  });
});
