import { normalizeRecordKey } from "./ids.js";
import { isProfileCustomizationUpdateRequest } from "./profiles.js";

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

const PRESENTATION_MAX_MESSAGE_BYTES = 16384;
const PRESENTATION_MAX_REQUEST_BYTES = 4096;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const isExactKey = (value: unknown): value is string =>
  typeof value === "string" && normalizeRecordKey(value) === value;
const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isMatchPresentation = (value: unknown): value is MatchPresentation =>
  isRecord(value) &&
  hasExactKeys(value, ["matchId", "actorUid", "emojiId", "aura", "revision"]) &&
  isExactKey(value.matchId) &&
  isExactKey(value.actorUid) &&
  value.actorUid.length <= 128 &&
  Number.isSafeInteger(value.emojiId) &&
  typeof value.aura === "string" &&
  value.aura.length <= 32 &&
  isRevision(value.revision);

const isMatchPresentationSnapshot = (
  value: unknown,
): value is MatchPresentationSnapshot =>
  isRecord(value) &&
  hasExactKeys(value, ["matchId", "players"]) &&
  isExactKey(value.matchId) &&
  isRecord(value.players) &&
  Object.keys(value.players).length <= 2 &&
  Object.entries(value.players).every(
    ([actorUid, presentation]) =>
      isMatchPresentation(presentation) &&
      presentation.actorUid === actorUid &&
      presentation.matchId === value.matchId,
  );

const isUpdateMatchPresentationRequest = (
  value: unknown,
): value is UpdateMatchPresentationRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["operationId", "expectedRevision", "emojiId", "aura"]) &&
  typeof value.operationId === "string" &&
  UUID_PATTERN.test(value.operationId) &&
  isRevision(value.expectedRevision) &&
  isProfileCustomizationUpdateRequest({
    field: "emojiAndAura",
    value: { emoji: value.emojiId, aura: value.aura },
  });

const isReadMatchPresentationResponse = (
  value: unknown,
): value is ReadMatchPresentationResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "presentation"]) &&
  value.ok === true &&
  isMatchPresentationSnapshot(value.presentation);

const isUpdateMatchPresentationResponse = (
  value: unknown,
): value is UpdateMatchPresentationResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "presentation"]) &&
  value.ok === true &&
  isMatchPresentation(value.presentation);

const isMatchPresentationConflictResponse = (
  value: unknown,
): value is MatchPresentationConflictResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "error", "presentation"]) &&
  value.ok === false &&
  value.error === "presentation-conflict" &&
  isMatchPresentation(value.presentation);

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
