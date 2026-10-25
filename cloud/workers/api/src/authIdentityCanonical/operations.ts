import {
  startedAuthOperation,
  finishedAuthOperation,
  successfulAuthOperation,
  type AuthOperationOutcome,
  type AuthOperationStartInput,
} from "./operationRecords.ts";
import {
  isAuthProfileResponse,
  isLinkedAuthMethodsResponse,
  type AuthMethodKey,
  type AuthProfileResponse,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import {
  assertAuthOperationContext,
  canCompleteVerifyOperation,
  isAuthOperationReplayExpired,
  matchesVerifiedAuthMethod,
  readVerifyOperationMeta,
  type VerifyOperationMeta,
} from "../authOperationReplay.ts";
import {
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  readCanonicalAuthOperation,
  type CanonicalAuthOperationSnapshot,
} from "../profileCanonicalD1.ts";
import {
  authFailure,
  linkedMethods,
  methodFromAggregate,
  methodValue,
  profileResponse,
} from "./policy.ts";
import type {
  CanonicalIdentityReads,
  RepairedVerifiedCaller,
} from "./types.ts";

type BegunAuthOperation = {
  operation: CanonicalAuthOperationSnapshot;
  replay: AuthProfileResponse | LinkedAuthMethodsResponse | null;
};
type BeginAuthOperation = {
  (
    operationId: string,
    kind: "verify",
    method: AuthMethodKey,
    uid: string,
    meta: VerifyOperationMeta,
  ): Promise<BegunAuthOperation>;
  (
    operationId: string,
    kind: "unlink",
    method: AuthMethodKey,
    uid: string,
    meta: null,
  ): Promise<BegunAuthOperation>;
};

export function createCanonicalAuthOperations({
  db,
  now,
  profileByLogin,
}: {
  db: D1Database;
  now: () => number;
  profileByLogin: CanonicalIdentityReads["profileByLogin"];
}) {
  const liveResponse = async (
    operation: CanonicalAuthOperationSnapshot,
  ): Promise<AuthProfileResponse | LinkedAuthMethodsResponse | null> => {
    if (
      operation.status !== "success" ||
      isAuthOperationReplayExpired(operation, now()) ||
      !operation.result
    )
      return null;
    const profile = await profileByLogin(operation.loginUid);
    if (!profile) return null;
    if (operation.kind === "verify") {
      const expectedHash = readVerifyOperationMeta(
        operation.meta,
      ).methodValueHash;
      const current = methodValue(profile.aggregate, operation.method);
      if (
        !current ||
        !matchesVerifiedAuthMethod(operation.method, current, expectedHash)
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

  const beginOperation: BeginAuthOperation = async (
    operationId,
    kind,
    method,
    uid,
    meta,
  ) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await readCanonicalAuthOperation(db, operationId);
      if (existing) {
        assertAuthOperationContext(existing, {
          kind,
          method,
          loginUid: uid,
          meta,
        });
        const replay = await liveResponse(existing);
        if (replay) return { operation: existing, replay };
        if (existing.status === "success")
          authFailure(409, "aborted", "profile-merged-retry");
        return { operation: existing, replay: null };
      }
      const timestamp = now();
      const value = startedAuthOperation({
        operationId,
        kind,
        method,
        loginUid: uid,
        meta,
        timestamp,
      } as AuthOperationStartInput);
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
    outcome: AuthOperationOutcome,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const operation = await readCanonicalAuthOperation(db, operationId);
      if (!operation || operation.status === "success") return;
      const timestamp = now();
      const value = finishedAuthOperation(operation, outcome, timestamp);
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
    outcome: AuthOperationOutcome,
  ) => {
    try {
      await finishOperation(operationId, outcome);
    } catch {
      console.error(JSON.stringify({ event: "auth_op_replay_write_failure" }));
    }
  };

  const completeVerifySuccess = async (
    operation: CanonicalAuthOperationSnapshot,
    verified: RepairedVerifiedCaller,
    result: AuthProfileResponse,
  ): Promise<boolean> => {
    if (!canCompleteVerifyOperation(operation, verified.method)) {
      return false;
    }
    const value = successfulAuthOperation(operation, result, now);
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

  return {
    beginOperation,
    finishBestEffort,
    liveResponse,
    completeVerifySuccess,
  };
}
