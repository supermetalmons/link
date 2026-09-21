import { CANONICAL_PROFILE_TOPOLOGY_VIOLATION_PREDICATE } from "../profileTopologySql.ts";
import { ProfileWritesDisabledFailure } from "../authErrors.ts";
import { classifyD1Failure } from "../d1Failure.ts";
import {
  type D1Value,
  type CanonicalProfileValue,
  type CanonicalProfileSnapshot,
  type CanonicalMergeTargetValue,
  type CanonicalSingleMutation,
  type CanonicalMutation,
  type JsonObject,
  type CanonicalCommitPlan,
  type CanonicalExpectation,
  CanonicalProfileConflict,
  CanonicalProfileCorruption,
} from "./types.ts";
import { profileWriteRow } from "./profiles.ts";
import {
  authMethodParams,
  authOperationParams,
  cooldownParams,
  recoveryParams,
} from "./auth.ts";
import { ratingProjectionWriteRow, ratingWriteRow } from "./accounting.ts";
import { guardStatement, buildCanonicalGuardStatements } from "./guards.ts";

function canonicalRowMutationStatement<Row extends Record<string, D1Value>>(
  db: D1Database,
  table: "profile_records" | "rating_updates",
  keyColumn: keyof Row & string,
  row: Row,
  insert: boolean,
  current?: Row,
): D1PreparedStatement {
  const fields = Object.entries(row);
  if (insert) {
    return db
      .prepare(
        `INSERT INTO ${table} (${fields.map(([column]) => column).join(", ")}, revision)
         VALUES (${fields.map(() => "?").join(", ")}, 1)`,
      )
      .bind(...fields.map(([, value]) => value));
  }
  const updates = fields.filter(
    ([column, value]) =>
      column !== keyColumn && (!current || current[column] !== value),
  );
  return db
    .prepare(
      `UPDATE ${table} SET
         ${[...updates.map(([column]) => `${column} = ?`), "revision = revision + 1"].join(", ")}
       WHERE ${keyColumn} = ?`,
    )
    .bind(...updates.map(([, value]) => value), row[keyColumn]);
}

function profileMutationStatement(
  db: D1Database,
  value: CanonicalProfileValue,
  insert: boolean,
  current?: CanonicalProfileSnapshot,
): D1PreparedStatement {
  return canonicalRowMutationStatement(
    db,
    "profile_records",
    "profile_id",
    profileWriteRow(value),
    insert,
    current ? profileWriteRow(current) : undefined,
  );
}

function mergeTargetMutationStatement(
  db: D1Database,
  value: CanonicalMergeTargetValue,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO profile_merge_targets (
         source_profile_id, target_profile_id, merged_at_ms, op_id,
         source_legacy_fields_json
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      value.sourceProfileId,
      value.targetProfileId,
      value.mergedAtMs,
      value.opId,
      JSON.stringify(value.sourceLegacyFields),
    );
}

function mutationStatement(
  db: D1Database,
  mutation: CanonicalSingleMutation,
): D1PreparedStatement {
  switch (mutation.kind) {
    case "insert-login-owner":
      return db
        .prepare(
          `INSERT INTO profile_login_owners (
             login_uid, profile_id, revision, created_at_ms, updated_at_ms
           ) VALUES (?, ?, 1, ?, ?)`,
        )
        .bind(
          mutation.value.loginUid,
          mutation.value.profileId,
          mutation.value.createdAtMs,
          mutation.value.updatedAtMs,
        );
    case "update-login-owner":
      return db
        .prepare(
          `UPDATE profile_login_owners SET
             profile_id = ?, updated_at_ms = ?, revision = revision + 1
           WHERE login_uid = ?`,
        )
        .bind(
          mutation.value.profileId,
          mutation.value.updatedAtMs,
          mutation.value.loginUid,
        );
    case "move-login-owner-set":
      return db
        .prepare(
          `UPDATE profile_login_owners SET
             profile_id = ?, updated_at_ms = ?, revision = revision + 1
           WHERE profile_id = ?`,
        )
        .bind(
          mutation.targetProfileId,
          mutation.updatedAtMs,
          mutation.sourceProfileId,
        );
    case "delete-login-owner":
      return db
        .prepare("DELETE FROM profile_login_owners WHERE login_uid = ?")
        .bind(mutation.loginUid);
    case "insert-auth-method":
      return db
        .prepare(
          `INSERT INTO profile_auth_methods (
             method, normalized_value, profile_id, raw_value,
             apple_email_masked, x_username, linked_at_ms, consent_at_ms,
             consent_source, created_at_ms, updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(...authMethodParams(mutation.value));
    case "update-auth-method": {
      const values = authMethodParams(mutation.value);
      const [method, normalizedValue, ...updates] = values;
      return db
        .prepare(
          `UPDATE profile_auth_methods SET
             profile_id = ?, raw_value = ?, apple_email_masked = ?,
             x_username = ?, linked_at_ms = ?, consent_at_ms = ?,
             consent_source = ?, created_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(...updates, method, normalizedValue);
    }
    case "delete-auth-method":
      return db
        .prepare(
          `DELETE FROM profile_auth_methods
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(mutation.method, mutation.normalizedValue);
    case "insert-february-opponent":
      return db
        .prepare(
          `INSERT INTO profile_february_opponents (
             profile_id, opponent_profile_id, recorded_at_ms
           ) VALUES (?, ?, ?)`,
        )
        .bind(
          mutation.profileId,
          mutation.opponentProfileId,
          mutation.recordedAtMs,
        );
    case "delete-february-opponent":
      return db
        .prepare(
          `DELETE FROM profile_february_opponents
           WHERE profile_id = ? AND opponent_profile_id = ?`,
        )
        .bind(mutation.profileId, mutation.opponentProfileId);
    case "insert-auth-operation":
      return db
        .prepare(
          `INSERT INTO profile_auth_operations (
             operation_id, kind, method, login_uid, status, meta_json,
             result_json, error_code, error_message, started_at_ms,
             updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(...authOperationParams(mutation.value));
    case "update-auth-operation": {
      const [operationId, ...updates] = authOperationParams(mutation.value);
      return db
        .prepare(
          `UPDATE profile_auth_operations SET
             kind = ?, method = ?, login_uid = ?, status = ?, meta_json = ?,
             result_json = ?, error_code = ?, error_message = ?,
             started_at_ms = ?, updated_at_ms = ?, revision = revision + 1
           WHERE operation_id = ?`,
        )
        .bind(...updates, operationId);
    }
    case "delete-auth-operation":
      return db
        .prepare("DELETE FROM profile_auth_operations WHERE operation_id = ?")
        .bind(mutation.operationId);
    case "insert-method-revocation":
      return db
        .prepare(
          `INSERT INTO profile_auth_method_revocations (
             method, normalized_value, profile_id, scope, unlinked_by_uid,
             cooldown_ms, started_at_ms, retry_at_ms, updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          mutation.value.method,
          mutation.value.normalizedValue,
          ...cooldownParams(mutation.value).filter((_, index) => index !== 1),
        );
    case "update-method-revocation":
      return db
        .prepare(
          `UPDATE profile_auth_method_revocations SET
             profile_id = ?, scope = ?, unlinked_by_uid = ?, cooldown_ms = ?,
             started_at_ms = ?, retry_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(
          mutation.value.profileId,
          mutation.value.scope,
          mutation.value.unlinkedByUid,
          mutation.value.cooldownMs,
          mutation.value.startedAtMs,
          mutation.value.retryAtMs,
          mutation.value.updatedAtMs,
          mutation.value.method,
          mutation.value.normalizedValue,
        );
    case "delete-method-revocation":
      return db
        .prepare(
          `DELETE FROM profile_auth_method_revocations
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(mutation.method, mutation.normalizedValue);
    case "insert-method-cooldown":
      return db
        .prepare(
          `INSERT INTO profile_auth_method_cooldowns (
             profile_id, method, scope, unlinked_by_uid, cooldown_ms,
             started_at_ms, retry_at_ms, updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(...cooldownParams(mutation.value));
    case "update-method-cooldown": {
      const [profileId, method, ...updates] = cooldownParams(mutation.value);
      return db
        .prepare(
          `UPDATE profile_auth_method_cooldowns SET
             scope = ?, unlinked_by_uid = ?, cooldown_ms = ?,
             started_at_ms = ?, retry_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1
           WHERE profile_id = ? AND method = ?`,
        )
        .bind(...updates, profileId, method);
    }
    case "delete-method-cooldown":
      return db
        .prepare(
          `DELETE FROM profile_auth_method_cooldowns
           WHERE profile_id = ? AND method = ?`,
        )
        .bind(mutation.profileId, mutation.method);
    case "insert-auth-recovery":
      return db
        .prepare(
          `INSERT INTO profile_auth_recovery_jobs (
             profile_id, login_uids_json, source_profile_ids_json,
             source_phase, prize_cursor, phase_started_at_ms,
             last_enqueued_at_ms, created_at_ms, updated_at_ms, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(...recoveryParams(mutation.value));
    case "update-auth-recovery": {
      const [profileId, ...updates] = recoveryParams(mutation.value);
      return db
        .prepare(
          `UPDATE profile_auth_recovery_jobs SET
             login_uids_json = ?, source_profile_ids_json = ?,
             source_phase = ?, prize_cursor = ?, phase_started_at_ms = ?,
             last_enqueued_at_ms = ?, created_at_ms = ?, updated_at_ms = ?,
             revision = revision + 1
           WHERE profile_id = ?`,
        )
        .bind(...updates, profileId);
    }
    case "delete-auth-recovery":
      return db
        .prepare("DELETE FROM profile_auth_recovery_jobs WHERE profile_id = ?")
        .bind(mutation.profileId);
    case "insert-rating-update":
    case "update-rating-update":
      return canonicalRowMutationStatement(
        db,
        "rating_updates",
        "operation_id",
        ratingWriteRow(mutation.value),
        mutation.kind === "insert-rating-update",
      );
    case "update-rating-projection":
      return canonicalRowMutationStatement(
        db,
        "rating_updates",
        "operation_id",
        ratingProjectionWriteRow(mutation.value, mutation.projection),
        false,
      );
    case "delete-rating-update":
      return db
        .prepare("DELETE FROM rating_updates WHERE operation_id = ?")
        .bind(mutation.operationId);
    case "insert-wager-settlement":
      return db
        .prepare(
          `INSERT INTO wager_settlements (
             operation_id, fingerprint, winner_profile_id, loser_profile_id,
             material, count, applied_at_ms, outcome, revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          mutation.value.operationId,
          mutation.value.fingerprint,
          mutation.value.winnerProfileId,
          mutation.value.loserProfileId,
          mutation.value.material,
          mutation.value.count,
          mutation.value.appliedAtMs,
          mutation.value.outcome,
        );
  }
}

function profileLinkCatchupOwnerStatement(
  db: D1Database,
  source: { loginUid: string } | { profileId: string },
  profileId: string,
  nowMs: number,
  skipUnchangedOwner: boolean,
): D1PreparedStatement {
  const byLogin = "loginUid" in source;
  return db
    .prepare(
      `INSERT INTO profile_link_catchup_jobs (
         login_uid, request_id, profile_id, cleanup_profile_ids_json,
         match_cursor, source_updated_at_ms, last_queued_at_ms, revision
       )
       SELECT owner.login_uid, ?, ?,
         (
           SELECT json_group_array(profile_id) FROM (
             SELECT profile_id FROM (
               SELECT value AS profile_id
               FROM json_each(COALESCE(job.cleanup_profile_ids_json, '[]'))
               UNION SELECT job.profile_id WHERE job.profile_id IS NOT NULL
               UNION SELECT owner.profile_id
             ) WHERE profile_id != ? ORDER BY profile_id
           )
         ),
         NULL, MAX(?, COALESCE(job.source_updated_at_ms, 0)), ?,
         COALESCE(job.revision, 0) + 1
       FROM profile_login_owners AS owner
       LEFT JOIN profile_link_catchup_jobs AS job
         ON job.login_uid = owner.login_uid
       WHERE owner.${byLogin ? "login_uid" : "profile_id"} = ?
         ${skipUnchangedOwner ? "AND owner.profile_id != ?" : ""}
       ON CONFLICT (login_uid) DO UPDATE SET
         request_id = excluded.request_id,
         profile_id = excluded.profile_id,
         cleanup_profile_ids_json = excluded.cleanup_profile_ids_json,
         match_cursor = NULL,
         source_updated_at_ms = excluded.source_updated_at_ms,
         last_queued_at_ms = excluded.last_queued_at_ms,
         revision = excluded.revision`,
    )
    .bind(
      crypto.randomUUID(),
      profileId,
      profileId,
      nowMs,
      nowMs,
      byLogin ? source.loginUid : source.profileId,
      ...(skipUnchangedOwner ? [profileId] : []),
    );
}

function mutationStatements(
  db: D1Database,
  mutation: CanonicalMutation,
): D1PreparedStatement[] {
  switch (mutation.kind) {
    case "insert-login-owner":
      return [
        mutationStatement(db, mutation),
        profileLinkCatchupOwnerStatement(
          db,
          { loginUid: mutation.value.loginUid },
          mutation.value.profileId,
          mutation.value.updatedAtMs,
          false,
        ),
      ];
    case "update-login-owner":
      return [
        profileLinkCatchupOwnerStatement(
          db,
          { loginUid: mutation.value.loginUid },
          mutation.value.profileId,
          mutation.value.updatedAtMs,
          true,
        ),
        mutationStatement(db, mutation),
      ];
    case "move-login-owner-set":
      return [
        profileLinkCatchupOwnerStatement(
          db,
          { profileId: mutation.sourceProfileId },
          mutation.targetProfileId,
          mutation.updatedAtMs,
          true,
        ),
        mutationStatement(db, mutation),
      ];
    case "insert-active-profile":
      return [profileMutationStatement(db, mutation.value, true)];
    case "update-active-profile":
    case "patch-active-profile":
      return [
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE profile_id = ? AND state = 'active'
           )`,
          [mutation.value.profile.id],
          "invariant",
        ),
        profileMutationStatement(
          db,
          mutation.value,
          false,
          mutation.kind === "patch-active-profile"
            ? mutation.current
            : undefined,
        ),
      ];
    case "retire-profile-with-redirect":
      return [
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE profile_id = ? AND state = 'active'
           )`,
          [mutation.profile.profile.id],
          "invariant",
        ),
        profileMutationStatement(db, mutation.profile, false),
        mergeTargetMutationStatement(db, mutation.redirect),
      ];
    case "delete-retired-profile":
      return [
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM profile_records
             WHERE profile_id = ? AND state = 'retiring'
               AND merged_into_profile_id = ?
           )`,
          [mutation.profileId, mutation.targetProfileId],
          "invariant",
        ),
        db
          .prepare(
            `DELETE FROM profile_records
             WHERE profile_id = ? AND state = 'retiring'
               AND merged_into_profile_id = ?`,
          )
          .bind(mutation.profileId, mutation.targetProfileId),
      ];
    default:
      return [mutationStatement(db, mutation)];
  }
}

function sameJsonObject(left: JsonObject, right: JsonObject): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function validateCanonicalCommitPlan(plan: CanonicalCommitPlan): void {
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

function canonicalTopologyProfileIds(plan: CanonicalCommitPlan): string[] {
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

function canonicalTopologyGuardStatement(
  db: D1Database,
  plan: CanonicalCommitPlan,
): D1PreparedStatement {
  return guardStatement(
    db,
    CANONICAL_PROFILE_TOPOLOGY_VIOLATION_PREDICATE,
    [JSON.stringify(canonicalTopologyProfileIds(plan))],
    "invariant",
  );
}

export async function commitCanonicalPlan(
  db: D1Database,
  plan: CanonicalCommitPlan,
  { maxStatements }: { maxStatements?: number } = {},
): Promise<void> {
  validateCanonicalCommitPlan(plan);
  if (
    maxStatements !== undefined &&
    (!Number.isSafeInteger(maxStatements) || maxStatements < 0)
  ) {
    throw new TypeError("invalid-canonical-commit-budget");
  }
  if (plan.mutations.length === 0) return;
  const statements = [
    guardStatement(
      db,
      `NOT EXISTS (
         SELECT 1 FROM profile_canonical_control
         WHERE singleton = 1 AND state = 'active'
       )`,
      [],
      "invariant",
    ),
    ...buildCanonicalGuardStatements(db, plan.expectations),
    ...plan.mutations.flatMap((mutation) => mutationStatements(db, mutation)),
    canonicalTopologyGuardStatement(db, plan),
  ];
  if (maxStatements !== undefined && statements.length > maxStatements) {
    throw new CanonicalProfileCorruption();
  }
  try {
    await db.batch(statements);
  } catch (error) {
    const failure = classifyD1Failure(error);
    if (failure === "profile-conflict" || failure === "username-conflict") {
      throw new CanonicalProfileConflict({ cause: error });
    }
    if (failure === "guard") {
      let control: { state: string } | null;
      try {
        control = await db
          .withSession("first-primary")
          .prepare(
            "SELECT state FROM profile_canonical_control WHERE singleton = 1",
          )
          .first<{ state: string }>();
      } catch {
        throw new Error("canonical-profile-unavailable", { cause: error });
      }
      if (control?.state === "frozen") {
        throw new ProfileWritesDisabledFailure({ cause: error });
      }
      throw new CanonicalProfileCorruption({ cause: error });
    }
    if (failure !== "unknown") {
      throw new CanonicalProfileCorruption({ cause: error });
    }
    throw error;
  }
}
