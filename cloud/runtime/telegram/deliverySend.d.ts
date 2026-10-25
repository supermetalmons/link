// Generated from src/telegram/deliverySend.ts. Run npm run generate:runtime.
import type { TextDesiredView } from "./desiredRecords.js";
import { type TelegramAppliedDocument } from "./records.js";
import type { TelegramClient } from "./client.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import {
  type DesiredContext,
  type DesiredSendOperations,
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
    desired: TextDesiredView;
    chatId: string;
    previousApplied: TelegramAppliedDocument | null;
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
        messageId: number;
        retryAtMs?: undefined;
        scheduled?: undefined;
      }
  >;
};
