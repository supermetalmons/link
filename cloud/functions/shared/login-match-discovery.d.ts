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

export function matchDiscoverySortKey(matchId: string): string;

export function resolveMatchDiscoveryInvite(
  matchId: string,
  hasInvite: (inviteId: string) => boolean | Promise<boolean>,
): Promise<Pick<MatchDiscoveryEntry, "inviteId" | "resolution">>;
