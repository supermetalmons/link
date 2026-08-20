export const MATCH_TIMER_DURATION_MS: 90000;
export const MATCH_TIMER_DURATION_SECONDS: 90;
export const MATCH_TIMER_TERMINAL: "gg";
export const MATCH_TIMER_START_ROOT: "matchTimerStarts";

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

export function formatMatchTimer(
  turnNumber: number,
  targetTimestamp: number,
): string;
export function parseMatchTimer(value: unknown): ParsedMatchTimer | null;
export function parseStrictMatchTimer(value: unknown): ParsedMatchTimer | null;
export function isMatchTimerTerminal(
  value: unknown,
): value is typeof MATCH_TIMER_TERMINAL;
export function isStartMatchTimerRequest(
  value: unknown,
): value is StartMatchTimerRequest;
export function isStartMatchTimerResponse(
  value: unknown,
): value is StartMatchTimerResponse;
