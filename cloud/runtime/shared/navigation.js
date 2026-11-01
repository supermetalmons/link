// Generated from src/shared/navigation.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRemoveNavigationGameResponse =
  exports.isRemoveNavigationGameRequest =
  exports.isCancelAutomatchResponse =
  exports.parseStartAutomatchApiResponse =
  exports.isStartAutomatchResponse =
  exports.isStartAutomatchRequest =
  exports.isReadNavigationGamesResponse =
  exports.isReadNavigationGamesRequest =
  exports.isNavigationGamesCursor =
  exports.isNavigationItem =
  exports.mapProfileGameProjection =
  exports.compareNavigationItems =
  exports.getNavigationSortBucket =
  exports.getNavigationStatusPriority =
  exports.inferAutomatchStateHint =
  exports.normalizeStrictAutomatchStateHint =
  exports.normalizeAutomatchStateHint =
  exports.NAVIGATION_SORT_BUCKETS =
  exports.AUTOMATCH_API_MAX_RESPONSE_BYTES =
    void 0;
const profile_game_projections_js_1 = require("./profile-game-projections.js");
const appearance_js_1 = require("./appearance.js");
const ids_js_1 = require("./ids.js");
const game_bootstrap_js_1 = require("./game-bootstrap.js");
const AUTOMATCH_API_MAX_RESPONSE_BYTES =
  game_bootstrap_js_1.GAME_BOOTSTRAP_MAX_RESPONSE_BYTES + 1024;
exports.AUTOMATCH_API_MAX_RESPONSE_BYTES = AUTOMATCH_API_MAX_RESPONSE_BYTES;
const NAVIGATION_SORT_BUCKETS =
  profile_game_projections_js_1.PROJECTION_SORT_BUCKETS;
exports.NAVIGATION_SORT_BUCKETS = NAVIGATION_SORT_BUCKETS;
const normalizeStrictAutomatchStateHint = (value) =>
  value === "pending" || value === "matched" || value === "canceled"
    ? value
    : null;
exports.normalizeStrictAutomatchStateHint = normalizeStrictAutomatchStateHint;
const normalizeAutomatchStateHint = (value) =>
  typeof value === "string"
    ? normalizeStrictAutomatchStateHint(value.trim())
    : null;
exports.normalizeAutomatchStateHint = normalizeAutomatchStateHint;
const inferAutomatchStateHint = ({
  inviteId,
  queueValue,
  hasGuest,
  storedStateHint,
}) => {
  if (!(0, ids_js_1.isAutoInviteId)(inviteId)) {
    return null;
  }
  if (queueValue) {
    return "pending";
  }
  if (hasGuest) {
    return "matched";
  }
  return normalizeAutomatchStateHint(storedStateHint) ?? "canceled";
};
exports.inferAutomatchStateHint = inferAutomatchStateHint;
const getNavigationStatusPriority = (status) => {
  if (status === "pending") {
    return 0;
  }
  if (status === "waiting") {
    return 1;
  }
  if (status === "active") {
    return 2;
  }
  return 3;
};
exports.getNavigationStatusPriority = getNavigationStatusPriority;
const getNavigationSortBucket = (status) => {
  if (status === "pending") {
    return NAVIGATION_SORT_BUCKETS.pending;
  }
  if (status === "active") {
    return NAVIGATION_SORT_BUCKETS.active;
  }
  if (status === "ended" || status === "dismissed") {
    return NAVIGATION_SORT_BUCKETS.ended;
  }
  return NAVIGATION_SORT_BUCKETS.waiting;
};
exports.getNavigationSortBucket = getNavigationSortBucket;
const compareNavigationItems = (left, right) => {
  const leftPriority = getNavigationStatusPriority(left.status);
  const rightPriority = getNavigationStatusPriority(right.status);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  if (left.sortBucket !== right.sortBucket) {
    return left.sortBucket - right.sortBucket;
  }
  if (left.listSortAtMs !== right.listSortAtMs) {
    return right.listSortAtMs - left.listSortAtMs;
  }
  return left.id.localeCompare(right.id);
};
exports.compareNavigationItems = compareNavigationItems;
const isRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
};
const normalizeNavigationStatus = (status) =>
  status === "pending" ||
  status === "waiting" ||
  status === "active" ||
  status === "ended" ||
  status === "dismissed"
    ? status
    : "waiting";
const mapProfileGameProjection = (value, projectionId) => {
  if (!(0, profile_game_projections_js_1.isProfileGameProjectionRecord)(value))
    return null;
  if (value.entityType === "event") {
    if (projectionId !== value.id) return null;
    return {
      id: value.id,
      entityType: "event",
      eventId: value.eventId,
      status: value.status,
      sortBucket: value.sortBucket,
      listSortAtMs: value.listSortAt,
      startAtMs: value.startAt,
      updatedAtMs: value.updatedAt,
      endedAtMs: value.endedAt,
      participantCount: value.participantCount,
      participantPreview: value.participantPreview,
      winnerDisplayName: value.winnerDisplayName,
    };
  }
  if (projectionId !== value.inviteId) return null;
  return {
    id: value.inviteId,
    entityType: "game",
    inviteId: value.inviteId,
    kind: value.kind,
    status: value.status,
    sortBucket: value.sortBucket,
    listSortAtMs: value.listSortAt,
    hostLoginId: value.hostLoginId,
    guestLoginId: value.guestLoginId,
    opponentProfileId: value.opponentProfileId,
    opponentName: value.opponentName,
    opponentEmoji: value.opponentEmoji,
    automatchStateHint: value.automatchStateHint,
    isPendingAutomatch: value.isPendingAutomatch,
  };
};
exports.mapProfileGameProjection = mapProfileGameProjection;
const isNullableString = (value) => value === null || typeof value === "string";
const isNullableNumber = (value) =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const isNavigationParticipantPreview = (value) =>
  Array.isArray(value) &&
  value.every(
    (participant) =>
      isRecord(participant) &&
      exactKeys(participant, ["profileId", "displayName", "emojiId", "aura"]) &&
      isNullableString(participant.profileId) &&
      isNullableString(participant.displayName) &&
      (participant.emojiId === null ||
        (0, appearance_js_1.isEmojiId)(participant.emojiId)) &&
      (participant.aura === null ||
        (0, appearance_js_1.isAura)(participant.aura)),
  );
const isNavigationItem = (value) => {
  if (!isRecord(value)) return false;
  if (value.entityType === "event") {
    return (
      exactKeys(value, [
        "id",
        "entityType",
        "eventId",
        "status",
        "sortBucket",
        "listSortAtMs",
        "startAtMs",
        "updatedAtMs",
        "endedAtMs",
        "participantCount",
        "participantPreview",
        "winnerDisplayName",
      ]) &&
      typeof value.id === "string" &&
      value.id !== "" &&
      typeof value.eventId === "string" &&
      value.eventId !== "" &&
      value.status !== "pending" &&
      normalizeNavigationStatus(value.status) === value.status &&
      Number.isInteger(value.sortBucket) &&
      Number.isSafeInteger(value.listSortAtMs) &&
      value.listSortAtMs > 0 &&
      isNullableNumber(value.startAtMs) &&
      isNullableNumber(value.updatedAtMs) &&
      isNullableNumber(value.endedAtMs) &&
      Number.isSafeInteger(value.participantCount) &&
      value.participantCount >= 0 &&
      isNavigationParticipantPreview(value.participantPreview) &&
      isNullableString(value.winnerDisplayName)
    );
  }
  return (
    value.entityType === "game" &&
    exactKeys(value, [
      "id",
      "entityType",
      "inviteId",
      "kind",
      "status",
      "sortBucket",
      "listSortAtMs",
      "hostLoginId",
      "guestLoginId",
      "opponentProfileId",
      "opponentName",
      "opponentEmoji",
      "automatchStateHint",
      "isPendingAutomatch",
    ]) &&
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.inviteId === "string" &&
    value.inviteId !== "" &&
    (value.kind === "auto" || value.kind === "direct") &&
    value.status !== "dismissed" &&
    normalizeNavigationStatus(value.status) === value.status &&
    Number.isInteger(value.sortBucket) &&
    Number.isSafeInteger(value.listSortAtMs) &&
    value.listSortAtMs > 0 &&
    isNullableString(value.hostLoginId) &&
    isNullableString(value.guestLoginId) &&
    isNullableString(value.opponentProfileId) &&
    isNullableString(value.opponentName) &&
    (value.opponentEmoji === null ||
      (0, appearance_js_1.isEmojiId)(value.opponentEmoji)) &&
    normalizeStrictAutomatchStateHint(value.automatchStateHint) ===
      value.automatchStateHint &&
    typeof value.isPendingAutomatch === "boolean"
  );
};
exports.isNavigationItem = isNavigationItem;
const isNavigationGamesCursor = (value) =>
  isRecord(value) &&
  exactKeys(value, ["sortBucket", "listSortAtMs", "id"]) &&
  Number.isInteger(value.sortBucket) &&
  Object.values(NAVIGATION_SORT_BUCKETS).includes(value.sortBucket) &&
  Number.isSafeInteger(value.listSortAtMs) &&
  value.listSortAtMs > 0 &&
  typeof value.id === "string" &&
  value.id !== "" &&
  new TextEncoder().encode(value.id).byteLength <= 1500 &&
  !value.id.includes("/");
exports.isNavigationGamesCursor = isNavigationGamesCursor;
const isReadNavigationGamesRequest = (value) =>
  isRecord(value) &&
  exactKeys(value, ["limit", "cursor"]) &&
  Number.isSafeInteger(value.limit) &&
  value.limit >= 1 &&
  value.limit <= 100 &&
  (value.cursor === null || isNavigationGamesCursor(value.cursor));
exports.isReadNavigationGamesRequest = isReadNavigationGamesRequest;
const isReadNavigationGamesResponse = (value) =>
  isRecord(value) &&
  exactKeys(value, ["ok", "items", "nextCursor", "hasMore"]) &&
  value.ok === true &&
  Array.isArray(value.items) &&
  value.items.length <= 100 &&
  value.items.every(isNavigationItem) &&
  (value.nextCursor === null || isNavigationGamesCursor(value.nextCursor)) &&
  typeof value.hasMore === "boolean";
exports.isReadNavigationGamesResponse = isReadNavigationGamesResponse;
const isStartAutomatchRequest = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  (0, appearance_js_1.isEmojiId)(value.emojiId) &&
  (0, appearance_js_1.isAura)(value.aura);
exports.isStartAutomatchRequest = isStartAutomatchRequest;
const isStartAutomatchResponse = (value) => {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok === false) {
    return Object.keys(value).length === 1;
  }
  if (
    Object.keys(value).length !== 4 ||
    typeof value.inviteId !== "string" ||
    value.inviteId.trim() === "" ||
    (value.mode !== "matched" && value.mode !== "pending") ||
    typeof value.matchedImmediately !== "boolean"
  ) {
    return false;
  }
  return value.matchedImmediately === (value.mode === "matched");
};
exports.isStartAutomatchResponse = isStartAutomatchResponse;
const parseStartAutomatchApiResponse = (value) => {
  if (!isRecord(value)) return null;
  const { bootstrap, ...response } = value;
  if (!isStartAutomatchResponse(response)) return null;
  if (
    response.ok &&
    response.mode === "matched" &&
    (0, game_bootstrap_js_1.isReadGameBootstrapResponse)(bootstrap) &&
    bootstrap.metadata.inviteId === response.inviteId &&
    bootstrap.metadata.automatchStateHint === "matched" &&
    bootstrap.viewer.role !== "watch" &&
    bootstrap.match.hostMatch !== null &&
    bootstrap.match.guestMatch !== null
  )
    return { ...response, bootstrap };
  return response;
};
exports.parseStartAutomatchApiResponse = parseStartAutomatchApiResponse;
const isCancelAutomatchResponse = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  typeof value.ok === "boolean";
exports.isCancelAutomatchResponse = isCancelAutomatchResponse;
const isRemoveNavigationGameRequest = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "";
exports.isRemoveNavigationGameRequest = isRemoveNavigationGameRequest;
const isRemoveNavigationGameResponse = (value) => {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.skipped !== "boolean" ||
    typeof value.inviteId !== "string" ||
    value.inviteId === "" ||
    !(value.reason === null || typeof value.reason === "string")
  ) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        key !== "ok" &&
        key !== "skipped" &&
        key !== "deleted" &&
        key !== "reason" &&
        key !== "inviteId",
    )
  ) {
    return false;
  }
  if (Object.hasOwn(value, "deleted") && typeof value.deleted !== "boolean") {
    return false;
  }
  if (!value.skipped) {
    return value.deleted === true && value.reason === null;
  }
  return value.deleted !== true && typeof value.reason === "string";
};
exports.isRemoveNavigationGameResponse = isRemoveNavigationGameResponse;
