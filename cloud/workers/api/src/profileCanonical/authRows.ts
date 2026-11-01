import { AUTH_METHODS } from "@mons/shared/auth";
import {
  parseCanonicalAuthOperationRow,
  parseCanonicalAuthMethodRow,
  parseCanonicalAuthRecoveryRow,
  parseCanonicalCooldownRow,
} from "./authRecords.ts";
import type {
  AuthMethodRow,
  AuthOperationRow,
  CanonicalAuthMethodValue,
  CanonicalAuthOperationValue,
  CanonicalAuthRecoveryValue,
  CanonicalCooldownValue,
  CanonicalMethodRevocationValue,
  RecoveryRow,
} from "./types.ts";

export function authMethodWriteRow(
  value: CanonicalAuthMethodValue,
): Omit<AuthMethodRow, "revision"> {
  if (
    !AUTH_METHODS.includes(value.method) ||
    !value.normalizedValue ||
    !value.profileId ||
    !value.rawValue
  ) {
    throw new TypeError("invalid-canonical-auth-method");
  }
  const row: Omit<AuthMethodRow, "revision"> = {
    method: value.method,
    normalized_value: value.normalizedValue,
    profile_id: value.profileId,
    raw_value: value.rawValue,
    apple_email_masked: value.appleEmailMasked,
    x_username: value.xUsername,
    linked_at_ms: value.linkedAtMs,
    consent_at_ms: value.consentAtMs,
    consent_source: value.consentSource,
    created_at_ms: value.createdAtMs,
    updated_at_ms: value.updatedAtMs,
  };
  parseCanonicalAuthMethodRow({ ...row, revision: 1 });
  return row;
}

export function authOperationWriteRow(
  value: CanonicalAuthOperationValue,
): Omit<AuthOperationRow, "revision"> {
  const row: Omit<AuthOperationRow, "revision"> = {
    schema_version: 1,
    operation_id: value.operationId,
    kind: value.kind,
    method: value.method,
    login_uid: value.loginUid,
    status: value.status,
    meta_json: value.meta === null ? null : JSON.stringify(value.meta),
    result_json: value.result === null ? null : JSON.stringify(value.result),
    error_code: value.errorCode,
    error_message: value.errorMessage,
    started_at_ms: value.startedAtMs,
    updated_at_ms: value.updatedAtMs,
    cancelled_at_ms: value.cancelledAtMs,
    cancellation_reason: value.cancellationReason,
  };
  parseCanonicalAuthOperationRow({ ...row, revision: 1 });
  return row;
}

export function cooldownWriteRow(value: CanonicalCooldownValue) {
  const row = {
    profile_id: value.profileId,
    method: value.method,
    scope: value.scope,
    unlinked_by_uid: value.unlinkedByUid,
    cooldown_ms: value.cooldownMs,
    started_at_ms: value.startedAtMs,
    retry_at_ms: value.retryAtMs,
    updated_at_ms: value.updatedAtMs,
  };
  parseCanonicalCooldownRow({ ...row, revision: 1 });
  return row;
}

export function methodRevocationWriteRow(
  value: CanonicalMethodRevocationValue,
) {
  const { method, ...cooldown } = cooldownWriteRow(value);
  return {
    method,
    normalized_value: value.normalizedValue,
    ...cooldown,
  };
}

export function recoveryWriteRow(
  value: CanonicalAuthRecoveryValue,
): Omit<RecoveryRow, "revision"> {
  const row: Omit<RecoveryRow, "revision"> = {
    profile_id: value.profileId,
    login_uids_json: JSON.stringify(value.loginUids),
    source_profile_ids_json: JSON.stringify(value.sourceProfileIds),
    source_phase: value.sourcePhase,
    prize_cursor: value.prizeCursor,
    phase_started_at_ms: value.phaseStartedAtMs,
    last_enqueued_at_ms: value.lastEnqueuedAtMs,
    created_at_ms: value.createdAtMs,
    updated_at_ms: value.updatedAtMs,
  };
  parseCanonicalAuthRecoveryRow({ ...row, revision: 1 });
  return row;
}
