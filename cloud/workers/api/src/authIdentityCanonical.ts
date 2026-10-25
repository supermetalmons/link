import { successfulAuthOperation } from "./authIdentityCanonical/operationRecords.ts";
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
import { AuthApiFailure } from "./authErrors.ts";
import {
  assertAuthOperationContext,
  createVerifyOperationMeta,
  isAuthOperationReplayExpired,
  matchesVerifiedAuthMethod,
  readVerifyOperationMeta,
  verifyReplayState,
} from "./authOperationReplay.ts";
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
  cleanString,
  finiteNumber,
  hashMethodValue,
  normalizeMethodValue,
  readStoredLoginUid,
} from "./authPolicy.ts";
import {
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  readCanonicalAuthMethod,
  readCanonicalAuthOperation,
  type CanonicalCooldownValue,
  type CanonicalMethodRevocationValue,
} from "./profileCanonicalD1.ts";
import {
  LINK_METHOD_MAX_ATTEMPTS,
  authFailure,
  linkedMethods,
  methodFromAggregate,
  profileResponse,
  profileValue,
  profileWithoutMethod,
  recoveryValue,
} from "./authIdentityCanonical/policy.ts";
import { createCanonicalIdentityProfiles } from "./authIdentityCanonical/profiles.ts";
import { createCanonicalAuthOperations } from "./authIdentityCanonical/operations.ts";
import { createCanonicalIdentityRepair } from "./authIdentityCanonical/repair.ts";

export { sweepExpiredCanonicalAuthCooldowns } from "./authIdentityCanonical/cooldowns.ts";

export function createCanonicalAuthIdentityService(
  env: Env,
  dependencies: ServiceDependencies = {},
): AuthIdentityService {
  const db = env.PROFILE_DB;
  const authState =
    dependencies.authState || createAuthStateRepository(env.AUTH_STATE_DB);
  const now = dependencies.now || Date.now;
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

  const { profileByLogin, createInitial, attachMethod, mergeIdentityProfiles } =
    createCanonicalIdentityProfiles({ db, now });
  const {
    beginOperation,
    finishBestEffort,
    liveResponse,
    completeVerifySuccess,
  } = createCanonicalAuthOperations({ db, now, profileByLogin });
  const { repairCallerProfile, repairVerifiedCaller } =
    createCanonicalIdentityRepair({
      db,
      env,
      now,
      randomInteger,
      profileByLogin,
    });

  const parseIntent = (
    intent: AuthIntentRecord | null,
    uid: string,
    method: AuthMethodKey,
    allowConsumed = false,
  ): AuthIntent => {
    if (!intent) authFailure(409, "failed-precondition", "intent-not-found");
    if (readStoredLoginUid(intent.uid) !== uid)
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
      readVerifyOperationMeta(operation.meta).intentId !== intentId ||
      isAuthOperationReplayExpired(operation, now())
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

  const repairCompletedVerifyReplay = async (
    input: LinkInput,
    replay: AuthProfileResponse | LinkedAuthMethodsResponse | null,
  ): Promise<AuthProfileResponse | null> => {
    if (!replay || !isAuthProfileResponse(replay)) return null;
    const completed = await repairVerifiedCaller(
      input.uid,
      input.method,
      hashMethodValue(input.method, input.normalizedMethodValue),
    );
    if (!completed) authFailure(409, "aborted", "method-index-race-retry");
    return profileResponse(completed.identity, input.uid, input.opId);
  };

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
        createVerifyOperationMeta(input),
      );
      const replay = await repairCompletedVerifyReplay(input, started.replay);
      if (replay) return replay;
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
        createVerifyOperationMeta(input),
      );
      const replay = await repairCompletedVerifyReplay(input, started.replay);
      if (replay) return replay;
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
      assertAuthOperationContext(operation, {
        kind: "verify",
        method,
        loginUid: uid,
      });
      const replayState = verifyReplayState(operation, now());
      if (!replayState) return null;
      const verified = await repairVerifiedCaller(
        uid,
        method,
        readVerifyOperationMeta(operation.meta).methodValueHash,
      );
      if (!verified) return null;
      const response = profileResponse(verified.identity, uid, opId);
      if (
        replayState === "incomplete" &&
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
      assertAuthOperationContext(operation, {
        kind: "verify",
        method,
        loginUid: uid,
      });
      const normalized = normalizeMethodValue(method, expectedMethodValue);
      if (
        operation.status !== "success" ||
        isAuthOperationReplayExpired(operation, now()) ||
        !matchesVerifiedAuthMethod(
          method,
          normalized,
          readVerifyOperationMeta(operation.meta).methodValueHash,
        )
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
          const operationValue = successfulAuthOperation(
            operation,
            response,
            () => timestamp,
          );
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
