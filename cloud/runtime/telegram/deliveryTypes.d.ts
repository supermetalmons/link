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
import type { TelegramTaskKind, TelegramTaskPayload } from "./taskIdentity.js";
import type { RetainedTelegramRetrySchedule } from "./retryRecords.js";
import type {
  TelegramApiGateDocument,
  TelegramApiGateWrite,
  TelegramMessageDocument,
} from "./records.js";
export type TelegramApiGateResult = {
  acquired: boolean;
  reason: string;
  retryNotBeforeMs: number;
  gate: TelegramApiGateDocument;
};
export type TelegramRetrySchedule = TelegramTaskPayload & {
  scheduleTimeMs?: number;
};
export type TelegramRetryScheduleResult = {
  scheduled: boolean;
  taskId?: string;
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
  getMessage(messageKey: string): Promise<TelegramMessageDocument | null>;
  transactMessage(
    messageKey: string,
    updater: (
      current: TelegramMessageDocument | null,
    ) => TransactionDecision<TelegramMessageDocument>,
  ): Promise<TransactionResult<TelegramMessageDocument>>;
  getRetryNotBeforeMs(): Promise<number>;
  extendRetryNotBeforeMs(candidateMs: number): Promise<number>;
  acquireApiGate(
    input: TelegramApiGateWrite & {
      reclaimOwner?: string;
    },
  ): Promise<TelegramApiGateResult>;
  releaseApiGate(owner: string): Promise<boolean>;
  extendRetryBarrierAndReleaseApiGate(
    input: TelegramBarrierProof,
  ): Promise<TelegramBarrierProofResult>;
};
export type TelegramRetryScheduler = (
  input: TelegramRetrySchedule | RetainedTelegramRetrySchedule,
) => Promise<TelegramRetryScheduleResult>;
export type TelegramEngineResult = {
  status: string;
  reason?: string;
  retryAtMs?: number | null;
  scheduled?: boolean;
  cleanup?: TelegramCleanupResult | TelegramCleanupOutcome;
  cleanupScheduled?: boolean;
};
export type TelegramCleanupOutcome =
  | "missing"
  | "stale"
  | "blocked-uncertain"
  | "invalid"
  | "rate-limit-proof-pending"
  | "locked"
  | "exhausted"
  | "deferred"
  | "acquired"
  | "deleted"
  | "orphaned";
export type TelegramCleanupResult = Omit<
  TelegramEngineResult,
  "cleanup" | "cleanupScheduled"
> & {
  cleanup?: TelegramCleanupOutcome;
};
