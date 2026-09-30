// Generated from src/shared/session-bootstrap.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES =
  exports.SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES =
  exports.SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS =
  exports.SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES =
    void 0;
exports.isSessionIdentityBootstrap = isSessionIdentityBootstrap;
exports.isSessionBootstrapTarget = isSessionBootstrapTarget;
exports.isSessionBootstrapFailure = isSessionBootstrapFailure;
exports.isSessionBootstrap = isSessionBootstrap;
exports.isSessionBootstrapResponse = isSessionBootstrapResponse;
exports.isSessionEventBootstrapTarget = isSessionEventBootstrapTarget;
exports.isSessionEventBootstrap = isSessionEventBootstrap;
exports.isSessionEventBootstrapResponse = isSessionEventBootstrapResponse;
const ids_js_1 = require("./ids.js");
const game_bootstrap_js_1 = require("./game-bootstrap.js");
const rematches_js_1 = require("./rematches.js");
const session_auth_js_1 = require("./session-auth.js");
const profiles_js_1 = require("./profiles.js");
const events_js_1 = require("./events.js");
const SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES =
  game_bootstrap_js_1.GAME_BOOTSTRAP_MAX_RESPONSE_BYTES + 16_384;
exports.SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES =
  SESSION_BOOTSTRAP_MAX_RESPONSE_BYTES;
const SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS = 25_000;
exports.SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS =
  SESSION_BOOTSTRAP_REQUEST_TIMEOUT_MS;
const SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES =
  events_js_1.MAX_EVENT_READ_RESPONSE_BYTES + 16_384;
exports.SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES =
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES;
const SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES = 65_536;
exports.SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES =
  SESSION_IDENTITY_BOOTSTRAP_MAX_RESPONSE_BYTES;
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
    (0, ids_js_1.normalizeRecordKey)(value.inviteId) === value.inviteId &&
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
    !(0, game_bootstrap_js_1.isReadGameBootstrapResponse)(value.result) ||
    value.result.metadata.inviteId !== value.inviteId
  )
    return false;
  const selected = (0, rematches_js_1.selectInviteMatch)(
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
  const { gameBootstrap, identityBootstrap, ...session } = value;
  return (
    (0, session_auth_js_1.isSessionTokenResponse)(session) &&
    isSessionBootstrap(gameBootstrap) &&
    (!Object.hasOwn(value, "identityBootstrap") ||
      isSessionIdentityBootstrap(identityBootstrap))
  );
}
function isSessionIdentityBootstrap(value) {
  return (
    (0, profiles_js_1.isProfileLookupResponse)(value) ||
    (record(value) &&
      exactKeys(value, ["ok", "status"]) &&
      value.ok === false &&
      [409, 503].includes(value.status))
  );
}
function isSessionEventBootstrapTarget(value) {
  return (
    record(value) &&
    exactKeys(value, ["eventId"]) &&
    typeof value.eventId === "string" &&
    (0, ids_js_1.normalizeRecordKey)(value.eventId) === value.eventId
  );
}
function isSessionEventBootstrap(value) {
  return (
    record(value) &&
    exactKeys(value, ["eventId", "result"]) &&
    isSessionEventBootstrapTarget({ eventId: value.eventId }) &&
    (isSessionBootstrapFailure(value.result) ||
      ((0, events_js_1.isEventSnapshotSeed)(value.result) &&
        value.result.snapshot.eventId === value.eventId))
  );
}
function isSessionEventBootstrapResponse(value) {
  if (!record(value)) return false;
  const { eventBootstrap, identityBootstrap, ...session } = value;
  return (
    (0, session_auth_js_1.isSessionTokenResponse)(session) &&
    isSessionEventBootstrap(eventBootstrap) &&
    (!Object.hasOwn(value, "identityBootstrap") ||
      isSessionIdentityBootstrap(identityBootstrap))
  );
}
