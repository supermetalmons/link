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

export function stateIncrement(delta: number): Record<string, unknown> {
  if (!Number.isFinite(delta)) {
    throw new TypeError("State increment must be finite");
  }
  return { [STATE_VALUE_FIELD]: { increment: delta } };
}
