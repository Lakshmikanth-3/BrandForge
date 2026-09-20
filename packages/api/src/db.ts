/**
 * Durable store for receipts and traces.
 *
 * node:sqlite — zero dependencies and no native build, which matters on a
 * Railway Nixpacks image. Schema is written so the Postgres migration (PRD §6)
 * is a driver swap, not a redesign: no sqlite-specific types, explicit columns.
 *
 * Amounts are stored in USDC base units (integers) as the source of truth.
 * Floats exist only for display and are derived, never stored as the authority.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * node:sqlite is loaded through createRequire rather than a static import.
 * Vite's builtin list does not include it yet, so a static `import` makes Vitest
 * try to resolve "sqlite" from node_modules and fail. createRequire keeps the
 * load out of static analysis while Node resolves it natively at runtime.
 */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

export type Direction = "in" | "out";

export interface ReceiptRow {
  txId: string;
  direction: Direction;
  route: string;
  payer: string;
  payee: string;
  amountBase: number;
  assetId: string;
  network: string;
  confirmedRound: number | null;
  settledAt: string;
  traceId: string | null;
  latencyMs: number | null;
}

export interface Stats {
  settleCount: number;
  totalBase: number;
  distinctPayers: number;
  outboundCount: number;
  /** Gross USDC sent downstream. */
  outboundBase: number;
  /** USDC returned by services we paid. */
  refundBase: number;
  /** What the calls actually cost: gross minus refunds. */
  netOutboundBase: number;
  firstSettledAt: string | null;
  lastSettledAt: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  tx_id            TEXT PRIMARY KEY,
  direction        TEXT NOT NULL CHECK (direction IN ('in','out')),
  route            TEXT NOT NULL,
  payer            TEXT NOT NULL,
  payee            TEXT NOT NULL,
  amount_base      INTEGER NOT NULL,
  asset_id         TEXT NOT NULL,
  network          TEXT NOT NULL,
  confirmed_round  INTEGER,
  settled_at       TEXT NOT NULL,
  trace_id         TEXT,
  latency_ms       INTEGER
);
CREATE INDEX IF NOT EXISTS receipts_settled_at ON receipts (settled_at DESC);
CREATE INDEX IF NOT EXISTS receipts_direction  ON receipts (direction, settled_at DESC);

CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  flow        TEXT NOT NULL DEFAULT 'inbound',
  route       TEXT NOT NULL,
  network     TEXT NOT NULL,
  state       TEXT NOT NULL,
  payer       TEXT,
  tx_id       TEXT,
  total_ms    INTEGER,
  created_at  TEXT NOT NULL,
  steps_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_created_at ON traces (created_at DESC);

-- Known x402 services from the Bazaar catalog. The active flag goes false when the
-- catalog stops listing a service; the row is kept so trust history survives.
CREATE TABLE IF NOT EXISTS services (
  resource_url      TEXT PRIMARY KEY,
  method            TEXT NOT NULL,
  description       TEXT NOT NULL,
  pay_to            TEXT NOT NULL,
  network           TEXT NOT NULL,
  amount_base       INTEGER NOT NULL,
  asset_id          TEXT NOT NULL,
  settle_count      INTEGER NOT NULL DEFAULT 0,
  last_seen         TEXT NOT NULL,
  has_discovery     INTEGER NOT NULL DEFAULT 0,
  -- The input example the service publishes via discovery. Sending a service a
  -- body it did not ask for produces a 4xx that looks like the service failing.
  discovery_input   TEXT,
  allowlisted       INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  first_ingested_at TEXT NOT NULL,
  -- Last probe outcome. Null until probed; a catalog entry is a claim, not a fact.
  probe_verdict     TEXT,
  probe_status      INTEGER,
  probe_latency_ms  INTEGER,
  probe_live_amount INTEGER,
  probe_drift       REAL,
  probe_cold_start  INTEGER,
  probe_detail      TEXT,
  probed_at         TEXT
);
CREATE INDEX IF NOT EXISTS services_allowlisted ON services (allowlisted, active);

-- USDC arriving at the PAYER address. Kept separate from receipts rather than added
-- as another direction, because the receipts CHECK constraint cannot be widened in
-- place and because these are not settlements of our routes.
--
-- Two kinds, and the distinction matters. A refund is money returned by a service we
-- paid, which reduces what a call actually cost us. Funding is a top-up from a faucet
-- or a wallet, which does not. Reconciliation was reporting clean while six real
-- transfers to our addresses had no row here at all, and a service refunding 0.275 USDC
-- made our books overstate spend by more than half.
CREATE TABLE IF NOT EXISTS inflows (
  tx_id           TEXT PRIMARY KEY,
  from_address    TEXT NOT NULL,
  amount_base     INTEGER NOT NULL,
  asset_id        TEXT NOT NULL,
  network         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('refund','funding')),
  confirmed_round INTEGER,
  received_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inflows_received_at ON inflows (received_at DESC);

-- Raw observations the trust engine scores. Append-only: a score is only as
-- trustworthy as the record it derives from, so outcomes are never rewritten.
CREATE TABLE IF NOT EXISTS outcomes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_url   TEXT NOT NULL,
  at             TEXT NOT NULL,
  ok             INTEGER NOT NULL,
  http_status    INTEGER,
  latency_ms     INTEGER,
  settled        INTEGER NOT NULL,
  schema_ok      INTEGER,
  cold_start     INTEGER NOT NULL,
  -- True when the call failed because OUR request was invalid. Excluded from
  -- scoring: a service must not be marked unreliable for refusing our bad input.
  client_error   INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS outcomes_url_at ON outcomes (resource_url, at DESC);

-- Every time the bridge routed around a refused service, and why.
CREATE TABLE IF NOT EXISTS substitutions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  refused_url  TEXT NOT NULL,
  refused_score REAL,
  chosen_url   TEXT,
  chosen_score REAL,
  reason       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS substitutions_at ON substitutions (at DESC);

-- Every intent to spend, reserved BEFORE the payment is attempted. Reserving
-- first is what makes concurrent calls unable to race past a limit: the check
-- and the reservation happen in one transaction.
CREATE TABLE IF NOT EXISTS spend_log (
  id          TEXT PRIMARY KEY,
  merchant    TEXT NOT NULL,
  route       TEXT NOT NULL,
  amount_base INTEGER NOT NULL,
  -- reserved -> settled (payment went through) | released (it did not)
  state       TEXT NOT NULL CHECK (state IN ('reserved','settled','released')),
  tx_id       TEXT,
  created_at  TEXT NOT NULL,
  day         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_log_day ON spend_log (day, state);
CREATE INDEX IF NOT EXISTS spend_log_merchant ON spend_log (merchant, day, state);

-- Operator settings, including the kill switch.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Cursor for the indexer settlement listener, so a restart does not rescan
-- from genesis and does not miss rounds.
CREATE TABLE IF NOT EXISTS listener_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);
`;

/**
 * Columns added to tables that already existed in a deployed database.
 *
 * CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so it silently skips
 * new columns. That is not a theoretical problem: adding `traces.flow` in Phase 3
 * left every already-created database without it, and the first real paid call
 * failed to persist its trace with "table traces has no column named flow" -- after
 * the payment had already settled.
 *
 * Each entry is applied only when the column is absent, so this is idempotent and
 * safe to run on every open. Any future column belongs here as well as in SCHEMA.
 */
const MIGRATIONS: { table: string; column: string; definition: string }[] = [
  { table: "traces", column: "flow", definition: "TEXT NOT NULL DEFAULT 'inbound'" },
  { table: "services", column: "discovery_input", definition: "TEXT" },
  { table: "outcomes", column: "client_error", definition: "INTEGER NOT NULL DEFAULT 0" },
];

export class Store {
  private readonly db: SqliteDatabase;

  constructor(path = "data/sentry402.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // FIRST, before anything else touches the file. journal_mode = WAL takes a lock of
    // its own, so a timeout set after it protects nothing on the one statement most
    // likely to collide: twelve processes opening one database at once made it fail with
    // "database is locked" about one run in four, even after busy_timeout was added,
    // because busy_timeout was being set after the pragma that needed it.
    // Wait for a write lock instead of failing on it. The API server, the settlement
    // listener, the prober and the MCP server all open this same file, so BEGIN
    // IMMEDIATE contends for real. Without a timeout SQLite returns "database is
    // locked" instantly: a multi-process race test showed one writer in twelve dying
    // that way, which in production is a budget reservation throwing and taking a
    // payment attempt down with it rather than refusing it cleanly.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Adds any column missing from an older database. Idempotent. */
  private migrate(): void {
    for (const m of MIGRATIONS) {
      const columns = this.db.prepare(`PRAGMA table_info(${m.table})`).all() as Record<
        string,
        unknown
      >[];
      if (columns.length === 0) continue; // table does not exist yet
      if (columns.some((c) => String(c["name"]) === m.column)) continue;
      this.db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
    }
  }

  /** Column names of a table, for tests and diagnostics. */
  columnsOf(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]).map(
      (c) => String(c["name"]),
    );
  }

  /**
   * Idempotent by transaction id: the settlement listener and the request path
   * both try to write the same receipt, and a poll can see the same round twice.
   * Returns true only when this call was the one that inserted it.
   */
  putReceipt(r: ReceiptRow): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO receipts
           (tx_id, direction, route, payer, payee, amount_base, asset_id,
            network, confirmed_round, settled_at, trace_id, latency_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tx_id) DO NOTHING`,
      )
      .run(
        r.txId,
        r.direction,
        r.route,
        r.payer,
        r.payee,
        r.amountBase,
        r.assetId,
        r.network,
        r.confirmedRound,
        r.settledAt,
        r.traceId,
        r.latencyMs,
      );
    return Number(result.changes) > 0;
  }

  receipts(opts: { direction?: Direction; limit?: number } = {}): ReceiptRow[] {
    const limit = Math.min(opts.limit ?? 50, 500);
    const rows = opts.direction
      ? this.db
          .prepare(
            `SELECT * FROM receipts WHERE direction = ? ORDER BY settled_at DESC LIMIT ?`,
          )
          .all(opts.direction, limit)
      : this.db
          .prepare(`SELECT * FROM receipts ORDER BY settled_at DESC LIMIT ?`)
          .all(limit);
    return (rows as Record<string, unknown>[]).map(toReceipt);
  }

  stats(): Stats {
    const inbound = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_base),0) AS total,
                COUNT(DISTINCT payer) AS payers,
                MIN(settled_at) AS first, MAX(settled_at) AS last
           FROM receipts WHERE direction = 'in'`,
      )
      .get() as Record<string, unknown>;
    const outbound = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount_base),0) AS total
           FROM receipts WHERE direction = 'out'`,
      )
      .get() as Record<string, unknown>;
    const refunds = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_base),0) AS total FROM inflows WHERE kind = 'refund'`,
      )
      .get() as Record<string, unknown>;
    const outboundBase = Number(outbound["total"] ?? 0);
    const refundBase = Number(refunds["total"] ?? 0);

    return {
      settleCount: Number(inbound["n"] ?? 0),
      totalBase: Number(inbound["total"] ?? 0),
      distinctPayers: Number(inbound["payers"] ?? 0),
      outboundCount: Number(outbound["n"] ?? 0),
      outboundBase,
      refundBase,
      netOutboundBase: outboundBase - refundBase,
      firstSettledAt: (inbound["first"] as string | null) ?? null,
      lastSettledAt: (inbound["last"] as string | null) ?? null,
    };
  }

  saveTrace(t: {
    id: string;
    flow: string;
    route: string;
    network: string;
    state: string;
    payer: string | null;
    txId: string | null;
    totalMs: number | null;
    createdAt: string;
    steps: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO traces (id, flow, route, network, state, payer, tx_id, total_ms, created_at, steps_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET
           state = excluded.state, payer = excluded.payer, tx_id = excluded.tx_id,
           total_ms = excluded.total_ms, steps_json = excluded.steps_json`,
      )
      .run(
        t.id,
        t.flow,
        t.route,
        t.network,
        t.state,
        t.payer,
        t.txId,
        t.totalMs,
        t.createdAt,
        JSON.stringify(t.steps),
      );
  }

  recentTraces(limit = 20): unknown[] {
    const rows = this.db
      .prepare(`SELECT * FROM traces ORDER BY created_at DESC LIMIT ?`)
      .all(Math.min(limit, 200)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r["id"],
      flow: r["flow"] ?? "inbound",
      route: r["route"],
      network: r["network"],
      state: r["state"],
      payer: r["payer"],
      txId: r["tx_id"],
      totalMs: r["total_ms"],
      createdAt: r["created_at"],
      steps: JSON.parse(String(r["steps_json"])),
    }));
  }

  /**
   * Inserts or refreshes a catalog entry. Preserves `first_ingested_at` and the
   * last probe result — an ingest tells us what the catalog claims, not whether
   * the service works.
   */
  upsertService(
    e: {
      resourceUrl: string;
      method: string;
      description: string;
      payTo: string;
      network: string;
      amountBase: number;
      assetId: string;
      settleCount: number;
      lastSeen: string;
      hasDiscoveryInfo: boolean;
      discoveryInput?: unknown;
    },
    allowlisted: boolean,
  ): void {
    this.db
      .prepare(
        `INSERT INTO services
           (resource_url, method, description, pay_to, network, amount_base, asset_id,
            settle_count, last_seen, has_discovery, discovery_input, allowlisted, active,
            first_ingested_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
         ON CONFLICT (resource_url) DO UPDATE SET
           method = excluded.method,
           description = excluded.description,
           pay_to = excluded.pay_to,
           network = excluded.network,
           amount_base = excluded.amount_base,
           asset_id = excluded.asset_id,
           settle_count = excluded.settle_count,
           last_seen = excluded.last_seen,
           has_discovery = excluded.has_discovery,
           discovery_input = excluded.discovery_input,
           allowlisted = excluded.allowlisted,
           active = 1`,
      )
      .run(
        e.resourceUrl,
        e.method,
        e.description,
        e.payTo,
        e.network,
        e.amountBase,
        e.assetId,
        e.settleCount,
        e.lastSeen,
        e.hasDiscoveryInfo ? 1 : 0,
        e.discoveryInput === undefined || e.discoveryInput === null
          ? null
          : JSON.stringify(e.discoveryInput),
        allowlisted ? 1 : 0,
        new Date().toISOString(),
      );
  }

  services(opts: { allowlistedOnly?: boolean; network?: string; activeOnly?: boolean } = {}) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.allowlistedOnly) clauses.push("allowlisted = 1");
    if (opts.activeOnly !== false) clauses.push("active = 1");
    if (opts.network) {
      clauses.push("network = ?");
      params.push(opts.network);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM services ${where} ORDER BY settle_count DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(toService);
  }

  /**
   * Marks every service NOT in `seenUrls` inactive. Deleting would destroy the
   * observation history the trust engine depends on.
   */
  markMissingInactive(seenUrls: string[], network: string): number {
    const known = this.db
      .prepare(`SELECT resource_url FROM services WHERE network = ? AND active = 1`)
      .all(network) as Record<string, unknown>[];
    const seen = new Set(seenUrls);
    let count = 0;
    for (const row of known) {
      const url = String(row["resource_url"]);
      if (seen.has(url)) continue;
      this.db.prepare(`UPDATE services SET active = 0 WHERE resource_url = ?`).run(url);
      count += 1;
    }
    return count;
  }

  recordProbe(
    resourceUrl: string,
    p: {
      verdict: string;
      httpStatus: number | null;
      latencyMs: number;
      liveAmountBase: number | null;
      priceDriftRatio: number | null;
      coldStart: boolean;
      detail: string | null;
      /** Preserves the original time when restoring from a snapshot. */
      probedAt?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE services SET
           probe_verdict = ?, probe_status = ?, probe_latency_ms = ?,
           probe_live_amount = ?, probe_drift = ?, probe_cold_start = ?,
           probe_detail = ?, probed_at = ?
         WHERE resource_url = ?`,
      )
      .run(
        p.verdict,
        p.httpStatus,
        p.latencyMs,
        p.liveAmountBase,
        p.priceDriftRatio,
        p.coldStart ? 1 : 0,
        p.detail,
        p.probedAt ?? new Date().toISOString(),
        resourceUrl,
      );
  }

  putOutcome(o: {
    resourceUrl: string;
    at: string;
    ok: boolean;
    httpStatus: number | null;
    latencyMs: number | null;
    settled: boolean;
    schemaOk: boolean | null;
    coldStart: boolean;
    clientError?: boolean;
    failureReason: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO outcomes
           (resource_url, at, ok, http_status, latency_ms, settled, schema_ok,
            cold_start, client_error, failure_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.resourceUrl,
        o.at,
        o.ok ? 1 : 0,
        o.httpStatus,
        o.latencyMs,
        o.settled ? 1 : 0,
        o.schemaOk === null ? null : o.schemaOk ? 1 : 0,
        o.coldStart ? 1 : 0,
        o.clientError ? 1 : 0,
        o.failureReason,
      );
  }

  /** Newest first, which is the order the scoring model expects. */
  outcomes(resourceUrl: string, limit = 50) {
    const rows = this.db
      .prepare(
        `SELECT * FROM outcomes WHERE resource_url = ? ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(resourceUrl, Math.min(limit, 500)) as Record<string, unknown>[];
    return rows.map((r) => ({
      resourceUrl: String(r["resource_url"]),
      at: String(r["at"]),
      ok: Number(r["ok"]) === 1,
      httpStatus: r["http_status"] === null ? null : Number(r["http_status"]),
      latencyMs: r["latency_ms"] === null ? null : Number(r["latency_ms"]),
      settled: Number(r["settled"]) === 1,
      schemaOk: r["schema_ok"] === null ? null : Number(r["schema_ok"]) === 1,
      coldStart: Number(r["cold_start"]) === 1,
      clientError: Number(r["client_error"] ?? 0) === 1,
      failureReason: r["failure_reason"] === null ? null : String(r["failure_reason"]),
    }));
  }

  /** Every outcome, oldest first. For the snapshot export, not for scoring. */
  allOutcomes() {
    const rows = this.db
      .prepare(`SELECT * FROM outcomes ORDER BY at ASC, id ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      resourceUrl: String(r["resource_url"]),
      at: String(r["at"]),
      ok: Number(r["ok"]) === 1,
      httpStatus: r["http_status"] === null ? null : Number(r["http_status"]),
      latencyMs: r["latency_ms"] === null ? null : Number(r["latency_ms"]),
      settled: Number(r["settled"]) === 1,
      schemaOk: r["schema_ok"] === null ? null : Number(r["schema_ok"]) === 1,
      coldStart: Number(r["cold_start"]) === 1,
      clientError: Number(r["client_error"] ?? 0) === 1,
      failureReason: r["failure_reason"] === null ? null : String(r["failure_reason"]),
    }));
  }

  outcomeCount(resourceUrl?: string): number {
    const row = (
      resourceUrl
        ? this.db
            .prepare(`SELECT COUNT(*) AS n FROM outcomes WHERE resource_url = ?`)
            .get(resourceUrl)
        : this.db.prepare(`SELECT COUNT(*) AS n FROM outcomes`).get()
    ) as Record<string, unknown>;
    return Number(row["n"] ?? 0);
  }

  putSubstitution(s: {
    at: string;
    refusedUrl: string;
    refusedScore: number | null;
    chosenUrl: string | null;
    chosenScore: number | null;
    reason: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO substitutions
           (at, refused_url, refused_score, chosen_url, chosen_score, reason)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(s.at, s.refusedUrl, s.refusedScore, s.chosenUrl, s.chosenScore, s.reason);
  }

  substitutions(limit = 50) {
    const rows = this.db
      .prepare(`SELECT * FROM substitutions ORDER BY at DESC, id DESC LIMIT ?`)
      .all(Math.min(limit, 200)) as Record<string, unknown>[];
    return rows.map((r) => ({
      at: String(r["at"]),
      refusedUrl: String(r["refused_url"]),
      refusedScore: r["refused_score"] === null ? null : Number(r["refused_score"]),
      chosenUrl: r["chosen_url"] === null ? null : String(r["chosen_url"]),
      chosenScore: r["chosen_score"] === null ? null : Number(r["chosen_score"]),
      reason: String(r["reason"]),
    }));
  }

  /**
   * Records USDC arriving at the payer. Idempotent by transaction id.
   *
   * `kind` is decided by the caller, which knows whether we have ever paid the sender.
   */
  putInflow(i: {
    txId: string;
    fromAddress: string;
    amountBase: number;
    assetId: string;
    network: string;
    kind: "refund" | "funding";
    confirmedRound: number | null;
    receivedAt: string;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO inflows
           (tx_id, from_address, amount_base, asset_id, network, kind, confirmed_round, received_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (tx_id) DO NOTHING`,
      )
      .run(
        i.txId,
        i.fromAddress,
        i.amountBase,
        i.assetId,
        i.network,
        i.kind,
        i.confirmedRound,
        i.receivedAt,
      );
    return Number(result.changes) > 0;
  }

  inflows(limit = 100) {
    const rows = this.db
      .prepare(`SELECT * FROM inflows ORDER BY received_at DESC LIMIT ?`)
      .all(Math.min(limit, 500)) as Record<string, unknown>[];
    return rows.map((r) => ({
      txId: String(r["tx_id"]),
      fromAddress: String(r["from_address"]),
      amountBase: Number(r["amount_base"]),
      assetId: String(r["asset_id"]),
      network: String(r["network"]),
      kind: String(r["kind"]) as "refund" | "funding",
      confirmedRound: r["confirmed_round"] === null ? null : Number(r["confirmed_round"]),
      receivedAt: String(r["received_at"]),
    }));
  }

  /** True when we have ever paid this address, which makes money back a refund. */
  hasPaid(address: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM receipts WHERE direction = 'out' AND payee = ? LIMIT 1`)
      .get(address) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? String(row["value"]) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?,?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Reserved plus settled spend for a UTC day. Released reservations do not count. */
  committedToday(day: string, merchant?: string): number {
    const sql =
      `SELECT COALESCE(SUM(amount_base),0) AS total FROM spend_log
        WHERE day = ? AND state IN ('reserved','settled')` +
      (merchant ? ` AND merchant = ?` : ``);
    const row = (
      merchant
        ? this.db.prepare(sql).get(day, merchant)
        : this.db.prepare(sql).get(day)
    ) as Record<string, unknown>;
    const logged = Number(row["total"] ?? 0);
    if (merchant) return logged;

    // The daily total also counts today's outbound payments as the CHAIN records them. On a
    // host that loses its disk on every cold start the spend log begins empty, which would reset
    // the daily cap to zero each time. Receipts are rebuilt from the indexer, so taking the
    // larger of the two keeps the cap honest across restarts without double counting a payment
    // that appears in both. (The per-merchant cap stays log-only: a chain receipt names an
    // address, not the service URL the log keys on.)
    const onChain = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_base),0) AS total FROM receipts
          WHERE direction = 'out' AND substr(settled_at, 1, 10) = ?`,
      )
      .get(day) as Record<string, unknown>;
    return Math.max(logged, Number(onChain["total"] ?? 0));
  }

  /**
   * Checks both daily caps and writes the reservation inside one transaction.
   *
   * BEGIN IMMEDIATE takes the write lock up front, so two concurrent callers
   * cannot both read the same headroom and both reserve against it. Without this
   * the guard would be advisory rather than enforcing.
   */
  tryReserveSpend(args: {
    id: string;
    merchant: string;
    route: string;
    amountBase: number;
    day: string;
    perDayBase: number;
    perMerchantPerDayBase: number;
  }):
    | { ok: true; id: string }
    | { ok: false; breached: "per_day" | "per_merchant_per_day"; committed: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const dayTotal = this.committedToday(args.day);
      if (dayTotal + args.amountBase > args.perDayBase) {
        this.db.exec("ROLLBACK");
        return { ok: false, breached: "per_day", committed: dayTotal };
      }

      const merchantTotal = this.committedToday(args.day, args.merchant);
      if (merchantTotal + args.amountBase > args.perMerchantPerDayBase) {
        this.db.exec("ROLLBACK");
        return { ok: false, breached: "per_merchant_per_day", committed: merchantTotal };
      }

      this.db
        .prepare(
          `INSERT INTO spend_log
             (id, merchant, route, amount_base, state, tx_id, created_at, day)
           VALUES (?,?,?,?, 'reserved', NULL, ?, ?)`,
        )
        .run(
          args.id,
          args.merchant,
          args.route,
          args.amountBase,
          new Date().toISOString(),
          args.day,
        );
      this.db.exec("COMMIT");
      return { ok: true, id: args.id };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  resolveSpend(id: string, state: "settled" | "released", txId: string | null): void {
    // Only a reservation can be resolved, so a duplicate settle is a no-op
    // rather than double-counting or resurrecting released headroom.
    this.db
      .prepare(
        `UPDATE spend_log SET state = ?, tx_id = ? WHERE id = ? AND state = 'reserved'`,
      )
      .run(state, txId, id);
  }

  spendLog(limit = 100): {
    id: string;
    merchant: string;
    route: string;
    amountBase: number;
    state: string;
    txId: string | null;
    createdAt: string;
  }[] {
    const rows = this.db
      .prepare(`SELECT * FROM spend_log ORDER BY created_at DESC LIMIT ?`)
      .all(Math.min(limit, 500)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r["id"]),
      merchant: String(r["merchant"]),
      route: String(r["route"]),
      amountBase: Number(r["amount_base"]),
      state: String(r["state"]),
      txId: r["tx_id"] === null ? null : String(r["tx_id"]),
      createdAt: String(r["created_at"]),
    }));
  }

  getCursor(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM listener_state WHERE key = ?`).get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? String(row["value"]) : null;
  }

  setCursor(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO listener_state (key, value) VALUES (?,?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

export interface ServiceRow {
  resourceUrl: string;
  method: string;
  description: string;
  payTo: string;
  network: string;
  amountBase: number;
  assetId: string;
  settleCount: number;
  lastSeen: string;
  hasDiscoveryInfo: boolean;
  /** The body example the service publishes, or null when it publishes none. */
  discoveryInput: unknown;
  allowlisted: boolean;
  active: boolean;
  probeVerdict: string | null;
  probeStatus: number | null;
  probeLatencyMs: number | null;
  probeLiveAmount: number | null;
  probeDrift: number | null;
  probeColdStart: boolean | null;
  probeDetail: string | null;
  probedAt: string | null;
}

function toService(r: Record<string, unknown>): ServiceRow {
  const num = (k: string) => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
  const str = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    resourceUrl: String(r["resource_url"]),
    method: String(r["method"]),
    description: String(r["description"]),
    payTo: String(r["pay_to"]),
    network: String(r["network"]),
    amountBase: Number(r["amount_base"]),
    assetId: String(r["asset_id"]),
    settleCount: Number(r["settle_count"]),
    lastSeen: String(r["last_seen"]),
    hasDiscoveryInfo: Number(r["has_discovery"]) === 1,
    discoveryInput: (() => {
      const raw = r["discovery_input"];
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(String(raw));
      } catch {
        return null;
      }
    })(),
    allowlisted: Number(r["allowlisted"]) === 1,
    active: Number(r["active"]) === 1,
    probeVerdict: str("probe_verdict"),
    probeStatus: num("probe_status"),
    probeLatencyMs: num("probe_latency_ms"),
    probeLiveAmount: num("probe_live_amount"),
    probeDrift: num("probe_drift"),
    probeColdStart: r["probe_cold_start"] === null ? null : Number(r["probe_cold_start"]) === 1,
    probeDetail: str("probe_detail"),
    probedAt: str("probed_at"),
  };
}

function toReceipt(r: Record<string, unknown>): ReceiptRow {
  return {
    txId: String(r["tx_id"]),
    direction: r["direction"] as Direction,
    route: String(r["route"]),
    payer: String(r["payer"]),
    payee: String(r["payee"]),
    amountBase: Number(r["amount_base"]),
    assetId: String(r["asset_id"]),
    network: String(r["network"]),
    confirmedRound: r["confirmed_round"] === null ? null : Number(r["confirmed_round"]),
    settledAt: String(r["settled_at"]),
    traceId: r["trace_id"] === null ? null : String(r["trace_id"]),
    latencyMs: r["latency_ms"] === null ? null : Number(r["latency_ms"]),
  };
}
