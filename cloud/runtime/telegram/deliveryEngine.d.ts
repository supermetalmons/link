import type { TelegramClient } from "./client.js";
import type { TelegramTaskKind } from "./taskIdentity.js";

export type TelegramRepository = {
  getMessage(messageKey: string): Promise<unknown>;
  transactMessage(
    messageKey: string,
    updater: (current: unknown) => unknown,
  ): Promise<Record<string, unknown>>;
  getRetryNotBeforeMs(): Promise<number>;
  extendRetryNotBeforeMs(candidateMs: number): Promise<number>;
  acquireApiGate(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  releaseApiGate(owner: string): Promise<boolean>;
  extendRetryBarrierAndReleaseApiGate(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

export type TelegramRetryScheduler = (
  input: Record<string, unknown> & { scheduleTimeMs?: number },
) => Promise<Record<string, unknown>>;

export type TelegramEngineResult = {
  status: string;
  reason?: string;
  retryAtMs?: number;
  scheduled?: boolean;
  cleanup?: unknown;
  cleanupScheduled?: boolean;
};

export function createTelegramLocalRetryBarrier(
  initialRetryNotBeforeMs?: number,
): {
  getRetryNotBeforeMs(): number;
  extendRetryNotBeforeMs(candidateMs: number): number;
};

export function resolveTelegramDestination(
  destination: string,
  environment?: Record<string, string | undefined>,
): string;

export function createTelegramDeliveryEngine(input: {
  repository: TelegramRepository;
  client: TelegramClient;
  resolveDestination?: (destination: string) => string;
  now?: () => number;
  createOwnerToken?: () => string;
  createAttemptId?: () => string;
  scheduleRetry: TelegramRetryScheduler;
  logger?: Pick<Console, "error" | "info">;
  leaseTtlMs?: number;
  localRetryBarrier: ReturnType<typeof createTelegramLocalRetryBarrier>;
}): {
  reconcile(input: {
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
  }): Promise<TelegramEngineResult>;
};
