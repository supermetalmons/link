import { isSafeRecordKey } from "./ids.js";

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

const MATCH_TIMER_DURATION_MS = 90000;
const MATCH_TIMER_DURATION_SECONDS: 90 = (MATCH_TIMER_DURATION_MS / 1000) as 90;
const MATCH_TIMER_TERMINAL = "gg";
const MATCH_TIMER_CLAIM_ROOT = "matchTimerClaims";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: object,
  expectedKeys: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};

const formatMatchTimer = (
  turnNumber: number,
  targetTimestamp: number,
): string => `${turnNumber};${targetTimestamp}`;

const parseMatchTimer = (value: unknown): ParsedMatchTimer | null => {
  if (typeof value !== "string") {
    return null;
  }
  const [turnNumber, targetTimestamp] = value.split(";").map(Number);
  if (
    typeof turnNumber !== "number" ||
    Number.isNaN(turnNumber) ||
    typeof targetTimestamp !== "number" ||
    Number.isNaN(targetTimestamp)
  ) {
    return null;
  }
  return {
    turnNumber,
    targetTimestamp,
  };
};

const parseStrictMatchTimer = (value: unknown): ParsedMatchTimer | null => {
  if (typeof value !== "string" || !/^\d+;\d+$/.test(value)) {
    return null;
  }
  const parsed = parseMatchTimer(value);
  return parsed !== null &&
    Number.isSafeInteger(parsed.turnNumber) &&
    parsed.turnNumber >= 0 &&
    Number.isSafeInteger(parsed.targetTimestamp) &&
    parsed.targetTimestamp > 0
    ? parsed
    : null;
};

const isStartMatchTimerRequest = (
  value: unknown,
): value is StartMatchTimerRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "opponentId", "matchId", "inviteId"]) &&
  isSafeRecordKey(value.playerId) &&
  isSafeRecordKey(value.opponentId) &&
  isSafeRecordKey(value.matchId) &&
  isSafeRecordKey(value.inviteId) &&
  value.playerId.trim() !== value.opponentId.trim();

const isClaimMatchVictoryByTimerRequest: (
  value: unknown,
) => value is ClaimMatchVictoryByTimerRequest = isStartMatchTimerRequest;

const isStartMatchTimerResponse = (
  value: unknown,
): value is StartMatchTimerResponse => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "timer", "duration"]) ||
    value.ok !== true ||
    value.duration !== MATCH_TIMER_DURATION_MS
  ) {
    return false;
  }
  return parseStrictMatchTimer(value.timer) !== null;
};

const isClaimMatchVictoryByTimerResponse = (
  value: unknown,
): value is ClaimMatchVictoryByTimerResponse =>
  isRecord(value) && hasExactKeys(value, ["ok"]) && value.ok === true;

export {
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_DURATION_SECONDS,
  MATCH_TIMER_TERMINAL,
  MATCH_TIMER_CLAIM_ROOT,
  formatMatchTimer,
  parseMatchTimer,
  parseStrictMatchTimer,
  isClaimMatchVictoryByTimerRequest,
  isClaimMatchVictoryByTimerResponse,
  isStartMatchTimerRequest,
  isStartMatchTimerResponse,
};
