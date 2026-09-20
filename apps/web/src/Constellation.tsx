import { motion } from "framer-motion";
import type { Receipt } from "./types";

/**
 * Who has actually paid us, drawn from real inbound receipts.
 *
 * One node per distinct payer address, orbiting the merchant. Node size follows how much that
 * payer really paid, and every node links to its transaction. Nothing is invented: with no
 * inbound receipts it says so instead of drawing a decorative sky. Payers we control (the
 * bootstrap and the e2e customer) are still shown, because hiding them would overstate how
 * independent the volume is; the caption says they are included.
 */
const SIZE = 320;
const C = SIZE / 2;

export function Constellation({ receipts }: { receipts: Receipt[] }) {
  const inbound = receipts.filter((r) => r.direction === "in");
  const byPayer = new Map<string, { total: number; last: Receipt }>();
  for (const r of inbound) {
    const cur = byPayer.get(r.payer);
    byPayer.set(r.payer, {
      total: (cur?.total ?? 0) + r.amountUsdc,
      last: cur && cur.last.settledAt > r.settledAt ? cur.last : r,
    });
  }
  const payers = [...byPayer.entries()].slice(0, 24);

  if (payers.length === 0) {
    return (
      <div className="panel constellation-empty">
        <span className="dim">No inbound payments yet, so no payers to draw.</span>
      </div>
    );
  }

  const max = Math.max(...payers.map(([, v]) => v.total));
  return (
    <div className="panel constellation">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${payers.length} distinct payers`}>
        <circle cx={C} cy={C} r={112} className="orbit" />
        <motion.circle
          cx={C}
          cy={C}
          r={16}
          className="core"
          animate={{ r: [16, 19, 16] }}
          transition={{ repeat: Infinity, duration: 3 }}
        />
        {payers.map(([addr, v], i) => {
          const a = (i / payers.length) * Math.PI * 2 - Math.PI / 2;
          const x = C + Math.cos(a) * 112;
          const y = C + Math.sin(a) * 112;
          const r = 5 + (v.total / max) * 9;
          return (
            <g key={addr}>
              <line x1={C} y1={C} x2={x} y2={y} className="ray" />
              <motion.a
                href={v.last.explorerUrl}
                target="_blank"
                rel="noreferrer"
                initial={{ opacity: 0, scale: 0 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.08 }}
              >
                <circle cx={x} cy={y} r={r} className="star">
                  <title>{`${addr.slice(0, 8)}… paid ${v.total.toFixed(2)} USDC`}</title>
                </circle>
              </motion.a>
            </g>
          );
        })}
      </svg>
      <p className="dim constellation-cap">
        {payers.length} distinct payer{payers.length === 1 ? "" : "s"}. Node size is USDC paid. Includes
        accounts we operate.
      </p>
    </div>
  );
}
