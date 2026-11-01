// Generated from src/shared/match-presentation.ts. Run npm run generate:runtime.
import { type Aura, type EmojiId } from "./appearance.js";
export type MatchPresentation = {
  matchId: string;
  actorUid: string;
  emojiId: EmojiId;
  aura: Aura;
  revision: number;
};
export type MatchPresentationSnapshot = {
  matchId: string;
  players: Record<string, MatchPresentation>;
};
export type UpdateMatchPresentationRequest = {
  operationId: string;
  expectedRevision: number;
  emojiId: EmojiId;
  aura: Aura;
};
export type ReadMatchPresentationResponse = {
  ok: true;
  presentation: MatchPresentationSnapshot;
};
export type UpdateMatchPresentationResponse = {
  ok: true;
  presentation: MatchPresentation;
};
export type MatchPresentationConflictResponse = {
  ok: false;
  error: "presentation-conflict";
  presentation: MatchPresentation;
};
declare const PRESENTATION_MAX_MESSAGE_BYTES = 16384;
declare const PRESENTATION_MAX_REQUEST_BYTES = 4096;
declare const isMatchPresentation: (
  value: unknown,
) => value is MatchPresentation;
declare const isMatchPresentationSnapshot: (
  value: unknown,
) => value is MatchPresentationSnapshot;
declare const isUpdateMatchPresentationRequest: (
  value: unknown,
) => value is UpdateMatchPresentationRequest;
declare const isReadMatchPresentationResponse: (
  value: unknown,
) => value is ReadMatchPresentationResponse;
declare const isUpdateMatchPresentationResponse: (
  value: unknown,
) => value is UpdateMatchPresentationResponse;
declare const isMatchPresentationConflictResponse: (
  value: unknown,
) => value is MatchPresentationConflictResponse;
export {
  PRESENTATION_MAX_MESSAGE_BYTES,
  PRESENTATION_MAX_REQUEST_BYTES,
  isMatchPresentation,
  isMatchPresentationSnapshot,
  isUpdateMatchPresentationRequest,
  isReadMatchPresentationResponse,
  isUpdateMatchPresentationResponse,
  isMatchPresentationConflictResponse,
};
