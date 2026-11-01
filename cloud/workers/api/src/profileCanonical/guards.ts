import {
  type D1Value,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalExpectation,
  CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
} from "./types.ts";

const UTF8_ENCODER = new TextEncoder();

export function guardStatement(
  db: D1Database,
  failurePredicate: string,
  values: D1Value[],
  kind: "conflict" | "invariant" = "conflict",
): D1PreparedStatement {
  // NOT NULL identifies optimistic guards; CHECK remains a permanent invariant.
  return db
    .prepare(
      `INSERT INTO profile_transaction_guards (singleton)
       SELECT ${kind === "conflict" ? "NULL" : "0"} WHERE ${failurePredicate}`,
    )
    .bind(...values);
}

function validateRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("invalid-canonical-revision");
  }
  return value;
}

function loginOwnerSetJson(
  profileId: string,
  owners: readonly CanonicalLoginOwnerSnapshot[],
): string {
  if (!profileId) throw new TypeError("invalid-canonical-login-owner-set");
  const sorted = [...owners].sort((left, right) => {
    const leftBytes = UTF8_ENCODER.encode(left.loginUid);
    const rightBytes = UTF8_ENCODER.encode(right.loginUid);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
      const difference = leftBytes[index]! - rightBytes[index]!;
      if (difference !== 0) return difference;
    }
    return leftBytes.length - rightBytes.length;
  });
  const seen = new Set<string>();
  for (const owner of sorted) {
    if (
      !owner.loginUid ||
      owner.profileId !== profileId ||
      seen.has(owner.loginUid) ||
      !Number.isSafeInteger(owner.createdAtMs) ||
      owner.createdAtMs < 0 ||
      !Number.isSafeInteger(owner.updatedAtMs) ||
      owner.updatedAtMs < owner.createdAtMs
    ) {
      throw new TypeError("invalid-canonical-login-owner-set");
    }
    validateRevision(owner.revision);
    seen.add(owner.loginUid);
  }
  return JSON.stringify(
    sorted.map((owner) => [
      owner.loginUid,
      owner.profileId,
      owner.revision,
      owner.createdAtMs,
      owner.updatedAtMs,
    ]),
  );
}

export function buildCanonicalGuardStatements(
  db: D1Database,
  expectations: readonly CanonicalExpectation[],
): D1PreparedStatement[] {
  return expectations.map((expectation) => {
    switch (expectation.kind) {
      case "profile-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM profile_records_canonical WHERE profile_id = ?)",
          [expectation.profileId],
        );
      case "profile-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records_canonical
             WHERE profile_id = ? AND revision = ?
           )`,
          [expectation.profileId, validateRevision(expectation.revision)],
        );
      case "username-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM profile_records_canonical WHERE username_key = ?)",
          [expectation.usernameKey],
        );
      case "username-owner":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records_canonical
             WHERE username_key = ? AND profile_id = ? AND revision = ?
           )`,
          [
            expectation.usernameKey,
            expectation.profileId,
            validateRevision(expectation.revision),
          ],
        );
      case "login-owner-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM profile_login_owners_canonical WHERE login_uid = ?)",
          [expectation.loginUid],
        );
      case "login-owner-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_login_owners_canonical
             WHERE login_uid = ? AND profile_id = ? AND revision = ?
           )`,
          [
            expectation.loginUid,
            expectation.profileId,
            validateRevision(expectation.revision),
          ],
        );
      case "login-owner-set":
        return guardStatement(
          db,
          `(
             SELECT json_group_array(
               json_array(
                 login_uid, profile_id, revision, created_at_ms, updated_at_ms
               )
             )
             FROM (
               SELECT login_uid, profile_id, revision, created_at_ms,
                      updated_at_ms
               FROM profile_login_owners_canonical
               WHERE profile_id = ?
               ORDER BY login_uid ASC
             )
           ) IS NOT json(?)`,
          [
            expectation.profileId,
            loginOwnerSetJson(expectation.profileId, expectation.owners),
          ],
        );
      case "auth-method-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_methods_canonical
             WHERE method = ? AND normalized_value = ?
           )`,
          [expectation.method, expectation.normalizedValue],
        );
      case "auth-method-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_methods_canonical
             WHERE method = ? AND normalized_value = ?
               AND profile_id = ? AND revision = ?
           )`,
          [
            expectation.method,
            expectation.normalizedValue,
            expectation.profileId,
            validateRevision(expectation.revision),
          ],
        );
      case "merge-target-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_merge_targets_canonical
             WHERE source_profile_id = ?
           )`,
          [expectation.sourceProfileId],
        );
      case "merge-target":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_merge_targets_canonical
             WHERE source_profile_id = ? AND target_profile_id = ?
           )`,
          [expectation.sourceProfileId, expectation.targetProfileId],
        );
      case "february-opponent-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_february_opponents_canonical
             WHERE profile_id = ? AND opponent_profile_id = ?
           )`,
          [expectation.profileId, expectation.opponentProfileId],
        );
      case "canonical-february-opponent-absent":
        return guardStatement(
          db,
          `EXISTS (
             WITH RECURSIVE opponent_chain(current_profile_id, depth) AS (
               SELECT opponent_profile_id, 0
               FROM profile_february_opponents_canonical
               WHERE profile_id = ?
               UNION ALL
               SELECT mapping.target_profile_id, opponent_chain.depth + 1
               FROM opponent_chain
               JOIN profile_merge_targets_canonical AS mapping
                 ON mapping.source_profile_id = opponent_chain.current_profile_id
               WHERE opponent_chain.depth <= ?
             )
             SELECT 1
             FROM opponent_chain
             LEFT JOIN profile_merge_targets_canonical AS mapping
               ON mapping.source_profile_id = opponent_chain.current_profile_id
             WHERE opponent_chain.depth > ?
                OR (
                  mapping.source_profile_id IS NULL
                  AND opponent_chain.current_profile_id = ?
                )
           )`,
          [
            expectation.profileId,
            CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
            CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
            expectation.opponentProfileId,
          ],
        );
      case "february-opponent":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_february_opponents_canonical
             WHERE profile_id = ? AND opponent_profile_id = ?
           )`,
          [expectation.profileId, expectation.opponentProfileId],
        );
      case "auth-operation-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_operations_canonical WHERE operation_id = ?
           )`,
          [expectation.operationId],
        );
      case "auth-operation-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_operations_canonical
             WHERE operation_id = ? AND revision = ?
           )`,
          [expectation.operationId, validateRevision(expectation.revision)],
        );
      case "method-revocation-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_method_revocations
             WHERE method = ? AND normalized_value = ?
           )`,
          [expectation.method, expectation.normalizedValue],
        );
      case "method-revocation-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_method_revocations
             WHERE method = ? AND normalized_value = ? AND revision = ?
           )`,
          [
            expectation.method,
            expectation.normalizedValue,
            validateRevision(expectation.revision),
          ],
        );
      case "method-cooldown-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_method_cooldowns
             WHERE profile_id = ? AND method = ?
           )`,
          [expectation.profileId, expectation.method],
        );
      case "method-cooldown-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_method_cooldowns
             WHERE profile_id = ? AND method = ? AND revision = ?
           )`,
          [
            expectation.profileId,
            expectation.method,
            validateRevision(expectation.revision),
          ],
        );
      case "auth-recovery-absent":
        return guardStatement(
          db,
          `EXISTS (
             SELECT 1 FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?
           )`,
          [expectation.profileId],
        );
      case "auth-recovery-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_auth_recovery_jobs_canonical
             WHERE profile_id = ? AND revision = ?
           )`,
          [expectation.profileId, validateRevision(expectation.revision)],
        );
      case "rating-update-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM rating_updates_canonical WHERE operation_id = ?)",
          [expectation.operationId],
        );
      case "rating-update-revision":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM rating_updates_canonical
             WHERE operation_id = ? AND revision = ?
           )`,
          [expectation.operationId, validateRevision(expectation.revision)],
        );
      case "wager-settlement-absent":
        return guardStatement(
          db,
          "EXISTS (SELECT 1 FROM wager_settlements_canonical WHERE operation_id = ?)",
          [expectation.operationId],
        );
      case "wager-settlement":
        return guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM wager_settlements_canonical
             WHERE operation_id = ? AND fingerprint = ?
           )`,
          [expectation.operationId, expectation.fingerprint],
        );
    }
  });
}
