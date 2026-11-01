// Existing records and error responses retain these exact values.
export const RETIRED_STATE_BACKEND = "rtdb";

export const STATE_FAILURE_MESSAGES = {
  invalidLoginUid: "invalid-firebase-uid",
  invalidRequestId: "requestId must be a safe Firebase key",
} as const;
