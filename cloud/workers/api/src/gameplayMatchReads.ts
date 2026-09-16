import type { GameplayRepository } from "./gameplayRepository.ts";
import type { MatchStatePairRequest } from "./matchStateTypes.ts";

export async function readGameplayMatchPair(
  repository: Pick<GameplayRepository, "readMatchPair">,
  request: Omit<MatchStatePairRequest, "epoch">,
  signal?: AbortSignal,
): Promise<[unknown, unknown]> {
  const pair = await repository.readMatchPair(request, signal);
  return [pair.playerMatch, pair.opponentMatch];
}

export async function readGameplayMatchPairs(
  repository: Pick<GameplayRepository, "readMatchPairs">,
  requests: readonly Omit<MatchStatePairRequest, "epoch">[],
  signal?: AbortSignal,
): Promise<Array<[unknown, unknown]>> {
  const pairs = await repository.readMatchPairs(requests, signal);
  return pairs.map((pair) => [pair.playerMatch, pair.opponentMatch]);
}
