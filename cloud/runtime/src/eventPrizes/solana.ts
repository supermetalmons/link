import type { Umi } from "@metaplex-foundation/umi";
import { EventPrizeWithdrawalError as HttpsError } from "./errors.js";
import {
  isEventPrizeStandard,
  type EventPrizeStandard,
} from "@mons/shared/event-prizes";
import {
  EVENT_PRIZE_ADMIN_WALLET,
  decodeAdminSecretKey,
} from "../eventPrizeWithdrawalState.js";

const CONFIRMATION_COMMITMENT = "confirmed";
const CONFIRMATION_TIMEOUT_MS = 45 * 1000;
const SEND_TRANSACTION_TIMEOUT_MS = 10 * 1000;
const SIGNATURE_STATUS_TIMEOUT_MS = 2 * 1000;
const TRANSACTION_STATUS_RETRY_DELAYS_MS = [0, 500, 1000, 2000, 4000, 8000];
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
  > & { transferCore: typeof import("@metaplex-foundation/mpl-core").transfer };
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
let sharedSolanaDependencies: SharedSolanaDependencies | null = null;
let coreSolanaDependencies: CoreSolanaDependencies | null = null;
let compressedSolanaDependencies: CompressedSolanaDependencies | null = null;

function loadSolanaDependencies(): SharedSolanaDependencies;
function loadSolanaDependencies(standard: "core"): CoreSolanaDependencies;
function loadSolanaDependencies(
  standard: "compressed",
): CompressedSolanaDependencies;
function loadSolanaDependencies(
  standard: EventPrizeStandard,
): CoreSolanaDependencies | CompressedSolanaDependencies;
function loadSolanaDependencies(
  standard?: unknown,
):
  | SharedSolanaDependencies
  | CoreSolanaDependencies
  | CompressedSolanaDependencies {
  if (standard != null && !isEventPrizeStandard(standard)) {
    throw new TypeError("Unsupported event prize standard.");
  }
  if (!sharedSolanaDependencies) {
    const {
      base58,
      createSignerFromKeypair,
      none,
      publicKey,
      some,
      signerIdentity,
      wrapNullable,
    }: typeof import("@metaplex-foundation/umi") = require("@metaplex-foundation/umi");
    const {
      createUmi,
    }: typeof import("@metaplex-foundation/umi-bundle-defaults") = require("@metaplex-foundation/umi-bundle-defaults");
    sharedSolanaDependencies = {
      base58,
      createSignerFromKeypair,
      createUmi,
      none,
      publicKey,
      some,
      signerIdentity,
      wrapNullable,
    };
  }
  if (standard == null) {
    return sharedSolanaDependencies;
  }
  if (standard === "core") {
    if (!coreSolanaDependencies) {
      const {
        fetchAsset,
        fetchCollection,
        mplCore,
        transfer: transferCore,
      }: typeof import("@metaplex-foundation/mpl-core") = require("@metaplex-foundation/mpl-core");
      coreSolanaDependencies = {
        ...sharedSolanaDependencies,
        fetchAsset,
        fetchCollection,
        mplCore,
        transferCore,
      };
    }
    return coreSolanaDependencies;
  }
  if (!compressedSolanaDependencies) {
    const {
      TokenProgramVersion,
      TokenStandard,
      canTransfer,
      findLeafAssetIdPda,
      getAssetWithProof,
      hashMetadataCreators,
      hashMetadataData,
      mplBubblegum,
      transfer: transferCompressed,
    }: typeof import("@metaplex-foundation/mpl-bubblegum") = require("@metaplex-foundation/mpl-bubblegum");
    compressedSolanaDependencies = {
      ...sharedSolanaDependencies,
      TokenProgramVersion,
      TokenStandard,
      canTransfer,
      findLeafAssetIdPda,
      getAssetWithProof,
      hashMetadataCreators,
      hashMetadataData,
      mplBubblegum,
      transferCompressed,
    };
  }
  return compressedSolanaDependencies;
}

const getRpcUrl = (heliusRpcApiKey: unknown): string => {
  const normalizedApiKey =
    typeof heliusRpcApiKey === "string" ? heliusRpcApiKey.trim() : "";
  const rpcUrl = normalizedApiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(normalizedApiKey)}`
    : "";
  if (!rpcUrl) {
    throw new HttpsError(
      "failed-precondition",
      "Solana RPC is not configured.",
    );
  }
  return rpcUrl;
};

const createEventPrizeUmi = (
  standard: EventPrizeStandard,
  {
    adminPrivateKey,
    heliusRpcApiKey,
  }: { adminPrivateKey?: unknown; heliusRpcApiKey?: unknown } = {},
): Umi => {
  const dependencies = loadSolanaDependencies(standard);
  const { createSignerFromKeypair, createUmi, signerIdentity } = dependencies;
  const secretKey = decodeAdminSecretKey(adminPrivateKey);
  if (!secretKey) {
    throw new HttpsError(
      "failed-precondition",
      "The event prize wallet is not configured.",
    );
  }
  const plugin =
    standard === "core"
      ? (dependencies as CoreSolanaDependencies).mplCore()
      : (dependencies as CompressedSolanaDependencies).mplBubblegum();
  const umi = createUmi(getRpcUrl(heliusRpcApiKey), {
    commitment: CONFIRMATION_COMMITMENT,
  }).use(plugin);
  const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
  const signer = createSignerFromKeypair(umi, keypair);
  if (signer.publicKey !== EVENT_PRIZE_ADMIN_WALLET) {
    throw new HttpsError(
      "failed-precondition",
      "The event prize wallet is misconfigured.",
    );
  }
  umi.use(signerIdentity(signer));
  return umi;
};

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
