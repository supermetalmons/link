import {
  getEventPrizeDefinition,
  type EventPrizeWithdrawalCompletedResponse,
} from "@mons/shared/event-prizes";
import {
  isWithdrawalRecordForPrize,
  normalizeSolanaAddress,
} from "../../../../runtime/eventPrizeWithdrawalState.js";
import { EventPrizeWithdrawalError } from "../../../../runtime/eventPrizes/errors.js";
import { createEventPrizeUmi as createConfiguredEventPrizeUmi } from "../../../../runtime/eventPrizes/solana.js";
import { handleWithdrawEventPrize } from "../../../../runtime/eventPrizes/withdrawalOrchestrator.js";
import {
  withdrawalOwnership,
  withdrawalRecipientAddress,
  withdrawalExecutionStatus,
} from "../../../../runtime/eventPrizes/records.js";
import type { WithdrawalRuntimeDependencies } from "../../../../runtime/eventPrizes/solanaTypes.js";
import {
  getCanonicalProfileId,
  requireProfileOwnershipSnapshot,
} from "../profileOwnership.ts";
import {
  buildCompletedResponse,
  type EventPrizeWithdrawalWorkflowParams,
} from "./contracts.ts";
import {
  createEventPrizeContext,
  type EventPrizeContext,
  type RuntimeOptions,
} from "./context.ts";

export type {
  EventPrizeGameplayRepository,
  RuntimeOptions,
} from "./context.ts";

export type EventPrizeRuntimeDependencies = EventPrizeContext &
  Pick<WithdrawalRuntimeDependencies, "createEventPrizeUmi">;

export async function createEventPrizeRuntimeDependencies(
  env: Env,
  options: RuntimeOptions & { allowFrozen?: boolean } = {},
): Promise<EventPrizeRuntimeDependencies> {
  const context = await createEventPrizeContext(env, options);
  return {
    ...context,
    createEventPrizeUmi: (standard) =>
      createConfiguredEventPrizeUmi(standard, {
        adminPrivateKey: env.EVENT_PRIZE_ADMIN_PRIVATE_KEY,
        heliusRpcApiKey: env.HELIUS_RPC_API_KEY,
      }),
  };
}

export async function resolveEventPrizeWithdrawalExecutionParams(
  params: EventPrizeWithdrawalWorkflowParams,
  runtime: Pick<
    EventPrizeRuntimeDependencies,
    "readProfileOwnershipSnapshot" | "readWithdrawal"
  >,
): Promise<EventPrizeWithdrawalWorkflowParams> {
  const withdrawal = await runtime.readWithdrawal(
    params.eventId,
    params.prizeId,
  );
  const prize = getEventPrizeDefinition(params.eventId, params.prizeId);
  const recordProfileId = withdrawalOwnership(withdrawal).profileId;
  const recordRecipientAddress = normalizeSolanaAddress(
    withdrawalRecipientAddress(withdrawal),
  );
  const recordRequesterUid = withdrawalOwnership(withdrawal).requesterUid;
  const admittedRecipientAddress = normalizeSolanaAddress(
    params.recipientAddress,
  );
  const status = withdrawalExecutionStatus(withdrawal);
  if (
    !withdrawal ||
    !prize ||
    !["processing", "submitted", "completed"].includes(status) ||
    !isWithdrawalRecordForPrize(
      withdrawal,
      params.eventId,
      params.prizeId,
      prize.assetAddress,
    ) ||
    !recordProfileId ||
    !recordRecipientAddress ||
    recordRecipientAddress !== admittedRecipientAddress ||
    !recordRequesterUid
  ) {
    throw new EventPrizeWithdrawalError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  const ownership = await requireProfileOwnershipSnapshot(runtime, {
    loginUids: [],
    profileIds: [params.profileId, recordProfileId],
  });
  const canonicalAdmittedProfileId =
    getCanonicalProfileId(ownership, params.profileId) || "";
  const canonicalRecordProfileId =
    getCanonicalProfileId(ownership, recordProfileId) || "";
  if (
    !canonicalAdmittedProfileId ||
    canonicalAdmittedProfileId !== canonicalRecordProfileId
  ) {
    throw new EventPrizeWithdrawalError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  return { ...params, profileId: canonicalAdmittedProfileId };
}

export function createEventPrizeExecutionProfileReader(
  params: Pick<
    EventPrizeWithdrawalWorkflowParams,
    "profileId" | "requesterUid"
  >,
  runtime: Pick<EventPrizeRuntimeDependencies, "readProfileByLoginUid">,
): EventPrizeRuntimeDependencies["readProfileByLoginUid"] {
  return async (uid) => {
    if (uid !== params.requesterUid) {
      return runtime.readProfileByLoginUid(uid);
    }
    return { id: params.profileId };
  };
}

export async function executeEventPrizeWithdrawal(
  env: Env,
  params: EventPrizeWithdrawalWorkflowParams,
  dependencies: RuntimeOptions = {},
): Promise<EventPrizeWithdrawalCompletedResponse> {
  const runtime = await createEventPrizeRuntimeDependencies(env, dependencies);
  const executionParams = await resolveEventPrizeWithdrawalExecutionParams(
    params,
    runtime,
  );
  const executionRuntime: EventPrizeRuntimeDependencies = {
    ...runtime,
    readProfileByLoginUid: createEventPrizeExecutionProfileReader(
      executionParams,
      runtime,
    ),
    resolveWithdrawalProfileId: async () => executionParams.profileId,
  };
  const result = await handleWithdrawEventPrize(
    {
      auth: { uid: executionParams.requesterUid },
      data: {
        eventId: executionParams.eventId,
        prizeId: executionParams.prizeId,
        solanaAddress: executionParams.recipientAddress,
      },
    },
    executionRuntime,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new EventPrizeWithdrawalError(
      "internal",
      "Prize withdrawal result is unavailable.",
    );
  }
  return buildCompletedResponse(params.operationId, result);
}
