export interface RematchInviteData {
  hostRematches?: unknown;
  guestRematches?: unknown;
}

export function parseRematchIndices(rawValue: unknown): number[];
export function rematchSeriesEnded(inviteData: unknown): boolean;
export function inviteMatchesPlayers(
  inviteData: unknown,
  playerId: string,
  opponentId: string,
): boolean;
export function createInviteCandidatesFromMatchId(matchId: string): string[];
export function parseInviteMatchIndex(
  inviteId: unknown,
  matchId: unknown,
): number | null;
export function getHintMatchIndex(
  inviteId: unknown,
  latestMatchIdHint: unknown,
): number;
export function getLatestRematchIndex(
  inviteData: RematchInviteData | null | undefined,
  minimumIndex?: number,
): number;
export function getLatestApprovedRematchIndex(
  inviteData: RematchInviteData | null | undefined,
): number;
export function deriveLatestMatchId(
  inviteId: string,
  inviteData: RematchInviteData | null | undefined,
  latestMatchIdHint?: unknown,
): string;
export function getHistoricalMatchIds(
  inviteId: string,
  inviteData: RematchInviteData | null | undefined,
): string[];
