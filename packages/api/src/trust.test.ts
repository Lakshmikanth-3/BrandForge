import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import {
  DEFAULT_POLICY,
  MIN_OBSERVATIONS,
  TrustEngine,
  computeRecord,
  verdictFor,
  type Outcome,
} from "./trust.js";

const URL_A = "https://a.test/x";
const URL_B = "https://b.test/y";

/** Outcomes are newest-first, so index 0 is the most recent call. */
function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    resourceUrl: URL_A,
    at: "2026-09-18T00:00:00.000Z",
    ok: true,
    httpStatus: 200,
    latencyMs: 400,
    settled: true,
    schemaOk: null,
    coldStart: false,
    failureReason: null,
    ...over,
  };
}

const many = (n: number, over: Partial<Outcome> = {}) =>
  Array.from({ length: n }, (_, i) =>
    outcome({ at: `2026-09-18T00:00:${String(59 - i).padStart(2, "0")}.000Z`, ...over }),
  );

describe("cold start is not unreliability", () => {
  it("counts a retried success as a success", () => {
    // Four live services timed out at 20s then answered in ~1.5s warm.
    const record = computeRecord(URL_A, many(10, { coldStart: true, latencyMs: 20_000 }));
    expect(record.successRate).toBe(1);
    expect(record.verdict).toBe("pass");
    expect(record.coldStartCount).toBe(10);
  });

  it("excludes cold-start latency from the latency signal entirely", () => {
    // That number measured a host waking up, not the service working.
    const warm = many(6, { coldStart: false, latencyMs: 300 });
    const cold = many(4, { coldStart: true, latencyMs: 40_000 });
    const record = computeRecord(URL_A, [...cold, ...warm]);
    expect(record.medianLatencyMs).toBe(300);
  });

  it("reports no median latency when every call was a cold start", () => {
    const record = computeRecord(URL_A, many(8, { coldStart: true, latencyMs: 30_000 }));
    expect(record.medianLatencyMs).toBeNull();
    // A missing latency must not be scored as slow.
    expect(record.score).toBeGreaterThan(0.9);
  });

  it("does not let a free-tier host score worse than a genuinely broken one", () => {
    const coldButWorking = computeRecord(URL_A, many(10, { coldStart: true, latencyMs: 25_000 }));
    const broken = computeRecord(URL_B, many(10, { ok: false, settled: true, latencyMs: 200 }));
    expect(coldButWorking.score as number).toBeGreaterThan(broken.score as number);
  });
});

describe("cold start", () => {
  it("still penalises a service that fails even after the retry", () => {
    const record = computeRecord(
      URL_A,
      many(10, { ok: false, coldStart: true, settled: false, failureReason: "unreachable" }),
    );
    expect(record.successRate).toBe(0);
    expect(record.verdict).toBe("refuse");
  });
});

describe("paying for nothing is the worst outcome", () => {
  it("scores lower than a failure where no money moved", () => {
    const paidNothing = computeRecord(URL_A, many(10, { ok: false, settled: true }));
    const failedFree = computeRecord(URL_B, many(10, { ok: false, settled: false }));
    expect(paidNothing.score as number).toBeLessThan(failedFree.score as number);
  });

  it("counts them explicitly, because it is the only failure that costs money", () => {
    const record = computeRecord(URL_A, [
      ...many(3, { ok: false, settled: true }),
      ...many(7),
    ]);
    expect(record.paidNothingCount).toBe(3);
  });
});

describe("cold start and unrated", () => {
  it("returns unrated below the observation floor, never a number", () => {
    for (let n = 0; n < MIN_OBSERVATIONS; n += 1) {
      const record = computeRecord(URL_A, many(n));
      expect(record.score).toBeNull();
      expect(record.verdict).toBe("unrated");
      expect(record.successRate).toBeNull();
    }
  });

  it("states the basis so 4 calls cannot look like 400", () => {
    expect(computeRecord(URL_A, many(2)).basis).toMatch(/2 observations, 5 needed/);
    expect(computeRecord(URL_A, many(40)).basis).toMatch(/40 observations/);
  });

  it("starts scoring at exactly the floor", () => {
    const record = computeRecord(URL_A, many(MIN_OBSERVATIONS));
    expect(record.score).not.toBeNull();
    expect(record.verdict).not.toBe("unrated");
  });

  it("reports paidNothing and coldStart counts even while unrated", () => {
    // Refusing to score is not refusing to report what was seen.
    const record = computeRecord(URL_A, [
      outcome({ ok: false, settled: true }),
      outcome({ coldStart: true }),
    ]);
    expect(record.verdict).toBe("unrated");
    expect(record.paidNothingCount).toBe(1);
    expect(record.coldStartCount).toBe(1);
  });
});

describe("determinism", () => {
  it("produces the same score for the same fixture", () => {
    const fixture = [
      ...many(4, { ok: false, settled: true }),
      ...many(16, { latencyMs: 550 }),
    ];
    const first = computeRecord(URL_A, fixture);
    const second = computeRecord(URL_A, fixture);
    expect(first).toEqual(second);
    // A score that drifts between runs cannot be sold or trusted.
    expect(first.score).toBe(second.score);
  });

  it("is bounded to [0,1]", () => {
    expect(computeRecord(URL_A, many(20)).score).toBeLessThanOrEqual(1);
    expect(
      computeRecord(URL_A, many(20, { ok: false, settled: true, schemaOk: false })).score,
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("recency weighting", () => {
  it("lets a service that was bad and is now good recover", () => {
    // Newest first: 20 recent successes, then 20 old failures.
    const recovered = computeRecord(URL_A, [
      ...many(20),
      ...many(20, { ok: false, settled: true }),
    ]);
    const stillBad = computeRecord(URL_B, [
      ...many(20, { ok: false, settled: true }),
      ...many(20),
    ]);
    expect(recovered.score as number).toBeGreaterThan(stillBad.score as number);
  });

  it("weights a recent failure more heavily than an old one", () => {
    const recentFailure = computeRecord(URL_A, [
      outcome({ ok: false, settled: true }),
      ...many(19),
    ]);
    const oldFailure = computeRecord(URL_A, [
      ...many(19),
      outcome({ ok: false, settled: true }),
    ]);
    expect(recentFailure.score as number).toBeLessThan(oldFailure.score as number);
  });
});

describe("slow but correct beats fast and wrong", () => {
  it("prefers a slow service that delivers", () => {
    const slowGood = computeRecord(URL_A, many(20, { latencyMs: 9_000 }));
    const fastBad = computeRecord(URL_B, many(20, { ok: false, settled: true, latencyMs: 50 }));
    expect(slowGood.score as number).toBeGreaterThan(fastBad.score as number);
  });
});

describe("verdictFor", () => {
  it.each([
    [null, "unrated"],
    [0, "refuse"],
    [0.59, "refuse"],
    [0.6, "warn"],
    [0.79, "warn"],
    [0.8, "pass"],
    [1, "pass"],
  ])("maps %s to %s", (score, expected) => {
    expect(verdictFor(score as number | null)).toBe(expected);
  });
});

describe("TrustEngine gate", () => {
  let store: Store;
  let engine: TrustEngine;

  // The fixtures are dated, so the clock is pinned just after them. Against a real
  // clock these records would be old enough for parole, which is correct behaviour
  // but not what these tests are about.
  const FIXTURE_NOW = Date.parse("2026-09-18T00:01:00.000Z");

  beforeEach(() => {
    store = new Store(":memory:");
    engine = new TrustEngine(store, DEFAULT_POLICY, () => FIXTURE_NOW);
  });

  const feed = (url: string, outcomes: Outcome[]) => {
    for (const o of outcomes) engine.record({ ...o, resourceUrl: url });
  };

  it("blocks a payment below the threshold", () => {
    feed(URL_A, many(20, { ok: false, settled: true }));
    const gate = engine.gate(URL_A);
    expect(gate.allow).toBe(false);
    expect(gate.reason).toMatch(/below the 0.6 threshold/);
  });

  it("allows an unrated service, because refusing everything new is a dead end", () => {
    // The bridge could never build a record if it refused all newcomers.
    const gate = engine.gate("https://brand-new.test/x");
    expect(gate.allow).toBe(true);
    expect(gate.record.verdict).toBe("unrated");
  });

  it("allows but flags a warn-band service", () => {
    feed(URL_A, [...many(5, { ok: false, settled: true }), ...many(15)]);
    const gate = engine.gate(URL_A);
    expect(gate.record.verdict).toBe("warn");
    expect(gate.allow).toBe(true);
  });

  it("allows a healthy service", () => {
    feed(URL_A, many(20));
    const gate = engine.gate(URL_A);
    expect(gate.allow).toBe(true);
    expect(gate.record.verdict).toBe("pass");
  });

  it("honours a stricter policy", () => {
    // A service the default policy only warns about is refused by a stricter one.
    feed(URL_A, [...many(5, { ok: false, settled: true }), ...many(15)]);
    expect(engine.gate(URL_A).record.verdict).toBe("warn");
    expect(engine.gate(URL_A).allow).toBe(true);

    const strict = new TrustEngine(
      store,
      { refuseBelow: 0.8, warnBelow: 0.95 },
      () => FIXTURE_NOW,
    );
    expect(strict.gate(URL_A).allow).toBe(false);
  });

  it("persists outcomes so a restart does not lose the record", () => {
    feed(URL_A, many(10));
    const revived = new TrustEngine(store, DEFAULT_POLICY, () => FIXTURE_NOW);
    expect(revived.recordFor(URL_A).observations).toBe(10);
  });
});

describe("TrustEngine route-around", () => {
  let store: Store;
  let engine: TrustEngine;

  beforeEach(() => {
    store = new Store(":memory:");
    engine = new TrustEngine(store);
  });

  const feed = (url: string, outcomes: Outcome[]) => {
    for (const o of outcomes) engine.record({ ...o, resourceUrl: url });
  };

  it("picks a healthy alternative over a refused service", () => {
    feed(URL_A, many(20, { ok: false, settled: true }));
    feed(URL_B, many(20));
    const alt = engine.alternativeTo(URL_A, [URL_A, URL_B]);
    expect(alt?.url).toBe(URL_B);
    expect(alt?.record.verdict).toBe("pass");
  });

  it("never returns the refused service itself", () => {
    feed(URL_A, many(20, { ok: false, settled: true }));
    expect(engine.alternativeTo(URL_A, [URL_A])).toBeNull();
  });

  it("never substitutes an unrated service for a known-bad one", () => {
    // Swapping known-bad for unknown is not an improvement the agent asked for.
    feed(URL_A, many(20, { ok: false, settled: true }));
    expect(engine.alternativeTo(URL_A, [URL_A, "https://unknown.test/z"])).toBeNull();
  });

  it("never substitutes another refused service", () => {
    feed(URL_A, many(20, { ok: false, settled: true }));
    feed(URL_B, many(20, { ok: false, settled: true }));
    expect(engine.alternativeTo(URL_A, [URL_A, URL_B])).toBeNull();
  });

  it("prefers the highest scoring alternative", () => {
    feed(URL_A, many(20, { ok: false, settled: true }));
    feed(URL_B, [...many(4, { ok: false, settled: true }), ...many(16)]);
    const best = "https://c.test/best";
    feed(best, many(20));

    const alt = engine.alternativeTo(URL_A, [URL_A, URL_B, best]);
    expect(alt?.url).toBe(best);
  });

  it("records a substitution so the route-around is auditable", () => {
    store.putSubstitution({
      at: "2026-09-18T00:00:00.000Z",
      refusedUrl: URL_A,
      refusedScore: 0.2,
      chosenUrl: URL_B,
      chosenScore: 0.95,
      reason: "score below threshold",
    });
    const log = store.substitutions();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ refusedUrl: URL_A, chosenUrl: URL_B });
  });
});

describe("our own bad requests are not the service's failure", () => {
  it("excludes a client error from the window entirely", () => {
    // Sending a POST endpoint an empty body earned a 400 from a service that works.
    // Scoring that would make the record measure our bugs instead of their behaviour.
    const record = computeRecord(URL_A, [
      ...many(10, { ok: false, settled: false, clientError: true }),
      ...many(10),
    ]);
    expect(record.observations).toBe(10);
    expect(record.successRate).toBe(1);
    expect(record.verdict).toBe("pass");
  });

  it("counts them separately so they are still visible", () => {
    const record = computeRecord(URL_A, [
      ...many(3, { ok: false, clientError: true }),
      ...many(10),
    ]);
    expect(record.clientErrorCount).toBe(3);
  });

  it("can leave a service unrated when every call was our fault", () => {
    // Ten calls we got wrong tell us nothing about the endpoint.
    const record = computeRecord(URL_A, many(10, { ok: false, clientError: true }));
    expect(record.observations).toBe(0);
    expect(record.verdict).toBe("unrated");
    expect(record.score).toBeNull();
    expect(record.clientErrorCount).toBe(10);
  });

  it("does not let a client error mask a real failure", () => {
    const record = computeRecord(URL_A, [
      ...many(5, { ok: false, clientError: true }),
      ...many(10, { ok: false, settled: true }),
    ]);
    // The real failures still score, and still refuse.
    expect(record.observations).toBe(10);
    expect(record.verdict).toBe("refuse");
    expect(record.paidNothingCount).toBe(10);
  });

  it("treats an absent clientError flag as not-a-client-error", () => {
    // Older rows predate the column and must keep their original meaning.
    const record = computeRecord(URL_A, many(10, { ok: false, settled: true }));
    expect(record.observations).toBe(10);
    expect(record.clientErrorCount).toBe(0);
  });

  it("is not affected in the gate by client errors alone", () => {
    const store = new Store(":memory:");
    const engine = new TrustEngine(store);
    for (const o of many(20, { ok: false, clientError: true })) {
      engine.record({ ...o, resourceUrl: URL_A });
    }
    // Unrated, so allowed: we have learned nothing about this endpoint.
    expect(engine.gate(URL_A).allow).toBe(true);
    expect(engine.gate(URL_A).record.verdict).toBe("unrated");
  });
});

describe("a refusal must not be permanent", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  /** Poisons a record, with the newest observation at `lastSeen`. */
  const poison = (engine: TrustEngine, url: string, lastSeen: string) => {
    for (let i = 0; i < 20; i += 1) {
      engine.record({
        resourceUrl: url,
        at: new Date(Date.parse(lastSeen) - i * 1_000).toISOString(),
        ok: false,
        httpStatus: 200,
        latencyMs: 300,
        settled: true,
        schemaOk: null,
        coldStart: false,
        failureReason: "took payment, returned nothing",
      });
    }
  };

  const NOW = Date.parse("2026-09-19T12:00:00.000Z");

  it("refuses a freshly failing service", () => {
    const engine = new TrustEngine(store, DEFAULT_POLICY, () => NOW);
    poison(engine, URL_A, "2026-09-19T11:59:00.000Z"); // one minute ago
    const gate = engine.gate(URL_A);
    expect(gate.allow).toBe(false);
    expect(gate.record.onParole).toBeUndefined();
  });

  it("allows one probationary call once the cooldown has elapsed", () => {
    // Without this a refusal is permanent by construction: refusing prevents the
    // observations that would clear it, so the score can never move.
    const engine = new TrustEngine(store, DEFAULT_POLICY, () => NOW);
    poison(engine, URL_A, "2026-09-19T11:40:00.000Z"); // twenty minutes ago
    const gate = engine.gate(URL_A);
    expect(gate.allow).toBe(true);
    expect(gate.record.onParole).toBe(true);
    expect(gate.reason).toMatch(/probationary/);
  });

  it("holds the line right up to the cooldown boundary", () => {
    const engine = new TrustEngine(store, DEFAULT_POLICY, () => NOW, 15 * 60 * 1000);
    poison(engine, URL_A, new Date(NOW - 15 * 60 * 1000 + 1_000).toISOString());
    expect(engine.gate(URL_A).allow).toBe(false);

    const later = new TrustEngine(store, DEFAULT_POLICY, () => NOW + 2_000, 15 * 60 * 1000);
    expect(later.gate(URL_A).allow).toBe(true);
  });

  it("lets a paroled service actually recover", () => {
    // The end of the story: probation, then good calls, then a passing score.
    const engine = new TrustEngine(store, DEFAULT_POLICY, () => NOW);
    poison(engine, URL_A, "2026-09-19T11:00:00.000Z");
    expect(engine.gate(URL_A).allow).toBe(true);

    for (let i = 0; i < 30; i += 1) {
      engine.record({
        resourceUrl: URL_A,
        at: new Date(NOW + i * 1_000).toISOString(),
        ok: true,
        httpStatus: 200,
        latencyMs: 300,
        settled: true,
        schemaOk: null,
        coldStart: false,
        failureReason: null,
      });
    }

    const recovered = engine.gate(URL_A);
    expect(recovered.record.verdict).toBe("pass");
    expect(recovered.record.onParole).toBeUndefined();
  });

  it("does not mark a passing service as on parole", () => {
    const engine = new TrustEngine(store, DEFAULT_POLICY, () => NOW);
    for (const o of many(20)) engine.record({ ...o, resourceUrl: URL_B });
    expect(engine.gate(URL_B).record.onParole).toBeUndefined();
  });

  it("paroles a record with no observation timestamp rather than trapping it", () => {
    const engine = new TrustEngine(store, DEFAULT_POLICY, () => NOW);
    // Nothing recorded at all is unrated, which is already allowed.
    expect(engine.gate("https://never-seen.test/x").allow).toBe(true);
  });
});
