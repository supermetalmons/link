import { resolveProfileMergeTargetPath } from "../../../../runtime/profileMergeTargets.js";
import { EventPrizeWithdrawalError } from "../../../../runtime/eventPrizes/errors.js";
import {
  createEventPrizeRepository,
  type EventPrizeRepository,
} from "../eventPrizeRepository.ts";
import {
  createD1EventPrizeWithdrawalStore,
  readEventPrizeWithdrawalStorageMode,
  type EventPrizeWithdrawalStore,
} from "../eventPrizeWithdrawalD1.ts";
import { readCanonicalMergeTarget } from "../profileCanonical/profiles.ts";
import {
  getCanonicalProfileId,
  getLoginProfileId,
  profileOwnershipUnavailable,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipReader,
} from "../profileOwnership.ts";

export type EventPrizeContext = {
  withdrawals: EventPrizeWithdrawalStore;
  readProfileEventPrizeAssignment: EventPrizeRepository["readProfileEventPrizeAssignment"];
  now(): number;
  readWithdrawal(
    eventId: string,
    prizeId: string,
  ): Promise<Record<string, unknown> | null>;
  readProfileByLoginUid(uid: string): Promise<{ id: string } | null>;
  readProfileOwnershipSnapshot: ProfileOwnershipReader["readProfileOwnershipSnapshot"];
  removeMatchingProfileEventPrizeAssignment: EventPrizeRepository["removeMatchingProfileEventPrizeAssignment"];
  resolveWithdrawalProfileId(profileId: string): Promise<string>;
  resolveCanonicalProfilePath(profileId: string): Promise<string[]>;
};

export type EventPrizeStatusDependencies = Pick<
  EventPrizeContext,
  | "readWithdrawal"
  | "readProfileOwnershipSnapshot"
  | "readProfileEventPrizeAssignment"
>;

export type EventPrizeRequestDependencies = EventPrizeStatusDependencies &
  Pick<
    EventPrizeContext,
    "removeMatchingProfileEventPrizeAssignment" | "resolveCanonicalProfilePath"
  > & {
    withdrawals: Pick<EventPrizeWithdrawalStore, "record">;
  };

export type EventPrizeGameplayRepository = EventPrizeRepository;

export type RuntimeOptions = {
  now?: () => number;
  profileDb?: D1Database;
  repository?: EventPrizeGameplayRepository;
  withdrawalStore?: EventPrizeWithdrawalStore;
};

export async function createEventPrizeContext(
  env: Env,
  {
    allowFrozen = false,
    now = Date.now,
    profileDb = env.PROFILE_DB,
    repository = createEventPrizeRepository(env.PROFILE_DB, env.EVENT_DB),
    withdrawalStore: withdrawalStoreOverride,
  }: RuntimeOptions & { allowFrozen?: boolean } = {},
): Promise<EventPrizeContext> {
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
    now,
    readWithdrawal: withdrawalStore.get,
    readProfileByLoginUid,
    readProfileOwnershipSnapshot: repository.readProfileOwnershipSnapshot,
    removeMatchingProfileEventPrizeAssignment: (input) =>
      repository.removeMatchingProfileEventPrizeAssignment(input),
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
