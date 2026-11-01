import type { RatingUpdateResponse } from "@mons/shared/ratings";
import type { WagerOutcomeResolveResponse } from "@mons/shared/wagers";
import type { Aura } from "@mons/shared/appearance";
import type { PlayerColor } from "@mons/shared/ids";
import type { StartAutomatchResponse } from "@mons/shared/navigation";
import type { StartMatchTimerResponse } from "@mons/shared/timers";
import type { MatchPresentation } from "@mons/shared/match-presentation";
import type {
  HistoricalMatchPair,
  PlayerProfile,
  RematchSeriesDescriptor,
} from "../connection/connectionModels";
import type { RouteState } from "../navigation/routeState";

export type AutomatchResponse = StartAutomatchResponse;

type TimerStartResponse = StartMatchTimerResponse | { ok: false };

type TimerClaimResponse = { ok: boolean };

export interface GameConnectionPort {
  getActiveMatchId(): string | null;
  getMatchPresentation(
    matchId: string,
    actorUid: string,
  ): MatchPresentation | null;
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
  sendEndMatchIndicator(): boolean;
  surrender(): boolean;
  updateEmoji(newId: number, matchOnly: boolean, aura: Aura | undefined): void;
  sendMove(moveFen: string, newBoardFen: string, expectedMatchId: string): void;
  resolveWagerOutcome(
    isWin?: boolean,
  ): Promise<WagerOutcomeResolveResponse | { ok: false }>;
  isAutomatch(): boolean;
  updateRatings(): Promise<RatingUpdateResponse>;
  isCurrentInviteEventOwned(): boolean;
  getCurrentInviteEventId(): string | null;
  getCachedHistoricalMatchPair(matchId: string): HistoricalMatchPair | null;
  getPlayerColorForMatch(
    matchId: string,
    playerUid: string,
  ): PlayerColor | null;
  seeIfFreshlySignedInProfileIsOneOfThePlayers(): Promise<void>;
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

function requireGameConnection(): GameConnectionPort {
  if (!boundConnection) throw new Error("game-connection-not-bound");
  return boundConnection;
}

export const gameConnection: GameConnectionPort = {
  get getActiveMatchId() {
    const connection = requireGameConnection();
    return connection.getActiveMatchId.bind(connection);
  },
  get getMatchPresentation() {
    const connection = requireGameConnection();
    return connection.getMatchPresentation.bind(connection);
  },
  get matchBelongsToCurrentInvite() {
    const connection = requireGameConnection();
    return connection.matchBelongsToCurrentInvite.bind(connection);
  },
  get rematchSeriesEndIsIndicated() {
    const connection = requireGameConnection();
    return connection.rematchSeriesEndIsIndicated.bind(connection);
  },
  get setWagerViewMatchId() {
    const connection = requireGameConnection();
    return connection.setWagerViewMatchId.bind(connection);
  },
  get getRematchSeriesDescriptor() {
    const connection = requireGameConnection();
    return connection.getRematchSeriesDescriptor.bind(connection);
  },
  get signInIfNeededAndConnectToGame() {
    const connection = requireGameConnection();
    return connection.signInIfNeededAndConnectToGame.bind(connection);
  },
  get getSameProfilePlayerUid() {
    const connection = requireGameConnection();
    return connection.getSameProfilePlayerUid.bind(connection);
  },
  get getHostColorForMatch() {
    const connection = requireGameConnection();
    return connection.getHostColorForMatch.bind(connection);
  },
  get getSameProfileColorForMatch() {
    const connection = requireGameConnection();
    return connection.getSameProfileColorForMatch.bind(connection);
  },
  get loadHistoricalMatchPair() {
    const connection = requireGameConnection();
    return connection.loadHistoricalMatchPair.bind(connection);
  },
  get hasPendingInviteCreationFor() {
    const connection = requireGameConnection();
    return connection.hasPendingInviteCreationFor.bind(connection);
  },
  get setupConnection() {
    const connection = requireGameConnection();
    return connection.setupConnection.bind(connection);
  },
  get tryNavigateWatchOnlyToLatestApprovedMatch() {
    const connection = requireGameConnection();
    return connection.tryNavigateWatchOnlyToLatestApprovedMatch.bind(
      connection,
    );
  },
  get sendRematchProposal() {
    const connection = requireGameConnection();
    return connection.sendRematchProposal.bind(connection);
  },
  get sendEndMatchIndicator() {
    const connection = requireGameConnection();
    return connection.sendEndMatchIndicator.bind(connection);
  },
  get surrender() {
    const connection = requireGameConnection();
    return connection.surrender.bind(connection);
  },
  get updateEmoji() {
    const connection = requireGameConnection();
    return connection.updateEmoji.bind(connection);
  },
  get sendMove() {
    const connection = requireGameConnection();
    return connection.sendMove.bind(connection);
  },
  get resolveWagerOutcome() {
    const connection = requireGameConnection();
    return connection.resolveWagerOutcome.bind(connection);
  },
  get isAutomatch() {
    const connection = requireGameConnection();
    return connection.isAutomatch.bind(connection);
  },
  get updateRatings() {
    const connection = requireGameConnection();
    return connection.updateRatings.bind(connection);
  },
  get isCurrentInviteEventOwned() {
    const connection = requireGameConnection();
    return connection.isCurrentInviteEventOwned.bind(connection);
  },
  get getCurrentInviteEventId() {
    const connection = requireGameConnection();
    return connection.getCurrentInviteEventId.bind(connection);
  },
  get getCachedHistoricalMatchPair() {
    const connection = requireGameConnection();
    return connection.getCachedHistoricalMatchPair.bind(connection);
  },
  get getPlayerColorForMatch() {
    const connection = requireGameConnection();
    return connection.getPlayerColorForMatch.bind(connection);
  },
  get seeIfFreshlySignedInProfileIsOneOfThePlayers() {
    const connection = requireGameConnection();
    return connection.seeIfFreshlySignedInProfileIsOneOfThePlayers.bind(
      connection,
    );
  },
  get connectToAutomatch() {
    const connection = requireGameConnection();
    return connection.connectToAutomatch.bind(connection);
  },
  get automatch() {
    const connection = requireGameConnection();
    return connection.automatch.bind(connection);
  },
  get claimVictoryByTimer() {
    const connection = requireGameConnection();
    return connection.claimVictoryByTimer.bind(connection);
  },
  get startTimer() {
    const connection = requireGameConnection();
    return connection.startTimer.bind(connection);
  },
  get getProfileByLoginId() {
    const connection = requireGameConnection();
    return connection.getProfileByLoginId.bind(connection);
  },
};
