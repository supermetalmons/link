import { AUTH_METHODS } from "@mons/shared/auth";
import { buildUsernameLookupKey } from "@mons/shared/usernames";
import type { LinkInput } from "../authIdentity.ts";
import { secureAlphanumericId } from "../authRandom.ts";
import {
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalAuthMethod,
  readCanonicalMergeTarget,
  readCanonicalProfileAggregateSnapshot,
  readCanonicalProfileAggregateByLogin,
  resolveCanonicalProfile,
  type CanonicalAuthMethodSnapshot,
  type CanonicalExpectation,
  type CanonicalMutation,
} from "../profileCanonicalD1.ts";
import { cooldownPlan } from "./cooldowns.ts";
import {
  LINK_METHOD_MAX_ATTEMPTS,
  authFailure,
  authMethodValue,
  initialProfile,
  mergeProfiles,
  methodFromAggregate,
  profileValue,
  profileWithMethod,
  recoveryValue,
} from "./policy.ts";
import type { CanonicalIdentityProfile } from "./types.ts";

const CANONICAL_AUTH_COMMIT_QUERY_BUDGET = 500;

export function createCanonicalIdentityProfiles({
  db,
  now,
}: {
  db: D1Database;
  now: () => number;
}) {
  const identityByProfile = async (
    profileId: string,
  ): Promise<CanonicalIdentityProfile | null> => {
    for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
      const resolved = await resolveCanonicalProfile(db, profileId);
      if (!resolved) return null;
      const aggregate = await readCanonicalProfileAggregateSnapshot(
        db,
        resolved.profileId,
      );
      const profile = aggregate.profile;
      if (profile?.state === "active") {
        return { profile, aggregate, owner: null };
      }
    }
    throw new CanonicalProfileConflict();
  };

  const profileByLogin = async (
    uid: string,
  ): Promise<CanonicalIdentityProfile | null> => {
    const resolved = await readCanonicalProfileAggregateByLogin(db, uid);
    if (!resolved) return null;
    const profile = resolved.aggregate.profile;
    if (!profile || resolved.owner.profileId !== profile.profileId) {
      throw new CanonicalProfileCorruption();
    }
    return {
      aggregate: resolved.aggregate,
      owner: resolved.owner,
      profile,
    };
  };

  const createInitial = async (input: LinkInput): Promise<string> => {
    for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
      const current = await profileByLogin(input.uid);
      if (current) return current.profile.profileId;
      const methodOwner = await readCanonicalAuthMethod(
        db,
        input.method,
        input.normalizedMethodValue,
      );
      if (methodOwner) return methodOwner.profileId;
      const timestamp = now();
      const cooldown = await cooldownPlan(
        db,
        null,
        input.method,
        input.normalizedMethodValue,
        timestamp,
      );
      const profileId = secureAlphanumericId();
      const value = materializeCanonicalProfile({
        profile: initialProfile(input, profileId),
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
        sortPresence: {
          rating: false,
          mp: false,
          nonce: false,
          dust: true,
          slime: true,
          gum: true,
          metal: true,
          ice: true,
        },
        winPresent: false,
        emojiPresent: true,
        gameplayEmoji: input.requestEmoji,
      });
      try {
        await commitCanonicalPlan(db, {
          expectations: [
            { kind: "profile-absent", profileId },
            { kind: "login-owner-absent", loginUid: input.uid },
            {
              kind: "auth-method-absent",
              method: input.method,
              normalizedValue: input.normalizedMethodValue,
            },
            { kind: "auth-recovery-absent", profileId },
            ...cooldown.expectations,
          ],
          mutations: [
            ...cooldown.mutations,
            { kind: "insert-active-profile", value },
            {
              kind: "insert-login-owner",
              value: {
                loginUid: input.uid,
                profileId,
                createdAtMs: timestamp,
                updatedAtMs: timestamp,
              },
            },
            {
              kind: "insert-auth-method",
              value: authMethodValue(input, profileId, timestamp),
            },
            {
              kind: "insert-auth-recovery",
              value: recoveryValue(null, profileId, [input.uid], [], timestamp),
            },
          ],
        });
        return profileId;
      } catch (error) {
        if (
          !(error instanceof CanonicalProfileConflict) ||
          attempt === LINK_METHOD_MAX_ATTEMPTS - 1
        )
          throw error;
      }
    }
    authFailure(409, "aborted", "method-index-race-retry");
  };

  const attachMethod = async (
    input: LinkInput,
    profileId: string,
  ): Promise<
    | { kind: "linked" }
    | { kind: "login-profile" | "method-profile"; profileId: string }
  > => {
    const identityProfile = await identityByProfile(profileId);
    const aggregate = identityProfile?.aggregate;
    const profile = identityProfile?.profile;
    if (!aggregate || !profile)
      authFailure(404, "not-found", "profile-not-found");
    const activeProfileId = profile.profileId;
    const loginProfile = await profileByLogin(input.uid);
    const loginOwner = loginProfile?.owner || null;
    if (loginProfile && loginProfile.profile.profileId !== activeProfileId) {
      return {
        kind: "login-profile",
        profileId: loginProfile.profile.profileId,
      };
    }
    const existing = methodFromAggregate(aggregate, input.method);
    if (existing && existing.normalizedValue !== input.normalizedMethodValue) {
      authFailure(
        409,
        "failed-precondition",
        "method-already-linked-different",
      );
    }
    const methodOwner = await readCanonicalAuthMethod(
      db,
      input.method,
      input.normalizedMethodValue,
    );
    if (methodOwner && methodOwner.profileId !== activeProfileId) {
      const methodProfile = await identityByProfile(methodOwner.profileId);
      if (!methodProfile) throw new CanonicalProfileCorruption();
      if (methodProfile.profile.profileId !== activeProfileId) {
        return {
          kind: "method-profile",
          profileId: methodProfile.profile.profileId,
        };
      }
    }
    const timestamp = now();
    const cooldown = existing
      ? { expectations: [], mutations: [] }
      : await cooldownPlan(
          db,
          activeProfileId,
          input.method,
          input.normalizedMethodValue,
          timestamp,
        );
    const recovery = recoveryValue(
      aggregate.recovery,
      activeProfileId,
      [input.uid],
      [],
      timestamp,
    );
    const expectations: CanonicalExpectation[] = [
      {
        kind: "profile-revision",
        profileId: activeProfileId,
        revision: profile.revision,
      },
      ...(loginOwner
        ? [
            {
              kind: "login-owner-revision" as const,
              loginUid: input.uid,
              profileId: activeProfileId,
              revision: loginOwner.revision,
            },
          ]
        : [{ kind: "login-owner-absent" as const, loginUid: input.uid }]),
      ...(methodOwner
        ? [
            {
              kind: "auth-method-revision" as const,
              method: input.method,
              normalizedValue: input.normalizedMethodValue,
              profileId: activeProfileId,
              revision: methodOwner.revision,
            },
          ]
        : [
            {
              kind: "auth-method-absent" as const,
              method: input.method,
              normalizedValue: input.normalizedMethodValue,
            },
          ]),
      ...(aggregate.recovery
        ? [
            {
              kind: "auth-recovery-revision" as const,
              profileId: activeProfileId,
              revision: aggregate.recovery.revision,
            },
          ]
        : [
            {
              kind: "auth-recovery-absent" as const,
              profileId: activeProfileId,
            },
          ]),
      ...cooldown.expectations,
    ];
    const mutations: CanonicalMutation[] = [
      ...cooldown.mutations,
      {
        kind: "update-active-profile",
        value: profileValue(
          profile,
          profileWithMethod(profile.profile, input),
          timestamp,
        ),
      },
      ...(!loginOwner
        ? [
            {
              kind: "insert-login-owner" as const,
              value: {
                loginUid: input.uid,
                profileId: activeProfileId,
                createdAtMs: timestamp,
                updatedAtMs: timestamp,
              },
            },
          ]
        : []),
      methodOwner
        ? {
            kind: "update-auth-method",
            value: authMethodValue(
              input,
              activeProfileId,
              timestamp,
              methodOwner,
            ),
          }
        : {
            kind: "insert-auth-method",
            value: authMethodValue(input, activeProfileId, timestamp),
          },
      aggregate.recovery
        ? { kind: "update-auth-recovery", value: recovery }
        : { kind: "insert-auth-recovery", value: recovery },
    ];
    await commitCanonicalPlan(db, { expectations, mutations });
    return { kind: "linked" };
  };

  const mergeIdentityProfiles = async (
    targetProfileId: string,
    sourceProfileId: string,
    opId: string,
  ): Promise<string> => {
    if (targetProfileId === sourceProfileId) return targetProfileId;
    const targetIdentity = await identityByProfile(targetProfileId);
    const sourceIdentity = await identityByProfile(sourceProfileId);
    if (!targetIdentity)
      authFailure(404, "not-found", "target-profile-not-found");
    if (!sourceIdentity)
      authFailure(404, "not-found", "source-profile-not-found");
    const target = targetIdentity.aggregate;
    const source = sourceIdentity.aggregate;
    const targetProfile = targetIdentity.profile;
    const sourceProfile = sourceIdentity.profile;
    const resolvedTargetProfileId = targetProfile.profileId;
    const resolvedSourceProfileId = sourceProfile.profileId;
    if (resolvedTargetProfileId === resolvedSourceProfileId) {
      return resolvedTargetProfileId;
    }
    if (target.recovery || source.recovery)
      authFailure(409, "aborted", "merge-recovery-pending");
    const existingMapping = await readCanonicalMergeTarget(
      db,
      resolvedSourceProfileId,
    );
    if (existingMapping) {
      if (existingMapping.targetProfileId !== resolvedTargetProfileId)
        authFailure(
          409,
          "failed-precondition",
          "profile-merge-target-conflict",
        );
      return resolvedTargetProfileId;
    }
    if (await readCanonicalMergeTarget(db, resolvedTargetProfileId))
      authFailure(409, "failed-precondition", "target-profile-already-merged");
    for (const method of AUTH_METHODS) {
      const targetMethod = methodFromAggregate(target, method);
      const sourceMethod = methodFromAggregate(source, method);
      if (
        targetMethod &&
        sourceMethod &&
        targetMethod.normalizedValue !== sourceMethod.normalizedValue
      ) {
        authFailure(409, "failed-precondition", "merge-method-conflict");
      }
    }
    const timestamp = now();
    const finalMethods = AUTH_METHODS.map(
      (method) =>
        methodFromAggregate(target, method) ||
        methodFromAggregate(source, method),
    ).filter((method): method is CanonicalAuthMethodSnapshot =>
      Boolean(method),
    );
    const merged = mergeProfiles(targetProfile, sourceProfile, finalMethods);
    const usernameKey = merged.username
      ? buildUsernameLookupKey(merged.username)
      : "";
    let usernameOwner: { profile_id: string; revision: number } | null = null;
    if (usernameKey) {
      usernameOwner = await db
        .prepare(
          "SELECT profile_id, revision FROM profile_records_canonical WHERE username_key = ?",
        )
        .bind(usernameKey)
        .first<{ profile_id: string; revision: number }>();
      if (
        usernameOwner &&
        usernameOwner.profile_id !== resolvedTargetProfileId &&
        usernameOwner.profile_id !== resolvedSourceProfileId
      ) {
        authFailure(409, "failed-precondition", "username-index-conflict");
      }
    }
    const loginOwners = [...target.loginOwners, ...source.loginOwners];
    const expectations: CanonicalExpectation[] = [
      {
        kind: "profile-revision",
        profileId: resolvedTargetProfileId,
        revision: targetProfile.revision,
      },
      {
        kind: "profile-revision",
        profileId: resolvedSourceProfileId,
        revision: sourceProfile.revision,
      },
      { kind: "merge-target-absent", sourceProfileId: resolvedSourceProfileId },
      {
        kind: "merge-target-absent",
        sourceProfileId: resolvedTargetProfileId,
      },
      { kind: "auth-recovery-absent", profileId: resolvedTargetProfileId },
      { kind: "auth-recovery-absent", profileId: resolvedSourceProfileId },
      {
        kind: "login-owner-set",
        profileId: resolvedTargetProfileId,
        owners: target.loginOwners,
      },
      {
        kind: "login-owner-set",
        profileId: resolvedSourceProfileId,
        owners: source.loginOwners,
      },
      ...source.authMethods.map((method) => ({
        kind: "auth-method-revision" as const,
        method: method.method,
        normalizedValue: method.normalizedValue,
        profileId: resolvedSourceProfileId,
        revision: method.revision,
      })),
      ...(usernameOwner
        ? [
            {
              kind: "username-owner" as const,
              usernameKey,
              profileId: usernameOwner.profile_id,
              revision: usernameOwner.revision,
            },
          ]
        : usernameKey
          ? [{ kind: "username-absent" as const, usernameKey }]
          : []),
    ];
    const retiredSource = profileValue(
      sourceProfile,
      { ...sourceProfile.profile, username: null, eth: null, sol: null },
      timestamp,
      {
        state: "retiring",
        mergedIntoProfileId: resolvedTargetProfileId,
        mergedAtMs: timestamp,
      },
    );
    const mergedSortPresence = {
      rating: true,
      mp: true,
      nonce: true,
      dust: true,
      slime: true,
      gum: true,
      metal: true,
      ice: true,
    } as const;
    const mergedValue = materializeCanonicalProfile({
      profile: merged,
      state: targetProfile.state,
      mergedIntoProfileId: targetProfile.mergedIntoProfileId,
      createdAtMs: targetProfile.createdAtMs,
      updatedAtMs: timestamp,
      mergedAtMs: timestamp,
      sortPresence: mergedSortPresence,
      sortValues: {
        rating: merged.rating,
        mp: merged.totalManaPoints,
        nonce: merged.nonce,
        ...merged.mining.materials,
      },
      winPresent: targetProfile.winPresent || sourceProfile.winPresent,
      emojiPresent: targetProfile.emojiPresent || sourceProfile.emojiPresent,
      gameplayEmoji: targetProfile.emojiPresent
        ? targetProfile.gameplayEmoji
        : sourceProfile.emojiPresent
          ? sourceProfile.gameplayEmoji
          : targetProfile.gameplayEmoji,
    });
    const mutations: CanonicalMutation[] = [
      {
        kind: "retire-profile-with-redirect",
        profile: retiredSource,
        redirect: {
          sourceProfileId: resolvedSourceProfileId,
          targetProfileId: resolvedTargetProfileId,
          mergedAtMs: timestamp,
          opId,
        },
      },
      { kind: "update-active-profile", value: mergedValue },
      {
        kind: "move-login-owner-set",
        sourceProfileId: resolvedSourceProfileId,
        targetProfileId: resolvedTargetProfileId,
        updatedAtMs: timestamp,
      },
      ...source.authMethods.map((method) => ({
        kind: "update-auth-method" as const,
        value: {
          ...method,
          profileId: resolvedTargetProfileId,
          updatedAtMs: timestamp,
        },
      })),
      {
        kind: "insert-auth-recovery",
        value: recoveryValue(
          null,
          resolvedTargetProfileId,
          loginOwners.map((owner) => owner.loginUid),
          [resolvedSourceProfileId],
          timestamp,
        ),
      },
    ];
    const plan = { expectations, mutations };
    await commitCanonicalPlan(db, plan, {
      maxStatements: CANONICAL_AUTH_COMMIT_QUERY_BUDGET,
    });
    return resolvedTargetProfileId;
  };

  return {
    identityByProfile,
    profileByLogin,
    createInitial,
    attachMethod,
    mergeIdentityProfiles,
  };
}
