import type {
  AutomatchEntryRecord,
  AutomatchEntryWrite,
  AutomatchRecordMap,
  AutomatchRecordRoot,
  AutomatchReceiptWrite,
  GameSessionMutationKind,
  GameSessionMutationResponseMap,
  GameSessionMutationReceiptWrite,
  MutationReceiptExpirationWrite,
} from "../../../runtime/automatchRecords.js";
import type {
  AutomatchRecordSnapshot,
  AutomatchRecordMutation,
  AutomatchOutboxClaimSnapshot,
  AutomatchOutboxRecoveryPage,
} from "../src/automatchD1/types.ts";
import type {
  AutomatchTelegramOutboxSnapshot,
  AutomatchProfileOutboxSnapshot,
} from "../src/automatchProjectionRecords.ts";
import type { GameSessionPort } from "../src/gameSessionContracts.ts";
import type { createAutomatchPersistence } from "../src/automatchPersistence.ts";
import type {
  StoredSessionMatchCreation,
  GameSessionIntentWrite,
} from "../src/gameSessionIntentRecords.ts";

type Assert<Value extends true> = Value;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type HasNoStringIndex<Value> = string extends keyof Value ? false : true;
type TelegramRecord = AutomatchRecordMap["telegramProjectionOutbox/automatch"];
type ProfileSnapshot =
  AutomatchOutboxClaimSnapshot<"profileGameProjectionOutbox/automatch">;
export type EntryHasClosedFields = Assert<
  HasNoStringIndex<AutomatchEntryRecord>
>;
export type PartialEntryIsRejected = Assert<
  Rejects<{ uid: string }, AutomatchEntryRecord>
>;
export type UnresolvedServerTimestampIsNotStored = Assert<
  Rejects<AutomatchEntryWrite, AutomatchEntryRecord>
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
export type TelegramViewHasNoRawEscape = Assert<
  "raw" extends keyof AutomatchTelegramOutboxSnapshot ? false : true
>;
export type ProfileViewHasNoRawEscape = Assert<
  "raw" extends keyof AutomatchProfileOutboxSnapshot ? false : true
>;
export type DomainPortHasNoStorageTransactions = Assert<
  "transactAutomatchTelegramSource" extends keyof GameSessionPort ? false : true
>;
export type PublicPersistenceHasNoStorageClient = Assert<
  "rawClient" extends keyof ReturnType<typeof createAutomatchPersistence>
    ? false
    : true
>;
export type StoredCreationRejectsUntypedPayload = Assert<
  Rejects<
    { path: string; marker: string; value: object },
    StoredSessionMatchCreation
  >
>;
export type StoredCreationContainsTypedValue = Assert<
  "value" extends keyof StoredSessionMatchCreation ? true : false
>;
export type PartialIntentIsRejected = Assert<
  Rejects<{ version: 3; inviteId: string }, GameSessionIntentWrite>
>;
type EveryCrossRootSnapshot = {
  [Left in AutomatchRecordRoot]: {
    [Right in Exclude<AutomatchRecordRoot, Left>]: Rejects<
      {
        root: Left;
        key: string;
        revision: number;
        value: AutomatchRecordMap[Right];
      },
      AutomatchRecordSnapshot
    >;
  }[Exclude<AutomatchRecordRoot, Left>];
}[AutomatchRecordRoot];
export type SnapshotRejectsEveryOtherRoot = Assert<EveryCrossRootSnapshot>;
type EveryCrossKindReceipt = {
  [Left in GameSessionMutationKind]: {
    [Right in Exclude<GameSessionMutationKind, Left>]: Rejects<
      Omit<
        Extract<GameSessionMutationReceiptWrite, { kind: Left }>,
        "response"
      > & { response: GameSessionMutationResponseMap[Right] },
      GameSessionMutationReceiptWrite
    >;
  }[Exclude<GameSessionMutationKind, Left>];
}[GameSessionMutationKind];
export type ReceiptRejectsEveryOtherResponse = Assert<EveryCrossKindReceipt>;
