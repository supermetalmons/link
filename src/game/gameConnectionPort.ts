import type { PlayerColor } from "@mons/shared/ids";
import type { StartAutomatchResponse } from "@mons/shared/navigation";
import type {
  HistoricalMatchPair,
  PlayerProfile,
  RematchSeriesDescriptor,
} from "../connection/connectionModels";
import type { RouteState } from "../navigation/routeState";

export type AutomatchResponse = StartAutomatchResponse;

type TimerStartResponse =
  { ok: true; timer: string; duration: number } | { ok: false };

type TimerClaimResponse = { ok: boolean };

export interface GameConnectionPort {
  getActiveMatchId(): string | null;
  matchBelongsToCurrentInvite(matchId: string): boolean;
  rematchSeriesEndIsIndicated(): boolean | null;
  setWagerViewMatchId(matchId: string | null): void;
  getRematchSeriesDescriptor(): RematchSeriesDescriptor | null;
  signInIfNeededAndConnectToGame(inviteId: string, autojoin: boolean): void;
  getSameProfilePlayerUid(): string | null;
  getHostColorForMatch(matchId: string): PlayerColor | null;
  getSameProfileColorForMatch(matchId: string): PlayerColor | null;
  loadHistoricalMatchPair(matchId: string): Promise<HistoricalMatchPair | null>;
  hasPendingInviteCreationFor(inviteId: string): boolean;
  setupConnection(autojoin: boolean, routeStateOverride?: RouteState): void;
  tryNavigateWatchOnlyToLatestApprovedMatch(): boolean;
  sendRematchProposal(): void;
  sendEndMatchIndicator(): void;
  surrender(): boolean;
  updateEmoji(
    newId: number,
    matchOnly: boolean,
    aura: string | null | undefined,
  ): void;
  sendMove(moveFen: string, newBoardFen: string, expectedMatchId: string): void;
  resolveWagerOutcome(isWin?: boolean): Promise<unknown>;
  isAutomatch(): boolean;
  updateRatings(): Promise<unknown>;
  isCurrentInviteEventOwned(): boolean;
  getCurrentInviteEventId(): string | null;
  getCachedHistoricalMatchPair(matchId: string): HistoricalMatchPair | null;
  getPlayerColorForMatch(
    matchId: string,
    playerUid: string,
  ): PlayerColor | null;
  seeIfFreshlySignedInProfileIsOneOfThePlayers(
    profileId: string,
  ): Promise<void>;
  connectToAutomatch(inviteId: string): void;
  automatch(): Promise<AutomatchResponse>;
  claimVictoryByTimer(): Promise<TimerClaimResponse>;
  startTimer(): Promise<TimerStartResponse>;
  getProfileByLoginId(loginId: string): Promise<PlayerProfile>;
}

let boundConnection: GameConnectionPort | null = null;

export const bindGameConnection = (connection: GameConnectionPort): void => {
  boundConnection = connection;
};

export const isGameConnectionBound = (): boolean => boundConnection !== null;

export const gameConnection = new Proxy({} as GameConnectionPort, {
  get(_target, property) {
    if (!boundConnection) {
      throw new Error("game-connection-not-bound");
    }
    const value = Reflect.get(boundConnection, property, boundConnection);
    return typeof value === "function" ? value.bind(boundConnection) : value;
  },
});
