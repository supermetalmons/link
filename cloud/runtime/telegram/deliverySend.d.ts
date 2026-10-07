// Generated from src/telegram/deliverySend.ts. Run npm run generate:runtime.
import type { TelegramClient } from "./client.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import {
  type DesiredContext,
  type DesiredSendOperations,
  type RawRecord,
} from "./deliveryState.js";
export declare function createTelegramSendDelivery({
  client,
  now,
  createAttemptId,
  control,
  operations,
}: {
  client: TelegramClient;
  now: () => number;
  createAttemptId: () => string;
  control: Pick<
    TelegramDeliveryControl,
    | "updateOwned"
    | "acquireApiGate"
    | "buildGateBlockedFailure"
    | "settlePersistedApiGate"
    | "logFailure"
  >;
  operations: DesiredSendOperations;
}): {
  runSend: ({
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
  }) => Promise<
    | {
        status: string;
        reason: string;
      }
    | {
        status: string;
        retryAtMs?: undefined;
        scheduled?: undefined;
        messageId?: undefined;
      }
    | {
        status: string;
        retryAtMs: number;
        scheduled: boolean;
        messageId?: undefined;
      }
    | {
        status: string;
        messageId: number | undefined;
        retryAtMs?: undefined;
        scheduled?: undefined;
      }
  >;
};
