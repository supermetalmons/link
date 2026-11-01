import type * as Client from "../../../runtime/telegram/client.js";
import type * as Records from "../../../runtime/telegram/records.js";
import type * as Desired from "../../../runtime/telegram/desiredStateCore.js";
import type * as EventProjection from "../../../runtime/telegram/eventProjectionRecords.js";
import type { TelegramTaskPayload } from "../../../runtime/telegram/taskIdentity.js";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryTypes.js";
import type { TelegramStorage } from "../../../runtime/telegram/repositoryCore.js";
import type * as Announcements from "../src/telegramAnnouncementRecords.ts";
import type { TelegramAnnouncementRepository } from "../src/telegramD1.ts";

type Assert<T extends true> = T;
type Rejects<Value, Contract> = [Value] extends [Contract] ? false : true;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Closed<Value> = string extends keyof Value ? false : true;
type MessageUpdater = Parameters<TelegramRepository["transactMessage"]>[1];
type ControlUpdater = Parameters<TelegramStorage["transactControl"]>[0];
type RateLimitTask = Extract<
  TelegramTaskPayload,
  { taskKind: "rate-limit-proof" }
>;

export type TelegramStoredDocumentContracts = [
  Assert<Closed<Records.TelegramMessageDocument>>,
  Assert<Closed<Records.TelegramControlDocument>>,
  Assert<Closed<Records.TelegramDeliveryDocument>>,
  Assert<Closed<Records.TelegramSendEvidence>>,
  Assert<Equal<Records.TelegramMessageDocument["schemaVersion"], 1>>,
  Assert<Equal<Records.TelegramControlDocument["schemaVersion"], 1>>,
  Assert<Rejects<Record<string, unknown>, Records.TelegramMessageDocument>>,
  Assert<
    Rejects<
      Omit<Records.TelegramMessageDocument, "schemaVersion">,
      Records.TelegramMessageDocument
    >
  >,
  Assert<
    Equal<
      Records.TelegramDeliveryDocument["status"],
      | "pending"
      | "processing"
      | "retryable"
      | "delivered"
      | "terminal"
      | "uncertain"
    >
  >,
  Assert<
    Rejects<
      Omit<Records.TelegramDeliveryDocument, "revision">,
      Records.TelegramDeliveryDocument
    >
  >,
  Assert<Equal<Records.TelegramSendEvidence["startedAtMs"], number>>,
  Assert<
    Rejects<
      Omit<Records.TelegramSendEvidence, "attemptId" | "apiGateOwner">,
      Records.TelegramSendEvidence
    >
  >,
  Assert<Equal<Records.TelegramAppliedDocument["messageId"], number>>,
  Assert<Equal<Records.TelegramAppliedDocument["appliedAtMs"], number>>,
  Assert<
    Equal<
      Records.TelegramCleanupQueueDocument[string],
      Records.TelegramCleanupDocument
    >
  >,
  Assert<
    Equal<
      Records.TelegramOrphanedDeletesDocument[string]["terminalAtMs"],
      number
    >
  >,
  Assert<
    Equal<Parameters<MessageUpdater>[0], Records.TelegramMessageDocument | null>
  >,
  Assert<
    Equal<Parameters<ControlUpdater>[0], Records.TelegramControlDocument | null>
  >,
  Assert<
    Equal<
      Awaited<ReturnType<TelegramRepository["getMessage"]>>,
      Records.TelegramMessageDocument | null
    >
  >,
  Assert<
    Equal<
      ReturnType<typeof Records.readTelegramMessageDocument>,
      Records.TelegramMessageDocument | null
    >
  >,
  Assert<
    Equal<
      ReturnType<typeof Records.readTelegramControlDocument>,
      Records.TelegramControlDocument | null
    >
  >,
];

export type TelegramDesiredAndRecoveryContracts = [
  Assert<Equal<Desired.TelegramDesired["schemaVersion"], 2>>,
  Assert<
    Equal<Desired.TelegramDesired["operation"], "send" | "edit" | "delete">
  >,
  Assert<
    Rejects<
      Omit<Desired.TelegramSendDesired, "text">,
      Desired.TelegramSendDesired
    >
  >,
  Assert<
    Rejects<
      Omit<Desired.TelegramEditDesired, "ifMissing">,
      Desired.TelegramEditDesired
    >
  >,
  Assert<
    Equal<
      Extract<
        Records.TelegramManualRecoveryWrite,
        { action: "confirm-send-applied" }
      >["messageId"],
      number
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
      { requestId: string; action: "abandon"; messageId: number },
      Records.TelegramManualRecoveryWrite
    >
  >,
  Assert<Equal<TelegramTaskPayload["schemaVersion"], 1>>,
  Assert<Equal<TelegramTaskPayload["dataEpoch"], 1>>,
  Assert<Rejects<Omit<TelegramTaskPayload, "dataEpoch">, TelegramTaskPayload>>,
  Assert<Rejects<Omit<RateLimitTask, "barrierProofOwner">, RateLimitTask>>,
  Assert<Rejects<Omit<RateLimitTask, "proofTaskKind">, RateLimitTask>>,
];

export type TelegramProjectionAndProviderContracts = [
  Assert<Closed<EventProjection.EventTelegramProjectionStateDocument>>,
  Assert<
    Equal<
      EventProjection.EventTelegramProjectionStateDocument["schemaVersion"],
      3
    >
  >,
  Assert<
    Equal<
      EventProjection.EventTelegramProjectionStateDocument["startedMatchKeys"],
      string[]
    >
  >,
  Assert<
    Equal<
      EventProjection.EventTelegramProjectionStateDocument["startedMatchLinesByKey"][string],
      string
    >
  >,
  Assert<
    Equal<
      EventProjection.EventTelegramProjectionStateDocument["eventTelegramProjectionGuard"],
      Required<EventProjection.EventTelegramProjectionGuard> | null
    >
  >,
  Assert<
    Rejects<{ status: "scored" }, EventProjection.EventTelegramEndedResult>
  >,
  Assert<Rejects<Records.TelegramMessageDocument, Client.TelegramSendInput>>,
  Assert<
    Rejects<Omit<Client.TelegramSendInput, "text">, Client.TelegramSendInput>
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramEditInput, "messageId">,
      Client.TelegramEditInput
    >
  >,
  Assert<
    Rejects<
      Omit<Client.TelegramMediaGroupInput, "imageUrls">,
      Client.TelegramMediaGroupInput
    >
  >,
  Assert<Rejects<Client.TelegramMediaGroupSuccess, Client.TelegramSendSuccess>>,
  Assert<Rejects<Client.TelegramSendSuccess, Client.TelegramMediaGroupSuccess>>,
  Assert<
    Rejects<
      { kind: "prizes"; payload: Announcements.TelegramReminderPayload },
      Pick<
        Extract<Announcements.TelegramAnnouncementAttempt, { kind: "prizes" }>,
        "kind" | "payload"
      >
    >
  >,
  Assert<
    Rejects<
      { kind: "reminder"; payload: Announcements.TelegramAlbumPayload },
      Pick<
        Extract<
          Announcements.TelegramAnnouncementAttempt,
          { kind: "reminder" }
        >,
        "kind" | "payload"
      >
    >
  >,
  Assert<
    Rejects<
      Omit<Announcements.TelegramAnnouncementAttempt, "attemptId">,
      Announcements.TelegramAnnouncementAttempt
    >
  >,
  Assert<
    Equal<
      NonNullable<
        Parameters<TelegramAnnouncementRepository["reserve"]>[0]["attempt"]
      >,
      Announcements.TelegramAnnouncementAttempt
    >
  >,
];
