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
  outboundBase: number;
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

-- Cursor for the indexer settlement listener, so a restart does not rescan
-- from genesis and does not miss rounds.
CREATE TABLE IF NOT EXISTS listener_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);
`;

export class Store {
  private readonly db: SqliteDatabase;

  constructor(path = "data/sentry402.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
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

    return {
      settleCount: Number(inbound["n"] ?? 0),
      totalBase: Number(inbound["total"] ?? 0),
      distinctPayers: Number(inbound["payers"] ?? 0),
      outboundCount: Number(outbound["n"] ?? 0),
      outboundBase: Number(outbound["total"] ?? 0),
      firstSettledAt: (inbound["first"] as string | null) ?? null,
      lastSettledAt: (inbound["last"] as string | null) ?? null,
    };
  }

  saveTrace(t: {
    id: string;
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
        `INSERT INTO traces (id, route, network, state, payer, tx_id, total_ms, created_at, steps_json)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET
           state = excluded.state, payer = excluded.payer, tx_id = excluded.tx_id,
           total_ms = excluded.total_ms, steps_json = excluded.steps_json`,
      )
      .run(
        t.id,
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
