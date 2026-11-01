import type { RunningMatchTimer } from "@mons/shared/timers";

export type MatchTimerStartCandidate = {
  timer: RunningMatchTimer;
  turnNumber: number;
};

export type MatchTimerStartMarker = MatchTimerStartCandidate & {
  updatedAtMs: number;
};
