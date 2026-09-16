"use strict";

const { normalizeRecordKey } = require("./ids");
const {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
} = require("./game-bootstrap");
const { selectInviteMatch } = require("./rematches");
const { isSessionTokenResponse } = require("./session-auth");
const {
  isEventSnapshotSeed,
  MAX_EVENT_READ_RESPONSE_BYTES,
} = require("./events");

const SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES =
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES + 16_384;
const SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS = 25_000;
const SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES =
  MAX_EVENT_READ_RESPONSE_BYTES + 16_384;

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

function isSessionBootstrapTarget(value) {
  return (
    record(value) &&
    exactKeys(value, ["inviteId", "selection"]) &&
    typeof value.inviteId === "string" &&
    normalizeRecordKey(value.inviteId) === value.inviteId &&
    (value.selection === "current" || value.selection === "approved")
  );
}

function isSessionBootstrapFailure(value) {
  return (
    record(value) &&
    exactKeys(
      value,
      Object.hasOwn(value, "retryAfterMs")
        ? ["ok", "status", "retryAfterMs"]
        : ["ok", "status"],
    ) &&
    value.ok === false &&
    [403, 404, 409, 429, 503].includes(value.status) &&
    (!Object.hasOwn(value, "retryAfterMs") ||
      (Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs >= 0))
  );
}

function isSessionBootstrap(value) {
  if (
    !record(value) ||
    !exactKeys(value, ["inviteId", "selection", "result"]) ||
    !isSessionBootstrapTarget({
      inviteId: value.inviteId,
      selection: value.selection,
    })
  )
    return false;
  if (isSessionBootstrapFailure(value.result)) return true;
  if (
    !isReadGameBootstrapResponse(value.result) ||
    value.result.metadata.inviteId !== value.inviteId
  )
    return false;
  const selected = selectInviteMatch(
    value.inviteId,
    value.result.metadata,
    value.result.viewer.actorUid,
    { preferApproved: value.selection === "approved" },
  );
  return (
    selected.matchId === value.result.match.matchId &&
    selected.hasPendingProposal === value.result.hasPendingProposal
  );
}

function isSessionBootstrapResponse(value) {
  if (!record(value)) return false;
  const { gameBootstrap, ...session } = value;
  return isSessionTokenResponse(session) && isSessionBootstrap(gameBootstrap);
}

function isSessionEventBootstrapTarget(value) {
  return (
    record(value) &&
    exactKeys(value, ["eventId"]) &&
    typeof value.eventId === "string" &&
    normalizeRecordKey(value.eventId) === value.eventId
  );
}

function isSessionEventBootstrap(value) {
  return (
    record(value) &&
    exactKeys(value, ["eventId", "result"]) &&
    isSessionEventBootstrapTarget({ eventId: value.eventId }) &&
    (isSessionBootstrapFailure(value.result) ||
      (isEventSnapshotSeed(value.result) &&
        value.result.snapshot.eventId === value.eventId))
  );
}

function isSessionEventBootstrapResponse(value) {
  if (!record(value)) return false;
  const { eventBootstrap, ...session } = value;
  return (
    isSessionTokenResponse(session) && isSessionEventBootstrap(eventBootstrap)
  );
}

module.exports = {
  SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES,
  SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS,
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isSessionBootstrapTarget,
  isSessionBootstrapFailure,
  isSessionBootstrap,
  isSessionBootstrapResponse,
  isSessionEventBootstrapTarget,
  isSessionEventBootstrap,
  isSessionEventBootstrapResponse,
};
