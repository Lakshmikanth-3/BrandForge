import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { FlowShape, StepState, Trace } from "./types";

/**
 * The 402 handshake, rendered from a real trace.
 *
 * Fixed topology, so the SVG is hand-laid rather than driven by a graph library:
 * the only thing that changes is which node is in which state. Every colour,
 * every label and every duration below comes from the trace the server emitted.
 * When there is no trace, it says so and renders the pipeline inert — it never
 * invents a frame (PRD §16).
 */

const STATE_LABEL: Record<StepState, string> = {
  pending: "waiting",
  active: "in progress",
  ok: "done",
  failed: "failed",
  skipped: "not reached",
  stalled: "STALLED",
};

function nodeClass(state: StepState): string {
  return `node node-${state}`;
}

interface Props {
  trace: Trace | null;
  flow: FlowShape | null;
  streamDown: boolean;
}

export function FlowVisualiser({ trace, flow, streamDown }: Props) {
  const steps = trace?.steps ?? flow?.steps.map((s) => ({ ...s, state: "pending" as StepState, durationMs: null, detail: null, startedAt: null, endedAt: null })) ?? [];

  if (steps.length === 0) {
    return (
      <div className="panel flow-empty">
        <span className="dim">Flow shape unavailable — /api/flow did not respond.</span>
      </div>
    );
  }

  const activeIndex = steps.findIndex((s) => s.state === "active" || s.state === "stalled");
  const failedStep = steps.find((s) => s.state === "failed");
  const stalledStep = steps.find((s) => s.state === "stalled");

  // Where did it stop? This is the readout that matters most.
  const verdict = (() => {
    if (streamDown) return { kind: "down" as const, text: "STREAM DOWN — not receiving state" };
    if (!trace) return { kind: "idle" as const, text: "IDLE — no request yet" };
    if (stalledStep)
      return {
        kind: "stalled" as const,
        text: `STALLED AT ${stalledStep.label.toUpperCase()} — ${stalledStep.detail ?? "over budget"}`,
      };
    if (failedStep)
      return {
        kind: "failed" as const,
        text: `STOPPED AT ${failedStep.label.toUpperCase()} — ${failedStep.detail ?? "failed"}`,
      };
    if (trace.state === "running") {
      const cur = steps[activeIndex];
      return {
        kind: "running" as const,
        text: `RUNNING — ${cur ? cur.label.toUpperCase() : "starting"}`,
      };
    }
    return {
      kind: "ok" as const,
      text: `COMPLETE — ${trace.totalMs ?? 0}ms end to end`,
    };
  })();

  return (
    <div className="flow">
      <div className={`verdict verdict-${verdict.kind}`}>
        <span className="verdict-dot" />
        <span className="verdict-text">{verdict.text}</span>
        {trace ? <span className="verdict-id">trace {trace.id.slice(0, 8)}</span> : null}
      </div>

      <div className="rail" role="list" aria-label="Payment flow steps">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          return (
            <div className="rail-cell" key={step.id} role="listitem">
              <motion.div
                className={nodeClass(step.state)}
                animate={{
                  scale: step.state === "active" ? 1.04 : 1,
                }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <div className="node-head">
                  <span className="node-index">{i + 1}</span>
                  <span className="node-label">{step.label}</span>
                </div>

                <div className="node-state">{STATE_LABEL[step.state]}</div>

                <div className="node-meta">
                  {step.durationMs !== null ? (
                    <span className="num">{step.durationMs}ms</span>
                  ) : step.state === "active" || step.state === "stalled" ? (
                    <LiveTimer since={step.startedAt} />
                  ) : (
                    <span className="dim">—</span>
                  )}
                </div>

                <AnimatePresence>
                  {step.detail ? (
                    <motion.div
                      className="node-detail"
                      initial={{ opacity: 0, y: -2 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      {step.detail}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </motion.div>

              {!isLast ? <Connector from={step.state} to={steps[i + 1]!.state} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The wire between two steps. Animates only while payment is actually moving
 * across it — the packet is a consequence of real state, not a loop.
 */
function Connector({ from, to }: { from: StepState; to: StepState }) {
  const flowing = from === "ok" && (to === "active" || to === "stalled");
  const dead = from === "failed" || from === "skipped" || to === "skipped";

  return (
    <div className={`connector ${dead ? "connector-dead" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 60 12" preserveAspectRatio="none">
        <line
          x1="0"
          y1="6"
          x2="60"
          y2="6"
          className={from === "ok" && !dead ? "wire wire-live" : "wire"}
          strokeDasharray={dead ? "3 3" : undefined}
        />
        {flowing ? (
          <motion.circle
            r="3.2"
            cy="6"
            className="packet"
            initial={{ cx: 0 }}
            animate={{ cx: 60 }}
            transition={{ duration: 0.45, repeat: Infinity, ease: "linear" }}
          />
        ) : null}
      </svg>
    </div>
  );
}

/**
 * Milliseconds since a step began, on rAF. Deliberately not an animation
 * library: this number must be raw timing tied to the real request, never eased
 * or interpolated (PRD §16.C).
 */
function LiveTimer({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let raf = 0;
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      setNow(Date.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  if (since === null) return <span className="dim">—</span>;
  return <span className="num num-live">{now - since}ms</span>;
}
