import { describe, expect, it } from "vitest";
import { loadConfig, CHALLENGE_TAG, MAINNET, TESTNET } from "@sentry402/shared";
import { Verifier, bustCache } from "./verification.js";

const MERCHANT = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";

function configFor(over: Record<string, string> = {}) {
  return loadConfig({
    NETWORK: "testnet",
    PUBLIC_BASE_URL: "https://sentry402.test",
    FACILITATOR_URL: "https://facilitator.goplausible.xyz",
    MERCHANT_ADDRESS: MERCHANT,
    PAYER_ADDRESS: "G3YVTPURK6VFSM5CXEH7QFTZXLCXBJL6UMAIUUYJO4P2XF3MHQ4FUHYYB4",
    PAYER_MNEMONIC: Array.from({ length: 25 }, (_, i) => `word${i}`).join(" "),
    ...over,
  });
}

interface FakeWorld {
  supportedNetworks?: string[];
  merchantRecord?: { totalSettlements?: number; resourceCount?: number } | null;
  bazaarPayTo?: string | null;
  bazaarTag?: string | null;
  ownStatus?: number;
  ownHasChallenge?: boolean;
  failEverything?: boolean;
}

/** A facilitator and endpoint that behave however a test needs. */
function world(w: FakeWorld): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (w.failEverything) throw new Error("ENOTFOUND");

    if (url.includes("/supported")) {
      return Response.json({
        kinds: (w.supportedNetworks ?? [TESTNET.caip2]).map((network) => ({ network })),
      });
    }
    if (url.includes("/discovery/merchants")) {
      return Response.json({
        items:
          w.merchantRecord === null || w.merchantRecord === undefined
            ? []
            : [{ addresses: { avm: MERCHANT }, ...w.merchantRecord }],
      });
    }
    if (url.includes("/discovery/resources")) {
      const payTo = w.bazaarPayTo === undefined ? MERCHANT : w.bazaarPayTo;
      return Response.json({
        items:
          payTo === null
            ? []
            : [
                {
                  resourceUrl: "https://sentry402.test/v1/orchestrate",
                  accepts: [
                    {
                      network: TESTNET.caip2,
                      payTo,
                      extra: w.bazaarTag === null ? {} : { tag: w.bazaarTag ?? CHALLENGE_TAG },
                    },
                  ],
                },
              ],
      });
    }
    // Our own endpoint.
    void init;
    return new Response(null, {
      status: w.ownStatus ?? 402,
      headers:
        (w.ownHasChallenge ?? true) ? { "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0=" } : {},
    });
  }) as unknown as typeof fetch;
}

const rowsOf = async (w: FakeWorld, over: Record<string, string> = {}) =>
  (await new Verifier(configFor(over), world(w)).report()).rows;

const row = async (id: string, w: FakeWorld, over: Record<string, string> = {}) => {
  const found = (await rowsOf(w, over)).find((r) => r.id === id);
  expect(found, `row ${id} must exist`).toBeDefined();
  return found!;
};

describe("a failing row reports as failing", () => {
  it("reports testnet as a failure of the mainnet claim", async () => {
    // It would be trivial to soften this. A panel that can show red is the only
    // evidence the green rows mean anything.
    expect((await row("mainnet", {})).status).toBe("fail");
  });

  it("reports mainnet as passing once the switch is flipped", async () => {
    const mainnetRow = await row("mainnet", { supportedNetworks: [MAINNET.caip2] }, {
      NETWORK: "mainnet",
    });
    expect(mainnetRow.status).toBe("pass");
  });

  it("fails every external row when the facilitator is unreachable", async () => {
    const rows = await rowsOf({ failEverything: true });
    for (const id of ["facilitator", "bazaar", "challenge_tag", "merchant_record"]) {
      const found = rows.find((r) => r.id === id)!;
      expect(found.status, id).toBe("fail");
      expect(found.detail).toMatch(/unreachable|ENOTFOUND/);
    }
  });

  it("counts failures rather than hiding them", async () => {
    const report = await new Verifier(configFor(), world({ failEverything: true })).report();
    expect(report.failing).toBeGreaterThan(0);
    expect(report.rows.length).toBe(report.rows.length);
  });
});

describe("the facilitator's view is the authority on our own flags", () => {
  it("fails the tag row when the catalog shows no tagged route, even though we send one", async () => {
    // Reading the tag off our own config would be circular: it would confirm we
    // intended it, not that the facilitator recorded it.
    expect((await row("challenge_tag", { bazaarTag: null })).status).toBe("fail");
  });

  it("passes the tag row when the catalog shows it", async () => {
    expect((await row("challenge_tag", { bazaarTag: CHALLENGE_TAG })).status).toBe("pass");
  });

  it("fails the bazaar row when the catalog lists nothing for our payTo", async () => {
    const found = await row("bazaar", { bazaarPayTo: null });
    expect(found.status).toBe("fail");
    expect(found.detail).toMatch(/first settled payment/);
  });

  it("does not count another merchant's listing as ours", async () => {
    expect((await row("bazaar", { bazaarPayTo: "SOMEONEELSESADDRESS" })).status).toBe("fail");
  });

  it("fails the settlement row until the facilitator records one", async () => {
    expect((await row("settlement", { merchantRecord: { totalSettlements: 0 } })).status).toBe(
      "fail",
    );
    expect((await row("settlement", { merchantRecord: { totalSettlements: 1 } })).status).toBe(
      "pass",
    );
  });

  it("fails the merchant record row when no record exists", async () => {
    expect((await row("merchant_record", { merchantRecord: null })).status).toBe("fail");
  });
});

describe("unverifiable claims say manual, never pass", () => {
  it.each(["doctor", "leaderboard", "electric_capital"])(
    "marks %s as manual because no machine-readable source exists",
    async (id) => {
      const found = await row(id, {});
      expect(found.status).toBe("manual");
      // A hardcoded tick on a claim nobody checked makes every other row suspect.
      expect(found.status).not.toBe("pass");
      expect(found.link).toBeTruthy();
    },
  );

  it("still links out so a judge can check it by hand", async () => {
    for (const id of ["doctor", "leaderboard", "electric_capital"]) {
      expect((await row(id, {})).link).toMatch(/^https:\/\//);
    }
  });
});

describe("our own endpoint probe", () => {
  it("passes on a 402 with a challenge", async () => {
    const found = await row("live_endpoint", { ownStatus: 402, ownHasChallenge: true });
    expect(found.status).toBe("pass");
  });

  it("fails on a 402 with no challenge header", async () => {
    const found = await row("live_endpoint", { ownStatus: 402, ownHasChallenge: false });
    expect(found.status).toBe("fail");
    expect(found.detail).toMatch(/without a payment-required header/);
  });

  it("fails on any status that is not 402", async () => {
    expect((await row("live_endpoint", { ownStatus: 200 })).status).toBe("fail");
    expect((await row("live_endpoint", { ownStatus: 500 })).status).toBe("fail");
  });

  it("reports pending rather than passing on localhost", async () => {
    // The claim is public reachability, which localhost cannot demonstrate.
    const found = await row("live_endpoint", {}, { PUBLIC_BASE_URL: "http://localhost:4021" });
    expect(found.status).toBe("pending");
    expect(found.detail).toMatch(/not reachable by the facilitator/);
  });

  it("fails when the public url is not HTTPS", async () => {
    const found = await row("live_endpoint", {}, { PUBLIC_BASE_URL: "http://example.test" });
    expect(found.status).toBe("fail");
    expect(found.detail).toMatch(/not HTTPS/);
  });
});

describe("raw data for a judge who wants it", () => {
  it("returns the facilitator's merchant record verbatim", async () => {
    const report = await new Verifier(
      configFor(),
      world({ merchantRecord: { totalSettlements: 7, resourceCount: 2 } }),
    ).report();
    expect(report.merchantRecord).toMatchObject({
      addresses: { avm: MERCHANT },
      totalSettlements: 7,
    });
  });

  it("returns only bazaar entries for our own payTo", async () => {
    const mine = await new Verifier(configFor(), world({})).report();
    expect(mine.bazaarEntries).toHaveLength(1);

    const theirs = await new Verifier(
      configFor(),
      world({ bazaarPayTo: "SOMEONEELSESADDRESS" }),
    ).report();
    expect(theirs.bazaarEntries).toHaveLength(0);
  });

  it("marks which rows were read from a third party", async () => {
    const rows = await rowsOf({});
    expect(rows.find((r) => r.id === "facilitator")!.external).toBe(true);
    // Our own network setting is not third-party evidence and does not claim to be.
    expect(rows.find((r) => r.id === "mainnet")!.external).toBe(false);
  });
});

describe("caching", () => {
  it("does not re-probe the facilitator on every request", async () => {
    let calls = 0;
    const counting = (async (input: string | URL | Request) => {
      calls += 1;
      return world({})(input);
    }) as unknown as typeof fetch;

    const verifier = new Verifier(configFor(), counting);
    await verifier.report();
    const afterFirst = calls;
    await verifier.report();
    expect(calls).toBe(afterFirst);
  });
});

describe("the facilitator's edge cache", () => {
  // The discovery endpoints are served with s-maxage=86400, so a shared cache can hold a
  // response for up to a day, keyed by URL and per region. The proof panel was showing RED for
  // true facts because the server that renders it was served a copy cached BEFORE the first
  // settlement. Each discovery read must therefore be a distinct cache key.
  it("adds a unique query parameter to every discovery read", async () => {
    const seen: string[] = [];
    const recording = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return world({})(input);
    }) as unknown as typeof fetch;

    await new Verifier(configFor(), recording, () => 1_700_000_000_000).report();

    const discovery = seen.filter((u) => u.includes("/discovery/"));
    expect(discovery.length).toBe(2);
    for (const url of discovery) expect(url).toMatch(/[?&]_=1700000000000$/);
  });

  it("uses a different key on a later read, so a stale copy cannot be reused", async () => {
    const urls: string[][] = [[], []];
    let batch = 0;
    const recording = (async (input: string | URL | Request) => {
      if (String(input).includes("/discovery/")) urls[batch]!.push(String(input));
      return world({})(input);
    }) as unknown as typeof fetch;

    let t = 1_000;
    const first = new Verifier(configFor(), recording, () => t);
    await first.report();
    batch = 1;
    t = 2_000;
    await new Verifier(configFor(), recording, () => t).report();

    expect(urls[0]).not.toEqual(urls[1]);
    expect(urls[0]!.every((u) => u.endsWith("_=1000"))).toBe(true);
    expect(urls[1]!.every((u) => u.endsWith("_=2000"))).toBe(true);
  });

  it("keeps the existing query parameters and appends with an ampersand", () => {
    expect(bustCache("https://f.test/discovery/x?limit=200", 5)).toBe(
      "https://f.test/discovery/x?limit=200&_=5",
    );
  });

  it("starts a query string when there is none", () => {
    expect(bustCache("https://f.test/discovery/x", 5)).toBe("https://f.test/discovery/x?_=5");
  });
});
