import type { EventOwnershipSnapshot } from "./ownership.js";

export type ScheduledEventTransitionResult = {
  didChange: boolean;
  updates: Record<string, unknown>;
};

export type EventStartTransitionDependencies = {
  random?: () => number;
  buildRandomGameSeed(random?: () => number): unknown | Promise<unknown>;
  ownershipSnapshot: EventOwnershipSnapshot | null;
  prizeSelections?: unknown;
};

export function buildFixedBracketState(input: {
  eventId: string;
  participantIds: string[];
  participantsById: Record<string, Record<string, unknown>>;
  nowMs: number;
  enableThirdPlace?: boolean;
  random?: () => number;
  buildRandomGameSeed(random?: () => number): unknown | Promise<unknown>;
  ownershipSnapshot: EventOwnershipSnapshot;
}): Promise<{
  bracketSize: number;
  roundCount: number;
  currentRoundIndex: number;
  rounds: Record<string, unknown>;
  thirdPlaceMatch: unknown;
  inviteUpdates: Record<string, unknown>;
}>;

export function buildScheduledEventDueUpdatesCore(
  input: {
    eventId: string;
    event: Record<string, unknown>;
    nowMs: number;
  } & EventStartTransitionDependencies,
): Promise<ScheduledEventTransitionResult>;

export function reconcileBracketMatchReadiness(
  input: Record<string, unknown> & {
    ownershipSnapshot: EventOwnershipSnapshot;
  },
): Promise<boolean>;

export function reconcileThirdPlaceMatchReadiness(
  input: Record<string, unknown> & {
    ownershipSnapshot: EventOwnershipSnapshot;
  },
): Promise<{
  didChange: boolean;
  thirdPlaceMatch: Record<string, unknown> | null;
}>;
