"use strict";

const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("./firebaseAdmin");
const { PRIZES_EVENT_ID } = require("./eventPrizeAwards");
const { HELIUS_RPC_API_KEY, getHeliusRpcUrl } = require("./heliusRpc");
const { readProfileByLoginUid } = require("./profileLookup");
const {
  removeMatchingProfileEventPrizeAssignment,
  resolveCanonicalProfileId,
} = require("./profileEventPrizeProjection");
const {
  EVENT_PRIZE_ADMIN_WALLET,
  EVENT_PRIZE_COLLECTION_ADDRESS,
  buildWithdrawalCompletionUpdates,
  decodeAdminSecretKey,
  decideWithdrawalClaim,
  getEventPrizeAssetAddress,
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
let solanaDependencies = null;

const loadSolanaDependencies = () => {
  if (!solanaDependencies) {
    const {
      fetchAsset,
      fetchCollection,
      mplCore,
      transfer,
    } = require("@metaplex-foundation/mpl-core");
    const {
      base58,
      createSignerFromKeypair,
      publicKey,
      signerIdentity,
    } = require("@metaplex-foundation/umi");
    const { createUmi } = require("@metaplex-foundation/umi-bundle-defaults");
    solanaDependencies = {
      base58,
      createSignerFromKeypair,
      createUmi,
      fetchAsset,
      fetchCollection,
      mplCore,
      publicKey,
      signerIdentity,
      transfer,
    };
  }
  return solanaDependencies;
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

const createEventPrizeUmi = () => {
  const { createSignerFromKeypair, createUmi, mplCore, signerIdentity } =
    loadSolanaDependencies();
  const secretKey = decodeAdminSecretKey(EVENT_PRIZE_ADMIN_PRIVATE_KEY.value());
  if (!secretKey) {
    throw new HttpsError(
      "failed-precondition",
      "The event prize wallet is not configured.",
    );
  }
  const umi = createUmi(getRpcUrl(), {
    commitment: CONFIRMATION_COMMITMENT,
  }).use(mplCore());
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
  let decision = null;
  const result = await withdrawalRef.transaction(
    (current) => {
      decision = decideWithdrawalClaim({
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
      return decision.kind === "acquired" ? decision.value : undefined;
    },
    undefined,
    false,
  );
  if (result.committed) {
    return { leaseId, withdrawal: result.snapshot.val() };
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
  throw new HttpsError("permission-denied", "Prize withdrawal is unavailable.");
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
      return undefined;
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
        return undefined;
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
        return undefined;
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
  if (!result.committed) {
    throw new HttpsError(
      "aborted",
      "Prize withdrawal ownership changed. Please try again.",
    );
  }
  return result.snapshot.val();
};

const getCurrentBlockHeight = async (umi) => {
  const blockHeight = await umi.rpc.call("getBlockHeight", [
    { commitment: CONFIRMATION_COMMITMENT },
  ]);
  const numeric = Number(blockHeight);
  return Number.isFinite(numeric)
    ? Math.floor(numeric)
    : Number.MAX_SAFE_INTEGER;
};

const deserializeSubmittedTransaction = async (umi, withdrawal) => {
  const encoded = normalizeString(withdrawal?.signedTransactionBase64);
  const lastValidBlockHeight = Number(withdrawal?.lastValidBlockHeight);
  if (!encoded || !Number.isFinite(lastValidBlockHeight)) {
    return null;
  }
  if ((await getCurrentBlockHeight(umi)) > lastValidBlockHeight) {
    return null;
  }
  try {
    return {
      signedTransaction: umi.transactions.deserialize(
        new Uint8Array(Buffer.from(encoded, "base64")),
      ),
      transactionSignature: normalizeString(withdrawal.transactionSignature),
      blockhash: normalizeString(withdrawal.blockhash),
      lastValidBlockHeight: Math.floor(lastValidBlockHeight),
    };
  } catch {
    return null;
  }
};

const buildSubmittedTransaction = async ({
  umi,
  asset,
  collection,
  recipientAddress,
  withdrawalRef,
  leaseId,
}) => {
  const { base58, publicKey, transfer } = loadSolanaDependencies();
  const latestBlockhash = await umi.rpc.getLatestBlockhash({
    commitment: CONFIRMATION_COMMITMENT,
  });
  const builder = transfer(umi, {
    asset,
    collection,
    newOwner: publicKey(recipientAddress),
  }).setBlockhash(latestBlockhash);
  const signedTransaction = await builder.buildAndSign(umi);
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
  await persistSubmittedTransaction({
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
  };
};

const sendAndConfirmSubmittedTransaction = async ({ umi, submitted }) => {
  const { base58 } = loadSolanaDependencies();
  const sentSignature = await umi.rpc.sendTransaction(
    submitted.signedTransaction,
    {
      skipPreflight: false,
      preflightCommitment: CONFIRMATION_COMMITMENT,
      maxRetries: 3,
    },
  );
  const sentSignatureString = base58.deserialize(sentSignature)[0];
  if (sentSignatureString !== submitted.transactionSignature) {
    throw new HttpsError("internal", "Prize transaction signature mismatch.");
  }
  const confirmation = await umi.rpc.confirmTransaction(sentSignature, {
    commitment: CONFIRMATION_COMMITMENT,
    strategy: {
      type: "blockhash",
      blockhash: submitted.blockhash,
      lastValidBlockHeight: submitted.lastValidBlockHeight,
    },
  });
  if (confirmation.value.err) {
    throw new HttpsError("failed-precondition", "Prize transfer failed.");
  }
};

const reconcileCompletedWithdrawalProjections = async ({
  withdrawal,
  profileIds,
  eventId,
  prizeId,
}) => {
  const projectionProfileIds = getWithdrawalProjectionProfileIds({
    withdrawal,
    profileIds,
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
  const canonicalProfileSnapshot = await readProfileByLoginUid(
    requesterUid,
    [],
  );
  const canonicalProfileId = normalizeString(canonicalProfileSnapshot?.id);
  if (!canonicalProfileId) {
    throw new HttpsError(
      "unavailable",
      "The prize profile could not be verified.",
    );
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
  await reconcileCompletedWithdrawalProjections({
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
  const recipientAddress = normalizeSolanaAddress(requestData.solanaAddress);
  const assetAddress = getEventPrizeAssetAddress(prizeId);
  if (!eventId || !prizeId || !recipientAddress) {
    throw new HttpsError(
      "invalid-argument",
      "eventId, prizeId, and a valid Solana address are required.",
    );
  }
  if (eventId !== PRIZES_EVENT_ID || !assetAddress) {
    throw new HttpsError("invalid-argument", "Unsupported event prize.");
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
    await reconcileCompletedWithdrawalProjections({
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
    await reconcileCompletedWithdrawalProjections({
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
  try {
    const { fetchAsset, fetchCollection, publicKey } = loadSolanaDependencies();
    const umi = createEventPrizeUmi();
    const asset = await fetchAsset(umi, publicKey(assetAddress), {
      commitment: CONFIRMATION_COMMITMENT,
    });
    if (
      asset.publicKey !== assetAddress ||
      asset.updateAuthority.type !== "Collection" ||
      asset.updateAuthority.address !== EVENT_PRIZE_COLLECTION_ADDRESS
    ) {
      await markWithdrawalBlocked({
        withdrawalRef,
        leaseId,
        observedOwner: asset.owner,
      });
      throw new HttpsError(
        "failed-precondition",
        "The prize collection could not be verified.",
      );
    }
    if (asset.owner === recipientAddress && withdrawal.status === "submitted") {
      const completed = await finalizeWithdrawal({
        withdrawal,
        profileId,
        eventId,
        prizeId,
        assetAddress,
        recipientAddress,
        transactionSignature: normalizeString(withdrawal.transactionSignature),
      });
      return buildCompletedResponse(completed);
    }
    if (asset.owner !== EVENT_PRIZE_ADMIN_WALLET) {
      await markWithdrawalBlocked({
        withdrawalRef,
        leaseId,
        observedOwner: asset.owner,
      });
      throw new HttpsError(
        "failed-precondition",
        "This prize is unavailable for withdrawal.",
      );
    }

    const collection = await fetchCollection(
      umi,
      publicKey(EVENT_PRIZE_COLLECTION_ADDRESS),
      { commitment: CONFIRMATION_COMMITMENT },
    );
    if (collection.publicKey !== EVENT_PRIZE_COLLECTION_ADDRESS) {
      throw new HttpsError(
        "failed-precondition",
        "The prize collection could not be verified.",
      );
    }
    submitted = await deserializeSubmittedTransaction(umi, withdrawal);
    if (!submitted) {
      submitted = await buildSubmittedTransaction({
        umi,
        asset,
        collection,
        recipientAddress,
        withdrawalRef,
        leaseId,
      });
      const submittedSnapshot = await withdrawalRef.once("value");
      withdrawal = submittedSnapshot.val() || withdrawal;
    }
    await sendAndConfirmSubmittedTransaction({ umi, submitted });
    const transferredAsset = await fetchAsset(umi, publicKey(assetAddress), {
      commitment: CONFIRMATION_COMMITMENT,
    });
    if (transferredAsset.owner !== recipientAddress) {
      throw new HttpsError(
        "unavailable",
        "Prize ownership could not be confirmed.",
      );
    }
    const completed = await finalizeWithdrawal({
      withdrawal,
      profileId,
      eventId,
      prizeId,
      assetAddress,
      recipientAddress,
      transactionSignature: submitted.transactionSignature,
    });
    console.info("event-prize-withdrawal-completed", {
      eventId,
      prizeId,
      profileId,
      transactionSignature: submitted.transactionSignature,
    });
    return buildCompletedResponse(completed);
  } catch (error) {
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
  deserializeSubmittedTransaction,
  handleWithdrawEventPrize,
  loadSolanaDependencies,
  reconcileCompletedWithdrawalProjections,
  validatePrizeAssignment,
  withdrawEventPrize,
};
