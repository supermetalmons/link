import {
  withdrawalOwnership,
  withdrawalRecipientAddress,
  withdrawalStatus,
  withdrawalPlace,
  withdrawalLeaseId,
  withdrawalResponseFields,
  type WithdrawalDocument,
} from "../../../../runtime/eventPrizes/records.js";
import {
  getEventPrizeDefinition,
  isEventPrizeStandard,
  isEventPrizeWithdrawalCompletedResponse,
  type EventPrizeEventId,
  type EventPrizeId,
  type EventPrizeWithdrawalCompletedResponse,
  type EventPrizeWithdrawalProcessingResponse,
  type EventPrizeWithdrawalRequest,
  type EventPrizeWithdrawalStatusRequest,
} from "@mons/shared/event-prizes";
import {
  EVENT_PRIZE_ADMIN_WALLET,
  isCompletedEventPrizeWithdrawal,
  isWithdrawalRecordForPrize,
  isWithdrawalRecordOwnedByRequest,
  normalizeSolanaAddress,
} from "../../../../runtime/eventPrizeWithdrawalState.js";
import { EventPrizeWithdrawalError } from "../../../../runtime/eventPrizes/errors.js";
import { attemptCompletedWithdrawalProjectionReconciliation } from "../../../../runtime/eventPrizes/projectionReconciliation.js";
import { validatePrizeAssignment } from "../../../../runtime/eventPrizes/assignmentValidation.js";
import {
  acquireWithdrawalClaim,
  releaseProcessingClaim,
} from "../../../../runtime/eventPrizes/withdrawalRepository.js";
import { AuthApiFailure } from "../authErrors.ts";
import type { RequestIdentity } from "../requestIdentity.ts";
import {
  getCanonicalProfileId,
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "../profileOwnership.ts";
import {
  buildCompletedResponse,
  buildEventPrizeWithdrawalOperationId,
  cleanString,
  terminalWorkflowFailure,
  toEventPrizeApiFailure,
  toRecord,
  type EventPrizeWithdrawalWorkflowInput,
  type EventPrizeWithdrawalWorkflowParams,
} from "./contracts.ts";
import type {
  EventPrizeRequestDependencies,
  EventPrizeStatusDependencies,
} from "./context.ts";

type PendingWithdrawalAdmission = {
  leaseId: string;
  params: EventPrizeWithdrawalWorkflowParams;
  releaseLeaseOnFailure: boolean;
};

async function ensureWorkflow(
  workflow: Workflow<EventPrizeWithdrawalWorkflowInput>,
  params: EventPrizeWithdrawalWorkflowParams,
): Promise<void> {
  let instance: WorkflowInstance | null = null;
  try {
    const instances = await workflow.createBatch([
      workflowCreateOptions(params),
    ]);
    instance = instances[0] || null;
  } catch (error) {
    try {
      instance = await workflow.get(params.operationId);
    } catch {
      throw error;
    }
  }
  instance ||= await workflow.get(params.operationId);
  const status = await instance.status();
  if (
    status.status === "errored" ||
    status.status === "complete" ||
    status.status === "terminated"
  ) {
    const output = toRecord(status.output);
    if (
      status.status === "complete" &&
      isEventPrizeWithdrawalCompletedResponse(output)
    ) {
      return;
    }
    await instance.delete();
    await workflow.createBatch([workflowCreateOptions(params)]);
    return;
  }
  if (status.status === "paused" || status.status === "waitingForPause") {
    throw new EventPrizeWithdrawalError(
      "failed-precondition",
      "Prize withdrawal is paused by an operator.",
    );
  }
  if (status.status === "unknown") {
    throw new Error("event-prize-withdrawal-workflow-unknown");
  }
}

function workflowCreateOptions(
  params: EventPrizeWithdrawalWorkflowParams,
): WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput> {
  return {
    id: params.operationId,
    params,
    retention: { successRetention: "1 day", errorRetention: "30 days" },
  };
}

async function ensureAdmittedWithdrawalWorkflow(
  workflow: Workflow<EventPrizeWithdrawalWorkflowInput>,
  admission: PendingWithdrawalAdmission,
  runtime: Pick<EventPrizeRequestDependencies, "withdrawals">,
): Promise<void> {
  try {
    await ensureWorkflow(workflow, admission.params);
  } catch (error) {
    if (admission.releaseLeaseOnFailure) {
      await releaseProcessingClaim({
        withdrawalRecord: runtime.withdrawals.record(
          admission.params.eventId,
          admission.params.prizeId,
        ),
        leaseId: admission.leaseId,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function resolveOwnedWithdrawal(
  identity: RequestIdentity,
  eventId: string,
  prizeId: string,
  runtime: EventPrizeStatusDependencies,
): Promise<{
  canonicalRecordProfileId: string;
  profileId: string;
  withdrawal: WithdrawalDocument | null;
}> {
  const withdrawal = await runtime.readWithdrawal(eventId, prizeId);
  const existingProfileId = withdrawalOwnership(withdrawal).profileId;
  const ownership = await requireProfileOwnershipSnapshot(runtime, {
    loginUids: [identity.uid],
    profileIds: existingProfileId ? [existingProfileId] : [],
  });
  const profileId = getLoginProfileId(ownership, identity.uid) || "";
  if (!profileId) {
    throw new EventPrizeWithdrawalError("not-found", "profile-not-found");
  }
  if (!withdrawal) {
    return { canonicalRecordProfileId: "", profileId, withdrawal: null };
  }
  const canonicalRecordProfileId = existingProfileId
    ? getCanonicalProfileId(ownership, existingProfileId) || ""
    : "";
  const owned = existingProfileId
    ? canonicalRecordProfileId === profileId
    : isWithdrawalRecordOwnedByRequest(withdrawal, profileId, identity.uid);
  if (!owned) {
    throw new EventPrizeWithdrawalError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  return { canonicalRecordProfileId, profileId, withdrawal };
}

type OwnedWithdrawal = Awaited<ReturnType<typeof resolveOwnedWithdrawal>>;

async function refreshOwnedWithdrawal(
  eventId: string,
  prizeId: string,
  owned: OwnedWithdrawal,
  runtime: Pick<EventPrizeStatusDependencies, "readWithdrawal">,
): Promise<OwnedWithdrawal> {
  const withdrawal = await runtime.readWithdrawal(eventId, prizeId);
  if (!withdrawal) return { ...owned, withdrawal: null };
  const recordProfileId = withdrawalOwnership(withdrawal).profileId;
  const previousRecordProfileId = withdrawalOwnership(
    owned.withdrawal,
  ).profileId;
  if (
    !recordProfileId ||
    (recordProfileId !== owned.profileId &&
      recordProfileId !== previousRecordProfileId)
  ) {
    throw new EventPrizeWithdrawalError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  return { ...owned, withdrawal };
}

async function admitWithdrawal(
  identity: RequestIdentity,
  request: {
    eventId: EventPrizeEventId;
    prizeId: EventPrizeId;
    solanaAddress: string;
  },
  operationId: string,
  runtime: EventPrizeRequestDependencies,
): Promise<EventPrizeWithdrawalCompletedResponse | PendingWithdrawalAdmission> {
  const prize = getEventPrizeDefinition(request.eventId, request.prizeId);
  const assetAddress = normalizeSolanaAddress(prize?.assetAddress);
  const collectionAddress = normalizeSolanaAddress(prize?.collectionAddress);
  if (
    !prize ||
    prize.claimAvailable !== true ||
    !isEventPrizeStandard(prize.standard) ||
    assetAddress !== cleanString(prize.assetAddress) ||
    collectionAddress !== cleanString(prize.collectionAddress)
  ) {
    throw new EventPrizeWithdrawalError(
      "invalid-argument",
      "Unsupported event prize.",
    );
  }
  const recipientAddress = normalizeSolanaAddress(request.solanaAddress);
  if (!recipientAddress) {
    throw new EventPrizeWithdrawalError(
      "invalid-argument",
      "A valid Solana address is required.",
    );
  }
  if (recipientAddress === EVENT_PRIZE_ADMIN_WALLET) {
    throw new EventPrizeWithdrawalError(
      "invalid-argument",
      "Choose a destination other than the prize wallet.",
    );
  }

  const { canonicalRecordProfileId, profileId, withdrawal } =
    await resolveOwnedWithdrawal(
      identity,
      request.eventId,
      request.prizeId,
      runtime,
    );
  if (
    withdrawal &&
    isCompletedEventPrizeWithdrawal(
      withdrawal,
      request.eventId,
      request.prizeId,
    )
  ) {
    const completed = buildCompletedResponse(
      operationId,
      withdrawalResponseFields(withdrawal),
    );
    await attemptCompletedWithdrawalProjectionReconciliation(
      {
        withdrawal,
        profileIds: [profileId],
        eventId: request.eventId,
        prizeId: request.prizeId,
      },
      runtime,
    );
    return completed;
  }

  const existingProfileId = withdrawalOwnership(withdrawal).profileId;
  const submittedRecordCanResume =
    withdrawalStatus(withdrawal) === "submitted" &&
    isWithdrawalRecordForPrize(
      withdrawal,
      request.eventId,
      request.prizeId,
      assetAddress,
    ) &&
    Boolean(normalizeSolanaAddress(withdrawalRecipientAddress(withdrawal))) &&
    [1, 2, 3].includes(withdrawalPlace(withdrawal));
  let place = withdrawalPlace(withdrawal);
  if (!submittedRecordCanResume) {
    const assignment = await runtime.readProfileEventPrizeAssignment(
      profileId,
      request.eventId,
    );
    place = validatePrizeAssignment({
      assignment,
      eventId: request.eventId,
      prizeId: request.prizeId,
      profileId,
    });
  }
  const params: EventPrizeWithdrawalWorkflowParams = {
    schemaVersion: 1,
    kind: "withdrawal",
    eventId: request.eventId,
    operationId,
    prizeId: request.prizeId,
    profileId,
    recipientAddress,
    requesterUid: identity.uid,
  };
  const activeLeaseId = withdrawalLeaseId(withdrawal);
  const activeProcessingIntent =
    withdrawalStatus(withdrawal) === "processing" &&
    Boolean(activeLeaseId) &&
    isWithdrawalRecordForPrize(
      withdrawal,
      request.eventId,
      request.prizeId,
      assetAddress,
    );
  if (activeProcessingIntent) {
    if (
      normalizeSolanaAddress(withdrawalRecipientAddress(withdrawal)) !==
      recipientAddress
    ) {
      throw new EventPrizeWithdrawalError(
        "failed-precondition",
        "The pending withdrawal is locked to its original destination.",
      );
    }
    return {
      leaseId: activeLeaseId,
      params,
      releaseLeaseOnFailure: false,
    };
  }
  const claim = await acquireWithdrawalClaim({
    withdrawalRecord: runtime.withdrawals.record(
      request.eventId,
      request.prizeId,
    ),
    eventId: request.eventId,
    prizeId: request.prizeId,
    assetAddress,
    profileId,
    place,
    recipientAddress,
    requesterUid: identity.uid,
    canonicalRecordProfileId,
    canonicalRecordSourceProfileId: existingProfileId,
  });
  if (claim.completed) {
    return buildCompletedResponse(
      operationId,
      withdrawalResponseFields(claim.completed),
    );
  }
  const leaseId = cleanString(claim.leaseId);
  if (!leaseId) throw new Error("event-prize-withdrawal-lease-missing");
  return {
    leaseId,
    params,
    releaseLeaseOnFailure: true,
  };
}

async function resolveWithdrawalWorkflowRecovery(
  request: {
    eventId: EventPrizeEventId;
    operationId: string;
    prizeId: EventPrizeId;
  },
  owned: OwnedWithdrawal,
): Promise<
  EventPrizeWithdrawalCompletedResponse | EventPrizeWithdrawalWorkflowParams
> {
  if (
    owned.withdrawal &&
    isCompletedEventPrizeWithdrawal(
      owned.withdrawal,
      request.eventId,
      request.prizeId,
    )
  ) {
    return buildCompletedResponse(
      request.operationId,
      withdrawalResponseFields(owned.withdrawal),
    );
  }
  if (withdrawalStatus(owned.withdrawal) === "blocked") {
    throw new AuthApiFailure(
      412,
      "failed-precondition",
      "This prize is unavailable for withdrawal.",
    );
  }
  if (
    withdrawalStatus(owned.withdrawal) !== "processing" &&
    withdrawalStatus(owned.withdrawal) !== "submitted"
  ) {
    throw terminalWorkflowFailure();
  }
  const recipientAddress = normalizeSolanaAddress(
    withdrawalRecipientAddress(owned.withdrawal),
  );
  const prize = getEventPrizeDefinition(request.eventId, request.prizeId);
  const assetAddress = normalizeSolanaAddress(prize?.assetAddress);
  const collectionAddress = normalizeSolanaAddress(prize?.collectionAddress);
  const place = withdrawalPlace(owned.withdrawal);
  const storedProfileId = withdrawalOwnership(owned.withdrawal).profileId;
  const requesterUid = withdrawalOwnership(owned.withdrawal).requesterUid;
  if (
    !prize ||
    prize.claimAvailable !== true ||
    !isEventPrizeStandard(prize.standard) ||
    assetAddress !== cleanString(prize.assetAddress) ||
    collectionAddress !== cleanString(prize.collectionAddress) ||
    !isWithdrawalRecordForPrize(
      owned.withdrawal,
      request.eventId,
      request.prizeId,
      assetAddress,
    ) ||
    !recipientAddress ||
    recipientAddress === EVENT_PRIZE_ADMIN_WALLET ||
    ![1, 2, 3].includes(place) ||
    !storedProfileId ||
    !requesterUid
  ) {
    throw terminalWorkflowFailure();
  }
  return {
    schemaVersion: 1,
    kind: "withdrawal",
    eventId: request.eventId,
    operationId: request.operationId,
    prizeId: request.prizeId,
    profileId: owned.profileId,
    recipientAddress,
    requesterUid,
  };
}

export async function startEventPrizeWithdrawal(
  identity: RequestIdentity,
  request: EventPrizeWithdrawalRequest,
  runtime: EventPrizeRequestDependencies,
  workflow: Workflow<EventPrizeWithdrawalWorkflowInput>,
): Promise<
  EventPrizeWithdrawalCompletedResponse | EventPrizeWithdrawalProcessingResponse
> {
  const operationId = await buildEventPrizeWithdrawalOperationId(
    request.eventId,
    request.prizeId,
  );
  const admission = await admitWithdrawal(
    identity,
    request,
    operationId,
    runtime,
  );
  if ("status" in admission) {
    return admission;
  }
  await ensureAdmittedWithdrawalWorkflow(workflow, admission, runtime);
  const processing: EventPrizeWithdrawalProcessingResponse = {
    ok: true,
    status: "processing",
    operationId,
    eventId: request.eventId,
    prizeId: request.prizeId,
  };
  return processing;
}

export async function getEventPrizeWithdrawalStatus(
  identity: RequestIdentity,
  request: EventPrizeWithdrawalStatusRequest,
  runtime: EventPrizeStatusDependencies,
  workflow: Workflow<EventPrizeWithdrawalWorkflowInput>,
): Promise<
  EventPrizeWithdrawalCompletedResponse | EventPrizeWithdrawalProcessingResponse
> {
  const expectedOperationId = await buildEventPrizeWithdrawalOperationId(
    request.eventId,
    request.prizeId,
  );
  if (request.operationId !== expectedOperationId) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  let owned = await resolveOwnedWithdrawal(
    identity,
    request.eventId,
    request.prizeId,
    runtime,
  );
  if (!owned.withdrawal) {
    const assignment = await runtime.readProfileEventPrizeAssignment(
      owned.profileId,
      request.eventId,
    );
    validatePrizeAssignment({
      assignment,
      eventId: request.eventId,
      prizeId: request.prizeId,
      profileId: owned.profileId,
    });
  }
  if (
    owned.withdrawal &&
    isCompletedEventPrizeWithdrawal(
      owned.withdrawal,
      request.eventId,
      request.prizeId,
    )
  ) {
    return buildCompletedResponse(
      request.operationId,
      withdrawalResponseFields(owned.withdrawal),
    );
  }
  if (withdrawalStatus(owned.withdrawal) === "blocked") {
    throw new AuthApiFailure(
      412,
      "failed-precondition",
      "This prize is unavailable for withdrawal.",
    );
  }
  let instance: WorkflowInstance | null = null;
  try {
    instance = await workflow.get(request.operationId);
  } catch {
    owned = await refreshOwnedWithdrawal(
      request.eventId,
      request.prizeId,
      owned,
      runtime,
    );
    const recovery = await resolveWithdrawalWorkflowRecovery(request, owned);
    if ("status" in recovery) {
      return recovery;
    }
    let created = false;
    try {
      created =
        (await workflow.createBatch([workflowCreateOptions(recovery)])).length >
        0;
    } catch {
      created = false;
    }
    if (!created) {
      try {
        instance = await workflow.get(request.operationId);
      } catch {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "Prize withdrawal service is unavailable.",
        );
      }
    }
  }
  const status = instance ? await instance.status() : null;
  if (status?.status === "complete") {
    const output = toRecord(status.output);
    if (output?.ok === false && output.status === "failed") {
      throw toEventPrizeApiFailure(output);
    }
    owned = await refreshOwnedWithdrawal(
      request.eventId,
      request.prizeId,
      owned,
      runtime,
    );
    if (
      owned.withdrawal &&
      isCompletedEventPrizeWithdrawal(
        owned.withdrawal,
        request.eventId,
        request.prizeId,
      )
    ) {
      return buildCompletedResponse(
        request.operationId,
        withdrawalResponseFields(owned.withdrawal),
      );
    }
    throw terminalWorkflowFailure();
  }
  if (status?.status === "errored") {
    throw terminalWorkflowFailure();
  }
  if (status?.status === "terminated") {
    owned = await refreshOwnedWithdrawal(
      request.eventId,
      request.prizeId,
      owned,
      runtime,
    );
    const recovery = await resolveWithdrawalWorkflowRecovery(request, owned);
    if ("status" in recovery) {
      return recovery;
    }
    if (!instance) {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "Prize withdrawal service is unavailable.",
      );
    }
    await instance.delete();
    await workflow.createBatch([workflowCreateOptions(recovery)]);
  }
  if (status?.status === "unknown") {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "Prize withdrawal service is unavailable.",
    );
  }
  const processing: EventPrizeWithdrawalProcessingResponse = {
    ok: true,
    status: "processing",
    operationId: request.operationId,
    eventId: request.eventId,
    prizeId: request.prizeId,
  };
  return processing;
}
