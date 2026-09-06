export type MatchPresentation = {
  matchId: string;
  actorUid: string;
  emojiId: number;
  aura: string;
  revision: number;
};

export type MatchPresentationSnapshot = {
  matchId: string;
  players: Record<string, MatchPresentation>;
};

export type UpdateMatchPresentationRequest = {
  operationId: string;
  expectedRevision: number;
  emojiId: number;
  aura: string;
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

export const PRESENTATION_MAX_MESSAGE_BYTES: 16384;
export const PRESENTATION_MAX_REQUEST_BYTES: 4096;
export function isMatchPresentation(value: unknown): value is MatchPresentation;
export function isMatchPresentationSnapshot(
  value: unknown,
): value is MatchPresentationSnapshot;
export function isUpdateMatchPresentationRequest(
  value: unknown,
): value is UpdateMatchPresentationRequest;
export function isReadMatchPresentationResponse(
  value: unknown,
): value is ReadMatchPresentationResponse;
export function isUpdateMatchPresentationResponse(
  value: unknown,
): value is UpdateMatchPresentationResponse;
export function isMatchPresentationConflictResponse(
  value: unknown,
): value is MatchPresentationConflictResponse;
