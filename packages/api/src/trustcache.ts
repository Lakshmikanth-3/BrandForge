/**
 * TTL cache and rate limiter for the trust lookup.
 *
 * The paid route is cached so it stays cheap to serve: a score recomputed from the
 * same outcomes returns the same number, so serving it twice from the database is
 * waste. The free route the UI calls is rate limited instead, because payment is
 * what limits the paid one and nothing limits a free one.
 *
 * The TTL is short on purpose. A trust score that lags reality is worse than a slow
 * one: the whole product claim is that the record reflects what endpoints actually
 * did, so a stale answer undermines the thing being sold.
 */

export const TRUST_CACHE_TTL_MS = 10_000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number = TRUST_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      // Expired entries are dropped rather than returned with a warning: a caller
      // that asked for a score must not receive a stale one.
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      // Bounded: an endpoint that is asked about once must not pin memory forever.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Fixed-window rate limiter, per key.
 *
 * Deliberately simple. It protects the free lookup from being used as an
 * unmetered API; it is not a security boundary, and the paid route does not need
 * it because payment is the limit there.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowEnd: number }>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns null when allowed, or the seconds to wait when not. */
  check(key: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const at = this.now();
    const entry = this.hits.get(key);

    if (!entry || entry.windowEnd <= at) {
      this.hits.set(key, { count: 1, windowEnd: at + this.windowMs });
      return { allowed: true };
    }

    if (entry.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((entry.windowEnd - at) / 1000)),
      };
    }

    entry.count += 1;
    return { allowed: true };
  }
}
