import {
  AUTH_COOLDOWN_REASONS,
  AUTH_METHODS,
  AUTH_METHOD_REUSE_COOLDOWN_MS,
  getAuthCooldownScope,
  isAuthProfileResponse,
  isLinkedAuthMethodsResponse,
  type AuthMethodKey,
  type AuthProfileResponse,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import { normalizeMiningSnapshot, sumMaterials } from "@mons/shared/mining";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import {
  buildUsernameLookupKey,
  isAlphanumericUsername,
  isReservedExplicitUsername,
  USERNAME_MAX_LENGTH,
} from "@mons/shared/usernames";
import { AuthApiFailure } from "./authErrors.ts";
import {
  createAuthStateRepository,
  type AuthIntentRecord,
} from "./authStateD1.ts";
import type {
  AuthIdentityService,
  AuthIntent,
  LinkInput,
  ServiceDependencies,
} from "./authIdentity.ts";
import {
  createFirebaseAuthAdminClient,
  type FirebaseAuthAdminClient,
} from "./firebaseAuthAdmin.ts";
import {
  createFirebaseRtdbClient,
  type FirebaseRtdbClient,
} from "./firebaseRtdb.ts";
import {
  cleanString,
  finiteNumber,
  hashMethodValue,
  normalizeMethodValue,
  readStoredFirebaseUid,
  throwMethodCooldown,
  throwProfileMethodCooldown,
  uniqueStoredFirebaseUids,
  uniqueStrings,
} from "./authPolicy.ts";
import {
  createAuthRecoveryService,
  enqueuePersistedCanonicalAuthRecovery,
  ensureFirebaseProfileClaim,
  newAuthRecoveryJob,
} from "./authRecovery.ts";
import { createProfileLinkCatchupStore } from "./profileLinkCatchupD1.ts";
import { secureAlphanumericId } from "./authRandom.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";
import {
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  countCanonicalCommitStatements,
  materializeCanonicalProfile,
  readCanonicalAuthMethod,
  readCanonicalAuthOperation,
  readCanonicalMergeTarget,
  readStableCanonicalProfileAggregate,
  readStableCanonicalProfileAggregateByLogin,
  resolveCanonicalProfile,
  type CanonicalAuthMethodSnapshot,
  type CanonicalAuthMethodValue,
  type CanonicalAuthOperationSnapshot,
  type CanonicalAuthOperationValue,
  type CanonicalAuthRecoverySnapshot,
  type CanonicalCooldownValue,
  type CanonicalExpectation,
  type CanonicalMethodRevocationValue,
  type CanonicalMutation,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalProfileAggregateSnapshot,
  type CanonicalProfileSnapshot,
} from "./profileCanonicalD1.ts";
import { createUsernameRepository } from "./usernameRepository.ts";

const AUTH_OP_REPLAY_TTL_MS = 10 * 60 * 1_000;
const LINK_METHOD_MAX_ATTEMPTS = 3;
const AUTO_NAME_MAX_ATTEMPTS = 30;
const CANONICAL_AUTH_COMMIT_QUERY_BUDGET = 500;

type CanonicalIdentityDependencies = ServiceDependencies & {
  authClient?: FirebaseAuthAdminClient;
  rtdb?: FirebaseRtdbClient;
};

type CanonicalCooldownRow = {
  revision: number;
  retry_at_ms: number;
};

type CanonicalIdentityProfile = {
  aggregate: CanonicalProfileAggregateSnapshot;
  owner: CanonicalLoginOwnerSnapshot | null;
  profile: CanonicalProfileSnapshot;
};

type RepairedVerifiedCaller = {
  identity: CanonicalIdentityProfile;
  method: CanonicalAuthMethodSnapshot;
};

type CooldownPlan = {
  expectations: CanonicalExpectation[];
  mutations: CanonicalMutation[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function authFailure(
  status: number,
  code: ConstructorParameters<typeof AuthApiFailure>[1],
  message: string,
): never {
  throw new AuthApiFailure(status, code, message);
}

function methodFromAggregate(
  aggregate: CanonicalProfileAggregateSnapshot,
  method: AuthMethodKey,
): CanonicalAuthMethodSnapshot | null {
  return (
    aggregate.authMethods.find((candidate) => candidate.method === method) ||
    null
  );
}

function linkedMethods(
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

function methodValue(
  aggregate: CanonicalProfileAggregateSnapshot,
  method: AuthMethodKey,
): string {
  return methodFromAggregate(aggregate, method)?.normalizedValue || "";
}

function authMethodValue(
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

function initialProfile(
  input: LinkInput,
  profileId: string,
): CompletePlayerProfile {
  return {
    id: profileId,
    nonce: -1,
    rating: 1500,
    totalManaPoints: 0,
    win: true,
    emoji: input.requestEmoji,
    ...(input.requestAura ? { aura: input.requestAura } : {}),
    username: null,
    eth: input.method === "eth" ? input.methodValueRaw : null,
    sol: input.method === "sol" ? input.methodValueRaw : null,
    feb2026UniqueOpponentsCount: 0,
    mining: normalizeMiningSnapshot(),
  };
}

function profileWithMethod(
  profile: CompletePlayerProfile,
  input: LinkInput,
): CompletePlayerProfile {
  if (input.method === "eth") {
    return { ...profile, eth: input.methodValueRaw };
  }
  if (input.method === "sol") {
    return { ...profile, sol: input.methodValueRaw };
  }
  return profile;
}

function profileWithoutMethod(
  profile: CompletePlayerProfile,
  method: AuthMethodKey,
): CompletePlayerProfile {
  if (method === "eth") return { ...profile, eth: null };
  if (method === "sol") return { ...profile, sol: null };
  return profile;
}

function recoveryValue(
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
    loginUids: uniqueStoredFirebaseUids(snapshot.loginUids, loginUids),
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

function profileValue(
  profile: CanonicalProfileSnapshot,
  nextProfile: CompletePlayerProfile,
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
    legacyFields: profile.legacyFields,
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

function mergePreferred<T>(
  target: T | undefined,
  source: T | undefined,
): T | undefined {
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

function mergeProfiles(
  targetSnapshot: CanonicalProfileSnapshot,
  sourceSnapshot: CanonicalProfileSnapshot,
  methods: CanonicalAuthMethodSnapshot[],
): CompletePlayerProfile {
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
    completedProblemIds: uniqueStrings(
      target.completedProblemIds,
      source.completedProblemIds,
    ),
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

function profileResponse(
  identityProfile: CanonicalIdentityProfile,
  uid: string,
  opId: string,
): AuthProfileResponse {
  const snapshot = identityProfile.profile;
  const profile = snapshot.profile;
  const methods = linkedMethods(identityProfile.aggregate);
  const eth = methodFromAggregate(identityProfile.aggregate, "eth");
  const sol = methodFromAggregate(identityProfile.aggregate, "sol");
  const emoji = snapshot.emojiPresent
    ? Math.floor(finiteNumber(profile.emoji, 1))
    : 1;
  return {
    ok: true,
    uid,
    profileId: profile.id,
    username: cleanString(profile.username) || null,
    eth: eth?.normalizedValue || null,
    sol: sol?.normalizedValue || null,
    linkedMethods: methods,
    appleLinked: methods.apple,
    emoji: emoji > 0 ? emoji : 1,
    aura: cleanString(profile.aura) || null,
    rating: snapshot.sortPresence.rating ? snapshot.sortValues.rating : null,
    nonce: snapshot.sortPresence.nonce ? snapshot.sortValues.nonce : null,
    totalManaPoints: snapshot.sortPresence.mp ? snapshot.sortValues.mp : null,
    cardBackgroundId: profile.cardBackgroundId ?? null,
    cardStickers: profile.cardStickers ?? null,
    cardSubtitleId: profile.cardSubtitleId ?? null,
    profileCounter: cleanString(profile.profileCounter) || null,
    profileMons: profile.profileMons ?? null,
    completedProblems: profile.completedProblemIds ?? null,
    tutorialCompleted: profile.isTutorialCompleted ?? null,
    mining: normalizeMiningSnapshot(profile.mining),
    opId,
  };
}

async function cooldownPlan(
  db: D1Database,
  profileId: string | null,
  method: AuthMethodKey,
  normalizedValue: string,
  nowMs: number,
): Promise<CooldownPlan> {
  const results = await db.batch([
    db
      .prepare(
        `SELECT revision, retry_at_ms FROM profile_auth_method_revocations
         WHERE method = ? AND normalized_value = ?`,
      )
      .bind(method, normalizedValue),
    ...(profileId
      ? [
          db
            .prepare(
              `SELECT revision, retry_at_ms FROM profile_auth_method_cooldowns
               WHERE profile_id = ? AND method = ?`,
            )
            .bind(profileId, method),
        ]
      : []),
  ]);
  const expectations: CanonicalExpectation[] = [];
  const mutations: CanonicalMutation[] = [];
  const revocation = results[0].results[0] as CanonicalCooldownRow | undefined;
  if (revocation) {
    if (
      !Number.isSafeInteger(revocation.revision) ||
      !Number.isSafeInteger(revocation.retry_at_ms)
    ) {
      throw new CanonicalProfileCorruption();
    }
    if (revocation.retry_at_ms > nowMs) {
      throwMethodCooldown(method, revocation.retry_at_ms);
    }
    expectations.push({
      kind: "method-revocation-revision",
      method,
      normalizedValue,
      revision: revocation.revision,
    });
    mutations.push({
      kind: "delete-method-revocation",
      method,
      normalizedValue,
    });
  } else {
    expectations.push({
      kind: "method-revocation-absent",
      method,
      normalizedValue,
    });
  }
  const profileCooldown = results[1]?.results[0] as
    CanonicalCooldownRow | undefined;
  if (profileId && profileCooldown) {
    if (
      !Number.isSafeInteger(profileCooldown.revision) ||
      !Number.isSafeInteger(profileCooldown.retry_at_ms)
    ) {
      throw new CanonicalProfileCorruption();
    }
    if (profileCooldown.retry_at_ms > nowMs) {
      throwProfileMethodCooldown(
        method,
        profileId,
        profileCooldown.retry_at_ms,
      );
    }
    expectations.push({
      kind: "method-cooldown-revision",
      method,
      profileId,
      revision: profileCooldown.revision,
    });
    mutations.push({ kind: "delete-method-cooldown", method, profileId });
  } else if (profileId) {
    expectations.push({ kind: "method-cooldown-absent", method, profileId });
  }
  return { expectations, mutations };
}

export async function sweepExpiredCanonicalAuthCooldowns(
  db: D1Database,
  nowMs: number,
  limit = PROFILE_BACKGROUND_SWEEP_LIMIT,
): Promise<{ cooldowns: number; revocations: number }> {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    throw new TypeError("invalid-auth-cooldown-sweep");
  }
  const [revocations, cooldowns] = await db.batch([
    db
      .prepare(
        `SELECT method, normalized_value, revision
         FROM profile_auth_method_revocations
         WHERE retry_at_ms <= ? ORDER BY retry_at_ms, method, normalized_value
         LIMIT ?`,
      )
      .bind(nowMs, limit),
    db
      .prepare(
        `SELECT profile_id, method, revision
         FROM profile_auth_method_cooldowns
         WHERE retry_at_ms <= ? ORDER BY retry_at_ms, profile_id, method
         LIMIT ?`,
      )
      .bind(nowMs, limit),
  ]);
  const expectations: CanonicalExpectation[] = [];
  const mutations: CanonicalMutation[] = [];
  for (const value of revocations.results) {
    const row = record(value);
    const method = row.method;
    const normalizedValue = cleanString(row.normalized_value);
    const revision = Number(row.revision);
    if (
      !AUTH_METHODS.includes(method as AuthMethodKey) ||
      !normalizedValue ||
      !Number.isSafeInteger(revision)
    ) {
      throw new CanonicalProfileCorruption();
    }
    expectations.push({
      kind: "method-revocation-revision",
      method: method as AuthMethodKey,
      normalizedValue,
      revision,
    });
    mutations.push({
      kind: "delete-method-revocation",
      method: method as AuthMethodKey,
      normalizedValue,
    });
  }
  for (const value of cooldowns.results) {
    const row = record(value);
    const method = row.method;
    const profileId = cleanString(row.profile_id);
    const revision = Number(row.revision);
    if (
      !AUTH_METHODS.includes(method as AuthMethodKey) ||
      !profileId ||
      !Number.isSafeInteger(revision)
    ) {
      throw new CanonicalProfileCorruption();
    }
    expectations.push({
      kind: "method-cooldown-revision",
      method: method as AuthMethodKey,
      profileId,
      revision,
    });
    mutations.push({
      kind: "delete-method-cooldown",
      method: method as AuthMethodKey,
      profileId,
    });
  }
  await commitCanonicalPlan(db, { expectations, mutations });
  return {
    revocations: revocations.results.length,
    cooldowns: cooldowns.results.length,
  };
}

export function createCanonicalAuthIdentityService(
  env: Env,
  dependencies: CanonicalIdentityDependencies = {},
): AuthIdentityService {
  const db = env.PROFILE_DB;
  const authState =
    dependencies.authState || createAuthStateRepository(env.AUTH_STATE_DB);
  const authClient =
    dependencies.authClient ||
    createFirebaseAuthAdminClient(env, { signal: dependencies.signal });
  const rtdb =
    dependencies.rtdb ||
    createFirebaseRtdbClient(env, {
      credentials: {
        email: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
    });
  const now = dependencies.now || Date.now;
  const recovery = createAuthRecoveryService(env, {
    authClient,
    now,
    profileDb: db,
    rtdb,
    signal: dependencies.signal,
  });
  const randomInteger =
    dependencies.randomInteger ||
    ((maximum: number) => {
      if (!Number.isInteger(maximum) || maximum <= 0)
        throw new TypeError("maximum must be positive");
      const ceiling = Math.floor(0x1_0000_0000 / maximum) * maximum;
      const buffer = new Uint32Array(1);
      do crypto.getRandomValues(buffer);
      while (buffer[0] >= ceiling);
      return buffer[0] % maximum;
    });

  const identityByProfile = async (
    profileId: string,
  ): Promise<CanonicalIdentityProfile | null> => {
    for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
      const resolved = await resolveCanonicalProfile(db, profileId);
      if (!resolved) return null;
      const aggregate = await readStableCanonicalProfileAggregate(
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
    const resolved = await readStableCanonicalProfileAggregateByLogin(db, uid);
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

  const operationContext = (
    operation: CanonicalAuthOperationSnapshot,
    kind: "unlink" | "verify",
    method: AuthMethodKey,
    uid: string,
    expectedMeta?: Record<string, unknown> | null,
  ): void => {
    if (
      operation.loginUid !== uid ||
      operation.kind !== kind ||
      operation.method !== method
    ) {
      authFailure(403, "permission-denied", "op-context-mismatch");
    }
    if (kind === "verify" && expectedMeta !== undefined) {
      const stored = record(operation.meta);
      const expected = record(expectedMeta);
      if (
        cleanString(stored.methodValueHash) !==
          cleanString(expected.methodValueHash) ||
        cleanString(stored.intentId) !== cleanString(expected.intentId)
      ) {
        authFailure(403, "permission-denied", "op-context-mismatch");
      }
    }
  };

  const liveResponse = async (
    operation: CanonicalAuthOperationSnapshot,
  ): Promise<AuthProfileResponse | LinkedAuthMethodsResponse | null> => {
    if (
      operation.status !== "success" ||
      now() - operation.updatedAtMs > AUTH_OP_REPLAY_TTL_MS ||
      !operation.result
    )
      return null;
    const profile = await profileByLogin(operation.loginUid);
    if (!profile) return null;
    if (operation.kind === "verify") {
      const expectedHash = cleanString(record(operation.meta).methodValueHash);
      const current = methodValue(profile.aggregate, operation.method);
      if (
        !current ||
        !expectedHash ||
        hashMethodValue(operation.method, current) !== expectedHash
      )
        return null;
      return isAuthProfileResponse(operation.result)
        ? profileResponse(profile, operation.loginUid, operation.operationId)
        : null;
    }
    if (methodFromAggregate(profile.aggregate, operation.method)) return null;
    if (!isLinkedAuthMethodsResponse(operation.result)) return null;
    const methods = linkedMethods(profile.aggregate);
    return {
      ok: true,
      profileId: profile.profile.profileId,
      linkedMethods: methods,
      appleLinked: methods.apple,
    };
  };

  const beginOperation = async (
    operationId: string,
    kind: "unlink" | "verify",
    method: AuthMethodKey,
    uid: string,
    meta: Record<string, unknown> | null,
  ) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await readCanonicalAuthOperation(db, operationId);
      if (existing) {
        operationContext(existing, kind, method, uid, meta);
        const replay = await liveResponse(existing);
        if (replay) return { operation: existing, replay };
        if (existing.status === "success")
          authFailure(409, "aborted", "profile-merged-retry");
        return { operation: existing, replay: null };
      }
      const timestamp = now();
      const value: CanonicalAuthOperationValue = {
        operationId,
        kind,
        method,
        loginUid: uid,
        status: "started",
        meta,
        result: null,
        errorCode: null,
        errorMessage: null,
        startedAtMs: timestamp,
        updatedAtMs: timestamp,
      };
      try {
        await commitCanonicalPlan(db, {
          expectations: [{ kind: "auth-operation-absent", operationId }],
          mutations: [{ kind: "insert-auth-operation", value }],
        });
        const operation = await readCanonicalAuthOperation(db, operationId);
        if (!operation) throw new CanonicalProfileCorruption();
        return { operation, replay: null };
      } catch (error) {
        if (!(error instanceof CanonicalProfileConflict) || attempt === 2)
          throw error;
      }
    }
    throw new CanonicalProfileConflict();
  };

  const finishOperation = async (
    operationId: string,
    outcome:
      | { result: AuthProfileResponse | LinkedAuthMethodsResponse }
      | { error: unknown },
  ): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const operation = await readCanonicalAuthOperation(db, operationId);
      if (!operation || operation.status === "success") return;
      const timestamp = now();
      const value: CanonicalAuthOperationValue = {
        ...operation,
        status: "result" in outcome ? "success" : "failed",
        result: "result" in outcome ? record(outcome.result) : null,
        errorCode:
          "error" in outcome && outcome.error instanceof AuthApiFailure
            ? outcome.error.code
            : "error" in outcome
              ? "unavailable"
              : null,
        errorMessage:
          "error" in outcome && outcome.error instanceof AuthApiFailure
            ? outcome.error.message
            : "error" in outcome
              ? "auth-service-unavailable"
              : null,
        updatedAtMs: timestamp,
      };
      try {
        await commitCanonicalPlan(db, {
          expectations: [
            {
              kind: "auth-operation-revision",
              operationId,
              revision: operation.revision,
            },
          ],
          mutations: [{ kind: "update-auth-operation", value }],
        });
        return;
      } catch (error) {
        if (!(error instanceof CanonicalProfileConflict) || attempt === 2)
          throw error;
      }
    }
  };

  const finishBestEffort = async (
    operationId: string,
    outcome:
      | { result: AuthProfileResponse | LinkedAuthMethodsResponse }
      | { error: unknown },
  ) => {
    try {
      await finishOperation(operationId, outcome);
    } catch {
      console.error(JSON.stringify({ event: "auth_op_replay_write_failure" }));
    }
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
          "SELECT profile_id, revision FROM profile_records WHERE username_key = ?",
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
      legacyFields: targetProfile.legacyFields,
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
          sourceLegacyFields: sourceProfile.legacyFields,
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
    if (
      countCanonicalCommitStatements(plan) > CANONICAL_AUTH_COMMIT_QUERY_BUDGET
    ) {
      throw new CanonicalProfileCorruption();
    }
    await commitCanonicalPlan(db, plan);
    return resolvedTargetProfileId;
  };

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
      await ensureFirebaseProfileClaim(uid, profile.profile.profileId, {
        authClient,
        catchupStore: createProfileLinkCatchupStore(db),
        enqueueProfileLinkProjection: (task) =>
          env.PROFILE_GAME_PROJECTION_QUEUE.send(task),
        logger: console,
        now,
        rtdb,
        signal: dependencies.signal,
      });
      await recovery.removeLoginUid(profile.profile.profileId, uid);
      const confirmed = await profileByLogin(uid);
      if (
        !confirmed ||
        confirmed.profile.profileId !== profile.profile.profileId
      )
        continue;
      if (
        (
          await readStableCanonicalProfileAggregate(
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

  const hasValidUsername = (value: unknown): boolean => {
    const username = cleanString(value);
    return (
      isAlphanumericUsername(username) &&
      username.length <= USERNAME_MAX_LENGTH &&
      !isReservedExplicitUsername(username)
    );
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

  const expectedMethod = (
    profile: CanonicalIdentityProfile,
    method: AuthMethodKey,
    methodValueHash: string,
  ): CanonicalAuthMethodSnapshot | null => {
    const current = methodFromAggregate(profile.aggregate, method);
    return current &&
      methodValueHash &&
      hashMethodValue(method, current.normalizedValue) === methodValueHash
      ? current
      : null;
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

  const completeVerifySuccess = async (
    operation: CanonicalAuthOperationSnapshot,
    verified: RepairedVerifiedCaller,
    result: AuthProfileResponse,
  ): Promise<boolean> => {
    if (
      operation.kind !== "verify" ||
      (operation.status !== "started" && operation.status !== "failed") ||
      operation.method !== verified.method.method ||
      cleanString(record(operation.meta).methodValueHash) !==
        hashMethodValue(verified.method.method, verified.method.normalizedValue)
    ) {
      return false;
    }
    const value: CanonicalAuthOperationValue = {
      ...operation,
      status: "success",
      result: record(result),
      errorCode: null,
      errorMessage: null,
      updatedAtMs: now(),
    };
    try {
      await commitCanonicalPlan(db, {
        expectations: [
          {
            kind: "auth-operation-revision",
            operationId: operation.operationId,
            revision: operation.revision,
          },
          {
            kind: "profile-revision",
            profileId: verified.identity.profile.profileId,
            revision: verified.identity.profile.revision,
          },
          {
            kind: "auth-method-revision",
            method: verified.method.method,
            normalizedValue: verified.method.normalizedValue,
            profileId: verified.method.profileId,
            revision: verified.method.revision,
          },
        ],
        mutations: [{ kind: "update-auth-operation", value }],
      });
      return true;
    } catch (error) {
      if (error instanceof CanonicalProfileConflict) return false;
      throw error;
    }
  };

  const parseIntent = (
    intent: AuthIntentRecord | null,
    uid: string,
    method: AuthMethodKey,
    allowConsumed = false,
  ): AuthIntent => {
    if (!intent) authFailure(409, "failed-precondition", "intent-not-found");
    if (readStoredFirebaseUid(intent.uid) !== uid)
      authFailure(403, "permission-denied", "intent-user-mismatch");
    if (cleanString(intent.method) !== method)
      authFailure(409, "failed-precondition", "intent-method-mismatch");
    const consumedAtMs = finiteNumber(intent.consumedAtMs, 0);
    const consumedByOpId = cleanString(intent.consumedByOpId);
    if (
      finiteNumber(intent.expiresAtMs, 0) < now() &&
      !(allowConsumed && consumedAtMs > 0)
    )
      authFailure(504, "deadline-exceeded", "intent-expired");
    if (!allowConsumed && consumedAtMs > 0)
      authFailure(409, "failed-precondition", "intent-consumed");
    return {
      uid,
      method,
      nonce: cleanString(intent.nonce),
      consumedAtMs,
      expiresAtMs: finiteNumber(intent.expiresAtMs, 0),
      ...(consumedByOpId ? { consumedByOpId } : {}),
    };
  };

  const readIntent = async (
    uid: string,
    method: AuthMethodKey,
    intentId: string,
    opId?: string,
  ): Promise<AuthIntent> => {
    const intent = await authState.getAuthIntent(cleanString(intentId));
    const parsed = parseIntent(intent, uid, method, Boolean(opId));
    if (parsed.consumedAtMs <= 0 || !opId)
      return parsed.consumedAtMs > 0
        ? parseIntent(intent, uid, method)
        : parsed;
    if (parsed.consumedByOpId && parsed.consumedByOpId !== opId)
      return parseIntent(intent, uid, method);
    const operation = await readCanonicalAuthOperation(db, opId);
    if (
      !operation ||
      operation.loginUid !== uid ||
      operation.kind !== "verify" ||
      operation.method !== method ||
      cleanString(record(operation.meta).intentId) !== intentId ||
      now() - operation.updatedAtMs > AUTH_OP_REPLAY_TTL_MS
    )
      return parseIntent(intent, uid, method);
    return parsed;
  };

  const consumeIntent = async (
    uid: string,
    method: AuthMethodKey,
    intentId: string,
    opId?: string,
  ): Promise<AuthIntent> => {
    const normalizedIntentId = cleanString(intentId);
    const intent = await authState.getAuthIntent(normalizedIntentId);
    const result = parseIntent(intent, uid, method);
    const consumed = await authState.consumeAuthIntent({
      consumedAtMs: now(),
      consumedByOpId: cleanString(opId) || null,
      intentId: normalizedIntentId,
      method,
      uid,
    });
    if (!consumed)
      return parseIntent(
        await authState.getAuthIntent(normalizedIntentId),
        uid,
        method,
      );
    return result;
  };

  const syncCurrentCallerProfile = async (
    uid: string,
  ): Promise<LinkedAuthMethodsResponse> => {
    const profile = await repairCallerProfile(uid);
    const methods = linkedMethods(profile.aggregate);
    return {
      ok: true,
      profileId: profile.profile.profileId,
      linkedMethods: methods,
      appleLinked: methods.apple,
    };
  };

  const verifyMeta = (input: LinkInput) => ({
    methodValue:
      input.method === "apple" || input.method === "x"
        ? "redacted"
        : input.methodValueRaw,
    methodValueHash: hashMethodValue(input.method, input.normalizedMethodValue),
    ...(input.intentId ? { intentId: input.intentId } : {}),
  });

  return {
    consumeIntent,
    readIntent,
    async prepareVerifiedMethod(input, intent) {
      if (!input.intentId)
        authFailure(400, "invalid-argument", "intentId is required.");
      const started = await beginOperation(
        input.opId,
        "verify",
        input.method,
        input.uid,
        verifyMeta(input),
      );
      if (started.replay && isAuthProfileResponse(started.replay)) {
        const completed = await repairVerifiedCaller(
          input.uid,
          input.method,
          hashMethodValue(input.method, input.normalizedMethodValue),
        );
        if (!completed) authFailure(409, "aborted", "method-index-race-retry");
        return profileResponse(completed.identity, input.uid, input.opId);
      }
      if (intent.consumedAtMs > 0) return null;
      try {
        await consumeIntent(
          input.uid,
          input.method,
          input.intentId,
          input.opId,
        );
      } catch (error) {
        if (
          !(error instanceof AuthApiFailure) ||
          error.message !== "intent-consumed"
        )
          throw error;
        await readIntent(input.uid, input.method, input.intentId, input.opId);
      }
      return null;
    },
    async linkVerifiedMethod(input) {
      const started = await beginOperation(
        input.opId,
        "verify",
        input.method,
        input.uid,
        verifyMeta(input),
      );
      if (started.replay && isAuthProfileResponse(started.replay)) {
        const completed = await repairVerifiedCaller(
          input.uid,
          input.method,
          hashMethodValue(input.method, input.normalizedMethodValue),
        );
        if (!completed) authFailure(409, "aborted", "method-index-race-retry");
        return profileResponse(completed.identity, input.uid, input.opId);
      }
      try {
        const current = await profileByLogin(input.uid);
        const methodOwner = await readCanonicalAuthMethod(
          db,
          input.method,
          input.normalizedMethodValue,
        );
        let targetProfileId =
          current?.profile.profileId ||
          methodOwner?.profileId ||
          (await createInitial(input));
        let linked = false;
        for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
          try {
            const attached = await attachMethod(input, targetProfileId);
            if (attached.kind === "linked") {
              linked = true;
              break;
            }
            if (attached.kind === "login-profile") {
              targetProfileId = attached.profileId;
              continue;
            }
            targetProfileId = await mergeIdentityProfiles(
              targetProfileId,
              attached.profileId,
              input.opId,
            );
          } catch (error) {
            if (
              error instanceof CanonicalProfileConflict &&
              attempt < LINK_METHOD_MAX_ATTEMPTS - 1
            )
              continue;
            throw error;
          }
        }
        if (!linked) authFailure(409, "aborted", "method-index-race-retry");
        const verified = await repairVerifiedCaller(
          input.uid,
          input.method,
          hashMethodValue(input.method, input.normalizedMethodValue),
        );
        if (!verified) authFailure(409, "aborted", "method-index-race-retry");
        const response = profileResponse(
          verified.identity,
          input.uid,
          input.opId,
        );
        if (
          !(await completeVerifySuccess(started.operation, verified, response))
        )
          authFailure(409, "aborted", "method-index-race-retry");
        return response;
      } catch (error) {
        await finishBestEffort(input.opId, { error });
        throw error;
      }
    },
    async peekVerifyReplay(opId, method, uid) {
      const operation = await readCanonicalAuthOperation(db, opId);
      if (!operation) return null;
      operationContext(operation, "verify", method, uid);
      if (now() - operation.updatedAtMs > AUTH_OP_REPLAY_TTL_MS) return null;
      const isCompletedReplay =
        operation.status === "success" &&
        isAuthProfileResponse(operation.result);
      if (
        !isCompletedReplay &&
        operation.status !== "started" &&
        operation.status !== "failed"
      ) {
        return null;
      }
      const verified = await repairVerifiedCaller(
        uid,
        method,
        cleanString(record(operation.meta).methodValueHash),
      );
      if (!verified) return null;
      const response = profileResponse(verified.identity, uid, opId);
      if (
        !isCompletedReplay &&
        !(await completeVerifySuccess(operation, verified, response))
      ) {
        return null;
      }
      return response;
    },
    async refreshCompletedVerifyResult(
      result,
      method,
      uid,
      expectedMethodValue,
    ) {
      const operation = await readCanonicalAuthOperation(db, result.opId);
      if (!operation) return null;
      operationContext(operation, "verify", method, uid);
      const normalized = normalizeMethodValue(method, expectedMethodValue);
      if (
        operation.status !== "success" ||
        now() - operation.updatedAtMs > AUTH_OP_REPLAY_TTL_MS ||
        cleanString(record(operation.meta).methodValueHash) !==
          hashMethodValue(method, normalized)
      )
        return null;
      const verified = await repairVerifiedCaller(
        uid,
        method,
        hashMethodValue(method, normalized),
      );
      return verified
        ? profileResponse(verified.identity, uid, result.opId)
        : null;
    },
    syncCurrentCallerProfile,
    async unlinkMethod(uid, rawMethod, opId) {
      const method = AUTH_METHODS.includes(rawMethod) ? rawMethod : null;
      if (!method)
        authFailure(400, "invalid-argument", "Unsupported auth method.");
      const started = await beginOperation(opId, "unlink", method, uid, null);
      if (started.replay && isLinkedAuthMethodsResponse(started.replay))
        return syncCurrentCallerProfile(uid);
      try {
        for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
          const profile = await profileByLogin(uid);
          const owner = profile?.owner;
          if (!owner || !profile)
            authFailure(404, "not-found", "profile-not-found");
          const existing = methodFromAggregate(profile.aggregate, method);
          if (!existing)
            authFailure(409, "failed-precondition", "method-not-linked");
          if (profile.aggregate.authMethods.length <= 1)
            authFailure(
              409,
              "failed-precondition",
              "cannot-remove-last-method",
            );
          const operation = await readCanonicalAuthOperation(db, opId);
          if (!operation) throw new CanonicalProfileCorruption();
          const timestamp = now();
          const retryAtMs = timestamp + AUTH_METHOD_REUSE_COOLDOWN_MS;
          const recoveryValueForProfile = recoveryValue(
            profile.aggregate.recovery,
            profile.profile.profileId,
            [uid],
            [],
            timestamp,
          );
          const nextAggregateMethods = profile.aggregate.authMethods.filter(
            (candidate) => candidate.method !== method,
          );
          const nextLinked = new Set(
            nextAggregateMethods.map((candidate) => candidate.method),
          );
          const response: LinkedAuthMethodsResponse = {
            ok: true,
            profileId: profile.profile.profileId,
            linkedMethods: {
              apple: nextLinked.has("apple"),
              eth: nextLinked.has("eth"),
              sol: nextLinked.has("sol"),
              x: nextLinked.has("x"),
            },
            appleLinked: nextLinked.has("apple"),
          };
          const cooldown: CanonicalCooldownValue = {
            profileId: profile.profile.profileId,
            method,
            scope: getAuthCooldownScope(AUTH_COOLDOWN_REASONS.profileMethod),
            unlinkedByUid: uid,
            cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
            startedAtMs: timestamp,
            retryAtMs,
            updatedAtMs: timestamp,
          };
          const revocation: CanonicalMethodRevocationValue = {
            ...cooldown,
            normalizedValue: existing.normalizedValue,
            scope: getAuthCooldownScope(AUTH_COOLDOWN_REASONS.method),
          };
          const operationValue: CanonicalAuthOperationValue = {
            ...operation,
            status: "success",
            result: record(response),
            errorCode: null,
            errorMessage: null,
            updatedAtMs: timestamp,
          };
          try {
            await commitCanonicalPlan(db, {
              expectations: [
                {
                  kind: "profile-revision",
                  profileId: profile.profile.profileId,
                  revision: profile.profile.revision,
                },
                {
                  kind: "login-owner-revision",
                  loginUid: uid,
                  profileId: owner.profileId,
                  revision: owner.revision,
                },
                {
                  kind: "auth-method-revision",
                  method,
                  normalizedValue: existing.normalizedValue,
                  profileId: profile.profile.profileId,
                  revision: existing.revision,
                },
                {
                  kind: "auth-operation-revision",
                  operationId: opId,
                  revision: operation.revision,
                },
                ...(profile.aggregate.recovery
                  ? [
                      {
                        kind: "auth-recovery-revision" as const,
                        profileId: profile.profile.profileId,
                        revision: profile.aggregate.recovery.revision,
                      },
                    ]
                  : [
                      {
                        kind: "auth-recovery-absent" as const,
                        profileId: profile.profile.profileId,
                      },
                    ]),
                {
                  kind: "method-cooldown-absent",
                  method,
                  profileId: profile.profile.profileId,
                },
                {
                  kind: "method-revocation-absent",
                  method,
                  normalizedValue: existing.normalizedValue,
                },
              ],
              mutations: [
                {
                  kind: "update-active-profile",
                  value: profileValue(
                    profile.profile,
                    profileWithoutMethod(profile.profile.profile, method),
                    timestamp,
                  ),
                },
                {
                  kind: "delete-auth-method",
                  method,
                  normalizedValue: existing.normalizedValue,
                },
                { kind: "insert-method-cooldown", value: cooldown },
                { kind: "insert-method-revocation", value: revocation },
                profile.aggregate.recovery
                  ? {
                      kind: "update-auth-recovery",
                      value: recoveryValueForProfile,
                    }
                  : {
                      kind: "insert-auth-recovery",
                      value: recoveryValueForProfile,
                    },
                { kind: "update-auth-operation", value: operationValue },
              ],
            });
            const repaired = await syncCurrentCallerProfile(uid);
            await finishBestEffort(opId, { result: repaired });
            return repaired;
          } catch (error) {
            if (
              error instanceof CanonicalProfileConflict &&
              attempt < LINK_METHOD_MAX_ATTEMPTS - 1
            )
              continue;
            throw error;
          }
        }
        authFailure(409, "aborted", "profile-merged-retry");
      } catch (error) {
        const operation = await readCanonicalAuthOperation(db, opId);
        const replay = operation ? await liveResponse(operation) : null;
        if (replay && isLinkedAuthMethodsResponse(replay)) {
          return syncCurrentCallerProfile(uid);
        }
        await finishBestEffort(opId, { error });
        throw error;
      }
    },
  };
}
