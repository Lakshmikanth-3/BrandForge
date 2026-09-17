import algosdk from "algosdk";
import type { NetworkConfig } from "@sentry402/shared";
import { MIN_BALANCE_MICROALGOS } from "@sentry402/shared";

export interface AccountStatus {
  readonly address: string;
  /** True once the account holds ALGO. Algod returns a zero record for unknown
   *  addresses rather than 404, so presence on chain is not a useful signal. */
  readonly funded: boolean;
  readonly algo: number;
  /** null when the account has not opted into USDC — a hard blocker for x402. */
  readonly usdc: number | null;
  readonly usdcOptedIn: boolean;
  /** Spendable ALGO after the locked minimum balance. */
  readonly spendableAlgo: number;
}

export function algodFor(net: NetworkConfig): algosdk.Algodv2 {
  return new algosdk.Algodv2("", net.algodUrl, "");
}

/**
 * Reads an account's ALGO and USDC position. Opt-in is reported as a distinct
 * boolean because "0 USDC" and "cannot hold USDC" are different failures and the
 * second one silently breaks every payment.
 */
export async function accountStatus(
  net: NetworkConfig,
  address: string,
): Promise<AccountStatus> {
  const client = algodFor(net);
  try {
    const info = await client.accountInformation(address).do();
    const micro = Number(info.amount ?? 0);
    const assets = (info.assets ?? []) as { assetId?: bigint | number; amount?: bigint | number }[];
    const holding = assets.find((a) => String(a.assetId) === net.usdcAsaId);

    return {
      address,
      funded: micro > 0,
      algo: micro / 1e6,
      usdc: holding ? Number(holding.amount ?? 0) / 1e6 : null,
      usdcOptedIn: holding !== undefined,
      spendableAlgo: Math.max(0, (micro - MIN_BALANCE_MICROALGOS) / 1e6),
    };
  } catch {
    // Network or decode failure. Report it as unfunded rather than crashing health.
    return {
      address,
      funded: false,
      algo: 0,
      usdc: null,
      usdcOptedIn: false,
      spendableAlgo: 0,
    };
  }
}
