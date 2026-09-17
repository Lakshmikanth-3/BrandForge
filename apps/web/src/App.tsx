import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FlowVisualiser } from "./FlowVisualiser";
import { useLive } from "./useLive";
import type { Receipt, Trace } from "./types";

const INSTALL_SNIPPET = `{
  "mcpServers": {
    "sentry402": {
      "command": "npx",
      "args": ["-y", "@sentry402/mcp"]
    }
  }
}`;

export default function App() {
  const { traces, stats, flow, receipts, streamState, sendUnpaidRequest } = useLive();
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
            An agent that needs a live service today has to sign up, store a key, and manage
            a subscription for something it may use twice. x402 fixed the billing. It did not
            fix discovery, and it did not fix trust. Paying a stranger&apos;s endpoint is a leap
            of faith with money you cannot get back. So the services exist, and nobody calls them.
          </p>
        </div>
        <div>
          <h2>What this is</h2>
          <p>
            One MCP server. Your agent discovers every live x402 service on Algorand, checks
            whether each one actually delivers before paying it, and settles per call in USDC
            under a budget you set. Install once. Your agent never sees a wallet.
          </p>
        </div>
        <div>
          <h2>Why here</h2>
          <p>
            Payments worth fractions of a cent need sub-cent fees and sub-three-second finality.
            An agent deciding in 200ms cannot wait on settlement or pay more in fees than the
            data costs.
          </p>
          <p className="emph">
            Every call routed through this bridge is volume for another entrant&apos;s endpoint.
            This project does not only compete on the leaderboard — it feeds it.
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
        </div>
        <p className="note">
          Phase 3 publishes the MCP server. The config block a developer copies will be this:
        </p>
        <pre className="snippet">{INSTALL_SNIPPET}</pre>
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
