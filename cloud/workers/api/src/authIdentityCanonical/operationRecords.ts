import {
  isAuthProfileResponse,
  isLinkedAuthMethodsResponse,
  type AuthMethodKey,
  type AuthProfileResponse,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import { AuthApiFailure } from "../authErrors.ts";
import type {
  CanonicalAuthOperationSnapshot,
  CanonicalAuthOperationStartWrite,
  CanonicalAuthOperationUpdateWrite,
} from "../profileCanonical/types.ts";
import {
  parseVerifyOperationMetadata,
  type AuthOperationReceipt,
  type VerifyOperationReceipt,
  type UnlinkOperationReceipt,
  type VerifyOperationMetadata,
} from "../profileCanonical/contracts.ts";

export type AuthOperationOutcome =
  | { result: AuthProfileResponse | LinkedAuthMethodsResponse; error?: never }
  | { error: unknown; result?: never };
export type AuthOperationStartInput = {
  operationId: string;
  method: AuthMethodKey;
  loginUid: string;
  timestamp: number;
} & (
  | { kind: "verify"; meta: VerifyOperationMetadata }
  | { kind: "unlink"; meta: null }
);

export function authOperationResult(
  kind: "verify",
  result: AuthProfileResponse | LinkedAuthMethodsResponse,
): VerifyOperationReceipt;
export function authOperationResult(
  kind: "unlink",
  result: AuthProfileResponse | LinkedAuthMethodsResponse,
): UnlinkOperationReceipt;
export function authOperationResult(
  kind: "verify" | "unlink",
  result: AuthProfileResponse | LinkedAuthMethodsResponse,
): AuthOperationReceipt {
  if (kind === "verify" && isAuthProfileResponse(result))
    return {
      schemaVersion: 1,
      kind,
      profileId: result.profileId,
      uid: result.uid,
      opId: result.opId,
    };
  if (kind === "unlink" && isLinkedAuthMethodsResponse(result))
    return { schemaVersion: 1, kind, profileId: result.profileId };
  throw new TypeError("invalid-auth-operation-result");
}

export function startedAuthOperation(
  input: AuthOperationStartInput,
): CanonicalAuthOperationStartWrite {
  const base = {
    operationId: input.operationId,
    method: input.method,
    loginUid: input.loginUid,
    status: "started" as const,
    result: null,
    errorCode: null,
    errorMessage: null,
    startedAtMs: input.timestamp,
    updatedAtMs: input.timestamp,
    cancelledAtMs: null,
    cancellationReason: null,
  };
  return input.kind === "verify"
    ? {
        ...base,
        kind: input.kind,
        meta: parseVerifyOperationMetadata(input.meta),
      }
    : { ...base, kind: input.kind, meta: null };
}

export function finishedAuthOperation(
  operation: CanonicalAuthOperationSnapshot,
  outcome: AuthOperationOutcome,
  timestamp: number,
): CanonicalAuthOperationUpdateWrite {
  if (operation.status === "cancelled")
    throw new TypeError("auth-operation-cancelled");
  if ("result" in outcome && outcome.result !== undefined)
    return successfulAuthOperation(operation, outcome.result, () => timestamp);
  const error = outcome.error;
  const base = {
    operationId: operation.operationId,
    method: operation.method,
    loginUid: operation.loginUid,
    startedAtMs: operation.startedAtMs,
    updatedAtMs: timestamp,
    status: "failed" as const,
    result: null,
    errorCode:
      error instanceof AuthApiFailure ? error.code : ("unavailable" as const),
    errorMessage:
      error instanceof AuthApiFailure
        ? error.message
        : "auth-service-unavailable",
    cancelledAtMs: null,
    cancellationReason: null,
  };
  return operation.kind === "verify"
    ? { ...base, kind: "verify", meta: operation.meta }
    : { ...base, kind: "unlink", meta: null };
}

export function successfulAuthOperation(
  operation: CanonicalAuthOperationSnapshot,
  result: AuthProfileResponse | LinkedAuthMethodsResponse,
  now: () => number,
): CanonicalAuthOperationUpdateWrite {
  if (operation.status === "cancelled")
    throw new TypeError("auth-operation-cancelled");
  const base = {
    operationId: operation.operationId,
    method: operation.method,
    loginUid: operation.loginUid,
    startedAtMs: operation.startedAtMs,
    updatedAtMs: now(),
    status: "success" as const,
    errorCode: null,
    errorMessage: null,
    cancelledAtMs: null,
    cancellationReason: null,
  };
  return operation.kind === "verify"
    ? {
        ...base,
        kind: "verify",
        meta: operation.meta,
        result: authOperationResult("verify", result),
      }
    : {
        ...base,
        kind: "unlink",
        meta: null,
        result: authOperationResult("unlink", result),
      };
}
