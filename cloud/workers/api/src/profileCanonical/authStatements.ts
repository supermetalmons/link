import type { CanonicalMutation } from "./types.ts";
import {
  authMethodWriteRow,
  authOperationWriteRow,
  cooldownWriteRow,
  methodRevocationWriteRow,
  recoveryWriteRow,
} from "./authRows.ts";
import { canonicalRowMutationStatement } from "./rowStatements.ts";

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
    case "update-auth-method":
      return canonicalRowMutationStatement(
        db,
        "profile_auth_methods_canonical",
        ["method", "normalized_value"],
        authMethodWriteRow(mutation.value),
        mutation.kind === "insert-auth-method",
      );
    case "delete-auth-method":
      return db
        .prepare(
          `DELETE FROM profile_auth_methods_canonical
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(mutation.method, mutation.normalizedValue);
    case "insert-auth-operation":
    case "update-auth-operation":
      return canonicalRowMutationStatement(
        db,
        "profile_auth_operations_canonical",
        "operation_id",
        authOperationWriteRow(mutation.value),
        mutation.kind === "insert-auth-operation",
      );
    case "delete-auth-operation":
      return db
        .prepare(
          "DELETE FROM profile_auth_operations_canonical WHERE operation_id = ?",
        )
        .bind(mutation.operationId);
    case "insert-method-revocation":
    case "update-method-revocation":
      return canonicalRowMutationStatement(
        db,
        "profile_auth_method_revocations",
        ["method", "normalized_value"],
        methodRevocationWriteRow(mutation.value),
        mutation.kind === "insert-method-revocation",
      );
    case "delete-method-revocation":
      return db
        .prepare(
          `DELETE FROM profile_auth_method_revocations
           WHERE method = ? AND normalized_value = ?`,
        )
        .bind(mutation.method, mutation.normalizedValue);
    case "insert-method-cooldown":
    case "update-method-cooldown":
      return canonicalRowMutationStatement(
        db,
        "profile_auth_method_cooldowns",
        ["profile_id", "method"],
        cooldownWriteRow(mutation.value),
        mutation.kind === "insert-method-cooldown",
      );
    case "delete-method-cooldown":
      return db
        .prepare(
          `DELETE FROM profile_auth_method_cooldowns
           WHERE profile_id = ? AND method = ?`,
        )
        .bind(mutation.profileId, mutation.method);
    case "insert-auth-recovery":
    case "update-auth-recovery":
      return canonicalRowMutationStatement(
        db,
        "profile_auth_recovery_jobs_canonical",
        "profile_id",
        recoveryWriteRow(mutation.value),
        mutation.kind === "insert-auth-recovery",
      );
    case "delete-auth-recovery":
      return db
        .prepare(
          "DELETE FROM profile_auth_recovery_jobs_canonical WHERE profile_id = ?",
        )
        .bind(mutation.profileId);
  }
}

export function buildAuthMutationStatements(
  db: D1Database,
  mutation: AuthMutation,
): D1PreparedStatement[] {
  return [authMutationStatement(db, mutation)];
}
