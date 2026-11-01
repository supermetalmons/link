import type { InviteDocument } from "@mons/shared/invite-records";
import type { WagerRecord } from "./wagerModel.ts";
import type { WagerStateSnapshot } from "./wagerStateD1.ts";

export type InviteWagerDocument = {
  invite: InviteDocument;
  wagers: Record<string, WagerRecord>;
  resolutionMarkers: Record<string, boolean>;
};

export function composeInviteWagerSource(
  invite: InviteDocument | null,
  states: readonly WagerStateSnapshot[],
): InviteWagerDocument | null {
  if (invite === null) return null;
  const wagers: Record<string, WagerRecord> = {};
  const resolutionMarkers: Record<string, boolean> = {};
  for (const state of states) {
    if (state.wager !== null) wagers[state.matchId] = state.wager;
    if (state.resolutionMarker !== null)
      resolutionMarkers[state.matchId] = state.resolutionMarker;
  }
  return { invite, wagers, resolutionMarkers };
}
