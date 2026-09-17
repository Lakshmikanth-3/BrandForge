/**
 * Network constants. Verified 2026-09-18 against
 * https://facilitator.goplausible.xyz/supported and the live discovery catalog.
 *
 * These are duplicated deliberately rather than imported from @x402/avm so that
 * a package upgrade can never silently change which chain we settle on. The
 * contract test in networks.test.ts asserts they still match the facilitator.
 */

export const NETWORKS = ["testnet", "mainnet"] as const;
export type NetworkName = (typeof NETWORKS)[number];

export interface NetworkConfig {
  readonly name: NetworkName;
  /** CAIP-2 chain id the facilitator keys payments on. */
  readonly caip2: string;
  /** USDC asset id (ASA). */
  readonly usdcAsaId: string;
  /** Facilitator account that covers the Algorand transaction fee. */
  readonly feePayer: string;
  readonly algodUrl: string;
  readonly indexerUrl: string;
  readonly explorerTxBase: string;
}

export const TESTNET: NetworkConfig = {
  name: "testnet",
  caip2: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  usdcAsaId: "10458941",
  feePayer: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  algodUrl: "https://testnet-api.algonode.cloud",
  indexerUrl: "https://testnet-idx.algonode.cloud",
  explorerTxBase: "https://lora.algokit.io/testnet/transaction/",
};

export const MAINNET: NetworkConfig = {
  name: "mainnet",
  caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  usdcAsaId: "31566704",
  feePayer: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA",
  algodUrl: "https://mainnet-api.algonode.cloud",
  indexerUrl: "https://mainnet-idx.algonode.cloud",
  explorerTxBase: "https://lora.algokit.io/mainnet/transaction/",
};

export function networkConfig(name: NetworkName): NetworkConfig {
  return name === "mainnet" ? MAINNET : TESTNET;
}

/** The challenge tag. Goes in `accepts[].extra.tag`. Labelling only — never affects payment. */
export const CHALLENGE_TAG = "x402-global-challenge";

/** Minimum balance locked per account: 0.1 ALGO base + 0.1 ALGO per ASA opt-in. */
export const MIN_BALANCE_MICROALGOS = 200_000;
