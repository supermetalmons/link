import { isStartAutomatchResponse } from "@mons/shared/navigation";
import { isSafeRecordKey } from "../recordKeys.ts";
import { STATE_SERVER_TIMESTAMP } from "../stateCompatibility.ts";
import type { GameSessionChange } from "../gameSessionContracts.ts";
import type {
  AutomatchPlan,
  AutomatchReceipt,
  StartAutomatchOperationRequest,
  SuccessfulStartAutomatchResponse,
} from "./types.ts";

const AUTOMATCH_RECEIPT_KIND = "automatch-start";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseAutomatchReceipt(value: unknown): AutomatchReceipt | null {
  const receipt = toRecord(value);
  const response = receipt?.response;
  const profileProjectionRequestId =
    receipt?.profileProjectionRequestId ?? null;
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.kind !== AUTOMATCH_RECEIPT_KIND ||
    typeof receipt.completedAtMs !== "number" ||
    !Number.isFinite(receipt.completedAtMs) ||
    typeof receipt.emojiId !== "number" ||
    !Number.isSafeInteger(receipt.emojiId) ||
    typeof receipt.aura !== "string" ||
    typeof receipt.operationId !== "string" ||
    !isSafeRecordKey(receipt.operationId) ||
    typeof receipt.requesterUid !== "string" ||
    !receipt.requesterUid ||
    typeof receipt.inviteId !== "string" ||
    !isSafeRecordKey(receipt.inviteId) ||
    !(
      profileProjectionRequestId === null ||
      (typeof profileProjectionRequestId === "string" &&
        isSafeRecordKey(profileProjectionRequestId))
    ) ||
    typeof receipt.telegramProjection !== "boolean" ||
    !isStartAutomatchResponse(response) ||
    !response.ok ||
    response.inviteId !== receipt.inviteId
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    aura: receipt.aura,
    completedAtMs: Math.floor(receipt.completedAtMs),
    emojiId: receipt.emojiId,
    inviteId: receipt.inviteId,
    kind: AUTOMATCH_RECEIPT_KIND,
    operationId: receipt.operationId,
    profileProjectionRequestId,
    requesterUid: receipt.requesterUid,
    response,
    telegramProjection: receipt.telegramProjection,
  };
}

export function buildAutomatchReceiptChanges(
  requesterUid: string,
  request: StartAutomatchOperationRequest,
  response: SuccessfulStartAutomatchResponse,
  profileProjectionRequestId: string | null,
  telegramProjection: boolean,
): GameSessionChange[] {
  const completedAtMs = STATE_SERVER_TIMESTAMP;
  return [
    {
      kind: "mutation-receipt",
      operationId: request.operationId,
      value: {
        schemaVersion: 1,
        aura: request.aura,
        completedAtMs,
        emojiId: request.emojiId,
        inviteId: response.inviteId,
        kind: AUTOMATCH_RECEIPT_KIND,
        operationId: request.operationId,
        profileProjectionRequestId,
        requesterUid,
        response,
        telegramProjection,
      },
      expiration: {
        completedAtMs,
      },
    },
  ];
}

export function matchesAutomatchReceiptRequest(
  receipt: AutomatchReceipt,
  requesterUid: string,
  request: StartAutomatchOperationRequest,
): boolean {
  return (
    receipt.operationId === request.operationId &&
    receipt.requesterUid === requesterUid &&
    receipt.emojiId === request.emojiId &&
    receipt.aura === request.aura
  );
}

export function buildAutomatchReplayTasks(
  receipt: AutomatchReceipt,
): Pick<AutomatchPlan, "profileGameProjectionTask" | "projectionTask"> | null {
  if (!receipt.profileProjectionRequestId) return null;
  return {
    projectionTask: receipt.telegramProjection
      ? {
          kind: "automatch-telegram-projection",
          inviteId: receipt.inviteId,
          requestId: receipt.profileProjectionRequestId,
        }
      : null,
    profileGameProjectionTask: {
      kind: "automatch-profile-game-projection",
      inviteId: receipt.inviteId,
      requestId: receipt.profileProjectionRequestId,
    },
  };
}
