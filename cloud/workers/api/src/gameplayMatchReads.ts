import type { GameplayRepository } from "./gameplayRepository.ts";
import type { MatchStatePairRequest } from "./matchStateTypes.ts";

export async function readGameplayMatchPair(
  repository: Pick<GameplayRepository, "getRtdbPath" | "readMatchPair">,
  request: Omit<MatchStatePairRequest, "epoch">,
  signal?: AbortSignal,
): Promise<[unknown, unknown]> {
  if (repository.readMatchPair) {
    const pair = await repository.readMatchPair(request, signal);
    return [pair.playerMatch, pair.opponentMatch];
  }
  const read = (playerId: string | null) =>
    playerId === null
      ? Promise.resolve(null)
      : repository.getRtdbPath(
          `players/${playerId}/matches/${request.matchId}`,
          undefined,
          signal,
        );
  const ids = [request.playerId, request.opponentId];
  const initial = await Promise.allSettled(ids.map(read));
  const values = await Promise.all(
    initial.map((result, index) =>
      result.status === "fulfilled" ? result.value : read(ids[index]),
    ),
  );
  return [values[0], values[1]];
}
