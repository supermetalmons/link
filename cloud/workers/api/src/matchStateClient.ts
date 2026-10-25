import {
  inviteTimerEventId,
  type InviteDocument,
} from "@mons/shared/invite-records";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import {
  getMatchStateRpc,
  unwrapMatchStateRpc,
  decodeMatchMoveResponse,
  decodeMatchSurrenderResponse,
  decodeMatchTimerStartResponse,
  decodeMatchTimerClaimResponse,
} from "./matchStateRpc.ts";
import type {
  SubmitMoveRequest,
  SurrenderMatchRequest,
} from "@mons/shared/game-sessions";
import type {
  StartMatchTimerRequest,
  ClaimMatchVictoryByTimerRequest,
} from "@mons/shared/timers";

export async function canonicalMatchOperations(
  env: Env,
  admittedEpoch?: number,
) {
  const epoch =
    admittedEpoch ??
    (await requireActiveDurableMatchState(env.PROFILE_GAMES_DB)).epoch;
  const execute = async <T>(
    work: (epoch: number) => Promise<T>,
  ): Promise<T> => {
    await requireActiveDurableMatchState(env.PROFILE_GAMES_DB, epoch);
    return work(epoch);
  };
  return {
    submitCanonical: (request: SubmitMoveRequest) =>
      execute(async (epoch) =>
        unwrapMatchStateRpc(
          await getMatchStateRpc(env, request.inviteId).submitCanonicalMove({
            ...request,
            epoch,
          }),
          decodeMatchMoveResponse,
        ),
      ),
    surrenderCanonical: (request: SurrenderMatchRequest) =>
      execute(async (epoch) =>
        unwrapMatchStateRpc(
          await getMatchStateRpc(env, request.inviteId).surrenderCanonicalMatch(
            { ...request, epoch },
          ),
          decodeMatchSurrenderResponse,
        ),
      ),
    startCanonical: (request: StartMatchTimerRequest) =>
      execute(async (epoch) =>
        unwrapMatchStateRpc(
          await getMatchStateRpc(
            env,
            request.inviteId,
          ).startCanonicalMatchTimer({ ...request, epoch }),
          decodeMatchTimerStartResponse,
        ),
      ),
    claimCanonical: (
      request: ClaimMatchVictoryByTimerRequest,
      inviteValue: InviteDocument,
    ) =>
      execute(async (epoch) => {
        return unwrapMatchStateRpc(
          await getMatchStateRpc(
            env,
            request.inviteId,
          ).claimCanonicalMatchTimer({
            ...request,
            epoch,
            eventId: inviteTimerEventId(inviteValue),
          }),
          decodeMatchTimerClaimResponse,
        );
      }),
  };
}
