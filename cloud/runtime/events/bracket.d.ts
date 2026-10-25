// Generated from src/events/bracket.ts. Run npm run generate:runtime.
import { type EventMatchesDocument } from "./documents.js";
import type { EventRuntimeStore, EventCommitPlan } from "../eventCommands.js";
import type { WithdrawalDocument } from "../eventPrizes/records.js";
import type { EventPrizeAssignmentRecord } from "../eventReads.js";
import type { EventOwnershipSnapshot } from "./ownership.js";
import type {
  EventData,
  EventParticipants,
  EventMatch,
  EventRounds,
  EventPlacement,
  MatchResolution,
  BuildGameSeed,
  MatchReadinessInput,
} from "./model.js";
import type {
  FixedBracketInput,
  ThirdPlaceReadinessOptions,
  EventStartTransitionDependencies,
} from "./startTransitionCore.js";
import {
  applyMatchResolution,
  assignWinnerToNextRound,
  buildSeedToProfileId,
  createEmptyEventMatch,
  getSortedMatchKeys,
  getSortedRoundIndexes,
  hasThirdPlaceMatchField,
  isMatchResolved,
  isMatchSlotBlocked,
  isMatchWinnerDisqualified,
  recomputeRoundStatuses,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
} from "./startTransitionCore.js";
export type EventMatchPairRequest = {
  inviteId: string;
  matchId: string;
  playerId: string;
  opponentId: string;
};
export type EventBracketDependencies = {
  state?: Pick<EventRuntimeStore, "transactProfileEventPrize">;
  readMatchPair?(input: EventMatchPairRequest): Promise<[unknown, unknown]>;
  readMatchPairs?(
    input: EventMatchPairRequest[],
  ): Promise<Array<[unknown, unknown]>>;
  buildRandomGameSeed?: BuildGameSeed;
  resolveMatchWinner?(
    match: unknown,
    opponentMatch: unknown,
  ): Promise<{
    winner: "player" | "opponent" | null;
    reason?: string;
  }>;
  readEventPrizeWithdrawals?(
    eventId: string,
  ): Promise<Record<string, WithdrawalDocument>>;
};
export type EventPrizePlacementsInput = {
  event: EventData | null;
  rounds: EventRounds;
  participantsById: EventParticipants;
  thirdPlaceMatch?: EventMatch | null;
};
type PrizeProjectionInput = {
  event: EventData;
  eventId: string;
  assignments: Record<string, EventPrizeAssignmentRecord>;
  ownershipSnapshot: EventOwnershipSnapshot | null;
};
declare const createEventBracketRuntime: (
  dependencies?: EventBracketDependencies,
) => {
  addEventPrizeAssignmentUpdates: ({
    updates,
    eventId,
    assignments,
    includeEventAssignments,
  }: {
    updates: EventCommitPlan;
    eventId: string;
    assignments: Record<string, EventPrizeAssignmentRecord>;
    includeEventAssignments: boolean;
  }) => Promise<void>;
  applyMatchResolution: (
    match: EventMatch | null,
    resolved: MatchResolution | null,
    nowMs: number,
  ) => boolean;
  assignWinnerToNextRound: ({
    rounds,
    roundIndex,
    matchIndex,
    winnerProfileId,
    participantsById,
    winnerDisqualified,
  }: {
    rounds: EventRounds;
    roundIndex: number;
    matchIndex: number;
    winnerProfileId: unknown;
    participantsById: EventParticipants;
    winnerDisqualified?: boolean;
  }) => boolean;
  buildFixedBracketState: (
    input: Omit<FixedBracketInput, "buildRandomGameSeed">,
  ) => Promise<{
    bracketSize: number;
    roundCount: number;
    currentRoundIndex: number;
    rounds: EventRounds;
    thirdPlaceMatch: EventMatch | null;
    inviteUpdates: EventCommitPlan;
  }>;
  buildScheduledEventDueUpdates: (
    input: {
      eventId: string;
      event: EventData;
      nowMs: number;
    } & Omit<EventStartTransitionDependencies, "buildRandomGameSeed">,
  ) => Promise<
    import("./startTransitionCore.js").ScheduledEventTransitionResult
  >;
  buildSeedToProfileId: ({
    participantIds,
    random,
  }: {
    participantIds: string[];
    random?: () => number;
  }) => Map<number, string>;
  createEmptyEventMatch: (matchKey: string) => EventMatch;
  getEventPrizePlacements: ({
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
  }: EventPrizePlacementsInput) => EventPlacement[];
  getSortedMatchKeys: (matchesByKey: object | null | undefined) => string[];
  getSortedRoundIndexes: (roundsByKey: object | null | undefined) => number[];
  hasThirdPlaceMatchField: (event: EventData | null | undefined) => boolean;
  isMatchResolved: (match: EventMatch | null | undefined) => boolean;
  isMatchSlotBlocked: (
    match: EventMatch | null | undefined,
    slot: "host" | "guest",
  ) => boolean;
  isMatchWinnerDisqualified: (match: EventMatch | null | undefined) => boolean;
  rebuildParticipantStatesFromRounds: ({
    participantsById,
    rounds,
    winnerProfileId,
    eventEnded,
  }: {
    participantsById: EventParticipants;
    rounds: EventRounds;
    winnerProfileId: unknown;
    eventEnded: boolean;
  }) => {
    didChange: boolean;
    participantsById: EventParticipants;
  };
  recomputeRoundStatuses: ({
    rounds,
    nowMs,
  }: {
    rounds: EventRounds;
    nowMs: number;
  }) => {
    didChange: boolean;
    finalRoundIndex: number | null;
    earliestUnresolvedRoundIndex: number | null;
    finalRoundWinnerProfileId: string | null;
  };
  reconcileBracketMatchReadiness: (
    input: Omit<MatchReadinessInput, "buildRandomGameSeed">,
  ) => Promise<boolean>;
  reconcileProfileEventPrizeAssignments: ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }: PrizeProjectionInput) => Promise<{
    didChange: boolean;
  }>;
  reconcileThirdPlaceMatchReadiness: (
    input: Omit<
      MatchReadinessInput,
      "buildRandomGameSeed" | "ownershipSnapshot"
    > &
      ThirdPlaceReadinessOptions,
  ) => Promise<
    | {
        didChange: boolean;
        thirdPlaceMatch: null;
      }
    | {
        didChange: boolean;
        thirdPlaceMatch: EventMatch;
      }
  >;
  removeCompletedEventPrizeProjections: ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }: PrizeProjectionInput) => Promise<void>;
  resolveEventPrizeAssignments: ({
    eventId,
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
    assignedAtMs,
    ownershipSnapshot,
    prizeSelections,
  }: EventPrizePlacementsInput & {
    eventId: string;
    assignedAtMs: number;
    ownershipSnapshot: EventOwnershipSnapshot | null;
    prizeSelections?: Record<string, string> | null;
  }) => Promise<{
    assignments: Record<string, EventPrizeAssignmentRecord>;
    didCreate: boolean;
  }>;
  resolveRoundMatchState: (
    matchRecord: EventMatch | null,
    matchPair?: [unknown, unknown],
  ) => Promise<MatchResolution | null>;
  resolveRoundMatchesWithConcurrency: (
    matchesByKey: EventMatchesDocument,
  ) => Promise<
    {
      matchKey: string;
      matchRecord: EventMatch | null;
      resolved: MatchResolution | null;
    }[]
  >;
  setMatchSlotBlocked: typeof import("./documents.js").setEventMatchSlotBlocked;
  setMatchSlotParticipant: typeof import("./documents.js").copyEventParticipantToMatchSlot;
};
export type EventBracketRuntime = ReturnType<typeof createEventBracketRuntime>;
export declare const addEventPrizeAssignmentUpdates: ({
    updates,
    eventId,
    assignments,
    includeEventAssignments,
  }: {
    updates: EventCommitPlan;
    eventId: string;
    assignments: Record<string, EventPrizeAssignmentRecord>;
    includeEventAssignments: boolean;
  }) => Promise<void>,
  buildFixedBracketState: (
    input: Omit<FixedBracketInput, "buildRandomGameSeed">,
  ) => Promise<{
    bracketSize: number;
    roundCount: number;
    currentRoundIndex: number;
    rounds: EventRounds;
    thirdPlaceMatch: EventMatch | null;
    inviteUpdates: EventCommitPlan;
  }>,
  buildScheduledEventDueUpdates: (
    input: {
      eventId: string;
      event: EventData;
      nowMs: number;
    } & Omit<EventStartTransitionDependencies, "buildRandomGameSeed">,
  ) => Promise<
    import("./startTransitionCore.js").ScheduledEventTransitionResult
  >,
  getEventPrizePlacements: ({
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
  }: EventPrizePlacementsInput) => EventPlacement[],
  rebuildParticipantStatesFromRounds: ({
    participantsById,
    rounds,
    winnerProfileId,
    eventEnded,
  }: {
    participantsById: EventParticipants;
    rounds: EventRounds;
    winnerProfileId: unknown;
    eventEnded: boolean;
  }) => {
    didChange: boolean;
    participantsById: EventParticipants;
  },
  reconcileBracketMatchReadiness: (
    input: Omit<MatchReadinessInput, "buildRandomGameSeed">,
  ) => Promise<boolean>,
  reconcileProfileEventPrizeAssignments: ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }: PrizeProjectionInput) => Promise<{
    didChange: boolean;
  }>,
  reconcileThirdPlaceMatchReadiness: (
    input: Omit<
      MatchReadinessInput,
      "buildRandomGameSeed" | "ownershipSnapshot"
    > &
      ThirdPlaceReadinessOptions,
  ) => Promise<
    | {
        didChange: boolean;
        thirdPlaceMatch: null;
      }
    | {
        didChange: boolean;
        thirdPlaceMatch: EventMatch;
      }
  >,
  removeCompletedEventPrizeProjections: ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }: PrizeProjectionInput) => Promise<void>,
  resolveEventPrizeAssignments: ({
    eventId,
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
    assignedAtMs,
    ownershipSnapshot,
    prizeSelections,
  }: EventPrizePlacementsInput & {
    eventId: string;
    assignedAtMs: number;
    ownershipSnapshot: EventOwnershipSnapshot | null;
    prizeSelections?: Record<string, string> | null;
  }) => Promise<{
    assignments: Record<string, EventPrizeAssignmentRecord>;
    didCreate: boolean;
  }>,
  resolveRoundMatchState: (
    matchRecord: EventMatch | null,
    matchPair?: [unknown, unknown],
  ) => Promise<MatchResolution | null>,
  resolveRoundMatchesWithConcurrency: (
    matchesByKey: EventMatchesDocument,
  ) => Promise<
    {
      matchKey: string;
      matchRecord: EventMatch | null;
      resolved: MatchResolution | null;
    }[]
  >;
export {
  createEventBracketRuntime,
  applyMatchResolution,
  assignWinnerToNextRound,
  buildSeedToProfileId,
  createEmptyEventMatch,
  getSortedMatchKeys,
  getSortedRoundIndexes,
  hasThirdPlaceMatchField,
  isMatchResolved,
  isMatchSlotBlocked,
  isMatchWinnerDisqualified,
  recomputeRoundStatuses,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
};
