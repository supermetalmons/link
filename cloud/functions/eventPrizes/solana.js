"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { isEventPrizeStandard } = require("@mons/shared/event-prizes");
const { getHeliusRpcUrl } = require("../heliusRpc");
const {
  EVENT_PRIZE_ADMIN_WALLET,
  decodeAdminSecretKey,
} = require("../eventPrizeWithdrawalState");

const EVENT_PRIZE_ADMIN_PRIVATE_KEY = defineSecret(
  "EVENT_PRIZE_ADMIN_PRIVATE_KEY",
);
const CONFIRMATION_COMMITMENT = "confirmed";
const CONFIRMATION_TIMEOUT_MS = 45 * 1000;
const SEND_TRANSACTION_TIMEOUT_MS = 10 * 1000;
const SIGNATURE_STATUS_TIMEOUT_MS = 2 * 1000;
const TRANSACTION_STATUS_RETRY_DELAYS_MS = [0, 500, 1000, 2000, 4000, 8000];
let sharedSolanaDependencies = null;
let coreSolanaDependencies = null;
let compressedSolanaDependencies = null;

const loadSolanaDependencies = (standard) => {
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
};

const getRpcUrl = () => {
  const rpcUrl = getHeliusRpcUrl();
  if (!rpcUrl) {
    throw new HttpsError(
      "failed-precondition",
      "Solana RPC is not configured.",
    );
  }
  return rpcUrl;
};

const createEventPrizeUmi = (standard) => {
  const dependencies = loadSolanaDependencies(standard);
  const { createSignerFromKeypair, createUmi, signerIdentity } = dependencies;
  const secretKey = decodeAdminSecretKey(EVENT_PRIZE_ADMIN_PRIVATE_KEY.value());
  if (!secretKey) {
    throw new HttpsError(
      "failed-precondition",
      "The event prize wallet is not configured.",
    );
  }
  const plugin =
    standard === "core" ? dependencies.mplCore() : dependencies.mplBubblegum();
  const umi = createUmi(getRpcUrl(), {
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

module.exports = {
  CONFIRMATION_COMMITMENT,
  CONFIRMATION_TIMEOUT_MS,
  EVENT_PRIZE_ADMIN_PRIVATE_KEY,
  SEND_TRANSACTION_TIMEOUT_MS,
  SIGNATURE_STATUS_TIMEOUT_MS,
  TRANSACTION_STATUS_RETRY_DELAYS_MS,
  createEventPrizeUmi,
  loadSolanaDependencies,
};
