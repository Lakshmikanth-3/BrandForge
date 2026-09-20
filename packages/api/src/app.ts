import { Hono } from "hono";
import { cors } from "hono/cors";
import { publicConfig, type AppConfig } from "@sentry402/shared";
import { accountStatus, type AccountStatus } from "./chain.js";
import { Store } from "./db.js";
import { TraceHub } from "./trace.js";
import { traceMiddleware } from "./tracing.js";
import { apiRoutes } from "./api.js";
import { ROUTE_PATHS, publicUrlMiddleware, x402Middleware } from "./x402.js";
import { SettlementListener } from "./listener.js";
import { SYNC_BEFORE_PATHS, ThrottledSync } from "./sync.js";
import { CatalogIngester } from "./catalog.js";
import { metadataRoutes } from "./metadata.js";
import { BudgetGuard, DEFAULT_LIMITS, type BudgetLimits } from "./budget.js";
import { orchestrateHandler } from "./orchestrate.js";
import { DownstreamPayer } from "./payer.js";
import { TrustEngine } from "./trust.js";
import { INJECT_PREFIX, mountInjectRoutes } from "./inject.js";
import { TtlCache } from "./trustcache.js";
import type { TrustRecord } from "./trust.js";

export interface DependencyStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail?: string;
}

async function probe(name: string, url: string): Promise<DependencyStatus> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    return {
      name,
      ok: res.ok,
      latencyMs: Date.now() - started,
      ...(res.ok ? {} : { detail: `HTTP ${res.status}` }),
    };
  } catch (err) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : "unknown error",
    };
  }
}

export interface HealthReport {
  readonly status: "ok" | "degraded";
  readonly config: ReturnType<typeof publicConfig>;
  readonly accounts: { readonly merchant: AccountStatus; readonly payer: AccountStatus };
  readonly dependencies: readonly DependencyStatus[];
  readonly checkedAt: string;
}

export async function healthReport(config: AppConfig): Promise<HealthReport> {
  const [merchant, payer, facilitator, algod] = await Promise.all([
    accountStatus(config.network, config.merchantAddress),
    accountStatus(config.network, config.payerAddress),
    probe("facilitator", `${config.facilitatorUrl}/supported`),
    probe("algod", `${config.network.algodUrl}/v2/status`),
  ]);

  const dependencies = [facilitator, algod];
  // Degraded, not failed: the process is up and can report why it is unhappy.
  const healthy =
    dependencies.every((d) => d.ok) && merchant.usdcOptedIn && payer.usdcOptedIn;

  return {
    status: healthy ? "ok" : "degraded",
    config: publicConfig(config),
    accounts: { merchant, payer },
    dependencies,
    checkedAt: new Date().toISOString(),
  };
}

export interface AppParts {
  app: Hono;
  store: Store;
  hub: TraceHub;
  listener: SettlementListener;
  ingester: CatalogIngester;
  guard: BudgetGuard;
  trust: TrustEngine;
  /** Null when the payer could not be constructed; the API still serves. */
  payer: DownstreamPayer | null;
}

/** Prices in USDC base units. Kept as integers; floats never hold money. */
const ORCHESTRATE_PRICE_BASE = 50_000; // $0.05
const TRUST_PRICE_BASE = 20_000; // $0.02

export interface AppOptions {
  /**
   * Run without a long-lived process.
   *
   * A serverless function starts for a request and may be discarded when it responds, so it
   * has no background timer and cannot hold a live event stream open. In this mode the read
   * endpoints that depend on receipts sync from the chain on demand (throttled), and the
   * live stream is reported as unavailable so the dashboard polls instead of showing a
   * connection that can never establish as though it had failed.
   */
  serverless?: boolean;
}

/**
 * Optional tighter caps for a host that holds a wallet. Each is in USDC base units, and an unset
 * or invalid value falls back to the default, so a typo can only ever leave the defaults in
 * place and never silently remove a cap.
 */
function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetLimits {
  const pick = (name: string, fallback: number): number => {
    const n = Number(env[name]);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    perCallBase: pick("BUDGET_PER_CALL_BASE", DEFAULT_LIMITS.perCallBase),
    perDayBase: pick("BUDGET_PER_DAY_BASE", DEFAULT_LIMITS.perDayBase),
    perMerchantPerDayBase: pick("BUDGET_PER_MERCHANT_BASE", DEFAULT_LIMITS.perMerchantPerDayBase),
  };
}

export function createApp(
  config: AppConfig,
  storePath?: string,
  options: AppOptions = {},
): AppParts {
  const serverless = options.serverless === true;
  const app = new Hono();
  const store = new Store(storePath ?? "data/sentry402.sqlite");
  const hub = new TraceHub(store, config.network.name);
  hub.hydrate();
  const listener = new SettlementListener(
    config.network,
    store,
    config.merchantAddress,
    ROUTE_PATHS.orchestrate,
    // Outbound too: a downstream that returns no transaction id leaves the request
    // path nothing to key a receipt on, so the chain is the only source for it.
    config.payerAddress,
  );

  // The facilitator's probe checks CORS headers (PRD §19).
  app.use("*", cors({ origin: "*", allowHeaders: ["*"], exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));

  app.get("/healthz", async (c) => {
    const report = await healthReport(config);
    return c.json(report, report.status === "ok" ? 200 : 503);
  });

  // Liveness only — never touches the network, so a chain outage can't restart us.
  app.get("/livez", (c) => c.json({ alive: true, buildSha: config.buildSha }));

  const ingester = new CatalogIngester(config.network, store, config.facilitatorUrl);
  const guard = new BudgetGuard(store, limitsFromEnv());
  const trust = new TrustEngine(store);

  // A bad payer key must not take the whole API down: /healthz still needs to be
  // able to report why the bridge cannot spend.
  let payer: DownstreamPayer | null = null;
  try {
    payer = new DownstreamPayer(config, store, guard, hub, trust);
  } catch (err) {
    console.error(
      "payer disabled:",
      err instanceof Error ? err.message : "could not construct payer",
    );
  }

  if (serverless) {
    // Bring receipts up to date from the chain before any endpoint that reads them.
    const sync = new ThrottledSync(() => listener.poll());
    app.use("/api/*", async (c, next) => {
      if (SYNC_BEFORE_PATHS.test(c.req.path)) await sync.ensureFresh();
      await next();
    });
  }

  app.route("/api", apiRoutes(config, store, hub, guard, trust, payer, { live: !serverless }));

  // Deliberately broken endpoints for failure injection. Null on mainnet, where
  // routes that exist to misbehave have no business on the probed domain.
  const inject = mountInjectRoutes(config);
  if (inject) app.route(INJECT_PREFIX, inject);
  // Served at the root, since the facilitator probes the domain, not a subpath.
  app.route("/", metadataRoutes(config));

  // Order matters: the tracer wraps the payment middleware so it observes both
  // the 402 it issues and the settlement it completes.
  app.use(`${ROUTE_PATHS.orchestrate}`, traceMiddleware(hub, store, config, ORCHESTRATE_PRICE_BASE));
  app.use(`${ROUTE_PATHS.orchestrate}`, publicUrlMiddleware(config));
  app.use(`${ROUTE_PATHS.orchestrate}`, x402Middleware(config));

  // Paid trust lookup. Cached, because a score recomputed from unchanged outcomes
  // is the same number and serving it twice from the database is waste.
  const trustCache = new TtlCache<TrustRecord>();

  app.use(
    ROUTE_PATHS.trust,
    traceMiddleware(hub, store, config, TRUST_PRICE_BASE),
  );
  app.use(ROUTE_PATHS.trust, publicUrlMiddleware(config));
  app.use(ROUTE_PATHS.trust, x402Middleware(config));

  app.get(ROUTE_PATHS.trust, (c) => {
    const url = c.req.query("url");
    if (!url) {
      return c.json({ error: "url query parameter required" }, 400);
    }

    const cached = trustCache.get(url);
    if (cached) return c.json({ ...cached, cached: true });

    // The same call the payment gate makes. Selling a different number than the
    // one we act on would make both worthless.
    const record = trust.recordFor(url);
    trustCache.set(url, record);
    return c.json({ ...record, cached: false });
  });

  // Phase 1 payload is a stub. Phase 3 replaces this body with the bridged call;
  // the payment path above does not change.
  app.post(ROUTE_PATHS.orchestrate, orchestrateHandler({ config, store, payer, trust }));

  return { app, store, hub, listener, ingester, guard, trust, payer };
}
