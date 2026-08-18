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
  isStartAutomatchRequest,
  isStartAutomatchResponse,
  isCancelAutomatchResponse,
  isRemoveNavigationGameRequest,
  isRemoveNavigationGameResponse,
};
