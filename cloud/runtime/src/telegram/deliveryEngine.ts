import { readProperty } from "./values.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";
import type { TelegramDesired } from "./desiredStateCore.js";
import type {
  TelegramRetryFailure,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import type { TelegramClient } from "./client.js";
import type {
  TelegramBarrierProof,
  TelegramBarrierProofResult,
  TelegramLocalRetryBarrier,
} from "./deliveryRetryTypes.js";
import type { TelegramTaskKind } from "./taskIdentity.js";
import * as crypto from "node:crypto";
import {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  resolveTelegramDestination,
  validateTelegramMessageKey,
} from "./desiredStateCore.js";
import {
  TELEGRAM_SAFE_RETRY_MAX_DELAY_MS,
  TELEGRAM_SAFE_RETRY_WINDOW_MS,
  buildErrorState,
  createTelegramLocalRetryBarrier,
  normalizeAttempts,
  normalizeRetrySequence,
  normalizeTimestamp,
  omitRetryState,
  resolveRetryDeadlineAtMs,
} from "./deliveryPolicy.js";
import {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_PENDING_DELETE_TASK_KIND,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
} from "./taskKinds.js";

import { createTelegramRetryCoordinator } from "./deliveryRetryCoordinator.js";
export type TelegramApiGateResult = {
  acquired: boolean;
  reason: string;
  retryNotBeforeMs: number;
  gate: Record<string, unknown>;
};
export type TelegramRetrySchedule = {
  messageKey: string;
  revision: string;
  taskKind: string;
  retrySequence: number;
  generation: string;
  retryStartedAtMs?: number;
  retryDeadlineAtMs?: number;
  retryAtMs?: number;
  scheduleTimeMs?: number;
  safeRejectedAttemptId?: unknown;
  pendingDeleteId?: unknown;
  retryProofLeaseOwner?: unknown;
  proofTaskKind?: unknown;
  barrierProofOwner?: unknown;
  barrierRetryNotBeforeMs?: unknown;
  apiGateReclaimOwner?: unknown;
  apiGateSettleOwner?: unknown;
};
export type TelegramReconcileInput = {
  messageKey: string;
  requestedRevision?: string;
  requestedGeneration?: string;
  taskKind?: TelegramTaskKind;
  retrySequence?: number;
  retryStartedAtMs?: number;
  retryDeadlineAtMs?: number;
  retryAtMs?: number;
  safeRejectedAttemptId?: string;
  pendingDeleteId?: string;
  retryProofLeaseOwner?: string;
  proofTaskKind?: string;
  barrierProofOwner?: string;
  barrierRetryNotBeforeMs?: number;
  apiGateReclaimOwner?: string;
  apiGateSettleOwner?: string;
};
export type TelegramEngineOptions = {
  repository: TelegramRepository;
  client: TelegramClient;
  resolveDestination?: (destination: string) => string;
  now?: () => number;
  createOwnerToken?: () => string;
  createAttemptId?: () => string;
  scheduleRetry?: TelegramRetryScheduler;
  logger?: Pick<Console, "error" | "info">;
  leaseTtlMs?: number;
  localRetryBarrier?: TelegramLocalRetryBarrier;
};
type RawRecord = Record<string, unknown>;
type MessageMutation = (record: RawRecord) => TransactionDecision<RawRecord>;
type OwnedMutation = (record: RawRecord, delivery: RawRecord) => RawRecord;
type DesiredContext = {
  messageKey: string;
  ownerToken: string;
  desired: TelegramDesired;
};
type FinishStatusInput = DesiredContext & {
  status: string;
  nowMs: number;
  result?: TelegramRetryFailure;
  applied?: RawRecord;
  clearApplied?: boolean;
  clearAppliedStateUnknown?: boolean;
  preserveSendInFlight?: boolean;
  apiGateSettleOwner?: unknown;
};
type ProofInput = Partial<
  Record<keyof TelegramReconcileInput | "requestedPendingDeleteId", unknown>
>;
type ExactRetryInput = {
  messageKey: string;
  revision: string;
  taskKind: TelegramTaskKind;
  retryState: Partial<Record<keyof TelegramRetryState, unknown>>;
  safeRejectedAttemptId?: unknown;
  pendingDeleteId?: unknown;
  retryProofLeaseOwner?: unknown;
  sourceGeneration?: unknown;
  proofTaskKind?: unknown;
  barrierProofOwner?: unknown;
  barrierRetryNotBeforeMs?: unknown;
  scheduleTimeMs?: unknown;
  apiGateReclaimOwner?: unknown;
  apiGateSettleOwner?: unknown;
};
export type TelegramRepository = {
  getMessage(messageKey: string): Promise<unknown>;
  transactMessage(
    messageKey: string,
    updater: (
      current: Record<string, unknown> | null,
    ) => TransactionDecision<Record<string, unknown>>,
  ): Promise<TransactionResult<Record<string, unknown>>>;
  getRetryNotBeforeMs(): Promise<number>;
  extendRetryNotBeforeMs(candidateMs: number): Promise<number>;
  acquireApiGate(
    input: Record<string, unknown>,
  ): Promise<TelegramApiGateResult>;
  releaseApiGate(owner: string): Promise<boolean>;
  extendRetryBarrierAndReleaseApiGate(
    input: TelegramBarrierProof,
  ): Promise<TelegramBarrierProofResult>;
};
export type TelegramRetryScheduler = (
  input: TelegramRetrySchedule,
) => Promise<Record<string, unknown>>;
export type TelegramEngineResult = {
  status: string;
  reason?: string;
  retryAtMs?: number | null;
  scheduled?: boolean;
  cleanup?: unknown;
  cleanupScheduled?: boolean;
};

const TELEGRAM_LEASE_TTL_MS = 60_000;

const moduleRetryBarrier = createTelegramLocalRetryBarrier();

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const hashValue = (value: unknown): string =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const omitKeys = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  const output = { ...asObject(value) };
  for (const key of keys) {
    delete output[key];
  }
  return output;
};

const buildPendingDeleteId = ({
  chatId,
  messageId,
}: {
  chatId: unknown;
  messageId: unknown;
}) => hashValue(`${normalizeString(chatId)}:${Number(messageId)}`).slice(0, 32);

const buildApiGateOwner = (...parts: unknown[]) =>
  `api_${hashValue(parts.map((part) => String(part ?? "")).join(":"))}`;

const resolvePendingDeleteId = (pendingDelete: unknown): string => {
  const value = asObject(pendingDelete);
  return (
    normalizeString(value.pendingDeleteId) ||
    hashValue(
      JSON.stringify({
        chatId: normalizeString(value.chatId),
        messageId: value.messageId ?? null,
        instanceKey: normalizeString(value.instanceKey),
      }),
    ).slice(0, 32)
  );
};

const promotePendingDeleteQueue = (delivery: unknown): RawRecord => {
  const value = omitKeys(delivery, ["pendingDelete"]);
  const queue = asObject(value.pendingDeleteQueue);
  const [nextPendingDeleteId] = Object.keys(queue).sort();
  if (!nextPendingDeleteId) {
    return omitKeys(value, ["pendingDeleteQueue"]);
  }
  const nextQueue = omitKeys(queue, [nextPendingDeleteId]);
  return {
    ...omitKeys(value, ["pendingDeleteQueue"]),
    pendingDelete: queue[nextPendingDeleteId],
    ...(Object.keys(nextQueue).length > 0
      ? { pendingDeleteQueue: nextQueue }
      : {}),
  };
};

const appendPendingDelete = (
  delivery: unknown,
  pendingDelete: unknown,
): RawRecord => {
  const value = asObject(delivery);
  const currentPendingDelete = asObject(value.pendingDelete);
  if (Object.keys(currentPendingDelete).length === 0) {
    return { ...value, pendingDelete };
  }
  const pendingDeleteId = resolvePendingDeleteId(pendingDelete);
  if (resolvePendingDeleteId(currentPendingDelete) === pendingDeleteId) {
    return value;
  }
  return {
    ...value,
    pendingDeleteQueue: {
      ...asObject(value.pendingDeleteQueue),
      [pendingDeleteId]: pendingDelete,
    },
  };
};

const ensureCommitted = <T extends { committed: boolean }>(
  result: T,
  code: string,
): T => {
  if (result?.committed) {
    return result;
  }
  const error = Object.assign(new Error(code), { code, retryable: true });
  throw error;
};

const validateDesiredForDelivery = (
  desired: unknown,
): desired is TelegramDesired => {
  const value = asObject(desired);
  if (
    value.schemaVersion !== TELEGRAM_SCHEMA_VERSION ||
    !normalizeString(value.revision) ||
    !normalizeString(value.sourceRevision) ||
    !Object.hasOwn(TELEGRAM_DESTINATIONS, value.destination as PropertyKey) ||
    !["send", "edit", "delete"].includes(value.operation as string)
  ) {
    return false;
  }
  if (value.operation === "delete") {
    return true;
  }
  return (
    normalizeString(value.instanceKey) !== "" &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    (value.parseMode === undefined || value.parseMode === "HTML") &&
    (value.operation !== "edit" ||
      value.ifMissing === "send" ||
      value.ifMissing === "skip")
  );
};

const createTelegramDeliveryEngine: (input: TelegramEngineOptions) => {
  reconcile(input: TelegramReconcileInput): Promise<TelegramEngineResult>;
} = ({
  repository,
  client,
  resolveDestination = resolveTelegramDestination,
  now = Date.now,
  createOwnerToken = () => crypto.randomUUID(),
  createAttemptId = () => crypto.randomUUID(),
  scheduleRetry = async () => ({ scheduled: true }),
  logger = console,
  leaseTtlMs = TELEGRAM_LEASE_TTL_MS,
  localRetryBarrier = moduleRetryBarrier,
}: Partial<TelegramEngineOptions> = {}): {
  reconcile(input: TelegramReconcileInput): Promise<TelegramEngineResult>;
} => {
  if (!repository || typeof repository.transactMessage !== "function") {
    throw new TypeError("repository.transactMessage is required");
  }
  if (
    !client ||
    typeof client.sendTelegramMessage !== "function" ||
    typeof client.editTelegramMessage !== "function" ||
    typeof client.deleteTelegramMessage !== "function"
  ) {
    throw new TypeError("complete Telegram client is required");
  }
  if (
    typeof repository.getRetryNotBeforeMs !== "function" ||
    typeof repository.extendRetryNotBeforeMs !== "function" ||
    typeof repository.acquireApiGate !== "function" ||
    typeof repository.releaseApiGate !== "function" ||
    typeof repository.extendRetryBarrierAndReleaseApiGate !== "function"
  ) {
    throw new TypeError("repository delivery control methods are required");
  }
  if (
    !localRetryBarrier ||
    typeof localRetryBarrier.getRetryNotBeforeMs !== "function" ||
    typeof localRetryBarrier.extendRetryNotBeforeMs !== "function"
  ) {
    throw new TypeError("local retry barrier methods are required");
  }
  if (typeof scheduleRetry !== "function") {
    throw new TypeError("scheduleRetry is required");
  }

  const logFailure = (
    messageKey: string,
    status: string,
    error: TelegramRetryFailure,
  ) => {
    if (typeof logger?.error === "function") {
      logger.error("telegram:delivery:failed", {
        messageKey,
        status,
        code: error?.code || "telegram-error",
        httpStatus: error?.httpStatus || null,
      });
    }
  };

  const transact = (messageKey: string, updater: MessageMutation) =>
    repository.transactMessage(messageKey, (current) => {
      const record = asObject(current);
      return updater(record);
    });

  const scheduleExactRetry = async ({
    messageKey,
    revision,
    taskKind,
    retryState,
    safeRejectedAttemptId = "",
    pendingDeleteId = "",
    retryProofLeaseOwner = "",
    sourceGeneration = "",
    proofTaskKind = "",
    barrierProofOwner = "",
    barrierRetryNotBeforeMs = 0,
    scheduleTimeMs = 0,
    apiGateReclaimOwner = "",
    apiGateSettleOwner = "",
  }: ExactRetryInput) => {
    const normalizedTaskKind =
      normalizeString(taskKind) || TELEGRAM_DESIRED_TASK_KIND;
    const retrySequence = normalizeRetrySequence(retryState.retrySequence);
    const generation = [
      normalizedTaskKind,
      retrySequence,
      normalizeTimestamp(retryState.retryAtMs),
      safeRejectedAttemptId || pendingDeleteId || revision,
      normalizeString(retryProofLeaseOwner),
      normalizeString(sourceGeneration),
      normalizeString(proofTaskKind),
      normalizeString(barrierProofOwner),
      normalizeTimestamp(barrierRetryNotBeforeMs),
      normalizeString(apiGateReclaimOwner),
      normalizeString(apiGateSettleOwner),
    ].join(":");
    return scheduleRetry({
      messageKey,
      revision,
      taskKind: normalizedTaskKind,
      retrySequence,
      generation,
      retryStartedAtMs: normalizeTimestamp(retryState.retryStartedAtMs),
      retryDeadlineAtMs: normalizeTimestamp(retryState.retryDeadlineAtMs),
      retryAtMs: normalizeTimestamp(retryState.retryAtMs),
      scheduleTimeMs:
        normalizeTimestamp(scheduleTimeMs) ||
        normalizeTimestamp(retryState.retryAtMs),
      ...(safeRejectedAttemptId ? { safeRejectedAttemptId } : {}),
      ...(pendingDeleteId ? { pendingDeleteId } : {}),
      ...(retryProofLeaseOwner ? { retryProofLeaseOwner } : {}),
      ...(proofTaskKind ? { proofTaskKind } : {}),
      ...(barrierProofOwner ? { barrierProofOwner } : {}),
      ...(barrierRetryNotBeforeMs ? { barrierRetryNotBeforeMs } : {}),
      ...(apiGateReclaimOwner ? { apiGateReclaimOwner } : {}),
      ...(apiGateSettleOwner ? { apiGateSettleOwner } : {}),
    });
  };

  const retryCoordinator = createTelegramRetryCoordinator({
    now,
    scheduleExactRetry,
    releaseApiGate: (owner) => repository.releaseApiGate(owner),
    extendRetryBarrierAndReleaseApiGate: (proof) =>
      repository.extendRetryBarrierAndReleaseApiGate(proof),
    localRetryBarrier,
  });

  const applyRateLimitBarrierProof = async ({
    barrierProofOwner,
    barrierRetryNotBeforeMs,
  }: {
    barrierProofOwner?: unknown;
    barrierRetryNotBeforeMs?: unknown;
  }): Promise<Partial<TelegramBarrierProofResult> & { applied: boolean }> => {
    const owner = normalizeString(barrierProofOwner);
    const retryNotBeforeMs = normalizeTimestamp(barrierRetryNotBeforeMs);
    if (!owner || !retryNotBeforeMs) {
      return { applied: false };
    }
    const result = await repository.extendRetryBarrierAndReleaseApiGate({
      owner,
      retryNotBeforeMs,
    });
    if (result.applied) {
      localRetryBarrier.extendRetryNotBeforeMs(result.retryNotBeforeMs);
    }
    return result;
  };

  const clearAppliedRateLimitProofMarker = async (
    messageKey: string,
    ownerInput: unknown,
  ) => {
    const owner = normalizeString(ownerInput);
    if (!owner) {
      return;
    }
    await transact(messageKey, (record) => {
      const delivery = asObject(record.delivery);
      const pendingDelete = asObject(delivery.pendingDelete);
      const clearsDesired =
        normalizeString(
          readProperty(delivery.apiGateProofRequired, "owner"),
        ) === owner;
      const clearsPending =
        normalizeString(
          readProperty(pendingDelete.apiGateProofRequired, "owner"),
        ) === owner;
      if (!clearsDesired && !clearsPending) {
        return { commit: false, decision: "rate-limit-proof-marker-stale" };
      }
      return {
        value: {
          ...record,
          delivery: {
            ...(clearsDesired
              ? omitKeys(delivery, ["apiGateProofRequired"])
              : delivery),
            ...(clearsPending
              ? {
                  pendingDelete: omitKeys(pendingDelete, [
                    "apiGateProofRequired",
                  ]),
                }
              : {}),
          },
        },
        decision: "rate-limit-proof-marker-cleared",
      };
    });
  };

  const acquireApiGate = ({
    messageKey,
    revision,
    operation,
    owner,
    attemptId = "",
    pendingDeleteId = "",
    reclaimOwner = "",
    taskGeneration = "",
  }: {
    messageKey: string;
    revision: string;
    operation: string;
    owner: string;
    attemptId?: string;
    pendingDeleteId?: string;
    reclaimOwner?: string;
    taskGeneration?: string;
  }) =>
    repository.acquireApiGate({
      messageKey,
      revision,
      operation,
      owner,
      acquiredAtMs: now(),
      ...(attemptId ? { attemptId } : {}),
      ...(pendingDeleteId ? { pendingDeleteId } : {}),
      ...(reclaimOwner ? { reclaimOwner } : {}),
      ...(taskGeneration ? { taskGeneration } : {}),
    });

  const buildGateBlockedFailure = (
    gateResult: TelegramApiGateResult,
    checkedAtMs: number,
  ): TelegramRetryFailure => ({
    code:
      gateResult.reason === "retry-after"
        ? "global-retry-after"
        : "global-api-gate-held",
    retryAfterSeconds:
      gateResult.retryNotBeforeMs > checkedAtMs
        ? (gateResult.retryNotBeforeMs - checkedAtMs) / 1000
        : null,
  });

  const applySafeRetryProof = async (
    messageKey: string,
    {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
    }: ProofInput,
  ) => {
    const normalizedAttemptId = normalizeString(safeRejectedAttemptId);
    const normalizedRevision = normalizeString(requestedRevision);
    if (!normalizedAttemptId || !normalizedRevision) {
      return { applied: false };
    }
    let applied = false;
    const result = await transact(messageKey, (record) => {
      const delivery = asObject(record.delivery);
      const marker = asObject(delivery.sendInFlight);
      if (
        normalizeString(marker.attemptId) !== normalizedAttemptId ||
        normalizeString(marker.revision) !== normalizedRevision
      ) {
        return { commit: false, decision: "stale-safe-retry-proof" };
      }
      const latestRevision = normalizeString(
        readProperty(record.desired, "revision"),
      );
      const proofRetryState = {
        retryStartedAtMs: normalizeTimestamp(retryStartedAtMs),
        retryDeadlineAtMs: normalizeTimestamp(retryDeadlineAtMs),
        retryAtMs: normalizeTimestamp(retryAtMs),
        retrySequence: normalizeRetrySequence(retrySequence),
      };
      const proofIsComplete =
        proofRetryState.retryStartedAtMs > 0 &&
        proofRetryState.retryDeadlineAtMs > 0 &&
        proofRetryState.retryAtMs > 0;
      applied = true;
      return {
        value: {
          ...record,
          delivery: {
            ...omitKeys(delivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "sendInFlight",
              "lastError",
              "apiGateProofRequired",
            ]),
            status:
              latestRevision === normalizedRevision && proofIsComplete
                ? "retryable"
                : "pending",
            revision: latestRevision || normalizedRevision,
            attempts:
              latestRevision === normalizedRevision
                ? normalizeAttempts(delivery.attempts)
                : 0,
            ...(latestRevision === normalizedRevision && proofIsComplete
              ? proofRetryState
              : {}),
            safeRejectionRecoveredAtMs: now(),
          },
        },
        decision: "safe-retry-proof-applied",
      };
    });
    return { applied: applied && result.committed };
  };

  const applyDesiredRetryWindowProof = async (
    messageKey: string,
    {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    }: ProofInput,
  ) => {
    if (normalizeString(safeRejectedAttemptId)) {
      return { applied: false };
    }
    const normalizedRevision = normalizeString(requestedRevision);
    const proofRetryState = {
      retryStartedAtMs: normalizeTimestamp(retryStartedAtMs),
      retryDeadlineAtMs: normalizeTimestamp(retryDeadlineAtMs),
      retryAtMs: normalizeTimestamp(retryAtMs),
      retrySequence: normalizeRetrySequence(retrySequence),
    };
    if (
      !normalizedRevision ||
      !proofRetryState.retryStartedAtMs ||
      !proofRetryState.retryDeadlineAtMs ||
      !proofRetryState.retryAtMs
    ) {
      return { applied: false };
    }
    let applied = false;
    const result = await transact(messageKey, (record) => {
      const delivery = asObject(record.delivery);
      if (
        normalizeString(readProperty(record.desired, "revision")) !==
          normalizedRevision ||
        normalizeString(delivery.revision) !== normalizedRevision ||
        delivery.status !== "processing" ||
        delivery.sendInFlight ||
        !normalizeString(retryProofLeaseOwner) ||
        normalizeString(delivery.leaseOwner) !==
          normalizeString(retryProofLeaseOwner) ||
        proofRetryState.retrySequence <=
          normalizeRetrySequence(delivery.retrySequence)
      ) {
        return { commit: false, decision: "stale-retry-window-proof" };
      }
      applied = true;
      const preservesApiGate =
        normalizeString(apiGateReclaimOwner) !== "" &&
        normalizeString(delivery.apiGateOwner) ===
          normalizeString(apiGateReclaimOwner);
      return {
        value: {
          ...record,
          delivery: {
            ...omitKeys(delivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "lastError",
              ...(preservesApiGate
                ? []
                : [
                    "apiGateOwner",
                    "apiGateGeneration",
                    "apiGateStartedAtMs",
                    "apiGateProofRequired",
                  ]),
            ]),
            status: "retryable",
            ...proofRetryState,
            retryWindowRecoveredAtMs: now(),
          },
        },
        decision: "retry-window-proof-applied",
      };
    });
    return { applied: applied && result.committed };
  };

  const applyManualRecovery = async (messageKey: string) => {
    const processedAtMs = now();
    const result = await transact(messageKey, (record) => {
      const request = asObject(record.manualRecovery);
      const requestId = normalizeString(request.requestId);
      const delivery = asObject(record.delivery);
      if (
        !requestId ||
        normalizeString(delivery.lastRecoveryRequestId) === requestId
      ) {
        return { commit: false, decision: "no-manual-recovery" };
      }
      const action = normalizeString(request.action);
      const marker = asObject(delivery.sendInFlight);
      const markerAttemptId = normalizeString(marker.attemptId);
      const markerApiGateOwner = normalizeString(marker.apiGateOwner);
      const recoverable =
        delivery.status === "uncertain" && markerAttemptId !== "";
      const latestRevision = normalizeString(
        readProperty(record.desired, "revision"),
      );
      const recoveryResult = {
        requestId,
        action,
        processedAtMs,
      };
      const baseDelivery = {
        ...delivery,
        lastRecoveryRequestId: requestId,
      };
      let nextRecord = record;
      if (action === "confirm-send-absent" && recoverable) {
        nextRecord = {
          ...record,
          delivery: {
            ...omitRetryState(
              omitKeys(baseDelivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "sendInFlight",
                "lastError",
                "uncertainAtMs",
                "uncertainReason",
                "deadLetterAtMs",
              ]),
            ),
            status: "pending",
            revision: latestRevision,
            attempts: 0,
            ...(markerApiGateOwner
              ? { apiGateReleaseOwner: markerApiGateOwner }
              : {}),
          },
          manualRecoveryResult: {
            ...recoveryResult,
            status: "accepted",
          },
        };
      } else if (
        action === "confirm-send-applied" &&
        recoverable &&
        Number.isInteger(Number(request.messageId)) &&
        Number(request.messageId) > 0
      ) {
        const recoveredApplied = {
          destination: normalizeString(marker.destination),
          chatId: normalizeString(marker.chatId),
          messageId: Number(request.messageId),
          instanceKey: normalizeString(marker.instanceKey),
          revision: normalizeString(marker.revision),
          contentHash: normalizeString(marker.contentHash),
          appliedAtMs: processedAtMs,
          recoveredAtMs: processedAtMs,
        };
        let recoveredDelivery: RawRecord = {
          ...omitRetryState(
            omitKeys(baseDelivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "sendInFlight",
              "lastError",
              "uncertainAtMs",
              "uncertainReason",
              "deadLetterAtMs",
              "apiGateOwner",
              "apiGateGeneration",
              "apiGateStartedAtMs",
              "appliedStateUnknown",
            ]),
          ),
          status: "pending",
          revision: latestRevision,
          attempts: 0,
          ...(markerApiGateOwner
            ? { apiGateReleaseOwner: markerApiGateOwner }
            : {}),
        };
        const previousApplied = asObject(record.applied);
        const previousChatId =
          normalizeString(previousApplied.chatId) || recoveredApplied.chatId;
        if (
          typeof previousApplied.messageId === "number" &&
          Number.isInteger(previousApplied.messageId) &&
          previousApplied.messageId > 0 &&
          (previousApplied.messageId !== recoveredApplied.messageId ||
            previousChatId !== recoveredApplied.chatId)
        ) {
          const pendingDelete = {
            chatId: previousChatId,
            messageId: previousApplied.messageId,
            instanceKey: normalizeString(previousApplied.instanceKey),
            pendingDeleteId: buildPendingDeleteId({
              chatId: previousChatId,
              messageId: previousApplied.messageId,
            }),
            status: "pending",
            attempts: 0,
          };
          recoveredDelivery = appendPendingDelete(
            recoveredDelivery,
            pendingDelete,
          );
        }
        nextRecord = {
          ...record,
          applied: recoveredApplied,
          delivery: recoveredDelivery,
          manualRecoveryResult: {
            ...recoveryResult,
            status: "accepted",
            messageId: Number(request.messageId),
          },
        };
      } else if (action === "abandon" && recoverable) {
        nextRecord = {
          ...record,
          delivery: {
            ...omitRetryState(
              omitKeys(baseDelivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "sendInFlight",
                "uncertainAtMs",
                "uncertainReason",
              ]),
            ),
            status: "terminal",
            revision: latestRevision || normalizeString(delivery.revision),
            deadLetterAtMs: processedAtMs,
            ...(markerAttemptId
              ? {
                  abandonedSend: {
                    ...marker,
                    abandonedAtMs: processedAtMs,
                  },
                }
              : {}),
            lastError: {
              code: "manually-abandoned",
              atMs: processedAtMs,
            },
            ...(markerApiGateOwner
              ? { apiGateReleaseOwner: markerApiGateOwner }
              : {}),
          },
          manualRecoveryResult: {
            ...recoveryResult,
            status: "accepted",
          },
        };
      } else {
        nextRecord = {
          ...record,
          delivery: baseDelivery,
          manualRecoveryResult: {
            ...recoveryResult,
            status: "rejected",
            code:
              markerAttemptId && delivery.status !== "uncertain"
                ? "recovery-not-uncertain"
                : markerAttemptId
                  ? "invalid-manual-recovery"
                  : "missing-send-in-flight",
          },
        };
      }
      return { value: nextRecord, decision: "manual-recovery-processed" };
    });
    const recoveryResult = asObject(result.value?.manualRecoveryResult);
    const processed =
      result.committed && normalizeString(recoveryResult.requestId) !== "";
    const action = normalizeString(recoveryResult.action);
    const apiGateReleaseOwner = normalizeString(
      readProperty(result.value?.delivery, "apiGateReleaseOwner"),
    );
    return {
      processed,
      action,
      apiGateReleaseOwner,
      shouldContinue: !(
        processed &&
        recoveryResult.status === "accepted" &&
        action === "abandon"
      ),
    };
  };

  const settleManualApiGateRelease = async (
    messageKey: string,
    ownerInput: unknown,
  ) => {
    const owner = normalizeString(ownerInput);
    if (!owner) {
      return;
    }
    await repository.releaseApiGate(owner);
    ensureCommitted(
      await transact(messageKey, (record) => {
        const delivery = asObject(record.delivery);
        if (normalizeString(delivery.apiGateReleaseOwner) !== owner) {
          return { commit: false, decision: "manual-gate-release-settled" };
        }
        return {
          value: {
            ...record,
            delivery: omitKeys(delivery, ["apiGateReleaseOwner"]),
          },
          decision: "manual-gate-release-settled",
        };
      }),
      "manual-gate-release-finalization-failed",
    );
  };

  const acquire = async (
    messageKey: string,
    ownerToken: string,
    nowMs: number,
  ) => {
    let acquireDecision = "missing";
    const result = await transact(messageKey, (record) => {
      const desired = asObject(record.desired);
      const delivery = asObject(record.delivery);
      const desiredRevision = normalizeString(desired.revision);
      const leaseExpiresAtMs = Number(delivery.leaseExpiresAtMs) || 0;
      if (normalizeString(delivery.apiGateSettleOwner)) {
        acquireDecision = "desired-api-gate-settle-pending";
        return { commit: false, decision: acquireDecision };
      }
      if (normalizeString(delivery.pendingDeleteApiGateSettleOwner)) {
        acquireDecision = "pending-api-gate-settle-pending";
        return { commit: false, decision: acquireDecision };
      }
      if (
        delivery.status === "processing" &&
        normalizeString(delivery.leaseOwner) !== ownerToken &&
        leaseExpiresAtMs > nowMs
      ) {
        acquireDecision = "locked";
        return { commit: false, decision: acquireDecision };
      }
      const currentApiGateOwner =
        normalizeString(delivery.apiGateOwner) ||
        normalizeString(readProperty(delivery.sendInFlight, "apiGateOwner"));
      const currentProofGateOwner = normalizeString(
        readProperty(delivery.apiGateProofRequired, "owner"),
      );
      if (
        currentApiGateOwner &&
        currentApiGateOwner === currentProofGateOwner
      ) {
        acquireDecision = "rate-limit-proof-pending";
        return { commit: false, decision: acquireDecision };
      }
      const pendingDelete = asObject(delivery.pendingDelete);
      const pendingApiGateOwner = normalizeString(pendingDelete.apiGateOwner);
      const pendingProofGateOwner = normalizeString(
        readProperty(pendingDelete.apiGateProofRequired, "owner"),
      );
      if (
        pendingApiGateOwner &&
        pendingApiGateOwner === pendingProofGateOwner
      ) {
        acquireDecision = "pending-rate-limit-proof-pending";
        return { commit: false, decision: acquireDecision };
      }
      if (
        pendingApiGateOwner &&
        pendingDelete.status === "processing" &&
        normalizeTimestamp(pendingDelete.leaseExpiresAtMs) <= nowMs
      ) {
        acquireDecision = "pending-api-gate-settle-pending";
        return {
          value: {
            ...record,
            delivery: {
              ...delivery,
              pendingDelete: omitKeys(pendingDelete, [
                "apiGateOwner",
                "apiGateGeneration",
              ]),
              pendingDeleteApiGateSettleOwner: pendingApiGateOwner,
            },
          },
          decision: acquireDecision,
        };
      }
      if (delivery.sendInFlight) {
        const sendInFlight = asObject(delivery.sendInFlight);
        const sendApiGateOwner = normalizeString(sendInFlight.apiGateOwner);
        const revision =
          desiredRevision || normalizeString(delivery.revision) || "invalid";
        acquireDecision = "in-flight-uncertain";
        if (delivery.status === "uncertain") {
          if (normalizeString(delivery.revision) === revision) {
            return { commit: false, decision: acquireDecision };
          }
          return {
            value: {
              ...record,
              delivery: {
                ...delivery,
                status: "uncertain",
                revision,
                attempts: 0,
                sendInFlight,
              },
            },
            decision: acquireDecision,
          };
        }
        return {
          value: {
            ...record,
            delivery: {
              ...omitKeys(delivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "retryAtMs",
              ]),
              status: "uncertain",
              revision,
              uncertainAtMs: nowMs,
              uncertainReason: "abandoned-send-in-flight",
              sendInFlight,
              ...(sendApiGateOwner
                ? { apiGateSettleOwner: sendApiGateOwner }
                : {}),
              lastError: {
                code: "abandoned-send-in-flight",
                atMs: nowMs,
              },
            },
          },
          decision: acquireDecision,
        };
      }
      if (!validateDesiredForDelivery(desired)) {
        acquireDecision = "invalid";
        const apiGateOwner = normalizeString(delivery.apiGateOwner);
        const proofGateOwner = normalizeString(
          readProperty(delivery.apiGateProofRequired, "owner"),
        );
        const shouldSettleApiGate =
          apiGateOwner && apiGateOwner !== proofGateOwner;
        return {
          value: {
            ...record,
            delivery: {
              ...omitRetryState(
                omitKeys(delivery, [
                  "leaseOwner",
                  "leaseExpiresAtMs",
                  "lastError",
                  ...(shouldSettleApiGate
                    ? [
                        "apiGateOwner",
                        "apiGateGeneration",
                        "apiGateStartedAtMs",
                      ]
                    : []),
                ]),
              ),
              ...(shouldSettleApiGate
                ? { apiGateSettleOwner: apiGateOwner }
                : {}),
              status: "terminal",
              revision: desiredRevision || "invalid",
              attempts: normalizeAttempts(delivery.attempts),
              lastError: {
                code: "invalid-desired-state",
                atMs: nowMs,
              },
            },
          },
          decision: acquireDecision,
        };
      }
      const revision = desired.revision;
      if (
        delivery.revision === revision &&
        ["pending", "processing", "retryable"].includes(
          delivery.status as string,
        ) &&
        resolveRetryDeadlineAtMs(delivery) > 0 &&
        resolveRetryDeadlineAtMs(delivery) <= nowMs
      ) {
        acquireDecision = "retry-exhausted";
        const apiGateOwner = normalizeString(delivery.apiGateOwner);
        const proofGateOwner = normalizeString(
          readProperty(delivery.apiGateProofRequired, "owner"),
        );
        const shouldSettleApiGate =
          apiGateOwner && apiGateOwner !== proofGateOwner;
        return {
          value: {
            ...record,
            delivery: {
              ...omitRetryState(
                omitKeys(delivery, [
                  "leaseOwner",
                  "leaseExpiresAtMs",
                  "sendInFlight",
                  ...(shouldSettleApiGate
                    ? [
                        "apiGateOwner",
                        "apiGateGeneration",
                        "apiGateStartedAtMs",
                      ]
                    : []),
                ]),
              ),
              ...(shouldSettleApiGate
                ? { apiGateSettleOwner: apiGateOwner }
                : {}),
              status: "terminal",
              revision,
              deadLetterAtMs: nowMs,
              lastError: {
                code: "safe-retry-window-exhausted",
                atMs: nowMs,
              },
            },
          },
          decision: acquireDecision,
        };
      }
      if (
        delivery.revision === revision &&
        delivery.status === "retryable" &&
        Number(delivery.retryAtMs) > nowMs
      ) {
        acquireDecision = "deferred";
        return { commit: false, decision: acquireDecision };
      }
      if (
        delivery.revision === revision &&
        (delivery.status === "terminal" ||
          delivery.status === "uncertain" ||
          delivery.status === "delivered")
      ) {
        acquireDecision = "settled";
        return { commit: false, decision: acquireDecision };
      }
      const deliveryForAcquire = delivery;
      acquireDecision = "acquired";
      const sameRevision = deliveryForAcquire.revision === revision;
      const proofRequiredOwner = normalizeString(
        readProperty(deliveryForAcquire.apiGateProofRequired, "owner"),
      );
      const previousApiGateOwner = normalizeString(
        deliveryForAcquire.apiGateOwner,
      );
      const supersededApiGateOwner =
        normalizeString(deliveryForAcquire.apiGateSettleOwner) ||
        (sameRevision || previousApiGateOwner === proofRequiredOwner
          ? ""
          : previousApiGateOwner);
      const deliveryForRevision = sameRevision
        ? deliveryForAcquire
        : omitRetryState(
            omitKeys(deliveryForAcquire, [
              "safeRejectionAtMs",
              "safeRejectionRecoveredAtMs",
              "apiGateOwner",
              "apiGateGeneration",
              "apiGateStartedAtMs",
              "apiGateSettleOwner",
            ]),
          );
      return {
        value: {
          ...record,
          delivery: {
            ...omitKeys(deliveryForRevision, [
              "retryAtMs",
              "lastError",
              "deadLetterAtMs",
            ]),
            ...(supersededApiGateOwner
              ? { apiGateSettleOwner: supersededApiGateOwner }
              : {}),
            status: "processing",
            revision,
            attempts: sameRevision
              ? normalizeAttempts(deliveryForRevision.attempts) + 1
              : 1,
            leaseOwner: ownerToken,
            leaseExpiresAtMs: nowMs + leaseTtlMs,
            startedAtMs: nowMs,
          },
        },
        decision: acquireDecision,
      };
    });
    return { ...result, decision: acquireDecision };
  };

  const updateOwned = async (
    messageKey: string,
    ownerToken: string,
    updater: OwnedMutation,
  ) =>
    transact(messageKey, (record) => {
      const delivery = asObject(record.delivery);
      if (normalizeString(delivery.leaseOwner) !== ownerToken) {
        return { commit: false, decision: "lease-lost" };
      }
      return {
        value: updater(record, delivery),
        decision: "updated",
      };
    });

  const prepareDesiredApiGateIdentity = async ({
    messageKey,
    ownerToken,
    revision,
    requestedGeneration,
    apiGateReclaimOwner,
  }: {
    messageKey: string;
    ownerToken: string;
    revision: string;
    requestedGeneration?: string;
    apiGateReclaimOwner?: string;
  }) => {
    const generation =
      normalizeString(requestedGeneration) || `direct:${revision}`;
    const preparedAtMs = now();
    const prepared = ensureCommitted(
      await updateOwned(messageKey, ownerToken, (record, delivery) => {
        const existingOwner = normalizeString(delivery.apiGateOwner);
        return {
          ...record,
          delivery: {
            ...delivery,
            apiGateOwner:
              existingOwner ||
              buildApiGateOwner(messageKey, "desired", revision, generation),
            apiGateGeneration:
              normalizeString(delivery.apiGateGeneration) || generation,
            apiGateStartedAtMs:
              normalizeTimestamp(delivery.apiGateStartedAtMs) || preparedAtMs,
          },
        };
      }),
      "api-gate-identity-not-persisted",
    );
    const delivery = asObject(prepared.value?.delivery);
    const owner = normalizeString(delivery.apiGateOwner);
    const persistedGeneration = normalizeString(delivery.apiGateGeneration);
    const proofRequiredOwner = normalizeString(
      readProperty(delivery.apiGateProofRequired, "owner"),
    );
    const mayReclaim = owner !== "" && proofRequiredOwner !== owner;
    return {
      owner,
      generation: persistedGeneration,
      reclaimOwner: mayReclaim ? owner : "",
      delivery,
    };
  };

  const settlePersistedApiGate = async ({
    messageKey,
    field,
    owner: ownerInput,
  }: {
    messageKey: string;
    field: string;
    owner: unknown;
  }) => {
    const settleOwner = normalizeString(ownerInput);
    if (!settleOwner) {
      return null;
    }
    await repository.releaseApiGate(settleOwner);
    const result = await transact(messageKey, (record) => {
      const delivery = asObject(record.delivery);
      if (normalizeString(delivery[field]) !== settleOwner) {
        return { commit: false, decision: "api-gate-settle-stale" };
      }
      return {
        value: {
          ...record,
          delivery: omitKeys(delivery, [field]),
        },
        decision: "api-gate-settled",
      };
    });
    if (!result.committed && result.decision !== "api-gate-settle-stale") {
      ensureCommitted(result, "api-gate-settle-finalization-failed");
    }
    return result;
  };

  const finishStatus = async ({
    messageKey,
    ownerToken,
    desired,
    status,
    nowMs,
    result,
    applied,
    clearApplied = false,
    clearAppliedStateUnknown = false,
    preserveSendInFlight = false,
    apiGateSettleOwner = "",
  }: FinishStatusInput) =>
    ensureCommitted(
      await updateOwned(messageKey, ownerToken, (record, delivery) => {
        const latestRevision = normalizeString(
          readProperty(record.desired, "revision"),
        );
        const desiredStillLatest = latestRevision === desired.revision;
        const nextDeliveryStatus =
          status === "uncertain"
            ? "uncertain"
            : desiredStillLatest
              ? status
              : "pending";
        const nextDelivery: RawRecord = {
          ...omitRetryState(
            omitKeys(delivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "lastError",
              "uncertainAtMs",
              "uncertainReason",
              "deadLetterAtMs",
              "apiGateOwner",
              "apiGateGeneration",
              "apiGateStartedAtMs",
              ...(clearAppliedStateUnknown ? ["appliedStateUnknown"] : []),
              ...(preserveSendInFlight ? [] : ["sendInFlight"]),
            ]),
          ),
          status: nextDeliveryStatus,
          revision: desiredStillLatest ? desired.revision : latestRevision,
          ...(normalizeString(apiGateSettleOwner)
            ? { apiGateSettleOwner }
            : {}),
        };
        if (!desiredStillLatest) {
          nextDelivery.attempts = 0;
          delete nextDelivery.deliveredAtMs;
        }
        if (status === "delivered" && desiredStillLatest) {
          nextDelivery.deliveredAtMs = nowMs;
        }
        if (
          ((desiredStillLatest && status === "terminal") ||
            status === "uncertain") &&
          result
        ) {
          nextDelivery.lastError = buildErrorState(result, nowMs);
        }
        if (status === "uncertain") {
          nextDelivery.uncertainAtMs = nowMs;
          nextDelivery.uncertainReason =
            normalizeString(result?.code) || "ambiguous-send";
        }
        if (
          desiredStillLatest &&
          status === "terminal" &&
          result?.code === "safe-retry-window-exhausted"
        ) {
          nextDelivery.deadLetterAtMs = nowMs;
        }
        const nextRecord: RawRecord = {
          ...record,
          delivery: nextDelivery,
        };
        if (clearApplied) {
          delete nextRecord.applied;
        } else if (applied) {
          nextRecord.applied = applied;
        }
        return nextRecord;
      }),
      `${status}-finalization-failed`,
    );

  const finishStatusAndSettleApiGate = async (input: FinishStatusInput) => {
    const owner = normalizeString(input.apiGateSettleOwner);
    const finalized = await finishStatus(input);
    if (owner) {
      await settlePersistedApiGate({
        messageKey: input.messageKey,
        field: "apiGateSettleOwner",
        owner,
      });
    }
    return finalized;
  };

  const finishRetryable = async ({
    messageKey,
    ownerToken,
    desired,
    result,
    safeRejectedAttemptId = "",
    currentDelivery,
    apiGateOwner = "",
    proofTaskKind = TELEGRAM_DESIRED_TASK_KIND,
    pendingDeleteId = "",
    preserveApiGateIdentity = false,
    persistBeforeSchedule = false,
  }: DesiredContext & {
    result: TelegramRetryFailure;
    safeRejectedAttemptId?: string;
    currentDelivery: unknown;
    apiGateOwner?: string;
    proofTaskKind?: "desired" | "pending-delete";
    pendingDeleteId?: string;
    preserveApiGateIdentity?: boolean;
    persistBeforeSchedule?: boolean;
  }) => {
    return retryCoordinator.finish({
      current: asObject(currentDelivery),
      failure: result,
      target: { kind: proofTaskKind, safeRejectedAttemptId, pendingDeleteId },
      messageKey,
      revision: desired.revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        ensureCommitted(
          await updateOwned(messageKey, ownerToken, (record, delivery) => ({
            ...record,
            delivery: {
              ...delivery,
              apiGateProofRequired: {
                owner: apiGateOwner,
                retryNotBeforeMs: barrierRetryNotBeforeMs,
                revision: desired.revision,
                proofTaskKind,
                ...retryState,
                ...(safeRejectedAttemptId ? { safeRejectedAttemptId } : {}),
                ...(pendingDeleteId ? { pendingDeleteId } : {}),
                ...(!safeRejectedAttemptId
                  ? { retryProofLeaseOwner: ownerToken }
                  : {}),
              },
            },
          })),
          "rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await updateOwned(
          messageKey,
          ownerToken,
          (record, delivery) => {
            const latestRevision = normalizeString(
              readProperty(record.desired, "revision"),
            );
            const desiredStillLatest = latestRevision === desired.revision;
            return {
              ...record,
              delivery: {
                ...omitRetryState(
                  omitKeys(delivery, [
                    "leaseOwner",
                    "leaseExpiresAtMs",
                    "lastError",
                    "sendInFlight",
                    ...(preserveApiGateIdentity
                      ? []
                      : [
                          "apiGateOwner",
                          "apiGateGeneration",
                          "apiGateStartedAtMs",
                          "apiGateProofRequired",
                          "apiGateSettleOwner",
                        ]),
                  ]),
                ),
                status: desiredStillLatest ? "retryable" : "pending",
                revision: desiredStillLatest
                  ? desired.revision
                  : latestRevision,
                attempts: desiredStillLatest
                  ? normalizeAttempts(delivery.attempts)
                  : 0,
                ...(desiredStillLatest
                  ? {
                      ...retryState,
                      lastError: buildErrorState(result, finalizedAtMs),
                      ...(result?.code === "rate-limited"
                        ? { safeRejectionAtMs: finalizedAtMs }
                        : {}),
                    }
                  : {}),
              },
            };
          },
        );
        if (!finalization.committed) {
          const current = asObject(await repository.getMessage(messageKey));
          const currentDeliveryState = asObject(current.delivery);
          const proofAlreadyApplied =
            rateLimited &&
            normalizeRetrySequence(currentDeliveryState.retrySequence) >=
              retryState.retrySequence &&
            normalizeString(
              readProperty(currentDeliveryState.apiGateProofRequired, "owner"),
            ) !== normalizeString(apiGateOwner);
          if (!proofAlreadyApplied) {
            ensureCommitted(finalization, "retryable-finalization-failed");
          }
        }
      },
    });
  };

  const finishExpiredOwnedRetryWindow = async ({
    messageKey,
    ownerToken,
    desired,
    currentDelivery,
  }: DesiredContext & { currentDelivery: unknown }) => {
    const deadlineAtMs = resolveRetryDeadlineAtMs(currentDelivery);
    const checkedAtMs = now();
    if (!deadlineAtMs || checkedAtMs < deadlineAtMs) {
      return null;
    }
    const result = { code: "safe-retry-window-exhausted" };
    const current = asObject(currentDelivery);
    const apiGateOwner = normalizeString(current.apiGateOwner);
    const proofGateOwner = normalizeString(
      readProperty(current.apiGateProofRequired, "owner"),
    );
    await finishStatusAndSettleApiGate({
      messageKey,
      ownerToken,
      desired,
      status: "terminal",
      result,
      nowMs: checkedAtMs,
      apiGateSettleOwner:
        apiGateOwner && apiGateOwner !== proofGateOwner ? apiGateOwner : "",
    });
    return { status: "terminal", reason: result.code };
  };

  const markAppliedStateUnknown = async ({
    messageKey,
    ownerToken,
    desired,
    operation,
    apiGateOwner,
  }: DesiredContext & { operation: string; apiGateOwner: string }) => {
    const markedAtMs = now();
    return ensureCommitted(
      await updateOwned(messageKey, ownerToken, (record, delivery) => ({
        ...record,
        delivery: {
          ...delivery,
          appliedStateUnknown: {
            revision: desired.revision,
            operation,
            apiGateOwner,
            markedAtMs,
          },
        },
      })),
      "applied-state-unknown-not-persisted",
    );
  };

  const markDelivered = (
    messageKey: string,
    ownerToken: string,
    desired: TelegramDesired,
    nowMs: number,
    options: Partial<FinishStatusInput> = {},
  ) =>
    finishStatus({
      messageKey,
      ownerToken,
      desired,
      status: "delivered",
      nowMs,
      ...options,
    });

  const runDelete = async ({
    messageKey,
    ownerToken,
    desired,
    chatId,
    messageId,
    nowMs,
    currentDelivery,
    requestedGeneration,
    apiGateReclaimOwner,
  }: DesiredContext & {
    chatId: string;
    messageId: number;
    nowMs: number;
    currentDelivery: unknown;
    requestedGeneration?: string;
    apiGateReclaimOwner?: string;
  }) => {
    const expired = await finishExpiredOwnedRetryWindow({
      messageKey,
      ownerToken,
      desired,
      currentDelivery,
    });
    if (expired) {
      return expired;
    }
    const gateIdentity = await prepareDesiredApiGateIdentity({
      messageKey,
      ownerToken,
      revision: desired.revision,
      requestedGeneration,
      apiGateReclaimOwner,
    });
    const apiGateOwner = gateIdentity.owner;
    const gateResult = await acquireApiGate({
      messageKey,
      revision: desired.revision,
      operation: "delete",
      owner: apiGateOwner,
      reclaimOwner: gateIdentity.reclaimOwner,
      taskGeneration: gateIdentity.generation,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        currentDelivery: gateIdentity.delivery,
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const callAtMs = now();
    if (
      resolveRetryDeadlineAtMs(gateIdentity.delivery) > 0 &&
      resolveRetryDeadlineAtMs(gateIdentity.delivery) <= callAtMs
    ) {
      const result = { code: "safe-retry-window-exhausted" };
      await finishStatusAndSettleApiGate({
        messageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs: callAtMs,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "terminal", reason: result.code };
    }
    await markAppliedStateUnknown({
      messageKey,
      ownerToken,
      desired,
      operation: "delete",
      apiGateOwner,
    });
    const result = await client.deleteTelegramMessage({ chatId, messageId });
    if (result.ok) {
      await finishStatusAndSettleApiGate({
        messageKey,
        ownerToken,
        desired,
        status: "delivered",
        nowMs,
        clearApplied: true,
        clearAppliedStateUnknown: true,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "delivered" };
    }
    if (result.classification === "retryable") {
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result,
        currentDelivery: gateIdentity.delivery,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await finishStatusAndSettleApiGate({
      messageKey,
      ownerToken,
      desired,
      status: "terminal",
      result,
      nowMs,
      apiGateSettleOwner: apiGateOwner,
    });
    logFailure(messageKey, "terminal", result);
    return { status: "terminal", reason: result.code };
  };

  const runSend = async ({
    messageKey,
    ownerToken,
    desired,
    chatId,
    previousApplied,
    nowMs,
  }: DesiredContext & {
    chatId: string;
    previousApplied: RawRecord | null;
    nowMs: number;
    requestedGeneration?: string;
  }) => {
    const marker: RawRecord & {
      attemptId: string;
      revision: string;
      apiGateOwner?: string;
    } = {
      attemptId: createAttemptId(),
      revision: desired.revision,
      destination: desired.destination,
      chatId,
      instanceKey: desired.instanceKey,
      contentHash: desired.contentHash,
      startedAtMs: nowMs,
    };
    marker.apiGateOwner = `send:${marker.attemptId}`;
    const marked = await updateOwned(
      messageKey,
      ownerToken,
      (record, delivery) => {
        if (
          normalizeString(readProperty(record.desired, "revision")) !==
          desired.revision
        ) {
          return {
            ...record,
            delivery: {
              ...omitKeys(delivery, ["leaseOwner", "leaseExpiresAtMs"]),
              status: "pending",
              revision: normalizeString(
                readProperty(record.desired, "revision"),
              ),
            },
          };
        }
        return {
          ...record,
          delivery: {
            ...delivery,
            sendInFlight: marker,
          },
        };
      },
    );
    if (
      !marked.committed ||
      readProperty(
        readProperty(marked.value?.delivery, "sendInFlight"),
        "revision",
      ) !== desired.revision
    ) {
      return { status: "stale" };
    }

    const expired = await finishExpiredOwnedRetryWindow({
      messageKey,
      ownerToken,
      desired,
      currentDelivery: marked.value?.delivery,
    });
    if (expired) {
      return expired;
    }

    const gateResult = await acquireApiGate({
      messageKey,
      revision: desired.revision,
      operation: "send",
      owner: marker.apiGateOwner,
      attemptId: marker.attemptId,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        currentDelivery: marked.value?.delivery,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const callAtMs = now();
    if (
      normalizeTimestamp(
        readProperty(marked.value?.delivery, "retryDeadlineAtMs"),
      ) > 0 &&
      normalizeTimestamp(
        readProperty(marked.value?.delivery, "retryDeadlineAtMs"),
      ) <= callAtMs
    ) {
      const expiredResult = { code: "safe-retry-window-exhausted" };
      await finishStatusAndSettleApiGate({
        messageKey,
        ownerToken,
        desired,
        status: "terminal",
        result: expiredResult,
        nowMs: callAtMs,
        apiGateSettleOwner: marker.apiGateOwner,
      });
      return { status: "terminal", reason: expiredResult.code };
    }

    const result = await client.sendTelegramMessage({
      chatId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      silent: desired.silent === true,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    });
    if (result.ok) {
      const applied = {
        destination: desired.destination,
        chatId,
        messageId: result.messageId,
        instanceKey: desired.instanceKey,
        revision: desired.revision,
        contentHash: desired.contentHash,
        appliedAtMs: nowMs,
      };
      const receiptWrite = await updateOwned(
        messageKey,
        ownerToken,
        (record, delivery) => {
          const latestRevision = normalizeString(
            readProperty(record.desired, "revision"),
          );
          const nextDelivery: RawRecord = {
            ...omitRetryState(
              omitKeys(delivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "sendInFlight",
                "lastError",
                "deadLetterAtMs",
                "apiGateOwner",
                "apiGateGeneration",
                "apiGateStartedAtMs",
                "appliedStateUnknown",
              ]),
            ),
            status:
              latestRevision === desired.revision ? "delivered" : "pending",
            revision: latestRevision || desired.revision,
            apiGateSettleOwner: marker.apiGateOwner,
            ...(latestRevision === desired.revision
              ? { deliveredAtMs: nowMs }
              : {}),
          };
          if (latestRevision !== desired.revision) {
            nextDelivery.attempts = 0;
          }
          if (
            previousApplied &&
            typeof previousApplied.messageId === "number" &&
            Number.isInteger(previousApplied.messageId) &&
            previousApplied.messageId > 0 &&
            (previousApplied.messageId !== result.messageId ||
              normalizeString(previousApplied.chatId) !== chatId)
          ) {
            const pendingDelete = {
              chatId: normalizeString(previousApplied.chatId) || chatId,
              messageId: previousApplied.messageId,
              instanceKey: normalizeString(previousApplied.instanceKey),
              pendingDeleteId: buildPendingDeleteId({
                chatId: normalizeString(previousApplied.chatId) || chatId,
                messageId: previousApplied.messageId,
              }),
              status: "pending",
              attempts: 0,
            };
            Object.assign(
              nextDelivery,
              appendPendingDelete(nextDelivery, pendingDelete),
            );
          }
          return {
            ...record,
            applied,
            delivery: nextDelivery,
          };
        },
      );
      ensureCommitted(receiptWrite, "send-receipt-not-persisted");
      await settlePersistedApiGate({
        messageKey,
        field: "apiGateSettleOwner",
        owner: marker.apiGateOwner,
      });
      return { status: "delivered", messageId: result.messageId };
    }

    if (result.classification === "retryable") {
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result,
        safeRejectedAttemptId: marker.attemptId,
        currentDelivery: marked.value?.delivery,
        apiGateOwner: marker.apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const status =
      result.classification === "uncertain" ? "uncertain" : "terminal";
    await finishStatusAndSettleApiGate({
      messageKey,
      ownerToken,
      desired,
      status,
      result,
      nowMs,
      preserveSendInFlight: status === "uncertain",
      apiGateSettleOwner: marker.apiGateOwner,
    });
    logFailure(messageKey, status, result);
    return { status, reason: result.code };
  };

  const reconcileDesired = async (
    {
      messageKey,
      requestedRevision = "",
      safeRejectedAttemptId = "",
      retryStartedAtMs = 0,
      retryDeadlineAtMs = 0,
      retryAtMs = 0,
      retrySequence = 0,
      retryProofLeaseOwner = "",
      requestedGeneration = "",
      taskKind = TELEGRAM_DESIRED_TASK_KIND,
      apiGateReclaimOwner = "",
      apiGateSettleOwner = "",
    }: TelegramReconcileInput = { messageKey: "" },
  ) => {
    const normalizedMessageKey = validateTelegramMessageKey(messageKey);
    const nowMs = now();
    if (normalizeString(apiGateSettleOwner)) {
      await repository.releaseApiGate(apiGateSettleOwner);
    }
    await applySafeRetryProof(normalizedMessageKey, {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
    });
    if (taskKind !== TELEGRAM_PENDING_DELETE_TASK_KIND) {
      await applyDesiredRetryWindowProof(normalizedMessageKey, {
        requestedRevision,
        safeRejectedAttemptId,
        retryStartedAtMs,
        retryDeadlineAtMs,
        retryAtMs,
        retrySequence,
        retryProofLeaseOwner,
        apiGateReclaimOwner,
      });
    }
    const recovery = await applyManualRecovery(normalizedMessageKey);
    await settleManualApiGateRelease(
      normalizedMessageKey,
      recovery.apiGateReleaseOwner,
    );
    if (recovery.processed && !recovery.shouldContinue) {
      return { status: "terminal", reason: "manually-abandoned" };
    }
    const retryNotBeforeMs = Math.max(
      await repository.getRetryNotBeforeMs(),
      localRetryBarrier.getRetryNotBeforeMs(),
    );
    const ownerToken = createOwnerToken();
    let acquired = await acquire(normalizedMessageKey, ownerToken, nowMs);
    for (let settlementCount = 0; settlementCount < 2; settlementCount += 1) {
      const field =
        acquired.decision === "desired-api-gate-settle-pending"
          ? "apiGateSettleOwner"
          : acquired.decision === "pending-api-gate-settle-pending"
            ? "pendingDeleteApiGateSettleOwner"
            : "";
      if (!field) {
        break;
      }
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field,
        owner: readProperty(readProperty(acquired.value, "delivery"), field),
      });
      acquired = await acquire(normalizedMessageKey, ownerToken, nowMs);
    }
    if (
      (acquired.decision === "invalid" ||
        acquired.decision === "retry-exhausted") &&
      normalizeString(
        readProperty(acquired.value?.delivery, "apiGateSettleOwner"),
      )
    ) {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: readProperty(
          readProperty(acquired.value, "delivery"),
          "apiGateSettleOwner",
        ),
      });
    }
    if (acquired.decision === "invalid") {
      return { status: "terminal", reason: "invalid-desired-state" };
    }
    if (acquired.decision === "in-flight-uncertain") {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: readProperty(acquired.value?.delivery, "apiGateSettleOwner"),
      });
      return { status: "uncertain", reason: "abandoned-send-in-flight" };
    }
    if (acquired.decision === "pending-rate-limit-proof-pending") {
      const proof = asObject(
        readProperty(
          readProperty(acquired.value?.delivery, "pendingDelete"),
          "apiGateProofRequired",
        ),
      );
      const proofRetryState = {
        retryStartedAtMs: normalizeTimestamp(proof.retryStartedAtMs),
        retryDeadlineAtMs: normalizeTimestamp(proof.retryDeadlineAtMs),
        retryAtMs: normalizeTimestamp(proof.retryAtMs),
        retrySequence: normalizeRetrySequence(proof.retrySequence),
      };
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(proof.revision) || requestedRevision || "latest",
        taskKind: TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
        retryState: proofRetryState,
        pendingDeleteId: normalizeString(proof.pendingDeleteId),
        retryProofLeaseOwner: normalizeString(proof.retryProofLeaseOwner),
        proofTaskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
        barrierProofOwner: proof.owner,
        barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        scheduleTimeMs: nowMs,
      });
      let barrierProof = { applied: false };
      try {
        barrierProof = await applyRateLimitBarrierProof({
          barrierProofOwner: proof.owner,
          barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        });
      } catch (_error) {
        barrierProof = { applied: false };
      }
      if (barrierProof.applied) {
        await applyPendingDeleteRetryWindowProof(normalizedMessageKey, {
          pendingDeleteId: proof.pendingDeleteId,
          retryProofLeaseOwner: proof.retryProofLeaseOwner,
          ...proofRetryState,
        });
        await clearAppliedRateLimitProofMarker(
          normalizedMessageKey,
          proof.owner,
        );
      }
      return {
        status: "retryable",
        reason: "pending-rate-limit-proof-pending",
        retryAtMs: normalizeTimestamp(proof.retryNotBeforeMs),
        scheduled: true,
      };
    }
    if (acquired.decision === "rate-limit-proof-pending") {
      const proof = asObject(
        readProperty(acquired.value?.delivery, "apiGateProofRequired"),
      );
      const proofRetryState = {
        retryStartedAtMs: normalizeTimestamp(proof.retryStartedAtMs),
        retryDeadlineAtMs: normalizeTimestamp(proof.retryDeadlineAtMs),
        retryAtMs: normalizeTimestamp(proof.retryAtMs),
        retrySequence: normalizeRetrySequence(proof.retrySequence),
      };
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(proof.revision) || requestedRevision || "latest",
        taskKind: TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
        retryState: proofRetryState,
        safeRejectedAttemptId: normalizeString(proof.safeRejectedAttemptId),
        retryProofLeaseOwner: normalizeString(proof.retryProofLeaseOwner),
        proofTaskKind: TELEGRAM_DESIRED_TASK_KIND,
        barrierProofOwner: proof.owner,
        barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        scheduleTimeMs: nowMs,
      });
      let barrierProof = { applied: false };
      try {
        barrierProof = await applyRateLimitBarrierProof({
          barrierProofOwner: proof.owner,
          barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        });
      } catch (_error) {
        barrierProof = { applied: false };
      }
      if (barrierProof.applied) {
        await applySafeRetryProof(normalizedMessageKey, {
          requestedRevision: proof.revision,
          safeRejectedAttemptId: proof.safeRejectedAttemptId,
          ...proofRetryState,
        });
        await applyDesiredRetryWindowProof(normalizedMessageKey, {
          requestedRevision: proof.revision,
          retryProofLeaseOwner: proof.retryProofLeaseOwner,
          ...proofRetryState,
        });
        await clearAppliedRateLimitProofMarker(
          normalizedMessageKey,
          proof.owner,
        );
      }
      return {
        status: "retryable",
        reason: "rate-limit-proof-pending",
        retryAtMs: normalizeTimestamp(proof.retryNotBeforeMs),
        scheduled: true,
      };
    }
    if (acquired.decision === "locked") {
      const lockedGateOwner = normalizeString(
        readProperty(acquired.value?.delivery, "apiGateOwner"),
      );
      const lockedGateGeneration = normalizeString(
        readProperty(acquired.value?.delivery, "apiGateGeneration"),
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        (normalizeString(apiGateReclaimOwner) === lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration === normalizeString(requestedGeneration)));
      const lockedRetryAtMs =
        normalizeTimestamp(
          readProperty(acquired.value?.delivery, "leaseExpiresAtMs"),
        ) || nowMs + 1000;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision: requestedRevision || "latest",
        taskKind: TELEGRAM_DESIRED_TASK_KIND,
        retryState: {
          retryStartedAtMs:
            readProperty(acquired.value?.delivery, "retryStartedAtMs") ||
            retryStartedAtMs,
          retryDeadlineAtMs:
            readProperty(acquired.value?.delivery, "retryDeadlineAtMs") ||
            retryDeadlineAtMs,
          retryAtMs: lockedRetryAtMs,
          retrySequence:
            readProperty(acquired.value?.delivery, "retrySequence") ??
            retrySequence,
        },
        sourceGeneration: requestedGeneration,
        apiGateReclaimOwner: mayReclaimLockedGate ? lockedGateOwner : "",
      });
      return {
        status: "retryable",
        reason: "locked",
        retryAtMs: lockedRetryAtMs,
        scheduled: true,
      };
    }
    if (acquired.decision === "deferred") {
      const deferredRetryAtMs =
        Number(readProperty(acquired.value?.delivery, "retryAtMs")) || null;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
          requestedRevision ||
          "latest",
        taskKind: TELEGRAM_DESIRED_TASK_KIND,
        retryState: {
          retryStartedAtMs: readProperty(
            acquired.value?.delivery,
            "retryStartedAtMs",
          ),
          retryDeadlineAtMs: readProperty(
            acquired.value?.delivery,
            "retryDeadlineAtMs",
          ),
          retryAtMs: deferredRetryAtMs,
          retrySequence: readProperty(
            acquired.value?.delivery,
            "retrySequence",
          ),
        },
        sourceGeneration: requestedGeneration,
      });
      return {
        status: "retryable",
        reason: "retry-after",
        retryAtMs: deferredRetryAtMs,
        scheduled: true,
      };
    }
    if (acquired.decision === "retry-exhausted") {
      return {
        status: "terminal",
        reason: "safe-retry-window-exhausted",
      };
    }
    if (acquired.decision === "settled") {
      return { status: "settled" };
    }
    if (acquired.decision !== "acquired") {
      return { status: "skipped", reason: "missing" };
    }

    let record = asObject(acquired.value);
    const settledSupersededGate = await settlePersistedApiGate({
      messageKey: normalizedMessageKey,
      field: "apiGateSettleOwner",
      owner: readProperty(record.delivery, "apiGateSettleOwner"),
    });
    if (settledSupersededGate) {
      record = asObject(settledSupersededGate.value);
    }
    const desired = asObject(record.desired) as TelegramDesired;
    const applied = asObject(record.applied);
    if (
      requestedRevision &&
      requestedRevision !== desired.revision &&
      typeof logger?.info === "function"
    ) {
      logger.info("telegram:delivery:stale-task", {
        messageKey: normalizedMessageKey,
      });
    }

    const barrierCheckedAtMs = now();
    if (retryNotBeforeMs > barrierCheckedAtMs) {
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: {
          code: "global-retry-after",
          retryAfterSeconds: Math.max(
            0,
            (retryNotBeforeMs - barrierCheckedAtMs) / 1000,
          ),
        },
        currentDelivery: record.delivery,
        preserveApiGateIdentity: Boolean(
          readProperty(record.delivery, "apiGateOwner"),
        ),
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        reason: "global-retry-after",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }

    const chatId = resolveDestination(desired.destination);
    if (!normalizeString(chatId)) {
      const result = {
        code: "missing-destination",
        description: `Telegram destination ${desired.destination} is not configured`,
      };
      await finishStatus({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs,
      });
      logFailure(normalizedMessageKey, "terminal", result);
      return { status: "terminal", reason: result.code };
    }

    if (desired.operation === "delete") {
      if (
        typeof applied.messageId !== "number" ||
        !Number.isInteger(applied.messageId) ||
        applied.messageId <= 0
      ) {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
          clearApplied: true,
        });
        return { status: "delivered" };
      }
      return runDelete({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId: normalizeString(applied.chatId) || chatId,
        messageId: applied.messageId,
        nowMs,
        currentDelivery: record.delivery,
        requestedGeneration,
        apiGateReclaimOwner,
      });
    }

    if (
      typeof applied.messageId !== "number" ||
      !Number.isInteger(applied.messageId) ||
      applied.messageId <= 0
    ) {
      if (desired.operation === "edit" && desired.ifMissing === "skip") {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
          clearApplied: true,
        });
        return { status: "delivered", reason: "missing-skipped" };
      }
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: null,
        nowMs,
        requestedGeneration,
      });
    }

    const appliedTargetMismatch =
      normalizeString(applied.instanceKey) !== desired.instanceKey ||
      normalizeString(applied.destination) !== desired.destination ||
      (normalizeString(applied.chatId) &&
        normalizeString(applied.chatId) !== chatId);
    if (appliedTargetMismatch) {
      if (desired.operation === "edit" && desired.ifMissing === "skip") {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs);
        return { status: "delivered", reason: "missing-skipped" };
      }
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: applied,
        nowMs,
        requestedGeneration,
      });
    }

    if (
      applied.contentHash === desired.contentHash &&
      !readProperty(record.delivery, "appliedStateUnknown")
    ) {
      await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
        applied: {
          ...applied,
          revision: desired.revision,
          appliedAtMs: nowMs,
        },
      });
      return { status: "delivered", reason: "already-current" };
    }

    const expired = await finishExpiredOwnedRetryWindow({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      currentDelivery: record.delivery,
    });
    if (expired) {
      return expired;
    }
    const gateIdentity = await prepareDesiredApiGateIdentity({
      messageKey: normalizedMessageKey,
      ownerToken,
      revision: desired.revision,
      requestedGeneration,
      apiGateReclaimOwner,
    });
    const apiGateOwner = gateIdentity.owner;
    const gateResult = await acquireApiGate({
      messageKey: normalizedMessageKey,
      revision: desired.revision,
      operation: "edit",
      owner: apiGateOwner,
      reclaimOwner: gateIdentity.reclaimOwner,
      taskGeneration: gateIdentity.generation,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        currentDelivery: gateIdentity.delivery,
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const editCallAtMs = now();
    if (
      resolveRetryDeadlineAtMs(gateIdentity.delivery) > 0 &&
      resolveRetryDeadlineAtMs(gateIdentity.delivery) <= editCallAtMs
    ) {
      const result = { code: "safe-retry-window-exhausted" };
      await finishStatusAndSettleApiGate({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs: editCallAtMs,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "terminal", reason: result.code };
    }
    await markAppliedStateUnknown({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      operation: "edit",
      apiGateOwner,
    });
    const editResult = await client.editTelegramMessage({
      chatId: normalizeString(applied.chatId) || chatId,
      messageId: applied.messageId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    });
    if (editResult.ok) {
      await finishStatusAndSettleApiGate({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "delivered",
        nowMs,
        applied: {
          ...applied,
          destination: desired.destination,
          chatId: normalizeString(applied.chatId) || chatId,
          instanceKey: desired.instanceKey,
          revision: desired.revision,
          contentHash: desired.contentHash,
          appliedAtMs: nowMs,
        },
        clearAppliedStateUnknown: true,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "delivered" };
    }
    if (editResult.classification === "missing") {
      if (desired.ifMissing === "skip") {
        await finishStatusAndSettleApiGate({
          messageKey: normalizedMessageKey,
          ownerToken,
          desired,
          status: "delivered",
          nowMs,
          clearApplied: true,
          clearAppliedStateUnknown: true,
          apiGateSettleOwner: apiGateOwner,
        });
        return { status: "delivered", reason: "missing-skipped" };
      }
      ensureCommitted(
        await updateOwned(
          normalizedMessageKey,
          ownerToken,
          (record, delivery) => {
            const nextRecord: RawRecord = {
              ...record,
              delivery: {
                ...omitKeys(delivery, [
                  "apiGateOwner",
                  "apiGateGeneration",
                  "apiGateStartedAtMs",
                  "appliedStateUnknown",
                ]),
                apiGateSettleOwner: apiGateOwner,
              },
            };
            delete nextRecord.applied;
            return nextRecord;
          },
        ),
        "missing-edit-transition-not-persisted",
      );
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: apiGateOwner,
      });
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: null,
        nowMs,
        requestedGeneration,
      });
    }
    if (editResult.classification === "retryable") {
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: editResult,
        currentDelivery: gateIdentity.delivery,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await finishStatusAndSettleApiGate({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      status: "terminal",
      result: editResult,
      nowMs,
      apiGateSettleOwner: apiGateOwner,
    });
    logFailure(normalizedMessageKey, "terminal", editResult);
    return { status: "terminal", reason: editResult.code };
  };

  const orphanPendingDelete = async ({
    messageKey,
    pendingDeleteId,
    result,
    nowMs,
    ownerToken = "",
    apiGateSettleOwner = "",
  }: {
    messageKey: string;
    pendingDeleteId: string;
    result: TelegramRetryFailure;
    nowMs: number;
    ownerToken?: string;
    apiGateSettleOwner?: unknown;
  }) =>
    ensureCommitted(
      await transact(messageKey, (record) => {
        const delivery = asObject(record.delivery);
        const pendingDelete = asObject(delivery.pendingDelete);
        if (
          normalizeString(pendingDelete.pendingDeleteId) !== pendingDeleteId ||
          (ownerToken &&
            normalizeString(pendingDelete.leaseOwner) !== ownerToken)
        ) {
          return { commit: false, decision: "pending-delete-lost" };
        }
        const orphanedDeletes = asObject(delivery.orphanedDeletes);
        const nextDelivery = promotePendingDeleteQueue({
          ...omitKeys(delivery, ["pendingDelete"]),
          orphanedDeletes: {
            ...orphanedDeletes,
            [pendingDeleteId]: {
              ...omitRetryState(
                omitKeys(pendingDelete, [
                  "leaseOwner",
                  "leaseExpiresAtMs",
                  "status",
                ]),
              ),
              terminalAtMs: nowMs,
              lastError: buildErrorState(result, nowMs),
            },
          },
        });
        return {
          value: {
            ...record,
            delivery: {
              ...nextDelivery,
              ...(normalizeString(apiGateSettleOwner)
                ? { pendingDeleteApiGateSettleOwner: apiGateSettleOwner }
                : {}),
            },
          },
          decision: "pending-delete-orphaned",
        };
      }),
      "pending-delete-orphan-finalization-failed",
    );

  const finishPendingDeleteRetryable = async ({
    messageKey,
    revision,
    pendingDelete,
    pendingDeleteId,
    ownerToken,
    result,
    apiGateOwner = "",
    preserveApiGateIdentity = false,
    persistBeforeSchedule = false,
  }: {
    messageKey: string;
    revision: string;
    pendingDelete: unknown;
    pendingDeleteId: string;
    ownerToken: string;
    result: TelegramRetryFailure;
    apiGateOwner?: string;
    preserveApiGateIdentity?: boolean;
    persistBeforeSchedule?: boolean;
  }) => {
    return retryCoordinator.finish({
      current: pendingDelete,
      failure: result,
      target: { kind: TELEGRAM_PENDING_DELETE_TASK_KIND, pendingDeleteId },
      messageKey,
      revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        ensureCommitted(
          await transact(messageKey, (record) => {
            const delivery = asObject(record.delivery);
            const latestPendingDelete = asObject(delivery.pendingDelete);
            if (
              normalizeString(latestPendingDelete.pendingDeleteId) !==
                pendingDeleteId ||
              normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
            ) {
              return { commit: false, decision: "pending-delete-lost" };
            }
            return {
              value: {
                ...record,
                delivery: {
                  ...delivery,
                  pendingDelete: {
                    ...latestPendingDelete,
                    apiGateProofRequired: {
                      owner: apiGateOwner,
                      retryNotBeforeMs: barrierRetryNotBeforeMs,
                      revision,
                      proofTaskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
                      pendingDeleteId,
                      retryProofLeaseOwner: ownerToken,
                      ...retryState,
                    },
                  },
                },
              },
              decision: "pending-rate-limit-proof-required",
            };
          }),
          "pending-rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await transact(messageKey, (record) => {
          const delivery = asObject(record.delivery);
          const latestPendingDelete = asObject(delivery.pendingDelete);
          if (
            normalizeString(latestPendingDelete.pendingDeleteId) !==
              pendingDeleteId ||
            normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
          ) {
            return { commit: false, decision: "pending-delete-lost" };
          }
          return {
            value: {
              ...record,
              delivery: {
                ...delivery,
                pendingDelete: {
                  ...omitRetryState(
                    omitKeys(latestPendingDelete, [
                      "leaseOwner",
                      "leaseExpiresAtMs",
                      "lastError",
                      ...(preserveApiGateIdentity
                        ? []
                        : [
                            "apiGateOwner",
                            "apiGateGeneration",
                            "apiGateStartedAtMs",
                            "apiGateProofRequired",
                          ]),
                    ]),
                  ),
                  status: "retryable",
                  ...retryState,
                  lastError: buildErrorState(result, finalizedAtMs),
                },
              },
            },
            decision: "pending-delete-retryable",
          };
        });
        if (!finalization.committed) {
          const current = asObject(await repository.getMessage(messageKey));
          const currentPendingDelete = asObject(
            readProperty(current.delivery, "pendingDelete"),
          );
          const proofAlreadyApplied =
            rateLimited &&
            normalizeRetrySequence(currentPendingDelete.retrySequence) >=
              retryState.retrySequence &&
            normalizeString(
              readProperty(currentPendingDelete.apiGateProofRequired, "owner"),
            ) !== normalizeString(apiGateOwner);
          if (!proofAlreadyApplied) {
            ensureCommitted(
              finalization,
              "pending-delete-retryable-finalization-failed",
            );
          }
        }
      },
    });
  };

  const applyPendingDeleteRetryWindowProof = async (
    messageKey: string,
    {
      pendingDeleteId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    }: ProofInput,
  ) => {
    const normalizedPendingDeleteId = normalizeString(pendingDeleteId);
    const proofRetryState = {
      retryStartedAtMs: normalizeTimestamp(retryStartedAtMs),
      retryDeadlineAtMs: normalizeTimestamp(retryDeadlineAtMs),
      retryAtMs: normalizeTimestamp(retryAtMs),
      retrySequence: normalizeRetrySequence(retrySequence),
    };
    if (
      !normalizedPendingDeleteId ||
      !proofRetryState.retryStartedAtMs ||
      !proofRetryState.retryDeadlineAtMs ||
      !proofRetryState.retryAtMs
    ) {
      return { applied: false };
    }
    let applied = false;
    const result = await transact(messageKey, (record) => {
      const delivery = asObject(record.delivery);
      const pendingDelete = asObject(delivery.pendingDelete);
      if (
        resolvePendingDeleteId(pendingDelete) !== normalizedPendingDeleteId ||
        pendingDelete.status !== "processing" ||
        !normalizeString(retryProofLeaseOwner) ||
        normalizeString(pendingDelete.leaseOwner) !==
          normalizeString(retryProofLeaseOwner) ||
        proofRetryState.retrySequence <=
          normalizeRetrySequence(pendingDelete.retrySequence)
      ) {
        return {
          commit: false,
          decision: "stale-pending-delete-retry-window-proof",
        };
      }
      applied = true;
      const preservesApiGate =
        normalizeString(apiGateReclaimOwner) !== "" &&
        normalizeString(pendingDelete.apiGateOwner) ===
          normalizeString(apiGateReclaimOwner);
      return {
        value: {
          ...record,
          delivery: {
            ...delivery,
            pendingDelete: {
              ...omitKeys(pendingDelete, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "lastError",
                ...(preservesApiGate
                  ? []
                  : [
                      "apiGateOwner",
                      "apiGateGeneration",
                      "apiGateStartedAtMs",
                      "apiGateProofRequired",
                    ]),
              ]),
              pendingDeleteId: normalizedPendingDeleteId,
              status: "retryable",
              ...proofRetryState,
              retryWindowRecoveredAtMs: now(),
            },
          },
        },
        decision: "pending-delete-retry-window-proof-applied",
      };
    });
    return { applied: applied && result.committed };
  };

  const reconcilePendingDelete = async ({
    messageKey,
    requestedRevision = "",
    requestedPendingDeleteId = "",
    requestedGeneration = "",
    retryStartedAtMs = 0,
    retryDeadlineAtMs = 0,
    retryAtMs = 0,
    retrySequence = 0,
    retryProofLeaseOwner = "",
    apiGateReclaimOwner = "",
  }: TelegramReconcileInput & {
    requestedPendingDeleteId?: string;
  }): Promise<TelegramEngineResult> => {
    const normalizedMessageKey = validateTelegramMessageKey(messageKey);
    await applyPendingDeleteRetryWindowProof(normalizedMessageKey, {
      pendingDeleteId: requestedPendingDeleteId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    });
    const nowMs = now();
    const ownerToken = createOwnerToken();
    let decision = "missing";
    const acquired = await transact(normalizedMessageKey, (record) => {
      const delivery = asObject(record.delivery);
      const pendingDelete = asObject(delivery.pendingDelete);
      if (delivery.status === "uncertain" || delivery.sendInFlight) {
        decision = "blocked-uncertain";
        return { commit: false, decision };
      }
      const chatId = normalizeString(pendingDelete.chatId);
      const messageId = Number(pendingDelete.messageId);
      if (Object.keys(pendingDelete).length === 0) {
        decision = "missing";
        return { commit: false, decision };
      }
      const pendingDeleteId = resolvePendingDeleteId(pendingDelete);
      if (
        requestedPendingDeleteId &&
        requestedPendingDeleteId !== pendingDeleteId
      ) {
        decision = "stale";
        return { commit: false, decision };
      }
      const currentApiGateOwner = normalizeString(pendingDelete.apiGateOwner);
      const currentProofGateOwner = normalizeString(
        readProperty(pendingDelete.apiGateProofRequired, "owner"),
      );
      if (
        currentApiGateOwner &&
        currentApiGateOwner === currentProofGateOwner
      ) {
        decision = "rate-limit-proof-pending";
        return { commit: false, decision };
      }
      if (!chatId || !Number.isInteger(messageId) || messageId <= 0) {
        decision = "invalid";
        const apiGateOwner = normalizeString(pendingDelete.apiGateOwner);
        const proofGateOwner = normalizeString(
          readProperty(pendingDelete.apiGateProofRequired, "owner"),
        );
        const shouldSettleApiGate =
          apiGateOwner && apiGateOwner !== proofGateOwner;
        const nextDelivery = promotePendingDeleteQueue({
          ...omitKeys(delivery, ["pendingDelete"]),
          orphanedDeletes: {
            ...asObject(delivery.orphanedDeletes),
            [pendingDeleteId]: {
              ...pendingDelete,
              pendingDeleteId,
              terminalAtMs: nowMs,
              lastError: {
                code: "invalid-pending-delete",
                atMs: nowMs,
              },
            },
          },
        });
        return {
          value: {
            ...record,
            delivery: {
              ...nextDelivery,
              ...(shouldSettleApiGate
                ? { pendingDeleteApiGateSettleOwner: apiGateOwner }
                : {}),
            },
          },
          decision,
        };
      }
      const retryDeadlineAtMs = resolveRetryDeadlineAtMs(pendingDelete);
      const leaseExpiresAtMs = normalizeTimestamp(
        pendingDelete.leaseExpiresAtMs,
      );
      if (
        pendingDelete.status === "processing" &&
        normalizeString(pendingDelete.leaseOwner) !== ownerToken &&
        leaseExpiresAtMs > nowMs
      ) {
        decision = "locked";
        return { commit: false, decision };
      }
      if (
        ["pending", "processing", "retryable"].includes(
          pendingDelete.status as string,
        ) &&
        retryDeadlineAtMs > 0 &&
        retryDeadlineAtMs <= nowMs
      ) {
        decision = "exhausted";
        const apiGateOwner = normalizeString(pendingDelete.apiGateOwner);
        const proofGateOwner = normalizeString(
          readProperty(pendingDelete.apiGateProofRequired, "owner"),
        );
        const shouldSettleApiGate =
          apiGateOwner && apiGateOwner !== proofGateOwner;
        const nextDelivery = promotePendingDeleteQueue({
          ...omitKeys(delivery, ["pendingDelete"]),
          orphanedDeletes: {
            ...asObject(delivery.orphanedDeletes),
            [pendingDeleteId]: {
              ...omitRetryState(pendingDelete),
              pendingDeleteId,
              terminalAtMs: nowMs,
              lastError: {
                code: "safe-retry-window-exhausted",
                atMs: nowMs,
              },
            },
          },
        });
        return {
          value: {
            ...record,
            delivery: {
              ...nextDelivery,
              ...(shouldSettleApiGate
                ? { pendingDeleteApiGateSettleOwner: apiGateOwner }
                : {}),
            },
          },
          decision,
        };
      }
      if (
        pendingDelete.status === "retryable" &&
        normalizeTimestamp(pendingDelete.retryAtMs) > nowMs
      ) {
        decision = "deferred";
        return { commit: false, decision };
      }
      decision = "acquired";
      const apiGateGeneration =
        normalizeString(pendingDelete.apiGateGeneration) ||
        normalizeString(requestedGeneration) ||
        `direct:${pendingDeleteId}`;
      return {
        value: {
          ...record,
          delivery: {
            ...delivery,
            pendingDelete: {
              ...pendingDelete,
              pendingDeleteId,
              status: "processing",
              attempts: normalizeAttempts(pendingDelete.attempts) + 1,
              leaseOwner: ownerToken,
              leaseExpiresAtMs: nowMs + leaseTtlMs,
              startedAtMs: nowMs,
              apiGateOwner:
                normalizeString(pendingDelete.apiGateOwner) ||
                buildApiGateOwner(
                  normalizedMessageKey,
                  "pending-delete",
                  pendingDeleteId,
                  apiGateGeneration,
                ),
              apiGateGeneration,
              apiGateStartedAtMs:
                normalizeTimestamp(pendingDelete.apiGateStartedAtMs) || nowMs,
            },
          },
        },
        decision,
      };
    });
    if (decision === "missing" || decision === "stale") {
      return { status: "settled", cleanup: decision };
    }
    if (decision === "blocked-uncertain") {
      return { status: "uncertain", cleanup: decision };
    }
    if (decision === "rate-limit-proof-pending") {
      const proof = asObject(
        readProperty(
          readProperty(acquired.value?.delivery, "pendingDelete"),
          "apiGateProofRequired",
        ),
      );
      const proofRetryState = {
        retryStartedAtMs: normalizeTimestamp(proof.retryStartedAtMs),
        retryDeadlineAtMs: normalizeTimestamp(proof.retryDeadlineAtMs),
        retryAtMs: normalizeTimestamp(proof.retryAtMs),
        retrySequence: normalizeRetrySequence(proof.retrySequence),
      };
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(proof.revision) || requestedRevision || "latest",
        taskKind: TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
        retryState: proofRetryState,
        pendingDeleteId:
          normalizeString(proof.pendingDeleteId) || requestedPendingDeleteId,
        retryProofLeaseOwner: normalizeString(proof.retryProofLeaseOwner),
        proofTaskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
        barrierProofOwner: proof.owner,
        barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        scheduleTimeMs: nowMs,
      });
      let barrierProof = { applied: false };
      try {
        barrierProof = await applyRateLimitBarrierProof({
          barrierProofOwner: proof.owner,
          barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        });
      } catch (_error) {
        barrierProof = { applied: false };
      }
      if (barrierProof.applied) {
        await applyPendingDeleteRetryWindowProof(normalizedMessageKey, {
          pendingDeleteId:
            normalizeString(proof.pendingDeleteId) || requestedPendingDeleteId,
          retryProofLeaseOwner: proof.retryProofLeaseOwner,
          ...proofRetryState,
        });
        await clearAppliedRateLimitProofMarker(
          normalizedMessageKey,
          proof.owner,
        );
      }
      return {
        status: "retryable",
        cleanup: decision,
        retryAtMs: normalizeTimestamp(proof.retryNotBeforeMs),
        scheduled: true,
      };
    }
    if (decision === "invalid" || decision === "exhausted") {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: readProperty(
          acquired.value?.delivery,
          "pendingDeleteApiGateSettleOwner",
        ),
      });
      return { status: "settled", cleanup: decision };
    }
    if (decision === "deferred" || decision === "locked") {
      const pendingDelete = asObject(
        readProperty(acquired.value?.delivery, "pendingDelete"),
      );
      const lockedGateOwner = normalizeString(pendingDelete.apiGateOwner);
      const lockedGateGeneration = normalizeString(
        pendingDelete.apiGateGeneration,
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        (normalizeString(apiGateReclaimOwner) === lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration === normalizeString(requestedGeneration)));
      const retryAtMs =
        decision === "deferred"
          ? normalizeTimestamp(pendingDelete.retryAtMs)
          : normalizeTimestamp(pendingDelete.leaseExpiresAtMs) || nowMs + 1000;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
          requestedRevision ||
          "latest",
        taskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
        retryState: {
          retryStartedAtMs: pendingDelete.retryStartedAtMs || retryStartedAtMs,
          retryDeadlineAtMs:
            pendingDelete.retryDeadlineAtMs || retryDeadlineAtMs,
          retryAtMs,
          retrySequence: pendingDelete.retrySequence ?? retrySequence,
        },
        pendingDeleteId: resolvePendingDeleteId(pendingDelete),
        sourceGeneration: requestedGeneration,
        apiGateReclaimOwner: mayReclaimLockedGate ? lockedGateOwner : "",
      });
      return { status: "retryable", retryAtMs, scheduled: true };
    }
    if (decision !== "acquired") {
      return { status: "settled", cleanup: "missing" };
    }
    const pendingDelete = asObject(
      readProperty(acquired.value?.delivery, "pendingDelete"),
    );
    const pendingDeleteId = normalizeString(pendingDelete.pendingDeleteId);
    const callAtMs = now();
    if (
      resolveRetryDeadlineAtMs(pendingDelete) > 0 &&
      resolveRetryDeadlineAtMs(pendingDelete) <= callAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: callAtMs,
        ownerToken,
        apiGateSettleOwner: pendingDelete.apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: pendingDelete.apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    const retryNotBeforeMs = Math.max(
      await repository.getRetryNotBeforeMs(),
      localRetryBarrier.getRetryNotBeforeMs(),
    );
    const barrierCheckedAtMs = now();
    if (
      resolveRetryDeadlineAtMs(pendingDelete) > 0 &&
      resolveRetryDeadlineAtMs(pendingDelete) <= barrierCheckedAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: barrierCheckedAtMs,
        ownerToken,
        apiGateSettleOwner: pendingDelete.apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: pendingDelete.apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    if (retryNotBeforeMs > barrierCheckedAtMs) {
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result: {
          code: "global-retry-after",
          retryAfterSeconds: Math.max(
            0,
            (retryNotBeforeMs - barrierCheckedAtMs) / 1000,
          ),
        },
        preserveApiGateIdentity: Boolean(pendingDelete.apiGateOwner),
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const apiGateOwner = normalizeString(pendingDelete.apiGateOwner);
    const pendingGateGeneration = normalizeString(
      pendingDelete.apiGateGeneration,
    );
    const proofRequiredOwner = normalizeString(
      readProperty(pendingDelete.apiGateProofRequired, "owner"),
    );
    const mayReclaimApiGate =
      apiGateOwner !== "" && proofRequiredOwner !== apiGateOwner;
    const gateResult = await acquireApiGate({
      messageKey: normalizedMessageKey,
      revision:
        normalizeString(readProperty(acquired.value?.desired, "revision")) ||
        requestedRevision ||
        "latest",
      operation: "pending-delete",
      owner: apiGateOwner,
      pendingDeleteId,
      reclaimOwner: mayReclaimApiGate ? apiGateOwner : "",
      taskGeneration: pendingGateGeneration,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const deleteCallAtMs = now();
    if (
      resolveRetryDeadlineAtMs(pendingDelete) > 0 &&
      resolveRetryDeadlineAtMs(pendingDelete) <= deleteCallAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: deleteCallAtMs,
        ownerToken,
        apiGateSettleOwner: apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    const result = await client.deleteTelegramMessage({
      chatId: pendingDelete.chatId,
      messageId: pendingDelete.messageId,
    });
    if (result.ok) {
      ensureCommitted(
        await transact(normalizedMessageKey, (record) => {
          const delivery = asObject(record.delivery);
          const latestPendingDelete = asObject(delivery.pendingDelete);
          if (
            normalizeString(latestPendingDelete.pendingDeleteId) !==
              pendingDeleteId ||
            normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
          ) {
            return { commit: false, decision: "pending-delete-lost" };
          }
          return {
            value: {
              ...record,
              delivery: {
                ...promotePendingDeleteQueue(delivery),
                pendingDeleteApiGateSettleOwner: apiGateOwner,
              },
            },
            decision: "pending-delete-cleared",
          };
        }),
        "pending-delete-finalization-failed",
      );
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: apiGateOwner,
      });
      return { status: "settled", cleanup: "deleted" };
    }
    if (result.classification === "retryable") {
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          normalizeString(readProperty(acquired.value?.desired, "revision")) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await orphanPendingDelete({
      messageKey: normalizedMessageKey,
      pendingDeleteId,
      result,
      nowMs: now(),
      ownerToken,
      apiGateSettleOwner: apiGateOwner,
    });
    await settlePersistedApiGate({
      messageKey: normalizedMessageKey,
      field: "pendingDeleteApiGateSettleOwner",
      owner: apiGateOwner,
    });
    return { status: "settled", cleanup: "orphaned" };
  };

  const reconcile = async (
    input: TelegramReconcileInput = { messageKey: "" },
  ): Promise<TelegramEngineResult> => {
    let effectiveInput = input;
    if (input.taskKind === TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND) {
      const proofTaskKind = normalizeString(input.proofTaskKind);
      if (
        proofTaskKind !== TELEGRAM_DESIRED_TASK_KIND &&
        proofTaskKind !== TELEGRAM_PENDING_DELETE_TASK_KIND
      ) {
        return { status: "skipped", reason: "invalid-rate-limit-proof" };
      }
      const barrierProof = await applyRateLimitBarrierProof({
        barrierProofOwner: input.barrierProofOwner,
        barrierRetryNotBeforeMs: input.barrierRetryNotBeforeMs,
      });
      if (!barrierProof.applied) {
        if (normalizeString(barrierProof.gate?.owner)) {
          return { status: "settled", reason: "stale-rate-limit-proof" };
        }
        const error = Object.assign(new Error("rate-limit-proof-not-applied"), {
          code: "rate-limit-proof-not-applied",
          retryable: true,
        });
        throw error;
      }
      await clearAppliedRateLimitProofMarker(
        input.messageKey,
        input.barrierProofOwner,
      );
      effectiveInput = { ...input, taskKind: proofTaskKind };
    }
    const desiredResult = await reconcileDesired(effectiveInput);
    if (
      desiredResult.status === "uncertain" ||
      desiredResult.status === "retryable" ||
      desiredResult.status === "skipped"
    ) {
      return desiredResult;
    }
    const record = asObject(
      await repository.getMessage(effectiveInput.messageKey),
    );
    const pendingDelete = asObject(
      readProperty(record.delivery, "pendingDelete"),
    );
    if (Object.keys(pendingDelete).length === 0) {
      return desiredResult;
    }
    const pendingDeleteId = resolvePendingDeleteId(pendingDelete);
    if (effectiveInput.taskKind !== TELEGRAM_PENDING_DELETE_TASK_KIND) {
      await scheduleExactRetry({
        messageKey: effectiveInput.messageKey,
        revision:
          normalizeString(readProperty(record.desired, "revision")) ||
          normalizeString(effectiveInput.requestedRevision) ||
          "latest",
        taskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
        retryState: {
          retryAtMs: now(),
          retrySequence: normalizeRetrySequence(pendingDelete.retrySequence),
        },
        pendingDeleteId,
        sourceGeneration: effectiveInput.requestedGeneration,
      });
      return { ...desiredResult, cleanupScheduled: true };
    }
    const cleanupResult = await reconcilePendingDelete({
      messageKey: effectiveInput.messageKey,
      requestedRevision: effectiveInput.requestedRevision,
      requestedPendingDeleteId: effectiveInput.pendingDeleteId,
      requestedGeneration: effectiveInput.requestedGeneration,
      retryStartedAtMs: effectiveInput.retryStartedAtMs,
      retryDeadlineAtMs: effectiveInput.retryDeadlineAtMs,
      retryAtMs: effectiveInput.retryAtMs,
      retrySequence: effectiveInput.retrySequence,
      retryProofLeaseOwner: effectiveInput.retryProofLeaseOwner,
      apiGateReclaimOwner: effectiveInput.apiGateReclaimOwner,
    });
    let cleanupScheduled = false;
    if (cleanupResult.status === "settled") {
      const refreshed = asObject(
        await repository.getMessage(effectiveInput.messageKey),
      );
      const nextPendingDelete = asObject(
        readProperty(refreshed.delivery, "pendingDelete"),
      );
      if (Object.keys(nextPendingDelete).length > 0) {
        const nextPendingDeleteId = resolvePendingDeleteId(nextPendingDelete);
        await scheduleExactRetry({
          messageKey: effectiveInput.messageKey,
          revision:
            normalizeString(readProperty(refreshed.desired, "revision")) ||
            normalizeString(effectiveInput.requestedRevision) ||
            "latest",
          taskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
          retryState: {
            retryAtMs: now(),
            retrySequence: normalizeRetrySequence(
              nextPendingDelete.retrySequence,
            ),
          },
          pendingDeleteId: nextPendingDeleteId,
          sourceGeneration: effectiveInput.requestedGeneration,
        });
        cleanupScheduled = true;
      }
    }
    return {
      ...desiredResult,
      cleanup: cleanupResult,
      ...(cleanupScheduled ? { cleanupScheduled: true } : {}),
    };
  };

  return { reconcile };
};

export {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_LEASE_TTL_MS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
  TELEGRAM_SAFE_RETRY_MAX_DELAY_MS,
  TELEGRAM_SAFE_RETRY_WINDOW_MS,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  createTelegramLocalRetryBarrier,
  createTelegramDeliveryEngine,
  resolveTelegramDestination,
  validateTelegramMessageKey,
};
