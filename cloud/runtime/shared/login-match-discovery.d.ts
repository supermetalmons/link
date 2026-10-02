// Generated from src/shared/login-match-discovery.ts. Run npm run generate:runtime.
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
declare function matchDiscoverySortKey(matchId: string): string;
export { matchDiscoverySortKey };
