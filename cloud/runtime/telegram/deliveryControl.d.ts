// Generated from src/telegram/deliveryControl.ts. Run npm run generate:runtime.
import {
  type TelegramBarrierInput,
  type RetainedTelegramBarrierInput,
  type RetainedTelegramOwner,
} from "./retryRecords.js";
import type {
  TelegramBarrierProofResult,
  TelegramLocalRetryBarrier,
  TelegramRetryFailure,
} from "./deliveryRetryTypes.js";
import {
  type ExactRetryInput,
  type MessageMutation,
  type OwnedMutation,
} from "./deliveryState.js";
import type {
  TelegramApiGateResult,
  TelegramRepository,
  TelegramRetryScheduler,
} from "./deliveryTypes.js";
import type { TelegramApiOperation } from "./records.js";
export declare function createTelegramDeliveryControl({
  repository,
  logger,
  now,
  scheduleRetry,
  localRetryBarrier,
}: {
  repository: TelegramRepository;
  logger: Pick<Console, "error" | "info">;
  now: () => number;
  scheduleRetry: TelegramRetryScheduler;
  localRetryBarrier: TelegramLocalRetryBarrier;
}): {
  logFailure: (
    messageKey: string,
    status: string,
    error: TelegramRetryFailure,
  ) => void;
  transact: (
    messageKey: string,
    updater: MessageMutation,
  ) => Promise<
    import("../transactions.js").TransactionResult<
      import("./records.js").TelegramMessageDocument
    >
  >;
  scheduleExactRetry: (
    input: ExactRetryInput,
  ) => Promise<import("./deliveryTypes.js").TelegramRetryScheduleResult>;
  retryCoordinator: {
    finish(
      input: import("./deliveryRetryTypes.js").TelegramRetryInput,
    ): Promise<import("./deliveryRetryTypes.js").TelegramRetryResult>;
  };
  applyRateLimitBarrierProof: (
    input: TelegramBarrierInput | RetainedTelegramBarrierInput,
  ) => Promise<
    Partial<TelegramBarrierProofResult> & {
      applied: boolean;
    }
  >;
  clearAppliedRateLimitProofMarker: (
    messageKey: string,
    ownerInput: string | RetainedTelegramOwner | undefined,
  ) => Promise<void>;
  acquireApiGate: ({
    messageKey,
    revision,
    operation,
    owner,
    attemptId,
    pendingDeleteId,
    reclaimOwner,
    taskGeneration,
  }: {
    messageKey: string;
    revision: string;
    operation: TelegramApiOperation;
    owner: string;
    attemptId?: string;
    pendingDeleteId?: string;
    reclaimOwner?: string;
    taskGeneration?: string;
  }) => Promise<TelegramApiGateResult>;
  buildGateBlockedFailure: (
    gateResult: TelegramApiGateResult,
    checkedAtMs: number,
  ) => TelegramRetryFailure;
  updateOwned: (
    messageKey: string,
    ownerToken: string,
    updater: OwnedMutation,
  ) => Promise<
    import("../transactions.js").TransactionResult<
      import("./records.js").TelegramMessageDocument
    >
  >;
  prepareDesiredApiGateIdentity: ({
    messageKey,
    ownerToken,
    revision,
    requestedGeneration,
  }: {
    messageKey: string;
    ownerToken: string;
    revision: string;
    requestedGeneration?: string;
    apiGateReclaimOwner?: string;
  }) => Promise<{
    owner: string;
    generation: string;
    reclaimOwner: string;
    delivery: import("./deliveryState.js").DeliverySnapshot;
  }>;
  settlePersistedApiGate: ({
    messageKey,
    field,
    owner: ownerInput,
  }: {
    messageKey: string;
    field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner";
    owner: string | RetainedTelegramOwner | undefined;
  }) => Promise<
    | import("../transactions.js").TransactionResult<
        import("./records.js").TelegramMessageDocument
      >
    | null
  >;
};
export type TelegramDeliveryControl = ReturnType<
  typeof createTelegramDeliveryControl
>;
