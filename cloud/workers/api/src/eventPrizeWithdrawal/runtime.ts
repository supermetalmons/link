import {
  getEventPrizeDefinition,
  type EventPrizeWithdrawalCompletedResponse,
} from "@mons/shared/event-prizes";
import { resolveProfileMergeTargetPath } from "../../../../runtime/profileMergeTargets.js";
import {
  isMatchingProfileEventPrizeAssignment,
  isWithdrawalRecordForPrize,
  normalizeSolanaAddress,
} from "../../../../runtime/eventPrizeWithdrawalState.js";
import { EventPrizeWithdrawalError } from "../../../../runtime/eventPrizes/errors.js";
import { createEventPrizeUmi as createConfiguredEventPrizeUmi } from "../../../../runtime/eventPrizes/solana.js";
import { handleWithdrawEventPrize } from "../../../../runtime/eventPrizes/withdrawalOrchestrator.js";
import {
  createEventGameplayRepository,
  type EventGameplayRepository,
} from "../eventRepository.ts";
import {
  createD1EventPrizeWithdrawalStore,
  readEventPrizeWithdrawalStorageMode,
  type EventPrizeWithdrawalStore,
} from "../eventPrizeWithdrawalD1.ts";
import { readCanonicalMergeTarget } from "../profileCanonicalD1.ts";
import {
  getCanonicalProfileId,
  getLoginProfileId,
  profileOwnershipUnavailable,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipReader,
} from "../profileOwnership.ts";
import {
  buildCompletedResponse,
  cleanString,
  toRecord,
  type EventPrizeWithdrawalWorkflowParams,
} from "./contracts.ts";

export type EventPrizeRuntimeDependencies = {
  withdrawals: EventPrizeWithdrawalStore;
  readProfileEventPrizeAssignment: EventGameplayRepository["readProfileEventPrizeAssignment"];
  createEventPrizeUmi(standard: "compressed" | "core"): unknown;
  now(): number;
  readWithdrawal(
    eventId: string,
    prizeId: string,
  ): Promise<Record<string, unknown> | null>;
  readProfileByLoginUid(uid: string): Promise<{ id: string } | null>;
  readProfileOwnershipSnapshot: ProfileOwnershipReader["readProfileOwnershipSnapshot"];
  removeMatchingProfileEventPrizeAssignment(input: {
    profileId: string;
    eventId: string;
    prizeId: string;
  }): Promise<boolean>;
  resolveWithdrawalProfileId(profileId: string): Promise<string>;
  resolveCanonicalProfilePath(profileId: string): Promise<string[]>;
};

export type EventPrizeGameplayRepository = Pick<
  EventGameplayRepository,
  | "readProfileOwnershipSnapshot"
  | "readProfileEventPrizeAssignment"
  | "transactProfileEventPrize"
>;

export type RuntimeOptions = {
  now?: () => number;
  profileDb?: D1Database;
  repository?: EventPrizeGameplayRepository;
  withdrawalStore?: EventPrizeWithdrawalStore;
};

export async function createEventPrizeRuntimeDependencies(
  env: Env,
  {
    allowFrozen = false,
    now = Date.now,
    profileDb = env.PROFILE_DB,
    repository = createEventGameplayRepository(env),
    withdrawalStore: withdrawalStoreOverride,
  }: RuntimeOptions & { allowFrozen?: boolean } = {},
): Promise<EventPrizeRuntimeDependencies> {
  const storageMode = await readEventPrizeWithdrawalStorageMode(
    env.EVENT_PRIZE_WITHDRAWALS_DB,
  );
  if (storageMode === "frozen" && !allowFrozen) {
    throw new EventPrizeWithdrawalError(
      "unavailable",
      "Prize withdrawals are temporarily unavailable.",
    );
  }
  const withdrawalStore =
    withdrawalStoreOverride ||
    createD1EventPrizeWithdrawalStore(env.EVENT_PRIZE_WITHDRAWALS_DB, { now });
  const readProfileByLoginUid = async (uid: string) => {
    const ownership = await requireProfileOwnershipSnapshot(repository, {
      loginUids: [uid],
      profileIds: [],
    });
    const profileId = getLoginProfileId(ownership, uid);
    return profileId ? { id: profileId } : null;
  };
  const resolveCanonicalProfilePath = async (profileId: string) => {
    try {
      return await resolveProfileMergeTargetPath({
        profileId,
        readMergeTarget: async (candidateProfileId: string) => {
          const target = await readCanonicalMergeTarget(
            profileDb,
            candidateProfileId,
          );
          return target ? { targetProfileId: target.targetProfileId } : null;
        },
      });
    } catch {
      throw profileOwnershipUnavailable();
    }
  };
  return {
    withdrawals: withdrawalStore,
    readProfileEventPrizeAssignment: (profileId, eventId, signal) =>
      repository.readProfileEventPrizeAssignment(profileId, eventId, signal),
    createEventPrizeUmi: (standard) =>
      createConfiguredEventPrizeUmi(standard, {
        adminPrivateKey: env.EVENT_PRIZE_ADMIN_PRIVATE_KEY,
        heliusRpcApiKey: env.HELIUS_RPC_API_KEY,
      }),
    now,
    readWithdrawal: withdrawalStore.get,
    readProfileByLoginUid,
    readProfileOwnershipSnapshot: repository.readProfileOwnershipSnapshot,
    async removeMatchingProfileEventPrizeAssignment({
      profileId,
      eventId,
      prizeId,
    }) {
      const result = await repository.transactProfileEventPrize(
        profileId,
        eventId,
        (currentAssignment) =>
          isMatchingProfileEventPrizeAssignment(
            currentAssignment,
            eventId,
            prizeId,
          )
            ? { value: null }
            : { value: currentAssignment ?? null },
      );
      return result.committed && result.value === null;
    },
    async resolveWithdrawalProfileId(profileId) {
      const ownership = await requireProfileOwnershipSnapshot(repository, {
        loginUids: [],
        profileIds: [profileId],
      });
      return getCanonicalProfileId(ownership, profileId) || "";
    },
    resolveCanonicalProfilePath,
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
  const recordProfileId = cleanString(withdrawal?.profileId);
  const recordRecipientAddress = normalizeSolanaAddress(
    withdrawal?.recipientAddress,
  );
  const recordRequesterUid = cleanString(withdrawal?.requesterUid);
  const admittedRecipientAddress = normalizeSolanaAddress(
    params.recipientAddress,
  );
  const status = cleanString(withdrawal?.status);
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
  const repository =
    dependencies.repository || createEventGameplayRepository(env);
  const runtime = await createEventPrizeRuntimeDependencies(env, {
    ...dependencies,
    repository,
  });
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
  const completed = toRecord(result);
  if (!completed) {
    throw new EventPrizeWithdrawalError(
      "internal",
      "Prize withdrawal result is unavailable.",
    );
  }
  return buildCompletedResponse(params.operationId, completed);
}
