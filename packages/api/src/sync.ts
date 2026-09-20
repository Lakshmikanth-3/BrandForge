/**
 * On-demand chain sync, for hosts that cannot run a background timer.
 *
 * The settlement listener normally polls the indexer every few seconds from a long-lived
 * process. A serverless function has no such process: it starts for a request and may be
 * frozen or discarded the moment it responds, so a setInterval would simply never fire.
 * Instead the read endpoints that depend on receipts ask for a sync first, and this makes
 * that cheap and safe.
 *
 * Three properties matter, each learned the hard way elsewhere in this codebase:
 *
 *  - Throttled. A dashboard polling every few seconds must not become a request to the
 *    indexer every few seconds. One sync serves every request inside the window.
 *  - Coalesced. Ten requests arriving together share one in-flight sync rather than
 *    starting ten.
 *  - Never fatal. A slow or failing indexer must not take the read API down with it, so the
 *    wait is bounded and a failure is recorded rather than thrown. The request is answered
 *    with what is already known, and the next one retries.
 */
export interface SyncResult {
  error?: string;
}

export class ThrottledSync {
  private nextAllowedAt = 0;
  private inflight: Promise<void> | null = null;
  lastError: string | null = null;
  lastSyncedAt: number | null = null;

  constructor(
    private readonly run: () => Promise<SyncResult>,
    private readonly minIntervalMs = 15_000,
    /** How long a request will wait for a sync before answering with what it has. */
    private readonly maxWaitMs = 8_000,
    /** Retry sooner after a failure than after a success, but never immediately. */
    private readonly retryAfterFailureMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async ensureFresh(): Promise<void> {
    if (this.inflight) return this.boundedWait(this.inflight);
    if (this.now() < this.nextAllowedAt) return;

    this.inflight = this.run()
      .then((result) => {
        this.lastError = result.error ?? null;
        this.nextAllowedAt =
          this.now() + (result.error ? this.retryAfterFailureMs : this.minIntervalMs);
        if (!result.error) this.lastSyncedAt = this.now();
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : "sync failed";
        this.nextAllowedAt = this.now() + this.retryAfterFailureMs;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.boundedWait(this.inflight);
  }

  private boundedWait(promise: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.maxWaitMs);
      timer.unref?.();
      void promise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Endpoints whose answer depends on receipts, and which therefore sync first. */
export const SYNC_BEFORE_PATHS = /^\/api\/(stats|receipts|receipts\.csv|reconcile)$/;
