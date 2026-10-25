import { AuthApiFailure, type AuthErrorCode } from "./authErrors.ts";
import {
  isSubmitMoveResponse,
  isSurrenderMatchResponse,
  type SubmitMoveResponse,
  type SurrenderMatchResponse,
} from "@mons/shared/game-sessions";
import {
  isClaimMatchVictoryByTimerResponse,
  isStartMatchTimerResponse,
  type ClaimMatchVictoryByTimerResponse,
  type StartMatchTimerResponse,
} from "@mons/shared/timers";
import {
  readRetainedMatchValue,
  type RetainedMatchValue,
} from "./matchRecordCodec.ts";
import type { InviteReactions } from "./inviteReactions.ts";
import type {
  MatchStatePair,
  MatchStateCreateResult,
} from "./matchStateTypes.ts";
import { readRetainedTimerClaim } from "./matchClaimCodec.ts";

export type MatchStateRpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      code: AuthErrorCode;
      message: string;
    };

type MatchStateRpcMethod =
  | "readCanonicalMatchRecord"
  | "readCanonicalMatchRecords"
  | "readCanonicalMatchPair"
  | "createCanonicalMatch"
  | "submitCanonicalMove"
  | "surrenderCanonicalMatch"
  | "startCanonicalMatchTimer"
  | "claimCanonicalMatchTimer"
  | "applyCanonicalMatchEventEffects";

export type MatchStateRpc = Pick<
  DurableObjectStub<InviteReactions>,
  MatchStateRpcMethod
>;

export function getMatchStateRpc(
  env: Pick<Env, "INVITE_REACTIONS">,
  inviteId: string,
): MatchStateRpc {
  const stub = env.INVITE_REACTIONS.getByName(inviteId);
  return {
    readCanonicalMatchRecord: (input) => stub.readCanonicalMatchRecord(input),
    readCanonicalMatchRecords: (input) => stub.readCanonicalMatchRecords(input),
    readCanonicalMatchPair: (input) => stub.readCanonicalMatchPair(input),
    createCanonicalMatch: (input) => stub.createCanonicalMatch(input),
    submitCanonicalMove: (input) => stub.submitCanonicalMove(input),
    surrenderCanonicalMatch: (input) => stub.surrenderCanonicalMatch(input),
    startCanonicalMatchTimer: (input) => stub.startCanonicalMatchTimer(input),
    claimCanonicalMatchTimer: (input) => stub.claimCanonicalMatchTimer(input),
    applyCanonicalMatchEventEffects: (input, options) =>
      stub.applyCanonicalMatchEventEffects(input, options),
  };
}

export async function captureMatchStateRpc<T>(
  work: () => T | Promise<T>,
): Promise<MatchStateRpcResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const failure =
      error instanceof AuthApiFailure
        ? error
        : new AuthApiFailure(503, "unavailable", "match-state-unavailable");
    if (!(error instanceof AuthApiFailure)) {
      console.error({
        event: "match_state_rpc_failed",
        kind: error instanceof Error ? error.name : "unknown",
      });
    }
    return {
      ok: false,
      status: failure.status,
      code: failure.code,
      message: failure.message,
    };
  }
}

function unavailable(): never {
  throw new AuthApiFailure(503, "unavailable", "match-state-unavailable");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(value: unknown): value is AuthErrorCode {
  return (
    value === "aborted" ||
    value === "deadline-exceeded" ||
    value === "failed-precondition" ||
    value === "internal" ||
    value === "invalid-argument" ||
    value === "method-not-allowed" ||
    value === "not-found" ||
    value === "permission-denied" ||
    value === "resource-exhausted" ||
    value === "unauthenticated" ||
    value === "unavailable"
  );
}

export function unwrapMatchStateRpc<T>(
  result: unknown,
  decode: (value: unknown) => T,
): T {
  if (!record(result)) unavailable();
  if (result.ok === true) return decode(result.value);
  if (
    result.ok !== false ||
    typeof result.status !== "number" ||
    !errorCode(result.code) ||
    typeof result.message !== "string"
  )
    unavailable();
  throw new AuthApiFailure(result.status, result.code, result.message);
}

export function decodeMatchStatePair(value: unknown): MatchStatePair {
  if (
    !record(value) ||
    typeof value.inviteId !== "string" ||
    typeof value.matchId !== "string" ||
    typeof value.playerId !== "string" ||
    !(value.opponentId === null || typeof value.opponentId === "string") ||
    typeof value.epoch !== "number" ||
    typeof value.revision !== "number"
  )
    unavailable();
  return {
    ...value,
    inviteId: value.inviteId,
    matchId: value.matchId,
    playerId: value.playerId,
    opponentId: value.opponentId,
    epoch: value.epoch,
    revision: value.revision,
    playerMatch: readRetainedMatchValue(value.playerMatch),
    opponentMatch: readRetainedMatchValue(value.opponentMatch),
    claim: readRetainedTimerClaim(value.claim),
  };
}

export function decodeMatchStateCreateResult(
  value: unknown,
): MatchStateCreateResult {
  if (
    !record(value) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.changedMatchIds) ||
    !Array.from(value.changedMatchIds).every(
      (id): id is string => typeof id === "string",
    )
  )
    unavailable();
  return {
    ...value,
    records: Array.from(value.records, (entry) => {
      if (
        !record(entry) ||
        typeof entry.matchId !== "string" ||
        typeof entry.playerId !== "string" ||
        (entry.outcome !== "created" && entry.outcome !== "already-created")
      )
        unavailable();
      return {
        ...entry,
        matchId: entry.matchId,
        playerId: entry.playerId,
        outcome: entry.outcome,
        value: readRetainedMatchValue(entry.value),
      };
    }),
    changedMatchIds: value.changedMatchIds,
  };
}

export function decodeRoutedMatchRecords(
  value: unknown,
  count: number,
): RetainedMatchValue[] {
  if (!Array.isArray(value) || value.length !== count)
    throw new Error("match-state-record-unavailable");
  return Array.from(value, (entry) => {
    if (entry === null || entry === undefined)
      throw new Error("match-state-record-unavailable");
    return readRetainedMatchValue(entry);
  });
}

export function decodeMatchMoveResponse(value: unknown): SubmitMoveResponse {
  if (!isSubmitMoveResponse(value)) unavailable();
  return value;
}

export function decodeMatchSurrenderResponse(
  value: unknown,
): SurrenderMatchResponse {
  if (!isSurrenderMatchResponse(value)) unavailable();
  return value;
}

export function decodeMatchTimerStartResponse(
  value: unknown,
): StartMatchTimerResponse {
  if (!isStartMatchTimerResponse(value)) unavailable();
  return value;
}

export function decodeMatchTimerClaimResponse(
  value: unknown,
): ClaimMatchVictoryByTimerResponse {
  if (!isClaimMatchVictoryByTimerResponse(value)) unavailable();
  return value;
}
