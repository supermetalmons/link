import { readProperty } from "./values.js";
import * as crypto from "node:crypto";
import { validateTelegramMessageKey } from "./desiredStateCore.js";
import {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_PENDING_DELETE_TASK_KIND,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
  TELEGRAM_TASK_KINDS,
} from "./taskKinds.js";
export type TelegramTaskKind =
  "desired" | "manual-recovery" | "pending-delete" | "rate-limit-proof";
type TelegramTaskFields = {
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
    | { taskKind: Exclude<TelegramTaskKind, "rate-limit-proof"> }
    | {
        taskKind: "rate-limit-proof";
        proofTaskKind: "desired" | "pending-delete";
        barrierProofOwner: string;
        barrierRetryNotBeforeMs: number;
      }
  );

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeTaskKind = (value: unknown): TelegramTaskKind => {
  const taskKind = normalizeString(value) || TELEGRAM_DESIRED_TASK_KIND;
  if (!TELEGRAM_TASK_KINDS.has(taskKind)) {
    throw new TypeError("invalid Telegram task kind");
  }
  return taskKind as TelegramTaskKind;
};

const normalizeRetrySequence = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError("retrySequence must be a non-negative integer");
  }
  return number;
};

const normalizeOptionalTimestamp: (value: unknown) => number = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

const normalizeTaskPayload: (input: unknown) => TelegramTaskPayload = (
  input,
) => {
  const messageKey = validateTelegramMessageKey(
    readProperty(input, "messageKey"),
  );
  const revision = normalizeString(readProperty(input, "revision"));
  const generation = normalizeString(readProperty(input, "generation"));
  if (!revision || !generation) {
    throw new TypeError("revision and generation are required");
  }
  const taskKind = normalizeTaskKind(readProperty(input, "taskKind"));
  const retrySequence = normalizeRetrySequence(
    readProperty(input, "retrySequence") ?? 0,
  );
  const payload: TelegramTaskFields = {
    messageKey,
    revision,
    taskKind,
    retrySequence,
    generation,
  };
  for (const field of [
    "retryStartedAtMs",
    "retryDeadlineAtMs",
    "retryAtMs",
    "barrierRetryNotBeforeMs",
  ] as const) {
    const value = normalizeOptionalTimestamp(readProperty(input, field));
    if (value > 0) {
      payload[field] = value;
    }
  }
  for (const field of [
    "safeRejectedAttemptId",
    "pendingDeleteId",
    "retryProofLeaseOwner",
    "barrierProofOwner",
    "apiGateReclaimOwner",
    "apiGateSettleOwner",
  ] as const) {
    const value = normalizeString(readProperty(input, field));
    if (value) {
      payload[field] = value;
    }
  }
  const proofTaskKind = normalizeString(readProperty(input, "proofTaskKind"));
  if (proofTaskKind) {
    if (
      proofTaskKind !== TELEGRAM_DESIRED_TASK_KIND &&
      proofTaskKind !== TELEGRAM_PENDING_DELETE_TASK_KIND
    ) {
      throw new TypeError("invalid Telegram proof task kind");
    }
    payload.proofTaskKind = proofTaskKind;
  }
  if (
    taskKind === TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND &&
    (!payload.proofTaskKind ||
      !payload.barrierProofOwner ||
      !payload.barrierRetryNotBeforeMs)
  ) {
    throw new TypeError("complete rate-limit proof is required");
  }
  return payload as TelegramTaskPayload;
};

const buildTelegramDeliveryTaskId = (input: TelegramTaskPayload): string => {
  const payload = normalizeTaskPayload(input);
  const cleanupIdentity =
    payload.safeRejectedAttemptId || payload.pendingDeleteId || "none";
  return `tg_${crypto
    .createHash("sha256")
    .update(
      [
        payload.messageKey,
        payload.revision,
        payload.taskKind,
        payload.retrySequence,
        payload.generation,
        cleanupIdentity,
        payload.retryProofLeaseOwner || "none",
        payload.proofTaskKind || "none",
        payload.barrierProofOwner || "none",
        payload.barrierRetryNotBeforeMs || 0,
        payload.apiGateReclaimOwner || "none",
        payload.apiGateSettleOwner || "none",
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 40)}`;
};

export {
  buildTelegramDeliveryTaskId,
  normalizeOptionalTimestamp,
  normalizeTaskPayload,
};
