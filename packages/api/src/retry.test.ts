import { describe, expect, it } from "vitest";
import { retryTransient } from "./x402.js";

const flaky = (failures: number, error: () => Error) => {
  const o = {
    calls: 0,
    async getSupported() {
      o.calls += 1;
      if (o.calls <= failures) throw error();
      return "ok";
    },
  };
  return o;
};

describe("retryTransient", () => {
  it("recovers from a socket failure on the first attempts", async () => {
    const o = flaky(2, () => new TypeError("fetch failed"));
    retryTransient(o, "getSupported", 3, 1);
    expect(await o.getSupported()).toBe("ok");
    expect(o.calls).toBe(3);
  });

  it("gives up after the attempt limit and surfaces the error", async () => {
    const o = flaky(9, () => new TypeError("fetch failed"));
    retryTransient(o, "getSupported", 3, 1);
    await expect(o.getSupported()).rejects.toThrow("fetch failed");
    expect(o.calls).toBe(3);
  });

  it("does not retry an error that is not a network failure", async () => {
    const o = flaky(9, () => new Error("HTTP 400 bad request"));
    retryTransient(o, "getSupported", 3, 1);
    await expect(o.getSupported()).rejects.toThrow("HTTP 400");
    expect(o.calls).toBe(1);
  });
});
