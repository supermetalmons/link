import type { Umi, TransactionBuilder } from "@metaplex-foundation/umi";
import type {
  AssetWithProof,
  MetadataArgsArgs,
} from "@metaplex-foundation/mpl-bubblegum";
import type {
  DasApiAsset,
  DasApiInterface,
} from "@metaplex-foundation/digital-asset-standard-api";
import type { EventPrizeDefinition } from "@mons/shared/event-prizes";
import type { PrizeAssetState } from "./solanaTypes.js";

import { EventPrizeWithdrawalError as HttpsError } from "./errors.js";
import { normalizeSolanaAddress } from "../eventPrizeWithdrawalState.js";
import { CONFIRMATION_COMMITMENT, loadSolanaDependencies } from "./solana.js";

type CompressedPrizeUmi = Umi & { rpc: DasApiInterface };
type ObservedAsset = DasApiAsset & {
  compression: DasApiAsset["compression"] & {
    collection_hash?: unknown;
    asset_data_hash?: unknown;
    flags?: unknown;
  };
};
type PrizeIdentity = Pick<
  EventPrizeDefinition,
  "assetAddress" | "collectionAddress"
>;
type PrizeAssetInput = {
  umi: Umi;
  prize: EventPrizeDefinition;
  recipientAddress: string;
};

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const isBytes32 = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.length === 32;

const areBytesEqual = (left: unknown, right: unknown): boolean =>
  left instanceof Uint8Array &&
  right instanceof Uint8Array &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const createPrizeAssetVerificationError = (message: string) =>
  new HttpsError("failed-precondition", message);

const parseCompressedPrizeObservation = ({
  prize,
  rpcAsset: rawAsset,
}: {
  prize: PrizeIdentity | null | undefined;
  rpcAsset: unknown;
}) => {
  const rpcAsset = rawAsset as ObservedAsset | null | undefined;
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
    dataHash = base58.serialize(compression!.data_hash);
    creatorHash = base58.serialize(compression!.creator_hash);
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
    rpcAsset!.interface !== "V1_NFT" ||
    compression!.collection_hash != null ||
    compression!.asset_data_hash != null ||
    compression!.flags != null
  ) {
    throw createPrizeAssetVerificationError(
      "The compressed prize format is not supported.",
    );
  }

  const collectionGroups = rpcAsset!.grouping.filter(
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
    compression: compression!,
    compressionTree,
    creatorHash,
    dataHash,
    leafId,
    rpcAsset: rpcAsset!,
  };
};

const resolveCompressedPrizeOwnership = (
  observation: ReturnType<typeof parseCompressedPrizeObservation>,
): PrizeAssetState => {
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

const validateCompressedPrizeProof = ({
  umi,
  assetWithProof: rawProofAsset,
  observation,
}: {
  umi: Umi;
  assetWithProof: unknown;
  observation: ReturnType<typeof parseCompressedPrizeObservation>;
}) => {
  const assetWithProof = rawProofAsset as AssetWithProof;
  const { findLeafAssetIdPda } = loadSolanaDependencies("compressed");
  const { assetOwner, compressionTree, creatorHash, dataHash, leafId } =
    observation;
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

const createCompressedPrizeMetadata = (
  rpcAsset: DasApiAsset,
): Omit<MetadataArgsArgs, "collection"> => {
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
}: {
  collectionAddress: string;
  creatorHash: Uint8Array;
  dataHash: Uint8Array;
  metadata: Omit<MetadataArgsArgs, "collection">;
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

const resolveCompressedPrizeCollection = (
  observation: ReturnType<typeof parseCompressedPrizeObservation>,
): PrizeAssetState | null => {
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
}: {
  umi: Umi;
  prize: PrizeIdentity | null | undefined;
  assetWithProof: unknown;
}): PrizeAssetState => {
  const assetWithProof = rawProofAsset as AssetWithProof | null | undefined;
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
}: {
  umi: Umi;
  asset: Awaited<
    ReturnType<typeof import("@metaplex-foundation/mpl-core").fetchAsset>
  >;
  collection: Awaited<
    ReturnType<typeof import("@metaplex-foundation/mpl-core").fetchCollection>
  >;
  recipientAddress: string;
}): TransactionBuilder => {
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
}: {
  umi: Umi;
  assetWithProof: AssetWithProof;
  recipientAddress: string;
}): TransactionBuilder => {
  const { publicKey, transferCompressed } =
    loadSolanaDependencies("compressed");
  return transferCompressed(umi, {
    ...assetWithProof,
    leafOwner: umi.identity,
    leafDelegate: assetWithProof.leafDelegate,
    newLeafOwner: publicKey(recipientAddress),
  });
};

const loadCorePrizeAssetState = async ({
  umi,
  prize,
  recipientAddress,
}: PrizeAssetInput): Promise<PrizeAssetState> => {
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
}: PrizeAssetInput): Promise<PrizeAssetState> => {
  const { getAssetWithProof, publicKey } = loadSolanaDependencies("compressed");
  const assetWithProof = await getAssetWithProof(
    umi as CompressedPrizeUmi,
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

const loadCompressedPrizeRecoveryState = async ({
  umi,
  prize,
}: Pick<PrizeAssetInput, "umi" | "prize">): Promise<PrizeAssetState> => {
  const { publicKey } = loadSolanaDependencies("compressed");
  const rpcAsset = await (umi as CompressedPrizeUmi).rpc.getAsset({
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
}: PrizeAssetInput & {
  needsTransferBuilder?: boolean;
}): Promise<PrizeAssetState> => {
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

export {
  buildCompressedTransferBuilder,
  createPrizeAssetVerificationError,
  loadPrizeAssetState,
  validateCompressedPrizeAsset,
};
