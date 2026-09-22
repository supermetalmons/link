import type { EventMutation } from "../../../runtime/eventCommands.js";
import type { GameSessionChange } from "../../../runtime/gameSessionChanges.js";
import type { EventStore } from "../src/eventStoreContracts.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import type {
  RatingCommitPlan,
  RatingCompletionPatch,
  RatingProfilePatch,
} from "../src/ratingContracts.ts";
import type {
  AutomatchRepository,
  GameSessionRepository,
} from "../src/gameplayContracts.ts";
import type { sweepGameSessionMutationReceipts } from "../src/gameSessionMutations.ts";
import type { MatchStatePort } from "../src/repositoryContracts.ts";
import type { WagerKey } from "../src/wagerStateRepository.ts";
import type { TelegramStorage } from "../../../runtime/telegram/repositoryCore.js";

type Assert<T extends true> = T;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
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
