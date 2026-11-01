// Generated from src/shared/rematches.ts. Run npm run generate:runtime.
export type RematchSeries = {
  state: "open" | "ended";
  indices: number[];
};
export interface RematchInviteData {
  hostRematches: RematchSeries;
  guestRematches: RematchSeries;
}
export declare function isRematchSeries(value: unknown): value is RematchSeries;
declare const parseRematchIndices: (
  value: RematchSeries | null | undefined,
) => number[];
declare const rematchSeriesEnded: (
  inviteData: RematchInviteData | null | undefined,
) => boolean;
declare const inviteMatchesPlayers: (
  inviteData:
    | {
        hostId: string;
        guestId: string | null;
      }
    | null
    | undefined,
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
    hostId: string;
    guestId: string | null;
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
};
