import { SESSION_TIMESTAMP } from "../sessionValueOperations.ts";
import type { GameSessionChange } from "../gameSessionContracts.ts";
import type {
  AutomatchPlan,
  AutomatchReceipt,
  StartAutomatchOperationRequest,
  SuccessfulStartAutomatchResponse,
} from "./types.ts";

export { parseAutomatchReceipt } from "../gameSessionReceiptRecords.ts";

const AUTOMATCH_RECEIPT_KIND = "automatch-start";

export function buildAutomatchReceiptChanges(
  requesterUid: string,
  request: StartAutomatchOperationRequest,
  response: SuccessfulStartAutomatchResponse,
  profileProjectionRequestId: string | null,
  telegramProjection: boolean,
): GameSessionChange[] {
  const completedAtMs = SESSION_TIMESTAMP;
  return [
    {
      kind: "mutation-receipt",
      operationId: request.operationId,
      value: {
        schemaVersion: 2,
        effects: { state: "enabled" },
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
        schemaVersion: 1,
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
  if (
    !receipt.profileProjectionRequestId ||
    receipt.effects.state === "retired"
  )
    return null;
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
