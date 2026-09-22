import type {
  JsonObject,
  CanonicalCommitPlan,
  CanonicalExpectation,
} from "./types.ts";

function sameJsonObject(left: JsonObject, right: JsonObject): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function validateCanonicalCommitPlan(plan: CanonicalCommitPlan): void {
  const has = (
    predicate: (expectation: CanonicalExpectation) => boolean,
  ): boolean => plan.expectations.some(predicate);
  const requireExpectation = (covered: boolean): void => {
    if (!covered) throw new TypeError("unsafe-canonical-commit-plan");
  };
  const ownerMoveProfileIds = new Set<string>();
  for (const mutation of plan.mutations) {
    if (mutation.kind !== "move-login-owner-set") continue;
    if (
      ownerMoveProfileIds.has(mutation.sourceProfileId) ||
      ownerMoveProfileIds.has(mutation.targetProfileId)
    ) {
      throw new TypeError("unsafe-canonical-commit-plan");
    }
    ownerMoveProfileIds.add(mutation.sourceProfileId);
    ownerMoveProfileIds.add(mutation.targetProfileId);
  }
  if (
    plan.mutations.some((mutation) => {
      if (mutation.kind === "insert-login-owner") {
        return ownerMoveProfileIds.has(mutation.value.profileId);
      }
      if (
        mutation.kind !== "update-login-owner" &&
        mutation.kind !== "delete-login-owner"
      ) {
        return false;
      }
      const loginUid =
        mutation.kind === "update-login-owner"
          ? mutation.value.loginUid
          : mutation.loginUid;
      const current = plan.expectations.find(
        (expectation) =>
          expectation.kind === "login-owner-revision" &&
          expectation.loginUid === loginUid,
      );
      return (
        (mutation.kind === "update-login-owner" &&
          ownerMoveProfileIds.has(mutation.value.profileId)) ||
        (current?.kind === "login-owner-revision" &&
          ownerMoveProfileIds.has(current.profileId))
      );
    })
  ) {
    throw new TypeError("unsafe-canonical-commit-plan");
  }
  const lifecycleProfileIds = new Set<string>();
  const requireUniqueLifecycleProfile = (profileId: string): void => {
    if (!profileId || lifecycleProfileIds.has(profileId)) {
      throw new TypeError("unsafe-canonical-commit-plan");
    }
    lifecycleProfileIds.add(profileId);
  };
  for (const mutation of plan.mutations) {
    switch (mutation.kind) {
      case "insert-active-profile":
        requireUniqueLifecycleProfile(mutation.value.profile.id);
        requireExpectation(mutation.value.state === "active");
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-absent" &&
              expectation.profileId === mutation.value.profile.id,
          ),
        );
        break;
      case "update-active-profile":
      case "patch-active-profile":
        requireUniqueLifecycleProfile(mutation.value.profile.id);
        requireExpectation(mutation.value.state === "active");
        if (mutation.kind === "patch-active-profile") {
          requireExpectation(
            mutation.current.state === "active" &&
              mutation.current.profileId === mutation.value.profile.id &&
              mutation.current.profile.id === mutation.value.profile.id,
          );
        }
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-revision" &&
              expectation.profileId === mutation.value.profile.id &&
              (mutation.kind !== "patch-active-profile" ||
                expectation.revision === mutation.current.revision),
          ),
        );
        break;
      case "retire-profile-with-redirect": {
        const sourceProfileId = mutation.profile.profile.id;
        const targetProfileId = mutation.redirect.targetProfileId;
        requireUniqueLifecycleProfile(sourceProfileId);
        requireExpectation(
          mutation.profile.state === "retiring" &&
            mutation.profile.mergedIntoProfileId === targetProfileId &&
            mutation.profile.mergedAtMs !== null &&
            mutation.redirect.sourceProfileId === sourceProfileId &&
            mutation.redirect.mergedAtMs === mutation.profile.mergedAtMs &&
            sourceProfileId !== targetProfileId &&
            sameJsonObject(
              mutation.profile.legacyFields,
              mutation.redirect.sourceLegacyFields,
            ),
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-revision" &&
              expectation.profileId === sourceProfileId,
          ),
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-revision" &&
              expectation.profileId === targetProfileId,
          ),
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "merge-target-absent" &&
              expectation.sourceProfileId === sourceProfileId,
          ),
        );
        break;
      }
      case "delete-retired-profile":
        requireUniqueLifecycleProfile(mutation.profileId);
        requireExpectation(
          mutation.profileId !== "" &&
            mutation.targetProfileId !== "" &&
            mutation.profileId !== mutation.targetProfileId,
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "profile-revision" &&
              expectation.profileId === mutation.profileId,
          ),
        );
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "merge-target" &&
              expectation.sourceProfileId === mutation.profileId &&
              expectation.targetProfileId === mutation.targetProfileId,
          ),
        );
        break;
      case "insert-login-owner":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "login-owner-absent" &&
              expectation.loginUid === mutation.value.loginUid,
          ),
        );
        break;
      case "update-login-owner":
      case "delete-login-owner": {
        const loginUid =
          mutation.kind === "update-login-owner"
            ? mutation.value.loginUid
            : mutation.loginUid;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "login-owner-revision" &&
              expectation.loginUid === loginUid,
          ),
        );
        break;
      }
      case "move-login-owner-set": {
        const sourceExpectation = plan.expectations.find(
          (candidate) =>
            candidate.kind === "login-owner-set" &&
            candidate.profileId === mutation.sourceProfileId,
        );
        const targetExpectation = plan.expectations.find(
          (candidate) =>
            candidate.kind === "login-owner-set" &&
            candidate.profileId === mutation.targetProfileId,
        );
        requireExpectation(
          sourceExpectation !== undefined && targetExpectation !== undefined,
        );
        if (
          !mutation.sourceProfileId ||
          !mutation.targetProfileId ||
          mutation.sourceProfileId === mutation.targetProfileId ||
          !Number.isSafeInteger(mutation.updatedAtMs) ||
          mutation.updatedAtMs < 0 ||
          (sourceExpectation?.kind === "login-owner-set" &&
            sourceExpectation.owners.some(
              (owner) => owner.createdAtMs > mutation.updatedAtMs,
            ))
        ) {
          throw new TypeError("invalid-canonical-login-owner-move");
        }
        break;
      }
      case "insert-auth-method":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-method-absent" &&
              expectation.method === mutation.value.method &&
              expectation.normalizedValue === mutation.value.normalizedValue,
          ),
        );
        break;
      case "update-auth-method":
      case "delete-auth-method": {
        const method =
          mutation.kind === "update-auth-method"
            ? mutation.value.method
            : mutation.method;
        const normalizedValue =
          mutation.kind === "update-auth-method"
            ? mutation.value.normalizedValue
            : mutation.normalizedValue;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-method-revision" &&
              expectation.method === method &&
              expectation.normalizedValue === normalizedValue,
          ),
        );
        break;
      }
      case "insert-february-opponent":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "february-opponent-absent" &&
              expectation.profileId === mutation.profileId &&
              expectation.opponentProfileId === mutation.opponentProfileId,
          ),
        );
        break;
      case "delete-february-opponent":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "february-opponent" &&
              expectation.profileId === mutation.profileId &&
              expectation.opponentProfileId === mutation.opponentProfileId,
          ),
        );
        break;
      case "insert-auth-operation":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-operation-absent" &&
              expectation.operationId === mutation.value.operationId,
          ),
        );
        break;
      case "update-auth-operation":
      case "delete-auth-operation": {
        const operationId =
          mutation.kind === "update-auth-operation"
            ? mutation.value.operationId
            : mutation.operationId;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-operation-revision" &&
              expectation.operationId === operationId,
          ),
        );
        break;
      }
      case "insert-method-revocation":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "method-revocation-absent" &&
              expectation.method === mutation.value.method &&
              expectation.normalizedValue === mutation.value.normalizedValue,
          ),
        );
        break;
      case "update-method-revocation":
      case "delete-method-revocation": {
        const method =
          mutation.kind === "update-method-revocation"
            ? mutation.value.method
            : mutation.method;
        const normalizedValue =
          mutation.kind === "update-method-revocation"
            ? mutation.value.normalizedValue
            : mutation.normalizedValue;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "method-revocation-revision" &&
              expectation.method === method &&
              expectation.normalizedValue === normalizedValue,
          ),
        );
        break;
      }
      case "insert-method-cooldown":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "method-cooldown-absent" &&
              expectation.profileId === mutation.value.profileId &&
              expectation.method === mutation.value.method,
          ),
        );
        break;
      case "update-method-cooldown":
      case "delete-method-cooldown": {
        const profileId =
          mutation.kind === "update-method-cooldown"
            ? mutation.value.profileId
            : mutation.profileId;
        const method =
          mutation.kind === "update-method-cooldown"
            ? mutation.value.method
            : mutation.method;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "method-cooldown-revision" &&
              expectation.profileId === profileId &&
              expectation.method === method,
          ),
        );
        break;
      }
      case "insert-auth-recovery":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-recovery-absent" &&
              expectation.profileId === mutation.value.profileId,
          ),
        );
        break;
      case "update-auth-recovery":
      case "delete-auth-recovery": {
        const profileId =
          mutation.kind === "update-auth-recovery"
            ? mutation.value.profileId
            : mutation.profileId;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "auth-recovery-revision" &&
              expectation.profileId === profileId,
          ),
        );
        break;
      }
      case "insert-rating-update":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "rating-update-absent" &&
              expectation.operationId === mutation.value.operationId,
          ),
        );
        break;
      case "update-rating-update":
      case "update-rating-projection":
      case "delete-rating-update": {
        const operationId =
          mutation.kind === "delete-rating-update"
            ? mutation.operationId
            : mutation.value.operationId;
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "rating-update-revision" &&
              expectation.operationId === operationId,
          ),
        );
        break;
      }
      case "insert-wager-settlement":
        requireExpectation(
          has(
            (expectation) =>
              expectation.kind === "wager-settlement-absent" &&
              expectation.operationId === mutation.value.operationId,
          ),
        );
        break;
    }
  }
}

export function canonicalTopologyProfileIds(
  plan: CanonicalCommitPlan,
): string[] {
  const profileIds = new Set<string>();
  for (const mutation of plan.mutations) {
    switch (mutation.kind) {
      case "insert-active-profile":
      case "update-active-profile":
      case "patch-active-profile":
        profileIds.add(mutation.value.profile.id);
        break;
      case "retire-profile-with-redirect":
        profileIds.add(mutation.profile.profile.id);
        profileIds.add(mutation.redirect.targetProfileId);
        break;
      case "delete-retired-profile":
        profileIds.add(mutation.profileId);
        profileIds.add(mutation.targetProfileId);
        break;
      case "insert-login-owner":
      case "insert-auth-method":
      case "insert-auth-recovery":
      case "update-auth-recovery":
        profileIds.add(mutation.value.profileId);
        break;
      case "delete-auth-recovery":
        profileIds.add(mutation.profileId);
        break;
      case "move-login-owner-set":
        profileIds.add(mutation.sourceProfileId);
        profileIds.add(mutation.targetProfileId);
        break;
      case "update-login-owner":
      case "delete-login-owner": {
        const loginUid =
          mutation.kind === "update-login-owner"
            ? mutation.value.loginUid
            : mutation.loginUid;
        const previous = plan.expectations.find(
          (expectation) =>
            expectation.kind === "login-owner-revision" &&
            expectation.loginUid === loginUid,
        );
        if (previous?.kind !== "login-owner-revision") {
          throw new TypeError("unsafe-canonical-commit-plan");
        }
        profileIds.add(previous.profileId);
        if (mutation.kind === "update-login-owner") {
          profileIds.add(mutation.value.profileId);
        }
        break;
      }
      case "update-auth-method":
      case "delete-auth-method": {
        const identity =
          mutation.kind === "update-auth-method" ? mutation.value : mutation;
        const previous = plan.expectations.find(
          (expectation) =>
            expectation.kind === "auth-method-revision" &&
            expectation.method === identity.method &&
            expectation.normalizedValue === identity.normalizedValue,
        );
        if (previous?.kind !== "auth-method-revision") {
          throw new TypeError("unsafe-canonical-commit-plan");
        }
        profileIds.add(previous.profileId);
        if (mutation.kind === "update-auth-method") {
          profileIds.add(mutation.value.profileId);
        }
        break;
      }
      case "insert-february-opponent":
      case "delete-february-opponent":
      case "insert-auth-operation":
      case "update-auth-operation":
      case "delete-auth-operation":
      case "insert-method-revocation":
      case "update-method-revocation":
      case "delete-method-revocation":
      case "insert-method-cooldown":
      case "update-method-cooldown":
      case "delete-method-cooldown":
      case "insert-rating-update":
      case "update-rating-update":
      case "update-rating-projection":
      case "delete-rating-update":
      case "insert-wager-settlement":
        break;
      default: {
        const unsupported: never = mutation;
        throw new TypeError("unsafe-canonical-commit-plan", {
          cause: unsupported,
        });
      }
    }
  }
  return [...profileIds];
}
