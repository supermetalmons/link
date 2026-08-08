"use strict";

const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { getEventPrizeDefinition } = require("@mons/shared/event-prizes");
const admin = require("./firebaseAdmin");
const { HELIUS_RPC_API_KEY, getHeliusRpcUrl } = require("./heliusRpc");
const { readProfileByLoginUid } = require("./profileLookup");
const {
  removeMatchingProfileEventPrizeAssignment,
  resolveCanonicalProfileId,
  resolveCanonicalProfilePath,
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
const CONFIRMATION_TIMEOUT_MS = 45 * 1000;
const SEND_TRANSACTION_TIMEOUT_MS = 10 * 1000;
const SIGNATURE_STATUS_TIMEOUT_MS = 2 * 1000;
const TRANSACTION_STATUS_RETRY_DELAYS_MS = [0, 500, 1000, 2000, 4000, 8000];
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

const getCurrentBlockHeight = async (umi) => {
  const blockHeight = await umi.rpc.call("getBlockHeight", [
    { commitment: CONFIRMATION_COMMITMENT },
  ]);
  const numeric = Number(blockHeight);
  return Number.isFinite(numeric)
    ? Math.floor(numeric)
    : Number.MAX_SAFE_INTEGER;
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

const deserializeSubmittedTransaction = async (umi, withdrawal) => {
  const encoded = normalizeString(withdrawal?.signedTransactionBase64);
  const lastValidBlockHeight = Number(withdrawal?.lastValidBlockHeight);
  if (!encoded || !Number.isFinite(lastValidBlockHeight)) {
    return null;
  }
  if ((await getCurrentBlockHeight(umi)) > lastValidBlockHeight) {
    return null;
  }
  return deserializePersistedSubmittedTransaction(umi, withdrawal);
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
    return { kind: "pending" };
  }
  if (status.error != null) {
    return { kind: "failed", error: status.error };
  }
  if (["confirmed", "finalized"].includes(status.commitment)) {
    return { kind: "confirmed" };
  }
  return { kind: "pending" };
};

const waitForSubmittedTransactionStatus = async ({
  umi,
  submitted,
  retryDelaysMs = TRANSACTION_STATUS_RETRY_DELAYS_MS,
  statusRequestTimeoutMs = SIGNATURE_STATUS_TIMEOUT_MS,
}) => {
  const transactionSignature = getSubmittedTransactionSignature(submitted);
  let observedStatus = false;
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
    } catch (error) {
      lastError = error;
    }
  }
  return observedStatus
    ? { kind: "pending" }
    : { kind: "unknown", error: lastError };
};

const recoverSubmittedWithdrawal = async ({
  umi,
  withdrawal,
  assetOwner,
  recipientAddress,
  statusRetryDelaysMs = TRANSACTION_STATUS_RETRY_DELAYS_MS,
}) => {
  const submitted = deserializePersistedSubmittedTransaction(umi, withdrawal);
  if (!submitted) {
    throw new HttpsError(
      "internal",
      "The submitted prize transaction is unavailable.",
    );
  }
  let status = await waitForSubmittedTransactionStatus({
    umi,
    submitted,
    retryDelaysMs: [0],
  });
  if (status.kind === "confirmed") {
    return { kind: "completed", submitted };
  }
  if (status.kind === "failed") {
    return assetOwner === EVENT_PRIZE_ADMIN_WALLET
      ? { kind: "retry", discardPersistedSubmission: true }
      : { kind: "blocked" };
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
    return { kind: "retry", discardPersistedSubmission: false };
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
    return { kind: "blocked" };
  }
  throw status.error || new Error("Prize transaction confirmation is pending.");
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
    if (Array.isArray(error?.logs) && error.logs.length > 0) {
      throw new HttpsError(
        "failed-precondition",
        "The prize transfer could not be submitted.",
      );
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
      throw new HttpsError("failed-precondition", "Prize transfer failed.");
    }
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    const status = await waitForSubmittedTransactionStatus({
      umi,
      submitted,
      retryDelaysMs: statusRetryDelaysMs,
      statusRequestTimeoutMs,
    });
    if (status.kind === "failed") {
      throw new HttpsError("failed-precondition", "Prize transfer failed.");
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
  const assetAddress = getEventPrizeAssetAddress(eventId, prizeId);
  if (
    !prize ||
    prize.claimAvailable !== true ||
    prize.standard !== "core" ||
    !assetAddress
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
    let discardPersistedSubmission = false;
    if (withdrawal.status === "submitted") {
      const recovery = await recoverSubmittedWithdrawal({
        umi,
        withdrawal,
        assetOwner: asset.owner,
        recipientAddress,
      });
      if (recovery.kind === "completed") {
        const completed = await finalizeWithdrawal({
          withdrawal,
          profileId,
          eventId,
          prizeId,
          assetAddress,
          recipientAddress,
          transactionSignature: recovery.submitted.transactionSignature,
        });
        return buildCompletedResponse(completed);
      }
      if (recovery.kind === "blocked") {
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
      discardPersistedSubmission = recovery.discardPersistedSubmission;
    } else if (asset.owner !== EVENT_PRIZE_ADMIN_WALLET) {
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
    submitted = discardPersistedSubmission
      ? null
      : await deserializeSubmittedTransaction(umi, withdrawal);
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
  acquireWithdrawalClaim,
  deserializePersistedSubmittedTransaction,
  deserializeSubmittedTransaction,
  handleWithdrawEventPrize,
  loadSolanaDependencies,
  persistSubmittedTransaction,
  recoverSubmittedWithdrawal,
  reconcileCompletedWithdrawalProjections,
  sendAndConfirmSubmittedTransaction,
  validatePrizeAssignment,
  waitForSubmittedTransactionStatus,
  withdrawEventPrize,
};
