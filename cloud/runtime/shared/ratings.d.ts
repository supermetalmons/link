// Generated from src/shared/ratings.ts. Run npm run generate:runtime.
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
  | {
      ok: true;
    }
  | {
      ok: true;
      skipped: true;
    }
  | {
      ok: false;
    };
export interface RatingEventMetadata {
  isEventMatch: boolean;
  eventOwned: boolean;
  eventId: string | null;
}
declare const RATING_VOLATILITY = 0.06;
declare const GLICKO_SETTINGS: Readonly<GlickoSettings>;
declare const getRatingDeviation: (gamesCount: number) => number;
declare const createRatingUpdater: <TPlayer extends RatingPlayerLike>(
  Glicko2: RatingCalculatorConstructor<TPlayer>,
) => RatingUpdater;
declare const getRatingEventMetadata: (value: unknown) => RatingEventMetadata;
declare const isRatingUpdateRequest: (
  value: unknown,
) => value is RatingUpdateRequest;
declare const isRatingUpdateResponse: (
  value: unknown,
) => value is RatingUpdateResponse;
export {
  GLICKO_SETTINGS,
  RATING_VOLATILITY,
  createRatingUpdater,
  getRatingEventMetadata,
  getRatingDeviation,
  isRatingUpdateRequest,
  isRatingUpdateResponse,
};
