import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono } from "hono";
import { bodyOf, vercelHandler } from "./vercel.js";

/** A request shaped like Vercel's: body already parsed onto req.body, stream already drained. */
function vercelReq(opts: { method?: string; body?: unknown; streamed?: string }): IncomingMessage {
  const stream = Readable.from(opts.streamed ? [Buffer.from(opts.streamed)] : []) as unknown as IncomingMessage;
  Object.assign(stream, {
    method: opts.method ?? "POST",
    url: "/v1/orchestrate?x=1",
    headers: { host: "example.test", "content-type": "application/json", "content-length": "999" },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  return stream;
}

function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const res = {
    set statusCode(v: number) { out.status = v; },
    setHeader: (k: string, v: unknown) => { out.headers[k] = v; },
    end: (b: Buffer) => { out.body = b.toString(); },
  } as unknown as ServerResponse;
  return { res, out };
}

describe("vercel adapter", () => {
  it("reads a body Vercel already parsed, which the stock adapter hangs on", async () => {
    const app = new Hono();
    app.post("/v1/orchestrate", async (c) => c.json({ got: await c.req.json() }));
    const { res, out } = fakeRes();

    // The stream is empty (Vercel drained it); only req.body has the data.
    await Promise.race([
      vercelHandler(app.fetch)(vercelReq({ body: { target: "folks_tvl" } }), res),
      new Promise((_, rej) => setTimeout(() => rej(new Error("hung waiting for the body")), 2000)),
    ]);

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ got: { target: "folks_tvl" } });
  });

  it("falls back to the stream when nothing was pre-parsed", async () => {
    const buf = await bodyOf(vercelReq({ streamed: '{"a":1}' }));
    expect(buf?.toString()).toBe('{"a":1}');
  });

  it("passes a string or buffer body through untouched", async () => {
    expect((await bodyOf(vercelReq({ body: "raw" })))?.toString()).toBe("raw");
    expect((await bodyOf(vercelReq({ body: Buffer.from("buf") })))?.toString()).toBe("buf");
  });

  it("sends no body on GET and keeps the query string", async () => {
    const app = new Hono();
    app.get("/v1/orchestrate", (c) => c.json({ q: c.req.query("x") }));
    const { res, out } = fakeRes();
    await vercelHandler(app.fetch)(vercelReq({ method: "GET" }), res);
    expect(JSON.parse(out.body)).toEqual({ q: "1" });
  });
});
