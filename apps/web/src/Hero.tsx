import { useEffect, useState } from "react";
import { motion } from "framer-motion";

/**
 * The landing hero: what the product does, as a looping walkthrough.
 *
 * This is an EXPLAINER, not telemetry, and it says so on screen. The live flow further down
 * is the one drawn from real traces. Keeping the two visibly separate is deliberate: an
 * animation that looks live but is scripted is exactly the kind of thing this project exists
 * to distrust.
 */
const STEPS = [
  { key: "agent", title: "Agent asks", body: "Your agent calls a tool. It never sees a wallet or a 402." },
  { key: "trust", title: "Trust check", body: "The service's record, built from real paid calls, is read first." },
  { key: "budget", title: "Spend cap", body: "Funds are reserved under per-call, per-day and per-merchant caps." },
  { key: "pay", title: "x402 payment", body: "USDC settles on Algorand in about three seconds." },
  { key: "receipt", title: "Receipt", body: "The result comes back with the on-chain transaction id." },
] as const;

export function Hero() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="hero" aria-label="What Sentry402 does">
      <div className="mesh" aria-hidden="true" />
      <motion.div
        className="hero-copy"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: "easeOut" }}
      >
        <span className="eyebrow">x402 · Algorand · MCP</span>
        <h2 className="hero-title">
          Agents that pay, <span className="grad">without paying blind.</span>
        </h2>
        <p className="hero-sub">
          One MCP server that checks a service&apos;s record, enforces a spending budget, then pays it
          in USDC, and hands your agent the result with a receipt. Install from source; see the README.
        </p>
        <code className="install">node packages/mcp/dist/index.js</code>
      </motion.div>

      <div className="walk" role="list">
        {STEPS.map((s, i) => (
          <motion.div
            role="listitem"
            key={s.key}
            className={`walk-step ${i === active ? "on" : i < active ? "past" : ""}`}
            animate={{ scale: i === active ? 1.04 : 1, opacity: i === active ? 1 : 0.55 }}
            transition={{ duration: 0.35 }}
          >
            <span className="walk-n">{i + 1}</span>
            <strong>{s.title}</strong>
            <span className="walk-body">{s.body}</span>
          </motion.div>
        ))}
      </div>
      <p className="hero-note">Illustrative walkthrough. The live flow below is drawn from real traces.</p>
    </section>
  );
}
