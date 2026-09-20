// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

/**
 * Polling mode, for a host that cannot hold a live stream open.
 *
 * A serverless function has no process that outlives the request, so /api/flow reports
 * stream:false. The dashboard must then poll, and must not open an EventSource that can never
 * connect and report "stream down" for something that was never going to work.
 */

let streamsOpened = 0;
class CountingEventSource {
  constructor(public url: string) {
    streamsOpened += 1;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const FLOW = (stream: boolean) => ({
  steps: [],
  flows: { inbound: [], bridged: [] },
  routes: { orchestrate: "/v1/orchestrate", trust: "/v1/trust" },
  prices: { orchestrate: "$0.05", trust: "$0.02" },
  network: "testnet",
  explorerTxBase: "https://x.test/",
  stream,
});

const OTHER: Record<string, unknown> = {
  "/api/stats": {
    settleCount: 0, totalBase: 0, totalUsdc: 0, distinctPayers: 0, outboundCount: 0,
    outboundBase: 0, outboundUsdc: 0, refundBase: 0, refundUsdc: 0, netOutboundBase: 0,
    netOutboundUsdc: 0, firstSettledAt: null, lastSettledAt: null, network: "testnet",
    merchantAddress: "M",
  },
  "/api/receipts": { receipts: [], explorerTxBase: "" },
  "/api/budget": {
    halted: false, day: "d", spentTodayUsdc: 0, remainingTodayUsdc: 2,
    caps: { perCallUsdc: 0.25, perDayUsdc: 2, perMerchantPerDayUsdc: 0.5 },
    payerReady: false, payerAddress: null, recent: [],
  },
  "/api/services": { services: [] },
  "/api/substitutions": { substitutions: [], policy: { refuseBelow: 0.6, warnBelow: 0.8 } },
  "/api/verification": {
    network: "testnet", checkedAt: "2026-09-20T00:00:00.000Z", rows: [], passing: 0,
    failing: 0, merchantRecord: null, bazaarEntries: [],
  },
  "/api/reconcile": {
    network: "testnet", checkedAt: "2026-09-20T00:00:00.000Z", chainTransfers: 0, receipts: 0,
    matched: 0, clean: true, error: null, discrepancies: [],
  },
  "/api/traces": { traces: [] },
};

function fetchWith(stream: boolean) {
  const seen: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/api/flow")) return Response.json(FLOW(stream));
    const key = Object.keys(OTHER).find((k) => url.includes(k));
    return key ? Response.json(OTHER[key]) : new Response("{}", { status: 404 });
  });
  return { fn, seen };
}

beforeEach(() => {
  streamsOpened = 0;
  vi.stubGlobal("EventSource", CountingEventSource as unknown as typeof EventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a host that cannot hold a stream", () => {
  it("never opens an event stream", async () => {
    const { fn } = fetchWith(false);
    vi.stubGlobal("fetch", fn);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/stream polling/)).toBeTruthy());
    expect(streamsOpened).toBe(0);
  });

  it("shows polling, which is healthy, rather than down", async () => {
    const { fn } = fetchWith(false);
    vi.stubGlobal("fetch", fn);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/stream polling/)).toBeTruthy());
    expect(screen.queryByText(/stream down/)).toBeNull();
    expect(screen.queryByText(/STREAM DOWN/)).toBeNull();
  });

  it("fetches traces itself, since nothing will push them", async () => {
    const { fn, seen } = fetchWith(false);
    vi.stubGlobal("fetch", fn);
    render(<App />);
    await waitFor(() => expect(seen.some((u) => u.includes("/api/traces"))).toBe(true));
  });
});

describe("a host that can", () => {
  it("opens the stream and does not poll for traces", async () => {
    const { fn, seen } = fetchWith(true);
    vi.stubGlobal("fetch", fn);
    render(<App />);
    await waitFor(() => expect(streamsOpened).toBe(1));
    expect(seen.some((u) => u.includes("/api/traces"))).toBe(false);
  });

  it("falls back to the stream when /api/flow itself cannot be read", async () => {
    // If we cannot even ask, the stream is the default, and it will honestly report down.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    render(<App />);
    await waitFor(() => expect(streamsOpened).toBe(1));
  });
});
