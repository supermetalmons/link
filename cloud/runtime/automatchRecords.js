// Generated from src/automatchRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAutomatchEntryRecord = isAutomatchEntryRecord;
exports.isAutomatchTelegramSourceRecord = isAutomatchTelegramSourceRecord;
exports.isGameplayEffectsState = isGameplayEffectsState;
exports.isAutomatchReceiptRecord = isAutomatchReceiptRecord;
exports.isGameSessionMutationReceiptRecord = isGameSessionMutationReceiptRecord;
exports.isMutationReceiptExpirationRecord = isMutationReceiptExpirationRecord;
exports.isHistoricalMatchDescriptorWrite = isHistoricalMatchDescriptorWrite;
exports.isAutomatchTelegramOutboxRecord = isAutomatchTelegramOutboxRecord;
exports.isAutomatchProfileOutboxRecord = isAutomatchProfileOutboxRecord;
exports.parseAutomatchRecord = parseAutomatchRecord;
exports.decodeAutomatchEntry = decodeAutomatchEntry;
exports.decodeAutomatchEntries = decodeAutomatchEntries;
const appearance_js_1 = require("./shared/appearance.js");
const ids_js_1 = require("./shared/ids.js");
const game_sessions_js_1 = require("./shared/game-sessions.js");
const navigation_js_1 = require("./shared/navigation.js");
function record(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function exact(value, keys) {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const integer = (value, minimum = 0) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const key = (value) =>
  typeof value === "string" &&
  (0, ids_js_1.normalizeRecordKey)(value) === value;
const nullableKey = (value) => value === null || key(value);
const text = (value) => typeof value === "string";
const nullableText = (value) => value === null || text(value);
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function map(value, validate) {
  return (
    record(value) &&
    Object.entries(value).every(([id, entry]) => key(id) && validate(entry))
  );
}
function isAutomatchEntryRecord(value) {
  return (
    exact(value, [
      "schemaVersion",
      "uid",
      "profileId",
      "timestamp",
      "rating",
      "hostColor",
      "password",
      "gameVariant",
      "telegramDeliveryVersion",
      "username",
      "ethAddress",
      "solAddress",
      "emojiId",
    ]) &&
    value.schemaVersion === 1 &&
    key(value.uid) &&
    nullableKey(value.profileId) &&
    integer(value.timestamp) &&
    typeof value.rating === "number" &&
    Number.isFinite(value.rating) &&
    value.rating >= 0 &&
    (value.hostColor === "white" || value.hostColor === "black") &&
    text(value.password) &&
    text(value.gameVariant) &&
    value.gameVariant !== "" &&
    (value.telegramDeliveryVersion === null ||
      value.telegramDeliveryVersion === 2) &&
    text(value.username) &&
    text(value.ethAddress) &&
    text(value.solAddress) &&
    (0, appearance_js_1.isEmojiId)(value.emojiId)
  );
}
function isAutomatchTelegramSourceRecord(value) {
  return (
    exact(value, [
      "schemaVersion",
      "version",
      "generation",
      "lifecycle",
      "waitingText",
      "canceledText",
      "waitingInstanceKey",
      "matchedText",
      "matchedInstanceKey",
      "createdAtMs",
      "updatedAtMs",
      "results",
    ]) &&
    value.schemaVersion === 1 &&
    value.version === 2 &&
    integer(value.generation, 1) &&
    ["pending", "matched", "canceled"].includes(String(value.lifecycle)) &&
    text(value.waitingText) &&
    text(value.canceledText) &&
    text(value.waitingInstanceKey) &&
    value.waitingInstanceKey !== "" &&
    nullableText(value.matchedText) &&
    nullableText(value.matchedInstanceKey) &&
    integer(value.createdAtMs) &&
    integer(value.updatedAtMs) &&
    value.updatedAtMs >= value.createdAtMs &&
    (value.lifecycle !== "matched" ||
      (typeof value.matchedText === "string" &&
        value.matchedText !== "" &&
        typeof value.matchedInstanceKey === "string" &&
        value.matchedInstanceKey !== "")) &&
    map(
      value.results,
      (entry) =>
        exact(entry, ["completedAtMs", "text"]) &&
        integer(entry.completedAtMs) &&
        text(entry.text) &&
        entry.text !== "",
    )
  );
}
function isGameplayEffectsState(value) {
  return exact(value, ["state"])
    ? value.state === "enabled"
    : exact(value, ["state", "retiredAtMs", "sourceDigest"]) &&
        value.state === "retired" &&
        integer(value.retiredAtMs) &&
        digest(value.sourceDigest);
}
function isAutomatchReceiptRecord(value) {
  return (
    exact(value, [
      "schemaVersion",
      "kind",
      "aura",
      "completedAtMs",
      "emojiId",
      "inviteId",
      "operationId",
      "profileProjectionRequestId",
      "requesterUid",
      "response",
      "telegramProjection",
      "effects",
    ]) &&
    value.schemaVersion === 2 &&
    value.kind === "automatch-start" &&
    (0, appearance_js_1.isAura)(value.aura) &&
    (0, appearance_js_1.isEmojiId)(value.emojiId) &&
    integer(value.completedAtMs) &&
    key(value.inviteId) &&
    key(value.operationId) &&
    nullableKey(value.profileProjectionRequestId) &&
    key(value.requesterUid) &&
    (0, navigation_js_1.isStartAutomatchResponse)(value.response) &&
    value.response.ok &&
    value.response.inviteId === value.inviteId &&
    typeof value.telegramProjection === "boolean" &&
    isGameplayEffectsState(value.effects)
  );
}
function isGameSessionMutationReceiptRecord(value) {
  if (
    !exact(value, [
      "schemaVersion",
      "completedAtMs",
      "fingerprint",
      "inviteId",
      "operationId",
      "projectionRequestId",
      "requesterUid",
      "effects",
      "kind",
      "response",
    ]) ||
    value.schemaVersion !== 2 ||
    !integer(value.completedAtMs) ||
    !text(value.fingerprint) ||
    value.fingerprint === "" ||
    !key(value.inviteId) ||
    !key(value.operationId) ||
    !nullableKey(value.projectionRequestId) ||
    !key(value.requesterUid) ||
    !isGameplayEffectsState(value.effects)
  )
    return false;
  const response = value.response;
  const valid =
    value.kind === "invite-create"
      ? (0, game_sessions_js_1.isCreateInviteResponse)(response)
      : value.kind === "invite-join"
        ? (0, game_sessions_js_1.isJoinInviteResponse)(response)
        : value.kind === "match-ensure"
          ? (0, game_sessions_js_1.isEnsureMatchResponse)(response)
          : value.kind === "rematch-end"
            ? (0, game_sessions_js_1.isEndRematchResponse)(response)
            : value.kind === "rematch-propose"
              ? (0, game_sessions_js_1.isProposeRematchResponse)(response)
              : false;
  return valid && record(response) && response.inviteId === value.inviteId;
}
function isMutationReceiptExpirationRecord(value) {
  return (
    exact(value, ["schemaVersion", "completedAtMs"]) &&
    value.schemaVersion === 1 &&
    integer(value.completedAtMs)
  );
}
function isHistoricalMatchDescriptorWrite(value) {
  return (
    exact(value, [
      "finalizedAtMs",
      "guestPlayerId",
      "hostPlayerId",
      "retryNotBeforeMs",
      "source",
    ]) &&
    integer(value.finalizedAtMs) &&
    key(value.guestPlayerId) &&
    key(value.hostPlayerId) &&
    value.guestPlayerId !== value.hostPlayerId &&
    (value.retryNotBeforeMs === null || integer(value.retryNotBeforeMs)) &&
    ["backfill", "rating", "transition"].includes(String(value.source))
  );
}
function isAutomatchTelegramOutboxRecord(value) {
  if (!record(value) || value.schemaVersion !== 2 || !key(value.requestId))
    return false;
  if (value.status === "pending")
    return (
      exact(value, ["schemaVersion", "status", "requestId", "updatedAtMs"]) &&
      integer(value.updatedAtMs)
    );
  if (value.status === "dead")
    return (
      exact(value, [
        "schemaVersion",
        "status",
        "requestId",
        "updatedAtMs",
        "deadAtMs",
        "reason",
      ]) &&
      value.updatedAtMs === null &&
      integer(value.deadAtMs) &&
      text(value.reason) &&
      value.reason !== ""
    );
  return (
    exact(value, [
      "schemaVersion",
      "status",
      "requestId",
      "updatedAtMs",
      "sourceUpdatedAtMs",
      "retirement",
    ]) &&
    value.status === "cancelled" &&
    value.updatedAtMs === null &&
    integer(value.sourceUpdatedAtMs) &&
    isGameplayEffectsState(value.retirement) &&
    value.retirement.state === "retired"
  );
}
function isAutomatchProfileOutboxRecord(value) {
  if (
    !record(value) ||
    value.schemaVersion !== 2 ||
    !key(value.requestId) ||
    !text(value.reason) ||
    value.reason === "" ||
    !integer(value.sourceUpdatedAtMs) ||
    !integer(value.lastQueuedAtMs) ||
    !map(value.historicalMatches, isHistoricalMatchDescriptorWrite)
  )
    return false;
  const base = [
    "schemaVersion",
    "status",
    "requestId",
    "reason",
    "sourceUpdatedAtMs",
    "lastQueuedAtMs",
    "historicalMatches",
    "archiveRetry",
  ];
  if (!(
    value.archiveRetry === null ||
    (exact(value.archiveRetry, ["requestId", "notBeforeMs"]) &&
      value.archiveRetry.requestId === value.requestId &&
      integer(value.archiveRetry.notBeforeMs))
  ))
    return false;
  if (value.status === "pending") return exact(value, base);
  return (
    exact(value, [...base, "retirement"]) &&
    value.status === "cancelled" &&
    isGameplayEffectsState(value.retirement) &&
    value.retirement.state === "retired"
  );
}
function parseAutomatchRecord(root, value) {
  if (value === null) return null;
  const valid =
    root === "automatch"
      ? isAutomatchEntryRecord(value)
      : root === "telegramAutomatches"
        ? isAutomatchTelegramSourceRecord(value)
        : root === "telegramProjectionOutbox/automatch"
          ? isAutomatchTelegramOutboxRecord(value)
          : root === "profileGameProjectionOutbox/automatch"
            ? isAutomatchProfileOutboxRecord(value)
            : root === "gameplayMutationReceipts"
              ? isAutomatchReceiptRecord(value) ||
                isGameSessionMutationReceiptRecord(value)
              : isMutationReceiptExpirationRecord(value);
  if (!valid) throw new TypeError(`invalid-canonical-${root}`);
  return value;
}
function decodeAutomatchEntry(value) {
  return parseAutomatchRecord("automatch", value);
}
function decodeAutomatchEntries(value) {
  if (value === null) return null;
  if (!record(value) || !Object.keys(value).every(key))
    throw new TypeError("invalid-canonical-automatch-entries");
  return Object.fromEntries(
    Object.entries(value).map(([id, entry]) => [
      id,
      decodeAutomatchEntry(entry),
    ]),
  );
}
