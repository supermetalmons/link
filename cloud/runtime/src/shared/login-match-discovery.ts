import { isSafeRecordKey } from "./ids.js";

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

export { matchDiscoverySortKey };
