// Generated from src/eventPrizes/assets.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateCompressedPrizeAsset =
  exports.loadPrizeAssetState =
  exports.createPrizeAssetVerificationError =
  exports.buildCompressedTransferBuilder =
    void 0;
const errors_js_1 = require("./errors.js");
const eventPrizeWithdrawalState_js_1 = require("../eventPrizeWithdrawalState.js");
const solana_js_1 = require("./solana.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const isBytes32 = (value) => value instanceof Uint8Array && value.length === 32;
const areBytesEqual = (left, right) =>
  left instanceof Uint8Array &&
  right instanceof Uint8Array &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
const createPrizeAssetVerificationError = (message) =>
  new errors_js_1.EventPrizeWithdrawalError("failed-precondition", message);
exports.createPrizeAssetVerificationError = createPrizeAssetVerificationError;
const parseCompressedPrizeObservation = ({ prize, rpcAsset: rawAsset }) => {
  const rpcAsset = rawAsset;
  const { base58 } = (0, solana_js_1.loadSolanaDependencies)();
  const assetAddress = normalizeString(prize?.assetAddress);
  const collectionAddress = normalizeString(prize?.collectionAddress);
  const assetOwner = (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
    rpcAsset?.ownership?.owner,
  );
  const compression = rpcAsset?.compression;
  const compressionTree = (0,
  eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(compression?.tree);
  const leafId = Number(compression?.leaf_id);
  if (
    (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(assetAddress) !==
      assetAddress ||
    (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
      collectionAddress,
    ) !== collectionAddress ||
    (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(rpcAsset?.id) !==
      assetAddress ||
    !assetOwner ||
    !Array.isArray(rpcAsset?.grouping) ||
    typeof rpcAsset?.ownership?.frozen !== "boolean" ||
    rpcAsset?.ownership?.ownership_model !== "single" ||
    !compressionTree ||
    compression?.compressed !== true ||
    !(0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
      compression?.data_hash,
    ) ||
    !(0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
      compression?.creator_hash,
    ) ||
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
  const observedCollectionAddress = (0,
  eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
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
    compression: compression,
    compressionTree,
    creatorHash,
    dataHash,
    leafId,
    rpcAsset: rpcAsset,
  };
};
const resolveCompressedPrizeOwnership = (observation) => {
  const { canTransfer } = (0, solana_js_1.loadSolanaDependencies)("compressed");
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
const validateCompressedPrizeProof = ({
  umi,
  assetWithProof: rawProofAsset,
  observation,
}) => {
  const assetWithProof = rawProofAsset;
  const { findLeafAssetIdPda } = (0, solana_js_1.loadSolanaDependencies)(
    "compressed",
  );
  const { assetOwner, compressionTree, creatorHash, dataHash, leafId } =
    observation;
  const rpcAsset = observation.rpcAsset;
  const rpcAssetProof = assetWithProof?.rpcAssetProof;
  const leafDelegate = rpcAsset?.ownership?.delegate;
  const expectedLeafDelegate =
    (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(leafDelegate) ||
    assetOwner;
  const merkleTree = (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
    assetWithProof?.merkleTree,
  );
  const nonce = Number(assetWithProof?.nonce);
  const index = Number(assetWithProof?.index);
  const proof = assetWithProof?.proof;
  const rawProof = rpcAssetProof?.proof;
  const rawNodeIndex = Number(rpcAssetProof?.node_index);
  const leafNodeOffset = Array.isArray(rawProof)
    ? 2 ** rawProof.length
    : Number.NaN;
  if (
    (leafDelegate != null &&
      !(0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
        leafDelegate,
      )) ||
    (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
      assetWithProof?.leafOwner,
    ) !== assetOwner ||
    (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
      assetWithProof?.leafDelegate,
    ) !== expectedLeafDelegate ||
    !merkleTree ||
    (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
      rpcAssetProof?.tree_id,
    ) !== merkleTree ||
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
    proof.some(
      (node) =>
        !(0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(node),
    ) ||
    !Array.isArray(rawProof) ||
    rawProof.some(
      (node) =>
        !(0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(node),
    ) ||
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
  const { TokenProgramVersion, TokenStandard, none, some, wrapNullable } = (0,
  solana_js_1.loadSolanaDependencies)("compressed");
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
  const { hashMetadataCreators, hashMetadataData, publicKey, some } = (0,
  solana_js_1.loadSolanaDependencies)("compressed");
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
const validateCompressedPrizeAsset = ({
  umi,
  prize,
  assetWithProof: rawProofAsset,
}) => {
  const assetWithProof = rawProofAsset;
  const observation = parseCompressedPrizeObservation({
    prize,
    rpcAsset: assetWithProof?.rpcAsset,
  });
  validateCompressedPrizeProof({ umi, assetWithProof, observation });
  const collectionResolution = resolveCompressedPrizeCollection(observation);
  if (collectionResolution) return collectionResolution;
  return resolveCompressedPrizeOwnership(observation);
};
exports.validateCompressedPrizeAsset = validateCompressedPrizeAsset;
const buildCoreTransferBuilder = ({
  umi,
  asset,
  collection,
  recipientAddress,
}) => {
  const { publicKey, transferCore } = (0, solana_js_1.loadSolanaDependencies)(
    "core",
  );
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
  const { publicKey, transferCompressed } = (0,
  solana_js_1.loadSolanaDependencies)("compressed");
  return transferCompressed(umi, {
    ...assetWithProof,
    leafOwner: umi.identity,
    leafDelegate: assetWithProof.leafDelegate,
    newLeafOwner: publicKey(recipientAddress),
  });
};
exports.buildCompressedTransferBuilder = buildCompressedTransferBuilder;
const loadCorePrizeAssetState = async ({ umi, prize, recipientAddress }) => {
  const { fetchAsset, fetchCollection, publicKey } = (0,
  solana_js_1.loadSolanaDependencies)("core");
  const asset = await fetchAsset(umi, publicKey(prize.assetAddress), {
    commitment: solana_js_1.CONFIRMATION_COMMITMENT,
  });
  if (
    asset.publicKey !== prize.assetAddress ||
    asset.updateAuthority.type !== "Collection" ||
    asset.updateAuthority.address !== prize.collectionAddress
  ) {
    return {
      assetOwner: (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
        asset.owner,
      ),
      blocked: true,
      message: "The prize collection could not be verified.",
    };
  }
  return {
    assetOwner: (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
      asset.owner,
    ),
    blocked: false,
    buildTransferBuilder: async () => {
      const collection = await fetchCollection(
        umi,
        publicKey(prize.collectionAddress),
        { commitment: solana_js_1.CONFIRMATION_COMMITMENT },
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
  const { getAssetWithProof, publicKey } = (0,
  solana_js_1.loadSolanaDependencies)("compressed");
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
  const { publicKey } = (0, solana_js_1.loadSolanaDependencies)("compressed");
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
exports.loadPrizeAssetState = loadPrizeAssetState;
