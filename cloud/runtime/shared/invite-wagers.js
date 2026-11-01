// Generated from src/shared/invite-wagers.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INVITE_WAGERS_REFRESH_MS =
  exports.INVITE_WAGERS_MAX_MESSAGE_BYTES =
  exports.INVITE_WAGERS_SOCKET_PROTOCOL =
    void 0;
exports.isPublicWagerProposal = isPublicWagerProposal;
exports.isPublicWagerAgreement = isPublicWagerAgreement;
exports.isPublicWagerResolution = isPublicWagerResolution;
exports.isPublicMatchWagerState = isPublicMatchWagerState;
exports.isInviteWagersSnapshot = isInviteWagersSnapshot;
exports.isReadInviteWagersResponse = isReadInviteWagersResponse;
exports.isInviteWagersMessage = isInviteWagersMessage;
const ids_js_1 = require("./ids.js");
const mining_js_1 = require("./mining.js");
const INVITE_WAGERS_SOCKET_PROTOCOL = "mons-invite-wagers-v1";
exports.INVITE_WAGERS_SOCKET_PROTOCOL = INVITE_WAGERS_SOCKET_PROTOCOL;
const INVITE_WAGERS_MAX_MESSAGE_BYTES = 1024 * 1024 + 16 * 1024;
exports.INVITE_WAGERS_MAX_MESSAGE_BYTES = INVITE_WAGERS_MAX_MESSAGE_BYTES;
const INVITE_WAGERS_REFRESH_MS = 5000;
exports.INVITE_WAGERS_REFRESH_MS = INVITE_WAGERS_REFRESH_MS;
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, required, optional = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const isKey = (value) =>
  typeof value === "string" &&
  (0, ids_js_1.normalizeRecordKey)(value) === value;
const isUid = (value) => isKey(value) && value.length <= 128;
const isCount = (value) =>
  Number.isSafeInteger(value) && Number.isSafeInteger(value * 2) && value > 0;
const isTimestamp = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isParticipantMap = (value, validate) =>
  isRecord(value) &&
  Object.keys(value).length <= 2 &&
  Object.entries(value).every(([uid, entry]) => isUid(uid) && validate(entry));
function isPublicWagerProposal(value) {
  return (
    isRecord(value) &&
    hasKeys(value, ["material", "count", "createdAt"]) &&
    (0, mining_js_1.isMaterialName)(value.material) &&
    isCount(value.count) &&
    isTimestamp(value.createdAt)
  );
}
function isPublicWagerAgreement(value) {
  return (
    isRecord(value) &&
    hasKeys(value, [
      "material",
      "count",
      "proposerId",
      "accepterId",
      "total",
      "acceptedAt",
    ]) &&
    (0, mining_js_1.isMaterialName)(value.material) &&
    isCount(value.count) &&
    isUid(value.proposerId) &&
    isUid(value.accepterId) &&
    value.proposerId !== value.accepterId &&
    value.total === value.count * 2 &&
    isTimestamp(value.acceptedAt)
  );
}
function isPublicWagerResolution(value) {
  return (
    isRecord(value) &&
    hasKeys(value, [
      "material",
      "count",
      "winnerId",
      "loserId",
      "total",
      "resolvedAt",
    ]) &&
    (0, mining_js_1.isMaterialName)(value.material) &&
    isCount(value.count) &&
    isUid(value.winnerId) &&
    isUid(value.loserId) &&
    value.winnerId !== value.loserId &&
    value.total === value.count * 2 &&
    isTimestamp(value.resolvedAt)
  );
}
function isPublicMatchWagerState(value) {
  return (
    isRecord(value) &&
    hasKeys(value, [
      "schemaVersion",
      "state",
      "proposals",
      "proposedBy",
      "agreed",
      "resolved",
      "blocked",
    ]) &&
    value.schemaVersion === 1 &&
    ["proposed", "agreed", "settling", "settled", "blocked"].includes(
      String(value.state),
    ) &&
    isParticipantMap(value.proposals, isPublicWagerProposal) &&
    isParticipantMap(value.proposedBy, (flag) => typeof flag === "boolean") &&
    (value.agreed === null || isPublicWagerAgreement(value.agreed)) &&
    (value.resolved === null || isPublicWagerResolution(value.resolved)) &&
    (value.state === "blocked"
      ? isRecord(value.blocked) &&
        hasKeys(value.blocked, ["reason", "requiresManualReview"]) &&
        value.blocked.requiresManualReview === true &&
        [
          "legacy-agreement-unsettled",
          "legacy-partial",
          "legacy-settlement-incomplete",
          "legacy-resolution-marker",
        ].includes(String(value.blocked.reason))
      : value.blocked === null)
  );
}
function isInviteWagersSnapshot(value) {
  return (
    isRecord(value) &&
    hasKeys(value, ["inviteId", "revision", "wagers"]) &&
    isKey(value.inviteId) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isRecord(value.wagers) &&
    Object.entries(value.wagers).every(
      ([matchId, wager]) => isKey(matchId) && isPublicMatchWagerState(wager),
    )
  );
}
function isReadInviteWagersResponse(value) {
  return (
    isRecord(value) &&
    hasKeys(value, ["ok", "snapshot"]) &&
    value.ok === true &&
    isInviteWagersSnapshot(value.snapshot)
  );
}
function isInviteWagersMessage(value) {
  return (
    isRecord(value) &&
    hasKeys(value, ["schemaVersion", "type", "snapshot"]) &&
    value.schemaVersion === 1 &&
    value.type === "snapshot" &&
    isInviteWagersSnapshot(value.snapshot)
  );
}
