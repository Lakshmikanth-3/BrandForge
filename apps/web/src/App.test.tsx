// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import type { Receipt } from "./types";

/**
 * Builder smoke tests.
 *
 * These do not judge whether the kit looks good — a human still has to. They check
 * the parts that would silently break: that the client-side preview generates from
 * the brief, that toggling a vibe re-styles it, and that the paid route really
 * answers 402 with a parseable challenge (the whole x402 claim).
 */

const STATS = {
  settleCount: 3,
  totalBase: 90_000,
  totalUsdc: 0.09,
  distinctPayers: 2,
  outboundCount: 0,
  outboundUsdc: 0,
  refundUsdc: 0,
  netOutboundUsdc: 0,
  firstSettledAt: null,
  lastSettledAt: null,
  network: "testnet",
  merchantAddress: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
};

/** A base64 payment-required header, exactly as the x402 middleware emits it. */
function challengeHeader(): string {
  const body = {
    accepts: [
      {
        network: "algorand:testnet",
        amount: "30000",
        asset: "10458941",
        payTo: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
      },
    ],
  };
  return btoa(JSON.stringify(body));
}

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/stats")) return Response.json(STATS);
    if (url.includes("/api/receipts")) return Response.json({ receipts: [] });
    if (url.includes("/api/traces")) return Response.json({ traces: [] });
    if (url.includes("/v1/brand-kit")) {
      return new Response(null, {
        status: 402,
        headers: { "payment-required": challengeHeader() },
      });
    }
    return new Response("{}", { status: 404 });
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", stubFetch());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the brand kit builder", () => {
  it("stays blank until Generate is clicked, then builds the kit", () => {
    render(<App />);
    expect(screen.getByText("BrandForge")).toBeTruthy();
    expect((screen.getByLabelText("Brand name") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Your brand kit appears here/i)).toBeTruthy();
    // Typing alone does NOT build the kit — nothing renders until Generate.
    fireEvent.change(screen.getByLabelText("Brand name"), { target: { value: "Northwind" } });
    expect(screen.queryAllByText(/Northwind/).length).toBe(0);
    expect(screen.getByText(/Your brand kit appears here/i)).toBeTruthy();
    // Clicking Generate processes the input and shows the result.
    fireEvent.click(screen.getByText("Generate kit"));
    expect(screen.getAllByText(/Northwind/).length).toBeGreaterThan(0);
  });

  it("renders the kit viewer with its free sections and gated ones", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Brand name"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByText("Generate kit"));
    // Free sections are fully rendered (nav + section headings, hence >1 each).
    expect(screen.getAllByText("Brand Strategy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Colors").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Typography").length).toBeGreaterThan(0);
    // Locked sections advertise the unlock price rather than showing content.
    expect(screen.getAllByText(/unlocks with the paid kit/i).length).toBeGreaterThan(0);
  });

  it("re-styles only when the brief is re-generated", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Brand name"), { target: { value: "Northwind" } });
    fireEvent.click(screen.getByText("modern"));
    fireEvent.click(screen.getByText("bold"));
    fireEvent.click(screen.getByText("Generate kit"));
    // modern + bold selects a sans heading.
    expect(screen.getAllByText(/Space Grotesk/).length).toBeGreaterThan(0);
    // Toggling a vibe does not change the kit until re-generated.
    fireEvent.click(screen.getByText("luxury"));
    expect(screen.queryAllByText(/DM Serif Display/).length).toBe(0);
    fireEvent.click(screen.getByText("Update kit"));
    expect(screen.getAllByText(/DM Serif Display/).length).toBeGreaterThan(0);
  });

  it("reflects the brand name after generating", () => {
    render(<App />);
    const input = screen.getByLabelText("Brand name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Volt" } });
    fireEvent.click(screen.getByText("Generate kit"));
    expect(screen.getAllByText("Volt").length).toBeGreaterThan(0);
  });

  it("proves the paid route answers 402 with a real challenge", async () => {
    render(<App />);
    fireEvent.click(screen.getByText("Show the 402 challenge"));
    expect(await screen.findByText(/HTTP 402 Payment Required/)).toBeTruthy();
    // The parsed challenge shows the real price and asset from the header.
    expect(await screen.findByText(/30000 base units/)).toBeTruthy();
    expect(screen.getByText(/ASA 10458941/)).toBeTruthy();
  });

  it("renders live settlement stats from the API", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("3")).toBeTruthy()); // settleCount
    expect(screen.getByText("0.09")).toBeTruthy(); // USDC received (2 dp)
    expect(screen.getByText("Algorand TestNet")).toBeTruthy();
  });

  it("lists only inbound brand-kit payments, hiding outbound and other routes", async () => {
    const receipts = [
      // Outbound bridge spend — must be hidden.
      mkReceipt({ txId: "OUT1", direction: "out", route: "downstream" }),
      // Inbound settlement on a different paid route (weather, $0.005) — must be hidden.
      mkReceipt({ txId: "OTHER", direction: "in", route: "/v1/weather", amountBase: 5_000, amountUsdc: 0.005 }),
      // A real brand-kit purchase — must be shown.
      mkReceipt({ txId: "KIT1", direction: "in", route: "/v1/brand-kit" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes("/api/stats")) return Response.json(STATS);
        if (u.includes("/api/receipts")) return Response.json({ receipts });
        if (u.includes("/api/traces")) return Response.json({ traces: [] });
        return new Response("{}", { status: 404 });
      }),
    );
    render(<App />);
    expect(await screen.findByText("Recent brand kit payments")).toBeTruthy();
    expect(screen.getByText(/KIT1/)).toBeTruthy();
    expect(screen.queryByText(/OUT1/)).toBeNull();
    expect(screen.queryByText(/OTHER/)).toBeNull();
  });
});

/** A minimal valid Receipt row for the receipts list. */
function mkReceipt(over: Partial<Receipt> & { txId: string }): Receipt {
  return {
    direction: "in",
    route: "/v1/brand-kit",
    payer: "PAYER1234567890",
    payee: "MERCHANT",
    amountBase: 30_000,
    amountUsdc: 0.03,
    assetId: "10458941",
    network: "testnet",
    confirmedRound: 1,
    settledAt: "2026-09-30T00:00:00.000Z",
    traceId: null,
    latencyMs: null,
    explorerUrl: "https://lora.algokit.io/testnet/transaction/" + over.txId,
    ...over,
  };
}
