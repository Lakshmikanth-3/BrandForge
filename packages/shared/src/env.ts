import { z } from "zod";
import { NETWORKS, networkConfig, type NetworkConfig, type NetworkName } from "./networks.js";

const ALGORAND_ADDRESS = /^[A-Z2-7]{58}$/;

/**
 * NETWORK is the single switch. Cutover is one variable change (PRD §20).
 * Anything network-derived must come from `config.network`, never from a literal
 * at the call site.
 */
const schema = z.object({
  NETWORK: z.enum(NETWORKS, {
    errorMap: () => ({ message: `NETWORK must be one of: ${NETWORKS.join(" | ")}` }),
  }),
  PORT: z.coerce.number().int().positive().max(65535).default(4021),
  PUBLIC_BASE_URL: z.string().url(),
  FACILITATOR_URL: z.string().url(),

  MERCHANT_ADDRESS: z
    .string()
    .regex(ALGORAND_ADDRESS, "MERCHANT_ADDRESS must be a 58-char Algorand address"),

  PAYER_ADDRESS: z
    .string()
    .regex(ALGORAND_ADDRESS, "PAYER_ADDRESS must be a 58-char Algorand address"),

  /**
   * 25-word mnemonic. Secret: never logged, never serialised, never returned.
   *
   * OPTIONAL, because the public server never pays anyone: it sells the paid routes and
   * serves the site, and every outbound payment comes from the MCP server or the prober
   * running on the operator's own machine. Requiring the key here meant the deployed
   * server had to hold a funded wallet's secret on a free third-party host for no reason
   * at all. Without it the payer is simply disabled, which /api/budget reports honestly.
   */
  PAYER_MNEMONIC: z
    .string()
    .trim()
    .refine(
      (s) => s === "" || s.split(/\s+/).length === 25,
      "PAYER_MNEMONIC must be 25 words when set",
    )
    .optional(),

  ALGOD_URL: z.string().url().optional().or(z.literal("")),
  INDEXER_URL: z.string().url().optional().or(z.literal("")),
  BUILD_SHA: z.string().default("dev"),
});

export interface AppConfig {
  readonly network: NetworkConfig;
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly facilitatorUrl: string;
  readonly merchantAddress: string;
  readonly payerAddress: string;
  readonly buildSha: string;
  /** Kept out of the public config object on purpose — see `secrets`. */
  readonly secrets: { readonly payerMnemonic: string | null };
}

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvError";
  }
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  // Render injects RENDER_EXTERNAL_URL, which is only knowable AFTER the first deploy.
  // Falling back to it removes a chicken-and-egg step: the domain does not have to be
  // guessed and pasted in before the service exists. An explicit PUBLIC_BASE_URL wins,
  // which is what a custom domain at cutover will use.
  // Vercel injects VERCEL_PROJECT_PRODUCTION_URL as a bare host with no scheme, and it is
  // the PRODUCTION alias even inside a preview deployment. That is exactly what we want:
  // a preview URL must never be the one the facilitator catalogs.
  const vercelHost = raw["VERCEL_PROJECT_PRODUCTION_URL"];
  const hostUrl =
    raw["RENDER_EXTERNAL_URL"] ?? (vercelHost ? `https://${vercelHost}` : undefined);
  const withHostUrl: NodeJS.ProcessEnv = {
    ...raw,
    ...(raw["PUBLIC_BASE_URL"] || !hostUrl ? {} : { PUBLIC_BASE_URL: hostUrl }),
  };
  const parsed = schema.safeParse(withHostUrl);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const net = networkConfig(e.NETWORK as NetworkName);

  return {
    network: {
      ...net,
      ...(e.ALGOD_URL ? { algodUrl: e.ALGOD_URL } : {}),
      ...(e.INDEXER_URL ? { indexerUrl: e.INDEXER_URL } : {}),
    },
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    facilitatorUrl: e.FACILITATOR_URL.replace(/\/$/, ""),
    merchantAddress: e.MERCHANT_ADDRESS,
    payerAddress: e.PAYER_ADDRESS,
    buildSha: raw["RAILWAY_GIT_COMMIT_SHA"] ?? e.BUILD_SHA,
    secrets: { payerMnemonic: e.PAYER_MNEMONIC ? e.PAYER_MNEMONIC : null },
  };
}

/** Safe-to-serialise view. Used by /healthz — asserts no secret can leak. */
export function publicConfig(c: AppConfig) {
  return {
    network: c.network.name,
    caip2: c.network.caip2,
    usdcAsaId: c.network.usdcAsaId,
    merchantAddress: c.merchantAddress,
    payerAddress: c.payerAddress,
    facilitatorUrl: c.facilitatorUrl,
    publicBaseUrl: c.publicBaseUrl,
    buildSha: c.buildSha,
  };
}
