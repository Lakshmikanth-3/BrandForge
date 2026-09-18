/**
 * Budget guard — minimal subset, pulled forward from Phase 6.
 *
 * Phase 3 is where the payer wallet goes live, which is the moment real money can
 * leave. A spend ceiling and a kill switch therefore have to exist before that,
 * not after it: the full limit model, receipt export and anomaly detection can
 * wait, but "stop spending" cannot.
 *
 * Correctness property that matters most: concurrent calls must not race past a
 * limit. Reserving is done in one SQL transaction that both checks the remaining
 * budget and writes the reservation, so two parallel calls cannot each read the
 * same headroom and both proceed. A reservation is later settled or released.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";

export interface BudgetLimits {
  /** Largest single downstream payment, in USDC base units. */
  perCallBase: number;
  /** Total outbound per UTC day, in USDC base units. */
  perDayBase: number;
  /** Total outbound per merchant per UTC day, in USDC base units. */
  perMerchantPerDayBase: number;
}

/** Conservative defaults. Real money: the floor is low until deliberately raised. */
export const DEFAULT_LIMITS: BudgetLimits = {
  perCallBase: 250_000, // $0.25
  perDayBase: 2_000_000, // $2.00
  perMerchantPerDayBase: 500_000, // $0.50
};

export type RefusalReason =
  | "kill_switch"
  | "per_call"
  | "per_day"
  | "per_merchant_per_day";

export interface Allowed {
  allowed: true;
  reservationId: string;
  remainingDayBase: number;
}

export interface Refused {
  allowed: false;
  reason: RefusalReason;
  detail: string;
  /** What was left when the request was refused, for an honest error message. */
  remainingDayBase: number;
}

export type BudgetDecision = Allowed | Refused;

const KILL_SWITCH_KEY = "kill_switch";

/** UTC day key. Limits reset on the UTC boundary regardless of host timezone. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export class BudgetGuard {
  constructor(
    private readonly store: Store,
    private readonly limits: BudgetLimits = DEFAULT_LIMITS,
  ) {}

  get currentLimits(): BudgetLimits {
    return this.limits;
  }

  isHalted(): boolean {
    return this.store.getSetting(KILL_SWITCH_KEY) === "on";
  }

  /** Halts all outbound payments. Takes effect on the next reservation attempt. */
  halt(): void {
    this.store.setSetting(KILL_SWITCH_KEY, "on");
  }

  resume(): void {
    this.store.setSetting(KILL_SWITCH_KEY, "off");
  }

  /**
   * Pre-flight check. Refusal is cheap and explicit — nothing is attempted, and
   * the caller gets a reason it can pass back to the agent verbatim.
   */
  reserve(args: { merchant: string; route: string; amountBase: number }): BudgetDecision {
    const day = utcDay();

    if (this.isHalted()) {
      return {
        allowed: false,
        reason: "kill_switch",
        detail: "outbound payments are halted by the kill switch",
        remainingDayBase: 0,
      };
    }

    if (args.amountBase > this.limits.perCallBase) {
      return {
        allowed: false,
        reason: "per_call",
        detail:
          `call costs ${usdc(args.amountBase)} which exceeds the ` +
          `${usdc(this.limits.perCallBase)} per-call cap`,
        remainingDayBase: this.limits.perDayBase - this.store.committedToday(day),
      };
    }

    // Atomic: check and reserve together, so parallel calls serialise here.
    const outcome = this.store.tryReserveSpend({
      id: randomUUID(),
      merchant: args.merchant,
      route: args.route,
      amountBase: args.amountBase,
      day,
      perDayBase: this.limits.perDayBase,
      perMerchantPerDayBase: this.limits.perMerchantPerDayBase,
    });

    if (!outcome.ok) {
      return {
        allowed: false,
        reason: outcome.breached,
        detail:
          outcome.breached === "per_day"
            ? `daily cap ${usdc(this.limits.perDayBase)} would be exceeded ` +
              `(${usdc(outcome.committed)} already committed today)`
            : `per-merchant daily cap ${usdc(this.limits.perMerchantPerDayBase)} would be ` +
              `exceeded for this merchant (${usdc(outcome.committed)} already committed)`,
        remainingDayBase: Math.max(0, this.limits.perDayBase - this.store.committedToday(day)),
      };
    }

    return {
      allowed: true,
      reservationId: outcome.id,
      remainingDayBase: Math.max(
        0,
        this.limits.perDayBase - this.store.committedToday(day),
      ),
    };
  }

  /** The payment went through. The reservation becomes real spend. */
  settle(reservationId: string, txId: string | null): void {
    this.store.resolveSpend(reservationId, "settled", txId);
  }

  /** The payment did not happen. Return the headroom. */
  release(reservationId: string): void {
    this.store.resolveSpend(reservationId, "released", null);
  }

  status(): {
    halted: boolean;
    limits: BudgetLimits;
    day: string;
    committedTodayBase: number;
    remainingDayBase: number;
  } {
    const day = utcDay();
    const committed = this.store.committedToday(day);
    return {
      halted: this.isHalted(),
      limits: this.limits,
      day,
      committedTodayBase: committed,
      remainingDayBase: Math.max(0, this.limits.perDayBase - committed),
    };
  }
}

function usdc(base: number): string {
  return `$${(base / 1e6).toFixed(6)}`;
}
