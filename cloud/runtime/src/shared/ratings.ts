export interface GlickoSettings {
  tau: number;
  rating: number;
  rd: number;
  vol: number;
}

export interface RatingPlayerLike {
  getRating(): number;
}

export interface RatingCalculatorLike<
  TPlayer extends RatingPlayerLike = RatingPlayerLike,
> {
  makePlayer(rating: number, rd: number, volatility: number): TPlayer;
  updateRatings(matches: [TPlayer, TPlayer, number][]): void;
}

export type RatingCalculatorConstructor<
  TPlayer extends RatingPlayerLike = RatingPlayerLike,
> = new (settings: GlickoSettings) => RatingCalculatorLike<TPlayer>;

export type RatingUpdater = (
  winRating: number,
  winPlayerGamesCount: number,
  lossRating: number,
  lossPlayerGamesCount: number,
) => [number, number];

export interface RatingUpdateRequest {
  playerId: string;
  opponentId: string;
  inviteId: string;
  matchId: string;
}

export type RatingUpdateResponse =
  { ok: true } | { ok: true; skipped: true } | { ok: false };

export interface RatingEventMetadata {
  isEventMatch: boolean;
  eventOwned: boolean;
  eventId: string | null;
}

const RATING_VOLATILITY = 0.06;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: object,
  expectedKeys: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};

const GLICKO_SETTINGS: Readonly<GlickoSettings> = Object.freeze({
  tau: 0.75,
  rating: 1500,
  rd: 100,
  vol: RATING_VOLATILITY,
});

const getRatingDeviation = (gamesCount: number): number =>
  Math.max(60, 350 - gamesCount);

const createRatingUpdater =
  <TPlayer extends RatingPlayerLike>(
    Glicko2: RatingCalculatorConstructor<TPlayer>,
  ): RatingUpdater =>
  (winRating, winPlayerGamesCount, lossRating, lossPlayerGamesCount) => {
    const ranking = new Glicko2({ ...GLICKO_SETTINGS });
    const winner = ranking.makePlayer(
      winRating,
      getRatingDeviation(winPlayerGamesCount),
      RATING_VOLATILITY,
    );
    const loser = ranking.makePlayer(
      lossRating,
      getRatingDeviation(lossPlayerGamesCount),
      RATING_VOLATILITY,
    );
    const matches: [TPlayer, TPlayer, number][] = [[winner, loser, 1]];
    ranking.updateRatings(matches);

    const newWinRating = Math.round(winner.getRating());
    const newLossRating = Math.round(loser.getRating());

    return [newWinRating, newLossRating];
  };

const getRatingEventMetadata = (value: unknown): RatingEventMetadata => {
  const invite = isRecord(value) ? value : {};
  const eventId =
    typeof invite.eventId === "string" && invite.eventId.trim() !== ""
      ? invite.eventId.trim()
      : null;
  return {
    isEventMatch: invite.eventOwned === true || eventId !== null,
    eventOwned: invite.eventOwned === true,
    eventId,
  };
};

const isRatingUpdateRequest = (value: unknown): value is RatingUpdateRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["playerId", "opponentId", "inviteId", "matchId"]) &&
  typeof value.playerId === "string" &&
  value.playerId.trim() !== "" &&
  typeof value.opponentId === "string" &&
  value.opponentId.trim() !== "" &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "";

const isRatingUpdateResponse = (
  value: unknown,
): value is RatingUpdateResponse => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === false) {
    return hasExactKeys(value, ["ok"]);
  }
  if (value.ok !== true) {
    return false;
  }
  return (
    hasExactKeys(value, ["ok"]) ||
    (hasExactKeys(value, ["ok", "skipped"]) && value.skipped === true)
  );
};

export {
  GLICKO_SETTINGS,
  RATING_VOLATILITY,
  createRatingUpdater,
  getRatingEventMetadata,
  getRatingDeviation,
  isRatingUpdateRequest,
  isRatingUpdateResponse,
};
