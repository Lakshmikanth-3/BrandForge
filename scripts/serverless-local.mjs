/**
 * Runs the Vercel function's exported handler behind a plain HTTP server, so the exact code
 * Vercel will run can be exercised locally before anything is deployed.
 *
 * Usage:  npm run build && npm run serverless:local     (listens on :4500)
 *
 * Point it at a public host by setting VERCEL_PROJECT_PRODUCTION_URL, which is what the
 * server uses to work out the URL it advertises.
 */
import { createServer } from "node:http";
import { config } from "dotenv";

config();
const { default: handler } = await import("../api/index.js");
const port = Number(process.env.PORT ?? 4500);
createServer((req, res) => handler(req, res)).listen(port, () => {
  console.log(`serverless handler on http://127.0.0.1:${port}`);
});
