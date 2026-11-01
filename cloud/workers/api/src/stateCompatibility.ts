// Existing records, replay digests, and error responses retain these exact values.
export const STATE_EFFECTS_FIELD = "rtdbEffects";
export const RETIRED_STATE_BACKEND = "rtdb";

export const STATE_FAILURE_MESSAGES = {
  unavailable: "firebase-rtdb-unavailable",
  permissionDenied: "firebase-rtdb-permission-denied",
  invalidLoginUid: "invalid-firebase-uid",
  invalidEventId: "eventId must be a safe Firebase key",
  invalidRequestId: "requestId must be a safe Firebase key",
} as const;

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
