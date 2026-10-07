// Generated from src/telegram/deliveryTypes.ts. Run npm run generate:runtime.
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
