import { Hono } from "hono";
import { cors } from "hono/cors";
import { publicConfig, type AppConfig } from "@sentry402/shared";
import { accountStatus, type AccountStatus } from "./chain.js";

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

export function createApp(config: AppConfig): Hono {
  const app = new Hono();

  // The facilitator's probe checks CORS headers (PRD §19).
  app.use("*", cors({ origin: "*", allowHeaders: ["*"], exposeHeaders: ["*"] }));

  app.get("/healthz", async (c) => {
    const report = await healthReport(config);
    return c.json(report, report.status === "ok" ? 200 : 503);
  });

  // Liveness only — never touches the network, so a chain outage can't restart us.
  app.get("/livez", (c) => c.json({ alive: true, buildSha: config.buildSha }));

  return app;
}
