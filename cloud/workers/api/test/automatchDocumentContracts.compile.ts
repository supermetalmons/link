import type {
  AutomatchEntryWrite,
  GameSessionMutationKind,
  GameSessionMutationResponseMap,
  AutomatchReceiptWrite,
  GameSessionMutationReceiptWrite,
  MutationReceiptExpirationWrite,
  RetainedAutomatchValue,
} from "../../../runtime/automatchRecords.js";
import type { ProposeRematchResponse } from "@mons/shared/game-sessions";
import type {
  AutomatchRecordSnapshot,
  AutomatchRoot,
  AutomatchFreshWrites,
  AutomatchRecordMutation,
  AutomatchOutboxClaimSnapshot,
  AutomatchOutboxRecoveryPage,
  RetainedAutomatchMutationBatch,
} from "../src/automatchD1/types.ts";
import type { RetainedInviteMutationBatch } from "../src/inviteSourceD1.ts";
import type {
  AutomatchTelegramOutboxSnapshot,
  AutomatchProfileOutboxSnapshot,
} from "../src/automatchProjectionRecords.ts";
import type {
  GameSessionPort,
  AutomatchProjectionRecoveryPort,
} from "../src/gameSessionContracts.ts";
import type { createAutomatchPersistence } from "../src/automatchPersistence.ts";
import type {
  StoredSessionMatchCreation,
  RetainedGameSessionIntent,
} from "../src/gameSessionCodec.ts";
import type {
  EventTransitionIntent,
  EventTransitionDraftInput,
} from "../src/eventD1/types.ts";
import type { effectLayout } from "../src/eventTransitionCodec.ts";
import type {
  EventTransitionReceipt,
  RetainedEventTransitionReceipt,
} from "../src/eventTransitionReceipts.ts";

type Assert<Value extends true> = Value;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type HasNoStringIndex<Value> = string extends keyof Value ? false : true;

type TelegramRecord =
  RetainedAutomatchValue<"telegramProjectionOutbox/automatch">;
type ProfileSnapshot =
  AutomatchOutboxClaimSnapshot<"profileGameProjectionOutbox/automatch">;
export type RetainedEntryHasNoFields = Assert<
  HasNoStringIndex<RetainedAutomatchValue<"automatch">>
>;
export type RawEntryCannotBecomeRetained = Assert<
  Rejects<AutomatchEntryWrite, RetainedAutomatchValue<"automatch">>
>;
export type RootSnapshotCannotMixValues = Assert<
  Rejects<
    { root: "automatch"; key: string; revision: number; value: TelegramRecord },
    AutomatchRecordSnapshot
  >
>;
export type RootMutationCannotMixValues = Assert<
  Rejects<
    { current: ProfileSnapshot; value: TelegramRecord },
    AutomatchRecordMutation
  >
>;
export type ReceiptCannotBecomeExpiration = Assert<
  Rejects<AutomatchReceiptWrite, MutationReceiptExpirationWrite>
>;
export type ExpirationMutationRejectsReceipt = Assert<
  Rejects<
    {
      current: AutomatchRecordSnapshot<"gameplayMutationReceiptExpirations">;
      value: AutomatchReceiptWrite;
    },
    AutomatchRecordMutation
  >
>;
export type RecoveryPageCannotMixRoots = Assert<
  Rejects<
    {
      entries: Record<string, TelegramRecord>;
      scannedIdentities: string[];
      snapshots: ReadonlyMap<string, ProfileSnapshot>;
    },
    AutomatchOutboxRecoveryPage
  >
>;
export type FreshManualReceiptRejectsOtherResponse = Assert<
  Rejects<
    Omit<
      Extract<GameSessionMutationReceiptWrite, { kind: "rematch-end" }>,
      "response"
    > & { response: ProposeRematchResponse },
    GameSessionMutationReceiptWrite
  >
>;
export type AutomatchBatchCannotBeConstructed = Assert<
  Rejects<AutomatchRecordMutation[], RetainedAutomatchMutationBatch>
>;
export type InviteBatchCannotBeConstructed = Assert<
  Rejects<unknown[], RetainedInviteMutationBatch>
>;
export type RetainedBatchHasNoStringIndex = Assert<
  HasNoStringIndex<RetainedAutomatchMutationBatch>
>;
export type TelegramOutboxHasNoRaw = Assert<
  "raw" extends keyof AutomatchTelegramOutboxSnapshot ? false : true
>;
export type ProfileOutboxHasNoRaw = Assert<
  "raw" extends keyof AutomatchProfileOutboxSnapshot ? false : true
>;
export type DomainPortHasNoRawTransactions = Assert<
  "transactAutomatchTelegramSource" extends keyof GameSessionPort ? false : true
>;
export type RecoveryPortHasNoRawTransactions = Assert<
  "transactRawAutomatchProfileOutbox" extends keyof AutomatchProjectionRecoveryPort
    ? false
    : true
>;
export type PersistenceHasNoRawClient = Assert<
  "rawClient" extends keyof ReturnType<typeof createAutomatchPersistence>
    ? false
    : true
>;
export type StoredCreationRejectsRawPayload = Assert<
  Rejects<
    { path: string; marker: string; value: object },
    StoredSessionMatchCreation
  >
>;
export type StoredCreationHasNoValueField = Assert<
  "value" extends keyof StoredSessionMatchCreation ? false : true
>;
export type SessionIntentCannotBeConstructed = Assert<
  Rejects<{ version: 2; inviteId: string }, RetainedGameSessionIntent>
>;
export type EventIntentRejectsRawEffectBags = Assert<
  Rejects<Record<string, unknown>, EventTransitionDraftInput["rtdbEffects"]>
>;
export type EventIntentCannotBeConstructed = Assert<
  Rejects<EventTransitionDraftInput, EventTransitionIntent>
>;
export type EventCreationHasNoStringIndex = Assert<
  HasNoStringIndex<
    ReturnType<typeof effectLayout>["creations"][number]["value"]
  >
>;
export type FreshEventReceiptHasNoStringIndex = Assert<
  HasNoStringIndex<EventTransitionReceipt>
>;
export type RetainedEventReceiptHasNoStringIndex = Assert<
  HasNoStringIndex<RetainedEventTransitionReceipt>
>;
export type FreshReceiptCannotBecomeRetained = Assert<
  Rejects<EventTransitionReceipt, RetainedEventTransitionReceipt>
>;

type EveryCrossRootFreshMutation = {
  [Left in AutomatchRoot]: {
    [Right in Exclude<AutomatchRoot, Left>]: Rejects<
      {
        current: AutomatchRecordSnapshot<Left>;
        value: AutomatchFreshWrites[Right];
      },
      AutomatchRecordMutation
    >;
  }[Exclude<AutomatchRoot, Left>];
}[AutomatchRoot];
export type FreshMutationRejectsEveryOtherRoot =
  Assert<EveryCrossRootFreshMutation>;

type EveryCrossRootRetainedSnapshot = {
  [Left in AutomatchRoot]: {
    [Right in Exclude<AutomatchRoot, Left>]: Rejects<
      {
        root: Left;
        key: string;
        revision: number;
        value: RetainedAutomatchValue<Right>;
      },
      AutomatchRecordSnapshot
    >;
  }[Exclude<AutomatchRoot, Left>];
}[AutomatchRoot];
export type RetainedSnapshotRejectsEveryOtherRoot =
  Assert<EveryCrossRootRetainedSnapshot>;

type EveryCrossKindReceipt = {
  [Left in GameSessionMutationKind]: {
    [Right in Exclude<GameSessionMutationKind, Left>]: Rejects<
      Omit<
        Extract<GameSessionMutationReceiptWrite, { kind: Left }>,
        "response"
      > & {
        response: GameSessionMutationResponseMap[Right];
      },
      GameSessionMutationReceiptWrite
    >;
  }[Exclude<GameSessionMutationKind, Left>];
}[GameSessionMutationKind];
export type FreshReceiptRejectsEveryOtherResponse =
  Assert<EveryCrossKindReceipt>;
