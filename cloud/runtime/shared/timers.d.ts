// Generated from src/shared/timers.ts. Run npm run generate:runtime.
export type IdleMatchTimer = {
  state: "idle";
};
export type RunningMatchTimer = {
  state: "running";
  turnNumber: number;
  deadlineAtMs: number;
};
export type FinishedMatchTimer = {
  state: "finished";
};
export type MatchTimer =
  IdleMatchTimer | RunningMatchTimer | FinishedMatchTimer;
export type ParsedMatchTimer = RunningMatchTimer;
export interface StartMatchTimerRequest {
  playerId: string;
  opponentId: string;
  matchId: string;
  inviteId: string;
}
export interface StartMatchTimerResponse {
  ok: true;
  timer: RunningMatchTimer;
  duration: typeof MATCH_TIMER_DURATION_MS;
}
export interface ClaimMatchVictoryByTimerRequest {
  playerId: string;
  opponentId: string;
  matchId: string;
  inviteId: string;
}
export interface ClaimMatchVictoryByTimerResponse {
  ok: true;
}
type TimerClaimIdentity = {
  schemaVersion: 1;
  inviteId: string;
  playerId: string;
  opponentId: string;
  turnNumber: number;
};
export type ClaimedTimerWrite = TimerClaimIdentity & {
  status: "claimed";
  timer: RunningMatchTimer | FinishedMatchTimer;
  claimedAtMs: number;
  expiresAtMs: null;
};
export type PendingTimerClaim = TimerClaimIdentity & {
  status: "pending";
  timer: RunningMatchTimer;
  claimedAtMs: null;
  expiresAtMs: number;
};
export type TimerClaim = PendingTimerClaim | ClaimedTimerWrite;
declare const MATCH_TIMER_DURATION_MS = 90000;
declare const MATCH_TIMER_DURATION_SECONDS: 90;
declare const MATCH_TIMER_TERMINAL: FinishedMatchTimer;
declare const MATCH_TIMER_CLAIM_ROOT = "matchTimerClaims";
export declare function isMatchTimer(value: unknown): value is MatchTimer;
export declare function isRunningMatchTimer(
  value: unknown,
): value is RunningMatchTimer;
export declare function matchTimersEqual(
  left: MatchTimer,
  right: MatchTimer,
): boolean;
export declare function isTimerClaim(value: unknown): value is TimerClaim;
declare const formatMatchTimer: (
  turnNumber: number,
  deadlineAtMs: number,
) => RunningMatchTimer;
declare const parseMatchTimer: (value: unknown) => RunningMatchTimer | null;
declare const parseStrictMatchTimer: (
  value: unknown,
) => RunningMatchTimer | null;
declare const isStartMatchTimerRequest: (
  value: unknown,
) => value is StartMatchTimerRequest;
declare const isClaimMatchVictoryByTimerRequest: (
  value: unknown,
) => value is ClaimMatchVictoryByTimerRequest;
declare const isStartMatchTimerResponse: (
  value: unknown,
) => value is StartMatchTimerResponse;
declare const isClaimMatchVictoryByTimerResponse: (
  value: unknown,
) => value is ClaimMatchVictoryByTimerResponse;
export {
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_DURATION_SECONDS,
  MATCH_TIMER_TERMINAL,
  MATCH_TIMER_CLAIM_ROOT,
  formatMatchTimer,
  parseMatchTimer,
  parseStrictMatchTimer,
  isClaimMatchVictoryByTimerRequest,
  isStartMatchTimerRequest,
  isStartMatchTimerResponse,
  isClaimMatchVictoryByTimerResponse,
};
