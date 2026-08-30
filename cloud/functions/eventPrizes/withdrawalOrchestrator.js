"use strict";

const { EventPrizeWithdrawalError: HttpsError } = require("./errors");
const {
  getEventPrizeDefinition,
  isEventPrizeStandard,
} = require("@mons/shared/event-prizes");
const {
  EVENT_PRIZE_ADMIN_WALLET,
  getEventPrizeWithdrawalPath,
  isCompletedEventPrizeWithdrawal,
  isWithdrawalRecordForPrize,
  isWithdrawalRecordOwnedByRequest,
  normalizeSolanaAddress,
} = require("../eventPrizeWithdrawalState");
const {
  createPrizeAssetVerificationError,
  loadPrizeAssetState,
} = require("./assets");
const {
  finalizeWithdrawal,
  reconcileCompletedWithdrawalProjections,
} = require("./projectionReconciliation");
const {
  inspectSubmittedWithdrawal,
  reconcileSubmittedAssetState,
} = require("./submissionRecovery");
const {
  buildSubmittedTransaction,
  isDefinitiveSubmittedTransactionFailure,
  sendAndConfirmSubmittedTransaction,
} = require("./submittedTransactions");
const {
  acquireWithdrawalClaim,
  discardDefinitiveSubmittedTransaction,
  markWithdrawalBlocked,
} = require("./withdrawalRepository");

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

const handleWithdrawEventPrize = async (request, dependencies) => {
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

  const {
    admin,
    createEventPrizeUmi,
    readProfileByLoginUid,
    resolveWithdrawalProfileId,
  } = dependencies;

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
      await resolveWithdrawalProfileId(existingProfileId);
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
    await reconcileCompletedWithdrawalProjections(
      {
        withdrawal: existingWithdrawal,
        profileIds: [profileId],
        eventId,
        prizeId,
      },
      dependencies,
    );
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
    await reconcileCompletedWithdrawalProjections(
      {
        withdrawal: claim.completed,
        profileIds: [profileId],
        eventId,
        prizeId,
      },
      dependencies,
    );
    return buildCompletedResponse(claim.completed);
  }

  const { leaseId } = claim;
  let withdrawal = claim.withdrawal;
  let submitted = null;
  const completeWithdrawal = async (transactionSignature) =>
    buildCompletedResponse(
      await finalizeWithdrawal(
        {
          withdrawal,
          profileId,
          eventId,
          prizeId,
          assetAddress,
          recipientAddress,
          transactionSignature,
        },
        dependencies,
      ),
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
    console.info(
      JSON.stringify({
        event: "event_prize_withdrawal_completed",
        eventId,
        prizeId,
        profileId,
        transactionSignature: submitted.transactionSignature,
      }),
    );
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
        console.error(
          JSON.stringify({
            event: "event_prize_withdrawal_discard_failed",
            eventId,
            prizeId,
            profileId,
            errorType: normalizeString(discardError?.name) || "Error",
          }),
        );
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
    if (error instanceof HttpsError) {
      throw error;
    }
    console.error(
      JSON.stringify({
        event: "event_prize_withdrawal_failed",
        eventId,
        prizeId,
        profileId,
        phase: submitted ? "submitted" : "processing",
        errorType: normalizeString(error?.name) || "Error",
      }),
    );
    throw new HttpsError(
      "unavailable",
      "Prize withdrawal failed. Please try again.",
    );
  }
};

module.exports = {
  handleWithdrawEventPrize,
  validatePrizeAssignment,
};
