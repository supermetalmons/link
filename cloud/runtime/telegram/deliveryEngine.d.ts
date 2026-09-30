// Generated from src/telegram/deliveryEngine.ts. Run npm run generate:runtime.
import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";
import type { TelegramClient } from "./client.js";
import type {
  TelegramBarrierProof,
  TelegramBarrierProofResult,
  TelegramLocalRetryBarrier,
} from "./deliveryRetryTypes.js";
import type { TelegramTaskKind } from "./taskIdentity.js";
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
  createTelegramLocalRetryBarrier,
} from "./deliveryPolicy.js";
import { TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND } from "./taskKinds.js";
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
declare const TELEGRAM_LEASE_TTL_MS = 60000;
declare const createTelegramDeliveryEngine: (input: TelegramEngineOptions) => {
  reconcile(input: TelegramReconcileInput): Promise<TelegramEngineResult>;
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
