import {
  parseInviteMatchIndex,
  parseRematchIndices,
  type RematchInviteData,
} from "@mons/shared/rematches";

export function registeredInviteMatchIndex(
  inviteId: string,
  matchId: string,
  rematches: Readonly<RematchInviteData>,
): number | null {
  const index = parseInviteMatchIndex(inviteId, matchId);
  if (index === null || index === 0) return index;
  return parseRematchIndices(rematches.hostRematches).includes(index) ||
    parseRematchIndices(rematches.guestRematches).includes(index)
    ? index
    : null;
}
