// Generated from src/eventPrizes/solana.ts. Run npm run generate:runtime.
import type { Umi } from "@metaplex-foundation/umi";
import { type EventPrizeStandard } from "@mons/shared/event-prizes";
declare const CONFIRMATION_COMMITMENT = "confirmed";
declare const CONFIRMATION_TIMEOUT_MS: number;
declare const SEND_TRANSACTION_TIMEOUT_MS: number;
declare const SIGNATURE_STATUS_TIMEOUT_MS: number;
declare const TRANSACTION_STATUS_RETRY_DELAYS_MS: number[];
type SharedSolanaDependencies = Pick<
  typeof import("@metaplex-foundation/umi"),
  | "base58"
  | "createSignerFromKeypair"
  | "none"
  | "publicKey"
  | "some"
  | "signerIdentity"
  | "wrapNullable"
> &
  Pick<typeof import("@metaplex-foundation/umi-bundle-defaults"), "createUmi">;
type CoreSolanaDependencies = SharedSolanaDependencies &
  Pick<
    typeof import("@metaplex-foundation/mpl-core"),
    "fetchAsset" | "fetchCollection" | "mplCore"
  > & {
    transferCore: typeof import("@metaplex-foundation/mpl-core").transfer;
  };
type CompressedSolanaDependencies = SharedSolanaDependencies &
  Pick<
    typeof import("@metaplex-foundation/mpl-bubblegum"),
    | "TokenProgramVersion"
    | "TokenStandard"
    | "canTransfer"
    | "findLeafAssetIdPda"
    | "getAssetWithProof"
    | "hashMetadataCreators"
    | "hashMetadataData"
    | "mplBubblegum"
  > & {
    transferCompressed: typeof import("@metaplex-foundation/mpl-bubblegum").transfer;
  };
declare function loadSolanaDependencies(): SharedSolanaDependencies;
declare function loadSolanaDependencies(
  standard: "core",
): CoreSolanaDependencies;
declare function loadSolanaDependencies(
  standard: "compressed",
): CompressedSolanaDependencies;
declare function loadSolanaDependencies(
  standard: EventPrizeStandard,
): CoreSolanaDependencies | CompressedSolanaDependencies;
declare const getRpcUrl: (heliusRpcApiKey: unknown) => string;
declare const createEventPrizeUmi: (
  standard: EventPrizeStandard,
  {
    adminPrivateKey,
    heliusRpcApiKey,
  }?: {
    adminPrivateKey?: unknown;
    heliusRpcApiKey?: unknown;
  },
) => Umi;
export {
  CONFIRMATION_COMMITMENT,
  CONFIRMATION_TIMEOUT_MS,
  SEND_TRANSACTION_TIMEOUT_MS,
  SIGNATURE_STATUS_TIMEOUT_MS,
  TRANSACTION_STATUS_RETRY_DELAYS_MS,
  createEventPrizeUmi,
  getRpcUrl,
  loadSolanaDependencies,
};
