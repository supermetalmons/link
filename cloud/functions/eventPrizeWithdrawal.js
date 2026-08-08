"use strict";

const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const {
  getEventPrizeDefinition,
  isEventPrizeStandard,
} = require("@mons/shared/event-prizes");
const admin = require("./firebaseAdmin");
const { HELIUS_RPC_API_KEY, getHeliusRpcUrl } = require("./heliusRpc");
const { readProfileByLoginUid } = require("./profileLookup");
const { runRtdbDecisionTransaction } = require("./rtdbDecisionTransaction");
const {
  removeMatchingProfileEventPrizeAssignment,
  resolveCanonicalProfileId,
  resolveCanonicalProfilePath,
} = require("./profileEventPrizeProjection");
const {
  EVENT_PRIZE_ADMIN_WALLET,
  buildWithdrawalCompletionUpdates,
  decodeAdminSecretKey,
  decideWithdrawalClaim,
  getEventPrizeWithdrawalPath,
  getWithdrawalProjectionProfileIds,
  isCompletedEventPrizeWithdrawal,
  isWithdrawalRecordForPrize,
  isWithdrawalRecordOwnedByRequest,
  normalizeSolanaAddress,
} = require("./eventPrizeWithdrawalState");

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

class DefinitiveSubmittedTransactionFailure extends Error {}

const isDefinitiveSubmittedTransactionFailure = (error) =>
  error instanceof DefinitiveSubmittedTransactionFailure;

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

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const buildCompletedResponse = (withdrawal) => ({
  ok: true,
  status: "completed",
  eventId: normalizeString(withdrawal.eventId),
  prizeId: normalizeString(withdrawal.prizeId),
  assetAddress: normalizeString(withdrawal.assetAddress),
  recipientAddress: normalizeString(withdrawal.recipientAddress),
  transactionSignature: normalizeString(withdrawal.transactionSignature),
});

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

const validatePrizeAssignment = ({
  assignment,
  eventId,
  prizeId,
  profileId,
}) => {
  const place = Number(assignment?.place);
  if (
    !assignment ||
    normalizeString(assignment.eventId) !== eventId ||
    normalizeString(assignment.prizeId) !== prizeId ||
    normalizeString(assignment.profileId) !== profileId ||
    ![1, 2, 3].includes(place)
  ) {
    throw new HttpsError("not-found", "Event prize not found.");
  }
  return place;
};

const isBytes32 = (value) => value instanceof Uint8Array && value.length === 32;

const areBytesEqual = (left, right) =>
  left instanceof Uint8Array &&
  right instanceof Uint8Array &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const createPrizeAssetVerificationError = (message) =>
  new HttpsError("failed-precondition", message);

const parseCompressedPrizeObservation = ({ prize, rpcAsset }) => {
  const { base58 } = loadSolanaDependencies();
  const assetAddress = normalizeString(prize?.assetAddress);
  const collectionAddress = normalizeString(prize?.collectionAddress);
  const assetOwner = normalizeSolanaAddress(rpcAsset?.ownership?.owner);
  const compression = rpcAsset?.compression;
  const compressionTree = normalizeSolanaAddress(compression?.tree);
  const leafId = Number(compression?.leaf_id);

  if (
    normalizeSolanaAddress(assetAddress) !== assetAddress ||
    normalizeSolanaAddress(collectionAddress) !== collectionAddress ||
    normalizeSolanaAddress(rpcAsset?.id) !== assetAddress ||
    !assetOwner ||
    !Array.isArray(rpcAsset?.grouping) ||
    typeof rpcAsset?.ownership?.frozen !== "boolean" ||
    rpcAsset?.ownership?.ownership_model !== "single" ||
    !compressionTree ||
    compression?.compressed !== true ||
    !normalizeSolanaAddress(compression?.data_hash) ||
    !normalizeSolanaAddress(compression?.creator_hash) ||
    !Number.isSafeInteger(leafId) ||
    leafId < 0
  ) {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }

  let dataHash;
  let creatorHash;
  try {
    dataHash = base58.serialize(compression.data_hash);
    creatorHash = base58.serialize(compression.creator_hash);
  } catch {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }
  if (!isBytes32(dataHash) || !isBytes32(creatorHash)) {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }

  if (
    rpcAsset.interface !== "V1_NFT" ||
    compression.collection_hash != null ||
    compression.asset_data_hash != null ||
    compression.flags != null
  ) {
    throw createPrizeAssetVerificationError(
      "The compressed prize format is not supported.",
    );
  }

  const collectionGroups = rpcAsset.grouping.filter(
    (group) => group?.group_key === "collection",
  );
  if (collectionGroups.length !== 1) {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }
  const observedCollectionAddress = normalizeSolanaAddress(
    collectionGroups[0].group_value,
  );
  if (!observedCollectionAddress) {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }
  return {
    assetOwner,
    collectionAddress,
    collectionMatches: observedCollectionAddress === collectionAddress,
    compression,
    compressionTree,
    creatorHash,
    dataHash,
    leafId,
    rpcAsset,
  };
};

const resolveCompressedPrizeOwnership = (observation) => {
  const { canTransfer } = loadSolanaDependencies("compressed");
  const { assetOwner, rpcAsset } = observation;
  if (rpcAsset.burnt === true || rpcAsset.ownership.non_transferable === true) {
    return {
      assetOwner,
      blocked: true,
      message: "This prize is unavailable for withdrawal.",
    };
  }
  if (
    rpcAsset.burnt !== false ||
    rpcAsset.ownership.frozen !== false ||
    !canTransfer(rpcAsset)
  ) {
    throw createPrizeAssetVerificationError(
      "This prize cannot be withdrawn right now.",
    );
  }
  return { assetOwner, blocked: false };
};

const validateCompressedPrizeProof = ({ umi, assetWithProof, observation }) => {
  const { findLeafAssetIdPda } = loadSolanaDependencies("compressed");
  const {
    assetOwner,
    compression,
    compressionTree,
    creatorHash,
    dataHash,
    leafId,
  } = observation;
  const rpcAsset = observation.rpcAsset;
  const rpcAssetProof = assetWithProof?.rpcAssetProof;
  const leafDelegate = rpcAsset?.ownership?.delegate;
  const expectedLeafDelegate =
    normalizeSolanaAddress(leafDelegate) || assetOwner;
  const merkleTree = normalizeSolanaAddress(assetWithProof?.merkleTree);
  const nonce = Number(assetWithProof?.nonce);
  const index = Number(assetWithProof?.index);
  const proof = assetWithProof?.proof;
  const rawProof = rpcAssetProof?.proof;
  const rawNodeIndex = Number(rpcAssetProof?.node_index);
  const leafNodeOffset = Array.isArray(rawProof)
    ? 2 ** rawProof.length
    : Number.NaN;

  if (
    (leafDelegate != null && !normalizeSolanaAddress(leafDelegate)) ||
    normalizeSolanaAddress(assetWithProof?.leafOwner) !== assetOwner ||
    normalizeSolanaAddress(assetWithProof?.leafDelegate) !==
      expectedLeafDelegate ||
    !merkleTree ||
    normalizeSolanaAddress(rpcAssetProof?.tree_id) !== merkleTree ||
    compressionTree !== merkleTree ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0 ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    leafId !== nonce ||
    !isBytes32(assetWithProof?.root) ||
    !isBytes32(assetWithProof?.dataHash) ||
    !isBytes32(assetWithProof?.creatorHash) ||
    !areBytesEqual(assetWithProof.dataHash, dataHash) ||
    !areBytesEqual(assetWithProof.creatorHash, creatorHash) ||
    !Array.isArray(proof) ||
    proof.some((node) => !normalizeSolanaAddress(node)) ||
    !Array.isArray(rawProof) ||
    rawProof.some((node) => !normalizeSolanaAddress(node)) ||
    proof.length > rawProof.length ||
    proof.some((node, proofIndex) => node !== rawProof[proofIndex]) ||
    !Number.isSafeInteger(rawNodeIndex) ||
    !Number.isSafeInteger(leafNodeOffset) ||
    rawNodeIndex - leafNodeOffset !== index
  ) {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }

  const [derivedAssetAddress] = findLeafAssetIdPda(umi, {
    merkleTree: assetWithProof.merkleTree,
    leafIndex: assetWithProof.nonce,
  });
  if (derivedAssetAddress !== normalizeString(rpcAsset.id)) {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }
};

const createCompressedPrizeMetadata = (rpcAsset) => {
  const { TokenProgramVersion, TokenStandard, none, some, wrapNullable } =
    loadSolanaDependencies("compressed");
  return {
    name: rpcAsset.content?.metadata?.name ?? "",
    symbol: rpcAsset.content?.metadata?.symbol ?? "",
    uri: rpcAsset.content?.json_uri,
    sellerFeeBasisPoints: rpcAsset.royalty?.basis_points,
    primarySaleHappened: rpcAsset.royalty?.primary_sale_happened,
    isMutable: rpcAsset.mutable,
    editionNonce: wrapNullable(rpcAsset.supply?.edition_nonce),
    tokenStandard: some(TokenStandard.NonFungible),
    uses: none(),
    tokenProgramVersion: TokenProgramVersion.Original,
    creators: rpcAsset.creators,
  };
};

const getCompressedPrizeCollectionVerification = ({
  collectionAddress,
  creatorHash,
  dataHash,
  metadata,
}) => {
  const { hashMetadataCreators, hashMetadataData, publicKey, some } =
    loadSolanaDependencies("compressed");
  if (!metadata || !Array.isArray(metadata.creators)) {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }
  let computedCreatorHash;
  let verifiedDataHash;
  let unverifiedDataHash;
  try {
    computedCreatorHash = hashMetadataCreators(metadata.creators);
    const collectionKey = publicKey(collectionAddress);
    verifiedDataHash = hashMetadataData({
      ...metadata,
      collection: some({ key: collectionKey, verified: true }),
    });
    unverifiedDataHash = hashMetadataData({
      ...metadata,
      collection: some({ key: collectionKey, verified: false }),
    });
  } catch {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }
  if (
    !areBytesEqual(computedCreatorHash, creatorHash) ||
    (!areBytesEqual(verifiedDataHash, dataHash) &&
      !areBytesEqual(unverifiedDataHash, dataHash))
  ) {
    throw createPrizeAssetVerificationError(
      "The compressed prize data could not be verified.",
    );
  }
  return areBytesEqual(verifiedDataHash, dataHash);
};

const resolveCompressedPrizeCollection = (observation) => {
  if (!observation.collectionMatches) {
    return {
      assetOwner: observation.assetOwner,
      blocked: true,
      message: "The prize collection could not be verified.",
    };
  }
  if (
    !getCompressedPrizeCollectionVerification({
      collectionAddress: observation.collectionAddress,
      creatorHash: observation.creatorHash,
      dataHash: observation.dataHash,
      metadata: createCompressedPrizeMetadata(observation.rpcAsset),
    })
  ) {
    return {
      assetOwner: observation.assetOwner,
      blocked: true,
      message: "The prize collection could not be verified.",
    };
  }
  return null;
};

const validateCompressedPrizeAsset = ({ umi, prize, assetWithProof }) => {
  const observation = parseCompressedPrizeObservation({
    prize,
    rpcAsset: assetWithProof?.rpcAsset,
  });
  validateCompressedPrizeProof({ umi, assetWithProof, observation });
  const collectionResolution = resolveCompressedPrizeCollection(observation);
  if (collectionResolution) return collectionResolution;
  return resolveCompressedPrizeOwnership(observation);
};

const buildCoreTransferBuilder = ({
  umi,
  asset,
  collection,
  recipientAddress,
}) => {
  const { publicKey, transferCore } = loadSolanaDependencies("core");
  return transferCore(umi, {
    asset,
    collection,
    newOwner: publicKey(recipientAddress),
  });
};

const buildCompressedTransferBuilder = ({
  umi,
  assetWithProof,
  recipientAddress,
}) => {
  const { publicKey, transferCompressed } =
    loadSolanaDependencies("compressed");
  return transferCompressed(umi, {
    ...assetWithProof,
    leafOwner: umi.identity,
    leafDelegate: assetWithProof.leafDelegate,
    newLeafOwner: publicKey(recipientAddress),
  });
};

const loadCorePrizeAssetState = async ({ umi, prize, recipientAddress }) => {
  const { fetchAsset, fetchCollection, publicKey } =
    loadSolanaDependencies("core");
  const asset = await fetchAsset(umi, publicKey(prize.assetAddress), {
    commitment: CONFIRMATION_COMMITMENT,
  });
  if (
    asset.publicKey !== prize.assetAddress ||
    asset.updateAuthority.type !== "Collection" ||
    asset.updateAuthority.address !== prize.collectionAddress
  ) {
    return {
      assetOwner: normalizeSolanaAddress(asset.owner),
      blocked: true,
      message: "The prize collection could not be verified.",
    };
  }
  return {
    assetOwner: normalizeSolanaAddress(asset.owner),
    blocked: false,
    buildTransferBuilder: async () => {
      const collection = await fetchCollection(
        umi,
        publicKey(prize.collectionAddress),
        { commitment: CONFIRMATION_COMMITMENT },
      );
      if (collection.publicKey !== prize.collectionAddress) {
        throw createPrizeAssetVerificationError(
          "The prize collection could not be verified.",
        );
      }
      return buildCoreTransferBuilder({
        umi,
        asset,
        collection,
        recipientAddress,
      });
    },
  };
};

const loadCompressedPrizeAssetState = async ({
  umi,
  prize,
  recipientAddress,
}) => {
  const { getAssetWithProof, publicKey } = loadSolanaDependencies("compressed");
  const assetWithProof = await getAssetWithProof(
    umi,
    publicKey(prize.assetAddress),
    { truncateCanopy: true },
  );
  const validation = validateCompressedPrizeAsset({
    umi,
    prize,
    assetWithProof,
  });
  return validation.blocked
    ? validation
    : {
        ...validation,
        buildTransferBuilder: async () =>
          buildCompressedTransferBuilder({
            umi,
            assetWithProof,
            recipientAddress,
          }),
      };
};

const loadCompressedPrizeRecoveryState = async ({ umi, prize }) => {
  const { publicKey } = loadSolanaDependencies("compressed");
  const rpcAsset = await umi.rpc.getAsset({
    assetId: publicKey(prize.assetAddress),
    displayOptions: { showUnverifiedCollections: true },
  });
  const observation = parseCompressedPrizeObservation({ prize, rpcAsset });
  const collectionResolution = resolveCompressedPrizeCollection(observation);
  return collectionResolution || resolveCompressedPrizeOwnership(observation);
};

const loadPrizeAssetState = ({
  umi,
  prize,
  recipientAddress,
  needsTransferBuilder = true,
}) => {
  if (prize.standard === "core") {
    return loadCorePrizeAssetState({ umi, prize, recipientAddress });
  }
  if (prize.standard === "compressed") {
    return needsTransferBuilder
      ? loadCompressedPrizeAssetState({ umi, prize, recipientAddress })
      : loadCompressedPrizeRecoveryState({ umi, prize });
  }
  throw new TypeError("Unsupported event prize standard.");
};

const acquireWithdrawalClaim = async ({
  withdrawalRef,
  eventId,
  prizeId,
  assetAddress,
  profileId,
  place,
  recipientAddress,
  requesterUid,
  canonicalRecordProfileId,
  canonicalRecordSourceProfileId,
}) => {
  const leaseId = crypto.randomBytes(16).toString("hex");
  const decide = (current) =>
    decideWithdrawalClaim({
      current,
      eventId,
      prizeId,
      assetAddress,
      profileId,
      place,
      recipientAddress,
      requesterUid,
      canonicalRecordProfileId,
      canonicalRecordSourceProfileId,
      leaseId,
      nowMs: Date.now(),
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await withdrawalRef.transaction(
      (current) => {
        const decision = decide(current);
        return decision.kind === "acquired"
          ? decision.value
          : (current ?? null);
      },
      undefined,
      false,
    );
    const withdrawal = result.snapshot.val();
    if (
      result.committed &&
      normalizeString(withdrawal?.leaseId) === leaseId &&
      ["processing", "submitted"].includes(withdrawal?.status) &&
      isWithdrawalRecordForPrize(withdrawal, eventId, prizeId, assetAddress)
    ) {
      return { leaseId, withdrawal };
    }
    const decision = decide(withdrawal);
    if (decision?.kind === "acquired") {
      continue;
    }
    if (decision?.kind === "completed") {
      return { completed: decision.value };
    }
    if (decision?.kind === "busy") {
      throw new HttpsError(
        "aborted",
        "This prize withdrawal is already being processed.",
      );
    }
    if (decision?.kind === "destination-mismatch") {
      throw new HttpsError(
        "failed-precondition",
        "The pending withdrawal is locked to its original destination.",
      );
    }
    if (decision?.kind === "blocked") {
      throw new HttpsError(
        "failed-precondition",
        "This prize is unavailable for withdrawal.",
      );
    }
    throw new HttpsError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  throw new HttpsError(
    "aborted",
    "Prize withdrawal changed. Please try again.",
  );
};

const releaseProcessingClaim = async ({ withdrawalRef, leaseId }) => {
  await withdrawalRef.transaction(
    (current) => {
      if (
        current?.status === "processing" &&
        normalizeString(current.leaseId) === leaseId
      ) {
        return null;
      }
      return current ?? null;
    },
    undefined,
    false,
  );
};

const markWithdrawalBlocked = async ({
  withdrawalRef,
  leaseId,
  observedOwner,
}) => {
  await withdrawalRef.transaction(
    (current) => {
      if (
        !current ||
        current.status === "completed" ||
        normalizeString(current.leaseId) !== leaseId
      ) {
        return current ?? null;
      }
      return {
        ...current,
        status: "blocked",
        observedOwner,
        updatedAtMs: Date.now(),
        leaseId: null,
        leaseExpiresAtMs: null,
      };
    },
    undefined,
    false,
  );
};

const persistSubmittedTransaction = async ({
  withdrawalRef,
  leaseId,
  transactionSignature,
  signedTransactionBase64,
  blockhash,
  lastValidBlockHeight,
}) => {
  const result = await withdrawalRef.transaction(
    (current) => {
      if (
        !current ||
        current.status === "completed" ||
        normalizeString(current.leaseId) !== leaseId
      ) {
        return current ?? null;
      }
      return {
        ...current,
        status: "submitted",
        transactionSignature,
        signedTransactionBase64,
        blockhash,
        lastValidBlockHeight,
        submittedAtMs:
          Number.isFinite(current.submittedAtMs) && current.submittedAtMs > 0
            ? Math.floor(current.submittedAtMs)
            : Date.now(),
        updatedAtMs: Date.now(),
      };
    },
    undefined,
    false,
  );
  const persisted = result.snapshot.val();
  if (
    !result.committed ||
    persisted?.status !== "submitted" ||
    normalizeString(persisted.leaseId) !== leaseId ||
    normalizeString(persisted.transactionSignature) !== transactionSignature ||
    normalizeString(persisted.signedTransactionBase64) !==
      signedTransactionBase64 ||
    normalizeString(persisted.blockhash) !== blockhash ||
    Number(persisted.lastValidBlockHeight) !== lastValidBlockHeight
  ) {
    throw new HttpsError(
      "aborted",
      "Prize withdrawal ownership changed. Please try again.",
    );
  }
  return persisted;
};

const discardDefinitiveSubmittedTransaction = async ({
  withdrawalRef,
  leaseId,
  transactionSignature,
}) => {
  const result = await runRtdbDecisionTransaction(withdrawalRef, (current) =>
    current?.status === "submitted" &&
    normalizeString(current.leaseId) === leaseId &&
    normalizeString(current.transactionSignature) === transactionSignature
      ? { value: null, decision: "discarded" }
      : { commit: false, decision: "stale" },
  );
  if (
    !result.committed ||
    result.decision !== "discarded" ||
    result.value !== null
  ) {
    throw new HttpsError(
      "aborted",
      "Prize withdrawal changed. Please try again.",
    );
  }
};

const getCurrentBlockHeight = async (umi) => {
  const blockHeight = await umi.rpc.call("getBlockHeight", [
    { commitment: CONFIRMATION_COMMITMENT },
  ]);
  if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
    throw new Error("Solana RPC returned an invalid block height.");
  }
  return blockHeight;
};

const deserializePersistedSubmittedTransaction = (umi, withdrawal) => {
  const encoded = normalizeString(withdrawal?.signedTransactionBase64);
  const transactionSignature = normalizeString(
    withdrawal?.transactionSignature,
  );
  const blockhash = normalizeString(withdrawal?.blockhash);
  const lastValidBlockHeight = Number(withdrawal?.lastValidBlockHeight);
  if (
    !encoded ||
    !transactionSignature ||
    !blockhash ||
    !Number.isFinite(lastValidBlockHeight)
  ) {
    return null;
  }
  try {
    return {
      signedTransaction: umi.transactions.deserialize(
        new Uint8Array(Buffer.from(encoded, "base64")),
      ),
      transactionSignature,
      blockhash,
      lastValidBlockHeight: Math.floor(lastValidBlockHeight),
    };
  } catch {
    return null;
  }
};

const buildSubmittedTransaction = async ({
  umi,
  builder,
  withdrawalRef,
  leaseId,
}) => {
  const { base58 } = loadSolanaDependencies();
  const latestBlockhash = await umi.rpc.getLatestBlockhash({
    commitment: CONFIRMATION_COMMITMENT,
  });
  const signedTransaction = await builder
    .setBlockhash(latestBlockhash)
    .buildAndSign(umi);
  const simulation = await umi.rpc.simulateTransaction(signedTransaction, {
    commitment: CONFIRMATION_COMMITMENT,
    verifySignatures: true,
  });
  if (simulation.err) {
    throw new HttpsError(
      "failed-precondition",
      "The prize transfer could not be simulated.",
    );
  }
  const transactionSignature = base58.deserialize(
    signedTransaction.signatures[0],
  )[0];
  const signedTransactionBase64 = Buffer.from(
    umi.transactions.serialize(signedTransaction),
  ).toString("base64");
  const persistedWithdrawal = await persistSubmittedTransaction({
    withdrawalRef,
    leaseId,
    transactionSignature,
    signedTransactionBase64,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
  return {
    signedTransaction,
    transactionSignature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    persistedWithdrawal,
  };
};

const waitForPromiseWithTimeout = (
  promise,
  timeoutMs,
  timeoutCode = "rpc-timeout",
) =>
  new Promise((resolve, reject) => {
    const timeoutId = setTimeout(
      () => {
        const error = new Error("Prize transaction RPC timed out.");
        error.code = timeoutCode;
        reject(error);
      },
      Math.max(0, Number(timeoutMs) || 0),
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });

const getSubmittedTransactionSignature = (submitted) => {
  const transactionSignature = submitted?.signedTransaction?.signatures?.[0];
  if (!transactionSignature) {
    throw new HttpsError("internal", "Prize transaction signature is missing.");
  }
  const { base58 } = loadSolanaDependencies();
  const transactionSignatureString =
    base58.deserialize(transactionSignature)[0];
  if (transactionSignatureString !== submitted.transactionSignature) {
    throw new HttpsError("internal", "Prize transaction signature mismatch.");
  }
  return transactionSignature;
};

const readSubmittedTransactionStatus = async ({
  umi,
  transactionSignature,
  statusRequestTimeoutMs = SIGNATURE_STATUS_TIMEOUT_MS,
}) => {
  const [status] = await waitForPromiseWithTimeout(
    umi.rpc.getSignatureStatuses([transactionSignature], {
      searchTransactionHistory: true,
    }),
    statusRequestTimeoutMs,
  );
  if (!status) {
    return { kind: "pending", signatureFound: false };
  }
  if (!["confirmed", "finalized"].includes(status.commitment)) {
    return { kind: "pending", signatureFound: true };
  }
  return status.error != null
    ? { kind: "failed", error: status.error }
    : { kind: "confirmed" };
};

const waitForSubmittedTransactionStatus = async ({
  umi,
  submitted,
  retryDelaysMs = TRANSACTION_STATUS_RETRY_DELAYS_MS,
  statusRequestTimeoutMs = SIGNATURE_STATUS_TIMEOUT_MS,
}) => {
  const transactionSignature = getSubmittedTransactionSignature(submitted);
  let observedStatus = false;
  let signatureFound = false;
  let lastError = null;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const status = await readSubmittedTransactionStatus({
        umi,
        transactionSignature,
        statusRequestTimeoutMs,
      });
      observedStatus = true;
      if (status.kind !== "pending") {
        return status;
      }
      signatureFound ||= status.signatureFound;
    } catch (error) {
      lastError = error;
    }
  }
  return observedStatus
    ? { kind: "pending", signatureFound }
    : { kind: "unknown", error: lastError };
};

const inspectSubmittedWithdrawal = async ({ umi, withdrawal }) => {
  const submitted = deserializePersistedSubmittedTransaction(umi, withdrawal);
  if (!submitted) {
    throw new HttpsError(
      "internal",
      "The submitted prize transaction is unavailable.",
    );
  }
  const status = await waitForSubmittedTransactionStatus({
    umi,
    submitted,
    retryDelaysMs: [0],
  });
  return { submitted, status };
};

const recoverSubmittedWithdrawal = async ({
  umi,
  withdrawal,
  assetOwner,
  recipientAddress,
  inspection,
  statusRetryDelaysMs = TRANSACTION_STATUS_RETRY_DELAYS_MS,
}) => {
  const submittedInspection =
    inspection || (await inspectSubmittedWithdrawal({ umi, withdrawal }));
  const { submitted } = submittedInspection;
  let { status } = submittedInspection;
  if (status.kind === "confirmed") {
    return { kind: "completed", submitted };
  }
  if (status.kind === "failed") {
    return assetOwner === EVENT_PRIZE_ADMIN_WALLET
      ? { kind: "retry", discardPersistedSubmission: true, submitted }
      : { kind: "blocked", submitted };
  }
  if (assetOwner === recipientAddress) {
    return { kind: "completed", submitted };
  }
  if (assetOwner === EVENT_PRIZE_ADMIN_WALLET) {
    if (status.kind === "unknown") {
      throw (
        status.error || new Error("Prize transaction status is unavailable.")
      );
    }
    return { kind: "retry", discardPersistedSubmission: false, submitted };
  }
  const remainingRetryDelaysMs =
    statusRetryDelaysMs[0] === 0
      ? statusRetryDelaysMs.slice(1)
      : statusRetryDelaysMs;
  if (remainingRetryDelaysMs.length > 0) {
    status = await waitForSubmittedTransactionStatus({
      umi,
      submitted,
      retryDelaysMs: remainingRetryDelaysMs,
    });
  }
  if (status.kind === "confirmed") {
    return { kind: "completed", submitted };
  }
  if (status.kind === "failed") {
    return { kind: "blocked", submitted };
  }
  throw status.error || new Error("Prize transaction confirmation is pending.");
};

const reconcileSubmittedAssetState = async ({
  umi,
  withdrawal,
  assetState,
  recipientAddress,
  inspection,
  statusRetryDelaysMs,
}) => {
  const assetOwner = normalizeSolanaAddress(assetState.assetOwner);
  if (!assetOwner) {
    throw createPrizeAssetVerificationError(
      "The prize ownership could not be verified.",
    );
  }
  const submittedInspection =
    inspection || (await inspectSubmittedWithdrawal({ umi, withdrawal }));
  const recovery = await recoverSubmittedWithdrawal({
    umi,
    withdrawal,
    assetOwner,
    recipientAddress,
    inspection: submittedInspection,
    statusRetryDelaysMs,
  });
  if (recovery.kind === "completed" || recovery.kind === "blocked") {
    return { kind: recovery.kind, assetOwner, submitted: recovery.submitted };
  }
  if (recovery.discardPersistedSubmission) {
    return { kind: "discard", assetOwner, submitted: recovery.submitted };
  }
  const currentBlockHeight = await getCurrentBlockHeight(umi);
  if (currentBlockHeight <= recovery.submitted.lastValidBlockHeight) {
    return {
      kind: assetState.blocked ? "retry" : "resume",
      assetOwner,
      submitted: recovery.submitted,
    };
  }
  const finalStatus = await waitForSubmittedTransactionStatus({
    umi,
    submitted: recovery.submitted,
    retryDelaysMs: [0],
  });
  if (finalStatus.kind === "confirmed") {
    return {
      kind: "completed",
      assetOwner,
      submitted: recovery.submitted,
    };
  }
  const signatureRemainsAbsent =
    submittedInspection.status.kind === "pending" &&
    submittedInspection.status.signatureFound === false &&
    finalStatus.kind === "pending" &&
    finalStatus.signatureFound === false;
  return {
    kind:
      finalStatus.kind === "failed" || signatureRemainsAbsent
        ? "discard"
        : "retry",
    assetOwner,
    submitted: recovery.submitted,
  };
};

const sendAndConfirmSubmittedTransaction = async ({
  umi,
  submitted,
  statusRetryDelaysMs,
  confirmationTimeoutMs = CONFIRMATION_TIMEOUT_MS,
  sendTimeoutMs = SEND_TRANSACTION_TIMEOUT_MS,
  statusRequestTimeoutMs = SIGNATURE_STATUS_TIMEOUT_MS,
}) => {
  const transactionSignature = getSubmittedTransactionSignature(submitted);
  const { base58 } = loadSolanaDependencies();
  let sendError = null;
  try {
    const sentSignature = await waitForPromiseWithTimeout(
      umi.rpc.sendTransaction(submitted.signedTransaction, {
        skipPreflight: false,
        preflightCommitment: CONFIRMATION_COMMITMENT,
        maxRetries: 3,
      }),
      sendTimeoutMs,
    );
    const sentSignatureString = base58.deserialize(sentSignature)[0];
    if (sentSignatureString !== submitted.transactionSignature) {
      throw new HttpsError("internal", "Prize transaction signature mismatch.");
    }
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    sendError = error;
  }
  try {
    const confirmation = await waitForPromiseWithTimeout(
      umi.rpc.confirmTransaction(transactionSignature, {
        commitment: CONFIRMATION_COMMITMENT,
        strategy: {
          type: "blockhash",
          blockhash: submitted.blockhash,
          lastValidBlockHeight: submitted.lastValidBlockHeight,
        },
      }),
      confirmationTimeoutMs,
      "confirmation-timeout",
    );
    if (confirmation.value.err) {
      throw new DefinitiveSubmittedTransactionFailure("Prize transfer failed.");
    }
  } catch (error) {
    if (
      error instanceof HttpsError ||
      isDefinitiveSubmittedTransactionFailure(error)
    ) {
      throw error;
    }
    const status = await waitForSubmittedTransactionStatus({
      umi,
      submitted,
      retryDelaysMs: statusRetryDelaysMs,
      statusRequestTimeoutMs,
    });
    if (status.kind === "failed") {
      throw new DefinitiveSubmittedTransactionFailure("Prize transfer failed.");
    }
    if (status.kind !== "confirmed") {
      throw sendError || status.error || error;
    }
    console.info("event-prize-withdrawal-confirmation-reconciled", {
      transactionSignature: submitted.transactionSignature,
    });
  }
  if (sendError) {
    console.info("event-prize-withdrawal-send-reconciled", {
      transactionSignature: submitted.transactionSignature,
    });
  }
};

const reconcileCompletedWithdrawalProjections = async ({
  withdrawal,
  profileIds,
  eventId,
  prizeId,
}) => {
  const knownProfileIds = getWithdrawalProjectionProfileIds({
    withdrawal,
    profileIds,
  });
  const canonicalProfilePaths = await Promise.all(
    knownProfileIds.map(resolveCanonicalProfilePath),
  );
  const projectionProfileIds = getWithdrawalProjectionProfileIds({
    withdrawal,
    profileIds: knownProfileIds.concat(canonicalProfilePaths.flat()),
  });
  await Promise.all(
    projectionProfileIds.map((projectionProfileId) =>
      removeMatchingProfileEventPrizeAssignment({
        targetRef: admin
          .database()
          .ref(`profileEventPrizes/${projectionProfileId}/${eventId}`),
        eventId,
        prizeId,
      }),
    ),
  );
};

const attemptCompletedWithdrawalProjectionReconciliation = async (args) => {
  try {
    await reconcileCompletedWithdrawalProjections(args);
  } catch (error) {
    console.warn("event-prize-withdrawal-projection-cleanup-failed", {
      eventId: args.eventId,
      prizeId: args.prizeId,
      errorType: normalizeString(error?.name) || "Error",
    });
  }
};

const finalizeWithdrawal = async ({
  withdrawal,
  profileId,
  eventId,
  prizeId,
  assetAddress,
  recipientAddress,
  transactionSignature,
}) => {
  const requesterUid = normalizeString(withdrawal.requesterUid);
  if (!requesterUid) {
    throw new HttpsError(
      "failed-precondition",
      "The prize profile could not be verified.",
    );
  }
  let canonicalProfileId = normalizeString(profileId);
  try {
    const canonicalProfileSnapshot = await readProfileByLoginUid(
      requesterUid,
      [],
    );
    canonicalProfileId =
      normalizeString(canonicalProfileSnapshot?.id) || canonicalProfileId;
  } catch {
    console.warn("event-prize-withdrawal-profile-refresh-failed", {
      eventId,
      prizeId,
      profileId: canonicalProfileId,
    });
  }
  if (!canonicalProfileId) {
    throw new HttpsError("internal", "The prize profile is unavailable.");
  }
  const projectionProfileIds = getWithdrawalProjectionProfileIds({
    withdrawal,
    profileIds: [profileId, canonicalProfileId],
  });
  const completedAtMs = Date.now();
  const { completed, updates } = buildWithdrawalCompletionUpdates({
    withdrawal,
    profileId: canonicalProfileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature,
    completedAtMs,
  });
  await admin.database().ref().update(updates);
  await attemptCompletedWithdrawalProjectionReconciliation({
    withdrawal: completed,
    profileIds: projectionProfileIds,
    eventId,
    prizeId,
  });
  return completed;
};

const handleWithdrawEventPrize = async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }
  const requestData =
    request.data && typeof request.data === "object" ? request.data : {};
  const eventId = normalizeString(requestData.eventId);
  const prizeId = normalizeString(requestData.prizeId);
  if (!eventId || !prizeId) {
    throw new HttpsError(
      "invalid-argument",
      "eventId and prizeId are required.",
    );
  }
  const prize = getEventPrizeDefinition(eventId, prizeId);
  const assetAddress = normalizeSolanaAddress(prize?.assetAddress);
  const collectionAddress = normalizeSolanaAddress(prize?.collectionAddress);
  if (
    !prize ||
    prize.claimAvailable !== true ||
    !isEventPrizeStandard(prize.standard) ||
    assetAddress !== normalizeString(prize.assetAddress) ||
    collectionAddress !== normalizeString(prize.collectionAddress)
  ) {
    throw new HttpsError("invalid-argument", "Unsupported event prize.");
  }
  const recipientAddress = normalizeSolanaAddress(requestData.solanaAddress);
  if (!recipientAddress) {
    throw new HttpsError(
      "invalid-argument",
      "A valid Solana address is required.",
    );
  }
  if (recipientAddress === EVENT_PRIZE_ADMIN_WALLET) {
    throw new HttpsError(
      "invalid-argument",
      "Choose a destination other than the prize wallet.",
    );
  }

  const profileSnapshot = await readProfileByLoginUid(request.auth.uid, []);
  const profileId = normalizeString(profileSnapshot?.id);
  if (!profileId) {
    throw new HttpsError("not-found", "profile-not-found");
  }
  const withdrawalRef = admin
    .database()
    .ref(getEventPrizeWithdrawalPath(eventId, prizeId));
  const existingWithdrawalSnapshot = await withdrawalRef.once("value");
  const existingWithdrawal = existingWithdrawalSnapshot.val();
  const existingProfileId = normalizeString(existingWithdrawal?.profileId);
  let canonicalRecordProfileId = existingProfileId;
  let existingRecordOwnedByRequest = isWithdrawalRecordOwnedByRequest(
    existingWithdrawal,
    profileId,
    request.auth.uid,
  );
  if (
    !existingRecordOwnedByRequest &&
    existingProfileId &&
    existingProfileId !== profileId
  ) {
    canonicalRecordProfileId =
      await resolveCanonicalProfileId(existingProfileId);
    existingRecordOwnedByRequest = isWithdrawalRecordOwnedByRequest(
      existingWithdrawal,
      profileId,
      request.auth.uid,
      canonicalRecordProfileId,
      existingProfileId,
    );
  }
  if (isCompletedEventPrizeWithdrawal(existingWithdrawal, eventId, prizeId)) {
    const completedRecipientAddress = normalizeSolanaAddress(
      existingWithdrawal.recipientAddress,
    );
    if (
      !existingRecordOwnedByRequest ||
      !completedRecipientAddress ||
      completedRecipientAddress === EVENT_PRIZE_ADMIN_WALLET
    ) {
      throw new HttpsError(
        "permission-denied",
        "Prize withdrawal is unavailable.",
      );
    }
    await attemptCompletedWithdrawalProjectionReconciliation({
      withdrawal: existingWithdrawal,
      profileIds: [profileId],
      eventId,
      prizeId,
    });
    return buildCompletedResponse(existingWithdrawal);
  }

  const submittedRecordCanResume =
    existingWithdrawal?.status === "submitted" &&
    isWithdrawalRecordForPrize(
      existingWithdrawal,
      eventId,
      prizeId,
      assetAddress,
    ) &&
    existingRecordOwnedByRequest &&
    Boolean(normalizeSolanaAddress(existingWithdrawal.recipientAddress)) &&
    [1, 2, 3].includes(Number(existingWithdrawal.place));
  let place = Number(existingWithdrawal?.place);
  if (!submittedRecordCanResume) {
    const assignmentSnapshot = await admin
      .database()
      .ref(`profileEventPrizes/${profileId}/${eventId}`)
      .once("value");
    const assignment = assignmentSnapshot.val();
    place = validatePrizeAssignment({
      assignment,
      eventId,
      prizeId,
      profileId,
    });
  }
  const claim = await acquireWithdrawalClaim({
    withdrawalRef,
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place,
    recipientAddress,
    requesterUid: request.auth.uid,
    canonicalRecordProfileId,
    canonicalRecordSourceProfileId: existingProfileId,
  });
  if (claim.completed) {
    await attemptCompletedWithdrawalProjectionReconciliation({
      withdrawal: claim.completed,
      profileIds: [profileId],
      eventId,
      prizeId,
    });
    return buildCompletedResponse(claim.completed);
  }

  const { leaseId } = claim;
  let withdrawal = claim.withdrawal;
  let submitted = null;
  const completeWithdrawal = async (transactionSignature) =>
    buildCompletedResponse(
      await finalizeWithdrawal({
        withdrawal,
        profileId,
        eventId,
        prizeId,
        assetAddress,
        recipientAddress,
        transactionSignature,
      }),
    );
  const blockWithdrawal = async (observedOwner, message) => {
    await markWithdrawalBlocked({ withdrawalRef, leaseId, observedOwner });
    throw new HttpsError(
      "failed-precondition",
      message || "This prize is unavailable for withdrawal.",
    );
  };
  try {
    const umi = createEventPrizeUmi(prize.standard);
    let submittedInspection = null;
    if (withdrawal.status === "submitted") {
      submittedInspection = await inspectSubmittedWithdrawal({
        umi,
        withdrawal,
      });
      if (submittedInspection.status.kind === "confirmed") {
        const completedResponse = await completeWithdrawal(
          submittedInspection.submitted.transactionSignature,
        );
        return completedResponse;
      }
    }
    const assetState = await loadPrizeAssetState({
      umi,
      prize,
      recipientAddress,
      needsTransferBuilder: withdrawal.status !== "submitted",
    });
    let assetOwner;
    if (withdrawal.status === "submitted") {
      const resolution = await reconcileSubmittedAssetState({
        umi,
        withdrawal,
        assetState,
        recipientAddress,
        inspection: submittedInspection,
      });
      assetOwner = resolution.assetOwner;
      if (resolution.kind === "completed") {
        const completedResponse = await completeWithdrawal(
          resolution.submitted.transactionSignature,
        );
        return completedResponse;
      }
      if (resolution.kind === "blocked") {
        await blockWithdrawal(assetOwner, assetState.message);
      }
      if (resolution.kind === "discard") {
        await discardDefinitiveSubmittedTransaction({
          withdrawalRef,
          leaseId,
          transactionSignature: resolution.submitted.transactionSignature,
        });
        throw new HttpsError(
          "unavailable",
          "Prize transfer failed. Please try again.",
        );
      }
      if (resolution.kind === "retry") {
        throw new HttpsError(
          "unavailable",
          "Prize withdrawal failed. Please try again.",
        );
      }
      submitted = resolution.submitted;
    } else {
      assetOwner = normalizeSolanaAddress(assetState.assetOwner);
      if (!assetOwner) {
        throw createPrizeAssetVerificationError(
          "The prize ownership could not be verified.",
        );
      }
      if (assetState.blocked) {
        await blockWithdrawal(assetOwner, assetState.message);
      }
      if (assetOwner !== EVENT_PRIZE_ADMIN_WALLET) {
        await blockWithdrawal(assetOwner);
      }
    }

    if (!submitted) {
      submitted = await buildSubmittedTransaction({
        umi,
        builder: await assetState.buildTransferBuilder(),
        withdrawalRef,
        leaseId,
      });
      withdrawal = submitted.persistedWithdrawal;
    }
    await sendAndConfirmSubmittedTransaction({ umi, submitted });
    const completedResponse = await completeWithdrawal(
      submitted.transactionSignature,
    );
    console.info("event-prize-withdrawal-completed", {
      eventId,
      prizeId,
      profileId,
      transactionSignature: submitted.transactionSignature,
    });
    return completedResponse;
  } catch (error) {
    if (submitted && isDefinitiveSubmittedTransactionFailure(error)) {
      try {
        await discardDefinitiveSubmittedTransaction({
          withdrawalRef,
          leaseId,
          transactionSignature: submitted.transactionSignature,
        });
      } catch (discardError) {
        if (discardError instanceof HttpsError) {
          throw discardError;
        }
        console.error("event-prize-withdrawal-discard-failed", {
          eventId,
          prizeId,
          profileId,
          errorType: normalizeString(discardError?.name) || "Error",
        });
        throw new HttpsError(
          "unavailable",
          "Prize withdrawal failed. Please try again.",
        );
      }
      throw new HttpsError(
        "unavailable",
        "Prize transfer failed. Please try again.",
      );
    }
    if (!submitted && withdrawal?.status !== "submitted") {
      await releaseProcessingClaim({ withdrawalRef, leaseId }).catch(() => {});
    }
    if (error instanceof HttpsError) {
      throw error;
    }
    console.error("event-prize-withdrawal-failed", {
      eventId,
      prizeId,
      profileId,
      phase: submitted ? "submitted" : "processing",
      errorType: normalizeString(error?.name) || "Error",
    });
    throw new HttpsError(
      "unavailable",
      "Prize withdrawal failed. Please try again.",
    );
  }
};

const withdrawEventPrize = onCall(
  {
    secrets: [EVENT_PRIZE_ADMIN_PRIVATE_KEY, HELIUS_RPC_API_KEY],
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 3,
    concurrency: 1,
  },
  handleWithdrawEventPrize,
);

module.exports = {
  acquireWithdrawalClaim,
  buildCompressedTransferBuilder,
  buildSubmittedTransaction,
  discardDefinitiveSubmittedTransaction,
  deserializePersistedSubmittedTransaction,
  handleWithdrawEventPrize,
  inspectSubmittedWithdrawal,
  isDefinitiveSubmittedTransactionFailure,
  loadPrizeAssetState,
  loadSolanaDependencies,
  persistSubmittedTransaction,
  reconcileSubmittedAssetState,
  recoverSubmittedWithdrawal,
  reconcileCompletedWithdrawalProjections,
  sendAndConfirmSubmittedTransaction,
  validateCompressedPrizeAsset,
  validatePrizeAssignment,
  waitForSubmittedTransactionStatus,
  withdrawEventPrize,
};
