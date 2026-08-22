export type ScheduledEventTransitionResult = {
  didChange: boolean;
  updates: Record<string, unknown>;
};

export type EventStartTransitionDependencies = {
  random?: () => number;
  buildRandomGameSeed(random?: () => number): unknown | Promise<unknown>;
};

export function buildFixedBracketState(input: {
  eventId: string;
  participantIds: string[];
  participantsById: Record<string, Record<string, unknown>>;
  nowMs: number;
  enableThirdPlace?: boolean;
  random?: () => number;
  buildRandomGameSeed(random?: () => number): unknown | Promise<unknown>;
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
