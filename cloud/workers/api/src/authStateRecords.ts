import type { AuthMethodKey, AuthProfileResponse } from "@mons/shared/auth";
import type { XConsentSource } from "@mons/shared/x-redirect";

export class AuthStateFailure extends Error {
  constructor(options?: ErrorOptions) {
    super("auth-state-unavailable", options);
  }
}

export type AuthIntentDocument = {
  consumedAtMs: null;
  createdAtMs: number;
  expiresAtMs: number;
  intentId: string;
  method: AuthMethodKey;
  nonce: string;
  state: string;
  uid: string;
};

type IntentBase = Omit<AuthIntentDocument, "consumedAtMs"> & { dataEpoch: 1 };
export type AuthIntentRecord = IntentBase &
  (
    | {
        status: "created";
        consumedAtMs: null;
        consumedByOpId: null;
        cancelledAtMs: null;
      }
    | {
        status: "consumed";
        consumedAtMs: number;
        consumedByOpId: string | null;
        cancelledAtMs: null;
      }
    | {
        status: "cancelled";
        consumedAtMs: null;
        consumedByOpId: null;
        cancelledAtMs: number;
      }
  );

export type XFlowResult = Pick<AuthProfileResponse, "opId" | "profileId">;
type FlowBase = {
  dataEpoch: 1;
  callbackUri: string;
  codeChallenge: string;
  codeVerifier: string;
  consentSource: XConsentSource;
  createdAtMs: number;
  expiresAtMs: number;
  flowId: string;
  intentId: string;
  method: "x";
  returnUrl: string;
  revision: number;
  uid: string;
  updatedAtMs: number;
};
type UnverifiedFlow = {
  completedAtMs: null;
  errorCode: null;
  result: null;
  xUserId: null;
  xUsername: null;
};
export type XRedirectFlow = FlowBase &
  (
    | (UnverifiedFlow & { status: "created"; processingStartedAtMs: null })
    | (UnverifiedFlow & { status: "processing"; processingStartedAtMs: number })
    | {
        status: "verified";
        completedAtMs: null;
        errorCode: null;
        processingStartedAtMs: null;
        result: null;
        xUserId: string;
        xUsername: string | null;
      }
    | {
        status: "completed";
        completedAtMs: number;
        errorCode: null;
        processingStartedAtMs: null;
        result: XFlowResult;
        xUserId: string;
        xUsername: string | null;
      }
    | {
        status: "failed" | "cancelled";
        completedAtMs: null;
        errorCode: string;
        processingStartedAtMs: null;
        result: null;
        xUserId: string | null;
        xUsername: string | null;
      }
  );

export type XRedirectFlowDocument = Omit<
  Extract<XRedirectFlow, { status: "created" }>,
  | "dataEpoch"
  | "completedAtMs"
  | "processingStartedAtMs"
  | "result"
  | "revision"
>;

export type XFlowUpdate = Partial<
  Pick<
    XRedirectFlow,
    | "result"
    | "status"
    | "updatedAtMs"
    | "completedAtMs"
    | "errorCode"
    | "processingStartedAtMs"
    | "xUserId"
    | "xUsername"
  >
>;

export function authStateText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new AuthStateFailure();
  return value;
}

export function authStateInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new AuthStateFailure();
  return value;
}

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AuthStateFailure();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  )
    throw new AuthStateFailure();
  return row;
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

export function parseAuthIntent(value: unknown): AuthIntentRecord {
  const row = record(value, [
    "dataEpoch",
    "status",
    "consumedAtMs",
    "consumedByOpId",
    "cancelledAtMs",
    "createdAtMs",
    "expiresAtMs",
    "intentId",
    "method",
    "nonce",
    "state",
    "uid",
  ]);
  const createdAtMs = authStateInteger(row.createdAtMs);
  const expiresAtMs = authStateInteger(row.expiresAtMs);
  if (
    row.dataEpoch !== 1 ||
    expiresAtMs < createdAtMs ||
    !["apple", "eth", "sol", "x"].includes(String(row.method))
  )
    throw new AuthStateFailure();
  const base: IntentBase = {
    dataEpoch: 1,
    createdAtMs,
    expiresAtMs,
    intentId: authStateText(row.intentId),
    method: row.method as AuthMethodKey,
    nonce: authStateText(row.nonce),
    state: authStateText(row.state),
    uid: authStateText(row.uid),
  };
  if (row.status === "consumed" && row.cancelledAtMs === null) {
    const consumedAtMs = authStateInteger(row.consumedAtMs);
    if (consumedAtMs < createdAtMs) throw new AuthStateFailure();
    return {
      ...base,
      status: "consumed",
      consumedAtMs,
      consumedByOpId: nullable(row.consumedByOpId, authStateText),
      cancelledAtMs: null,
    };
  }
  if (row.consumedAtMs !== null || row.consumedByOpId !== null)
    throw new AuthStateFailure();
  if (row.status === "created" && row.cancelledAtMs === null)
    return {
      ...base,
      status: "created",
      consumedAtMs: null,
      consumedByOpId: null,
      cancelledAtMs: null,
    };
  if (row.status === "cancelled") {
    const cancelledAtMs = authStateInteger(row.cancelledAtMs);
    if (cancelledAtMs < createdAtMs) throw new AuthStateFailure();
    return {
      ...base,
      status: "cancelled",
      consumedAtMs: null,
      consumedByOpId: null,
      cancelledAtMs,
    };
  }
  throw new AuthStateFailure();
}

export function parseXRedirectFlow(value: unknown): XRedirectFlow {
  const row = record(value, [
    "dataEpoch",
    "callbackUri",
    "codeChallenge",
    "codeVerifier",
    "completedAtMs",
    "consentSource",
    "createdAtMs",
    "errorCode",
    "expiresAtMs",
    "flowId",
    "intentId",
    "method",
    "processingStartedAtMs",
    "result",
    "returnUrl",
    "revision",
    "status",
    "uid",
    "updatedAtMs",
    "xUserId",
    "xUsername",
  ]);
  const createdAtMs = authStateInteger(row.createdAtMs);
  const expiresAtMs = authStateInteger(row.expiresAtMs);
  const updatedAtMs = authStateInteger(row.updatedAtMs);
  if (
    row.dataEpoch !== 1 ||
    row.method !== "x" ||
    expiresAtMs < createdAtMs ||
    updatedAtMs < createdAtMs ||
    (row.consentSource !== "signin" && row.consentSource !== "settings")
  )
    throw new AuthStateFailure();
  const base: FlowBase = {
    dataEpoch: 1,
    callbackUri: authStateText(row.callbackUri),
    codeChallenge: authStateText(row.codeChallenge),
    codeVerifier: authStateText(row.codeVerifier),
    consentSource: row.consentSource,
    createdAtMs,
    expiresAtMs,
    updatedAtMs,
    flowId: authStateText(row.flowId),
    intentId: authStateText(row.intentId),
    method: "x",
    returnUrl: authStateText(row.returnUrl),
    revision: authStateInteger(row.revision),
    uid: authStateText(row.uid),
  };
  const xUserId = nullable(row.xUserId, authStateText);
  const xUsername = nullable(row.xUsername, authStateText);
  if (xUsername !== null && xUserId === null) throw new AuthStateFailure();
  if (row.status === "created" || row.status === "processing") {
    if (
      row.completedAtMs !== null ||
      row.errorCode !== null ||
      row.result !== null ||
      xUserId !== null ||
      xUsername !== null
    )
      throw new AuthStateFailure();
    const unverified = {
      completedAtMs: null,
      errorCode: null,
      result: null,
      xUserId: null,
      xUsername: null,
    };
    if (row.status === "created" && row.processingStartedAtMs === null)
      return {
        ...base,
        ...unverified,
        status: "created",
        processingStartedAtMs: null,
      };
    if (row.status === "processing") {
      const processingStartedAtMs = authStateInteger(row.processingStartedAtMs);
      if (
        processingStartedAtMs < createdAtMs ||
        processingStartedAtMs > updatedAtMs
      )
        throw new AuthStateFailure();
      return {
        ...base,
        ...unverified,
        status: "processing",
        processingStartedAtMs,
      };
    }
    throw new AuthStateFailure();
  }
  if (row.processingStartedAtMs !== null) throw new AuthStateFailure();
  if (row.status === "failed" || row.status === "cancelled") {
    if (
      row.result !== null ||
      row.completedAtMs !== null ||
      (row.status === "cancelled" && row.errorCode !== "application-data-reset")
    )
      throw new AuthStateFailure();
    return {
      ...base,
      status: row.status,
      completedAtMs: null,
      errorCode: authStateText(row.errorCode),
      processingStartedAtMs: null,
      result: null,
      xUserId,
      xUsername,
    };
  }
  if (xUserId === null || row.errorCode !== null) throw new AuthStateFailure();
  if (
    row.status === "verified" &&
    row.completedAtMs === null &&
    row.result === null
  )
    return {
      ...base,
      status: "verified",
      completedAtMs: null,
      errorCode: null,
      processingStartedAtMs: null,
      result: null,
      xUserId,
      xUsername,
    };
  if (row.status === "completed") {
    const completedAtMs = authStateInteger(row.completedAtMs);
    if (completedAtMs < createdAtMs || completedAtMs > updatedAtMs)
      throw new AuthStateFailure();
    const result = record(row.result, ["profileId", "opId"]);
    return {
      ...base,
      status: "completed",
      completedAtMs,
      errorCode: null,
      processingStartedAtMs: null,
      result: {
        profileId: authStateText(result.profileId),
        opId: authStateText(result.opId),
      },
      xUserId,
      xUsername,
    };
  }
  throw new AuthStateFailure();
}

export const AUTH_INTENT_COLUMNS = [
  "data_epoch",
  "cancelled_at_ms",
  "consumed_at_ms",
  "consumed_by_op_id",
  "created_at_ms",
  "expires_at_ms",
  "intent_id",
  "method",
  "nonce",
  "state",
  "uid",
] as const;
export const X_FLOW_COLUMNS = [
  "data_epoch",
  "callback_uri",
  "code_challenge",
  "code_verifier",
  "completed_at_ms",
  "consent_source",
  "created_at_ms",
  "error_code",
  "expires_at_ms",
  "flow_id",
  "intent_id",
  "method",
  "processing_started_at_ms",
  "result_profile_id",
  "result_op_id",
  "return_url",
  "revision",
  "status",
  "uid",
  "updated_at_ms",
  "x_user_id",
  "x_username",
] as const;

export function decodeAuthIntentRow(value: unknown): AuthIntentRecord {
  const row = record(value, AUTH_INTENT_COLUMNS);
  return parseAuthIntent({
    dataEpoch: row.data_epoch,
    status:
      row.cancelled_at_ms !== null
        ? "cancelled"
        : row.consumed_at_ms !== null
          ? "consumed"
          : "created",
    consumedAtMs: row.consumed_at_ms,
    consumedByOpId: row.consumed_by_op_id,
    cancelledAtMs: row.cancelled_at_ms,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    intentId: row.intent_id,
    method: row.method,
    nonce: row.nonce,
    state: row.state,
    uid: row.uid,
  });
}

export function decodeXFlowRow(value: unknown): XRedirectFlow {
  const row = record(value, X_FLOW_COLUMNS);
  return parseXRedirectFlow({
    dataEpoch: row.data_epoch,
    callbackUri: row.callback_uri,
    codeChallenge: row.code_challenge,
    codeVerifier: row.code_verifier,
    completedAtMs: row.completed_at_ms,
    consentSource: row.consent_source,
    createdAtMs: row.created_at_ms,
    errorCode: row.error_code,
    expiresAtMs: row.expires_at_ms,
    flowId: row.flow_id,
    intentId: row.intent_id,
    method: row.method,
    processingStartedAtMs: row.processing_started_at_ms,
    result:
      row.result_profile_id === null && row.result_op_id === null
        ? null
        : { profileId: row.result_profile_id, opId: row.result_op_id },
    returnUrl: row.return_url,
    revision: row.revision,
    status: row.status,
    uid: row.uid,
    updatedAtMs: row.updated_at_ms,
    xUserId: row.x_user_id,
    xUsername: row.x_username,
  });
}
