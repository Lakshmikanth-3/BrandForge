// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * The blank-page regression.
 *
 * The first version of the render tests faked EventSource as a no-op, so the live stream
 * never delivered anything and every test passed. In a real browser the stream's first
 * message is a snapshot carrying the RAW store stats -- base units, no totalUsdc -- and the
 * client merged it into the state the header reads. When that message beat the stats
 * request, the header called totalUsdc.toFixed on undefined, React had no error boundary,
 * and the entire page rendered blank. This reproduces that ordering with the real shape.
 */

/** The stream's snapshot payload as the server actually sends it. */
const RAW_SNAPSHOT = {
  traces: [],
  stats: {
    settleCount: 3,
    totalBase: 150000,
    distinctPayers: 2,
    outboundCount: 36,
    outboundBase: 440000,
    refundBase: 275000,
    netOutboundBase: 165000,
    firstSettledAt: null,
    lastSettledAt: null,
    // no totalUsdc, no outboundUsdc: that is the whole bug
  },
};

/** An EventSource that behaves like the real one: it delivers a snapshot on connect. */
class StreamingEventSource {
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(public url: string) {
    queueMicrotask(() => {
      this.emit("open", "");
      this.emit("snapshot", JSON.stringify(RAW_SNAPSHOT));
    });
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  close(): void {}
  private emit(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent<string>);
  }
}

const DERIVED_STATS = {
  settleCount: 3,
  totalBase: 150000,
  totalUsdc: 0.15,
  distinctPayers: 2,
  outboundCount: 36,
  outboundBase: 440000,
  outboundUsdc: 0.44,
  refundBase: 275000,
  refundUsdc: 0.275,
  netOutboundBase: 165000,
  netOutboundUsdc: 0.165,
  firstSettledAt: null,
  lastSettledAt: null,
  network: "testnet",
  merchantAddress: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
};

const ROUTES: Record<string, unknown> = {
  "/api/flow": {
    steps: [],
    flows: { inbound: [], bridged: [] },
    routes: { orchestrate: "/v1/orchestrate", trust: "/v1/trust" },
    prices: { orchestrate: "$0.05", trust: "$0.02" },
    network: "testnet",
    explorerTxBase: "https://lora.algokit.io/testnet/transaction/",
  },
  "/api/receipts": { receipts: [], explorerTxBase: "" },
  "/api/budget": {
    halted: false, day: "2026-09-19", spentTodayUsdc: 0, remainingTodayUsdc: 2,
    caps: { perCallUsdc: 0.25, perDayUsdc: 2, perMerchantPerDayUsdc: 0.5 },
    payerReady: false, payerAddress: null, recent: [],
  },
  "/api/services": { services: [] },
  "/api/substitutions": { substitutions: [], policy: { refuseBelow: 0.6, warnBelow: 0.8 } },
  "/api/verification": {
    network: "testnet", checkedAt: "2026-09-19T00:00:00.000Z", rows: [],
    passing: 0, failing: 0, merchantRecord: null, bazaarEntries: [],
  },
  "/api/reconcile": {
    network: "testnet", checkedAt: "2026-09-19T00:00:00.000Z", chainTransfers: 0,
    receipts: 0, matched: 0, clean: true, error: null, discrepancies: [],
  },
};

/** Serves the routes, but holds /api/stats back so the stream's snapshot lands first. */
function slowStatsFetch(statsDelayMs: number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/stats")) {
      await new Promise((r) => setTimeout(r, statsDelayMs));
      return Response.json(DERIVED_STATS);
    }
    const key = Object.keys(ROUTES).find((k) => url.includes(k));
    return key ? Response.json(ROUTES[key]) : new Response("{}", { status: 404 });
  });
}

beforeEach(() => {
  vi.stubGlobal("EventSource", StreamingEventSource as unknown as typeof EventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the live stream's first message", () => {
  it("does not blank the page when it arrives before the stats request", async () => {
    vi.stubGlobal("fetch", slowStatsFetch(150));
    render(<App />);

    // Give the snapshot time to land while stats are still outstanding.
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText("Sentry402")).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("then fills the header from the derived stats, not from the raw stream figures", async () => {
    vi.stubGlobal("fetch", slowStatsFetch(80));
    render(<App />);

    // 0.150000 comes from /api/stats. The raw snapshot only has totalBase, and formatting
    // that as USDC here would be the wrong unit.
    await waitFor(() => expect(screen.getByText("0.150000")).toBeTruthy());
    expect(screen.getByText("0.165000")).toBeTruthy(); // net spent
  });

  it("keeps every panel on the page once data has arrived", async () => {
    vi.stubGlobal("fetch", slowStatsFetch(20));
    render(<App />);
    for (const heading of ["Live protocol flow", "Budget guard", "Verification", "Reconciliation"]) {
      expect(await screen.findByText(heading), heading).toBeTruthy();
    }
  });

  it("survives a stats response that is missing fields entirely", async () => {
    // A missing number is not zero, and formatting it must not throw.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/stats")) return Response.json({ settleCount: 1 });
        const key = Object.keys(ROUTES).find((k) => url.includes(k));
        return key ? Response.json(ROUTES[key]) : new Response("{}", { status: 404 });
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByText("Sentry402")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText("Sentry402")).toBeTruthy();
  });
});

describe("ErrorBoundary", () => {
  function Bomb(): never {
    throw new Error("boom from a child");
  }

  it("shows what failed instead of an empty page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("The dashboard failed to render")).toBeTruthy();
    expect(screen.getByText("boom from a child")).toBeTruthy();
    expect(screen.getByText("reload")).toBeTruthy();
  });

  it("renders its children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all fine")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
