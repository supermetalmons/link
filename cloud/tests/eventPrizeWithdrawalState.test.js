"use strict";

const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const test = require("node:test");
const bs58 = require("bs58");
const requireFunctionDependency = createRequire(
  require.resolve("../functions/package.json"),
);
const { createSignerFromKeypair, none, publicKeyBytes, signerIdentity, some } =
  requireFunctionDependency("@metaplex-foundation/umi");
const {
  publicKey: publicKeySerializer,
  u8,
  u64,
} = requireFunctionDependency("@metaplex-foundation/umi/serializers");
const { createUmi } = requireFunctionDependency(
  "@metaplex-foundation/umi-bundle-defaults",
);
const {
  TokenProgramVersion,
  TokenStandard,
  findLeafAssetIdPda,
  getTransferInstructionDataSerializer,
  hash,
  hashMetadataCreators,
  hashMetadataData,
  mplBubblegum,
} = requireFunctionDependency("@metaplex-foundation/mpl-bubblegum");
const {
  EVENT_PRIZE_ADMIN_WALLET,
  buildWithdrawalCompletionUpdates,
  decodeAdminSecretKey,
  decideWithdrawalClaim,
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
  getWithdrawalProjectionProfileIds,
  isCompletedEventPrizeWithdrawal,
  normalizeSolanaAddress,
} = require("../functions/eventPrizeWithdrawalState");
const {
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
} = require("../functions/eventPrizeWithdrawal");
const {
  copyProfileEventPrizeAssignment,
  removeProfileEventPrizeAssignmentIfWithdrawalCompleted,
  removeMatchingProfileEventPrizeAssignment,
} = require("../functions/profileEventPrizeProjection");
const admin = require("../functions/firebaseAdmin");

const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const assetAddress = getEventPrizeAssetAddress(eventId, prizeId);
const profileId = "profile";
const recipientAddress = "11111111111111111111111111111111";

const generateTestSigner = (umi) =>
  createSignerFromKeypair(umi, umi.eddsa.generateKeypair());

const buildMerkleRootAndProof = (leaves, leafIndex) => {
  const proof = [];
  let nodes = leaves;
  let index = leafIndex;
  while (nodes.length > 1) {
    proof.push(nodes[index ^ 1]);
    const parents = [];
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 2) {
      parents.push(hash([nodes[nodeIndex], nodes[nodeIndex + 1]]));
    }
    nodes = parents;
    index = Math.floor(index / 2);
  }
  return { root: nodes[0], proof };
};

const calculateMerkleRoot = (leaf, proof, leafIndex) => {
  return proof.reduce(
    (node, sibling, depth) =>
      Math.floor(leafIndex / 2 ** depth) % 2 === 0
        ? hash([node, sibling])
        : hash([sibling, node]),
    leaf,
  );
};

const createCompressedPrizeFixture = ({ collectionVerified = true } = {}) => {
  const umi = createUmi("http://127.0.0.1:8899").use(mplBubblegum());
  const owner = generateTestSigner(umi);
  const merkleTree = generateTestSigner(umi).publicKey;
  const collectionAddress = generateTestSigner(umi).publicKey;
  const nonce = 4;
  const [compressedAssetAddress] = findLeafAssetIdPda(umi, {
    merkleTree,
    leafIndex: nonce,
  });
  const metadata = {
    name: "Prize",
    symbol: "",
    uri: "https://example.com/prize.json",
    sellerFeeBasisPoints: 500,
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: none(),
    tokenStandard: some(TokenStandard.NonFungible),
    collection: some({
      key: collectionAddress,
      verified: collectionVerified,
    }),
    uses: none(),
    tokenProgramVersion: TokenProgramVersion.Original,
    creators: [
      {
        address: owner.publicKey,
        verified: true,
        share: 100,
      },
    ],
  };
  const dataHash = hashMetadataData(metadata);
  const creatorHash = hashMetadataCreators(metadata.creators);
  const leaf = hash([
    u8().serialize(1),
    publicKeySerializer().serialize(compressedAssetAddress),
    publicKeySerializer().serialize(owner.publicKey),
    publicKeySerializer().serialize(owner.publicKey),
    u64().serialize(nonce),
    dataHash,
    creatorHash,
  ]);
  const leaves = Array.from({ length: 8 }, () =>
    publicKeyBytes(generateTestSigner(umi).publicKey),
  );
  leaves[nonce] = leaf;
  const merkle = buildMerkleRootAndProof(leaves, nonce);
  const encodeBytes = (value) => bs58.default.encode(value);
  const rootAddress = encodeBytes(merkle.root);
  const dataHashAddress = encodeBytes(dataHash);
  const creatorHashAddress = encodeBytes(creatorHash);
  const proof = merkle.proof.map(encodeBytes);
  umi.use(signerIdentity(owner));
  const assetWithProof = {
    leafOwner: owner.publicKey,
    leafDelegate: owner.publicKey,
    merkleTree,
    root: merkle.root,
    dataHash,
    creatorHash,
    nonce,
    index: nonce,
    proof,
    metadata,
    rpcAsset: {
      id: compressedAssetAddress,
      interface: "V1_NFT",
      content: {
        metadata: { name: metadata.name, symbol: metadata.symbol },
        json_uri: metadata.uri,
      },
      creators: metadata.creators,
      mutable: metadata.isMutable,
      royalty: {
        basis_points: metadata.sellerFeeBasisPoints,
        primary_sale_happened: metadata.primarySaleHappened,
      },
      supply: { edition_nonce: null },
      compression: {
        compressed: true,
        tree: merkleTree,
        leaf_id: nonce,
        data_hash: dataHashAddress,
        creator_hash: creatorHashAddress,
      },
      grouping: [
        {
          group_key: "collection",
          group_value: collectionAddress,
        },
      ],
      ownership: {
        owner: owner.publicKey,
        delegate: null,
        delegated: false,
        frozen: false,
        non_transferable: false,
        ownership_model: "single",
      },
      burnt: false,
    },
    rpcAssetProof: {
      tree_id: merkleTree,
      root: rootAddress,
      proof,
      node_index: nonce + leaves.length,
      leaf: encodeBytes(leaf),
    },
  };
  return {
    umi,
    owner,
    prize: {
      assetAddress: compressedAssetAddress,
      collectionAddress,
      standard: "compressed",
    },
    assetWithProof,
  };
};

const mockProfileMergeTargets = (targets) => () => ({
  collection: () => ({
    doc: (candidateProfileId) => ({
      get: async () => {
        const targetProfileId = targets[candidateProfileId];
        return {
          exists: Boolean(targetProfileId),
          data: () => (targetProfileId ? { targetProfileId } : null),
        };
      },
    }),
  }),
});

const claim = (current, overrides = {}) =>
  decideWithdrawalClaim({
    current,
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "lease-next",
    nowMs: 1000,
    ...overrides,
  });

const createSubmittedTransaction = (transactionSignature, overrides = {}) => ({
  signedTransaction: { signatures: [transactionSignature] },
  transactionSignature: bs58.default.encode(transactionSignature),
  blockhash: "blockhash",
  lastValidBlockHeight: 123,
  ...overrides,
});

const reconcileTestSubmission = ({
  submitted,
  rpc = {},
  assetOwner = EVENT_PRIZE_ADMIN_WALLET,
  blocked = true,
  status = { kind: "pending", signatureFound: false },
}) =>
  reconcileSubmittedAssetState({
    umi: { rpc },
    withdrawal: {},
    assetState: { assetOwner, blocked },
    recipientAddress,
    inspection: { submitted, status },
  });

test("maps every configured prize to its asset address", () => {
  assert.equal(
    getEventPrizeAssetAddress(eventId, "1092"),
    "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
  );
  assert.equal(
    getEventPrizeAssetAddress(eventId, "1111"),
    "8BhUWeckB6432Vnxr6Jg9ve2NN39huPk8PBNL87wQgpL",
  );
  assert.equal(
    getEventPrizeAssetAddress(eventId, "1514"),
    "FxgNuJ47j95kaWEVkPo4QGPfXzF4x5YKLFBSYezyFRRJ",
  );
  assert.equal(getEventPrizeAssetAddress(eventId, "invalid"), "");
  assert.equal(
    getEventPrizeAssetAddress("FRkdorMWaYW", "1866"),
    "2KNT8rbXC7G8w5AChbEHHi6i4FN7EAZCtdWX65ZSuQp6",
  );
  assert.equal(
    getEventPrizeAssetAddress("VOxalSrexcA", "282"),
    "88taYXAaCEmStoLNYiZC6sRSsakDrATpiVtviBTqebxi",
  );
  assert.equal(
    getEventPrizeAssetAddress("VOxalSrexcA", "283"),
    "29e8p9KMcZgaMZmmMseptz3pAdvQwT4hzhvr5C9NxUbu",
  );
  assert.equal(
    getEventPrizeAssetAddress("VOxalSrexcA", "280"),
    "6H1UzLgUm3yW6nzFQVFnsMs3MTRpv5BtyDMfp97XcqqV",
  );
  assert.equal(getEventPrizeAssetStandard("VOxalSrexcA", "282"), "core");
  assert.equal(getEventPrizeAssetStandard("VOxalSrexcA", "283"), "core");
  assert.equal(getEventPrizeAssetStandard("VOxalSrexcA", "280"), "core");
  assert.equal(
    getEventPrizeAssetAddress("oXAceF6anag", "281"),
    "7Bx4AxqugjJUYvR2AS8ggduSEjbf2kMcLP5T6dSVZLP9",
  );
  assert.equal(
    getEventPrizeAssetAddress("oXAceF6anag", "279"),
    "FQhpFRVkJAg2hMoQn62Xo9UjuJuzideuiKB22nbNrQr9",
  );
  assert.equal(
    getEventPrizeAssetAddress("oXAceF6anag", "284"),
    "H7SFR6CSyZYcfpvF4rSoDDfuj2TMiwfqUuyXzS2tLvXa",
  );
  assert.equal(getEventPrizeAssetStandard("oXAceF6anag", "281"), "core");
  assert.equal(getEventPrizeAssetStandard("oXAceF6anag", "279"), "core");
  assert.equal(getEventPrizeAssetStandard("oXAceF6anag", "284"), "core");
});

test("routes claim-enabled Artifact Magazine 3 prizes through destination validation", async () => {
  await assert.rejects(
    handleWithdrawEventPrize({
      auth: { uid: "uid" },
      data: {
        eventId: "VOxalSrexcA",
        prizeId: "282",
      },
    }),
    (error) =>
      error.code === "invalid-argument" &&
      error.message === "A valid Solana address is required.",
  );
});

test("routes claim-enabled second Artifact Magazine 3 prizes through destination validation", async () => {
  await assert.rejects(
    handleWithdrawEventPrize({
      auth: { uid: "uid" },
      data: {
        eventId: "oXAceF6anag",
        prizeId: "281",
      },
    }),
    (error) =>
      error.code === "invalid-argument" &&
      error.message === "A valid Solana address is required.",
  );
});

test("routes claim-enabled compressed prizes through destination validation", async () => {
  await assert.rejects(
    handleWithdrawEventPrize({
      auth: { uid: "uid" },
      data: {
        eventId: "FRkdorMWaYW",
        prizeId: "1866",
      },
    }),
    (error) =>
      error.code === "invalid-argument" &&
      error.message === "A valid Solana address is required.",
  );
});

test("recognizes completed compressed withdrawal records", () => {
  const compressedEventId = "FRkdorMWaYW";
  const compressedPrizeId = "1866";
  const compressedAssetAddress = getEventPrizeAssetAddress(
    compressedEventId,
    compressedPrizeId,
  );
  const completed = {
    status: "completed",
    eventId: compressedEventId,
    prizeId: compressedPrizeId,
    assetAddress: compressedAssetAddress,
    assetStandard: "compressed",
  };
  assert.equal(
    isCompletedEventPrizeWithdrawal(
      completed,
      compressedEventId,
      compressedPrizeId,
    ),
    true,
  );
  assert.deepEqual(
    filterProjectableEventPrizeAssignments({
      eventId: compressedEventId,
      assignments: {
        1: {
          eventId: compressedEventId,
          profileId,
          place: 1,
          prizeId: compressedPrizeId,
        },
      },
      withdrawals: { [compressedPrizeId]: completed },
    }),
    {},
  );
});

test("accepts missing asset standards only for legacy Core records", () => {
  const legacyCoreCompleted = {
    status: "completed",
    eventId,
    prizeId,
    assetAddress,
  };
  assert.equal(
    isCompletedEventPrizeWithdrawal(legacyCoreCompleted, eventId, prizeId),
    true,
  );
  assert.equal(
    isCompletedEventPrizeWithdrawal(
      {
        status: "completed",
        eventId: "FRkdorMWaYW",
        prizeId: "1866",
        assetAddress: getEventPrizeAssetAddress("FRkdorMWaYW", "1866"),
      },
      "FRkdorMWaYW",
      "1866",
    ),
    false,
  );
});

test("records the configured standard on new compressed withdrawals", () => {
  const compressedEventId = "FRkdorMWaYW";
  const compressedPrizeId = "1866";
  const decision = decideWithdrawalClaim({
    current: null,
    eventId: compressedEventId,
    prizeId: compressedPrizeId,
    assetAddress: getEventPrizeAssetAddress(
      compressedEventId,
      compressedPrizeId,
    ),
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "lease",
    nowMs: 1000,
  });
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.assetStandard, "compressed");
});

test("validates a Helius-shaped Bubblegum V1 prize without a grouping verification flag", () => {
  const fixture = createCompressedPrizeFixture();
  assert.equal(
    Object.hasOwn(fixture.assetWithProof.rpcAsset.grouping[0], "verified"),
    false,
  );
  assert.deepEqual(validateCompressedPrizeAsset(fixture), {
    assetOwner: fixture.owner.publicKey,
    blocked: false,
  });
});

test("accepts a fully truncated canopy proof", () => {
  const fixture = createCompressedPrizeFixture();
  fixture.assetWithProof.proof = [];
  assert.deepEqual(validateCompressedPrizeAsset(fixture), {
    assetOwner: fixture.owner.publicKey,
    blocked: false,
  });
});

test("blocks compressed prizes from another collection", () => {
  const fixture = createCompressedPrizeFixture();
  fixture.assetWithProof.rpcAsset.grouping[0].group_value = recipientAddress;
  assert.deepEqual(validateCompressedPrizeAsset(fixture), {
    assetOwner: fixture.owner.publicKey,
    blocked: true,
    message: "The prize collection could not be verified.",
  });
});

test("blocks explicitly unverified compressed prize collections", () => {
  const fixture = createCompressedPrizeFixture({ collectionVerified: false });
  assert.deepEqual(validateCompressedPrizeAsset(fixture), {
    assetOwner: fixture.owner.publicKey,
    blocked: true,
    message: "The prize collection could not be verified.",
  });
});

test("keeps incomplete compressed ownership and collection data retryable", () => {
  for (const update of [
    (asset) => {
      asset.grouping = [];
    },
    (asset) => {
      delete asset.ownership.frozen;
    },
  ]) {
    const fixture = createCompressedPrizeFixture();
    update(fixture.assetWithProof.rpcAsset);
    assert.throws(
      () => validateCompressedPrizeAsset(fixture),
      (error) =>
        error.code === "failed-precondition" &&
        error.message === "The compressed prize data could not be verified.",
    );
  }
});

test("rejects compressed metadata that does not match its leaf hashes", () => {
  for (const update of [
    (assetWithProof) => {
      assetWithProof.rpcAsset.content.json_uri =
        "https://example.com/other.json";
    },
    (assetWithProof) => {
      assetWithProof.rpcAsset.creators[0].share = 99;
    },
  ]) {
    const fixture = createCompressedPrizeFixture();
    update(fixture.assetWithProof);
    assert.throws(
      () => validateCompressedPrizeAsset(fixture),
      (error) =>
        error.code === "failed-precondition" &&
        error.message === "The compressed prize data could not be verified.",
    );
  }
});

test("blocks burnt and permanently non-transferable compressed prizes", () => {
  for (const update of [
    (asset) => {
      asset.burnt = true;
    },
    (asset) => {
      asset.ownership.non_transferable = true;
    },
  ]) {
    const fixture = createCompressedPrizeFixture();
    update(fixture.assetWithProof.rpcAsset);
    assert.equal(validateCompressedPrizeAsset(fixture).blocked, true);
  }
});

test("keeps frozen compressed prizes retryable", () => {
  const fixture = createCompressedPrizeFixture();
  fixture.assetWithProof.rpcAsset.ownership.frozen = true;
  assert.throws(
    () => validateCompressedPrizeAsset(fixture),
    (error) =>
      error.code === "failed-precondition" &&
      error.message === "This prize cannot be withdrawn right now.",
  );
});

test("submitted compressed recovery reads ownership without fetching a proof", async () => {
  const fixture = createCompressedPrizeFixture();
  let assetReadCount = 0;
  let assetRequest;
  const state = await loadPrizeAssetState({
    umi: {
      rpc: {
        getAsset: async (request) => {
          assetReadCount += 1;
          assetRequest = request;
          return fixture.assetWithProof.rpcAsset;
        },
        getAssetProof: async () => {
          throw new Error("proof must not be read");
        },
        getAccount: async () => {
          throw new Error("tree account must not be read");
        },
      },
    },
    prize: fixture.prize,
    recipientAddress,
    needsTransferBuilder: false,
  });

  assert.equal(assetReadCount, 1);
  assert.deepEqual(assetRequest, {
    assetId: fixture.prize.assetAddress,
    displayOptions: { showUnverifiedCollections: true },
  });
  assert.deepEqual(state, {
    assetOwner: fixture.owner.publicKey,
    blocked: false,
  });
});

test("submitted compressed recovery blocks an unverified collection without a proof", async () => {
  const fixture = createCompressedPrizeFixture({ collectionVerified: false });
  const state = await loadPrizeAssetState({
    umi: {
      rpc: {
        getAsset: async () => fixture.assetWithProof.rpcAsset,
        getAssetProof: async () => {
          throw new Error("proof must not be read");
        },
        getAccount: async () => {
          throw new Error("tree account must not be read");
        },
      },
    },
    prize: fixture.prize,
    recipientAddress,
    needsTransferBuilder: false,
  });

  assert.deepEqual(state, {
    assetOwner: fixture.owner.publicKey,
    blocked: true,
    message: "The prize collection could not be verified.",
  });
});

test("rejects Bubblegum V2 and malformed compressed prize proofs", () => {
  const v2Fixture = createCompressedPrizeFixture();
  v2Fixture.assetWithProof.rpcAsset.interface = "V2_NFT";
  v2Fixture.assetWithProof.rpcAsset.compression.asset_data_hash =
    recipientAddress;
  assert.throws(
    () => validateCompressedPrizeAsset(v2Fixture),
    (error) =>
      error.code === "failed-precondition" &&
      error.message === "The compressed prize format is not supported.",
  );

  for (const update of [
    (fixture) => {
      fixture.assetWithProof.rpcAsset.id = recipientAddress;
    },
    (fixture) => {
      fixture.assetWithProof.rpcAssetProof.tree_id = recipientAddress;
    },
    (fixture) => {
      fixture.assetWithProof.proof = [recipientAddress];
    },
    (fixture) => {
      fixture.assetWithProof.leafDelegate = recipientAddress;
    },
    (fixture) => {
      fixture.assetWithProof.rpcAssetProof.node_index += 1;
    },
    (fixture) => {
      fixture.assetWithProof.rpcAsset.compression.data_hash = "invalid";
    },
    (fixture) => {
      fixture.assetWithProof.rpcAsset.compression.creator_hash = "invalid";
    },
    (fixture) => {
      fixture.assetWithProof.dataHash = new Uint8Array(31);
    },
    (fixture) => {
      fixture.assetWithProof.creatorHash = new Uint8Array(31);
    },
  ]) {
    const fixture = createCompressedPrizeFixture();
    update(fixture);
    assert.throws(
      () => validateCompressedPrizeAsset(fixture),
      (error) =>
        error.code === "failed-precondition" &&
        error.message === "The compressed prize data could not be verified.",
    );
  }
});

test("builds compressed transfers with the admin identity as leaf owner", () => {
  const fixture = createCompressedPrizeFixture();
  const destination = generateTestSigner(fixture.umi).publicKey;
  const builder = buildCompressedTransferBuilder({
    umi: fixture.umi,
    assetWithProof: fixture.assetWithProof,
    recipientAddress: destination,
  });
  const [instruction] = builder.getInstructions();
  const [instructionData] = getTransferInstructionDataSerializer().deserialize(
    instruction.data,
  );
  assert.equal(instruction.keys[1].pubkey, fixture.owner.publicKey);
  assert.equal(instruction.keys[1].isSigner, true);
  assert.equal(instruction.keys[2].pubkey, fixture.owner.publicKey);
  assert.equal(instruction.keys[3].pubkey, destination);
  assert.equal(instruction.keys[4].pubkey, fixture.assetWithProof.merkleTree);
  assert.deepEqual(
    instruction.keys.slice(8).map((account) => account.pubkey),
    fixture.assetWithProof.proof,
  );
  assert.deepEqual(instructionData.root, fixture.assetWithProof.root);
  assert.deepEqual(instructionData.dataHash, fixture.assetWithProof.dataHash);
  assert.deepEqual(
    instructionData.creatorHash,
    fixture.assetWithProof.creatorHash,
  );
  assert.equal(instructionData.nonce, BigInt(fixture.assetWithProof.nonce));
  assert.equal(instructionData.index, fixture.assetWithProof.index);
  assert.deepEqual(
    fixture.assetWithProof.root,
    publicKeyBytes(fixture.assetWithProof.rpcAssetProof.root),
  );
  assert.deepEqual(
    fixture.assetWithProof.dataHash,
    publicKeyBytes(fixture.assetWithProof.rpcAsset.compression.data_hash),
  );
  assert.deepEqual(
    fixture.assetWithProof.creatorHash,
    publicKeyBytes(fixture.assetWithProof.rpcAsset.compression.creator_hash),
  );
  assert.equal(
    fixture.assetWithProof.merkleTree,
    fixture.assetWithProof.rpcAssetProof.tree_id,
  );
  assert.equal(
    fixture.assetWithProof.nonce,
    fixture.assetWithProof.rpcAsset.compression.leaf_id,
  );
  assert.equal(fixture.assetWithProof.index, fixture.assetWithProof.nonce);
  assert.deepEqual(
    fixture.assetWithProof.proof,
    fixture.assetWithProof.rpcAssetProof.proof,
  );
  assert.deepEqual(
    calculateMerkleRoot(
      publicKeyBytes(fixture.assetWithProof.rpcAssetProof.leaf),
      fixture.assetWithProof.rpcAssetProof.proof.map((node) =>
        publicKeyBytes(node),
      ),
      fixture.assetWithProof.index,
    ),
    fixture.assetWithProof.root,
  );
  assert.equal(
    builder
      .getSigners(fixture.umi)
      .some((signer) => signer.publicKey === fixture.owner.publicKey),
    true,
  );
});

test("validates Solana addresses and 64-byte base58 secret keys", () => {
  assert.equal(normalizeSolanaAddress(recipientAddress), recipientAddress);
  assert.equal(normalizeSolanaAddress("invalid"), "");
  const secret = new Uint8Array(64).fill(7);
  assert.deepEqual(decodeAdminSecretKey(bs58.default.encode(secret)), secret);
  assert.equal(
    decodeAdminSecretKey(bs58.default.encode(new Uint8Array(32))),
    null,
  );
  assert.notEqual(EVENT_PRIZE_ADMIN_WALLET, recipientAddress);
});

test("acquires a new withdrawal lease", () => {
  const decision = claim(null);
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "processing");
  assert.equal(decision.value.assetStandard, "core");
  assert.equal(decision.value.recipientAddress, recipientAddress);
  assert.equal(decision.value.leaseId, "lease-next");
});

test("rejects concurrent active leases", () => {
  const decision = claim({
    status: "processing",
    eventId,
    prizeId,
    assetAddress,
    profileId: "other-profile",
    place: 1,
    recipientAddress,
    requesterUid: "other-uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: 2000,
  });
  assert.equal(decision.kind, "busy");
});

test("takes over the caller's active processing lease before submission", () => {
  const decision = claim({
    status: "processing",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: 2000,
  });
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "processing");
  assert.equal(decision.value.leaseId, "lease-next");
  assert.equal(decision.value.recipientAddress, recipientAddress);
});

test("reacquires an active submitted withdrawal for idempotent recovery", () => {
  const decision = claim({
    status: "submitted",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: 2000,
    transactionSignature: "signature",
    signedTransactionBase64: "transaction",
    blockhash: "blockhash",
    lastValidBlockHeight: 123,
  });
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "submitted");
  assert.equal(decision.value.leaseId, "lease-next");
  assert.equal(decision.value.transactionSignature, "signature");
  assert.equal(decision.value.signedTransactionBase64, "transaction");
});

test("checks the authoritative claim after a stale local transaction read", async () => {
  const authoritative = {
    status: "processing",
    eventId,
    prizeId,
    assetAddress,
    profileId: "other-profile",
    place: 1,
    recipientAddress,
    requesterUid: "other-uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: Date.now() + 60_000,
  };
  const withdrawalRef = {
    transaction: async (update) => {
      const optimistic = update(null);
      assert.equal(optimistic.status, "processing");
      const unchanged = update(authoritative);
      assert.equal(unchanged, authoritative);
      return {
        committed: true,
        snapshot: { val: () => unchanged },
      };
    },
  };
  await assert.rejects(
    acquireWithdrawalClaim({
      withdrawalRef,
      eventId,
      prizeId,
      assetAddress,
      profileId,
      place: 1,
      recipientAddress,
      requesterUid: "uid",
      canonicalRecordProfileId: profileId,
      canonicalRecordSourceProfileId: profileId,
    }),
    (error) =>
      error.code === "aborted" &&
      error.message === "This prize withdrawal is already being processed.",
  );
});

test("retries acquisition when a busy lease expires after the transaction", async () => {
  const authoritative = {
    status: "processing",
    eventId,
    prizeId,
    assetAddress,
    profileId: "other-profile",
    place: 1,
    recipientAddress,
    requesterUid: "other-uid",
    leaseId: "lease-current",
    leaseExpiresAtMs: Date.now() + 5,
  };
  let transactionCount = 0;
  const withdrawalRef = {
    transaction: async (update) => {
      transactionCount += 1;
      const next = update(authoritative);
      if (transactionCount === 1) {
        assert.equal(next, authoritative);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } else {
        assert.equal(next.status, "processing");
        assert.notEqual(next.leaseId, authoritative.leaseId);
      }
      return {
        committed: true,
        snapshot: { val: () => next },
      };
    },
  };
  const claimResult = await acquireWithdrawalClaim({
    withdrawalRef,
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    canonicalRecordProfileId: profileId,
    canonicalRecordSourceProfileId: profileId,
  });
  assert.equal(transactionCount, 2);
  assert.equal(claimResult.withdrawal.status, "processing");
});

test("persists a submission after refreshing a stale local transaction cache", async () => {
  const authoritative = {
    status: "processing",
    leaseId: "lease",
  };
  const inputs = [];
  const withdrawalRef = {
    transaction: async (update) => {
      inputs.push(null);
      assert.equal(update(null), null);
      inputs.push(authoritative);
      const submitted = update(authoritative);
      return {
        committed: true,
        snapshot: { val: () => submitted },
      };
    },
  };
  const persisted = await persistSubmittedTransaction({
    withdrawalRef,
    leaseId: "lease",
    transactionSignature: "signature",
    signedTransactionBase64: "transaction",
    blockhash: "blockhash",
    lastValidBlockHeight: 123,
  });
  assert.deepEqual(inputs, [null, authoritative]);
  assert.equal(persisted.status, "submitted");
  assert.equal(persisted.transactionSignature, "signature");
});

test("simulates a signed transfer before persisting its submission", async () => {
  const calls = [];
  const signature = new Uint8Array(64).fill(21);
  const signedTransaction = { signatures: [signature] };
  const latestBlockhash = {
    blockhash: "blockhash",
    lastValidBlockHeight: 123,
  };
  const builder = {
    setBlockhash: (value) => {
      calls.push("set-blockhash");
      assert.equal(value, latestBlockhash);
      return builder;
    },
    buildAndSign: async () => {
      calls.push("build-and-sign");
      return signedTransaction;
    },
  };
  const umi = {
    rpc: {
      getLatestBlockhash: async () => {
        calls.push("latest-blockhash");
        return latestBlockhash;
      },
      simulateTransaction: async (value, options) => {
        calls.push("simulate");
        assert.equal(value, signedTransaction);
        assert.equal(options.verifySignatures, true);
        return { err: null };
      },
    },
    transactions: {
      serialize: () => new Uint8Array([1, 2, 3]),
    },
  };
  let current = { status: "processing", leaseId: "lease" };
  const withdrawalRef = {
    transaction: async (update) => {
      calls.push("persist");
      current = update(current);
      return {
        committed: true,
        snapshot: { val: () => current },
      };
    },
  };

  const submitted = await buildSubmittedTransaction({
    umi,
    builder,
    withdrawalRef,
    leaseId: "lease",
  });

  assert.deepEqual(calls, [
    "latest-blockhash",
    "set-blockhash",
    "build-and-sign",
    "simulate",
    "persist",
  ]);
  assert.equal(submitted.transactionSignature, bs58.default.encode(signature));
  assert.equal(submitted.persistedWithdrawal, current);
  assert.equal(current.status, "submitted");
});

test("does not persist a submission after authoritative lease ownership changes", async () => {
  const authoritative = {
    status: "processing",
    leaseId: "another-lease",
  };
  const withdrawalRef = {
    transaction: async (update) => {
      const unchanged = update(authoritative);
      assert.equal(unchanged, authoritative);
      return {
        committed: true,
        snapshot: { val: () => unchanged },
      };
    },
  };
  await assert.rejects(
    persistSubmittedTransaction({
      withdrawalRef,
      leaseId: "lease",
      transactionSignature: "signature",
      signedTransactionBase64: "transaction",
      blockhash: "blockhash",
      lastValidBlockHeight: 123,
    }),
    (error) => error.code === "aborted",
  );
});

test("discards only the exact definitive submitted transaction", async () => {
  let current = {
    status: "submitted",
    leaseId: "lease",
    transactionSignature: "signature",
  };
  const withdrawalRef = {
    transaction: async (update) => {
      current = update(current);
      return {
        committed: true,
        snapshot: { val: () => current },
      };
    },
  };

  await discardDefinitiveSubmittedTransaction({
    withdrawalRef,
    leaseId: "lease",
    transactionSignature: "signature",
  });

  assert.equal(current, null);
  const decision = claim(current);
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "processing");
});

test("checks authoritative state before discarding a submission", async () => {
  const authoritative = {
    status: "submitted",
    leaseId: "lease",
    transactionSignature: "signature",
  };
  const inputs = [];
  const withdrawalRef = {
    transaction: async (update) => {
      inputs.push(null);
      assert.equal(update(null), null);
      inputs.push(authoritative);
      assert.equal(update(authoritative), null);
      return {
        committed: true,
        snapshot: { val: () => null },
      };
    },
  };

  await discardDefinitiveSubmittedTransaction({
    withdrawalRef,
    leaseId: "lease",
    transactionSignature: "signature",
  });
  assert.deepEqual(inputs, [null, authoritative]);
});

test("does not discard a concurrent successor submission", async () => {
  const successor = {
    status: "submitted",
    leaseId: "successor-lease",
    transactionSignature: "successor-signature",
  };
  const withdrawalRef = {
    transaction: async (update) => {
      const next = update(successor);
      assert.equal(next, successor);
      return {
        committed: true,
        snapshot: { val: () => successor },
      };
    },
  };

  await assert.rejects(
    discardDefinitiveSubmittedTransaction({
      withdrawalRef,
      leaseId: "old-lease",
      transactionSignature: "old-signature",
    }),
    (error) => error.code === "aborted",
  );
  assert.equal(successor.transactionSignature, "successor-signature");
});

test("preserves submitted transaction data on an idempotent retry", () => {
  const decision = claim({
    status: "submitted",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    place: 1,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "expired",
    leaseExpiresAtMs: 500,
    startedAtMs: 100,
    transactionSignature: "signature",
    signedTransactionBase64: "transaction",
    blockhash: "blockhash",
    lastValidBlockHeight: 123,
  });
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.status, "submitted");
  assert.equal(decision.value.transactionSignature, "signature");
  assert.equal(decision.value.signedTransactionBase64, "transaction");
  assert.equal(decision.value.startedAtMs, 100);
});

test("migrates a submitted attempt to the caller's current profile", () => {
  const originalProfileId = "profile-before-merge";
  const currentProfileId = "profile-after-merge";
  const decision = claim(
    {
      status: "submitted",
      eventId,
      prizeId,
      assetAddress,
      profileId: originalProfileId,
      place: 1,
      recipientAddress,
      requesterUid: "uid",
      leaseId: "expired",
      leaseExpiresAtMs: 500,
      transactionSignature: "signature",
      signedTransactionBase64: "transaction",
      blockhash: "blockhash",
      lastValidBlockHeight: 123,
    },
    { profileId: currentProfileId },
  );
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.profileId, currentProfileId);
  assert.equal(decision.value.entitledProfileId, originalProfileId);
  assert.equal(decision.value.recipientAddress, recipientAddress);
  assert.equal(decision.value.transactionSignature, "signature");
  assert.equal(decision.value.signedTransactionBase64, "transaction");
  assert.equal(decision.value.blockhash, "blockhash");
  assert.equal(decision.value.lastValidBlockHeight, 123);
});

test("allows canonical profile recovery when the recorded UID changed", () => {
  const originalProfileId = "profile-before-merge";
  const currentProfileId = "profile-after-merge";
  const decision = claim(
    {
      status: "submitted",
      eventId,
      prizeId,
      assetAddress,
      profileId: originalProfileId,
      place: 1,
      recipientAddress,
      requesterUid: "uid-before-merge",
      leaseId: "expired",
      leaseExpiresAtMs: 500,
    },
    {
      profileId: currentProfileId,
      requesterUid: "uid-after-merge",
      canonicalRecordProfileId: currentProfileId,
      canonicalRecordSourceProfileId: originalProfileId,
    },
  );
  assert.equal(decision.kind, "acquired");
  assert.equal(decision.value.profileId, currentProfileId);
  assert.equal(decision.value.entitledProfileId, originalProfileId);
  assert.equal(decision.value.requesterUid, "uid-after-merge");
});

test("does not let a different UID and profile claim a submitted attempt", () => {
  const decision = claim(
    {
      status: "submitted",
      eventId,
      prizeId,
      assetAddress,
      profileId: "profile-before-merge",
      place: 1,
      recipientAddress,
      requesterUid: "uid-before-merge",
      leaseId: "expired",
      leaseExpiresAtMs: 500,
    },
    {
      profileId: "unrelated-profile",
      requesterUid: "unrelated-uid",
      canonicalRecordProfileId: "another-profile",
      canonicalRecordSourceProfileId: "profile-before-merge",
    },
  );
  assert.equal(decision.kind, "forbidden");
});

test("does not recover a submitted record for another prize", () => {
  const decision = claim({
    status: "submitted",
    eventId,
    prizeId: "1111",
    assetAddress: getEventPrizeAssetAddress(eventId, "1111"),
    profileId,
    place: 2,
    recipientAddress,
    requesterUid: "uid",
    leaseId: "expired",
    leaseExpiresAtMs: 500,
  });
  assert.equal(decision.kind, "forbidden");
});

test("locks a submitted withdrawal to its original destination", () => {
  const decision = claim(
    {
      status: "submitted",
      eventId,
      prizeId,
      assetAddress,
      profileId,
      place: 1,
      recipientAddress,
      requesterUid: "uid",
      leaseId: "expired",
      leaseExpiresAtMs: 500,
    },
    { recipientAddress: "SysvarRent111111111111111111111111111111111" },
  );
  assert.equal(decision.kind, "destination-mismatch");
});

test("returns completed withdrawals without acquiring another lease", () => {
  const completed = {
    status: "completed",
    eventId,
    prizeId,
    assetAddress,
    profileId,
    recipientAddress,
    transactionSignature: "signature",
  };
  const decision = claim(completed);
  assert.equal(decision.kind, "completed");
  assert.equal(decision.value, completed);
  assert.equal(
    isCompletedEventPrizeWithdrawal(completed, eventId, prizeId),
    true,
  );
});

test("returns a completed withdrawal after the caller's profile was merged", () => {
  const completed = {
    status: "completed",
    eventId,
    prizeId,
    assetAddress,
    profileId: "profile-before-merge",
    recipientAddress,
    requesterUid: "uid",
    transactionSignature: "signature",
  };
  const decision = claim(completed, { profileId: "profile-after-merge" });
  assert.equal(decision.kind, "completed");
  assert.equal(decision.value, completed);
});

test("filters completed withdrawals out of prize projections", () => {
  const assignments = {
    1: { eventId, profileId, place: 1, prizeId },
    2: { eventId, profileId: "other", place: 2, prizeId: "1111" },
  };
  const projectable = filterProjectableEventPrizeAssignments({
    eventId,
    assignments,
    withdrawals: {
      [prizeId]: {
        status: "completed",
        eventId,
        prizeId,
        assetAddress,
      },
    },
  });
  assert.deepEqual(Object.keys(projectable), ["2"]);
});

test("schedules ended-event cleanup even when no event fields changed", () => {
  const assignments = {
    1: { eventId, profileId, place: 1, prizeId },
  };
  assert.deepEqual(
    getCompletedEventPrizeProjectionCleanupRequest({
      eventId,
      eventStatus: "ended",
      assignments,
      didChange: false,
    }),
    { eventId, assignments },
  );
  assert.equal(
    getCompletedEventPrizeProjectionCleanupRequest({
      eventId,
      eventStatus: "active",
      assignments,
      didChange: true,
    }),
    null,
  );
});

test("requires the entitlement to match the canonical profile and requested prize", () => {
  const assignment = { eventId, prizeId, profileId, place: 1 };
  assert.equal(
    validatePrizeAssignment({ assignment, eventId, prizeId, profileId }),
    1,
  );
  assert.throws(
    () =>
      validatePrizeAssignment({
        assignment,
        eventId,
        prizeId: "1111",
        profileId,
      }),
    (error) => error.code === "not-found",
  );
  assert.throws(
    () =>
      validatePrizeAssignment({
        assignment,
        eventId,
        prizeId,
        profileId: "different-profile",
      }),
    (error) => error.code === "not-found",
  );
});

test("recognizes a confirmed submitted transaction by its stored signature", async () => {
  const transactionSignature = new Uint8Array(64).fill(1);
  let statusReadCount = 0;
  const umi = {
    rpc: {
      getSignatureStatuses: async (signatures, options) => {
        assert.equal(signatures[0], transactionSignature);
        assert.deepEqual(options, { searchTransactionHistory: true });
        statusReadCount += 1;
        return statusReadCount === 1
          ? [null]
          : [
              {
                commitment: "confirmed",
                error: null,
              },
            ];
      },
    },
  };
  const status = await waitForSubmittedTransactionStatus({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    retryDelaysMs: [0, 0],
  });
  assert.equal(status.kind, "confirmed");
  assert.equal(statusReadCount, 2);
});

test("does not treat a processed transaction as failed", async () => {
  const transactionSignature = new Uint8Array(64).fill(6);
  let statusReadCount = 0;
  const umi = {
    rpc: {
      getSignatureStatuses: async () => {
        statusReadCount += 1;
        return [
          {
            commitment: statusReadCount === 1 ? "processed" : "confirmed",
            error: statusReadCount === 1 ? { InstructionError: [0, 1] } : null,
          },
        ];
      },
    },
  };
  const status = await waitForSubmittedTransactionStatus({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    retryDelaysMs: [0, 0],
  });
  assert.equal(status.kind, "confirmed");
  assert.equal(statusReadCount, 2);
});

test("bounds stalled confirmation and reconciles the exact signature", async () => {
  const transactionSignature = new Uint8Array(64).fill(8);
  const umi = {
    rpc: {
      sendTransaction: async () => transactionSignature,
      confirmTransaction: async () => new Promise(() => {}),
      getSignatureStatuses: async () => [
        { commitment: "confirmed", error: null },
      ],
    },
  };
  const startedAtMs = Date.now();
  await sendAndConfirmSubmittedTransaction({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    confirmationTimeoutMs: 1,
    statusRetryDelaysMs: [0],
  });
  assert.ok(Date.now() - startedAtMs < 1000);
});

test("exits a stalled unresolved confirmation before the function deadline", async () => {
  const transactionSignature = new Uint8Array(64).fill(9);
  const umi = {
    rpc: {
      sendTransaction: async () => transactionSignature,
      confirmTransaction: async () => new Promise(() => {}),
      getSignatureStatuses: async () => [null],
    },
  };
  const startedAtMs = Date.now();
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(transactionSignature),
      confirmationTimeoutMs: 1,
      statusRetryDelaysMs: [0],
    }),
    (error) => error.code === "confirmation-timeout",
  );
  assert.ok(Date.now() - startedAtMs < 1000);
});

test("bounds a stalled send before confirming the exact signature", async () => {
  const transactionSignature = new Uint8Array(64).fill(10);
  const umi = {
    rpc: {
      sendTransaction: async () => new Promise(() => {}),
      confirmTransaction: async () => ({ value: { err: null } }),
    },
  };
  const startedAtMs = Date.now();
  await sendAndConfirmSubmittedTransaction({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    sendTimeoutMs: 1,
  });
  assert.ok(Date.now() - startedAtMs < 1000);
});

test("bounds stalled exact-signature status reads", async () => {
  const transactionSignature = new Uint8Array(64).fill(11);
  const startedAtMs = Date.now();
  const status = await waitForSubmittedTransactionStatus({
    umi: {
      rpc: {
        getSignatureStatuses: async () => new Promise(() => {}),
      },
    },
    submitted: createSubmittedTransaction(transactionSignature),
    retryDelaysMs: [0],
    statusRequestTimeoutMs: 1,
  });
  assert.equal(status.kind, "unknown");
  assert.ok(Date.now() - startedAtMs < 1000);
});

test("recovers an ambiguous send error when the signature was confirmed", async () => {
  const sendError = new Error("RPC response was lost");
  const transactionSignature = new Uint8Array(64).fill(2);
  let statusReadCount = 0;
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw sendError;
      },
      confirmTransaction: async (signature, options) => {
        assert.equal(signature, transactionSignature);
        assert.deepEqual(options, {
          commitment: "confirmed",
          strategy: {
            type: "blockhash",
            blockhash: "blockhash",
            lastValidBlockHeight: 123,
          },
        });
        return { value: { err: null } };
      },
      getSignatureStatuses: async () => {
        statusReadCount += 1;
        return [null];
      },
    },
  };
  await sendAndConfirmSubmittedTransaction({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    statusRetryDelaysMs: [0],
  });
  assert.equal(statusReadCount, 0);
});

test("preserves a log-bearing send error when the signature is not confirmed", async () => {
  const sendError = new Error("RPC rejected the request");
  sendError.logs = ["Program failed"];
  const transactionSignature = new Uint8Array(64).fill(3);
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw sendError;
      },
      confirmTransaction: async () => {
        throw new Error("signature was not confirmed");
      },
      getSignatureStatuses: async () => [null],
    },
  };
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(transactionSignature),
      statusRetryDelaysMs: [0],
    }),
    (error) => error === sendError,
  );
});

test("classifies a confirmed on-chain transaction error as definitive", async () => {
  const transactionSignature = new Uint8Array(64).fill(4);
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw new Error("RPC response was lost");
      },
      confirmTransaction: async () => ({
        value: { err: { InstructionError: [0, "Custom"] } },
      }),
      getSignatureStatuses: async () => {
        throw new Error("status fallback should not run");
      },
    },
  };
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(transactionSignature),
      statusRetryDelaysMs: [0],
    }),
    (error) =>
      isDefinitiveSubmittedTransactionFailure(error) &&
      error.message === "Prize transfer failed.",
  );
});

test("reconciles a log-bearing preflight error against the exact signature", async () => {
  const sendError = new Error("preflight failed");
  sendError.logs = ["Program failed"];
  const transactionSignature = new Uint8Array(64).fill(5);
  let confirmationCount = 0;
  let statusReadCount = 0;
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw sendError;
      },
      confirmTransaction: async () => {
        confirmationCount += 1;
        throw new Error("confirmation response was lost");
      },
      getSignatureStatuses: async () => {
        statusReadCount += 1;
        return [{ commitment: "confirmed", error: null }];
      },
    },
  };
  await sendAndConfirmSubmittedTransaction({
    umi,
    submitted: createSubmittedTransaction(transactionSignature),
    statusRetryDelaysMs: [0],
  });
  assert.equal(confirmationCount, 1);
  assert.equal(statusReadCount, 1);
});

test("classifies a failed signature status as definitive", async () => {
  const sendError = new Error("RPC response was lost");
  const transactionSignature = new Uint8Array(64).fill(14);
  const umi = {
    rpc: {
      sendTransaction: async () => {
        throw sendError;
      },
      confirmTransaction: async () => {
        throw new Error("confirmation failed");
      },
      getSignatureStatuses: async () => [
        { commitment: "confirmed", error: { InstructionError: [0, 1] } },
      ],
    },
  };

  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(transactionSignature),
      statusRetryDelaysMs: [0],
    }),
    (error) =>
      isDefinitiveSubmittedTransactionFailure(error) &&
      error.message === "Prize transfer failed.",
  );
});

test("does not classify same-message plain errors as definitive", () => {
  assert.equal(
    isDefinitiveSubmittedTransactionFailure(
      new Error("Prize transfer failed."),
    ),
    false,
  );
  assert.equal(
    isDefinitiveSubmittedTransactionFailure(
      new Error("The prize transfer could not be submitted."),
    ),
    false,
  );
});

test("rejects a stored signature that does not match the signed transaction", async () => {
  let sendCount = 0;
  const umi = {
    rpc: {
      sendTransaction: async () => {
        sendCount += 1;
      },
    },
  };
  await assert.rejects(
    sendAndConfirmSubmittedTransaction({
      umi,
      submitted: createSubmittedTransaction(new Uint8Array(64).fill(7), {
        transactionSignature: "different-signature",
      }),
    }),
    (error) => error.code === "internal",
  );
  assert.equal(sendCount, 0);
});

test("reads an expired persisted signature for completed-transfer recovery", () => {
  const transactionSignature = new Uint8Array(64).fill(10);
  const serialized = new Uint8Array([1, 2, 3]);
  const recovered = deserializePersistedSubmittedTransaction(
    {
      transactions: {
        deserialize: (bytes) => {
          assert.deepEqual(bytes, serialized);
          return { signatures: [transactionSignature] };
        },
      },
    },
    {
      signedTransactionBase64: Buffer.from(serialized).toString("base64"),
      transactionSignature: bs58.default.encode(transactionSignature),
      blockhash: "expired-blockhash",
      lastValidBlockHeight: 1,
    },
  );
  assert.equal(recovered.blockhash, "expired-blockhash");
  assert.equal(recovered.lastValidBlockHeight, 1);
  assert.equal(
    recovered.transactionSignature,
    bs58.default.encode(transactionSignature),
  );
});

test("inspects a persisted submitted signature once", async () => {
  const transactionSignature = new Uint8Array(64).fill(15);
  let statusReadCount = 0;
  const inspection = await inspectSubmittedWithdrawal({
    umi: {
      transactions: {
        deserialize: () => ({ signatures: [transactionSignature] }),
      },
      rpc: {
        getSignatureStatuses: async () => {
          statusReadCount += 1;
          return [{ commitment: "confirmed", error: null }];
        },
      },
    },
    withdrawal: {
      signedTransactionBase64: Buffer.from([9]).toString("base64"),
      transactionSignature: bs58.default.encode(transactionSignature),
      blockhash: "blockhash",
      lastValidBlockHeight: 123,
    },
  });

  assert.equal(inspection.status.kind, "confirmed");
  assert.equal(
    inspection.submitted.transactionSignature,
    bs58.default.encode(transactionSignature),
  );
  assert.equal(statusReadCount, 1);
});

test("a definitively failed signature never completes from recipient ownership", async () => {
  const transactionSignature = new Uint8Array(64).fill(16);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    rpc: {
      getSignatureStatuses: async () => {
        throw new Error("the inspected status must be reused");
      },
    },
    assetOwner: recipientAddress,
    status: { kind: "failed", error: { InstructionError: [0, 1] } },
  });

  assert.deepEqual(resolution, {
    kind: "blocked",
    assetOwner: recipientAddress,
    submitted,
  });
});

test("recipient ownership completes an ambiguous submitted transfer", async () => {
  const transactionSignature = new Uint8Array(64).fill(26);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    assetOwner: recipientAddress,
  });

  assert.deepEqual(resolution, {
    kind: "completed",
    assetOwner: recipientAddress,
    submitted,
  });
});

test("failed submissions rebuild only while the admin still owns the prize", async () => {
  const transactionSignature = new Uint8Array(64).fill(17);
  const submitted = createSubmittedTransaction(transactionSignature);
  const base = {
    umi: {},
    withdrawal: {},
    recipientAddress,
    inspection: {
      submitted,
      status: { kind: "failed", error: { InstructionError: [0, 1] } },
    },
  };

  assert.deepEqual(
    await recoverSubmittedWithdrawal({
      ...base,
      assetOwner: EVENT_PRIZE_ADMIN_WALLET,
    }),
    { kind: "retry", discardPersistedSubmission: true, submitted },
  );
  assert.deepEqual(
    await recoverSubmittedWithdrawal({
      ...base,
      assetOwner: "11111111111111111111111111111112",
    }),
    { kind: "blocked", submitted },
  );
});

test("recovers a confirmed submitted transfer despite a blocked current state", async () => {
  const transactionSignature = new Uint8Array(64).fill(11);
  const serialized = new Uint8Array([4, 5, 6]);
  let statusReadCount = 0;
  const resolution = await reconcileSubmittedAssetState({
    umi: {
      transactions: {
        deserialize: () => ({ signatures: [transactionSignature] }),
      },
      rpc: {
        getSignatureStatuses: async () => {
          statusReadCount += 1;
          return [{ commitment: "finalized", error: null }];
        },
      },
    },
    withdrawal: {
      signedTransactionBase64: Buffer.from(serialized).toString("base64"),
      transactionSignature: bs58.default.encode(transactionSignature),
      blockhash: "expired-blockhash",
      lastValidBlockHeight: 1,
    },
    assetState: {
      assetOwner: "11111111111111111111111111111112",
      blocked: true,
    },
    recipientAddress,
    statusRetryDelaysMs: [0],
  });
  assert.equal(resolution.kind, "completed");
  assert.equal(
    resolution.submitted.transactionSignature,
    bs58.default.encode(transactionSignature),
  );
  assert.equal(Object.hasOwn(resolution, "recovery"), false);
  assert.equal(statusReadCount, 1);
});

test("keeps a blocked submitted withdrawal retryable while status is pending", async () => {
  const transactionSignature = new Uint8Array(64).fill(18);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    rpc: {
      call: async () => submitted.lastValidBlockHeight,
    },
  });

  assert.deepEqual(resolution, {
    kind: "retry",
    assetOwner: EVENT_PRIZE_ADMIN_WALLET,
    submitted,
  });
});

test("resumes the exact submitted transaction while its blockhash is valid", async () => {
  const transactionSignature = new Uint8Array(64).fill(23);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    rpc: {
      call: async () => submitted.lastValidBlockHeight,
    },
    blocked: false,
  });

  assert.deepEqual(resolution, {
    kind: "resume",
    assetOwner: EVENT_PRIZE_ADMIN_WALLET,
    submitted,
  });
});

test("discards an expired submitted transaction when the current state is blocked", async () => {
  const transactionSignature = new Uint8Array(64).fill(19);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    rpc: {
      call: async () => submitted.lastValidBlockHeight + 1,
      getSignatureStatuses: async () => [null],
    },
  });

  assert.deepEqual(resolution, {
    kind: "discard",
    assetOwner: EVENT_PRIZE_ADMIN_WALLET,
    submitted,
  });
});

test("preserves an expired submission when its exact signature was processed", async () => {
  const transactionSignature = new Uint8Array(64).fill(20);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    rpc: {
      call: async () => submitted.lastValidBlockHeight + 1,
      getSignatureStatuses: async () => [
        { commitment: "processed", error: null },
      ],
    },
  });

  assert.equal(resolution.kind, "retry");
  assert.equal(resolution.submitted, submitted);
});

test("preserves an expired processed submission on the transferable path", async () => {
  const transactionSignature = new Uint8Array(64).fill(24);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    rpc: {
      call: async () => submitted.lastValidBlockHeight + 1,
      getSignatureStatuses: async () => [
        { commitment: "processed", error: null },
      ],
    },
    blocked: false,
    status: { kind: "pending", signatureFound: true },
  });

  assert.equal(resolution.kind, "retry");
  assert.equal(resolution.submitted, submitted);
});

test("completes an expired submission confirmed during final reconciliation", async () => {
  const transactionSignature = new Uint8Array(64).fill(21);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    rpc: {
      call: async () => submitted.lastValidBlockHeight + 1,
      getSignatureStatuses: async () => [
        { commitment: "confirmed", error: null },
      ],
    },
  });

  assert.deepEqual(resolution, {
    kind: "completed",
    assetOwner: EVENT_PRIZE_ADMIN_WALLET,
    submitted,
  });
});

test("completes a transferable submission confirmed during expiry reconciliation", async () => {
  const transactionSignature = new Uint8Array(64).fill(25);
  const submitted = createSubmittedTransaction(transactionSignature);
  const resolution = await reconcileTestSubmission({
    submitted,
    rpc: {
      call: async () => submitted.lastValidBlockHeight + 1,
      getSignatureStatuses: async () => [
        { commitment: "confirmed", error: null },
      ],
    },
    blocked: false,
  });

  assert.deepEqual(resolution, {
    kind: "completed",
    assetOwner: EVENT_PRIZE_ADMIN_WALLET,
    submitted,
  });
});

test("keeps submitted recovery retryable after an invalid block height response", async () => {
  const transactionSignature = new Uint8Array(64).fill(22);
  const submitted = createSubmittedTransaction(transactionSignature);
  await assert.rejects(
    reconcileTestSubmission({
      submitted,
      rpc: {
        call: async () => undefined,
        getSignatureStatuses: async () => {
          throw new Error("status must not be read after an invalid height");
        },
      },
    }),
    (error) => error.message === "Solana RPC returned an invalid block height.",
  );
});

test("keeps a blocked submitted withdrawal retryable when status is unavailable", async () => {
  const transactionSignature = new Uint8Array(64).fill(12);
  const statusError = new Error("RPC unavailable");
  let statusReadCount = 0;
  await assert.rejects(
    reconcileSubmittedAssetState({
      umi: {
        transactions: {
          deserialize: () => ({ signatures: [transactionSignature] }),
        },
        rpc: {
          getSignatureStatuses: async () => {
            statusReadCount += 1;
            throw statusError;
          },
        },
      },
      withdrawal: {
        signedTransactionBase64: Buffer.from([7]).toString("base64"),
        transactionSignature: bs58.default.encode(transactionSignature),
        blockhash: "blockhash",
        lastValidBlockHeight: 123,
      },
      assetState: {
        assetOwner: "11111111111111111111111111111112",
        blocked: true,
      },
      recipientAddress,
      statusRetryDelaysMs: [0],
    }),
    (error) => error === statusError,
  );
  assert.equal(statusReadCount, 1);
});

test("rejects a mismatched persisted signature before reading its status", async () => {
  let statusReadCount = 0;
  await assert.rejects(
    recoverSubmittedWithdrawal({
      umi: {
        transactions: {
          deserialize: () => ({ signatures: [new Uint8Array(64).fill(13)] }),
        },
        rpc: {
          getSignatureStatuses: async () => {
            statusReadCount += 1;
            return [null];
          },
        },
      },
      withdrawal: {
        signedTransactionBase64: Buffer.from([8]).toString("base64"),
        transactionSignature: "different-signature",
        blockhash: "blockhash",
        lastValidBlockHeight: 123,
      },
      assetOwner: EVENT_PRIZE_ADMIN_WALLET,
      recipientAddress,
      statusRetryDelaysMs: [0],
    }),
    (error) => error.code === "internal",
  );
  assert.equal(statusReadCount, 0);
});

test("completion records the canonical profile and retains event history", () => {
  const originalProfileId = "profile-before-merge";
  const currentProfileId = "profile-after-merge";
  const result = buildWithdrawalCompletionUpdates({
    withdrawal: {
      profileId: originalProfileId,
      entitledProfileId: originalProfileId,
      place: 1,
      requesterUid: "uid",
      startedAtMs: 10,
      submittedAtMs: 20,
    },
    profileId: currentProfileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature: "signature",
    completedAtMs: 30,
  });
  assert.equal(result.completed.status, "completed");
  assert.equal(result.completed.assetStandard, "core");
  assert.equal(result.completed.profileId, currentProfileId);
  assert.equal(result.completed.entitledProfileId, originalProfileId);
  assert.equal(
    result.updates[`eventPrizeWithdrawals/${eventId}/${prizeId}`],
    result.completed,
  );
  assert.equal(
    Object.keys(result.updates).some(
      (path) =>
        path.startsWith("profileEventPrizes/") ||
        path.startsWith(`events/${eventId}/prizeAssignments`),
    ),
    false,
  );
});

test("completion marker updates never delete profile projections directly", () => {
  const result = buildWithdrawalCompletionUpdates({
    withdrawal: {
      profileId,
      entitledProfileId: profileId,
      place: 1,
      requesterUid: "uid",
    },
    profileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature: "signature",
    completedAtMs: 30,
  });
  assert.equal(
    Object.keys(result.updates).some((path) =>
      path.startsWith("profileEventPrizes/"),
    ),
    false,
  );
});

test("completion reconciliation includes every known profile exactly once", () => {
  assert.deepEqual(
    getWithdrawalProjectionProfileIds({
      withdrawal: {
        profileId: "profile-before-merge",
        entitledProfileId: "profile-before-merge",
      },
      profileIds: ["profile-after-merge", "profile-before-merge", ""],
    }),
    ["profile-before-merge", "profile-after-merge"],
  );
});

test("completed retries reconcile old and current profile projections", async (t) => {
  const originalDatabase = admin.database;
  const originalFirestore = admin.firestore;
  t.after(() => {
    admin.database = originalDatabase;
    admin.firestore = originalFirestore;
  });
  const originalProfileId = "profile-before-merge";
  const currentProfileId = "profile-after-merge";
  const assignments = new Map([
    [
      `profileEventPrizes/${originalProfileId}/${eventId}`,
      { eventId, prizeId, profileId: originalProfileId, place: 1 },
    ],
    [
      `profileEventPrizes/${currentProfileId}/${eventId}`,
      { eventId, prizeId, profileId: currentProfileId, place: 1 },
    ],
  ]);
  admin.database = () => ({
    ref: (path) => ({
      transaction: async (update) => {
        const next = update(assignments.get(path) ?? null);
        if (next === undefined) {
          return { committed: false };
        }
        assignments.set(path, next);
        return {
          committed: true,
          snapshot: { val: () => next },
        };
      },
    }),
  });
  admin.firestore = mockProfileMergeTargets({
    [originalProfileId]: currentProfileId,
  });

  const withdrawal = {
    profileId: originalProfileId,
    entitledProfileId: originalProfileId,
  };
  await reconcileCompletedWithdrawalProjections({
    withdrawal,
    profileIds: [currentProfileId],
    eventId,
    prizeId,
  });
  await reconcileCompletedWithdrawalProjections({
    withdrawal,
    profileIds: [currentProfileId],
    eventId,
    prizeId,
  });

  assert.equal(
    assignments.get(`profileEventPrizes/${originalProfileId}/${eventId}`),
    null,
  );
  assert.equal(
    assignments.get(`profileEventPrizes/${currentProfileId}/${eventId}`),
    null,
  );
});

test("completed reconciliation cleans every profile in a merge chain", async (t) => {
  const originalDatabase = admin.database;
  const originalFirestore = admin.firestore;
  t.after(() => {
    admin.database = originalDatabase;
    admin.firestore = originalFirestore;
  });
  const sourceProfileId = "profile-source";
  const middleProfileId = "profile-middle";
  const targetProfileId = "profile-target";
  const profileIds = [sourceProfileId, middleProfileId, targetProfileId];
  const assignments = new Map(
    profileIds.map((candidateProfileId) => [
      `profileEventPrizes/${candidateProfileId}/${eventId}`,
      { eventId, prizeId, profileId: candidateProfileId, place: 1 },
    ]),
  );
  admin.firestore = mockProfileMergeTargets({
    [sourceProfileId]: middleProfileId,
    [middleProfileId]: targetProfileId,
  });
  admin.database = () => ({
    ref: (path) => ({
      transaction: async (update) => {
        const next = update(assignments.get(path) ?? null);
        assignments.set(path, next);
        return {
          committed: true,
          snapshot: { val: () => next },
        };
      },
    }),
  });

  await reconcileCompletedWithdrawalProjections({
    withdrawal: {
      profileId: targetProfileId,
      entitledProfileId: sourceProfileId,
    },
    profileIds: [],
    eventId,
    prizeId,
  });

  profileIds.forEach((candidateProfileId) => {
    assert.equal(
      assignments.get(`profileEventPrizes/${candidateProfileId}/${eventId}`),
      null,
    );
  });
});

test("projection cleanup failures remain retryable", async (t) => {
  const originalDatabase = admin.database;
  const originalFirestore = admin.firestore;
  t.after(() => {
    admin.database = originalDatabase;
    admin.firestore = originalFirestore;
  });
  admin.firestore = mockProfileMergeTargets({});
  admin.database = () => ({
    ref: () => ({
      transaction: async () => {
        throw new Error("database unavailable");
      },
    }),
  });

  await assert.rejects(
    reconcileCompletedWithdrawalProjections({
      withdrawal: { profileId },
      profileIds: [],
      eventId,
      prizeId,
    }),
    /database unavailable/,
  );
});

test("a late profile projection removes itself after withdrawal completion", async (t) => {
  const originalDatabase = admin.database;
  t.after(() => {
    admin.database = originalDatabase;
  });
  const assignment = { eventId, prizeId, profileId, place: 1 };
  let currentAssignment = assignment;
  admin.database = () => ({
    ref: (path) => {
      if (path === `eventPrizeWithdrawals/${eventId}/${prizeId}`) {
        return {
          once: async () => ({
            val: () => ({
              status: "completed",
              eventId,
              prizeId,
              assetAddress,
            }),
          }),
        };
      }
      assert.equal(path, `profileEventPrizes/${profileId}/${eventId}`);
      return {
        transaction: async (update) => {
          currentAssignment = update(currentAssignment);
          return {
            committed: true,
            snapshot: { val: () => currentAssignment },
          };
        },
      };
    },
  });

  assert.equal(
    await removeProfileEventPrizeAssignmentIfWithdrawalCompleted({
      profileId,
      eventId,
      assignment,
    }),
    true,
  );
  assert.equal(currentAssignment, null);
});

test("late cleanup preserves a newer assignment for another prize", async (t) => {
  const originalDatabase = admin.database;
  t.after(() => {
    admin.database = originalDatabase;
  });
  const completedAssignment = { eventId, prizeId, profileId, place: 1 };
  const currentAssignment = {
    eventId,
    prizeId: "1111",
    profileId,
    place: 2,
  };
  let storedAssignment = currentAssignment;
  admin.database = () => ({
    ref: (path) => {
      if (path === `eventPrizeWithdrawals/${eventId}/${prizeId}`) {
        return {
          once: async () => ({
            val: () => ({
              status: "completed",
              eventId,
              prizeId,
              assetAddress,
            }),
          }),
        };
      }
      return {
        transaction: async (update) => {
          storedAssignment = update(storedAssignment);
          return {
            committed: true,
            snapshot: { val: () => storedAssignment },
          };
        },
      };
    },
  });

  assert.equal(
    await removeProfileEventPrizeAssignmentIfWithdrawalCompleted({
      profileId,
      eventId,
      assignment: completedAssignment,
    }),
    true,
  );
  assert.deepEqual(storedAssignment, currentAssignment);
});

test("merge cleanup rechecks completion after an uncommitted copy", async (t) => {
  const originalDatabase = admin.database;
  t.after(() => {
    admin.database = originalDatabase;
  });
  const sourceProfileId = "profile-before-merge";
  const targetProfileId = "profile-after-merge";
  const targetPath = `profileEventPrizes/${targetProfileId}/${eventId}`;
  const withdrawalPath = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
  let markerReadCount = 0;
  let targetAssignment = {
    eventId,
    prizeId,
    profileId: targetProfileId,
    place: 1,
    assignedAtMs: 10,
  };
  admin.database = () => ({
    ref: (path) => {
      if (path === withdrawalPath) {
        return {
          once: async () => ({
            val: () => {
              markerReadCount += 1;
              return markerReadCount === 1
                ? { status: "submitted" }
                : { status: "completed", eventId, prizeId, assetAddress };
            },
          }),
        };
      }
      assert.equal(path, targetPath);
      return {
        transaction: async (update) => {
          const next = update(targetAssignment);
          if (next === undefined) {
            return { committed: false };
          }
          targetAssignment = next;
          return {
            committed: true,
            snapshot: { val: () => next },
          };
        },
      };
    },
  });

  const copied = await copyProfileEventPrizeAssignment({
    sourceProfileId,
    targetProfileId,
    eventId,
    sourceAssignment: {
      eventId,
      prizeId,
      profileId: sourceProfileId,
      place: 1,
      assignedAtMs: 10,
    },
  });

  assert.equal(copied, false);
  assert.equal(markerReadCount, 2);
  assert.equal(targetAssignment, null);
});

test("completed merge cleanup removes only the matching target projection", async () => {
  let currentAssignment = { eventId, prizeId, profileId, place: 1 };
  const targetRef = {
    transaction: async (update) => {
      const next = update(currentAssignment);
      if (next === undefined) {
        return { committed: false };
      }
      currentAssignment = next;
      return {
        committed: true,
        snapshot: { val: () => next },
      };
    },
  };
  assert.equal(
    await removeMatchingProfileEventPrizeAssignment({
      targetRef,
      eventId,
      prizeId,
    }),
    true,
  );
  assert.equal(currentAssignment, null);

  currentAssignment = {
    eventId: "another-event",
    prizeId,
    profileId,
    place: 1,
  };
  assert.equal(
    await removeMatchingProfileEventPrizeAssignment({
      targetRef,
      eventId,
      prizeId,
    }),
    false,
  );
  assert.deepEqual(currentAssignment, {
    eventId: "another-event",
    prizeId,
    profileId,
    place: 1,
  });
});

test("removes a completed prize projection after a stale local read", async () => {
  const authoritative = { eventId, prizeId, profileId, place: 1 };
  const inputs = [];
  const targetRef = {
    transaction: async (update) => {
      inputs.push(null);
      assert.equal(update(null), null);
      inputs.push(authoritative);
      const removed = update(authoritative);
      return {
        committed: true,
        snapshot: { val: () => removed },
      };
    },
  };
  assert.equal(
    await removeMatchingProfileEventPrizeAssignment({
      targetRef,
      eventId,
      prizeId,
    }),
    true,
  );
  assert.deepEqual(inputs, [null, authoritative]);
});
