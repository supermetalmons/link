import type {
  AuthMethodKey,
  AuthProfileResponse,
  LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import { AuthApiFailure } from "../authErrors.ts";
import type { VerifyOperationMeta } from "../authOperationReplay.ts";
import type {
  CanonicalAuthOperationValue,
  CanonicalAuthOperationSnapshot,
  CanonicalAuthOperationStartWrite,
  CanonicalAuthOperationUpdateWrite,
} from "../profileCanonical/types.ts";
import {
  retainCanonicalAuthMetadata,
  retainCanonicalAuthResult,
  type CanonicalAuthResultDocument,
} from "../profileCanonical/retainedRecords.ts";

export type AuthOperationOutcome =
  | { result: AuthProfileResponse | LinkedAuthMethodsResponse; error?: never }
  | { error: unknown; result?: never };
export type AuthOperationStartInput = {
  operationId: string;
  method: AuthMethodKey;
  loginUid: string;
  timestamp: number;
} & (
  { kind: "verify"; meta: VerifyOperationMeta } | { kind: "unlink"; meta: null }
);

export function authOperationResult(
  result: AuthProfileResponse | LinkedAuthMethodsResponse,
): CanonicalAuthResultDocument {
  return retainCanonicalAuthResult(
    result && typeof result === "object" && !Array.isArray(result)
      ? result
      : {},
  );
}

export function startedAuthOperation(
  input: AuthOperationStartInput,
): CanonicalAuthOperationStartWrite {
  const value: CanonicalAuthOperationValue = {
    operationId: input.operationId,
    kind: input.kind,
    method: input.method,
    loginUid: input.loginUid,
    status: "started" as const,
    meta: input.meta === null ? null : retainCanonicalAuthMetadata(input.meta),
    result: null,
    errorCode: null,
    errorMessage: null,
    startedAtMs: input.timestamp,
    updatedAtMs: input.timestamp,
  };
  return value as CanonicalAuthOperationStartWrite;
}

export function finishedAuthOperation(
  operation: CanonicalAuthOperationSnapshot,
  outcome: AuthOperationOutcome,
  timestamp: number,
): CanonicalAuthOperationUpdateWrite {
  const value: CanonicalAuthOperationValue = {
    ...operation,
    status: "result" in outcome ? "success" : "failed",
    result: "result" in outcome ? authOperationResult(outcome.result!) : null,
    errorCode:
      "error" in outcome && outcome.error instanceof AuthApiFailure
        ? outcome.error.code
        : "error" in outcome
          ? "unavailable"
          : null,
    errorMessage:
      "error" in outcome && outcome.error instanceof AuthApiFailure
        ? outcome.error.message
        : "error" in outcome
          ? "auth-service-unavailable"
          : null,
    updatedAtMs: timestamp,
  };
  return value as CanonicalAuthOperationUpdateWrite;
}

export function successfulAuthOperation(
  operation: CanonicalAuthOperationSnapshot,
  result: AuthProfileResponse | LinkedAuthMethodsResponse,
  now: () => number,
): CanonicalAuthOperationUpdateWrite {
  return {
    ...operation,
    status: "success",
    result: authOperationResult(result),
    errorCode: null,
    errorMessage: null,
    updatedAtMs: now(),
  };
}
