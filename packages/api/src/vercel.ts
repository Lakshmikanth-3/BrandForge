import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Bridges a Vercel Node function to a fetch-style app (Hono's `app.fetch`).
 *
 * Why this exists instead of `@hono/node-server/vercel`: Vercel reads and parses the request
 * body BEFORE the function runs and leaves it on `req.body`, so the underlying stream is already
 * consumed. The stock adapter builds its Request from that empty stream, and any handler that
 * then awaits `c.req.json()` waits for bytes that never come, until the function times out.
 * Unpaid requests and GETs never read a body, so nothing showed it until the first paid POST.
 * Here the body is taken from `req.body` when Vercel has already parsed it, and only read from
 * the stream when it has not.
 */
type Fetcher = (request: Request) => Response | Promise<Response>;

async function readStream(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The body as bytes, from whichever place still has it. */
export async function bodyOf(req: IncomingMessage & { body?: unknown }): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const parsed = req.body;
  if (parsed === undefined || parsed === null) return readStream(req);
  if (Buffer.isBuffer(parsed)) return parsed;
  if (typeof parsed === "string") return Buffer.from(parsed);
  return Buffer.from(JSON.stringify(parsed));
}

export function toRequest(req: IncomingMessage, body: Buffer | undefined): Request {
  const host = req.headers.host ?? "localhost";
  const proto = String(req.headers["x-forwarded-proto"] ?? "https").split(",")[0]!.trim();
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    // Node's content-length may no longer match a re-serialised body, so let fetch set it.
    if (key === "content-length") continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  return new Request(`${proto}://${host}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}

export function vercelHandler(fetcher: Fetcher) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const response = await fetcher(toRequest(req, await bodyOf(req)));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") res.setHeader(key, value);
    });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
