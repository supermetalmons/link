import {
  parseAuthOperationReceipt,
  parseStoredAuthErrorCode,
  parseVerifyOperationMetadata,
} from "./contracts.ts";
import {
  CanonicalProfileCorruption,
  type CanonicalLoginOwnerSnapshot,
  type LoginOwnerRow,
  type CanonicalAuthMethodSnapshot,
  type AuthMethodRow,
  type CanonicalAuthOperationSnapshot,
  type CanonicalAuthRecoverySnapshot,
  type RecoveryRow,
  type CanonicalCooldownSnapshot,
} from "./types.ts";
import {
  record,
  nonempty,
  safeInteger,
  authMethod,
  nullableString,
  nullableSafeInteger,
  parseNullableObjectJson,
  parseStringArrayJson,
} from "./validation.ts";

export function parseCanonicalLoginOwnerRow(
  value: unknown,
): CanonicalLoginOwnerSnapshot {
  const row = record(value) as LoginOwnerRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  return {
    loginUid: nonempty(row.login_uid),
    profileId: nonempty(row.profile_id),
    revision: safeInteger(row.revision, 1),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export function parseCanonicalAuthMethodRow(
  value: unknown,
): CanonicalAuthMethodSnapshot {
  const row = record(value) as AuthMethodRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  const method = authMethod(row.method);
  if (
    (method !== "apple" && row.apple_email_masked !== null) ||
    (method !== "x" && row.x_username !== null)
  ) {
    throw new CanonicalProfileCorruption();
  }
  const consentSource = row.consent_source;
  if (
    consentSource !== null &&
    consentSource !== "signin" &&
    consentSource !== "settings"
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    method,
    normalizedValue: nonempty(row.normalized_value),
    profileId: nonempty(row.profile_id),
    rawValue: nonempty(row.raw_value),
    appleEmailMasked: nullableString(row.apple_email_masked),
    xUsername: nullableString(row.x_username),
    linkedAtMs: nullableSafeInteger(row.linked_at_ms),
    consentAtMs: nullableSafeInteger(row.consent_at_ms),
    consentSource,
    revision: safeInteger(row.revision, 1),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export function parseCanonicalAuthOperationRow(
  value: unknown,
): CanonicalAuthOperationSnapshot {
  const row = record(value);
  if (
    !row ||
    row.schema_version !== 1 ||
    (row.kind !== "verify" && row.kind !== "unlink")
  )
    throw new CanonicalProfileCorruption();
  const metaValue = parseNullableObjectJson(row.meta_json);
  if (row.kind === "unlink" && metaValue !== null)
    throw new CanonicalProfileCorruption();
  const context =
    row.kind === "verify"
      ? {
          kind: "verify" as const,
          meta: parseVerifyOperationMetadata(metaValue),
        }
      : { kind: "unlink" as const, meta: null };
  const base = {
    operationId: nonempty(row.operation_id),
    method: authMethod(row.method),
    loginUid: nonempty(row.login_uid),
    startedAtMs: safeInteger(row.started_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    revision: safeInteger(row.revision, 1),
  };
  if (base.updatedAtMs < base.startedAtMs)
    throw new CanonicalProfileCorruption();
  const resultValue = parseNullableObjectJson(row.result_json);
  if (row.status === "cancelled") {
    const cancelledAtMs = safeInteger(row.cancelled_at_ms);
    if (
      resultValue !== null ||
      row.error_code !== "aborted" ||
      row.error_message !== "operation-cancelled" ||
      row.cancellation_reason !== "canonical-data-cutover" ||
      cancelledAtMs < base.startedAtMs ||
      cancelledAtMs > base.updatedAtMs
    )
      throw new CanonicalProfileCorruption();
    return {
      ...base,
      ...context,
      status: "cancelled",
      result: null,
      errorCode: "aborted",
      errorMessage: "operation-cancelled",
      cancelledAtMs,
      cancellationReason: "canonical-data-cutover",
    };
  }
  if (row.cancelled_at_ms !== null || row.cancellation_reason !== null)
    throw new CanonicalProfileCorruption();
  const uncancelled = { cancelledAtMs: null, cancellationReason: null };
  if (row.status === "started") {
    if (
      resultValue !== null ||
      row.error_code !== null ||
      row.error_message !== null
    )
      throw new CanonicalProfileCorruption();
    return {
      ...base,
      ...context,
      ...uncancelled,
      status: "started",
      result: null,
      errorCode: null,
      errorMessage: null,
    };
  }
  if (row.status === "failed") {
    if (resultValue !== null) throw new CanonicalProfileCorruption();
    return {
      ...base,
      ...context,
      ...uncancelled,
      status: "failed",
      result: null,
      errorCode: parseStoredAuthErrorCode(row.error_code),
      errorMessage: nonempty(row.error_message),
    };
  }
  if (
    row.status !== "success" ||
    row.error_code !== null ||
    row.error_message !== null
  )
    throw new CanonicalProfileCorruption();
  const result = parseAuthOperationReceipt(resultValue);
  if (context.kind === "verify") {
    if (
      result.kind !== "verify" ||
      result.uid !== base.loginUid ||
      result.opId !== base.operationId
    )
      throw new CanonicalProfileCorruption();
    return {
      ...base,
      ...context,
      ...uncancelled,
      status: "success",
      result,
      errorCode: null,
      errorMessage: null,
    };
  }
  if (result.kind !== "unlink") throw new CanonicalProfileCorruption();
  return {
    ...base,
    ...context,
    ...uncancelled,
    status: "success",
    result,
    errorCode: null,
    errorMessage: null,
  };
}

export function parseCanonicalAuthRecoveryRow(
  value: unknown,
): CanonicalAuthRecoverySnapshot {
  const row = record(value) as RecoveryRow | null;
  if (!row) throw new CanonicalProfileCorruption();
  if (
    row.source_phase !== "prizes" &&
    row.source_phase !== "games" &&
    row.source_phase !== "finalize"
  ) {
    throw new CanonicalProfileCorruption();
  }
  return {
    profileId: nonempty(row.profile_id),
    loginUids: parseStringArrayJson(row.login_uids_json),
    sourceProfileIds: parseStringArrayJson(row.source_profile_ids_json),
    sourcePhase: row.source_phase,
    prizeCursor: nullableString(row.prize_cursor),
    phaseStartedAtMs: safeInteger(row.phase_started_at_ms),
    lastEnqueuedAtMs: safeInteger(row.last_enqueued_at_ms),
    createdAtMs: safeInteger(row.created_at_ms),
    updatedAtMs: safeInteger(row.updated_at_ms),
    revision: safeInteger(row.revision, 1),
  };
}

export function parseCanonicalCooldownRow(
  value: unknown,
): CanonicalCooldownSnapshot {
  const row = record(value);
  if (!row || (row.scope !== "method" && row.scope !== "profile-method"))
    throw new CanonicalProfileCorruption();
  const base = {
    cooldownMs: safeInteger(row.cooldown_ms, 1),
    method: authMethod(row.method),
    profileId: nonempty(row.profile_id),
    retryAtMs: safeInteger(row.retry_at_ms),
    scope: row.scope,
    startedAtMs: safeInteger(row.started_at_ms),
    unlinkedByUid: nonempty(row.unlinked_by_uid),
    updatedAtMs: safeInteger(row.updated_at_ms),
    revision: safeInteger(row.revision, 1),
  };
  if (base.retryAtMs < base.startedAtMs || base.updatedAtMs < base.startedAtMs)
    throw new CanonicalProfileCorruption();
  return {
    ...base,
    scope: row.scope,
    ...(row.normalized_value === undefined
      ? {}
      : { normalizedValue: nonempty(row.normalized_value) }),
  };
}
