import { AuthApiFailure, type AuthErrorCode } from "./authErrors.ts";
import type {
  SubmitMoveResponse,
  SurrenderMatchResponse,
} from "@mons/shared/game-sessions";
import type {
  ClaimMatchVictoryByTimerResponse,
  StartMatchTimerResponse,
} from "@mons/shared/timers";
import type {
  MatchStateClaimTimerRequest,
  MatchStateCreateRequest,
  MatchStateCreateResult,
  MatchStateEventEffectsRequest,
  MatchStateMoveRequest,
  MatchStatePair,
  MatchStatePairRequest,
  MatchStateRecord,
  MatchStateRecordRequest,
  MatchStateStartTimerRequest,
  MatchStateSurrenderRequest,
} from "./matchStateTypes.ts";

export type MatchStateRpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      code: AuthErrorCode;
      message: string;
    };

export type MatchStateRpc = {
  readCanonicalMatchRecord(
    input: MatchStateRecordRequest,
  ): Promise<MatchStateRpcResult<MatchStateRecord | null>>;
  readCanonicalMatchPair(
    input: MatchStatePairRequest,
  ): Promise<MatchStateRpcResult<MatchStatePair>>;
  createCanonicalMatch(
    input: MatchStateCreateRequest,
  ): Promise<MatchStateRpcResult<MatchStateCreateResult>>;
  submitCanonicalMove(
    input: MatchStateMoveRequest,
  ): Promise<MatchStateRpcResult<SubmitMoveResponse>>;
  surrenderCanonicalMatch(
    input: MatchStateSurrenderRequest,
  ): Promise<MatchStateRpcResult<SurrenderMatchResponse>>;
  startCanonicalMatchTimer(
    input: MatchStateStartTimerRequest,
  ): Promise<MatchStateRpcResult<StartMatchTimerResponse>>;
  claimCanonicalMatchTimer(
    input: MatchStateClaimTimerRequest,
  ): Promise<MatchStateRpcResult<ClaimMatchVictoryByTimerResponse>>;
  applyCanonicalMatchEventEffects(
    input: MatchStateEventEffectsRequest,
  ): Promise<MatchStateRpcResult<MatchStateCreateResult>>;
};

export function getMatchStateRpc(
  env: Pick<Env, "INVITE_REACTIONS">,
  inviteId: string,
): MatchStateRpc {
  const stub: object = env.INVITE_REACTIONS.getByName(inviteId);
  return stub as MatchStateRpc;
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

export function unwrapMatchStateRpc<T>(result: MatchStateRpcResult<T>): T {
  if (result.ok) return result.value;
  throw new AuthApiFailure(result.status, result.code, result.message);
}
