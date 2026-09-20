import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Budget,
  FlowShape,
  Receipt,
  Service,
  Stats,
  StreamState,
  Substitution,
  Trace,
  VerificationReport,
  ReconcileReport,
} from "./types";

/**
 * Subscribes to the server's trace stream.
 *
 * The rule from the PRD: if data is unavailable the UI says so rather than
 * animating anyway. So `streamState` is surfaced, and a dropped connection
 * freezes the flow and shows "stream down" instead of replaying anything.
 */
export function useLive() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [flow, setFlow] = useState<FlowShape | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [substitutions, setSubstitutions] = useState<Substitution[]>([]);
  const [verification, setVerification] = useState<VerificationReport | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileReport | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const [lastPing, setLastPing] = useState<number | null>(null);

  const upsert = useCallback((incoming: Trace) => {
    setTraces((prev) => {
      const without = prev.filter((t) => t.id !== incoming.id);
      return [incoming, ...without].slice(0, 25);
    });
  }, []);

  const refreshSideData = useCallback(async () => {
    try {
      const [s, r, b, sv, sub] = await Promise.all([
        fetch("/api/stats").then((x) => x.json() as Promise<Stats>),
        fetch("/api/receipts?limit=25").then(
          (x) => x.json() as Promise<{ receipts: Receipt[] }>,
        ),
        fetch("/api/budget").then((x) => x.json() as Promise<Budget>),
        fetch("/api/services").then((x) => x.json() as Promise<{ services: Service[] }>),
        fetch("/api/substitutions").then(
          (x) => x.json() as Promise<{ substitutions: Substitution[] }>,
        ),
      ]);
      setStats(s);
      setReceipts(r.receipts);
      setBudget(b);
      setServices(sv.services);
      setSubstitutions(sub.substitutions);
    } catch {
      // Leave the last known values in place; the stream indicator carries the
      // failure. Blanking real numbers on a transient error is worse.
    }
  }, []);

  // Verification and reconciliation are slower, external calls. They load once and
  // refresh on demand rather than on the stream tick.
  const refreshProofs = useCallback(async () => {
    try {
      const [v, rec] = await Promise.all([
        fetch("/api/verification").then((x) => x.json() as Promise<VerificationReport>),
        // 409 is a real answer here: a dirty reconciliation is still a report.
        fetch("/api/reconcile").then((x) => x.json() as Promise<ReconcileReport>),
      ]);
      setVerification(v);
      setReconcile(rec);
    } catch {
      // Leave the last known report; the rows carry their own failure states.
    }
  }, []);

  useEffect(() => {
    void refreshProofs();
  }, [refreshProofs]);

  /**
   * How this host delivers live data. Unknown until /api/flow answers, because opening an
   * event stream against a host that cannot serve one just produces a reconnect loop that
   * reports "stream down" for something that was never going to work.
   */
  const [mode, setMode] = useState<"unknown" | "stream" | "poll">("unknown");

  useEffect(() => {
    fetch("/api/flow")
      .then((r) => r.json() as Promise<FlowShape>)
      .then((f) => {
        setFlow(f);
        setMode(f.stream === false ? "poll" : "stream");
      })
      .catch(() => {
        setFlow(null);
        // If we cannot even ask, fall back to the stream, which will honestly report down.
        setMode("stream");
      });
    void refreshSideData();
  }, [refreshSideData]);

  // Polling mode: same data, fetched on an interval.
  useEffect(() => {
    if (mode !== "poll") return;
    setStreamState("polling");
    let stopped = false;

    const tick = async () => {
      try {
        const res = await fetch("/api/traces?limit=25");
        const body = (await res.json()) as { traces: Trace[] };
        if (!stopped) setTraces(body.traces);
      } catch {
        // Keep the last known traces; the next tick retries.
      }
      if (!stopped) await refreshSideData();
    };

    void tick();
    const timer = setInterval(() => void tick(), 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [mode, refreshSideData]);

  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (mode !== "stream") return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const es = new EventSource("/api/stream");
      esRef.current = es;

      es.addEventListener("open", () => setStreamState("live"));

      es.addEventListener("snapshot", (e) => {
        const payload = JSON.parse((e as MessageEvent<string>).data) as {
          traces: Trace[];
        };
        setTraces(payload.traces.slice(0, 25));
        // Deliberately NOT merging payload.stats into state. The stream carries the raw
        // store figures in base units, with no totalUsdc, while the display reads the
        // derived /api/stats shape. Merging them made the header call totalUsdc.toFixed on
        // undefined whenever the stream's first message beat the stats request, React had no
        // error boundary, and the whole page rendered blank. Always fetch the derived shape.
        void refreshSideData();
        setStreamState("live");
      });

      es.addEventListener("trace", (e) => {
        const trace = JSON.parse((e as MessageEvent<string>).data) as Trace;
        upsert(trace);
        // A finished trace may have produced a receipt; pull the real rows.
        if (trace.state !== "running") void refreshSideData();
      });

      es.addEventListener("ping", (e) => {
        setLastPing(Number((e as MessageEvent<string>).data));
        setStreamState("live");
      });

      es.addEventListener("error", () => {
        setStreamState("down");
        es.close();
        esRef.current = null;
        if (!cancelled) retry = setTimeout(connect, 3_000);
      });
    };

    connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      esRef.current?.close();
    };
  }, [mode, upsert, refreshSideData]);

  /**
   * Fires a real unpaid request at the real paid route. Produces a genuine 402
   * and a genuine trace — nothing is simulated. Returns the HTTP status so the
   * caller can show what actually came back.
   */
  const sendUnpaidRequest = useCallback(async (): Promise<number> => {
    const res = await fetch("/v1/orchestrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ demo: true }),
    });
    return res.status;
  }, []);

  return {
    traces,
    stats,
    flow,
    receipts,
    budget,
    services,
    substitutions,
    verification,
    reconcile,
    refreshProofs,
    streamState,
    lastPing,
    sendUnpaidRequest,
  };
}
