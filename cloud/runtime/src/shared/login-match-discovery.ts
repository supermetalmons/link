import { isSafeRecordKey } from "./ids.js";
import { createInviteCandidatesFromMatchId } from "./rematches.js";

export type MatchDiscoveryResolution = "resolved" | "missing" | "ambiguous";

export type MatchDiscoveryEntry = {
  matchId: string;
  inviteId: string | null;
  resolution: MatchDiscoveryResolution;
};

export type MatchDiscoveryPage = {
  entries: MatchDiscoveryEntry[];
  hasMore: boolean;
};

function matchDiscoverySortKey(matchId: string): string {
  if (typeof matchId !== "string" || !isSafeRecordKey(matchId)) {
    throw new TypeError("invalid-discovery-match-id");
  }
  let key = "";
  for (let index = 0; index < matchId.length; index++) {
    key += matchId.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return key;
}

async function resolveMatchDiscoveryInvite(
  matchId: string,
  hasInvite: (inviteId: string) => boolean | Promise<boolean>,
): Promise<Pick<MatchDiscoveryEntry, "inviteId" | "resolution">> {
  matchDiscoverySortKey(matchId);
  const normalizedMatchId = matchId.trim();
  if (await hasInvite(normalizedMatchId)) {
    return { inviteId: normalizedMatchId, resolution: "resolved" };
  }
  const existing = [];
  for (const candidate of createInviteCandidatesFromMatchId(
    normalizedMatchId,
  )) {
    if (await hasInvite(candidate)) existing.push(candidate);
  }
  if (existing.length > 1) {
    return { inviteId: null, resolution: "ambiguous" };
  }
  return existing.length === 1
    ? { inviteId: existing[0], resolution: "resolved" }
    : { inviteId: null, resolution: "missing" };
}

export { matchDiscoverySortKey, resolveMatchDiscoveryInvite };
