// Generated from src/events/startTransitionCore.ts. Run npm run generate:runtime.
import type { EventCommitPlan } from "../eventCommands.js";
import type { EventOwnershipSnapshot } from "./ownership.js";
import type {
  EventData,
  EventParticipant,
  EventMatch,
  EventRounds,
  MatchResolution,
  MatchReadinessInput,
  BuildGameSeed,
} from "./model.js";
export type ScheduledEventTransitionResult = {
  didChange: boolean;
  updates: EventCommitPlan;
};
export type EventStartTransitionDependencies = {
  random?: () => number;
  buildRandomGameSeed: BuildGameSeed;
  ownershipSnapshot: EventOwnershipSnapshot | null;
  prizeSelections?: Record<string, string> | null;
};
export type FixedBracketInput = {
  eventId: string;
  participantIds: string[];
  participantsById: Record<string, EventParticipant>;
  nowMs: number;
  enableThirdPlace?: boolean;
  random?: () => number;
  buildRandomGameSeed: BuildGameSeed;
  ownershipSnapshot: EventOwnershipSnapshot;
};
export type ThirdPlaceReadinessOptions = {
  thirdPlaceMatch: EventMatch | null;
} & (
  | {
      allowInviteCreation: false;
      ownershipSnapshot?: EventOwnershipSnapshot | null;
    }
  | {
      allowInviteCreation?: true;
      ownershipSnapshot: EventOwnershipSnapshot | null;
    }
);
export type ThirdPlaceReadinessInput = Omit<
  MatchReadinessInput,
  "ownershipSnapshot"
> &
  ThirdPlaceReadinessOptions;
declare const getSortedMatchKeys: (
  matchesByKey: object | null | undefined,
) => string[];
declare const getSortedRoundIndexes: (
  roundsByKey: object | null | undefined,
) => number[];
declare const isMatchWinnerDisqualified: (
  match: EventMatch | null | undefined,
) => boolean;
declare const isMatchResolved: (
  match: EventMatch | null | undefined,
) => boolean;
declare const isMatchSlotBlocked: (
  match: EventMatch | null | undefined,
  slot: "host" | "guest",
) => boolean;
declare const buildSeedToProfileId: ({
  participantIds,
  random,
}: {
  participantIds: string[];
  random?: () => number;
}) => Map<number, string>;
declare const createEmptyEventMatch: (matchKey: string) => EventMatch;
declare const hasThirdPlaceMatchField: (
  event: EventData | null | undefined,
) => boolean;
declare const setMatchSlotBlocked: (
  match: EventMatch,
  slot: "host" | "guest",
  blocked: boolean,
) => boolean;
declare const setMatchSlotParticipant: (
  match: EventMatch,
  slot: "host" | "guest",
  participant: EventParticipant | null,
) => boolean;
declare const applyMatchResolution: (
  match: EventMatch | null,
  resolved: MatchResolution | null,
  nowMs: number,
) => boolean;
declare const assignWinnerToNextRound: ({
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
  participantsById: Record<string, EventParticipant>;
  winnerDisqualified?: boolean;
}) => boolean;
declare const createInviteForMatch: ({
  eventId,
  roundIndex,
  matchKey,
  match,
  inviteUpdates,
  random,
  buildRandomGameSeed,
  ownershipSnapshot,
}: {
  eventId: string;
  roundIndex: number | null;
  matchKey: string;
  match: EventMatch;
  inviteUpdates: EventCommitPlan;
  random?: () => number;
  buildRandomGameSeed: BuildGameSeed;
  ownershipSnapshot?: EventOwnershipSnapshot | null;
}) => Promise<boolean>;
declare const reconcileThirdPlaceMatchReadiness: ({
  eventId,
  rounds,
  nowMs,
  participantsById,
  inviteUpdates,
  thirdPlaceMatch,
  random,
  buildRandomGameSeed,
  allowInviteCreation,
  ownershipSnapshot,
}: ThirdPlaceReadinessInput) => Promise<
  | {
      didChange: boolean;
      thirdPlaceMatch: null;
    }
  | {
      didChange: boolean;
      thirdPlaceMatch: EventMatch;
    }
>;
declare const reconcileBracketMatchReadiness: ({
  eventId,
  rounds,
  nowMs,
  participantsById,
  inviteUpdates,
  random,
  buildRandomGameSeed,
  ownershipSnapshot,
}: MatchReadinessInput) => Promise<boolean>;
declare const recomputeRoundStatuses: ({
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
declare const buildFixedBracketState: ({
  eventId,
  participantIds,
  participantsById,
  nowMs,
  enableThirdPlace,
  random,
  buildRandomGameSeed,
  ownershipSnapshot,
}: FixedBracketInput) => Promise<{
  bracketSize: number;
  roundCount: number;
  currentRoundIndex: number;
  rounds: EventRounds;
  thirdPlaceMatch: EventMatch | null;
  inviteUpdates: EventCommitPlan;
}>;
declare const buildScheduledEventDueUpdatesCore: ({
  eventId,
  event,
  nowMs,
  random,
  buildRandomGameSeed,
  ownershipSnapshot,
  prizeSelections,
}: {
  eventId: string;
  event: EventData;
  nowMs: number;
} & EventStartTransitionDependencies) => Promise<ScheduledEventTransitionResult>;
export {
  applyMatchResolution,
  assignWinnerToNextRound,
  buildSeedToProfileId,
  buildFixedBracketState,
  buildScheduledEventDueUpdatesCore,
  createEmptyEventMatch,
  createInviteForMatch,
  getSortedMatchKeys,
  getSortedRoundIndexes,
  hasThirdPlaceMatchField,
  isMatchResolved,
  isMatchSlotBlocked,
  isMatchWinnerDisqualified,
  recomputeRoundStatuses,
  reconcileBracketMatchReadiness,
  reconcileThirdPlaceMatchReadiness,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
};
