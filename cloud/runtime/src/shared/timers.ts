import { isSafeRecordKey } from "./ids.js";

export type IdleMatchTimer = { state: "idle" };
export type RunningMatchTimer = {
  state: "running";
  turnNumber: number;
  deadlineAtMs: number;
};
export type FinishedMatchTimer = { state: "finished" };
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

const MATCH_TIMER_DURATION_MS = 90000;
const MATCH_TIMER_DURATION_SECONDS: 90 = (MATCH_TIMER_DURATION_MS / 1000) as 90;
const MATCH_TIMER_TERMINAL: FinishedMatchTimer = Object.freeze({
  state: "finished",
});
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
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const key = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && isSafeRecordKey(value);

export function isMatchTimer(value: unknown): value is MatchTimer {
  if (!isRecord(value)) return false;
  if (value.state === "idle" || value.state === "finished")
    return hasExactKeys(value, ["state"]);
  return (
    value.state === "running" &&
    hasExactKeys(value, ["state", "turnNumber", "deadlineAtMs"]) &&
    integer(value.turnNumber) &&
    integer(value.deadlineAtMs, 1)
  );
}

export function isRunningMatchTimer(
  value: unknown,
): value is RunningMatchTimer {
  return isMatchTimer(value) && value.state === "running";
}

export function matchTimersEqual(left: MatchTimer, right: MatchTimer): boolean {
  return (
    left.state === right.state &&
    (left.state !== "running" ||
      (right.state === "running" &&
        left.turnNumber === right.turnNumber &&
        left.deadlineAtMs === right.deadlineAtMs))
  );
}

export function isTimerClaim(value: unknown): value is TimerClaim {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "status",
      "inviteId",
      "playerId",
      "opponentId",
      "timer",
      "turnNumber",
      "claimedAtMs",
      "expiresAtMs",
    ]) ||
    value.schemaVersion !== 1 ||
    !key(value.inviteId) ||
    !key(value.playerId) ||
    !key(value.opponentId) ||
    value.playerId === value.opponentId ||
    !integer(value.turnNumber) ||
    !isMatchTimer(value.timer) ||
    value.timer.state === "idle" ||
    (value.timer.state === "running" &&
      value.timer.turnNumber !== value.turnNumber)
  )
    return false;
  return value.status === "pending"
    ? value.timer.state === "running" &&
        value.claimedAtMs === null &&
        integer(value.expiresAtMs)
    : value.status === "claimed" &&
        integer(value.claimedAtMs) &&
        value.expiresAtMs === null;
}

const formatMatchTimer = (
  turnNumber: number,
  deadlineAtMs: number,
): RunningMatchTimer => {
  const timer: RunningMatchTimer = {
    state: "running",
    turnNumber,
    deadlineAtMs,
  };
  if (!isRunningMatchTimer(timer)) throw new TypeError("invalid-match-timer");
  return timer;
};
const parseMatchTimer = (value: unknown): RunningMatchTimer | null =>
  isRunningMatchTimer(value) ? value : null;
const parseStrictMatchTimer = parseMatchTimer;

const isStartMatchTimerRequest = (
  value: unknown,
): value is StartMatchTimerRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "opponentId", "matchId", "inviteId"]) &&
  key(value.playerId) &&
  key(value.opponentId) &&
  key(value.matchId) &&
  key(value.inviteId) &&
  value.playerId !== value.opponentId;
const isClaimMatchVictoryByTimerRequest: (
  value: unknown,
) => value is ClaimMatchVictoryByTimerRequest = isStartMatchTimerRequest;
const isStartMatchTimerResponse = (
  value: unknown,
): value is StartMatchTimerResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "timer", "duration"]) &&
  value.ok === true &&
  value.duration === MATCH_TIMER_DURATION_MS &&
  isRunningMatchTimer(value.timer);
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
  isStartMatchTimerRequest,
  isStartMatchTimerResponse,
  isClaimMatchVictoryByTimerResponse,
};
