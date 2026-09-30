// Generated from src/eventPrizes/solana.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRpcUrl =
  exports.createEventPrizeUmi =
  exports.TRANSACTION_STATUS_RETRY_DELAYS_MS =
  exports.SIGNATURE_STATUS_TIMEOUT_MS =
  exports.SEND_TRANSACTION_TIMEOUT_MS =
  exports.CONFIRMATION_TIMEOUT_MS =
  exports.CONFIRMATION_COMMITMENT =
    void 0;
exports.loadSolanaDependencies = loadSolanaDependencies;
const errors_js_1 = require("./errors.js");
const event_prizes_1 = require("@mons/shared/event-prizes");
const eventPrizeWithdrawalState_js_1 = require("../eventPrizeWithdrawalState.js");
const CONFIRMATION_COMMITMENT = "confirmed";
exports.CONFIRMATION_COMMITMENT = CONFIRMATION_COMMITMENT;
const CONFIRMATION_TIMEOUT_MS = 45 * 1000;
exports.CONFIRMATION_TIMEOUT_MS = CONFIRMATION_TIMEOUT_MS;
const SEND_TRANSACTION_TIMEOUT_MS = 10 * 1000;
exports.SEND_TRANSACTION_TIMEOUT_MS = SEND_TRANSACTION_TIMEOUT_MS;
const SIGNATURE_STATUS_TIMEOUT_MS = 2 * 1000;
exports.SIGNATURE_STATUS_TIMEOUT_MS = SIGNATURE_STATUS_TIMEOUT_MS;
const TRANSACTION_STATUS_RETRY_DELAYS_MS = [0, 500, 1000, 2000, 4000, 8000];
exports.TRANSACTION_STATUS_RETRY_DELAYS_MS = TRANSACTION_STATUS_RETRY_DELAYS_MS;
let sharedSolanaDependencies = null;
let coreSolanaDependencies = null;
let compressedSolanaDependencies = null;
function loadSolanaDependencies(standard) {
  if (standard != null && !(0, event_prizes_1.isEventPrizeStandard)(standard)) {
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
    } = require("@metaplex-foundation/umi");
    const { createUmi } = require("@metaplex-foundation/umi-bundle-defaults");
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
      } = require("@metaplex-foundation/mpl-core");
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
    } = require("@metaplex-foundation/mpl-bubblegum");
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
const getRpcUrl = (heliusRpcApiKey) => {
  const normalizedApiKey =
    typeof heliusRpcApiKey === "string" ? heliusRpcApiKey.trim() : "";
  const rpcUrl = normalizedApiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(normalizedApiKey)}`
    : "";
  if (!rpcUrl) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "failed-precondition",
      "Solana RPC is not configured.",
    );
  }
  return rpcUrl;
};
exports.getRpcUrl = getRpcUrl;
const createEventPrizeUmi = (
  standard,
  { adminPrivateKey, heliusRpcApiKey } = {},
) => {
  const dependencies = loadSolanaDependencies(standard);
  const { createSignerFromKeypair, createUmi, signerIdentity } = dependencies;
  const secretKey = (0, eventPrizeWithdrawalState_js_1.decodeAdminSecretKey)(
    adminPrivateKey,
  );
  if (!secretKey) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "failed-precondition",
      "The event prize wallet is not configured.",
    );
  }
  const plugin =
    standard === "core" ? dependencies.mplCore() : dependencies.mplBubblegum();
  const umi = createUmi(getRpcUrl(heliusRpcApiKey), {
    commitment: CONFIRMATION_COMMITMENT,
  }).use(plugin);
  const keypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
  const signer = createSignerFromKeypair(umi, keypair);
  if (
    signer.publicKey !== eventPrizeWithdrawalState_js_1.EVENT_PRIZE_ADMIN_WALLET
  ) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "failed-precondition",
      "The event prize wallet is misconfigured.",
    );
  }
  umi.use(signerIdentity(signer));
  return umi;
};
exports.createEventPrizeUmi = createEventPrizeUmi;
