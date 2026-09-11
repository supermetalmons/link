import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import type {
  SubmitMoveRequest,
  SurrenderMatchRequest,
} from "@mons/shared/game-sessions";
import type {
  StartMatchTimerRequest,
  ClaimMatchVictoryByTimerRequest,
} from "@mons/shared/timers";

export async function canonicalMatchOperations(env: Env) {
  const control = await requireActiveDurableMatchState(env.PROFILE_GAMES_DB);
  const execute = async <T>(
    work: (epoch: number) => Promise<T>,
  ): Promise<T> => {
    await requireActiveDurableMatchState(env.PROFILE_GAMES_DB, control.epoch);
    return work(control.epoch);
  };
  return {
    submitCanonical: (request: SubmitMoveRequest) =>
      execute(async (epoch) =>
        unwrapMatchStateRpc(
          await getMatchStateRpc(env, request.inviteId).submitCanonicalMove({
            ...request,
            epoch,
          }),
        ),
      ),
    surrenderCanonical: (request: SurrenderMatchRequest) =>
      execute(async (epoch) =>
        unwrapMatchStateRpc(
          await getMatchStateRpc(env, request.inviteId).surrenderCanonicalMatch(
            { ...request, epoch },
          ),
        ),
      ),
    startCanonical: (request: StartMatchTimerRequest) =>
      execute(async (epoch) =>
        unwrapMatchStateRpc(
          await getMatchStateRpc(
            env,
            request.inviteId,
          ).startCanonicalMatchTimer({ ...request, epoch }),
        ),
      ),
    claimCanonical: (
      request: ClaimMatchVictoryByTimerRequest,
      inviteValue: unknown,
    ) =>
      execute(async (epoch) => {
        const invite =
          inviteValue &&
          typeof inviteValue === "object" &&
          !Array.isArray(inviteValue)
            ? (inviteValue as Record<string, unknown>)
            : null;
        return unwrapMatchStateRpc(
          await getMatchStateRpc(
            env,
            request.inviteId,
          ).claimCanonicalMatchTimer({
            ...request,
            epoch,
            eventId:
              invite?.eventOwned === true && typeof invite.eventId === "string"
                ? invite.eventId
                : null,
          }),
        );
      }),
  };
}
