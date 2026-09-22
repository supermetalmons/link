// Existing records, replay digests, and error responses retain these exact values.
export const STATE_VALUE_FIELD = ".sv";
export const STATE_EFFECTS_FIELD = "rtdbEffects";
export const RETIRED_STATE_BACKEND = "rtdb";

export const STATE_FAILURE_MESSAGES = {
  unavailable: "firebase-rtdb-unavailable",
  permissionDenied: "firebase-rtdb-permission-denied",
  invalidLoginUid: "invalid-firebase-uid",
  invalidEventId: "eventId must be a safe Firebase key",
  invalidRequestId: "requestId must be a safe Firebase key",
} as const;

export const STATE_SERVER_TIMESTAMP = Object.freeze({
  [STATE_VALUE_FIELD]: "timestamp",
});

export type StateValueResult =
  | { ok: true; value: number }
  | { ok: false; reason: "invalid-marker" | "increment-overflow" };

export function evaluateStateValueMarker(
  marker: unknown,
  current: unknown,
  nowMs: number,
): StateValueResult {
  if (marker === "timestamp") return { ok: true, value: nowMs };
  const operation = marker as Record<string, unknown>;
  if (
    marker !== null &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    Object.keys(marker).length === 1 &&
    typeof operation.increment === "number" &&
    Number.isFinite(operation.increment)
  ) {
    const value =
      (typeof current === "number" && Number.isFinite(current) ? current : 0) +
      operation.increment;
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, reason: "increment-overflow" };
  }
  return { ok: false, reason: "invalid-marker" };
}

export function stateIncrement(delta: number): {
  [STATE_VALUE_FIELD]: { increment: number };
} {
  if (!Number.isFinite(delta)) {
    throw new TypeError("State increment must be finite");
  }
  return { [STATE_VALUE_FIELD]: { increment: delta } };
}

export class StateRepositoryFailure extends Error {
  constructor() {
    super(STATE_FAILURE_MESSAGES.unavailable);
  }
}

export class StateRepositoryPermissionDenied extends StateRepositoryFailure {
  constructor() {
    super();
    this.message = STATE_FAILURE_MESSAGES.permissionDenied;
  }
}
