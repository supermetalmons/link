// Generated from src/shared/timers.ts. Run npm run generate:runtime.
export interface ParsedMatchTimer {
  turnNumber: number;
  targetTimestamp: number;
}
export interface StartMatchTimerRequest {
  playerId: string;
  opponentId: string;
  matchId: string;
  inviteId: string;
}
export interface StartMatchTimerResponse {
  ok: true;
  timer: string;
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
declare const MATCH_TIMER_DURATION_MS = 90000;
declare const MATCH_TIMER_DURATION_SECONDS: 90;
declare const MATCH_TIMER_TERMINAL = "gg";
declare const MATCH_TIMER_CLAIM_ROOT = "matchTimerClaims";
declare const formatMatchTimer: (
  turnNumber: number,
  targetTimestamp: number,
) => string;
declare const parseMatchTimer: (value: unknown) => ParsedMatchTimer | null;
declare const isMatchTimerTerminal: (
  value: unknown,
) => value is typeof MATCH_TIMER_TERMINAL;
declare const parseStrictMatchTimer: (
  value: unknown,
) => ParsedMatchTimer | null;
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
  isMatchTimerTerminal,
  isClaimMatchVictoryByTimerRequest,
  isClaimMatchVictoryByTimerResponse,
  isStartMatchTimerRequest,
  isStartMatchTimerResponse,
};
