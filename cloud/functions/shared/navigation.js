const { isAutoInviteId } = require("./ids");

const NAVIGATION_SORT_BUCKETS = Object.freeze({
  pending: 20,
  waiting: 30,
  active: 40,
  ended: 50,
  dismissed: 50,
});

const normalizeStrictAutomatchStateHint = (value) =>
  value === "pending" || value === "matched" || value === "canceled"
    ? value
    : null;

const normalizeAutomatchStateHint = (value) =>
  typeof value === "string"
    ? normalizeStrictAutomatchStateHint(value.trim())
    : null;

const inferAutomatchStateHint = ({
  inviteId,
  queueValue,
  hasGuest,
  storedStateHint,
}) => {
  if (!isAutoInviteId(inviteId)) {
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

const isRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected) => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
};

const readTimestampMillis = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return 0;
};

const normalizeStringOrNull = (value) =>
  typeof value === "string" && value !== "" ? value : null;

const normalizeFiniteNumber = (value, fallback = 0) => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value !== ""
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};

const normalizeNavigationStatus = (status) =>
  status === "pending" ||
  status === "waiting" ||
  status === "active" ||
  status === "ended" ||
  status === "dismissed"
    ? status
    : "waiting";

const mapProjectionParticipantPreview = (value) => {
  if (!Array.isArray(value)) return [];
  return value.reduce((participants, candidate) => {
    if (!isRecord(candidate)) return participants;
    const emojiId = normalizeFiniteNumber(candidate.emojiId, NaN);
    participants.push({
      profileId: normalizeStringOrNull(candidate.profileId),
      displayName: normalizeStringOrNull(candidate.displayName),
      emojiId: Number.isFinite(emojiId) ? emojiId : null,
      aura: normalizeStringOrNull(candidate.aura),
    });
    return participants;
  }, []);
};

const mapProfileGameProjection = (rawData, fallbackProjectionId) => {
  if (!isRecord(rawData)) return null;
  const entityType = rawData.entityType === "event" ? "event" : "game";
  if (entityType === "event") {
    const eventId = normalizeStringOrNull(rawData.eventId);
    if (!eventId) return null;
    const rawStatus = normalizeNavigationStatus(rawData.status);
    if (rawStatus === "pending") return null;
    const participantPreview = mapProjectionParticipantPreview(
      rawData.participantPreview,
    );
    return {
      id:
        typeof rawData.id === "string" && rawData.id !== ""
          ? rawData.id
          : `event_${eventId}`,
      entityType: "event",
      eventId,
      status: rawStatus,
      sortBucket: getNavigationSortBucket(rawStatus),
      listSortAtMs: readTimestampMillis(rawData.listSortAt) || Date.now(),
      startAtMs: readTimestampMillis(rawData.startAt) || null,
      updatedAtMs: readTimestampMillis(rawData.updatedAt) || null,
      endedAtMs: readTimestampMillis(rawData.endedAt) || null,
      participantCount: normalizeFiniteNumber(
        rawData.participantCount,
        participantPreview.length,
      ),
      participantPreview,
      winnerDisplayName: normalizeStringOrNull(rawData.winnerDisplayName),
    };
  }

  const inviteId =
    typeof rawData.inviteId === "string" && rawData.inviteId !== ""
      ? rawData.inviteId
      : fallbackProjectionId;
  if (!inviteId) return null;
  const rawStatus = normalizeNavigationStatus(rawData.status);
  const status = rawStatus === "dismissed" ? "ended" : rawStatus;
  const rawOpponentEmoji = rawData.opponentEmoji ?? rawData.opponentEmojiId;
  const rawOpponentName = rawData.opponentName ?? rawData.opponentDisplayName;
  const opponentEmoji = normalizeFiniteNumber(rawOpponentEmoji, NaN);
  const normalizedOpponentEmoji = Number.isFinite(opponentEmoji)
    ? opponentEmoji
    : null;
  if (
    (status === "active" || status === "ended") &&
    normalizedOpponentEmoji === null
  ) {
    return null;
  }
  return {
    id: inviteId,
    entityType: "game",
    inviteId,
    kind: rawData.kind === "auto" ? "auto" : "direct",
    status,
    sortBucket: getNavigationSortBucket(status),
    listSortAtMs: readTimestampMillis(rawData.listSortAt) || Date.now(),
    hostLoginId: normalizeStringOrNull(rawData.hostLoginId),
    guestLoginId: normalizeStringOrNull(rawData.guestLoginId),
    opponentProfileId: normalizeStringOrNull(rawData.opponentProfileId),
    opponentName: typeof rawOpponentName === "string" ? rawOpponentName : null,
    opponentEmoji: normalizedOpponentEmoji,
    automatchStateHint: normalizeStrictAutomatchStateHint(
      rawData.automatchStateHint,
    ),
    isPendingAutomatch:
      typeof rawData.isPendingAutomatch === "boolean"
        ? rawData.isPendingAutomatch
        : status === "pending",
  };
};

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
      isNullableNumber(participant.emojiId) &&
      isNullableString(participant.aura),
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
    isNullableNumber(value.opponentEmoji) &&
    normalizeStrictAutomatchStateHint(value.automatchStateHint) ===
      value.automatchStateHint &&
    typeof value.isPendingAutomatch === "boolean"
  );
};

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

const isReadNavigationGamesRequest = (value) =>
  isRecord(value) &&
  exactKeys(value, ["limit", "cursor"]) &&
  Number.isSafeInteger(value.limit) &&
  value.limit >= 1 &&
  value.limit <= 100 &&
  (value.cursor === null || isNavigationGamesCursor(value.cursor));

const isReadNavigationGamesResponse = (value) =>
  isRecord(value) &&
  exactKeys(value, ["ok", "items", "nextCursor", "hasMore"]) &&
  value.ok === true &&
  Array.isArray(value.items) &&
  value.items.length <= 100 &&
  value.items.every(isNavigationItem) &&
  (value.nextCursor === null || isNavigationGamesCursor(value.nextCursor)) &&
  typeof value.hasMore === "boolean";

const isStartAutomatchRequest = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  Number.isInteger(value.emojiId) &&
  value.emojiId > 0 &&
  typeof value.aura === "string";

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

const isCancelAutomatchResponse = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  typeof value.ok === "boolean";

const isRemoveNavigationGameRequest = (value) =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "";

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

module.exports = {
  NAVIGATION_SORT_BUCKETS,
  normalizeAutomatchStateHint,
  normalizeStrictAutomatchStateHint,
  inferAutomatchStateHint,
  getNavigationStatusPriority,
  getNavigationSortBucket,
  compareNavigationItems,
  mapProfileGameProjection,
  isNavigationItem,
  isNavigationGamesCursor,
  isReadNavigationGamesRequest,
  isReadNavigationGamesResponse,
  isStartAutomatchRequest,
  isStartAutomatchResponse,
  isCancelAutomatchResponse,
  isRemoveNavigationGameRequest,
  isRemoveNavigationGameResponse,
};
