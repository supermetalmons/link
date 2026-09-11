"use strict";

const { createHash } = require("node:crypto");
const { parseInviteMatchIndex } = require("../shared/rematches");
const { TELEGRAM_AUTOMATCH_VERSION } = require("./automatchSource");

const AUTOMATCH_PROJECTION_GUARD_VERSION = 1;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeGeneration = (value) =>
  Number.isInteger(value) && value >= 0 ? value : 0;

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const resolveAutomatchTelegramLifecycle = (source, inviteData) => {
  if (!source || source.version !== TELEGRAM_AUTOMATCH_VERSION) {
    return null;
  }
  if (normalizeString(inviteData && inviteData.guestId)) {
    return "matched";
  }
  if (
    source.lifecycle === "pending" ||
    source.lifecycle === "matched" ||
    source.lifecycle === "canceled"
  ) {
    return source.lifecycle;
  }
  return null;
};

const getAutomatchResultFragments = (inviteId, source) => {
  const results =
    source && source.results && typeof source.results === "object"
      ? source.results
      : {};
  return Object.entries(results)
    .map(([matchId, value]) => ({
      matchId,
      text: normalizeString(
        typeof value === "string" ? value : value && value.text,
      ),
      matchIndex: parseInviteMatchIndex(inviteId, matchId),
    }))
    .filter((result) => result.matchId !== "" && result.text !== "")
    .sort((left, right) => {
      const leftIndex = left.matchIndex === null ? Infinity : left.matchIndex;
      const rightIndex =
        right.matchIndex === null ? Infinity : right.matchIndex;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      return left.matchId.localeCompare(right.matchId);
    });
};

const hashText = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

const buildResultDigests = (fragments) =>
  Object.fromEntries(
    fragments.map((fragment) => [fragment.matchId, hashText(fragment.text)]),
  );

const inferAutomatchProjectionLifecycle = (record) => {
  const currentRecord = asObject(record);
  const guard = asObject(currentRecord.automatchProjection);
  const appliedInstanceKey = normalizeString(
    asObject(currentRecord.applied).instanceKey,
  );
  const desired = asObject(currentRecord.desired);
  const desiredInstanceKey = normalizeString(desired.instanceKey);
  if (
    guard.lifecycle === "matched" ||
    appliedInstanceKey.startsWith("matched:") ||
    desiredInstanceKey.startsWith("matched:")
  ) {
    return "matched";
  }
  if (
    guard.lifecycle === "canceled" ||
    (desired.operation === "edit" &&
      desired.ifMissing === "skip" &&
      desiredInstanceKey.startsWith("waiting:"))
  ) {
    return "canceled";
  }
  if (
    guard.lifecycle === "pending" ||
    desiredInstanceKey.startsWith("waiting:")
  ) {
    return "pending";
  }
  return null;
};

const containsProtectedResultDigests = (candidateDigests, protectedDigests) =>
  Object.entries(asObject(protectedDigests)).every(
    ([matchId, digest]) =>
      normalizeString(digest) !== "" && candidateDigests[matchId] === digest,
  );

const evaluateAutomatchProjectionUpdate = (record, projection) => {
  const currentRecord = asObject(record);
  const currentGuard = asObject(currentRecord.automatchProjection);
  const currentLifecycle = inferAutomatchProjectionLifecycle(currentRecord);
  const candidateLifecycle = projection.lifecycle;
  const currentGeneration = normalizeGeneration(currentGuard.sourceGeneration);
  const candidateGeneration = normalizeGeneration(projection.sourceGeneration);

  if (currentGeneration > candidateGeneration) {
    return { allowed: false, reason: "older-generation" };
  }
  if (currentLifecycle === "matched" && candidateLifecycle !== "matched") {
    return { allowed: false, reason: "matched-regression" };
  }
  if (currentLifecycle === "canceled" && candidateLifecycle === "pending") {
    return { allowed: false, reason: "canceled-regression" };
  }
  if (
    currentLifecycle === "matched" &&
    candidateLifecycle === "matched" &&
    !containsProtectedResultDigests(
      asObject(projection.resultDigests),
      asObject(currentGuard.resultDigests),
    )
  ) {
    return { allowed: false, reason: "result-regression" };
  }
  return { allowed: true, reason: "advanced" };
};

const buildAutomatchProjectionGuard = (projection) => ({
  schemaVersion: AUTOMATCH_PROJECTION_GUARD_VERSION,
  lifecycle: projection.lifecycle,
  sourceGeneration: normalizeGeneration(projection.sourceGeneration),
  sourceRevision: projection.sourceRevision,
  resultDigests: asObject(projection.resultDigests),
});

const renderMatchedAutomatchTelegramText = (inviteId, source) => {
  const matchedText = normalizeString(source && source.matchedText);
  if (!matchedText) {
    return "";
  }
  const fragments = getAutomatchResultFragments(inviteId, source);
  if (fragments.length === 0) {
    return matchedText;
  }
  return `${matchedText}\n\n${fragments.map((fragment) => fragment.text).join("\n\n")}`;
};

const buildSourceRevision = ({
  lifecycle,
  instanceKey,
  text,
  sourceGeneration,
}) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        version: TELEGRAM_AUTOMATCH_VERSION,
        lifecycle,
        instanceKey,
        text,
        sourceGeneration,
      }),
    )
    .digest("hex");

const buildAutomatchTelegramProjection = ({ inviteId, source, inviteData }) => {
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId) {
    return null;
  }
  const lifecycle = resolveAutomatchTelegramLifecycle(source, inviteData);
  if (!lifecycle) {
    return null;
  }

  let operation;
  let instanceKey;
  let text;
  let ifMissing;
  let resultFragments = [];

  if (lifecycle === "pending") {
    operation = "send";
    instanceKey = normalizeString(source.waitingInstanceKey);
    text = normalizeString(source.waitingText);
  } else if (lifecycle === "canceled") {
    operation = "edit";
    instanceKey = normalizeString(source.waitingInstanceKey);
    text = normalizeString(source.canceledText);
    ifMissing = "skip";
  } else {
    resultFragments = getAutomatchResultFragments(normalizedInviteId, source);
    operation = resultFragments.length > 0 ? "edit" : "send";
    instanceKey = normalizeString(source.matchedInstanceKey);
    text = renderMatchedAutomatchTelegramText(normalizedInviteId, source);
    ifMissing = resultFragments.length > 0 ? "send" : undefined;
  }

  if (!instanceKey || !text) {
    return null;
  }

  const sourceGeneration = normalizeGeneration(source.generation);
  return {
    operation,
    lifecycle,
    messageKey: `automatch:${normalizedInviteId}`,
    destination: "community",
    instanceKey,
    text,
    parseMode: "HTML",
    silent: false,
    ...(ifMissing ? { ifMissing } : {}),
    sourceGeneration,
    resultDigests: buildResultDigests(resultFragments),
    sourceRevision: buildSourceRevision({
      lifecycle,
      instanceKey,
      text,
      sourceGeneration,
    }),
  };
};

const isEventRatingUpdate = (ratingUpdate) =>
  ratingUpdate &&
  (ratingUpdate.isEventMatch === true ||
    ratingUpdate.eventOwned === true ||
    normalizeString(ratingUpdate.eventId) !== "");

const shouldProjectRatingTelegramUpdate = (ratingUpdate) =>
  !!ratingUpdate &&
  ratingUpdate.telegramDeliveryVersion === TELEGRAM_AUTOMATCH_VERSION &&
  ratingUpdate.status === "done" &&
  !isEventRatingUpdate(ratingUpdate) &&
  normalizeString(ratingUpdate.inviteId) !== "" &&
  normalizeString(ratingUpdate.matchId) !== "" &&
  normalizeString(ratingUpdate.updateRatingMessage) !== "";

const shouldRequestEventRatingProgress = (ratingUpdate) =>
  !!ratingUpdate &&
  ratingUpdate.status === "done" &&
  ratingUpdate.isEventMatch === true &&
  ratingUpdate.eventOwned === true &&
  normalizeString(ratingUpdate.eventId) !== "" &&
  normalizeString(ratingUpdate.inviteId) !== "" &&
  normalizeString(ratingUpdate.matchId) !== "";

const mergeRatingResultFragment = (source, ratingUpdate) => {
  if (
    !source ||
    source.version !== TELEGRAM_AUTOMATCH_VERSION ||
    !shouldProjectRatingTelegramUpdate(ratingUpdate)
  ) {
    return { changed: false, source, reason: "skipped" };
  }
  const matchId = normalizeString(ratingUpdate.matchId);
  const existingResults =
    source.results && typeof source.results === "object" ? source.results : {};
  if (Object.hasOwn(existingResults, matchId)) {
    return { changed: false, source, reason: "duplicate" };
  }
  const completedAtMs =
    typeof ratingUpdate.completedAtMs === "number" &&
    Number.isFinite(ratingUpdate.completedAtMs)
      ? Math.floor(ratingUpdate.completedAtMs)
      : null;
  const result = {
    text: ratingUpdate.updateRatingMessage,
    ...(completedAtMs === null ? {} : { completedAtMs }),
  };
  const currentUpdatedAtMs =
    typeof source.updatedAtMs === "number" &&
    Number.isFinite(source.updatedAtMs)
      ? Math.floor(source.updatedAtMs)
      : 0;
  const currentGeneration =
    Number.isInteger(source.generation) && source.generation >= 0
      ? source.generation
      : 0;
  return {
    changed: true,
    reason: "inserted",
    source: {
      ...source,
      results: {
        ...existingResults,
        [matchId]: result,
      },
      updatedAtMs:
        completedAtMs === null
          ? currentUpdatedAtMs
          : Math.max(currentUpdatedAtMs, completedAtMs),
      generation: currentGeneration + 1,
    },
  };
};

module.exports = {
  AUTOMATCH_PROJECTION_GUARD_VERSION,
  asObject,
  buildAutomatchProjectionGuard,
  buildAutomatchTelegramProjection,
  evaluateAutomatchProjectionUpdate,
  getAutomatchResultFragments,
  isEventRatingUpdate,
  mergeRatingResultFragment,
  normalizeString,
  renderMatchedAutomatchTelegramText,
  resolveAutomatchTelegramLifecycle,
  shouldProjectRatingTelegramUpdate,
  shouldRequestEventRatingProgress,
};
