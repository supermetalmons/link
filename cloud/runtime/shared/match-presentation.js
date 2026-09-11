"use strict";

const { normalizeRecordKey } = require("./ids");
const { isProfileCustomizationUpdateRequest } = require("./profiles");

const PRESENTATION_MAX_MESSAGE_BYTES = 16384;
const PRESENTATION_MAX_REQUEST_BYTES = 4096;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const isExactKey = (value) =>
  typeof value === "string" && normalizeRecordKey(value) === value;
const isRevision = (value) => Number.isSafeInteger(value) && value >= 0;

const isMatchPresentation = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["matchId", "actorUid", "emojiId", "aura", "revision"]) &&
  isExactKey(value.matchId) &&
  isExactKey(value.actorUid) &&
  value.actorUid.length <= 128 &&
  Number.isSafeInteger(value.emojiId) &&
  typeof value.aura === "string" &&
  value.aura.length <= 32 &&
  isRevision(value.revision);

const isMatchPresentationSnapshot = (value) =>
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

const isUpdateMatchPresentationRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["operationId", "expectedRevision", "emojiId", "aura"]) &&
  typeof value.operationId === "string" &&
  UUID_PATTERN.test(value.operationId) &&
  isRevision(value.expectedRevision) &&
  isProfileCustomizationUpdateRequest({
    field: "emojiAndAura",
    value: { emoji: value.emojiId, aura: value.aura },
  });

const isReadMatchPresentationResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "presentation"]) &&
  value.ok === true &&
  isMatchPresentationSnapshot(value.presentation);

const isUpdateMatchPresentationResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "presentation"]) &&
  value.ok === true &&
  isMatchPresentation(value.presentation);

const isMatchPresentationConflictResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "error", "presentation"]) &&
  value.ok === false &&
  value.error === "presentation-conflict" &&
  isMatchPresentation(value.presentation);

module.exports = {
  PRESENTATION_MAX_MESSAGE_BYTES,
  PRESENTATION_MAX_REQUEST_BYTES,
  isMatchPresentation,
  isMatchPresentationSnapshot,
  isUpdateMatchPresentationRequest,
  isReadMatchPresentationResponse,
  isUpdateMatchPresentationResponse,
  isMatchPresentationConflictResponse,
};
