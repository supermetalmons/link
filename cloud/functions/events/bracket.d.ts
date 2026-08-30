import type { EventOwnershipSnapshot } from "./ownership.js";

export type EventBracketAdmin = {
  database(): {
    ref(path?: string): {
      once(event: "value"): Promise<{ exists(): boolean; val(): unknown }>;
      transaction(
        updater: (current: unknown) => unknown,
        onComplete?: unknown,
        applyLocally?: boolean,
      ): Promise<{ committed: boolean }>;
    };
  };
};

export type EventBracketRuntime = {
  addEventPrizeAssignmentUpdates(input: Record<string, unknown>): Promise<void>;
  applyMatchResolution(
    matchRecord: Record<string, unknown>,
    resolved: Record<string, unknown>,
    nowMs: number,
  ): boolean;
  buildScheduledEventDueUpdates(input: Record<string, unknown>): Promise<{
    didChange: boolean;
    updates: Record<string, unknown>;
  }>;
  getSortedRoundIndexes(rounds: unknown): number[];
  hasThirdPlaceMatchField(event: unknown): boolean;
  isMatchResolved(match: unknown): boolean;
  isMatchWinnerDisqualified(match: unknown): boolean;
  rebuildParticipantStatesFromRounds(input: Record<string, unknown>): {
    didChange: boolean;
    participantsById: Record<string, unknown>;
  };
  recomputeRoundStatuses(
    input: Record<string, unknown>,
  ): Record<string, unknown>;
  reconcileBracketMatchReadiness(
    input: Record<string, unknown> & {
      ownershipSnapshot: EventOwnershipSnapshot;
    },
  ): Promise<boolean>;
  reconcileProfileEventPrizeAssignments(
    input: Record<string, unknown>,
  ): Promise<{ didChange: boolean }>;
  reconcileThirdPlaceMatchReadiness(
    input: Record<string, unknown> & {
      ownershipSnapshot: EventOwnershipSnapshot;
    },
  ): Promise<{
    didChange: boolean;
    thirdPlaceMatch: Record<string, unknown> | null;
  }>;
  removeCompletedEventPrizeProjections(
    input: Record<string, unknown>,
  ): Promise<void>;
  resolveEventPrizeAssignments(input: Record<string, unknown>): Promise<{
    assignments: Record<string, unknown>;
    didCreate: boolean;
  }>;
  resolveRoundMatchState(
    match: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  resolveRoundMatchesWithConcurrency(matches: Record<string, unknown>): Promise<
    Array<{
      matchKey: string;
      matchRecord: Record<string, unknown>;
      resolved: Record<string, unknown> | null;
    }>
  >;
};

export function createEventBracketRuntime(dependencies: {
  admin: EventBracketAdmin;
  batchReadWithRetry?: (
    refs: unknown[],
  ) => Promise<Array<{ exists(): boolean; val(): unknown }>>;
  buildRandomGameSeed?: (random?: () => number) => Promise<unknown>;
  resolveMatchWinner?: (
    match: unknown,
    opponentMatch: unknown,
  ) => Promise<{ winner: "player" | "opponent" | null; reason: string }>;
  readEventPrizeWithdrawals: (
    eventId: string,
  ) => Promise<Record<string, Record<string, unknown>>>;
}): EventBracketRuntime;

export function getEventPrizePlacements(
  input: Record<string, unknown>,
): Array<Record<string, unknown>>;
export function getSortedRoundIndexes(rounds: unknown): number[];
export function hasThirdPlaceMatchField(event: unknown): boolean;
export function isMatchResolved(match: unknown): boolean;
export function isMatchWinnerDisqualified(match: unknown): boolean;
