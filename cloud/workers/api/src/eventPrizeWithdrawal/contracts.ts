import {
  isEventPrizeWithdrawalCompletedResponse,
  isEventPrizeWithdrawalRequest,
  type EventPrizeEventId,
  type EventPrizeId,
  type EventPrizeWithdrawalCompletedResponse,
} from "@mons/shared/event-prizes";
import { EVENT_PRIZE_ADMIN_WALLET } from "../../../../runtime/eventPrizeWithdrawalState.js";
import { EventPrizeWithdrawalError } from "../../../../runtime/eventPrizes/errors.js";
import { AuthApiFailure, type AuthErrorCode } from "../authErrors.ts";

export type EventPrizeWithdrawalWorkflowParams = {
  schemaVersion: 1;
  kind: "withdrawal";
  eventId: EventPrizeEventId;
  operationId: string;
  prizeId: EventPrizeId;
  profileId: string;
  recipientAddress: string;
  requesterUid: string;
};

export type EventPrizeWithdrawalPreflightParams = {
  schemaVersion: 1;
  kind: "preflight";
};

export type EventPrizeWithdrawalWorkflowInput =
  EventPrizeWithdrawalWorkflowParams | EventPrizeWithdrawalPreflightParams;

export type EventPrizeWithdrawalWorkflowFailure = {
  ok: false;
  status: "failed";
  error:
    | "failed-precondition"
    | "invalid-argument"
    | "not-found"
    | "permission-denied";
  message: string;
};

export type EventPrizeWithdrawalWorkflowOutput =
  | EventPrizeWithdrawalCompletedResponse
  | EventPrizeWithdrawalWorkflowFailure
  | { ok: true; status: "ready" };

export function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorStatus(code: string): number {
  if (code === "invalid-argument") return 400;
  if (code === "unauthenticated") return 401;
  if (code === "permission-denied") return 403;
  if (code === "not-found") return 404;
  if (code === "aborted") return 409;
  if (code === "failed-precondition") return 412;
  if (code === "resource-exhausted") return 429;
  return 503;
}

function isMappedErrorCode(code: string): code is AuthErrorCode {
  return (
    code === "aborted" ||
    code === "failed-precondition" ||
    code === "invalid-argument" ||
    code === "not-found" ||
    code === "permission-denied" ||
    code === "resource-exhausted" ||
    code === "unauthenticated"
  );
}

export function toEventPrizeApiFailure(error: unknown): AuthApiFailure {
  if (error instanceof AuthApiFailure) return error;
  const record = toRecord(error);
  const code = cleanString(record?.code || record?.error);
  const message = cleanString(record?.message);
  if (isMappedErrorCode(code)) {
    return new AuthApiFailure(
      errorStatus(code),
      code,
      message || "Prize withdrawal is unavailable.",
    );
  }
  return new AuthApiFailure(
    503,
    "unavailable",
    "Prize withdrawal service is unavailable.",
  );
}

export function buildCompletedResponse(
  operationId: string,
  withdrawal: Record<string, unknown>,
): EventPrizeWithdrawalCompletedResponse {
  const response = {
    ok: true,
    status: "completed" as const,
    operationId,
    eventId: cleanString(withdrawal.eventId),
    prizeId: cleanString(withdrawal.prizeId),
    assetAddress: cleanString(withdrawal.assetAddress),
    recipientAddress: cleanString(withdrawal.recipientAddress),
    transactionSignature: cleanString(withdrawal.transactionSignature),
  };
  if (!isEventPrizeWithdrawalCompletedResponse(response)) {
    throw new EventPrizeWithdrawalError(
      "internal",
      "Prize withdrawal result is unavailable.",
    );
  }
  if (response.recipientAddress === EVENT_PRIZE_ADMIN_WALLET) {
    throw new EventPrizeWithdrawalError(
      "permission-denied",
      "Prize withdrawal is unavailable.",
    );
  }
  return response;
}

export function terminalWorkflowFailure(): AuthApiFailure {
  return new AuthApiFailure(
    503,
    "unavailable",
    "Prize withdrawal service is unavailable.",
    { terminal: true },
  );
}

export async function buildEventPrizeWithdrawalOperationId(
  eventId: string,
  prizeId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${eventId}\n${prizeId}`),
  );
  return `epw_${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export async function parseEventPrizeWithdrawalWorkflowParams(
  value: unknown,
  instanceId: string,
): Promise<EventPrizeWithdrawalWorkflowParams | null> {
  const record = toRecord(value);
  const request = {
    eventId: record?.eventId,
    prizeId: record?.prizeId,
    solanaAddress: record?.recipientAddress,
  };
  if (
    !record ||
    Object.keys(record).length !== 8 ||
    record.schemaVersion !== 1 ||
    record.kind !== "withdrawal" ||
    !isEventPrizeWithdrawalRequest(request) ||
    cleanString(record.operationId) !== instanceId ||
    !cleanString(record.profileId) ||
    !cleanString(record.requesterUid)
  ) {
    return null;
  }
  const operationId = await buildEventPrizeWithdrawalOperationId(
    String(record.eventId),
    String(record.prizeId),
  );
  if (operationId !== instanceId) return null;
  return {
    schemaVersion: 1,
    kind: "withdrawal",
    eventId: request.eventId,
    operationId,
    prizeId: request.prizeId,
    profileId: cleanString(record.profileId),
    recipientAddress: request.solanaAddress,
    requesterUid: cleanString(record.requesterUid),
  };
}
