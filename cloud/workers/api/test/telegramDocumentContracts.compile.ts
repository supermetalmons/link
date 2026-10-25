import type * as Client from "../../../runtime/telegram/client.js";
import type * as Records from "../../../runtime/telegram/records.js";
import type * as Desired from "../../../runtime/telegram/desiredStateCore.js";
import type * as Views from "../../../runtime/telegram/desiredRecords.js";
import type {
  DeliverySnapshot,
  PendingDeleteSnapshot,
} from "../../../runtime/telegram/deliveryState.js";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryTypes.js";

import type * as EventProjectionRecords from "../../../runtime/telegram/eventProjectionRecords.js";
import type * as EventProjection from "../../../runtime/telegram/eventProjectionCore.js";
import type * as MessageProjection from "../../../runtime/telegram/messageProjectionRecords.js";
import type * as Announcements from "../src/telegramAnnouncementRecords.ts";
import type * as TelegramD1 from "../src/telegramD1.ts";
import type * as Commands from "../src/telegramCommandRecords.ts";
import type * as AutomatchProjection from "../../../runtime/telegram/projectionCore.js";
import type { RetainedAutomatchValue } from "../../../runtime/automatchRecords.js";
import type * as RetryRecords from "../../../runtime/telegram/retryRecords.js";
import type * as RetryTypes from "../../../runtime/telegram/deliveryRetryTypes.js";
import type * as DeliveryTypes from "../../../runtime/telegram/deliveryTypes.js";
import type { TelegramDeliveryControl } from "../../../runtime/telegram/deliveryControl.js";
import type { TelegramDeliveryRecovery } from "../../../runtime/telegram/deliveryRecovery.js";
import type * as DeliveryState from "../../../runtime/telegram/deliveryState.js";
import type * as DesiredOperations from "../../../runtime/telegram/deliveryDesiredRecords.js";

import type { EventStore } from "../src/eventStoreContracts.ts";
import type { EventCommand } from "../../../runtime/eventCommands.js";
import type { TelegramStorage } from "../../../runtime/telegram/repositoryCore.js";
type Assert<T extends true> = T;
type Rejects<A, B> = A extends B ? false : true;
type HasIndex<T> = string extends keyof T ? true : false;
type GuardedEvent = typeof EventProjection.isV2TelegramEvent extends (
  value: unknown,
) => value is infer V
  ? V
  : never;
type AttemptFields = Pick<
  TelegramD1.TelegramAnnouncementAttempt,
  | "eventId"
  | "startAtMs"
  | "runAtMs"
  | "firstQueuedAtMs"
  | "attemptId"
  | "expectedAttemptId"
>;

export type TelegramDocumentAndProviderContracts = [
  Assert<Rejects<Record<string, unknown>, Records.TelegramMessageDocument>>,
  Assert<
    HasIndex<Records.TelegramMessageDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramRetryProofDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramMessageDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramMessageDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramMessageDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramMessageDocument, Records.TelegramRetryDocument>
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramControlDocument>>,
  Assert<
    HasIndex<Records.TelegramControlDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramRetryProofDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramControlDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramControlDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramControlDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramControlDocument, Records.TelegramRetryDocument>
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramDesiredDocument>>,
  Assert<
    HasIndex<Records.TelegramDesiredDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramRetryProofDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramDesiredDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramDesiredDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramDesiredDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramDesiredDocument, Records.TelegramRetryDocument>
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramDeliveryDocument>>,
  Assert<
    HasIndex<Records.TelegramDeliveryDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<
      Records.TelegramDeliveryDocument,
      Records.TelegramRetryProofDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramDeliveryDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramDeliveryDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramDeliveryDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramDeliveryDocument, Records.TelegramRetryDocument>
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramCleanupDocument>>,
  Assert<
    HasIndex<Records.TelegramCleanupDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramRetryProofDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramCleanupDocument, Records.TelegramRetryDocument>
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramAppliedDocument>>,
  Assert<
    HasIndex<Records.TelegramAppliedDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramRetryProofDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramAppliedDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramAppliedDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramAppliedDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramAppliedDocument, Records.TelegramRetryDocument>
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramRecoveryDocument>>,
  Assert<
    HasIndex<Records.TelegramRecoveryDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryDocument,
      Records.TelegramRetryProofDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramRecoveryDocument, Records.TelegramRetryDocument>
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramApiGateDocument>>,
  Assert<
    HasIndex<Records.TelegramApiGateDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramRetryProofDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramApiGateDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramApiGateDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramApiGateDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramApiGateDocument, Records.TelegramRetryDocument>
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramSendEvidence>>,
  Assert<HasIndex<Records.TelegramSendEvidence> extends false ? true : false>,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramRetryProofDocument>
  >,
  Assert<
    Rejects<Records.TelegramSendEvidence, Records.TelegramCleanupQueueDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramSendEvidence,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramSendEvidence,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<Rejects<Records.TelegramSendEvidence, Records.TelegramRetryDocument>>,
  Assert<Rejects<Record<string, unknown>, Records.TelegramRetryProofDocument>>,
  Assert<
    HasIndex<Records.TelegramRetryProofDocument> extends false ? true : false
  >,
  Assert<
    Rejects<Records.TelegramRetryProofDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryProofDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryProofDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramRetryProofDocument,
      Records.TelegramDeliveryDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramRetryProofDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryProofDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramRetryProofDocument,
      Records.TelegramRecoveryDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramRetryProofDocument, Records.TelegramApiGateDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryProofDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<
      Records.TelegramRetryProofDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRetryProofDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRetryProofDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramRetryProofDocument, Records.TelegramRetryDocument>
  >,
  Assert<
    Rejects<Record<string, unknown>, Records.TelegramCleanupQueueDocument>
  >,
  Assert<
    HasIndex<Records.TelegramCleanupQueueDocument> extends false ? true : false
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramControlDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramDesiredDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramDeliveryDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramCleanupDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramAppliedDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramRecoveryDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramApiGateDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramCleanupQueueDocument, Records.TelegramSendEvidence>
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramRetryProofDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupQueueDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<Records.TelegramCleanupQueueDocument, Records.TelegramRetryDocument>
  >,
  Assert<
    Rejects<Record<string, unknown>, Records.TelegramOrphanedDeletesDocument>
  >,
  Assert<
    HasIndex<Records.TelegramOrphanedDeletesDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramControlDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramDesiredDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramDeliveryDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramCleanupDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramAppliedDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramRecoveryDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramApiGateDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramSendEvidence
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramRetryProofDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramOrphanedDeletesDocument,
      Records.TelegramRetryDocument
    >
  >,
  Assert<
    Rejects<Record<string, unknown>, Records.TelegramRecoveryResultDocument>
  >,
  Assert<
    HasIndex<Records.TelegramRecoveryResultDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramControlDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramDesiredDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramDeliveryDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramCleanupDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramAppliedDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramRecoveryDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramApiGateDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramSendEvidence
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramRetryProofDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramCleanupQueueDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRecoveryResultDocument,
      Records.TelegramRetryDocument
    >
  >,
  Assert<Rejects<Record<string, unknown>, Records.TelegramRetryDocument>>,
  Assert<HasIndex<Records.TelegramRetryDocument> extends false ? true : false>,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramMessageDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramControlDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramDesiredDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramDeliveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramCleanupDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramAppliedDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramRecoveryDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramApiGateDocument>
  >,
  Assert<Rejects<Records.TelegramRetryDocument, Records.TelegramSendEvidence>>,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramRetryProofDocument>
  >,
  Assert<
    Rejects<Records.TelegramRetryDocument, Records.TelegramCleanupQueueDocument>
  >,
  Assert<
    Rejects<
      Records.TelegramRetryDocument,
      Records.TelegramOrphanedDeletesDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramRetryDocument,
      Records.TelegramRecoveryResultDocument
    >
  >,
  Assert<HasIndex<Client.TelegramSendInput> extends false ? true : false>,
  Assert<Rejects<Record<string, unknown>, Client.TelegramSendInput>>,
  Assert<Rejects<Record<string, unknown>, Client.RetainedTelegramSendInput>>,
  Assert<
    Rejects<Client.RetainedTelegramSendInput, Client.RetainedTelegramEditInput>
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramSendInput,
      Client.RetainedTelegramDeleteInput
    >
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramSendInput,
      Client.RetainedTelegramMediaGroupInput
    >
  >,
  Assert<HasIndex<Client.TelegramEditInput> extends false ? true : false>,
  Assert<Rejects<Record<string, unknown>, Client.TelegramEditInput>>,
  Assert<Rejects<Record<string, unknown>, Client.RetainedTelegramEditInput>>,
  Assert<
    Rejects<Client.RetainedTelegramEditInput, Client.RetainedTelegramSendInput>
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramEditInput,
      Client.RetainedTelegramDeleteInput
    >
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramEditInput,
      Client.RetainedTelegramMediaGroupInput
    >
  >,
  Assert<HasIndex<Client.TelegramDeleteInput> extends false ? true : false>,
  Assert<Rejects<Record<string, unknown>, Client.TelegramDeleteInput>>,
  Assert<Rejects<Record<string, unknown>, Client.RetainedTelegramDeleteInput>>,
  Assert<
    Rejects<
      Client.RetainedTelegramDeleteInput,
      Client.RetainedTelegramSendInput
    >
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramDeleteInput,
      Client.RetainedTelegramEditInput
    >
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramDeleteInput,
      Client.RetainedTelegramMediaGroupInput
    >
  >,
  Assert<HasIndex<Client.TelegramMediaGroupInput> extends false ? true : false>,
  Assert<Rejects<Record<string, unknown>, Client.TelegramMediaGroupInput>>,
  Assert<
    Rejects<Record<string, unknown>, Client.RetainedTelegramMediaGroupInput>
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramMediaGroupInput,
      Client.RetainedTelegramSendInput
    >
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramMediaGroupInput,
      Client.RetainedTelegramEditInput
    >
  >,
  Assert<
    Rejects<
      Client.RetainedTelegramMediaGroupInput,
      Client.RetainedTelegramDeleteInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramSendInput, "text"> & { text: number },
      Client.TelegramSendInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramSendInput, "chatId"> & { chatId: {} },
      Client.TelegramSendInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramSendInput, "silent"> & { silent: string },
      Client.TelegramSendInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramSendInput, "disableWebPagePreview"> & {
        disableWebPagePreview: string;
      },
      Client.TelegramSendInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramSendInput, "token"> & { token: number },
      Client.TelegramSendInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramSendInput, "timeoutMs"> & { timeoutMs: string },
      Client.TelegramSendInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramEditInput, "messageId"> & { messageId: string },
      Client.TelegramEditInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramDeleteInput, "messageId"> & { messageId: string },
      Client.TelegramDeleteInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramMediaGroupInput, "imageUrls"> & {
        imageUrls: unknown[];
      },
      Client.TelegramMediaGroupInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramMediaGroupInput, "hasSpoiler"> & {
        hasSpoiler: string;
      },
      Client.TelegramMediaGroupInput
    >
  >,
  Assert<Rejects<Client.TelegramSendSuccess, Client.TelegramEditResult>>,
  Assert<Rejects<Client.TelegramSendSuccess, Client.TelegramDeleteResult>>,
  Assert<Rejects<Client.TelegramSendSuccess, Client.TelegramMediaGroupResult>>,
  Assert<Rejects<Client.TelegramEditSuccess, Client.TelegramSendResult>>,
  Assert<Rejects<Client.TelegramEditSuccess, Client.TelegramDeleteResult>>,
  Assert<Rejects<Client.TelegramEditSuccess, Client.TelegramMediaGroupResult>>,
  Assert<Rejects<Client.TelegramDeleteSuccess, Client.TelegramSendResult>>,
  Assert<Rejects<Client.TelegramDeleteSuccess, Client.TelegramEditResult>>,
  Assert<
    Rejects<Client.TelegramDeleteSuccess, Client.TelegramMediaGroupResult>
  >,
  Assert<Rejects<Client.TelegramMediaGroupSuccess, Client.TelegramSendResult>>,
  Assert<Rejects<Client.TelegramMediaGroupSuccess, Client.TelegramEditResult>>,
  Assert<
    Rejects<Client.TelegramMediaGroupSuccess, Client.TelegramDeleteResult>
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramSendSuccess, "messageId">,
      Client.TelegramSendResult
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramMediaGroupSuccess, "messageIds">,
      Client.TelegramMediaGroupResult
    >
  >,
  Assert<
    Rejects<
      { requestId: string; action: "confirm-send-applied" },
      Records.TelegramManualRecoveryWrite
    >
  >,
  Assert<
    Rejects<
      { requestId: string; action: "confirm-send-absent"; messageId: number },
      Records.TelegramManualRecoveryWrite
    >
  >,
  Assert<
    Rejects<
      { requestId: string; action: "abandon"; messageId: number },
      Records.TelegramManualRecoveryWrite
    >
  >,
  Assert<
    Rejects<
      { requestId: string; action: "other" },
      Records.TelegramManualRecoveryWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Records.TelegramAppliedReceiptWrite, "messageId"> & {
        messageId: string;
      },
      Records.TelegramAppliedReceiptWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Records.TelegramApiGateWrite, "operation"> & { operation: "other" },
      Records.TelegramApiGateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<Records.TelegramRetryProofWrite, "retryAtMs"> & {
        retryAtMs: string;
      },
      Records.TelegramRetryProofWrite
    >
  >,
  Assert<
    Rejects<Omit<Desired.TelegramSendDesired, "text">, Desired.TelegramDesired>
  >,
  Assert<
    Rejects<
      Omit<Desired.TelegramSendDesired, "instanceKey">,
      Desired.TelegramDesired
    >
  >,
  Assert<
    Rejects<
      Omit<Desired.TelegramSendDesired, "contentHash">,
      Desired.TelegramDesired
    >
  >,
  Assert<
    Rejects<Omit<Desired.TelegramEditDesired, "text">, Desired.TelegramDesired>
  >,
  Assert<
    Rejects<
      Omit<Desired.TelegramEditDesired, "instanceKey">,
      Desired.TelegramDesired
    >
  >,
  Assert<
    Rejects<
      Omit<Desired.TelegramEditDesired, "contentHash">,
      Desired.TelegramDesired
    >
  >,
  Assert<
    Rejects<
      Omit<Desired.TelegramEditDesired, "ifMissing">,
      Desired.TelegramDesired
    >
  >,
  Assert<
    Rejects<
      Omit<Desired.TelegramSendDesired, "schemaVersion"> & { schemaVersion: 1 },
      Desired.TelegramDesired
    >
  >,
  Assert<
    Rejects<
      {
        destination: string;
        instanceKey: string;
        text: string;
        sourceRevision: string;
        ifMissing: null;
      },
      Desired.TelegramEditDesiredInput
    >
  >,
  Assert<"source" extends keyof DeliverySnapshot ? false : true>,
  Assert<"source" extends keyof PendingDeleteSnapshot ? false : true>,
  Assert<
    HasIndex<
      NonNullable<
        Parameters<Parameters<TelegramRepository["transactMessage"]>[1]>[0]
      >
    > extends false
      ? true
      : false
  >,
  Assert<Rejects<Desired.TelegramDesired, Views.RetainedDesiredView>>,
  Assert<Rejects<Views.RetainedDesiredView, Desired.TelegramDesired>>,
];

export type EventProjectionContracts = [
  Assert<
    Rejects<
      Record<string, unknown>,
      EventProjectionRecords.EventTelegramProjectionStateDocument
    >
  >,
  Assert<
    HasIndex<EventProjectionRecords.EventTelegramProjectionStateDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      EventProjectionRecords.EventTelegramProjectionStateDocument,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramMessageDocument,
      EventProjectionRecords.EventTelegramProjectionStateDocument
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      EventProjectionRecords.RetainedStartedMatchLines
    >
  >,
  Assert<
    HasIndex<EventProjectionRecords.RetainedStartedMatchLines> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      EventProjectionRecords.RetainedStartedMatchLines,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    Rejects<
      Records.TelegramMessageDocument,
      EventProjectionRecords.RetainedStartedMatchLines
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "schemaVersion"
      > & { schemaVersion: number },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "upcomingText"
      > & { upcomingText: number },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "reminderText"
      > & { reminderText: null },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "startedText"
      > & { startedText: {} },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "endedText"
      > & { endedText: boolean },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "endedAnnouncementArmed"
      > & { endedAnnouncementArmed: string },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "startedMatchKeys"
      > & { startedMatchKeys: unknown[] },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "startedMatchLinesByKey"
      > & { startedMatchLinesByKey: Record<string, unknown> },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "lastProjectedSignature"
      > & { lastProjectedSignature: {} },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "updatedAtMs"
      > & { updatedAtMs: string },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "eventTelegramProjectionGuard"
      > & { eventTelegramProjectionGuard: {} },
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "schemaVersion"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "upcomingText"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "reminderText"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "startedText"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "endedText"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "endedAnnouncementArmed"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "startedMatchKeys"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "startedMatchLinesByKey"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "lastProjectedSignature"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionStateWrite,
        "updatedAtMs"
      >,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Rejects<
      EventProjectionRecords.EventTelegramProjectionStateWrite,
      EventProjectionRecords.EventTelegramProjectionStateDocument
    >
  >,
  Assert<
    HasIndex<EventProjectionRecords.EventTelegramProjectionStateWrite> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Omit<EventProjectionRecords.EventTelegramProjectionGuard, "eventId">,
      EventProjectionRecords.EventTelegramProjectionGuard
    >
  >,
  Assert<
    Rejects<
      Omit<EventProjectionRecords.EventTelegramProjectionGuard, "lockId">,
      EventProjectionRecords.EventTelegramProjectionGuard
    >
  >,
  Assert<
    Rejects<
      Omit<EventProjectionRecords.EventTelegramProjectionGuard, "lockRoot">,
      EventProjectionRecords.EventTelegramProjectionGuard
    >
  >,
  Assert<
    Rejects<
      Omit<EventProjectionRecords.EventTelegramProjectionGuard, "ownerUid">,
      EventProjectionRecords.EventTelegramProjectionGuard
    >
  >,
  Assert<
    Rejects<
      Omit<
        EventProjectionRecords.EventTelegramProjectionGuard,
        "generation"
      > & { generation: string },
      EventProjectionRecords.EventTelegramProjectionGuard
    >
  >,
  Assert<Rejects<"endedText", EventProjectionRecords.EventTelegramTextField>>,
  Assert<
    Rejects<
      { operation: "send"; ifMissing: "skip" } & Pick<
        EventProjection.EventTelegramProjectionOperation,
        "channel" | "instanceKey" | "messageKey" | "sourceRevision" | "text"
      >,
      EventProjection.EventTelegramProjectionOperation
    >
  >,
  Assert<
    Rejects<
      { operation: "edit"; ifMissing: null } & Pick<
        EventProjection.EventTelegramProjectionOperation,
        "channel" | "instanceKey" | "messageKey" | "sourceRevision" | "text"
      >,
      EventProjection.EventTelegramProjectionOperation
    >
  >,
  Assert<
    Rejects<
      {
        action: "project";
        operations: [];
        signature: string;
        state: Record<string, unknown>;
      },
      EventProjection.EventTelegramProjection
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<
        Parameters<typeof MessageProjection.replaceTelegramDesired>[0]
      >
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<
        Parameters<typeof MessageProjection.projectAutomatchMessage>[0]
      >
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<Parameters<typeof MessageProjection.adoptTelegramReminder>[0]>
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<Parameters<typeof MessageProjection.projectEventMessage>[0]>
    >
  >,
  Assert<
    Rejects<
      Desired.TelegramSendDesired,
      Parameters<typeof MessageProjection.adoptTelegramReminder>[1]
    >
  >,
  Assert<
    Rejects<{}, Parameters<typeof MessageProjection.adoptTelegramReminder>[3]>
  >,
  Assert<
    Rejects<
      { messageId: string; appliedAtMs: number },
      Parameters<typeof MessageProjection.adoptTelegramReminder>[3]
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<Parameters<typeof MessageProjection.projectEventMessage>[3]>
    >
  >,
];

export type AnnouncementContracts = [
  Assert<HasIndex<GuardedEvent> extends false ? true : false>,
  Assert<Rejects<Record<string, unknown>, GuardedEvent>>,
  Assert<
    HasIndex<Announcements.TelegramAnnouncementPayloadDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Announcements.TelegramAnnouncementPayloadDocument
    >
  >,
  Assert<
    Rejects<
      Announcements.TelegramAnnouncementPayloadDocument,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    HasIndex<Announcements.RetainedTelegramAnnouncementAttempt> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Announcements.RetainedTelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      Announcements.RetainedTelegramAnnouncementAttempt,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    Rejects<
      Announcements.TelegramAlbumPayload,
      Announcements.TelegramReminderPayload
    >
  >,
  Assert<
    Rejects<
      Announcements.TelegramReminderPayload,
      Announcements.TelegramAlbumPayload
    >
  >,
  Assert<
    Rejects<
      AttemptFields & {
        kind: "reminder";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      AttemptFields & {
        kind: "prizes";
        payload: Announcements.TelegramReminderPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      AttemptFields & { payload: Announcements.TelegramReminderPayload },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      AttemptFields & {
        kind: "other";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramAlbumPayload, "chatId"> & { chatId: number },
      Announcements.TelegramAlbumPayload
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramAlbumPayload, "imageUrls"> & {
        imageUrls: unknown[];
      },
      Announcements.TelegramAlbumPayload
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramAlbumPayload, "hasSpoiler"> & {
        hasSpoiler: boolean;
      },
      Announcements.TelegramAlbumPayload
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramAlbumPayload, "parseMode"> & {
        parseMode: string;
      },
      Announcements.TelegramAlbumPayload
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramAlbumPayload, "silent"> & { silent: true },
      Announcements.TelegramAlbumPayload
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramReminderPayload, "imageUrls"> & {
        imageUrls: string[];
      },
      Announcements.TelegramReminderPayload
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramReminderPayload, "hasSpoiler"> & {
        hasSpoiler: true;
      },
      Announcements.TelegramReminderPayload
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramReminderPayload, "text"> & { text: unknown },
      Announcements.TelegramReminderPayload
    >
  >,
  Assert<
    Rejects<
      Omit<AttemptFields, "eventId"> & {
        kind: "prizes";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      Omit<AttemptFields, "startAtMs"> & {
        kind: "prizes";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      Omit<AttemptFields, "runAtMs"> & {
        kind: "prizes";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      Omit<AttemptFields, "firstQueuedAtMs"> & {
        kind: "prizes";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      Omit<AttemptFields, "attemptId"> & {
        kind: "prizes";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Rejects<
      Omit<AttemptFields, "expectedAttemptId"> & {
        kind: "prizes";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<Rejects<"sending", Announcements.TelegramAnnouncementOutcomeStatus>>,
  Assert<Rejects<string, Announcements.TelegramAnnouncementOutcomeStatus>>,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<TelegramD1.TelegramAnnouncementRecord["payload"]>
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Parameters<typeof Commands.requestTelegramRecovery>[0]
    >
  >,
  Assert<
    Rejects<
      { requestId: string; action: "confirm-send-applied" },
      Parameters<typeof Commands.requestTelegramRecovery>[1]
    >
  >,
  Assert<
    Rejects<
      { requestId: string; action: "abandon"; messageId: number },
      Parameters<typeof Commands.requestTelegramRecovery>[1]
    >
  >,
  Assert<
    Rejects<
      { action: "confirm-send-applied" },
      Parameters<typeof Commands.previewTelegramRecovery>[1]
    >
  >,
  Assert<
    HasIndex<Commands.TelegramRecoveryStatus> extends false ? true : false
  >,
];

export type ProjectionSourceContracts = [
  Assert<
    HasIndex<EventProjectionRecords.EventTelegramEndedResultsDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      EventProjectionRecords.EventTelegramEndedResultsDocument
    >
  >,
  Assert<
    Rejects<
      EventProjectionRecords.EventTelegramProjectionStateDocument,
      EventProjectionRecords.EventTelegramEndedResultsDocument
    >
  >,
  Assert<
    Rejects<
      EventProjectionRecords.EventTelegramEndedResultsDocument,
      EventProjectionRecords.EventTelegramProjectionStateDocument
    >
  >,
  Assert<
    Awaited<
      ReturnType<typeof EventProjection.loadEndedMatchResults>
    > extends EventProjectionRecords.EventTelegramEndedResultsDocument
      ? true
      : false
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<
        Parameters<
          typeof EventProjection.buildEventTelegramProjection
        >[0]["endedMatchResults"]
      >
    >
  >,
  Assert<"asObject" extends keyof typeof AutomatchProjection ? false : true>,
  Assert<
    HasIndex<AutomatchProjection.AutomatchTelegramSourceDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      AutomatchProjection.AutomatchTelegramSourceDocument
    >
  >,
  Assert<
    AutomatchProjection.AutomatchTelegramSourceDocument extends RetainedAutomatchValue<"telegramAutomatches">
      ? true
      : false
  >,
  Assert<
    Rejects<
      RetainedAutomatchValue<"telegramProjectionOutbox/automatch">,
      AutomatchProjection.AutomatchTelegramSourceDocument
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<AutomatchProjection.RatingProjectionMerge["source"]>
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      NonNullable<
        Parameters<
          typeof AutomatchProjection.buildAutomatchTelegramProjection
        >[0]["source"]
      >
    >
  >,
  Assert<
    HasIndex<AutomatchProjection.TelegramRatingProjectionInput> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      Omit<
        AutomatchProjection.TelegramRatingProjectionInput,
        "completedAtMs"
      > & { completedAtMs: string },
      AutomatchProjection.TelegramRatingProjectionInput
    >
  >,
];

export type RetryContracts = [
  Assert<
    Rejects<
      Record<string, unknown>,
      RetryRecords.RetainedTelegramExactRetryInput
    >
  >,
  Assert<
    HasIndex<RetryRecords.RetainedTelegramExactRetryInput> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramExactRetryInput,
      RetryRecords.RetainedTelegramRetrySchedule
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramExactRetryInput,
      RetryRecords.RetainedTelegramProofInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramExactRetryInput,
      RetryRecords.TelegramProofApplicationDocument
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramExactRetryInput,
      RetryRecords.RetainedTelegramBarrierInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramExactRetryInput,
      RetryRecords.RetainedTelegramOwner
    >
  >,
  Assert<
    Rejects<Record<string, unknown>, RetryRecords.RetainedTelegramRetrySchedule>
  >,
  Assert<
    HasIndex<RetryRecords.RetainedTelegramRetrySchedule> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramRetrySchedule,
      RetryRecords.RetainedTelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramRetrySchedule,
      RetryRecords.RetainedTelegramProofInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramRetrySchedule,
      RetryRecords.TelegramProofApplicationDocument
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramRetrySchedule,
      RetryRecords.RetainedTelegramBarrierInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramRetrySchedule,
      RetryRecords.RetainedTelegramOwner
    >
  >,
  Assert<
    Rejects<Record<string, unknown>, RetryRecords.RetainedTelegramProofInput>
  >,
  Assert<
    HasIndex<RetryRecords.RetainedTelegramProofInput> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramProofInput,
      RetryRecords.RetainedTelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramProofInput,
      RetryRecords.RetainedTelegramRetrySchedule
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramProofInput,
      RetryRecords.TelegramProofApplicationDocument
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramProofInput,
      RetryRecords.RetainedTelegramBarrierInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramProofInput,
      RetryRecords.RetainedTelegramOwner
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      RetryRecords.TelegramProofApplicationDocument
    >
  >,
  Assert<
    HasIndex<RetryRecords.TelegramProofApplicationDocument> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      RetryRecords.TelegramProofApplicationDocument,
      RetryRecords.RetainedTelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.TelegramProofApplicationDocument,
      RetryRecords.RetainedTelegramRetrySchedule
    >
  >,
  Assert<
    Rejects<
      RetryRecords.TelegramProofApplicationDocument,
      RetryRecords.RetainedTelegramProofInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.TelegramProofApplicationDocument,
      RetryRecords.RetainedTelegramBarrierInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.TelegramProofApplicationDocument,
      RetryRecords.RetainedTelegramOwner
    >
  >,
  Assert<
    Rejects<Record<string, unknown>, RetryRecords.RetainedTelegramBarrierInput>
  >,
  Assert<
    HasIndex<RetryRecords.RetainedTelegramBarrierInput> extends false
      ? true
      : false
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramBarrierInput,
      RetryRecords.RetainedTelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramBarrierInput,
      RetryRecords.RetainedTelegramRetrySchedule
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramBarrierInput,
      RetryRecords.RetainedTelegramProofInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramBarrierInput,
      RetryRecords.TelegramProofApplicationDocument
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramBarrierInput,
      RetryRecords.RetainedTelegramOwner
    >
  >,
  Assert<Rejects<Record<string, unknown>, RetryRecords.RetainedTelegramOwner>>,
  Assert<
    HasIndex<RetryRecords.RetainedTelegramOwner> extends false ? true : false
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramOwner,
      RetryRecords.RetainedTelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramOwner,
      RetryRecords.RetainedTelegramRetrySchedule
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramOwner,
      RetryRecords.RetainedTelegramProofInput
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramOwner,
      RetryRecords.TelegramProofApplicationDocument
    >
  >,
  Assert<
    Rejects<
      RetryRecords.RetainedTelegramOwner,
      RetryRecords.RetainedTelegramBarrierInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "taskKind"> & {
        taskKind: "other";
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "safeRejectedAttemptId"> & {
        safeRejectedAttemptId: number;
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "pendingDeleteId"> & {
        pendingDeleteId: {};
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "retryProofLeaseOwner"> & {
        retryProofLeaseOwner: boolean;
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "sourceGeneration"> & {
        sourceGeneration: number;
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "proofTaskKind"> & {
        proofTaskKind: "other";
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "barrierProofOwner"> & {
        barrierProofOwner: number;
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "barrierRetryNotBeforeMs"> & {
        barrierRetryNotBeforeMs: string;
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "scheduleTimeMs"> & {
        scheduleTimeMs: string;
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "apiGateReclaimOwner"> & {
        apiGateReclaimOwner: boolean;
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      Omit<RetryTypes.TelegramExactRetryInput, "apiGateSettleOwner"> & {
        apiGateSettleOwner: number;
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Rejects<
      { retryAtMs: number },
      RetryTypes.TelegramExactRetryInput["retryState"]
    >
  >,
  Assert<
    Rejects<
      { retryAtMs: string; retrySequence: number },
      RetryTypes.TelegramExactRetryInput["retryState"]
    >
  >,
  Assert<
    Rejects<{ requestedRevision: number }, RetryRecords.TelegramProofInput>
  >,
  Assert<Rejects<{ pendingDeleteId: {} }, RetryRecords.TelegramProofInput>>,
  Assert<Rejects<{ retryAtMs: string }, RetryRecords.TelegramProofInput>>,
  Assert<Rejects<{ retrySequence: string }, RetryRecords.TelegramProofInput>>,
  Assert<
    Rejects<{ retryProofLeaseOwner: boolean }, RetryRecords.TelegramProofInput>
  >,
  Assert<Rejects<{ apiGateReclaimOwner: {} }, RetryRecords.TelegramProofInput>>,
  Assert<
    Rejects<{ barrierProofOwner: number }, RetryRecords.TelegramBarrierInput>
  >,
  Assert<
    Rejects<
      { barrierRetryNotBeforeMs: string },
      RetryRecords.TelegramBarrierInput
    >
  >,
  Assert<
    Rejects<
      Omit<DeliveryTypes.TelegramRetrySchedule, "taskKind"> & {
        taskKind: "other";
      },
      DeliveryTypes.TelegramRetrySchedule
    >
  >,
  Assert<
    Rejects<
      Omit<DeliveryTypes.TelegramRetrySchedule, "retryAtMs"> & {
        retryAtMs: string;
      },
      DeliveryTypes.TelegramRetrySchedule
    >
  >,
  Assert<
    Rejects<Record<string, unknown>, DeliveryTypes.TelegramRetryScheduleResult>
  >,
  Assert<
    Rejects<{ scheduled: string }, DeliveryTypes.TelegramRetryScheduleResult>
  >,
  Assert<
    Rejects<unknown, NonNullable<DeliveryTypes.TelegramEngineResult["cleanup"]>>
  >,
  Assert<Rejects<string, DeliveryTypes.TelegramCleanupOutcome>>,
  Assert<
    Rejects<
      Record<string, unknown>,
      Parameters<TelegramDeliveryControl["scheduleExactRetry"]>[0]
    >
  >,
  Assert<
    Rejects<
      { barrierProofOwner: 42 },
      Parameters<TelegramDeliveryControl["applyRateLimitBarrierProof"]>[0]
    >
  >,
  Assert<
    Rejects<
      number,
      Parameters<TelegramDeliveryControl["clearAppliedRateLimitProofMarker"]>[1]
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Parameters<TelegramDeliveryRecovery["resumeRateLimitProof"]>[0]["proof"]
    >
  >,
  Assert<
    Rejects<
      { retryAtMs: string },
      Parameters<TelegramDeliveryRecovery["applySafeRetryProof"]>[1]
    >
  >,
];

export type DeliveryRetryContracts = [
  Assert<
    Rejects<Record<string, unknown>, RetryTypes.TelegramRetryInput["current"]>
  >,
  Assert<
    Rejects<
      Records.TelegramMessageDocument,
      RetryTypes.TelegramRetryInput["current"]
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      DeliveryState.DesiredRetryInput["currentDelivery"]
    >
  >,
  Assert<
    Rejects<
      Records.TelegramCleanupDocument,
      DeliveryState.DesiredRetryInput["currentDelivery"]
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Parameters<
        DeliveryState.DesiredSendOperations["finishExpiredOwnedRetryWindow"]
      >[0]["currentDelivery"]
    >
  >,
  Assert<
    Rejects<
      Record<string, unknown>,
      Parameters<typeof DeliveryState.retryDocument>[0]
    >
  >,
  Assert<
    Rejects<
      string,
      Parameters<
        typeof DesiredOperations.markAppliedStateUnknownRecord
      >[2]["operation"]
    >
  >,
  Assert<
    Awaited<
      ReturnType<RetryTypes.TelegramRetryDependencies["scheduleExactRetry"]>
    > extends DeliveryTypes.TelegramRetryScheduleResult
      ? true
      : false
  >,
];

type Accepts<Value, Contract> = Value extends Contract ? true : false;

type CompleteEventProjectionState = {
  schemaVersion: 2;
  upcomingText: string;
  reminderText: string;
  startedText: string;
  endedText: string;
  endedAnnouncementArmed: boolean;
  startedMatchKeys: string[];
  startedMatchLinesByKey: Record<string, string>;
  lastProjectedSignature: string;
  updatedAtMs: number;
};

export type ValidTelegramBoundaryContracts = [
  Assert<Accepts<{ chatId: string; text: string }, Client.TelegramSendInput>>,
  Assert<
    Accepts<
      { chatId: string; text: string; messageId: number },
      Client.TelegramEditInput
    >
  >,
  Assert<
    Accepts<{ chatId: number; messageId: number }, Client.TelegramDeleteInput>
  >,
  Assert<
    Accepts<
      { chatId: string; text: string; imageUrls: string[]; hasSpoiler: true },
      Client.TelegramMediaGroupInput
    >
  >,
  Assert<
    Accepts<
      { ok: true; outcome: "sent"; messageId: number; httpStatus: number },
      Client.TelegramSendResult
    >
  >,
  Assert<
    Accepts<
      { ok: true; outcome: "edited"; httpStatus: number },
      Client.TelegramEditResult
    >
  >,
  Assert<
    Accepts<
      { ok: true; outcome: "deleted"; httpStatus: number },
      Client.TelegramDeleteResult
    >
  >,
  Assert<
    Accepts<
      { ok: true; outcome: "sent"; messageIds: number[]; httpStatus: number },
      Client.TelegramMediaGroupResult
    >
  >,
  Assert<
    Accepts<
      {
        destination: "community";
        instanceKey: string;
        text: string;
        sourceRevision: string;
      },
      Desired.TelegramSendDesiredInput
    >
  >,
  Assert<
    Accepts<
      {
        destination: "community";
        instanceKey: string;
        text: string;
        sourceRevision: number;
        ifMissing: "skip";
      },
      Desired.TelegramEditDesiredInput
    >
  >,
  Assert<
    Accepts<
      { destination: "events"; sourceRevision: string },
      Desired.TelegramDeleteDesiredInput
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Desired.buildTelegramSendDesired>,
      Desired.TelegramSendDesired
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Desired.buildTelegramEditDesired>,
      Desired.TelegramEditDesired
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof Desired.buildTelegramDeleteDesired>,
      Desired.TelegramDeleteDesired
    >
  >,
  Assert<
    Accepts<
      NonNullable<ReturnType<typeof Records.readTelegramMessageDocument>>,
      NonNullable<Awaited<ReturnType<TelegramRepository["getMessage"]>>>
    >
  >,
  Assert<
    Accepts<
      NonNullable<ReturnType<typeof Records.readTelegramControlDocument>>,
      NonNullable<Awaited<ReturnType<TelegramStorage["readControl"]>>>
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof TelegramD1.createD1TelegramRepository>,
      TelegramRepository
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof MessageProjection.replaceTelegramDesired>,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    Accepts<
      CompleteEventProjectionState,
      EventProjectionRecords.EventTelegramProjectionStateWrite
    >
  >,
  Assert<
    Accepts<
      EventProjectionRecords.EventTelegramProjectionStateDocument,
      NonNullable<
        Awaited<ReturnType<EventStore["readEventTelegramProjectionState"]>>
      >["state"]
    >
  >,
  Assert<
    Accepts<
      EventProjectionRecords.EventTelegramProjectionStateDocument,
      NonNullable<Extract<EventCommand, { kind: "telegram-state" }>["value"]>
    >
  >,
  Assert<
    Accepts<
      NonNullable<
        ReturnType<typeof Announcements.readTelegramAnnouncementPayloadDocument>
      >,
      NonNullable<TelegramD1.TelegramAnnouncementRecord["payload"]>
    >
  >,
  Assert<
    Accepts<
      AttemptFields & { payload: Announcements.TelegramAlbumPayload },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Accepts<
      AttemptFields & {
        kind: "prizes";
        payload: Announcements.TelegramAlbumPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Accepts<
      AttemptFields & {
        kind: "reminder";
        payload: Announcements.TelegramReminderPayload;
      },
      TelegramD1.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Accepts<
      Announcements.RetainedTelegramAnnouncementAttempt,
      NonNullable<
        Parameters<
          TelegramD1.TelegramAnnouncementRepository["reserve"]
        >[0]["attempt"]
      >
    >
  >,
  Assert<
    Accepts<
      { requestId: string; action: "confirm-send-applied"; messageId: number },
      Records.TelegramManualRecoveryWrite
    >
  >,
  Assert<
    Accepts<
      { requestId: string; action: "confirm-send-absent" },
      Records.TelegramManualRecoveryWrite
    >
  >,
  Assert<
    Accepts<
      { requestId: string; action: "abandon" },
      Records.TelegramManualRecoveryWrite
    >
  >,
  Assert<
    Accepts<
      {
        owner: string;
        messageKey: string;
        revision: string;
        operation: "send";
        acquiredAtMs: number;
      },
      Records.TelegramApiGateWrite
    >
  >,
  Assert<
    Accepts<
      Records.TelegramRetryDocument,
      RetryTypes.TelegramRetryInput["current"]
    >
  >,
  Assert<
    Accepts<
      Records.TelegramDeliveryDocument,
      DeliveryState.DesiredRetryInput["currentDelivery"]
    >
  >,
  Assert<
    Accepts<
      {
        messageKey: string;
        revision: string;
        taskKind: "desired";
        retryState: { retryAtMs: number; retrySequence: number };
      },
      RetryTypes.TelegramExactRetryInput
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof RetryRecords.buildTelegramRetrySchedule>,
      Parameters<DeliveryTypes.TelegramRetryScheduler>[0]
    >
  >,
  Assert<
    Accepts<
      { scheduled: true; taskId: string },
      DeliveryTypes.TelegramRetryScheduleResult
    >
  >,
  Assert<
    Accepts<
      {
        owner: string;
        retryNotBeforeMs: number;
        revision: string;
      } & RetryTypes.TelegramRetryState,
      Records.TelegramRetryProofWrite
    >
  >,
  Assert<
    Accepts<
      ReturnType<typeof DeliveryState.retryDocument>,
      Records.TelegramRetryDocument
    >
  >,
  Assert<
    Accepts<
      AutomatchProjection.AutomatchTelegramSourceDocument,
      RetainedAutomatchValue<"telegramAutomatches">
    >
  >,
  Assert<
    Accepts<
      Awaited<ReturnType<typeof EventProjection.loadEndedMatchResults>>,
      EventProjectionRecords.EventTelegramEndedResultsDocument
    >
  >,
];

export function acceptTypedTelegramBoundaries(
  messages: TelegramRepository,
  events: EventStore,
  announcements: TelegramD1.TelegramAnnouncementRepository,
  message: Records.TelegramMessageDocument,
  state: EventProjectionRecords.EventTelegramProjectionStateDocument,
  payload: Announcements.TelegramReminderPayload,
) {
  return {
    message: messages.transactMessage("message", () => ({ value: message })),
    state: events.transactEventTelegramProjectionState("event", () => ({
      value: state,
    })),
    reminder: announcements.reserve({
      requestId: "request",
      payloadDigest: "digest",
      createdAtMs: 1,
      attempt: {
        kind: "reminder",
        eventId: "event",
        startAtMs: 2,
        runAtMs: 1,
        firstQueuedAtMs: 1,
        attemptId: "attempt",
        expectedAttemptId: null,
        payload,
      },
    }),
  };
}
