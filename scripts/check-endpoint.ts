/**
 * Reads a live 402 from a public URL and checks everything a badge depends on.
 *
 * Built for one specific moment: a settlement confirms on chain and the BAZAAR badge
 * is still false. The reflex is to re-fire the payment, which is wrong — it buys a
 * second bootstrap row in the receipts and changes nothing. The two causes look
 * identical from the badge:
 *
 *   the payment did not land          → the chain tells you, not this script
 *   the payment landed but nothing    → this script tells you, by showing whether
 *   was declared to catalog             extensions.bazaar is in the live response
 *
 * This deliberately fetches over the network from outside the process, because a
 * declaration present in the config and a declaration present in what the facilitator
 * actually receives are different facts, and only the second one matters.
 *
 * Usage:
 *   npm run check:endpoint -- https://your-domain/v1/orchestrate
 *   npm run check:endpoint                 # defaults to PUBLIC_BASE_URL + /v1/orchestrate
 */
import { config as loadDotenv } from "dotenv";
import { CHALLENGE_TAG, loadConfig } from "@sentry402/shared";

loadDotenv();
const config = loadConfig();

const target =
  process.argv.slice(2).find((a) => a.startsWith("http")) ??
  `${config.publicBaseUrl}/v1/orchestrate`;

interface Check {
  label: string;
  pass: boolean;
  detail: string;
  /** Why this one matters, shown only when it fails. */
  hint?: string;
}

const checks: Check[] = [];
const add = (label: string, pass: boolean, detail: string, hint?: string) =>
  checks.push({ label, pass, detail, ...(hint ? { hint } : {}) });

console.log(`\nchecking ${target}\n`);

let res: Response;
try {
  res = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
} catch (err) {
  console.error(
    `✗ unreachable: ${err instanceof Error ? err.message : "unknown error"}\n\n` +
      `  If the facilitator cannot reach this URL, nothing downstream of it can work.\n`,
  );
  process.exit(1);
}

add(
  "returns 402",
  res.status === 402,
  `HTTP ${res.status}`,
  "A paid route must answer 402 to an unpaid request before anything else is true.",
);

add(
  "served over HTTPS",
  target.startsWith("https://"),
  target.split(":")[0] ?? "",
  "The facilitator probes over HTTPS.",
);

add(
  "CORS allows the probe",
  res.headers.get("access-control-allow-origin") === "*",
  res.headers.get("access-control-allow-origin") ?? "absent",
  "The facilitator's probe checks CORS headers.",
);

const header = res.headers.get("payment-required");
add(
  "carries a payment-required header",
  header !== null,
  header === null ? "absent" : `${header.length} bytes`,
  "x402 v2 carries the challenge in this header, not the body. Without it there is " +
    "nothing for a client or the facilitator to read.",
);

interface Challenge {
  x402Version?: number;
  resource?: { url?: string; description?: string };
  accepts?: {
    network?: string;
    amount?: string;
    asset?: string;
    payTo?: string;
    extra?: { tag?: string };
  }[];
  extensions?: { bazaar?: { info?: unknown; schema?: unknown } };
}

let challenge: Challenge | null = null;
if (header) {
  try {
    challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Challenge;
  } catch {
    challenge = null;
  }
}

add(
  "challenge decodes as base64 JSON",
  challenge !== null,
  challenge === null ? "unparseable" : `x402Version ${challenge.x402Version}`,
);

const accept = challenge?.accepts?.[0];

add(
  "advertises our network",
  accept?.network === config.network.caip2,
  accept?.network ?? "none",
  `Expected ${config.network.caip2}. A truncated CAIP-2 will not match the facilitator.`,
);

add(
  "advertises our merchant address",
  accept?.payTo === config.merchantAddress,
  accept?.payTo ?? "none",
  `Expected ${config.merchantAddress}.`,
);

add(
  "advertises USDC",
  accept?.asset === config.network.usdcAsaId,
  accept?.asset ?? "none",
  `Expected ASA ${config.network.usdcAsaId}.`,
);

add(
  `carries the ${CHALLENGE_TAG} tag`,
  accept?.extra?.tag === CHALLENGE_TAG,
  accept?.extra?.tag ?? "absent",
  "Without the tag a settlement is real but does not count for the challenge. " +
    "This is the HACKATHON badge, and it only applies to MainNet routes.",
);

// The one this script exists for.
const bazaar = challenge?.extensions?.bazaar;
add(
  "declares extensions.bazaar",
  bazaar !== undefined && bazaar !== null,
  bazaar ? "present, with info and schema" : "ABSENT",
  "This is the BAZAAR badge. Without this in the LIVE response, a settled payment " +
    "catalogs nothing, and the badge stays false no matter how many payments land. " +
    "Re-firing the payment will not help.",
);

add(
  "resource url is the public one",
  typeof challenge?.resource?.url === "string" &&
    !/localhost|127\.0\.0\.1/.test(challenge.resource.url),
  challenge?.resource?.url ?? "none",
  "The facilitator catalogs this URL. A localhost value publishes a broken listing " +
    "bound to a payTo that cannot be rotated.",
);

add(
  "description is specific enough to list",
  (challenge?.resource?.description ?? "").length > 80,
  `${(challenge?.resource?.description ?? "").length} chars`,
  "The description IS the Bazaar listing.",
);

// ── Report ────────────────────────────────────────────────────────────────────
for (const c of checks) {
  console.log(`  ${c.pass ? "✓" : "✗"} ${c.label.padEnd(38)} ${c.detail}`);
  if (!c.pass && c.hint) console.log(`      ${c.hint}`);
}

const failed = checks.filter((c) => !c.pass);
console.log(
  `\n  ${checks.length - failed.length}/${checks.length} checks passed on ${config.network.name}\n`,
);

if (failed.length > 0) {
  console.log(`  Fix these before looking at the badge, not after.\n`);
  process.exit(1);
}

console.log(`  The live response is sound. If a badge is still false after a settlement
  confirms on chain, the cause is on the facilitator's side rather than ours:
    ${config.facilitatorUrl}/discovery/merchants
    ${config.facilitatorUrl}/discovery/resources
`);
