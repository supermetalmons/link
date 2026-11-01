import type {
  AuthMethodKey,
  AuthProfileResponse,
  LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import { createEmptyMaterials, sumMaterials } from "@mons/shared/mining";
import {
  createDefaultProfileAppearance,
  isAura,
} from "@mons/shared/appearance";
import type { StoredPlayerProfile } from "../profileCanonical/contracts.ts";
import {
  isAlphanumericUsername,
  isReservedExplicitUsername,
  USERNAME_MAX_LENGTH,
} from "@mons/shared/usernames";
import { AuthApiFailure } from "../authErrors.ts";
import { matchesVerifiedAuthMethod } from "../authOperationReplay.ts";
import type { LinkInput } from "../authIdentity.ts";
import { cleanString, uniqueStoredLoginUids } from "../authPolicy.ts";
import { newAuthRecoveryJob } from "../authRecovery.ts";
import {
  materializeCanonicalProfile,
  type CanonicalAuthMethodSnapshot,
  type CanonicalAuthMethodValue,
  type CanonicalAuthRecoverySnapshot,
  type CanonicalProfileAggregateSnapshot,
  type CanonicalProfileSnapshot,
} from "../profileCanonicalD1.ts";
import type { CanonicalIdentityProfile } from "./types.ts";

export const LINK_METHOD_MAX_ATTEMPTS = 3;

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function authFailure(
  status: number,
  code: ConstructorParameters<typeof AuthApiFailure>[1],
  message: string,
): never {
  throw new AuthApiFailure(status, code, message);
}

export function methodFromAggregate(
  aggregate: CanonicalProfileAggregateSnapshot,
  method: AuthMethodKey,
): CanonicalAuthMethodSnapshot | null {
  return (
    aggregate.authMethods.find((candidate) => candidate.method === method) ||
    null
  );
}

export function linkedMethods(
  aggregate: CanonicalProfileAggregateSnapshot,
): LinkedAuthMethodsResponse["linkedMethods"] {
  const methods = new Set(aggregate.authMethods.map((method) => method.method));
  return {
    apple: methods.has("apple"),
    eth: methods.has("eth"),
    sol: methods.has("sol"),
    x: methods.has("x"),
  };
}

export function methodValue(
  aggregate: CanonicalProfileAggregateSnapshot,
  method: AuthMethodKey,
): string {
  return methodFromAggregate(aggregate, method)?.normalizedValue || "";
}

export function authMethodValue(
  input: LinkInput,
  profileId: string,
  nowMs: number,
  existing?: CanonicalAuthMethodSnapshot | null,
): CanonicalAuthMethodValue {
  return {
    method: input.method,
    normalizedValue: input.normalizedMethodValue,
    profileId,
    rawValue: input.methodValueRaw,
    appleEmailMasked:
      input.method === "apple"
        ? input.appleEmailMasked || existing?.appleEmailMasked || null
        : null,
    xUsername:
      input.method === "x"
        ? input.xUsername || existing?.xUsername || null
        : null,
    linkedAtMs: input.method === "apple" || input.method === "x" ? nowMs : null,
    consentAtMs:
      input.method === "apple" || input.method === "x" ? nowMs : null,
    consentSource:
      input.method === "apple" || input.method === "x"
        ? input.consentSource || "signin"
        : null,
    createdAtMs: existing?.createdAtMs || nowMs,
    updatedAtMs: nowMs,
  };
}

export function initialProfile(
  input: LinkInput,
  profileId: string,
): StoredPlayerProfile {
  if (!isAura(input.requestAura)) throw new TypeError("invalid-profile-aura");
  return {
    ...createDefaultProfileAppearance(input.requestEmoji),
    id: profileId,
    nonce: -1,
    rating: 1500,
    totalManaPoints: 0,
    win: true,
    aura: input.requestAura,
    username: null,
    eth: input.method === "eth" ? input.methodValueRaw : null,
    sol: input.method === "sol" ? input.methodValueRaw : null,
    feb2026UniqueOpponentsCount: 0,
    completedProblemIds: [],
    isTutorialCompleted: false,
    mining: { lastRockDate: null, materials: createEmptyMaterials() },
  };
}

export function profileWithMethod(
  profile: StoredPlayerProfile,
  input: LinkInput,
): StoredPlayerProfile {
  if (input.method === "eth") {
    return { ...profile, eth: input.methodValueRaw };
  }
  if (input.method === "sol") {
    return { ...profile, sol: input.methodValueRaw };
  }
  return profile;
}

export function profileWithoutMethod(
  profile: StoredPlayerProfile,
  method: AuthMethodKey,
): StoredPlayerProfile {
  if (method === "eth") return { ...profile, eth: null };
  if (method === "sol") return { ...profile, sol: null };
  return profile;
}

export function recoveryValue(
  snapshot: CanonicalAuthRecoverySnapshot | null,
  profileId: string,
  loginUids: string[],
  sourceProfileIds: string[],
  nowMs: number,
) {
  if (!snapshot) {
    return newAuthRecoveryJob(profileId, loginUids, sourceProfileIds, nowMs);
  }
  return {
    profileId,
    loginUids: uniqueStoredLoginUids(snapshot.loginUids, loginUids),
    sourceProfileIds: Array.from(
      new Set([...snapshot.sourceProfileIds, ...sourceProfileIds]),
    ),
    sourcePhase: snapshot.sourcePhase,
    prizeCursor: snapshot.prizeCursor,
    phaseStartedAtMs: snapshot.phaseStartedAtMs,
    lastEnqueuedAtMs: snapshot.lastEnqueuedAtMs,
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs: nowMs,
  };
}

export function profileValue(
  profile: CanonicalProfileSnapshot,
  nextProfile: StoredPlayerProfile,
  updatedAtMs: number,
  overrides: Partial<{
    state: CanonicalProfileSnapshot["state"];
    mergedIntoProfileId: string | null;
    mergedAtMs: number | null;
  }> = {},
) {
  return materializeCanonicalProfile({
    profile: nextProfile,
    state: overrides.state || profile.state,
    mergedIntoProfileId:
      overrides.mergedIntoProfileId === undefined
        ? profile.mergedIntoProfileId
        : overrides.mergedIntoProfileId,
    createdAtMs: profile.createdAtMs,
    updatedAtMs,
    mergedAtMs:
      overrides.mergedAtMs === undefined
        ? profile.mergedAtMs
        : overrides.mergedAtMs,
    sortPresence: profile.sortPresence,
    sortValues: profile.sortValues,
    winPresent: profile.winPresent,
    emojiPresent: profile.emojiPresent,
    gameplayEmoji: profile.gameplayEmoji,
  });
}

function hasMergeValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function mergePreferred<T>(target: T, source: T): T {
  return hasMergeValue(target) ? target : source;
}

function mergeSortValue(
  snapshot: CanonicalProfileSnapshot,
  key: "mp" | "nonce" | "rating",
  fallback: number,
): number {
  const value = snapshot.sortValues[key];
  return snapshot.sortPresence[key] ? (value ?? 0) : fallback;
}

export function mergeProfiles(
  targetSnapshot: CanonicalProfileSnapshot,
  sourceSnapshot: CanonicalProfileSnapshot,
  methods: CanonicalAuthMethodSnapshot[],
): StoredPlayerProfile {
  const target = targetSnapshot.profile;
  const source = sourceSnapshot.profile;
  const dates = [target.mining.lastRockDate, source.mining.lastRockDate]
    .filter((value): value is string => Boolean(value))
    .sort();
  const methodMap = new Map(
    methods.map((method) => [method.method, method.normalizedValue]),
  );
  return {
    ...source,
    ...target,
    id: target.id,
    username:
      cleanString(target.username) || cleanString(source.username) || null,
    eth: methodMap.get("eth") || null,
    sol: methodMap.get("sol") || null,
    rating: Math.min(
      mergeSortValue(targetSnapshot, "rating", 1500),
      mergeSortValue(sourceSnapshot, "rating", 1500),
    ),
    nonce: Math.max(
      mergeSortValue(targetSnapshot, "nonce", -1),
      mergeSortValue(sourceSnapshot, "nonce", -1),
    ),
    totalManaPoints:
      mergeSortValue(targetSnapshot, "mp", 0) +
      mergeSortValue(sourceSnapshot, "mp", 0),
    win: targetSnapshot.winPresent
      ? target.win
      : sourceSnapshot.winPresent
        ? source.win
        : target.win,
    emoji: targetSnapshot.emojiPresent
      ? target.emoji
      : sourceSnapshot.emojiPresent
        ? source.emoji
        : target.emoji,
    aura: mergePreferred(target.aura, source.aura),
    cardBackgroundId: mergePreferred(
      target.cardBackgroundId,
      source.cardBackgroundId,
    ),
    cardSubtitleId: mergePreferred(
      target.cardSubtitleId,
      source.cardSubtitleId,
    ),
    profileCounter: mergePreferred(
      target.profileCounter,
      source.profileCounter,
    ),
    profileMons: mergePreferred(target.profileMons, source.profileMons),
    cardStickers: mergePreferred(target.cardStickers, source.cardStickers),
    completedProblemIds: [
      ...new Set([
        ...target.completedProblemIds,
        ...source.completedProblemIds,
      ]),
    ],
    isTutorialCompleted:
      target.isTutorialCompleted === true ||
      source.isTutorialCompleted === true,
    feb2026UniqueOpponentsCount: Math.max(
      target.feb2026UniqueOpponentsCount || 0,
      source.feb2026UniqueOpponentsCount || 0,
    ),
    mining: {
      lastRockDate: dates.at(-1) || null,
      materials: sumMaterials(target.mining.materials, source.mining.materials),
    },
  };
}

export function profileResponse(
  identityProfile: CanonicalIdentityProfile,
  uid: string,
  opId: string,
): AuthProfileResponse {
  const snapshot = identityProfile.profile;
  const profile = snapshot.profile;
  const methods = linkedMethods(identityProfile.aggregate);
  const eth = methodFromAggregate(identityProfile.aggregate, "eth");
  const sol = methodFromAggregate(identityProfile.aggregate, "sol");
  return {
    ok: true,
    uid,
    profileId: profile.id,
    username: cleanString(profile.username) || null,
    eth: eth?.normalizedValue || null,
    sol: sol?.normalizedValue || null,
    linkedMethods: methods,
    appleLinked: methods.apple,
    emoji: profile.emoji,
    aura: profile.aura,
    rating: snapshot.sortPresence.rating ? snapshot.sortValues.rating : null,
    nonce: snapshot.sortPresence.nonce ? snapshot.sortValues.nonce : null,
    totalManaPoints: snapshot.sortPresence.mp ? snapshot.sortValues.mp : null,
    cardBackgroundId: profile.cardBackgroundId,
    cardStickers: profile.cardStickers,
    cardSubtitleId: profile.cardSubtitleId,
    profileCounter: profile.profileCounter,
    profileMons: profile.profileMons,
    completedProblems: profile.completedProblemIds,
    tutorialCompleted: profile.isTutorialCompleted,
    mining: profile.mining,
    opId,
  };
}

export const hasValidUsername = (value: unknown): boolean => {
  const username = cleanString(value);
  return (
    isAlphanumericUsername(username) &&
    username.length <= USERNAME_MAX_LENGTH &&
    !isReservedExplicitUsername(username)
  );
};

export const expectedMethod = (
  profile: CanonicalIdentityProfile,
  method: AuthMethodKey,
  methodValueHash: string,
): CanonicalAuthMethodSnapshot | null => {
  const current = methodFromAggregate(profile.aggregate, method);
  return current &&
    matchesVerifiedAuthMethod(method, current.normalizedValue, methodValueHash)
    ? current
    : null;
};
