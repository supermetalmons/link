// Generated from src/telegram/taskIdentity.ts. Run npm run generate:runtime.
export type TelegramTaskKind =
  "desired" | "manual-recovery" | "pending-delete" | "rate-limit-proof";
export type TelegramTaskFields = {
  schemaVersion: 1;
  dataEpoch: 1;
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
export type TelegramTaskPayload = TelegramTaskFields &
  (
    | {
        taskKind: Exclude<TelegramTaskKind, "rate-limit-proof">;
      }
    | {
        taskKind: "rate-limit-proof";
        proofTaskKind: "desired" | "pending-delete";
        barrierProofOwner: string;
        barrierRetryNotBeforeMs: number;
      }
  );
declare const normalizeOptionalTimestamp: (value: unknown) => number;
declare const normalizeTaskPayload: (input: unknown) => TelegramTaskPayload;
declare const buildTelegramDeliveryTaskId: (
  input: TelegramTaskPayload,
) => string;
export {
  buildTelegramDeliveryTaskId,
  normalizeOptionalTimestamp,
  normalizeTaskPayload,
};
export declare function parseTelegramTaskPayload(
  value: unknown,
): TelegramTaskPayload | null;
