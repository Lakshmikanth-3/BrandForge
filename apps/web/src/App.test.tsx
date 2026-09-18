// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

/**
 * Render smoke tests.
 *
 * These do not check that the page looks right — nothing automated can, and a human
 * still has to look at it. What they do check is the part that had never executed at
 * all: whether the components survive the states they will actually meet. An empty
 * store, a null budget, a failed fetch and an unrated score are the normal cases
 * before traffic exists, and every one of them was written without being run.
 */

interface Routes {
  [path: string]: unknown;
}

/** Serves each /api path from a fixture, so no network is touched. */
function stubFetch(routes: Routes, failing: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (failing.some((f) => url.includes(f))) {
      throw new Error("network down");
    }
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("{}", { status: 404 });
    return Response.json(routes[key]);
  });
}

/** EventSource does not exist in jsdom; the page must not require it to render. */
class FakeEventSource {
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const EMPTY_ROUTES: Routes = {
  "/api/flow": {
    steps: [
      { id: "request", label: "Request", hint: "" },
      { id: "challenge", label: "402 Challenge", hint: "" },
      { id: "payment", label: "X-PAYMENT", hint: "" },
      { id: "settle", label: "Verify & settle", hint: "" },
      { id: "deliver", label: "Deliver", hint: "" },
      { id: "receipt", label: "Receipt", hint: "" },
    ],
    flows: { inbound: [], bridged: [] },
    routes: { orchestrate: "/v1/orchestrate", trust: "/v1/trust" },
    prices: { orchestrate: "$0.05", trust: "$0.02" },
    network: "testnet",
    explorerTxBase: "https://lora.algokit.io/testnet/transaction/",
  },
  "/api/stats": {
    settleCount: 0,
    totalBase: 0,
    totalUsdc: 0,
    distinctPayers: 0,
    outboundCount: 0,
    outboundUsdc: 0,
    firstSettledAt: null,
    lastSettledAt: null,
    network: "testnet",
    merchantAddress: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  },
  "/api/receipts": { receipts: [], explorerTxBase: "" },
  "/api/budget": {
    halted: false,
    day: "2026-09-18",
    spentTodayUsdc: 0,
    remainingTodayUsdc: 2,
    caps: { perCallUsdc: 0.25, perDayUsdc: 2, perMerchantPerDayUsdc: 0.5 },
    payerReady: true,
    payerAddress: "OTVJB2ZSQW4CJTQDU6UMRFWRW2D4GIKRQPBUARS5AXW4KVRRWYZYCTGXYA",
    recent: [],
  },
  "/api/services": { services: [] },
  "/api/substitutions": { substitutions: [], policy: { refuseBelow: 0.6, warnBelow: 0.8 } },
  "/api/verification": {
    network: "testnet",
    checkedAt: "2026-09-18T00:00:00.000Z",
    rows: [
      {
        id: "mainnet",
        claim: "Running on Algorand MainNet",
        status: "fail",
        detail: "currently testnet",
        link: null,
        external: false,
      },
      {
        id: "doctor",
        claim: "Endpoint passes the GoPlausible Doctor",
        status: "manual",
        detail: "no machine-readable result",
        link: "https://facilitator.goplausible.xyz/guide",
        external: true,
      },
    ],
    passing: 0,
    failing: 1,
    merchantRecord: null,
    bazaarEntries: [],
  },
  "/api/reconcile": {
    network: "testnet",
    checkedAt: "2026-09-18T00:00:00.000Z",
    chainTransfers: 0,
    receipts: 0,
    matched: 0,
    clean: true,
    error: null,
    discrepancies: [],
  },
};

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the page renders before any traffic exists", () => {
  it("mounts without throwing on a completely empty backend", async () => {
    // The state the app is actually in today, and had never been executed.
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES));
    render(<App />);
    expect(await screen.findByText("Sentry402")).toBeTruthy();
  });

  it("renders every panel heading", async () => {
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES));
    render(<App />);

    for (const heading of [
      "Live protocol flow",
      "Install",
      "Services the bridge can pay",
      "Trust lookup",
      "Route-around log",
      "Budget guard",
      "Receipts",
      "Verification",
      "Reconciliation",
    ]) {
      expect(await screen.findByText(heading), heading).toBeTruthy();
    }
  });

  it("says the flow is idle rather than animating nothing", async () => {
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES));
    render(<App />);
    expect(await screen.findByText(/IDLE — no request yet/)).toBeTruthy();
  });

  it("shows empty tables as explanatory text, not blank panels", async () => {
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES));
    render(<App />);
    expect(await screen.findByText(/No settlements yet/)).toBeTruthy();
    expect(await screen.findByText(/No services in the registry yet/)).toBeTruthy();
    expect(await screen.findByText(/Nothing routed around yet/)).toBeTruthy();
  });

  it("renders a failing verification row as failing", async () => {
    // The panel must be able to show red; that is the whole point of it.
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES));
    render(<App />);
    await waitFor(() => expect(screen.getByText("fail")).toBeTruthy());
    // "manual" appears as a status chip and inside the explanatory copy above it.
    expect(screen.getAllByText("manual").length).toBeGreaterThan(0);
  });

  it("reports a clean reconciliation over an empty window", async () => {
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES));
    render(<App />);
    expect(await screen.findByText(/No phantom rows in either direction/)).toBeTruthy();
  });
});

describe("the page survives a backend that is not answering", () => {
  it("does not crash when every api call fails", async () => {
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES, ["/api/"]));
    render(<App />);
    // The header is static, so it must still be there to carry the failure states.
    expect(await screen.findByText("Sentry402")).toBeTruthy();
  });

  it("reports missing panels instead of rendering empty ones", async () => {
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES, ["/api/budget", "/api/verification"]));
    render(<App />);
    expect((await screen.findAllByText(/did not respond/)).length).toBeGreaterThan(0);
  });

  it("shows placeholder dashes for counters rather than fabricating zeros", async () => {
    // A missing number and a real zero are different claims.
    vi.stubGlobal("fetch", stubFetch(EMPTY_ROUTES, ["/api/stats"]));
    render(<App />);
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0));
  });
});

describe("real data renders", () => {
  it("shows an unrated service as unrated, never as a score", async () => {
    const routes: Routes = {
      ...EMPTY_ROUTES,
      "/api/services": {
        services: [
          {
            label: "folks_tvl",
            summary: "Total value locked in Folks Finance.",
            url: "https://example.test/x",
            method: "GET",
            priceUsdc: 0.005,
            catalogPriceUsdc: 0.005,
            probeVerdict: "ok",
            probeLatencyMs: 421,
            priceDrift: 1,
            active: true,
            probedAt: "2026-09-18T00:00:00.000Z",
            trust: {
              resourceUrl: "https://example.test/x",
              score: null,
              verdict: "unrated",
              observations: 0,
              successRate: null,
              paidNothingCount: 0,
              medianLatencyMs: null,
              schemaConformance: null,
              coldStartCount: 0,
              lastSeenAt: null,
              basis: "unrated: 0 observations, 5 needed",
            },
          },
        ],
      },
    };

    vi.stubGlobal("fetch", stubFetch(routes));
    render(<App />);

    expect(await screen.findByText("folks_tvl")).toBeTruthy();
    // Appears in the badge and again in the basis string it carries as a tooltip.
    expect((await screen.findAllByText(/unrated/)).length).toBeGreaterThan(0);
    // 0.00 would read as a terrible score rather than as no data.
    expect(screen.queryByText("0.00")).toBeNull();
  });

  it("marks a price that drifted from the catalog", async () => {
    const routes: Routes = {
      ...EMPTY_ROUTES,
      "/api/services": {
        services: [
          {
            label: "drifty",
            summary: "A service that repriced.",
            url: "https://example.test/y",
            method: "GET",
            priceUsdc: 0.05,
            catalogPriceUsdc: 0.01,
            probeVerdict: "ok",
            probeLatencyMs: 300,
            priceDrift: 5,
            active: true,
            probedAt: "2026-09-18T00:00:00.000Z",
            trust: EMPTY_ROUTES["/api/services"] as never,
          },
        ],
      },
    };
    // The trust field must be a record; reuse a valid one.
    (routes["/api/services"] as { services: { trust: unknown }[] }).services[0]!.trust = {
      resourceUrl: "https://example.test/y",
      score: 0.91,
      verdict: "pass",
      observations: 42,
      successRate: 0.95,
      paidNothingCount: 1,
      medianLatencyMs: 300,
      schemaConformance: null,
      coldStartCount: 3,
      lastSeenAt: "2026-09-18T00:00:00.000Z",
      basis: "42 observations, recency-weighted over the last 50",
    };

    vi.stubGlobal("fetch", stubFetch(routes));
    render(<App />);

    expect(await screen.findByText(/x5\.00/)).toBeTruthy();
    expect(await screen.findByText("0.91")).toBeTruthy();
  });
});
