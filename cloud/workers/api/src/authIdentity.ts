import {
  AUTH_COOLDOWN_REASONS,
  AUTH_METHODS,
  AUTH_METHOD_REUSE_COOLDOWN_MS,
  getLinkedAuthMethodsFromProfile,
  getAuthCooldownScope,
  isAuthProfileResponse,
  isLinkedAuthMethodsResponse,
  type AuthMethodKey,
  type AuthProfileResponse,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import { normalizeMiningSnapshot, sumMaterials } from "@mons/shared/mining";
import {
  USERNAME_LOOKUP_KEY_FIELD,
  buildUsernameLookupKey,
  getUsernameIndexDocIds,
  isAlphanumericUsername,
  isReservedExplicitUsername,
  isSafeFirestoreDocIdSegment,
} from "@mons/shared/usernames";
import { PROFILE_MERGE_TARGETS_COLLECTION } from "../../../functions/profileMergeTargets.js";
import { AuthApiFailure } from "./authErrors.ts";
import {
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestoreTransaction,
  type AuthFirestoreWrite,
  AuthFirestoreConflict,
  authDeleteWrite,
  authDocumentName,
  authFieldFilter,
  authUpdateWrite,
  createAuthFirestoreClient,
} from "./authFirestore.ts";
import {
  type FirebaseAuthAdminClient,
  createFirebaseAuthAdminClient,
} from "./firebaseAuthAdmin.ts";
import {
  type FirebaseRtdbClient,
  createFirebaseRtdbClient,
} from "./firebaseRtdb.ts";
import {
  assertAuthMethod,
  cleanString,
  cooldownRetryAtMs,
  finiteNumber,
  getMethodField,
  getMethodKey,
  hashMethodValue,
  linkedMethodCount,
  normalizeMethodValue,
  normalizeProfileMethod,
  profileMethodCooldownId,
  readStoredFirebaseUid,
  throwMethodCooldown,
  throwProfileMethodCooldown,
  uniqueStoredFirebaseUids,
  uniqueStrings,
} from "./authPolicy.ts";
import {
  authRecoveryJobName,
  createAuthRecoveryService,
  enqueuePersistedAuthRecovery,
  ensureFirebaseProfileClaim,
  newAuthRecoveryJob,
  parseAuthRecoveryJob,
} from "./authRecovery.ts";
import { createGoogleAccessToken } from "./googleAuth.ts";

const AUTH_OP_REPLAY_TTL_MS = 10 * 60 * 1_000;
const LINK_METHOD_MAX_ATTEMPTS = 3;
const AUTO_NAME_MAX_ATTEMPTS = 30;
const USERNAME_CONFLICT_QUERY_LIMIT = 100;
const PROVIDER_METADATA_FIELD_PATHS = {
  apple: [
    "appleEmailMasked",
    "appleLinkedAt",
    "appleConsentAt",
    "appleConsentSource",
  ],
  x: ["xUsername", "xLinkedAt", "xConsentAt", "xConsentSource"],
} as const;

type AuthIntent = {
  consumedByOpId?: string;
  consumedAtMs: number;
  expiresAtMs: number;
  method: AuthMethodKey;
  nonce: string;
  uid: string;
};

type LinkInput = {
  appleEmailMasked?: string | null;
  consentSource?: "signin" | "settings";
  method: AuthMethodKey;
  methodValueLookupRaw?: string;
  methodValueRaw: string;
  normalizedMethodValue: string;
  intentId?: string;
  opId: string;
  preferredAddress?: string | null;
  requestAura: string | null;
  requestEmoji: number;
  uid: string;
  xUsername?: string | null;
};

type AttachMethodResult =
  | { kind: "linked" }
  | { kind: "login-profile"; profileId: string }
  | { kind: "method-profile"; profileId: string };

export type AuthIdentityService = {
  consumeIntent: (
    uid: string,
    method: AuthMethodKey,
    intentId: string,
    opId?: string,
  ) => Promise<AuthIntent>;
  readIntent: (
    uid: string,
    method: AuthMethodKey,
    intentId: string,
    opId?: string,
  ) => Promise<AuthIntent>;
  prepareVerifiedMethod: (
    input: LinkInput,
    intent: AuthIntent,
  ) => Promise<AuthProfileResponse | null>;
  linkVerifiedMethod: (input: LinkInput) => Promise<AuthProfileResponse>;
  peekVerifyReplay: (
    opId: string,
    method: AuthMethodKey,
    uid: string,
  ) => Promise<AuthProfileResponse | null>;
  refreshCompletedVerifyResult: (
    result: Pick<AuthProfileResponse, "profileId" | "opId">,
    method: AuthMethodKey,
    uid: string,
    expectedMethodValue: string,
  ) => Promise<AuthProfileResponse | null>;
  syncCurrentCallerProfile: (uid: string) => Promise<LinkedAuthMethodsResponse>;
  unlinkMethod: (
    uid: string,
    method: AuthMethodKey,
    opId: string,
  ) => Promise<LinkedAuthMethodsResponse>;
};

type ServiceDependencies = {
  authClient?: FirebaseAuthAdminClient;
  firestore?: AuthFirestoreClient;
  now?: () => number;
  randomInteger?: (maximum: number) => number;
  rtdb?: FirebaseRtdbClient;
  signal?: AbortSignal;
};

type AuthOperationOutcome =
  | { result: AuthProfileResponse | LinkedAuthMethodsResponse }
  | { error: unknown };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasMergeValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function isRetiredMergeSource(fields: Record<string, unknown>): boolean {
  return cleanString(fields.mergedIntoProfileId) !== "";
}

function mergeCustom(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const targetCustom = record(target.custom);
  const sourceCustom = record(source.custom);
  const prefer = (left: unknown, right: unknown) =>
    hasMergeValue(left) ? left : right;
  return {
    ...sourceCustom,
    ...targetCustom,
    emoji: prefer(targetCustom.emoji, sourceCustom.emoji),
    aura: prefer(targetCustom.aura, sourceCustom.aura),
    cardBackgroundId: prefer(
      targetCustom.cardBackgroundId,
      sourceCustom.cardBackgroundId,
    ),
    cardStickers: prefer(targetCustom.cardStickers, sourceCustom.cardStickers),
    cardSubtitleId: prefer(
      targetCustom.cardSubtitleId,
      sourceCustom.cardSubtitleId,
    ),
    profileCounter: prefer(
      targetCustom.profileCounter,
      sourceCustom.profileCounter,
    ),
    profileMons: prefer(targetCustom.profileMons, sourceCustom.profileMons),
    completedProblems: uniqueStrings(
      targetCustom.completedProblems,
      sourceCustom.completedProblems,
    ),
    tutorialCompleted:
      targetCustom.tutorialCompleted === true ||
      sourceCustom.tutorialCompleted === true,
  };
}

function mergeMining(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
) {
  const targetMining = normalizeMiningSnapshot(target.mining);
  const sourceMining = normalizeMiningSnapshot(source.mining);
  const dates = [targetMining.lastRockDate, sourceMining.lastRockDate]
    .filter((value): value is string => typeof value === "string" && !!value)
    .sort();
  return {
    lastRockDate: dates.at(-1) || null,
    materials: sumMaterials(targetMining.materials, sourceMining.materials),
  };
}

function optionalPreferred(target: unknown, source: unknown): unknown {
  return hasMergeValue(target) ? target : source;
}

function methodPatch(input: LinkInput, nowMs: number): Record<string, unknown> {
  if (input.method === "eth") {
    return { eth: input.methodValueRaw };
  }
  if (input.method === "sol") {
    return { sol: input.methodValueRaw };
  }
  if (input.method === "apple") {
    return {
      appleSub: input.methodValueRaw,
      ...(input.appleEmailMasked
        ? { appleEmailMasked: input.appleEmailMasked }
        : {}),
      appleLinkedAt: nowMs,
      appleConsentAt: nowMs,
      appleConsentSource: input.consentSource || "signin",
    };
  }
  return {
    xUserId: input.methodValueRaw,
    ...(input.xUsername ? { xUsername: input.xUsername } : {}),
    xLinkedAt: nowMs,
    xConsentAt: nowMs,
    xConsentSource: input.consentSource || "signin",
  };
}

function authFailure(
  status: number,
  code: ConstructorParameters<typeof AuthApiFailure>[1],
  message: string,
): never {
  throw new AuthApiFailure(status, code, message);
}

function getOne(
  values: Map<string, AuthFirestoreDocument | null>,
  name: string,
): AuthFirestoreDocument | null {
  return values.get(name) || null;
}

type ProfileMergePlan = {
  deleteTargetFields: string[];
  merged: Record<string, unknown>;
  mergedLogins: string[];
  mergedUsername: string;
  methodIndexes: Array<{ method: AuthMethodKey; value: string }>;
  staleUsernameIndexNames: string[];
  usernameKey: string;
};

function buildProfileMergePlan(
  target: AuthFirestoreDocument,
  source: AuthFirestoreDocument,
  nowMs: number,
): ProfileMergePlan {
  for (const method of AUTH_METHODS) {
    const targetValue = normalizeProfileMethod(method, target.fields);
    const sourceValue = normalizeProfileMethod(method, source.fields);
    if (targetValue && sourceValue && targetValue !== sourceValue) {
      authFailure(409, "failed-precondition", "merge-method-conflict");
    }
  }
  const mergedLogins = uniqueStoredFirebaseUids(
    target.fields.logins,
    source.fields.logins,
  );
  const mergedUsername =
    cleanString(target.fields.username) || cleanString(source.fields.username);
  const usernameKeyCandidate = buildUsernameLookupKey(mergedUsername);
  const usernameKey = isSafeFirestoreDocIdSegment(usernameKeyCandidate)
    ? usernameKeyCandidate
    : "";
  const staleUsernameIndexNames = Array.from(
    new Set([
      ...getUsernameIndexDocIds(cleanString(target.fields.username)),
      ...getUsernameIndexDocIds(cleanString(source.fields.username)),
    ]),
  ).map((id) => authDocumentName("usernameIndex", id));
  const merged: Record<string, unknown> = {
    logins: mergedLogins,
    username: mergedUsername,
    ...(usernameKey ? { [USERNAME_LOOKUP_KEY_FIELD]: usernameKey } : {}),
    rating: Math.min(
      finiteNumber(target.fields.rating, 1500),
      finiteNumber(source.fields.rating, 1500),
    ),
    nonce: Math.max(
      finiteNumber(target.fields.nonce, -1),
      finiteNumber(source.fields.nonce, -1),
    ),
    totalManaPoints:
      finiteNumber(target.fields.totalManaPoints, 0) +
      finiteNumber(source.fields.totalManaPoints, 0),
    win: optionalPreferred(target.fields.win, source.fields.win),
    feb2026UniqueOpponentsCount: Math.max(
      finiteNumber(target.fields.feb2026UniqueOpponentsCount, 0),
      finiteNumber(source.fields.feb2026UniqueOpponentsCount, 0),
    ),
    custom: mergeCustom(target.fields, source.fields),
    mining: mergeMining(target.fields, source.fields),
    mergedAtMs: nowMs,
  };
  const deleteTargetFields: string[] = usernameKey
    ? []
    : [USERNAME_LOOKUP_KEY_FIELD];
  for (const method of AUTH_METHODS) {
    const value =
      normalizeProfileMethod(method, target.fields) ||
      normalizeProfileMethod(method, source.fields);
    const field = getMethodField(method);
    if (value) {
      merged[field] = value;
    } else {
      deleteTargetFields.push(field);
    }
  }
  const mergeProviderMetadata = (
    method: "apple" | "x",
    names: readonly string[],
  ) => {
    const targetOwns = !!normalizeProfileMethod(method, target.fields);
    const sourceOwns = !!normalizeProfileMethod(method, source.fields);
    for (const name of names) {
      const value = targetOwns
        ? optionalPreferred(target.fields[name], source.fields[name])
        : sourceOwns
          ? source.fields[name]
          : undefined;
      if (value !== undefined && value !== null && value !== "") {
        merged[name] = value;
      } else {
        deleteTargetFields.push(name);
      }
    }
  };
  for (const method of ["apple", "x"] as const) {
    mergeProviderMetadata(method, PROVIDER_METADATA_FIELD_PATHS[method]);
  }
  const methodIndexes = AUTH_METHODS.map((method) => ({
    method,
    value: normalizeProfileMethod(method, merged),
  })).filter((entry): entry is { method: AuthMethodKey; value: string } =>
    Boolean(entry.value),
  );
  return {
    deleteTargetFields,
    merged,
    mergedLogins,
    mergedUsername,
    methodIndexes,
    staleUsernameIndexNames,
    usernameKey,
  };
}

export function createAuthIdentityService(
  env: Env,
  dependencies: ServiceDependencies = {},
): AuthIdentityService {
  let accessToken: Promise<string> | null = null;
  const accessTokenProvider = () => {
    accessToken ||= createGoogleAccessToken(env, {
      credentials: {
        email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
    });
    return accessToken;
  };
  const firestore =
    dependencies.firestore ||
    createAuthFirestoreClient(env, {
      accessTokenProvider,
      signal: dependencies.signal,
    });
  const durableFirestore =
    dependencies.firestore ||
    createAuthFirestoreClient(env, { accessTokenProvider });
  const authClient =
    dependencies.authClient ||
    createFirebaseAuthAdminClient(env, { signal: dependencies.signal });
  const rtdb =
    dependencies.rtdb ||
    createFirebaseRtdbClient(env, {
      credentials: {
        email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
    });
  const now = dependencies.now || Date.now;
  const recovery = createAuthRecoveryService(env, {
    authClient,
    firestore: durableFirestore,
    now,
    rtdb,
    signal: dependencies.signal,
  });
  const randomInteger =
    dependencies.randomInteger ||
    ((maximum: number) => {
      if (!Number.isInteger(maximum) || maximum <= 0) {
        throw new TypeError("maximum must be positive");
      }
      const ceiling = Math.floor(0x1_0000_0000 / maximum) * maximum;
      const buffer = new Uint32Array(1);
      do {
        crypto.getRandomValues(buffer);
      } while (buffer[0] >= ceiling);
      return buffer[0] % maximum;
    });

  const enqueueRecoveryBestEffort = async (
    profileId: string,
  ): Promise<void> => {
    try {
      await enqueuePersistedAuthRecovery(
        env,
        durableFirestore,
        profileId,
        now(),
      );
    } catch {
      console.error(JSON.stringify({ event: "auth_recovery_enqueue_failure" }));
    }
  };

  const profileByLogin = async (
    uid: string,
    transaction?: AuthFirestoreTransaction,
  ): Promise<AuthFirestoreDocument | null> => {
    const query = transaction?.query || firestore.query;
    const profiles = await query(
      "users",
      authFieldFilter("logins", "ARRAY_CONTAINS", uid),
      2,
    );
    if (profiles.length > 1) {
      authFailure(409, "failed-precondition", "login-profile-conflict");
    }
    return profiles[0] || null;
  };

  const profileByMethod = async (
    method: AuthMethodKey,
    normalizedValue: string,
    rawValue: string,
  ): Promise<AuthFirestoreDocument | null> => {
    const indexName = authDocumentName(
      "authMethodIndex",
      getMethodKey(method, normalizedValue),
    );
    const index = await firestore.get(indexName);
    if (index) {
      const indexedProfileId = cleanString(index.fields.profileId);
      const indexedProfile = indexedProfileId
        ? await firestore.get(authDocumentName("users", indexedProfileId))
        : null;
      if (
        indexedProfile &&
        normalizeProfileMethod(method, indexedProfile.fields) ===
          normalizedValue
      ) {
        return indexedProfile;
      }
      const liveProfile = await firestore.runTransaction(
        async (transaction) => {
          const liveIndex = getOne(
            await transaction.batchGet([indexName]),
            indexName,
          );
          if (!liveIndex) {
            return { result: null, writes: [] };
          }
          const liveProfileId = cleanString(liveIndex.fields.profileId);
          const liveProfileName = liveProfileId
            ? authDocumentName("users", liveProfileId)
            : "";
          const candidate = liveProfileName
            ? getOne(
                await transaction.batchGet([liveProfileName]),
                liveProfileName,
              )
            : null;
          if (
            candidate &&
            normalizeProfileMethod(method, candidate.fields) === normalizedValue
          ) {
            return { result: candidate, writes: [] };
          }
          return {
            result: null,
            writes: [authDeleteWrite(indexName, true)],
          };
        },
      );
      if (liveProfile) {
        return liveProfile;
      }
    }
    const candidates = Array.from(
      new Set([cleanString(rawValue), normalizedValue].filter(Boolean)),
    );
    const discoveredProfiles = new Map<string, AuthFirestoreDocument>();
    for (const candidate of candidates) {
      const profiles = await firestore.query(
        "users",
        authFieldFilter(getMethodField(method), "EQUAL", candidate),
        2,
      );
      if (profiles.length > 1) {
        authFailure(
          409,
          "failed-precondition",
          "legacy-method-duplicate-ownership",
        );
      }
      for (const profile of profiles) {
        discoveredProfiles.set(profile.id, profile);
      }
    }
    if (discoveredProfiles.size > 1) {
      authFailure(
        409,
        "failed-precondition",
        "legacy-method-duplicate-ownership",
      );
    }
    const discovered = discoveredProfiles.values().next().value;
    if (!discovered) {
      return null;
    }
    await firestore.runTransaction(async (transaction) => {
      const liveIndex = getOne(
        await transaction.batchGet([indexName]),
        indexName,
      );
      const liveOwner = liveIndex
        ? cleanString(liveIndex.fields.profileId)
        : "";
      if (liveOwner && liveOwner !== discovered.id) {
        const ownerName = authDocumentName("users", liveOwner);
        const owner = getOne(
          await transaction.batchGet([ownerName]),
          ownerName,
        );
        if (
          owner &&
          normalizeProfileMethod(method, owner.fields) === normalizedValue
        ) {
          authFailure(409, "failed-precondition", "method-index-conflict");
        }
      }
      return {
        result: undefined,
        writes: [
          authUpdateWrite(indexName, {
            profileId: discovered.id,
            method,
            normalizedValue,
            updatedAtMs: now(),
          }),
        ],
      };
    });
    return discovered;
  };

  const replayFromOp = async (
    opId: string,
    kind: "unlink" | "verify",
    method: AuthMethodKey,
    uid: string,
    expectedMeta?: Record<string, unknown> | null,
  ): Promise<AuthProfileResponse | LinkedAuthMethodsResponse | null> => {
    const operation = await firestore.get(authDocumentName("authOps", opId));
    if (!operation) {
      return null;
    }
    const fields = operation.fields;
    const existingUid = readStoredFirebaseUid(fields.uid);
    const existingKind = cleanString(fields.kind);
    const existingMethod = cleanString(fields.method);
    if (!existingUid || !existingKind || !existingMethod) {
      return null;
    }
    if (
      existingUid !== uid ||
      existingKind !== kind ||
      existingMethod !== method
    ) {
      authFailure(403, "permission-denied", "op-context-mismatch");
    }
    const updatedAtMs = Math.max(
      finiteNumber(fields.updatedAtMs, 0),
      finiteNumber(fields.startedAtMs, 0),
    );
    if (
      fields.status !== "success" ||
      now() - updatedAtMs > AUTH_OP_REPLAY_TTL_MS
    ) {
      return null;
    }
    const result = record(fields.result);
    if (result.ok !== true) {
      return null;
    }
    if (kind === "verify") {
      const storedMeta = record(fields.meta);
      if (
        expectedMeta !== undefined &&
        (cleanString(storedMeta.methodValueHash) !==
          cleanString(record(expectedMeta).methodValueHash) ||
          cleanString(storedMeta.intentId) !==
            cleanString(record(expectedMeta).intentId))
      ) {
        authFailure(403, "permission-denied", "op-context-mismatch");
      }
      const profile = await profileByLogin(uid);
      if (!profile) {
        return null;
      }
      const currentValue = normalizeProfileMethod(method, profile.fields);
      const expectedHash = cleanString(record(fields.meta).methodValueHash);
      if (
        !currentValue ||
        !expectedHash ||
        hashMethodValue(method, currentValue) !== expectedHash
      ) {
        return null;
      }
    }
    if (kind === "verify" && isAuthProfileResponse(result)) {
      return result;
    }
    if (kind === "unlink" && isLinkedAuthMethodsResponse(result)) {
      const profile = await repairCurrentCaller(uid);
      if (normalizeProfileMethod(method, profile.fields)) {
        return null;
      }
      const linkedMethods = getLinkedAuthMethodsFromProfile(profile.fields);
      return {
        ok: true,
        profileId: profile.id,
        linkedMethods,
        appleLinked: linkedMethods.apple,
      };
    }
    return null;
  };

  const beginOp = async (
    opId: string,
    kind: "unlink" | "verify",
    method: AuthMethodKey,
    uid: string,
    meta: Record<string, unknown> | null,
  ): Promise<AuthProfileResponse | LinkedAuthMethodsResponse | null> => {
    const validateExisting = (existing: AuthFirestoreDocument): void => {
      const existingUid = readStoredFirebaseUid(existing.fields.uid);
      const existingKind = cleanString(existing.fields.kind);
      const existingMethod = cleanString(existing.fields.method);
      if (!existingUid || !existingKind || !existingMethod) {
        authFailure(409, "failed-precondition", "op-context-invalid");
      }
      if (
        existingUid !== uid ||
        existingKind !== kind ||
        existingMethod !== method
      ) {
        authFailure(403, "permission-denied", "op-context-mismatch");
      }
      if (kind === "verify") {
        const existingHash = cleanString(
          record(existing.fields.meta).methodValueHash,
        );
        const incomingHash = cleanString(record(meta).methodValueHash);
        const existingIntentId = cleanString(
          record(existing.fields.meta).intentId,
        );
        const incomingIntentId = cleanString(record(meta).intentId);
        if (
          !existingHash ||
          existingHash !== incomingHash ||
          existingIntentId !== incomingIntentId
        ) {
          authFailure(403, "permission-denied", "op-context-mismatch");
        }
      }
    };
    const replay = await replayFromOp(opId, kind, method, uid, meta);
    if (replay) {
      return replay;
    }
    const operationName = authDocumentName("authOps", opId);
    const existing = await durableFirestore.get(operationName);
    if (existing) {
      validateExisting(existing);
      if (existing.fields.status === "success") {
        authFailure(409, "aborted", "profile-merged-retry");
      }
      return null;
    }
    const nowMs = now();
    try {
      await durableFirestore.commitWrites([
        authUpdateWrite(
          operationName,
          {
            opId,
            kind,
            method,
            uid,
            status: "started",
            meta,
            startedAtMs: nowMs,
            updatedAtMs: nowMs,
          },
          undefined,
          false,
        ),
      ]);
      return null;
    } catch (error) {
      if (!(error instanceof AuthFirestoreConflict)) {
        throw error;
      }
      const racedReplay = await replayFromOp(opId, kind, method, uid, meta);
      if (racedReplay) {
        return racedReplay;
      }
      const raced = await durableFirestore.get(operationName);
      if (!raced) {
        throw error;
      }
      validateExisting(raced);
      if (raced.fields.status === "success") {
        authFailure(409, "aborted", "profile-merged-retry");
      }
      return null;
    }
  };

  const finishOp = async (
    opId: string,
    outcome: AuthOperationOutcome,
  ): Promise<void> => {
    const nowMs = now();
    if (!("result" in outcome)) {
      const operationName = authDocumentName("authOps", opId);
      await durableFirestore.runTransaction(async (transaction) => {
        const operation = getOne(
          await transaction.batchGet([operationName]),
          operationName,
        );
        if (operation?.fields.status === "success") {
          return { result: undefined, writes: [] };
        }
        return {
          result: undefined,
          writes: [
            authUpdateWrite(operationName, {
              status: "failed",
              errorCode:
                outcome.error instanceof AuthApiFailure
                  ? outcome.error.code
                  : "unavailable",
              errorMessage:
                outcome.error instanceof AuthApiFailure
                  ? outcome.error.message
                  : "auth-service-unavailable",
              updatedAtMs: nowMs,
            }),
          ],
        };
      });
      return;
    }
    const write = authUpdateWrite(authDocumentName("authOps", opId), {
      status: "success",
      result: outcome.result,
      updatedAtMs: nowMs,
    });
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await durableFirestore.commitWrites([write]);
        return;
      } catch (failure) {
        lastError = failure;
      }
    }
    throw lastError;
  };

  const finishOpBestEffort = async (
    opId: string,
    outcome: AuthOperationOutcome,
  ): Promise<void> => {
    try {
      await finishOp(opId, outcome);
    } catch {
      console.error(JSON.stringify({ event: "auth_op_replay_write_failure" }));
    }
  };

  const assertCooldowns = async (
    transaction: AuthFirestoreTransaction,
    profileId: string | null,
    method: AuthMethodKey,
    normalizedValue: string,
  ): Promise<AuthFirestoreWrite[]> => {
    const names = [
      authDocumentName(
        "authMethodRevocations",
        getMethodKey(method, normalizedValue),
      ),
      ...(profileId
        ? [
            authDocumentName(
              "authProfileMethodCooldowns",
              profileMethodCooldownId(profileId, method),
            ),
          ]
        : []),
    ];
    const documents = await transaction.batchGet(names);
    const deletes: AuthFirestoreWrite[] = [];
    for (const name of names) {
      const document = getOne(documents, name);
      if (!document) {
        continue;
      }
      const retryAtMs = cooldownRetryAtMs(document.fields);
      if (retryAtMs > now()) {
        if (name.includes("authProfileMethodCooldowns")) {
          throwProfileMethodCooldown(method, profileId || "", retryAtMs);
        }
        throwMethodCooldown(method, retryAtMs);
      }
      deletes.push(authDeleteWrite(name, true));
    }
    return deletes;
  };

  const createInitialProfile = (input: LinkInput) =>
    firestore.runTransaction(async (transaction) => {
      const loginProfile = await profileByLogin(input.uid, transaction);
      if (loginProfile) {
        return { result: loginProfile.id, writes: [] };
      }
      const indexName = authDocumentName(
        "authMethodIndex",
        getMethodKey(input.method, input.normalizedMethodValue),
      );
      const index = getOne(await transaction.batchGet([indexName]), indexName);
      if (index) {
        const profileId = cleanString(index.fields.profileId);
        const profileName = profileId
          ? authDocumentName("users", profileId)
          : "";
        const profile = profileName
          ? getOne(await transaction.batchGet([profileName]), profileName)
          : null;
        if (
          profile &&
          normalizeProfileMethod(input.method, profile.fields) ===
            input.normalizedMethodValue
        ) {
          return { result: profile.id, writes: [] };
        }
      }
      const writes = await assertCooldowns(
        transaction,
        null,
        input.method,
        input.normalizedMethodValue,
      );
      const profileId = firestore.createDocumentId();
      const nowMs = now();
      writes.push(
        authUpdateWrite(
          authDocumentName("users", profileId),
          {
            logins: [input.uid],
            custom: {
              emoji: input.requestEmoji,
              aura: input.requestAura,
            },
            mining: normalizeMiningSnapshot(),
            ...methodPatch(input, nowMs),
          },
          undefined,
          false,
        ),
        authUpdateWrite(indexName, {
          profileId,
          method: input.method,
          normalizedValue: input.normalizedMethodValue,
          updatedAtMs: nowMs,
        }),
        authUpdateWrite(
          authRecoveryJobName(profileId),
          newAuthRecoveryJob(profileId, [input.uid], [], nowMs),
          undefined,
          false,
        ),
      );
      return { result: profileId, writes };
    });

  const attachMethod = (
    input: LinkInput,
    profileId: string,
  ): Promise<AttachMethodResult> =>
    firestore.runTransaction<AttachMethodResult>(async (transaction) => {
      const profileName = authDocumentName("users", profileId);
      const indexName = authDocumentName(
        "authMethodIndex",
        getMethodKey(input.method, input.normalizedMethodValue),
      );
      const recoveryName = authRecoveryJobName(profileId);
      const snapshots = await transaction.batchGet([
        profileName,
        indexName,
        recoveryName,
      ]);
      const profile = getOne(snapshots, profileName);
      const index = getOne(snapshots, indexName);
      const recoveryDocument = getOne(snapshots, recoveryName);
      if (!profile) {
        authFailure(404, "not-found", "profile-not-found");
      }
      const loginProfile = await profileByLogin(input.uid, transaction);
      if (loginProfile && loginProfile.id !== profileId) {
        return {
          result: {
            kind: "login-profile" as const,
            profileId: loginProfile.id,
          },
          writes: [],
        };
      }
      const existing = normalizeProfileMethod(input.method, profile.fields);
      if (existing && existing !== input.normalizedMethodValue) {
        authFailure(
          409,
          "failed-precondition",
          "method-already-linked-different",
        );
      }
      const writes: AuthFirestoreWrite[] = [];
      if (!existing) {
        writes.push(
          ...(await assertCooldowns(
            transaction,
            profileId,
            input.method,
            input.normalizedMethodValue,
          )),
        );
      }
      const indexedProfileId = index ? cleanString(index.fields.profileId) : "";
      if (indexedProfileId && indexedProfileId !== profileId) {
        const indexedName = authDocumentName("users", indexedProfileId);
        const indexed = getOne(
          await transaction.batchGet([indexedName]),
          indexedName,
        );
        if (
          indexed &&
          normalizeProfileMethod(input.method, indexed.fields) ===
            input.normalizedMethodValue
        ) {
          return {
            result: {
              kind: "method-profile" as const,
              profileId: indexedProfileId,
            },
            writes: [],
          };
        }
      }
      const patch = methodPatch(input, now());
      patch.logins = uniqueStoredFirebaseUids(profile.fields.logins, [
        input.uid,
      ]);
      const nowMs = now();
      const existingRecovery = recoveryDocument
        ? parseAuthRecoveryJob(recoveryDocument)
        : null;
      if (recoveryDocument && !existingRecovery) {
        authFailure(409, "failed-precondition", "auth-recovery-job-invalid");
      }
      const recoveryJob = existingRecovery
        ? {
            ...existingRecovery,
            loginUids: uniqueStoredFirebaseUids(existingRecovery.loginUids, [
              input.uid,
            ]),
            updatedAtMs: nowMs,
          }
        : newAuthRecoveryJob(profileId, [input.uid], [], nowMs);
      writes.push(
        authUpdateWrite(profileName, patch, Object.keys(patch), true),
        authUpdateWrite(indexName, {
          profileId,
          method: input.method,
          normalizedValue: input.normalizedMethodValue,
          updatedAtMs: nowMs,
        }),
        authUpdateWrite(
          recoveryName,
          recoveryJob,
          Object.keys(recoveryJob),
          recoveryDocument
            ? recoveryDocument.updateTime
              ? { updateTime: recoveryDocument.updateTime }
              : true
            : false,
        ),
      );
      return { result: { kind: "linked" as const }, writes };
    });

  const mergeProfiles = async (
    targetProfileId: string,
    sourceProfileId: string,
    opId: string,
  ): Promise<AuthFirestoreDocument> => {
    if (targetProfileId === sourceProfileId) {
      const profile = await firestore.get(
        authDocumentName("users", targetProfileId),
      );
      if (!profile) {
        authFailure(404, "not-found", "target-profile-not-found");
      }
      return profile;
    }
    const targetName = authDocumentName("users", targetProfileId);
    const sourceName = authDocumentName("users", sourceProfileId);
    const mergeTargetName = authDocumentName(
      PROFILE_MERGE_TARGETS_COLLECTION,
      sourceProfileId,
    );
    const targetMergeTargetName = authDocumentName(
      PROFILE_MERGE_TARGETS_COLLECTION,
      targetProfileId,
    );
    const targetRecoveryName = authRecoveryJobName(targetProfileId);
    const sourceRecoveryName = authRecoveryJobName(sourceProfileId);
    const mergeResult = await firestore.runTransaction<{
      kind: "existing" | "merged";
    }>(async (transaction) => {
      const baseSnapshots = await transaction.batchGet([
        targetName,
        sourceName,
        mergeTargetName,
        targetMergeTargetName,
        targetRecoveryName,
        sourceRecoveryName,
      ]);
      const target = getOne(baseSnapshots, targetName);
      const source = getOne(baseSnapshots, sourceName);
      if (!target) {
        authFailure(404, "not-found", "target-profile-not-found");
      }
      if (
        getOne(baseSnapshots, targetRecoveryName) ||
        getOne(baseSnapshots, sourceRecoveryName)
      ) {
        authFailure(409, "aborted", "merge-recovery-pending");
      }
      const existingMergeTarget = getOne(baseSnapshots, mergeTargetName);
      const existingMergeTargetId = cleanString(
        existingMergeTarget?.fields.targetProfileId,
      );
      if (existingMergeTargetId && existingMergeTargetId !== targetProfileId) {
        authFailure(
          409,
          "failed-precondition",
          "profile-merge-target-conflict",
        );
      }
      const targetMergeTarget = getOne(baseSnapshots, targetMergeTargetName);
      if (
        targetMergeTarget &&
        cleanString(targetMergeTarget.fields.targetProfileId)
      ) {
        authFailure(
          409,
          "failed-precondition",
          "target-profile-already-merged",
        );
      }
      if (
        source &&
        existingMergeTargetId === targetProfileId &&
        cleanString(source.fields.mergedIntoProfileId) === targetProfileId
      ) {
        if (uniqueStoredFirebaseUids(source.fields.logins).length > 0) {
          authFailure(409, "failed-precondition", "merge-source-invalid");
        }
        const nowMs = now();
        return {
          result: {
            kind: "existing" as const,
          },
          writes: [
            authUpdateWrite(
              targetRecoveryName,
              newAuthRecoveryJob(
                targetProfileId,
                uniqueStoredFirebaseUids(target.fields.logins),
                [sourceProfileId],
                nowMs,
              ),
              undefined,
              false,
            ),
          ],
        };
      }
      if (!source) {
        if (existingMergeTargetId === targetProfileId) {
          return {
            result: { kind: "existing" as const },
            writes: [],
          };
        }
        authFailure(404, "not-found", "source-profile-not-found");
      }
      const nowMs = now();
      const plan = buildProfileMergePlan(target, source, nowMs);
      const names = [
        ...plan.methodIndexes.map((entry) =>
          authDocumentName(
            "authMethodIndex",
            getMethodKey(entry.method, entry.value),
          ),
        ),
        ...(plan.usernameKey
          ? [authDocumentName("usernameIndex", plan.usernameKey)]
          : []),
        ...plan.staleUsernameIndexNames,
      ];
      const snapshots = await transaction.batchGet(names);
      const externalOwnerIds = new Set<string>();
      for (const name of names) {
        const owner = cleanString(getOne(snapshots, name)?.fields.profileId);
        if (owner && owner !== targetProfileId && owner !== sourceProfileId) {
          externalOwnerIds.add(owner);
        }
      }
      const externalOwnerNames = Array.from(externalOwnerIds, (owner) =>
        authDocumentName("users", owner),
      );
      const externalOwners = await transaction.batchGet(externalOwnerNames);
      const writes: AuthFirestoreWrite[] = [];
      for (const entry of plan.methodIndexes) {
        const name = authDocumentName(
          "authMethodIndex",
          getMethodKey(entry.method, entry.value),
        );
        const index = getOne(snapshots, name);
        const owner = index ? cleanString(index.fields.profileId) : "";
        if (owner && owner !== targetProfileId && owner !== sourceProfileId) {
          const ownerProfile = getOne(
            externalOwners,
            authDocumentName("users", owner),
          );
          if (
            ownerProfile &&
            normalizeProfileMethod(entry.method, ownerProfile.fields) ===
              entry.value
          ) {
            authFailure(409, "failed-precondition", "method-index-conflict");
          }
        }
        writes.push(
          authUpdateWrite(name, {
            profileId: targetProfileId,
            method: entry.method,
            normalizedValue: entry.value,
            updatedAtMs: nowMs,
          }),
        );
      }
      if (plan.usernameKey) {
        const usernameName = authDocumentName(
          "usernameIndex",
          plan.usernameKey,
        );
        const index = getOne(snapshots, usernameName);
        const owner = index ? cleanString(index.fields.profileId) : "";
        if (owner && owner !== targetProfileId && owner !== sourceProfileId) {
          const ownerProfile = getOne(
            externalOwners,
            authDocumentName("users", owner),
          );
          if (
            ownerProfile &&
            buildUsernameLookupKey(ownerProfile.fields.username) ===
              plan.usernameKey
          ) {
            authFailure(409, "failed-precondition", "username-index-conflict");
          }
        }
        const conflicts = await transaction.query(
          "users",
          authFieldFilter(USERNAME_LOOKUP_KEY_FIELD, "EQUAL", plan.usernameKey),
          USERNAME_CONFLICT_QUERY_LIMIT,
          ["username"],
        );
        if (
          conflicts.length >= USERNAME_CONFLICT_QUERY_LIMIT ||
          conflicts.some(
            (document) =>
              document.id !== targetProfileId &&
              document.id !== sourceProfileId &&
              buildUsernameLookupKey(document.fields.username) ===
                plan.usernameKey,
          )
        ) {
          authFailure(409, "failed-precondition", "username-index-conflict");
        }
        const exactConflicts = await transaction.query(
          "users",
          authFieldFilter("username", "EQUAL", plan.mergedUsername),
          3,
          ["username"],
        );
        if (
          exactConflicts.some(
            (document) =>
              document.id !== targetProfileId &&
              document.id !== sourceProfileId,
          )
        ) {
          authFailure(409, "failed-precondition", "username-index-conflict");
        }
        if (plan.usernameKey !== plan.mergedUsername) {
          const lowercaseConflicts = await transaction.query(
            "users",
            authFieldFilter("username", "EQUAL", plan.usernameKey),
            3,
            ["username"],
          );
          if (
            lowercaseConflicts.some(
              (document) =>
                document.id !== targetProfileId &&
                document.id !== sourceProfileId,
            )
          ) {
            authFailure(409, "failed-precondition", "username-index-conflict");
          }
        }
        writes.push(
          authUpdateWrite(usernameName, {
            profileId: targetProfileId,
            username: plan.mergedUsername,
            lookupKey: plan.usernameKey,
            updatedAtMs: nowMs,
          }),
        );
      }
      const canonicalUsernameIndexName = plan.usernameKey
        ? authDocumentName("usernameIndex", plan.usernameKey)
        : "";
      for (const name of plan.staleUsernameIndexNames) {
        if (name === canonicalUsernameIndexName) {
          continue;
        }
        const stale = getOne(snapshots, name);
        const owner = stale ? cleanString(stale.fields.profileId) : "";
        if (owner === targetProfileId || owner === sourceProfileId) {
          writes.push(authDeleteWrite(name, true));
        }
      }
      const targetPaths = Array.from(
        new Set([...Object.keys(plan.merged), ...plan.deleteTargetFields]),
      );
      writes.push(
        authUpdateWrite(targetName, plan.merged, targetPaths, true),
        authUpdateWrite(mergeTargetName, {
          sourceProfileId,
          targetProfileId,
          mergedAtMs: nowMs,
          opId,
        }),
        authUpdateWrite(
          targetRecoveryName,
          newAuthRecoveryJob(
            targetProfileId,
            plan.mergedLogins,
            [sourceProfileId],
            nowMs,
          ),
          undefined,
          false,
        ),
        authUpdateWrite(
          sourceName,
          {
            logins: [],
            mergedIntoProfileId: targetProfileId,
            mergedAtMs: nowMs,
          },
          [
            "logins",
            "eth",
            "sol",
            "appleSub",
            ...PROVIDER_METADATA_FIELD_PATHS.apple,
            "xUserId",
            ...PROVIDER_METADATA_FIELD_PATHS.x,
            "username",
            USERNAME_LOOKUP_KEY_FIELD,
            "rating",
            "totalManaPoints",
            "nonce",
            "win",
            "feb2026UniqueOpponentsCount",
            "custom",
            "mining",
            "mergedIntoProfileId",
            "mergedAtMs",
          ],
          true,
        ),
      );
      return {
        result: {
          kind: "merged" as const,
        },
        writes,
      };
    });
    const mergedProfile = await firestore.get(targetName);
    if (!mergedProfile) {
      if (mergeResult.kind === "existing") {
        authFailure(404, "not-found", "target-profile-not-found");
      }
      authFailure(500, "internal", "target-profile-missing");
    }
    return mergedProfile;
  };

  const acquireCallerRecoveryBarrier = (uid: string) =>
    durableFirestore.runTransaction(async (transaction) => {
      const profile = await profileByLogin(uid, transaction);
      if (!profile || isRetiredMergeSource(profile.fields)) {
        authFailure(409, "aborted", "profile-merged-retry");
      }
      const recoveryName = authRecoveryJobName(profile.id);
      const recoveryDocument = getOne(
        await transaction.batchGet([recoveryName]),
        recoveryName,
      );
      const existingRecovery = recoveryDocument
        ? parseAuthRecoveryJob(recoveryDocument)
        : null;
      if (recoveryDocument && !existingRecovery) {
        authFailure(409, "failed-precondition", "auth-recovery-job-invalid");
      }
      const nowMs = now();
      const recoveryJob = existingRecovery
        ? {
            ...existingRecovery,
            loginUids: uniqueStoredFirebaseUids(existingRecovery.loginUids, [
              uid,
            ]),
            updatedAtMs: nowMs,
          }
        : newAuthRecoveryJob(profile.id, [uid], [], nowMs);
      return {
        result: profile,
        writes: [
          authUpdateWrite(
            recoveryName,
            recoveryJob,
            Object.keys(recoveryJob),
            recoveryDocument
              ? recoveryDocument.updateTime
                ? { updateTime: recoveryDocument.updateTime }
                : true
              : false,
          ),
        ],
      };
    });

  const repairCurrentCaller = async (
    uid: string,
  ): Promise<AuthFirestoreDocument> => {
    for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
      const profile = await acquireCallerRecoveryBarrier(uid);
      await ensureFirebaseProfileClaim(uid, profile.id, {
        authClient,
        rtdb,
        signal: dependencies.signal,
      });
      await recovery.removeLoginUid(profile.id, uid);
      const confirmed = await profileByLogin(uid);
      if (confirmed?.id !== profile.id) {
        continue;
      }
      const fresh = await firestore.get(profile.name);
      if (!fresh || isRetiredMergeSource(fresh.fields)) {
        continue;
      }
      if (await durableFirestore.get(authRecoveryJobName(profile.id))) {
        await enqueueRecoveryBestEffort(profile.id);
      }
      return fresh;
    }
    authFailure(409, "aborted", "profile-merged-retry");
  };

  const syncCurrentCallerProfile = async (
    uid: string,
  ): Promise<LinkedAuthMethodsResponse> => {
    const profile = await repairCurrentCaller(uid);
    const linkedMethods = getLinkedAuthMethodsFromProfile(profile.fields);
    return {
      ok: true,
      profileId: profile.id,
      linkedMethods,
      appleLinked: linkedMethods.apple,
    };
  };

  const recoverVerifyReplay = async (
    replay: AuthProfileResponse,
    method: AuthMethodKey,
    uid: string,
  ): Promise<AuthProfileResponse> => {
    const operation = await firestore.get(
      authDocumentName("authOps", replay.opId),
    );
    const expectedHash = cleanString(
      record(operation?.fields.meta).methodValueHash,
    );
    const profile = await repairCurrentCaller(uid);
    const currentValue = normalizeProfileMethod(method, profile.fields);
    if (
      !currentValue ||
      !expectedHash ||
      hashMethodValue(method, currentValue) !== expectedHash
    ) {
      authFailure(409, "aborted", "profile-merged-retry");
    }
    const preferredAddress =
      method === "eth" || method === "sol" ? currentValue : null;
    return profileResponse(profile, uid, preferredAddress, replay.opId);
  };

  const refreshCompletedVerifyResult = async (
    result: Pick<AuthProfileResponse, "profileId" | "opId">,
    method: AuthMethodKey,
    uid: string,
    expectedMethodValue: string,
  ): Promise<AuthProfileResponse | null> => {
    const normalizedMethodValue = normalizeMethodValue(
      method,
      expectedMethodValue,
    );
    const operation = await firestore.get(
      authDocumentName("authOps", result.opId),
    );
    const operationFields = operation?.fields;
    const updatedAtMs = Math.max(
      finiteNumber(operationFields?.updatedAtMs, 0),
      finiteNumber(operationFields?.startedAtMs, 0),
    );
    if (
      !operationFields ||
      readStoredFirebaseUid(operationFields.uid) !== uid ||
      cleanString(operationFields.kind) !== "verify" ||
      cleanString(operationFields.method) !== method ||
      operationFields.status !== "success" ||
      !updatedAtMs ||
      now() - updatedAtMs > AUTH_OP_REPLAY_TTL_MS ||
      cleanString(record(operationFields.meta).methodValueHash) !==
        hashMethodValue(method, normalizedMethodValue)
    ) {
      return null;
    }
    const profile = await repairCurrentCaller(uid);
    if (
      normalizeProfileMethod(method, profile.fields) !== normalizedMethodValue
    ) {
      return null;
    }
    const preferredAddress =
      method === "eth" || method === "sol" ? normalizedMethodValue : null;
    return profileResponse(profile, uid, preferredAddress, result.opId);
  };

  const randomUsername = (): string => {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    let value = upper[randomInteger(upper.length)];
    for (let index = 0; index < 3; index++) {
      value += lower[randomInteger(lower.length)];
    }
    return `${value}${String(randomInteger(1_000)).padStart(3, "0")}`;
  };

  const assignUsername = async (
    profile: AuthFirestoreDocument,
    preferredUsername?: string | null,
  ): Promise<AuthFirestoreDocument> => {
    const profileId = profile.id;
    const profileName = profile.name;
    if (isRetiredMergeSource(profile.fields)) {
      authFailure(409, "aborted", "profile-merged-retry");
    }
    const currentUsername = cleanString(profile.fields.username);
    if (
      (currentUsername && !isReservedExplicitUsername(currentUsername)) ||
      cleanString(profile.fields.eth) ||
      cleanString(profile.fields.sol)
    ) {
      return profile;
    }
    const preferred = cleanString(preferredUsername);
    const preferredCandidate =
      isAlphanumericUsername(preferred) &&
      !isReservedExplicitUsername(preferred)
        ? preferred
        : null;
    const attempts = AUTO_NAME_MAX_ATTEMPTS + (preferredCandidate ? 1 : 0);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const username =
        attempt === 0 && preferredCandidate
          ? preferredCandidate
          : randomUsername();
      const key = buildUsernameLookupKey(username);
      const indexName = authDocumentName("usernameIndex", key);
      const indexNames = Array.from(
        new Set(
          getUsernameIndexDocIds(username).map((id) =>
            authDocumentName("usernameIndex", id),
          ),
        ),
      );
      const claimed = await firestore.runTransaction(async (transaction) => {
        const snapshots = await transaction.batchGet([
          profileName,
          ...indexNames,
        ]);
        const liveProfile = getOne(snapshots, profileName);
        if (!liveProfile) {
          authFailure(404, "not-found", "profile-not-found");
        }
        if (isRetiredMergeSource(liveProfile.fields)) {
          authFailure(409, "aborted", "profile-merged-retry");
        }
        const explicit = cleanString(liveProfile.fields.username);
        if (
          (explicit && !isReservedExplicitUsername(explicit)) ||
          cleanString(liveProfile.fields.eth) ||
          cleanString(liveProfile.fields.sol)
        ) {
          return { result: true, writes: [] };
        }
        const ownerIds = Array.from(
          new Set(
            indexNames
              .map((name) =>
                cleanString(getOne(snapshots, name)?.fields.profileId),
              )
              .filter((owner) => owner && owner !== profileId),
          ),
        );
        const ownerNames = ownerIds.map((owner) =>
          authDocumentName("users", owner),
        );
        const owners = await transaction.batchGet(ownerNames);
        const writes: AuthFirestoreWrite[] = [];
        for (const name of indexNames) {
          const index = getOne(snapshots, name);
          if (!index) {
            continue;
          }
          const owner = cleanString(index.fields.profileId);
          if (owner && owner !== profileId) {
            const ownerProfile = getOne(
              owners,
              authDocumentName("users", owner),
            );
            if (
              ownerProfile &&
              buildUsernameLookupKey(ownerProfile.fields.username) === key
            ) {
              return { result: false, writes: [] };
            }
          }
          if (name !== indexName) {
            writes.push(authDeleteWrite(name, true));
          }
        }
        const lookupConflicts = await transaction.query(
          "users",
          authFieldFilter(USERNAME_LOOKUP_KEY_FIELD, "EQUAL", key),
          USERNAME_CONFLICT_QUERY_LIMIT,
          ["username"],
        );
        const exactConflicts = await transaction.query(
          "users",
          authFieldFilter("username", "EQUAL", username),
          2,
          ["username"],
        );
        const lowercaseConflicts =
          key === username
            ? []
            : await transaction.query(
                "users",
                authFieldFilter("username", "EQUAL", key),
                2,
                ["username"],
              );
        if (
          lookupConflicts.length >= USERNAME_CONFLICT_QUERY_LIMIT ||
          lookupConflicts.some(
            (entry) =>
              entry.id !== profileId &&
              buildUsernameLookupKey(entry.fields.username) === key,
          ) ||
          [...exactConflicts, ...lowercaseConflicts].some(
            (entry) => entry.id !== profileId,
          )
        ) {
          return { result: false, writes: [] };
        }
        return {
          result: true,
          writes: [
            ...writes,
            authUpdateWrite(indexName, {
              profileId,
              username,
              lookupKey: key,
              updatedAtMs: now(),
            }),
            authUpdateWrite(
              profileName,
              { username, [USERNAME_LOOKUP_KEY_FIELD]: key },
              ["username", USERNAME_LOOKUP_KEY_FIELD],
              true,
            ),
          ],
        };
      });
      if (claimed) {
        const refreshed = await firestore.get(profileName);
        if (refreshed) {
          return refreshed;
        }
      }
    }
    authFailure(409, "aborted", "username-generation-exhausted");
  };

  const profileResponse = (
    profile: AuthFirestoreDocument,
    uid: string,
    preferredAddress: string | null,
    opId: string,
  ): AuthProfileResponse => {
    const fields = profile.fields;
    const custom = record(fields.custom);
    const linkedMethods = getLinkedAuthMethodsFromProfile(fields);
    const eth = normalizeProfileMethod("eth", fields) || null;
    const sol = normalizeProfileMethod("sol", fields) || null;
    const emoji = Math.floor(finiteNumber(custom.emoji, 1));
    return {
      ok: true,
      uid,
      profileId: profile.id,
      username: cleanString(fields.username) || null,
      address: preferredAddress || eth || sol,
      eth,
      sol,
      linkedMethods,
      appleLinked: linkedMethods.apple,
      emoji: emoji > 0 ? emoji : 1,
      aura: cleanString(custom.aura) || null,
      rating: fields.rating == null ? null : finiteNumber(fields.rating, 0),
      nonce: fields.nonce == null ? null : finiteNumber(fields.nonce, 0),
      totalManaPoints:
        fields.totalManaPoints == null
          ? null
          : finiteNumber(fields.totalManaPoints, 0),
      cardBackgroundId:
        custom.cardBackgroundId == null
          ? null
          : finiteNumber(custom.cardBackgroundId, 0),
      cardStickers:
        typeof custom.cardStickers === "string" ? custom.cardStickers : null,
      cardSubtitleId:
        custom.cardSubtitleId == null
          ? null
          : finiteNumber(custom.cardSubtitleId, 0),
      profileCounter: cleanString(custom.profileCounter) || null,
      profileMons:
        typeof custom.profileMons === "string" ? custom.profileMons : null,
      completedProblems: Array.isArray(custom.completedProblems)
        ? custom.completedProblems.filter(
            (value): value is string => typeof value === "string",
          )
        : null,
      tutorialCompleted:
        typeof custom.tutorialCompleted === "boolean"
          ? custom.tutorialCompleted
          : null,
      mining: normalizeMiningSnapshot(fields.mining),
      opId,
    };
  };

  const recoverIncompleteVerifyOp = async (
    opId: string,
    method: AuthMethodKey,
    uid: string,
  ): Promise<AuthProfileResponse | null> => {
    const operation = await firestore.get(authDocumentName("authOps", opId));
    if (!operation) {
      return null;
    }
    const fields = operation.fields;
    const existingUid = readStoredFirebaseUid(fields.uid);
    const existingKind = cleanString(fields.kind);
    const existingMethod = cleanString(fields.method);
    if (!existingUid || !existingKind || !existingMethod) {
      return null;
    }
    if (
      existingUid !== uid ||
      existingKind !== "verify" ||
      existingMethod !== method
    ) {
      authFailure(403, "permission-denied", "op-context-mismatch");
    }
    const updatedAtMs = Math.max(
      finiteNumber(fields.updatedAtMs, 0),
      finiteNumber(fields.startedAtMs, 0),
    );
    if (!updatedAtMs || now() - updatedAtMs > AUTH_OP_REPLAY_TTL_MS) {
      return null;
    }
    const expectedHash = cleanString(record(fields.meta).methodValueHash);
    let profile = await repairCurrentCaller(uid);
    let currentValue = normalizeProfileMethod(method, profile.fields);
    if (
      !expectedHash ||
      !currentValue ||
      hashMethodValue(method, currentValue) !== expectedHash
    ) {
      return null;
    }
    if (method === "apple" || method === "x") {
      profile = await assignUsername(
        profile,
        method === "x" ? cleanString(profile.fields.xUsername) : null,
      );
      profile = await repairCurrentCaller(uid);
      currentValue = normalizeProfileMethod(method, profile.fields);
      if (
        !currentValue ||
        hashMethodValue(method, currentValue) !== expectedHash
      ) {
        return null;
      }
    }
    const preferredAddress =
      method === "eth" || method === "sol"
        ? normalizeProfileMethod(method, profile.fields)
        : null;
    const response = profileResponse(profile, uid, preferredAddress, opId);
    await finishOpBestEffort(opId, { result: response });
    return response;
  };

  const parseIntent = (
    intent: AuthFirestoreDocument | null,
    uid: string,
    method: AuthMethodKey,
    allowConsumed = false,
  ): AuthIntent => {
    if (!intent) {
      authFailure(409, "failed-precondition", "intent-not-found");
    }
    if (readStoredFirebaseUid(intent.fields.uid) !== uid) {
      authFailure(403, "permission-denied", "intent-user-mismatch");
    }
    if (cleanString(intent.fields.method) !== method) {
      authFailure(409, "failed-precondition", "intent-method-mismatch");
    }
    const consumedAtMs = finiteNumber(intent.fields.consumedAtMs, 0);
    const consumedByOpId = cleanString(intent.fields.consumedByOpId);
    if (
      finiteNumber(intent.fields.expiresAtMs, 0) < now() &&
      !(allowConsumed && consumedAtMs > 0)
    ) {
      authFailure(504, "deadline-exceeded", "intent-expired");
    }
    if (!allowConsumed && consumedAtMs > 0) {
      authFailure(409, "failed-precondition", "intent-consumed");
    }
    return {
      uid,
      method,
      nonce: cleanString(intent.fields.nonce),
      consumedAtMs,
      expiresAtMs: finiteNumber(intent.fields.expiresAtMs, 0),
      ...(consumedByOpId ? { consumedByOpId } : {}),
    };
  };

  const readIntent = async (
    uid: string,
    method: AuthMethodKey,
    intentId: string,
    opId?: string,
  ): Promise<AuthIntent> => {
    const intent = await firestore.get(
      authDocumentName("authIntents", cleanString(intentId)),
    );
    const parsed = parseIntent(intent, uid, method, Boolean(opId));
    if (parsed.consumedAtMs <= 0) {
      return parsed;
    }
    if (!opId) {
      return parseIntent(intent, uid, method);
    }
    if (parsed.consumedByOpId && parsed.consumedByOpId !== opId) {
      return parseIntent(intent, uid, method);
    }
    const operation = await firestore.get(authDocumentName("authOps", opId));
    const fields = operation?.fields;
    const updatedAtMs = Math.max(
      finiteNumber(fields?.updatedAtMs, 0),
      finiteNumber(fields?.startedAtMs, 0),
    );
    if (
      !fields ||
      readStoredFirebaseUid(fields.uid) !== uid ||
      cleanString(fields.kind) !== "verify" ||
      cleanString(fields.method) !== method ||
      cleanString(record(fields.meta).intentId) !== intentId ||
      (fields.status !== "started" &&
        fields.status !== "failed" &&
        fields.status !== "success") ||
      !updatedAtMs ||
      now() - updatedAtMs > AUTH_OP_REPLAY_TTL_MS
    ) {
      return parseIntent(intent, uid, method);
    }
    return parsed;
  };

  const consumeIntent = (
    uid: string,
    method: AuthMethodKey,
    intentId: string,
    opId?: string,
  ): Promise<AuthIntent> =>
    firestore.runTransaction(async (transaction) => {
      const name = authDocumentName("authIntents", cleanString(intentId));
      const intent = getOne(await transaction.batchGet([name]), name);
      const result = parseIntent(intent, uid, method);
      return {
        result,
        writes: [
          authUpdateWrite(
            name,
            {
              consumedAtMs: now(),
              consumedByOpId: cleanString(opId) || null,
            },
            ["consumedAtMs", "consumedByOpId"],
            true,
          ),
        ],
      };
    });

  const startVerifiedMethod = async (
    input: LinkInput,
  ): Promise<AuthProfileResponse | null> => {
    const replay = (await beginOp(
      input.opId,
      "verify",
      input.method,
      input.uid,
      {
        methodValue:
          input.method === "apple" || input.method === "x"
            ? "redacted"
            : input.methodValueRaw,
        methodValueHash: hashMethodValue(
          input.method,
          input.normalizedMethodValue,
        ),
        ...(input.intentId ? { intentId: input.intentId } : {}),
      },
    )) as AuthProfileResponse | null;
    return replay ? recoverVerifyReplay(replay, input.method, input.uid) : null;
  };

  return {
    consumeIntent,
    readIntent,
    async prepareVerifiedMethod(input, intent) {
      if (!input.intentId) {
        authFailure(400, "invalid-argument", "intentId is required.");
      }
      const replay = await startVerifiedMethod(input);
      if (replay) {
        return replay;
      }
      if (intent.consumedAtMs > 0) {
        return null;
      }
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
        ) {
          throw error;
        }
        await readIntent(input.uid, input.method, input.intentId, input.opId);
      }
      return null;
    },
    async linkVerifiedMethod(input) {
      const replay = await startVerifiedMethod(input);
      if (replay) {
        return replay;
      }
      try {
        const current = await profileByLogin(input.uid);
        const methodProfile = await profileByMethod(
          input.method,
          input.normalizedMethodValue,
          input.methodValueLookupRaw || input.methodValueRaw,
        );
        let targetProfileId =
          current?.id ??
          methodProfile?.id ??
          (await createInitialProfile(input));
        let linked = false;
        for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
          const attached = await attachMethod(input, targetProfileId);
          if (attached.kind === "linked") {
            linked = true;
            break;
          }
          if (attached.kind === "login-profile") {
            targetProfileId = attached.profileId;
            continue;
          }
          const merged = await mergeProfiles(
            targetProfileId,
            attached.profileId,
            input.opId,
          );
          targetProfileId = merged.id;
        }
        if (!linked) {
          authFailure(409, "aborted", "method-index-race-retry");
        }
        for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
          let profile = await repairCurrentCaller(input.uid);
          targetProfileId = profile.id;
          if (
            normalizeProfileMethod(input.method, profile.fields) !==
            input.normalizedMethodValue
          ) {
            authFailure(409, "aborted", "method-index-race-retry");
          }
          if (input.method === "apple" || input.method === "x") {
            try {
              profile = await assignUsername(
                profile,
                input.method === "x" ? input.xUsername : null,
              );
            } catch (error) {
              if (
                error instanceof AuthApiFailure &&
                error.message === "profile-merged-retry"
              ) {
                continue;
              }
              throw error;
            }
            profile = await repairCurrentCaller(input.uid);
          }
          const response = profileResponse(
            profile,
            input.uid,
            input.preferredAddress || null,
            input.opId,
          );
          const confirmedProfile = await profileByLogin(input.uid);
          if (confirmedProfile?.id === profile.id) {
            await finishOpBestEffort(input.opId, { result: response });
            return response;
          }
        }
        authFailure(409, "aborted", "profile-merged-retry");
      } catch (error) {
        await finishOpBestEffort(input.opId, { error });
        throw error;
      }
    },
    async peekVerifyReplay(opId, method, uid) {
      const replay = (await replayFromOp(
        opId,
        "verify",
        method,
        uid,
      )) as AuthProfileResponse | null;
      return replay
        ? recoverVerifyReplay(replay, method, uid)
        : recoverIncompleteVerifyOp(opId, method, uid);
    },
    refreshCompletedVerifyResult,
    syncCurrentCallerProfile,
    async unlinkMethod(uid, rawMethod, opId) {
      const method = assertAuthMethod(rawMethod);
      const replay = await beginOp(opId, "unlink", method, uid, null);
      if (replay) {
        return replay as LinkedAuthMethodsResponse;
      }
      try {
        for (let attempt = 0; attempt < LINK_METHOD_MAX_ATTEMPTS; attempt++) {
          const profile = await profileByLogin(uid);
          if (!profile) {
            authFailure(404, "not-found", "profile-not-found");
          }
          const profileName = profile.name;
          const recoveryName = authRecoveryJobName(profile.id);
          const committed = await firestore.runTransaction(
            async (transaction) => {
              const snapshots = await transaction.batchGet([
                profileName,
                recoveryName,
              ]);
              const live = getOne(snapshots, profileName);
              if (
                !live ||
                isRetiredMergeSource(live.fields) ||
                !uniqueStoredFirebaseUids(live.fields.logins).includes(uid)
              ) {
                return { result: null, writes: [] };
              }
              const nowMs = now();
              const recoveryDocument = getOne(snapshots, recoveryName);
              const existingRecovery = recoveryDocument
                ? parseAuthRecoveryJob(recoveryDocument)
                : null;
              if (recoveryDocument && !existingRecovery) {
                authFailure(
                  409,
                  "failed-precondition",
                  "auth-recovery-job-invalid",
                );
              }
              const recoveryJob = existingRecovery
                ? {
                    ...existingRecovery,
                    loginUids: uniqueStoredFirebaseUids(
                      existingRecovery.loginUids,
                      [uid],
                    ),
                    updatedAtMs: nowMs,
                  }
                : newAuthRecoveryJob(profile.id, [uid], [], nowMs);
              const normalizedValue = normalizeProfileMethod(
                method,
                live.fields,
              );
              const rawValue = cleanString(live.fields[getMethodField(method)]);
              if (!normalizedValue && !rawValue) {
                authFailure(409, "failed-precondition", "method-not-linked");
              }
              if (normalizedValue && linkedMethodCount(live.fields) <= 1) {
                authFailure(
                  409,
                  "failed-precondition",
                  "cannot-remove-last-method",
                );
              }
              const fieldPaths =
                method === "apple" || method === "x"
                  ? [
                      getMethodField(method),
                      ...PROVIDER_METADATA_FIELD_PATHS[method],
                    ]
                  : [getMethodField(method)];
              const writes: AuthFirestoreWrite[] = [
                authUpdateWrite(profileName, {}, fieldPaths, true),
                authUpdateWrite(
                  recoveryName,
                  recoveryJob,
                  Object.keys(recoveryJob),
                  recoveryDocument
                    ? recoveryDocument.updateTime
                      ? { updateTime: recoveryDocument.updateTime }
                      : true
                    : false,
                ),
              ];
              const retryAtMs = nowMs + AUTH_METHOD_REUSE_COOLDOWN_MS;
              writes.push(
                authUpdateWrite(
                  authDocumentName(
                    "authProfileMethodCooldowns",
                    profileMethodCooldownId(profile.id, method),
                  ),
                  {
                    profileId: profile.id,
                    method,
                    scope: getAuthCooldownScope(
                      AUTH_COOLDOWN_REASONS.profileMethod,
                    ),
                    unlinkedByUid: uid,
                    cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
                    startedAtMs: nowMs,
                    retryAtMs,
                    updatedAtMs: nowMs,
                  },
                ),
              );
              if (normalizedValue) {
                const methodId = getMethodKey(method, normalizedValue);
                const indexName = authDocumentName("authMethodIndex", methodId);
                const index = getOne(
                  await transaction.batchGet([indexName]),
                  indexName,
                );
                if (
                  !index ||
                  cleanString(index.fields.profileId) === profile.id
                ) {
                  if (index) {
                    writes.push(authDeleteWrite(indexName, true));
                  }
                }
                writes.push(
                  authUpdateWrite(
                    authDocumentName("authMethodRevocations", methodId),
                    {
                      method,
                      normalizedValue,
                      profileId: profile.id,
                      scope: getAuthCooldownScope(AUTH_COOLDOWN_REASONS.method),
                      unlinkedByUid: uid,
                      cooldownMs: AUTH_METHOD_REUSE_COOLDOWN_MS,
                      startedAtMs: nowMs,
                      retryAtMs,
                      updatedAtMs: nowMs,
                    },
                  ),
                );
              }
              const nextFields = { ...live.fields };
              for (const fieldPath of fieldPaths) {
                delete nextFields[fieldPath];
              }
              const linkedMethods = getLinkedAuthMethodsFromProfile(nextFields);
              const response: LinkedAuthMethodsResponse = {
                ok: true,
                profileId: profile.id,
                linkedMethods,
                appleLinked: linkedMethods.apple,
              };
              writes.push(
                authUpdateWrite(authDocumentName("authOps", opId), {
                  status: "success",
                  result: response,
                  updatedAtMs: nowMs,
                }),
              );
              return { result: response, writes };
            },
          );
          if (!committed) {
            continue;
          }
          const response = await syncCurrentCallerProfile(uid);
          await finishOpBestEffort(opId, { result: response });
          return response;
        }
        authFailure(409, "aborted", "profile-merged-retry");
      } catch (error) {
        const replay = await replayFromOp(opId, "unlink", method, uid);
        if (replay && isLinkedAuthMethodsResponse(replay)) {
          return replay;
        }
        await finishOpBestEffort(opId, { error });
        throw error;
      }
    },
  };
}
