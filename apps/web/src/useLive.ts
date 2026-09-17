import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowShape, Receipt, Stats, StreamState, Trace } from "./types";

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
      const [s, r] = await Promise.all([
        fetch("/api/stats").then((x) => x.json() as Promise<Stats>),
        fetch("/api/receipts?limit=25").then(
          (x) => x.json() as Promise<{ receipts: Receipt[] }>,
        ),
      ]);
      setStats(s);
      setReceipts(r.receipts);
    } catch {
      // Leave the last known values in place; the stream indicator carries the
      // failure. Blanking real numbers on a transient error is worse.
    }
  }, []);

  useEffect(() => {
    fetch("/api/flow")
      .then((r) => r.json() as Promise<FlowShape>)
      .then(setFlow)
      .catch(() => setFlow(null));
    void refreshSideData();
  }, [refreshSideData]);

  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
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
          stats: Stats;
        };
        setTraces(payload.traces.slice(0, 25));
        setStats((prev) => ({ ...(prev ?? ({} as Stats)), ...payload.stats }));
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
  }, [upsert, refreshSideData]);

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

  return { traces, stats, flow, receipts, streamState, lastPing, sendUnpaidRequest };
}
