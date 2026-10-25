import { queueFor } from "../queueProducers.ts";
import type { AuthMethodKey } from "@mons/shared/auth";
import {
  isAlphanumericUsername,
  isReservedExplicitUsername,
  USERNAME_MAX_LENGTH,
} from "@mons/shared/usernames";
import { cleanString } from "../authPolicy.ts";
import {
  removeCanonicalAuthRecoveryLoginUid,
  dispatchProfileLinkCatchupForOwner,
  enqueuePersistedCanonicalAuthRecovery,
} from "../authRecovery.ts";
import { createProfileLinkCatchupStore } from "../profileLinkCatchupD1.ts";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  readCanonicalProfileAggregateSnapshot,
} from "../profileCanonicalD1.ts";
import { createUsernameRepository } from "../usernameRepository.ts";
import {
  LINK_METHOD_MAX_ATTEMPTS,
  authFailure,
  expectedMethod,
  hasValidUsername,
  methodFromAggregate,
  methodValue,
  recoveryValue,
} from "./policy.ts";
import type {
  CanonicalIdentityProfile,
  CanonicalIdentityReads,
  RepairedVerifiedCaller,
} from "./types.ts";

const AUTO_NAME_MAX_ATTEMPTS = 30;

export function createCanonicalIdentityRepair({
  db,
  env,
  now,
  randomInteger,
  profileByLogin,
}: {
  db: D1Database;
  env: Env;
  now: () => number;
  randomInteger: (maximum: number) => number;
  profileByLogin: CanonicalIdentityReads["profileByLogin"];
}) {
  const acquireRecoveryBarrier = async (
    uid: string,
  ): Promise<CanonicalIdentityProfile> => {
    for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
      const identityProfile = await profileByLogin(uid);
      const owner = identityProfile?.owner;
      if (!owner || !identityProfile)
        authFailure(409, "aborted", "profile-merged-retry");
      const timestamp = now();
      const recoveryValueForProfile = recoveryValue(
        identityProfile.aggregate.recovery,
        identityProfile.profile.profileId,
        [uid],
        [],
        timestamp,
      );
      try {
        await commitCanonicalPlan(db, {
          expectations: [
            {
              kind: "profile-revision",
              profileId: identityProfile.profile.profileId,
              revision: identityProfile.profile.revision,
            },
            {
              kind: "login-owner-revision",
              loginUid: uid,
              profileId: owner.profileId,
              revision: owner.revision,
            },
            ...(identityProfile.aggregate.recovery
              ? [
                  {
                    kind: "auth-recovery-revision" as const,
                    profileId: identityProfile.profile.profileId,
                    revision: identityProfile.aggregate.recovery.revision,
                  },
                ]
              : [
                  {
                    kind: "auth-recovery-absent" as const,
                    profileId: identityProfile.profile.profileId,
                  },
                ]),
          ],
          mutations: [
            identityProfile.aggregate.recovery
              ? { kind: "update-auth-recovery", value: recoveryValueForProfile }
              : {
                  kind: "insert-auth-recovery",
                  value: recoveryValueForProfile,
                },
          ],
        });
        return identityProfile;
      } catch (error) {
        if (
          !(error instanceof CanonicalProfileConflict) ||
          attempt === LINK_METHOD_MAX_ATTEMPTS - 1
        )
          throw error;
      }
    }
    authFailure(409, "aborted", "profile-merged-retry");
  };

  const repairCurrentCaller = async (
    uid: string,
  ): Promise<CanonicalIdentityProfile> => {
    for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
      const profile = await acquireRecoveryBarrier(uid);
      await dispatchProfileLinkCatchupForOwner(uid, profile.profile.profileId, {
        catchupStore: createProfileLinkCatchupStore(db),
        enqueueProfileLinkProjection: (task) =>
          queueFor(env, "PROFILE_GAME_PROJECTION_QUEUE").send(task),
        logger: console,
      });
      await removeCanonicalAuthRecoveryLoginUid(
        db,
        profile.profile.profileId,
        uid,
        now,
      );
      const confirmed = await profileByLogin(uid);
      if (
        !confirmed ||
        confirmed.profile.profileId !== profile.profile.profileId
      )
        continue;
      if (
        (
          await readCanonicalProfileAggregateSnapshot(
            db,
            profile.profile.profileId,
          )
        ).recovery
      ) {
        try {
          await enqueuePersistedCanonicalAuthRecovery(
            env,
            db,
            profile.profile.profileId,
            now(),
          );
        } catch {
          console.error(
            JSON.stringify({ event: "auth_recovery_enqueue_failure" }),
          );
        }
      }
      return confirmed;
    }
    authFailure(409, "aborted", "profile-merged-retry");
  };

  const assignUsername = async (
    uid: string,
    profile: CanonicalIdentityProfile,
    preferredUsername?: string | null,
  ): Promise<CanonicalIdentityProfile> => {
    if (
      hasValidUsername(profile.profile.profile.username) ||
      methodValue(profile.aggregate, "eth") ||
      methodValue(profile.aggregate, "sol")
    )
      return profile;
    const preferred = cleanString(preferredUsername);
    const preferredCandidate =
      isAlphanumericUsername(preferred) &&
      preferred.length <= USERNAME_MAX_LENGTH &&
      !isReservedExplicitUsername(preferred)
        ? preferred
        : null;
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const randomUsername = () => {
      let value = upper[randomInteger(upper.length)];
      for (let index = 0; index < 3; index++)
        value += lower[randomInteger(lower.length)];
      return `${value}${String(randomInteger(1_000)).padStart(3, "0")}`;
    };
    const repository = createUsernameRepository(env);
    const attempts = AUTO_NAME_MAX_ATTEMPTS + (preferredCandidate ? 1 : 0);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const username =
        attempt === 0 && preferredCandidate
          ? preferredCandidate
          : randomUsername();
      const outcome = await repository.editUsername(uid, username);
      if (outcome === "taken") continue;
      if (outcome === "updated") {
        const refreshed = await profileByLogin(uid);
        if (refreshed) return refreshed;
      }
      authFailure(409, "aborted", "profile-merged-retry");
    }
    authFailure(409, "aborted", "username-generation-exhausted");
  };

  const repairCallerProfile = async (
    uid: string,
  ): Promise<CanonicalIdentityProfile> => {
    let profile = await repairCurrentCaller(uid);
    const xMethod = methodFromAggregate(profile.aggregate, "x");
    if (
      (xMethod || methodFromAggregate(profile.aggregate, "apple")) &&
      !hasValidUsername(profile.profile.profile.username) &&
      !methodFromAggregate(profile.aggregate, "eth") &&
      !methodFromAggregate(profile.aggregate, "sol")
    ) {
      await assignUsername(uid, profile, xMethod?.xUsername);
      profile = await repairCurrentCaller(uid);
    }
    return profile;
  };

  const repairVerifiedCaller = async (
    uid: string,
    method: AuthMethodKey,
    methodValueHash: string,
  ): Promise<RepairedVerifiedCaller | null> => {
    const current = await profileByLogin(uid);
    if (!current || !expectedMethod(current, method, methodValueHash)) {
      return null;
    }
    const identity = await repairCallerProfile(uid);
    const liveMethod = expectedMethod(identity, method, methodValueHash);
    return liveMethod ? { identity, method: liveMethod } : null;
  };

  return { repairCallerProfile, repairVerifiedCaller };
}
