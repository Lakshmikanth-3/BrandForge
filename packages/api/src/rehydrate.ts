/**
 * Rebuilding state on boot, for hosts with an ephemeral filesystem.
 *
 * Render's free tier loses the local filesystem on every restart, redeploy and spin-down,
 * so the SQLite file cannot be treated as durable there. Rather than pretend otherwise,
 * each kind of state is restored from the place that actually still has it:
 *
 *   receipts        the chain. The settlement listener re-derives every inbound payment,
 *                   outbound payment and refund from the indexer, which is authoritative
 *                   and is what reconciliation compares against anyway.
 *   service registry  the Bazaar catalog, by re-running the ingest and the probes.
 *   trust outcomes  a snapshot file committed to the repo (seed/outcomes.json).
 *
 * Trust outcomes are the one thing that cannot be re-derived: they are observations of
 * what a service returned when we paid it, and no chain records that. They are exported
 * from the operator's own payer (npm run trust:export) and imported here only when the
 * table is empty.
 *
 * What this means for the hosted trust record, stated plainly so nobody has to infer it:
 * it is a SNAPSHOT of real observations from real paid calls, refreshed by re-exporting
 * and redeploying. The hosted server itself does not pay anyone -- it has no payer key --
 * so it does not generate new observations. Those are real data, not fixtures, but they
 * are not live.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Store } from "./db.js";
import type { CatalogIngester } from "./catalog.js";
import type { Outcome } from "./trust.js";

export const SEED_PATH = "seed/outcomes.json";

export interface SeedFile {
  /** Schema version of this file, so a future format change is detectable. */
  version: 1;
  exportedAt: string;
  network: string;
  outcomes: Outcome[];
}

export function isSeedFile(value: unknown): value is SeedFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SeedFile>;
  return v.version === 1 && Array.isArray(v.outcomes) && typeof v.network === "string";
}

/**
 * Imports the snapshot, but only into an empty table.
 *
 * "Only when empty" is the safety property: on a host with a durable disk, or after the
 * server has recorded anything of its own, a stale snapshot must never be layered over
 * live data. Returns how many rows were imported.
 */
export function importSeedOutcomes(
  store: Store,
  seed: unknown,
  expectedNetwork: string,
): { imported: number; reason: string } {
  if (!isSeedFile(seed)) return { imported: 0, reason: "seed file is not in a recognised format" };

  // Observations from another network describe other endpoints and other prices.
  if (seed.network !== expectedNetwork) {
    return {
      imported: 0,
      reason: `seed is for ${seed.network}, this server is ${expectedNetwork}`,
    };
  }

  if (store.outcomeCount() > 0) {
    return { imported: 0, reason: "outcomes already present; not overwriting live data" };
  }

  // Oldest first, so the store's own ordering reproduces the original recency.
  const ordered = [...seed.outcomes].sort((a, b) => a.at.localeCompare(b.at));
  let imported = 0;
  for (const o of ordered) {
    if (typeof o.resourceUrl !== "string" || typeof o.at !== "string") continue;
    store.putOutcome({
      resourceUrl: o.resourceUrl,
      at: o.at,
      ok: o.ok === true,
      httpStatus: o.httpStatus ?? null,
      latencyMs: o.latencyMs ?? null,
      settled: o.settled === true,
      schemaOk: o.schemaOk ?? null,
      coldStart: o.coldStart === true,
      clientError: o.clientError === true,
      failureReason: o.failureReason ?? null,
    });
    imported += 1;
  }
  return { imported, reason: "imported into an empty table" };
}

export interface RehydrateResult {
  seedImported: number;
  seedReason: string;
  catalog: { normalised: number; allowlisted: number; error?: string } | null;
  probesOk: number;
  probesTotal: number;
  errors: string[];
}

/**
 * Runs the whole restore. Every step is independent and failure of one must not stop the
 * others: an unreachable catalog should not prevent the trust snapshot from loading.
 */
export async function rehydrate(
  store: Store,
  ingester: CatalogIngester,
  network: string,
  opts: { seedPath?: string; log?: (line: string) => void } = {},
): Promise<RehydrateResult> {
  const log = opts.log ?? (() => {});
  const seedPath = opts.seedPath ?? SEED_PATH;
  const errors: string[] = [];

  let seedImported = 0;
  let seedReason = "no seed file";
  if (existsSync(seedPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(seedPath, "utf8"));
      const result = importSeedOutcomes(store, parsed, network);
      seedImported = result.imported;
      seedReason = result.reason;
    } catch (err) {
      seedReason = "seed file could not be read";
      errors.push(`seed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }
  log(`rehydrate: trust outcomes ${seedImported} imported (${seedReason})`);

  let catalog: RehydrateResult["catalog"] = null;
  let probesOk = 0;
  let probesTotal = 0;
  try {
    const ingest = await ingester.ingest();
    catalog = {
      normalised: ingest.normalised,
      allowlisted: ingest.allowlisted,
      ...(ingest.error ? { error: ingest.error } : {}),
    };
    if (ingest.error) errors.push(`catalog: ${ingest.error}`);
    log(`rehydrate: catalog ${ingest.normalised} payable, ${ingest.allowlisted} curated`);

    // Probes can be slow: a curated service on a free tier may take a minute to wake.
    const probes = await ingester.verifyAllowlisted();
    probesTotal = probes.length;
    probesOk = probes.filter((p) => p.result.verdict === "ok").length;
    log(`rehydrate: probes ${probesOk}/${probesTotal} payable`);
  } catch (err) {
    errors.push(`catalog: ${err instanceof Error ? err.message : "unknown error"}`);
  }

  return { seedImported, seedReason, catalog, probesOk, probesTotal, errors };
}
