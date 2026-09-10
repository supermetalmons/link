import type { WagerStateSnapshot } from "./wagerStateD1.ts";

export function composeInviteWagerSource(
  source: unknown,
  states: readonly WagerStateSnapshot[],
  shallow = false,
): unknown {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return source;
  }
  const invite: Record<string, unknown> = { ...source };
  delete invite.wagers;
  delete invite.matchesWagerResolutions;
  const wagers = Object.fromEntries(
    states
      .filter((state) => state.wager !== null)
      .map((state) => [state.matchId, state.wager]),
  );
  const markers = Object.fromEntries(
    states
      .filter((state) => state.resolutionMarker !== null)
      .map((state) => [state.matchId, state.resolutionMarker]),
  );
  if (Object.keys(wagers).length) invite.wagers = shallow ? true : wagers;
  if (Object.keys(markers).length) {
    invite.matchesWagerResolutions = shallow ? true : markers;
  }
  return invite;
}
