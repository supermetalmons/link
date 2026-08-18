export type TelegramTaskKind =
  "desired" | "manual-recovery" | "pending-delete" | "rate-limit-proof";

export type TelegramTaskPayload = {
  messageKey: string;
  revision: string;
  taskKind: TelegramTaskKind;
  retrySequence: number;
  generation: string;
  retryStartedAtMs?: number;
  retryDeadlineAtMs?: number;
  retryAtMs?: number;
  barrierRetryNotBeforeMs?: number;
  safeRejectedAttemptId?: string;
  pendingDeleteId?: string;
  retryProofLeaseOwner?: string;
  proofTaskKind?: "desired" | "pending-delete";
  barrierProofOwner?: string;
  apiGateReclaimOwner?: string;
  apiGateSettleOwner?: string;
};

export function normalizeOptionalTimestamp(value: unknown): number;
export function normalizeTaskPayload(input: unknown): TelegramTaskPayload;
export function buildTelegramDeliveryTaskId(input: TelegramTaskPayload): string;
