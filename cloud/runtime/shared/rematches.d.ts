// Generated from src/shared/rematches.ts. Run npm run generate:runtime.
export interface RematchInviteData {
  hostRematches?: unknown;
  guestRematches?: unknown;
}
declare const parseRematchIndices: (rawValue: unknown) => number[];
declare const rematchSeriesEnded: (inviteData: unknown) => boolean;
declare const inviteMatchesPlayers: (
  inviteData: unknown,
  playerId: string,
  opponentId: string,
) => boolean;
declare const createInviteCandidatesFromMatchId: (matchId: string) => string[];
declare const parseInviteMatchIndex: (
  inviteId: unknown,
  matchId: unknown,
) => number | null;
declare const getHintMatchIndex: (
  inviteId: unknown,
  latestMatchIdHint: unknown,
) => number;
declare const getLatestRematchIndex: (
  inviteData: RematchInviteData | null | undefined,
  minimumIndex?: number,
) => number;
declare const getLatestApprovedRematchIndex: (
  inviteData: RematchInviteData | null | undefined,
) => number;
declare const selectInviteMatch: (
  inviteId: string,
  inviteData: RematchInviteData & {
    hostId?: unknown;
    guestId?: unknown;
  },
  actorUid: string | null,
  options?: {
    preferApproved?: boolean;
  },
) => {
  matchId: string;
  hasPendingProposal: boolean;
};
declare const deriveLatestMatchId: (
  inviteId: string,
  inviteData: RematchInviteData | null | undefined,
  latestMatchIdHint?: unknown,
) => string;
declare const getHistoricalMatchIds: (
  inviteId: string,
  inviteData: RematchInviteData | null | undefined,
) => string[];
export {
  parseRematchIndices,
  rematchSeriesEnded,
  inviteMatchesPlayers,
  createInviteCandidatesFromMatchId,
  parseInviteMatchIndex,
  getHintMatchIndex,
  getLatestRematchIndex,
  getLatestApprovedRematchIndex,
  selectInviteMatch,
  deriveLatestMatchId,
  getHistoricalMatchIds,
};
