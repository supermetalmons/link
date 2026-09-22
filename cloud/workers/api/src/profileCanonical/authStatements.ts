import type { CanonicalMutation } from "./types.ts";
import {
  authMethodParams,
  authOperationParams,
  cooldownParams,
  recoveryParams,
} from "./auth.ts";

type AuthMutation = Extract<
  CanonicalMutation,
  {
    kind:
      | "insert-auth-method"
      | "update-auth-method"
      | "delete-auth-method"
      | "insert-auth-operation"
      | "update-auth-operation"
      | "delete-auth-operation"
      | "insert-method-revocation"
      | "update-method-revocation"
      | "delete-method-revocation"
      | "insert-method-cooldown"
      | "update-method-cooldown"
      | "delete-method-cooldown"
      | "insert-auth-recovery"
      | "update-auth-recovery"
      | "delete-auth-recovery";
  }
>;

function authMutationStatement(
  db: D1Database,
  mutation: AuthMutation,
): D1PreparedStatement {
  switch (mutation.kind) {
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
  }
}

export function buildAuthMutationStatements(
  db: D1Database,
  mutation: AuthMutation,
): D1PreparedStatement[] {
  return [authMutationStatement(db, mutation)];
}
