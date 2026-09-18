import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FlowVisualiser } from "./FlowVisualiser";
import { useLive } from "./useLive";
import type { Budget, Receipt, Service, Substitution, Trace, TrustRecord } from "./types";

/**
 * The config that works today. It points at a local build rather than an npm
 * package, because the package is not published yet: showing an npx snippet would
 * be a copy-paste that fails.
 */
const INSTALL_SNIPPET = `{
  "mcpServers": {
    "sentry402": {
      "command": "node",
      "args": ["/path/to/Sentry402/packages/mcp/dist/index.js"],
      "env": { "NETWORK": "testnet" }
    }
  }
}`;

export default function App() {
  const {
    traces,
    stats,
    flow,
    receipts,
    budget,
    services,
    substitutions,
    streamState,
    sendUnpaidRequest,
  } = useLive();
  const [sending, setSending] = useState(false);
  const [lastStatus, setLastStatus] = useState<number | null>(null);

  // The trace to feature: whichever is running, else the most recent.
  const featured = useMemo<Trace | null>(() => {
    const running = traces.find((t) => t.state === "running" || t.state === "stalled");
    return running ?? traces[0] ?? null;
  }, [traces]);

  const onSend = async () => {
    setSending(true);
    setLastStatus(null);
    try {
      setLastStatus(await sendUnpaidRequest());
    } catch {
      setLastStatus(0);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="wrap">
      <header className="head">
        <div className="head-left">
          <h1>Sentry402</h1>
          <span className={`tag net net-${stats?.network ?? "unknown"}`}>
            {stats?.network ?? "—"}
          </span>
          <span className={`tag stream stream-${streamState}`}>
            <span className="dot" /> stream {streamState}
          </span>
        </div>
        <div className="counters">
          <Counter label="settles" value={stats ? String(stats.settleCount) : "—"} />
          <Counter
            label="usdc in"
            value={stats ? stats.totalUsdc.toFixed(6) : "—"}
          />
          <Counter
            label="distinct payers"
            value={stats ? String(stats.distinctPayers) : "—"}
            emphasis
          />
        </div>
      </header>

      <section className="pitch">
        <div>
          <h2>The problem</h2>
          <p>
            x402 fixed the billing: an agent pays per call over HTTP, no account, no key.
            What it did not fix is the wiring. Using a paid service still means a developer
            hand-writing an integration, holding a wallet, and trusting an endpoint with
            money that cannot be recalled. So the services exist and the demand does not.
          </p>
        </div>
        <div>
          <h2>What this is</h2>
          <p>
            One MCP server. Install it once and your agent gains every curated x402 service
            on Algorand as a native tool, priced per call, paid in USDC, under a spend cap
            you set. Your agent never sees a wallet and never handles a 402.
          </p>
          <p>
            Relays and pre-spend checkers exist. An agent-native install and an enforced
            budget with a kill switch do not.
          </p>
        </div>
        <div>
          <h2>Why here</h2>
          <p>
            Payments worth fractions of a cent need sub-cent fees and sub-three-second
            finality. An agent deciding in 200ms cannot wait on settlement or pay more in
            fees than the data costs.
          </p>
          <p className="emph">
            Every call routed through this bridge is volume for another entrant&apos;s
            endpoint. This project does not only compete on the leaderboard &mdash; it
            feeds it.
          </p>
        </div>
      </section>

      <section>
        <div className="sec-head">
          <h3>Live protocol flow</h3>
          <div className="sec-actions">
            <button className="btn" onClick={onSend} disabled={sending}>
              {sending ? "sending…" : "Send an unpaid request"}
            </button>
            {lastStatus !== null ? (
              <span className={`resp ${lastStatus === 402 ? "resp-ok" : "resp-bad"}`}>
                HTTP {lastStatus === 0 ? "failed" : lastStatus}
                {lastStatus === 402 ? " — payment required, as specified" : ""}
              </span>
            ) : null}
          </div>
        </div>
        <p className="note">
          This fires a real request at the real paid route, <code>POST {flow?.routes.orchestrate ?? "/v1/orchestrate"}</code>{" "}
          ({flow?.prices.orchestrate ?? "$0.05"}). With no payment attached it stops at the 402 —
          which is exactly what the flow below will show you. Nothing here is replayed.
        </p>

        <div className="panel">
          <FlowVisualiser trace={featured} flow={flow} streamDown={streamState === "down"} />
        </div>

        <TraceHistory traces={traces} />
      </section>

      <section>
        <div className="sec-head">
          <h3>Install</h3>
          <span className="dim mono">{services.length} services as agent tools</span>
        </div>
        <p className="note">
          Build the repo, then add this to your MCP client. It points at a local build
          because the npm package is not published yet, and a published-package snippet
          here would be a copy-paste that fails.
        </p>
        <pre className="snippet">{INSTALL_SNIPPET}</pre>
      </section>

      <section>
        <div className="sec-head">
          <h3>Services the bridge can pay</h3>
          <span className="dim mono">verified by live probe, not by the catalog</span>
        </div>
        <ServiceTable services={services} />
      </section>

      <section>
        <div className="sec-head">
          <h3>Route-around log</h3>
          <span className="dim mono">a refusal is a feature</span>
        </div>
        <SubstitutionLog substitutions={substitutions} />
      </section>

      <section>
        <div className="sec-head">
          <h3>Budget guard</h3>
          {budget ? (
            <span className={`tag ${budget.halted ? "halted" : ""}`}>
              {budget.halted ? "HALTED" : budget.payerReady ? "armed" : "payer not ready"}
            </span>
          ) : null}
        </div>
        <BudgetPanel budget={budget} />
      </section>

      <section>
        <div className="sec-head">
          <h3>Receipts</h3>
          <span className="dim mono">
            {stats?.merchantAddress ? `merchant ${stats.merchantAddress.slice(0, 10)}…` : ""}
          </span>
        </div>
        <ReceiptStream receipts={receipts} />
      </section>

      <footer>
        <span className="mono dim">
          Every number on this page is read live from the API. No mock data, at any time.
          An empty table means nothing has settled yet.
        </span>
      </footer>
    </div>
  );
}

function ServiceTable({ services }: { services: Service[] }) {
  if (services.length === 0) {
    return (
      <p className="note dim">
        No services in the registry yet. Run <code>npm run catalog:ingest</code>.
      </p>
    );
  }
  return (
    <div className="panel scroll">
      <table>
        <thead>
          <tr>
            <th>tool</th>
            <th>price</th>
            <th>catalog</th>
            <th>trust</th>
            <th>probe</th>
            <th>latency</th>
            <th>what it returns</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const drifted = s.priceDrift !== null && Math.abs(s.priceDrift - 1) > 0.01;
            return (
              <tr key={s.label}>
                <td>
                  <span className={`dot ${s.probeVerdict === "ok" ? "ok" : "bad"}`} />
                  {s.label}
                </td>
                <td className="num">{s.priceUsdc === null ? "\u2014" : s.priceUsdc.toFixed(4)}</td>
                <td className={`num ${drifted ? "bad-text" : "dim"}`}>
                  {s.catalogPriceUsdc === null ? "\u2014" : s.catalogPriceUsdc.toFixed(4)}
                  {drifted && s.priceDrift !== null ? ` x${s.priceDrift.toFixed(2)}` : ""}
                </td>
                <td>
                  <TrustBadge trust={s.trust} />
                </td>
                <td className={s.probeVerdict === "ok" ? "ok-text" : "bad-text"}>
                  {s.probeVerdict ?? "not probed"}
                </td>
                <td className="num">
                  {s.probeLatencyMs === null ? "\u2014" : `${s.probeLatencyMs}ms`}
                </td>
                <td className="dim summary">{s.summary}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TrustBadge({ trust }: { trust: TrustRecord }) {
  // An unrated service shows as unrated, never as 0.00. A score from 4 calls must
  // not look like a score from 400, so the observation count rides along.
  if (trust.score === null) {
    return (
      <span className="trust trust-unrated" title={trust.basis}>
        unrated
        <span className="trust-n">{trust.observations}/5</span>
      </span>
    );
  }
  return (
    <span className={`trust trust-${trust.verdict}`} title={trust.basis}>
      <span className="num">{trust.score.toFixed(2)}</span>
      <span className="trust-n">n={trust.observations}</span>
    </span>
  );
}

function SubstitutionLog({ substitutions }: { substitutions: Substitution[] }) {
  if (substitutions.length === 0) {
    return (
      <p className="note dim">
        Nothing routed around yet. Each time the trust gate refuses an endpoint it is
        logged here with the score that caused it, whether or not an alternative existed.
      </p>
    );
  }
  return (
    <div className="panel scroll">
      <table>
        <thead>
          <tr>
            <th>refused</th>
            <th>score</th>
            <th>routed to</th>
            <th>score</th>
            <th>reason</th>
            <th>when</th>
          </tr>
        </thead>
        <tbody>
          {substitutions.map((sub) => (
            <tr key={`${sub.at}-${sub.refusedUrl}`}>
              <td className="addr bad-text">{hostOf(sub.refusedUrl)}</td>
              <td className="num bad-text">
                {sub.refusedScore === null ? "unrated" : sub.refusedScore.toFixed(2)}
              </td>
              <td className="addr ok-text">
                {sub.chosenUrl === null ? "no alternative" : hostOf(sub.chosenUrl)}
              </td>
              <td className="num ok-text">
                {sub.chosenScore === null ? "\u2014" : sub.chosenScore.toFixed(2)}
              </td>
              <td className="dim summary">{sub.reason}</td>
              <td className="dim">{new Date(sub.at).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function BudgetPanel({ budget }: { budget: Budget | null }) {
  if (!budget) {
    return <p className="note dim">/api/budget did not respond.</p>;
  }
  const used =
    budget.caps.perDayUsdc === 0 ? 0 : budget.spentTodayUsdc / budget.caps.perDayUsdc;
  return (
    <div className="panel budget">
      <div className="budget-row">
        <div>
          <span className="counter-label">spent today</span>
          <span className="counter-value num">{budget.spentTodayUsdc.toFixed(6)}</span>
        </div>
        <div>
          <span className="counter-label">remaining</span>
          <span className="counter-value num">{budget.remainingTodayUsdc.toFixed(6)}</span>
        </div>
        <div>
          <span className="counter-label">daily cap</span>
          <span className="counter-value num">{budget.caps.perDayUsdc.toFixed(2)}</span>
        </div>
        <div>
          <span className="counter-label">per call</span>
          <span className="counter-value num">{budget.caps.perCallUsdc.toFixed(2)}</span>
        </div>
      </div>
      <div
        className="meter"
        role="img"
        aria-label={`${Math.round(used * 100)} percent of the daily cap used`}
      >
        <motion.div
          className="meter-fill"
          animate={{ width: `${Math.min(100, used * 100)}%` }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        />
      </div>
      {budget.recent.length === 0 ? (
        <p className="note dim budget-empty">
          No outbound spend yet. Every reservation appears here, including ones released
          because the payment did not happen.
        </p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>route</th>
                <th>usdc</th>
                <th>state</th>
                <th>tx</th>
                <th>when</th>
              </tr>
            </thead>
            <tbody>
              {budget.recent.map((r) => (
                <tr key={r.id}>
                  <td>{r.route}</td>
                  <td className="num">{r.amountUsdc.toFixed(6)}</td>
                  <td className={`spend-${r.state}`}>{r.state}</td>
                  <td className="dim">{r.txId ? `${r.txId.slice(0, 10)}...` : "\u2014"}</td>
                  <td className="dim">{new Date(r.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Counter({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`counter ${emphasis ? "counter-emph" : ""}`}>
      <span className="counter-value num">{value}</span>
      <span className="counter-label">{label}</span>
    </div>
  );
}

/** Recent traces, newest first, so a judge can see more than the current one. */
function TraceHistory({ traces }: { traces: Trace[] }) {
  if (traces.length === 0) {
    return <p className="note dim">No traces yet. Send a request to produce one.</p>;
  }
  return (
    <div className="panel scroll trace-history">
      <table>
        <thead>
          <tr>
            <th>trace</th>
            <th>flow</th>
            <th>route</th>
            <th>outcome</th>
            <th>stopped at</th>
            <th>total</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => {
            const halt =
              t.steps.find((s) => s.state === "failed") ??
              t.steps.find((s) => s.state === "stalled");
            return (
              <tr key={t.id}>
                <td className="dim">{t.id.slice(0, 8)}</td>
                <td className={`flow-${t.flow}`}>{t.flow}</td>
                <td>{t.route}</td>
                <td className={`state-${t.state}`}>{t.state}</td>
                <td className="dim">{halt ? halt.label : "—"}</td>
                <td className="num">{t.totalMs === null ? "…" : `${t.totalMs}ms`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReceiptStream({ receipts }: { receipts: Receipt[] }) {
  if (receipts.length === 0) {
    return (
      <p className="note dim">
        No settlements yet. Rows appear here as USDC lands, each linking to the transaction
        on an explorer.
      </p>
    );
  }
  return (
    <div className="panel scroll">
      <table>
        <thead>
          <tr>
            <th>dir</th>
            <th>payer</th>
            <th>usdc</th>
            <th>latency</th>
            <th>settled</th>
            <th>tx</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {receipts.map((r) => (
              <motion.tr
                key={r.txId}
                initial={{ opacity: 0, backgroundColor: "rgba(47,129,247,0.14)" }}
                animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              >
                <td className={r.direction === "in" ? "dir-in" : "dir-out"}>{r.direction}</td>
                <td className="addr">{r.payer}</td>
                <td className="num">{r.amountUsdc.toFixed(6)}</td>
                <td className="num">{r.latencyMs === null ? "—" : `${r.latencyMs}ms`}</td>
                <td className="dim">{new Date(r.settledAt).toLocaleTimeString()}</td>
                <td>
                  <a href={r.explorerUrl} target="_blank" rel="noreferrer">
                    {r.txId.slice(0, 10)}…
                  </a>
                </td>
              </motion.tr>
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}
