// Generated from src/eventPrizes/withdrawalOrchestrator.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePrizeAssignment = exports.handleWithdrawEventPrize = void 0;
const errors_js_1 = require("./errors.js");
const event_prizes_1 = require("@mons/shared/event-prizes");
const eventPrizeWithdrawalState_js_1 = require("../eventPrizeWithdrawalState.js");
const assets_js_1 = require("./assets.js");
const projectionReconciliation_js_1 = require("./projectionReconciliation.js");
const submissionRecovery_js_1 = require("./submissionRecovery.js");
const submittedTransactions_js_1 = require("./submittedTransactions.js");
const withdrawalRepository_js_1 = require("./withdrawalRepository.js");
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
    throw new errors_js_1.EventPrizeWithdrawalError(
      "not-found",
      "Event prize not found.",
    );
  }
  return place;
};
exports.validatePrizeAssignment = validatePrizeAssignment;
const handleWithdrawEventPrize = async (request, dependencies) => {
  if (!request.auth) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }
  const requestData =
    request.data && typeof request.data === "object" ? request.data : {};
  const eventId = normalizeString(requestData.eventId);
  const prizeId = normalizeString(requestData.prizeId);
  if (!eventId || !prizeId) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "invalid-argument",
      "eventId and prizeId are required.",
    );
  }
  const prize = (0, event_prizes_1.getEventPrizeDefinition)(eventId, prizeId);
  const assetAddress = (0,
  eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(prize?.assetAddress);
  const collectionAddress = (0,
  eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
    prize?.collectionAddress,
  );
  if (
    !prize ||
    prize.claimAvailable !== true ||
    !(0, event_prizes_1.isEventPrizeStandard)(prize.standard) ||
    assetAddress !== normalizeString(prize.assetAddress) ||
    collectionAddress !== normalizeString(prize.collectionAddress)
  ) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "invalid-argument",
      "Unsupported event prize.",
    );
  }
  const recipientAddress = (0,
  eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
    requestData.solanaAddress,
  );
  if (!recipientAddress) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "invalid-argument",
      "A valid Solana address is required.",
    );
  }
  if (
    recipientAddress === eventPrizeWithdrawalState_js_1.EVENT_PRIZE_ADMIN_WALLET
  ) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "invalid-argument",
      "Choose a destination other than the prize wallet.",
    );
  }
  const {
    withdrawals,
    createEventPrizeUmi,
    readProfileByLoginUid,
    resolveWithdrawalProfileId,
  } = dependencies;
  const profileSnapshot = await readProfileByLoginUid(request.auth.uid, []);
  const profileId = normalizeString(profileSnapshot?.id);
  if (!profileId) {
    throw new errors_js_1.EventPrizeWithdrawalError(
      "not-found",
      "profile-not-found",
    );
  }
  const withdrawalRecord = withdrawals.record(eventId, prizeId);
  const existingWithdrawal = await withdrawalRecord.read();
  const existingProfileId = normalizeString(existingWithdrawal?.profileId);
  let canonicalRecordProfileId = existingProfileId;
  let existingRecordOwnedByRequest = (0,
  eventPrizeWithdrawalState_js_1.isWithdrawalRecordOwnedByRequest)(
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
    existingRecordOwnedByRequest = (0,
    eventPrizeWithdrawalState_js_1.isWithdrawalRecordOwnedByRequest)(
      existingWithdrawal,
      profileId,
      request.auth.uid,
      canonicalRecordProfileId,
      existingProfileId,
    );
  }
  if (
    (0, eventPrizeWithdrawalState_js_1.isCompletedEventPrizeWithdrawal)(
      existingWithdrawal,
      eventId,
      prizeId,
    )
  ) {
    const completedRecipientAddress = (0,
    eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
      existingWithdrawal.recipientAddress,
    );
    if (
      !existingRecordOwnedByRequest ||
      !completedRecipientAddress ||
      completedRecipientAddress ===
        eventPrizeWithdrawalState_js_1.EVENT_PRIZE_ADMIN_WALLET
    ) {
      throw new errors_js_1.EventPrizeWithdrawalError(
        "permission-denied",
        "Prize withdrawal is unavailable.",
      );
    }
    await (0,
    projectionReconciliation_js_1.reconcileCompletedWithdrawalProjections)(
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
    (0, eventPrizeWithdrawalState_js_1.isWithdrawalRecordForPrize)(
      existingWithdrawal,
      eventId,
      prizeId,
      assetAddress,
    ) &&
    existingRecordOwnedByRequest &&
    Boolean(
      (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
        existingWithdrawal.recipientAddress,
      ),
    ) &&
    [1, 2, 3].includes(Number(existingWithdrawal.place));
  let place = Number(existingWithdrawal?.place);
  if (!submittedRecordCanResume) {
    const assignment = await dependencies.readProfileEventPrizeAssignment(
      profileId,
      eventId,
    );
    place = validatePrizeAssignment({
      assignment,
      eventId,
      prizeId,
      profileId,
    });
  }
  const claim = await (0, withdrawalRepository_js_1.acquireWithdrawalClaim)({
    withdrawalRecord,
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
    await (0,
    projectionReconciliation_js_1.reconcileCompletedWithdrawalProjections)(
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
      await (0, projectionReconciliation_js_1.finalizeWithdrawal)(
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
    await (0, withdrawalRepository_js_1.markWithdrawalBlocked)({
      withdrawalRecord,
      leaseId,
      observedOwner,
    });
    throw new errors_js_1.EventPrizeWithdrawalError(
      "failed-precondition",
      message || "This prize is unavailable for withdrawal.",
    );
  };
  try {
    const umi = createEventPrizeUmi(prize.standard);
    let submittedInspection = null;
    if (withdrawal.status === "submitted") {
      submittedInspection = await (0,
      submissionRecovery_js_1.inspectSubmittedWithdrawal)({
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
    const assetState = await (0, assets_js_1.loadPrizeAssetState)({
      umi,
      prize,
      recipientAddress,
      needsTransferBuilder: withdrawal.status !== "submitted",
    });
    let assetOwner;
    if (withdrawal.status === "submitted") {
      const resolution = await (0,
      submissionRecovery_js_1.reconcileSubmittedAssetState)({
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
        await (0,
        withdrawalRepository_js_1.discardDefinitiveSubmittedTransaction)({
          withdrawalRecord,
          leaseId,
          transactionSignature: resolution.submitted.transactionSignature,
        });
        throw new errors_js_1.EventPrizeWithdrawalError(
          "unavailable",
          "Prize transfer failed. Please try again.",
        );
      }
      if (resolution.kind === "retry") {
        throw new errors_js_1.EventPrizeWithdrawalError(
          "unavailable",
          "Prize withdrawal failed. Please try again.",
        );
      }
      submitted = resolution.submitted;
    } else {
      assetOwner = (0, eventPrizeWithdrawalState_js_1.normalizeSolanaAddress)(
        assetState.assetOwner,
      );
      if (!assetOwner) {
        throw (0, assets_js_1.createPrizeAssetVerificationError)(
          "The prize ownership could not be verified.",
        );
      }
      if (assetState.blocked) {
        await blockWithdrawal(assetOwner, assetState.message);
      }
      if (
        assetOwner !== eventPrizeWithdrawalState_js_1.EVENT_PRIZE_ADMIN_WALLET
      ) {
        await blockWithdrawal(assetOwner);
      }
    }
    if (!submitted) {
      submitted = await (0,
      submittedTransactions_js_1.buildSubmittedTransaction)({
        umi,
        builder: await assetState.buildTransferBuilder(),
        withdrawalRecord,
        leaseId,
      });
      withdrawal = submitted.persistedWithdrawal;
    }
    await (0, submittedTransactions_js_1.sendAndConfirmSubmittedTransaction)({
      umi,
      submitted,
    });
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
    if (
      submitted &&
      (0, submittedTransactions_js_1.isDefinitiveSubmittedTransactionFailure)(
        error,
      )
    ) {
      try {
        await (0,
        withdrawalRepository_js_1.discardDefinitiveSubmittedTransaction)({
          withdrawalRecord,
          leaseId,
          transactionSignature: submitted.transactionSignature,
        });
      } catch (discardError) {
        if (discardError instanceof errors_js_1.EventPrizeWithdrawalError) {
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
        throw new errors_js_1.EventPrizeWithdrawalError(
          "unavailable",
          "Prize withdrawal failed. Please try again.",
        );
      }
      throw new errors_js_1.EventPrizeWithdrawalError(
        "unavailable",
        "Prize transfer failed. Please try again.",
      );
    }
    if (error instanceof errors_js_1.EventPrizeWithdrawalError) {
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
    throw new errors_js_1.EventPrizeWithdrawalError(
      "unavailable",
      "Prize withdrawal failed. Please try again.",
    );
  }
};
exports.handleWithdrawEventPrize = handleWithdrawEventPrize;
