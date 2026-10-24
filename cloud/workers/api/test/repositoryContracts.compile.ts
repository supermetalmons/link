import type { EventMutation } from "../../../runtime/eventCommands.js";
import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
import type { EventStore } from "../src/eventStoreContracts.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import type {
  PendingRatingEventProgress,
  PendingRatingProfileGameProjection,
  PendingRatingTelegramProjection,
  RatingCommitPlan,
  RatingCompletionPatch,
  RatingEventProgressRepository,
  RatingProfileGameProjectionRepository,
  RatingProfilePatch,
  RatingProjectionRepository,
} from "../src/ratingContracts.ts";
import type {
  ProjectionRecord,
  ProjectionWrite,
} from "../../../runtime/profileGamesProjectionCore.js";
import type { ProjectionWrite as D1ProjectionWrite } from "../src/profileGamesD1.ts";
import type {
  AutomatchRepository,
  GameSessionRepository,
} from "../src/gameplayContracts.ts";
import type { sweepGameSessionMutationReceipts } from "../src/gameSessionMutations.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import type { WagerKey } from "../src/wagerStateRepository.ts";
import type { TelegramStorage } from "../../../runtime/telegram/repositoryCore.js";
import type {
  AutomatchEntryFields,
  AutomatchEntryRead,
  AutomatchEntryWrite,
  AutomatchReceiptView,
  AutomatchReceiptWrite,
  AutomatchTelegramSourceWrite,
  GameSessionMutationReceiptView,
  GameSessionMutationReceiptWrite,
  HistoricalMatchDescriptorWrite,
  MutationReceiptWrite,
  SessionTimestamp,
} from "../../../runtime/automatchRecords.js";
import type {
  ProfileProjectionRequest,
  TelegramProjectionRequest,
  TelegramSourceChanges,
} from "../../../runtime/gameSessionChanges.js";
import type { GameSessionPort } from "../src/gameSessionContracts.ts";
import type { ReceiptRead } from "../src/gameSessionReceiptRecords.ts";
import type {
  createEventPrizeContext,
  EventPrizeContext,
  EventPrizeRequestDependencies,
  EventPrizeStatusDependencies,
} from "../src/eventPrizeWithdrawal/context.ts";
import type {
  getEventPrizeWithdrawalStatus,
  startEventPrizeWithdrawal,
} from "../src/eventPrizeWithdrawal/admission.ts";
import type { createEventPrizeRuntimeDependencies } from "../src/eventPrizeWithdrawal/runtime.ts";
import type { EventPrizeWithdrawalStore } from "../src/eventPrizeWithdrawalD1.ts";
import type { EventGameplayRepository } from "../src/eventRepository.ts";
import type { ProfileOwnershipReader } from "../src/profileOwnership.ts";
import type { EventPrizeRepository } from "../src/eventPrizeRepository.ts";
import type { WithdrawalRuntimeDependencies } from "../../../runtime/eventPrizes/solanaTypes.js";

type Assert<T extends true> = T;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type HasAnyDependencyResult<T> = {
  [Key in keyof T]: T[Key] extends (...args: never[]) => infer Result
    ? IsAny<Awaited<Result>>
    : IsAny<T[Key]>;
}[keyof T];
type RetiredMethod =
  | "getPath"
  | "patchRoot"
  | "transactPath"
  | "getStatePath"
  | "patchStateRoot"
  | "transactStatePath"
  | "replacePaths";

export type DomainPortsHaveNoPathMethods = Assert<
  Extract<
    keyof EventStore | keyof GameplayRepository | keyof TelegramStorage,
    RetiredMethod
  > extends never
    ? true
    : false
>;
export type MatchMethodsAreRequired = Assert<
  MatchStatePort extends Required<MatchStatePort> ? true : false
>;
export type InvalidEventStatusIsRejected = Assert<
  Rejects<
    { kind: "event-field"; eventId: "event"; field: "status"; value: 123 },
    EventMutation
  >
>;
export type UnknownEventFieldIsRejected = Assert<
  Rejects<
    { kind: "event-field"; eventId: "event"; field: "arbitrary"; value: true },
    EventMutation
  >
>;
export type ArbitrarySessionPathIsRejected = Assert<
  Rejects<
    { kind: "patch"; path: "invites/invite/guestId"; value: "guest" },
    GameSessionChange
  >
>;
export type WagerIdentityRequiresMatch = Assert<
  Rejects<{ inviteId: "invite" }, WagerKey>
>;

export type AutomatchPersistenceIsRequired = Assert<
  Rejects<
    Omit<AutomatchRepository, "automatchPersistence">,
    AutomatchRepository
  >
>;
export type GameplayPersistenceIsRequired = Assert<
  Rejects<Omit<GameplayRepository, "automatchPersistence">, GameplayRepository>
>;
export type SessionRepositoryNeedsNoAutomatchCoordinator = Assert<
  "automatchPersistence" extends keyof GameSessionRepository ? false : true
>;
export type ReceiptCleanupRequiresExpiryOperation = Assert<
  Rejects<{}, Parameters<typeof sweepGameSessionMutationReceipts>[0]>
>;

export type RatingProfilePatchAllowsPartialUpdates = Assert<
  { rating: 0 } | { win: false } | null extends RatingCommitPlan["playerUpdate"]
    ? true
    : false
>;
export type RatingCommitPlanRejectsInvalidPatches = Assert<
  | Rejects<{ rating: string }, RatingCommitPlan["playerUpdate"]>
  | Rejects<{ unexpected: true }, RatingCommitPlan["opponentUpdate"]>
  | Rejects<
      Omit<RatingCompletionPatch, "status"> & { status: "processing" },
      RatingCommitPlan["ratingUpdate"]
    >
>;
export type RatingProfilePatchHasOnlyKnownFields = Assert<
  Exclude<
    keyof RatingProfilePatch,
    "rating" | "nonce" | "win" | "totalManaPoints"
  > extends never
    ? true
    : false
>;
export type RatingProfilePatchRejectsIncorrectValues = Assert<
  | Rejects<{ rating: string }, RatingProfilePatch>
  | Rejects<{ nonce: string }, RatingProfilePatch>
  | Rejects<{ win: number }, RatingProfilePatch>
  | Rejects<{ totalManaPoints: null }, RatingProfilePatch>
>;
export type RatingCompletionHasNoArbitraryFields = Assert<
  string extends keyof RatingCompletionPatch ? false : true
>;
export type RatingCompletionRejectsUnknownField = Assert<
  Rejects<"completedAt" | "arbitrary", keyof RatingCompletionPatch>
>;
export type RatingCompletionRejectsInvalidStatus = Assert<
  | Rejects<"processing", RatingCompletionPatch["status"]>
  | Rejects<"done", RatingCompletionPatch["telegramProjectionState"]>
  | Rejects<"dead", RatingCompletionPatch["profileGameProjectionState"]>
  | Rejects<"invalid", RatingCompletionPatch["eventProgressState"]>
>;
export type RatingCompletionRejectsIncorrectValues = Assert<
  | Rejects<string, RatingCompletionPatch["completedAtMs"]>
  | Rejects<string, RatingCompletionPatch["playerManaPoints"]>
  | Rejects<null, RatingCompletionPatch["opponentManaPoints"]>
  | Rejects<number, RatingCompletionPatch["eventId"]>
>;
export type RatingCompletionRequiresTimestamps = Assert<
  | Rejects<Omit<RatingCompletionPatch, "completedAtMs">, RatingCompletionPatch>
  | Rejects<Omit<RatingCompletionPatch, "updatedAtMs">, RatingCompletionPatch>
  | Rejects<
      Omit<RatingCompletionPatch, "leaseExpiresAtMs">,
      RatingCompletionPatch
    >
>;
export type RatingCompletionAllowsNullableMetadata = Assert<
  {
    status: "done";
    completedAtMs: number;
    updatedAtMs: number;
    leaseExpiresAtMs: number;
    eventId: null;
    winnerNewRating: null;
    loserNewRating: null;
    telegramDeliveryVersion: null;
    telegramProjectionReason: null;
    profileGameProjectionReason: null;
    eventProgressReason: null;
  } extends RatingCompletionPatch
    ? true
    : false
>;

type RatingRecoveryRecord =
  | PendingRatingEventProgress
  | PendingRatingProfileGameProjection
  | PendingRatingTelegramProjection;
type RatingClaimRevision =
  | Parameters<RatingEventProgressRepository["claimRatingEventProgress"]>[1]
  | Parameters<
      RatingProfileGameProjectionRepository["claimRatingProfileGameProjection"]
    >[1]
  | Parameters<RatingProjectionRepository["claimRatingTelegramProjection"]>[1];

export type RatingRecoveryRevisionsAreNumeric = Assert<
  RatingRecoveryRecord["revision"] | RatingClaimRevision extends number
    ? true
    : false
>;
export type RatingRecoveryRejectsStringRevisions = Assert<
  | Rejects<string, RatingRecoveryRecord["revision"]>
  | Rejects<string, RatingClaimRevision>
>;
export type RatingRecoveryHasNoUpdateTime = Assert<
  Rejects<
    "updateTime",
    | keyof PendingRatingEventProgress
    | keyof PendingRatingProfileGameProjection
    | keyof PendingRatingTelegramProjection
  >
>;
export type ProjectionVersionsAreNumeric = Assert<
  | (ProjectionRecord["version"] extends number ? true : false)
  | (number extends ProjectionWrite["expectedVersion"] ? true : false)
  | (number extends D1ProjectionWrite["expectedVersion"] ? true : false)
>;
export type ProjectionRecordsRejectStringVersions = Assert<
  | Rejects<string, ProjectionRecord["version"]>
  | Rejects<string, ProjectionWrite["expectedVersion"]>
  | Rejects<string, D1ProjectionWrite["expectedVersion"]>
>;

type ReplacedField<T, Key extends keyof T, Value> = Omit<T, Key> &
  Record<Key, Value>;
type HistoricalDescriptorMap = NonNullable<
  Extract<
    GameSessionChange,
    { kind: "profile-outbox-merge" }
  >["historicalMatches"]
>;
type StoredTimestampMarker = { readonly ".sv": "timestamp" };
type IncrementMarker = { readonly ".sv": { increment: number } };

export type AutomatchEntryReadIsRequired = Assert<
  Awaited<
    ReturnType<GameSessionPort["readAutomatchEntry"]>
  > extends AutomatchEntryRead
    ? true
    : false
>;
export type AutomatchEntryReadsRejectRawRecords = Assert<
  | Rejects<
      { uid: string },
      Awaited<ReturnType<GameSessionPort["readAutomatchEntry"]>>
    >
  | Rejects<
      Record<string, unknown>,
      NonNullable<
        Awaited<ReturnType<GameSessionPort["readFirstAutomatchEntry"]>>
      >
    >
>;
export type AutomatchReadNumbersAreResolved = Assert<
  | (
      | AutomatchEntryFields["timestamp"]
      | AutomatchEntryFields["rating"] extends number
      ? true
      : false)
  | (AutomatchReceiptView["completedAtMs"] extends number ? true : false)
  | (GameSessionMutationReceiptView["completedAtMs"] extends number
      ? true
      : false)
  | Rejects<StoredTimestampMarker, AutomatchEntryFields["timestamp"]>
  | Rejects<StoredTimestampMarker, AutomatchReceiptView["completedAtMs"]>
  | Rejects<
      StoredTimestampMarker,
      GameSessionMutationReceiptView["completedAtMs"]
    >
>;
export type AutomatchReceiptReadsDistinguishInvalidRecords = Assert<
  | (Awaited<
      ReturnType<GameSessionPort["readAutomatchReceipt"]>
    > extends ReceiptRead<AutomatchReceiptView>
      ? true
      : false)
  | (Awaited<
      ReturnType<GameSessionPort["readGameSessionMutationReceipt"]>
    > extends ReceiptRead<GameSessionMutationReceiptView>
      ? true
      : false)
  | Rejects<
      { kind: "valid"; value: {} },
      Awaited<ReturnType<GameSessionPort["readAutomatchReceipt"]>>
    >
>;
export type AutomatchProducersHaveKnownFields = Assert<
  | Rejects<"arbitrary", keyof AutomatchEntryWrite>
  | Rejects<"arbitrary", keyof AutomatchTelegramSourceWrite>
  | Rejects<"arbitrary", keyof AutomatchReceiptWrite>
  | Rejects<"arbitrary", keyof GameSessionMutationReceiptWrite>
  | Rejects<"arbitrary", keyof HistoricalMatchDescriptorWrite>
>;
export type AutomatchEntriesRejectWrongProducerFields = Assert<
  | Rejects<
      ReplacedField<AutomatchEntryWrite, "uid", number>,
      AutomatchEntryWrite
    >
  | Rejects<
      ReplacedField<AutomatchEntryWrite, "rating", string>,
      AutomatchEntryWrite
    >
  | Rejects<
      ReplacedField<AutomatchEntryWrite, "hostColor", "green">,
      AutomatchEntryWrite
    >
  | Rejects<
      ReplacedField<AutomatchEntryWrite, "telegramDeliveryVersion", string>,
      AutomatchEntryWrite
    >
>;
export type AutomatchReceiptsRequireIdentityAndResponse = Assert<
  | Rejects<Omit<AutomatchReceiptWrite, "operationId">, MutationReceiptWrite>
  | Rejects<
      Omit<GameSessionMutationReceiptWrite, "requesterUid">,
      MutationReceiptWrite
    >
  | Rejects<
      ReplacedField<AutomatchReceiptWrite, "response", { ok: false }>,
      MutationReceiptWrite
    >
  | Rejects<
      ReplacedField<GameSessionMutationReceiptWrite, "kind", "other">,
      MutationReceiptWrite
    >
  | Rejects<
      ReplacedField<GameSessionMutationReceiptWrite, "fingerprint", number>,
      MutationReceiptWrite
    >
>;
export type AutomatchChangesAcceptNamedProducers = Assert<
  | ({
      kind: "automatch-entry";
      inviteId: string;
      value: AutomatchEntryWrite;
    } extends GameSessionChange
      ? true
      : false)
  | ({
      kind: "telegram-source";
      inviteId: string;
      value: AutomatchTelegramSourceWrite;
    } extends GameSessionChange
      ? true
      : false)
  | ({
      kind: "mutation-receipt";
      operationId: string;
      value: MutationReceiptWrite;
      expiration: { completedAtMs: StoredTimestampMarker };
    } extends GameSessionChange
      ? true
      : false)
>;
export type AutomatchWritesAcceptServerTimestamps = Assert<
  | (StoredTimestampMarker extends AutomatchEntryWrite["timestamp"]
      ? true
      : false)
  | (StoredTimestampMarker extends AutomatchReceiptWrite["completedAtMs"]
      ? true
      : false)
  | (StoredTimestampMarker extends GameSessionMutationReceiptWrite["completedAtMs"]
      ? true
      : false)
  | (StoredTimestampMarker extends TelegramProjectionRequest["updatedAtMs"]
      ? true
      : false)
  | (StoredTimestampMarker extends ProfileProjectionRequest["lastQueuedAtMs"]
      ? true
      : false)
  | (IncrementMarker extends TelegramSourceChanges["generation"] ? true : false)
>;
export type AutomatchWritesRejectWrongServerMarkers = Assert<
  | Rejects<IncrementMarker, SessionTimestamp>
  | Rejects<{ ".sv": "invalid" }, SessionTimestamp>
  | Rejects<StoredTimestampMarker, TelegramSourceChanges["generation"]>
>;
export type AutomatchProjectionWritesRejectInvalidShapes = Assert<
  | Rejects<
      ReplacedField<AutomatchTelegramSourceWrite, "lifecycle", "active">,
      AutomatchTelegramSourceWrite
    >
  | Rejects<
      ReplacedField<TelegramProjectionRequest, "status", "dead">,
      TelegramProjectionRequest
    >
  | Rejects<
      ReplacedField<ProfileProjectionRequest, "requestId", number>,
      ProfileProjectionRequest
    >
  | Rejects<
      ReplacedField<HistoricalMatchDescriptorWrite, "source", "other">,
      HistoricalMatchDescriptorWrite
    >
  | Rejects<HistoricalMatchDescriptorWrite[], HistoricalDescriptorMap>
>;
export type AutomatchHistoricalWritesUseDescriptorMaps = Assert<
  Record<string, HistoricalMatchDescriptorWrite> extends HistoricalDescriptorMap
    ? true
    : false
>;
export type AutomatchSessionPortExcludesRawRecoveryAccess = Assert<
  Extract<
    keyof GameSessionPort,
    | "readMutationReceipt"
    | "transactAutomatchTelegramSource"
    | "transactAutomatchTelegramOutbox"
    | "transactAutomatchProfileOutbox"
    | "transactRawAutomatchTelegramOutbox"
    | "transactRawAutomatchProfileOutbox"
    | "listDueAutomatchTelegramOutboxes"
    | "listDueAutomatchTelegramOutboxesPage"
    | "listDueAutomatchProfileOutboxes"
    | "listDueAutomatchProfileOutboxesPage"
    | "listMalformedAutomatchProfileOutboxes"
    | "listMalformedAutomatchProfileOutboxesPage"
    | "projectionRecovery"
  > extends never
    ? true
    : false
>;

type MinimalPrizeStatusDependencies = {
  readWithdrawal: EventPrizeWithdrawalStore["get"];
  readProfileOwnershipSnapshot: ProfileOwnershipReader["readProfileOwnershipSnapshot"];
  readProfileEventPrizeAssignment: EventGameplayRepository["readProfileEventPrizeAssignment"];
};
type MinimalPrizeRequestDependencies = MinimalPrizeStatusDependencies & {
  withdrawals: Pick<EventPrizeWithdrawalStore, "record">;
  removeMatchingProfileEventPrizeAssignment(input: {
    profileId: string;
    eventId: string;
    prizeId: string;
  }): Promise<boolean>;
  resolveCanonicalProfilePath(profileId: string): Promise<string[]>;
};
type PrizeStatusRuntime = Parameters<typeof getEventPrizeWithdrawalStatus>[2];
type PrizeRequestRuntime = Parameters<typeof startEventPrizeWithdrawal>[2];

export type PrizeRequestContractsRejectAny = Assert<
  | Equal<IsAny<EventPrizeContext>, false>
  | Equal<IsAny<EventPrizeStatusDependencies>, false>
  | Equal<IsAny<EventPrizeRequestDependencies>, false>
  | Equal<IsAny<PrizeStatusRuntime>, false>
  | Equal<IsAny<PrizeRequestRuntime>, false>
  | Equal<HasAnyDependencyResult<EventPrizeStatusDependencies>, false>
  | Equal<HasAnyDependencyResult<EventPrizeRequestDependencies>, false>
  | Equal<
      IsAny<EventPrizeStatusDependencies[keyof EventPrizeStatusDependencies]>,
      false
    >
  | Equal<
      IsAny<EventPrizeRequestDependencies[keyof EventPrizeRequestDependencies]>,
      false
    >
>;
export type PrizeAdmissionAcceptsOnlyRequestCapabilities = Assert<
  | Equal<PrizeRequestRuntime, EventPrizeRequestDependencies>
  | Equal<
      keyof EventPrizeRequestDependencies,
      keyof MinimalPrizeRequestDependencies
    >
  | (MinimalPrizeRequestDependencies extends PrizeRequestRuntime ? true : false)
>;
export type PrizeStatusAcceptsOnlyReadCapabilities = Assert<
  | Equal<PrizeStatusRuntime, EventPrizeStatusDependencies>
  | Equal<
      keyof EventPrizeStatusDependencies,
      keyof MinimalPrizeStatusDependencies
    >
  | (MinimalPrizeStatusDependencies extends PrizeStatusRuntime ? true : false)
>;
export type PrizeRequestCannotReplaceCompletionRecords = Assert<
  Equal<
    EventPrizeRequestDependencies["withdrawals"],
    Pick<EventPrizeWithdrawalStore, "record">
  >
>;
export type PrizeRepositoryRequiresGuardedCleanup = Assert<
  Rejects<
    Omit<EventPrizeRepository, "removeMatchingProfileEventPrizeAssignment">,
    EventPrizeRepository
  >
>;
export type PrizeContextHasNoSigner = Assert<
  | Rejects<"createEventPrizeUmi", keyof EventPrizeContext>
  | Rejects<
      "createEventPrizeUmi",
      keyof Awaited<ReturnType<typeof createEventPrizeContext>>
    >
>;
export type PrizeExecutionRetainsItsSigner = Assert<
  Equal<
    Awaited<
      ReturnType<typeof createEventPrizeRuntimeDependencies>
    >["createEventPrizeUmi"],
    WithdrawalRuntimeDependencies["createEventPrizeUmi"]
  >
>;
