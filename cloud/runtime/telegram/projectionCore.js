// Generated from src/telegram/projectionCore.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldProjectRatingTelegramUpdate =
  exports.resolveAutomatchTelegramLifecycle =
  exports.renderMatchedAutomatchTelegramText =
  exports.normalizeString =
  exports.mergeRatingResultFragment =
  exports.isEventRatingUpdate =
  exports.getAutomatchResultFragments =
  exports.evaluateAutomatchProjectionUpdate =
  exports.buildAutomatchTelegramProjection =
  exports.buildAutomatchProjectionGuard =
  exports.asObject =
  exports.AUTOMATCH_PROJECTION_GUARD_VERSION =
    void 0;
const values_js_1 = require("./values.js");
const node_crypto_1 = require("node:crypto");
const rematches_js_1 = require("../shared/rematches.js");
const automatchSource_js_1 = require("./automatchSource.js");
const AUTOMATCH_PROJECTION_GUARD_VERSION = 1;
exports.AUTOMATCH_PROJECTION_GUARD_VERSION = AUTOMATCH_PROJECTION_GUARD_VERSION;
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
exports.normalizeString = normalizeString;
const normalizeGeneration = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
exports.asObject = asObject;
const resolveAutomatchTelegramLifecycle = (source, inviteData) => {
  if (
    !source ||
    source.version !== automatchSource_js_1.TELEGRAM_AUTOMATCH_VERSION
  ) {
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
exports.resolveAutomatchTelegramLifecycle = resolveAutomatchTelegramLifecycle;
const getAutomatchResultFragments = (inviteId, source) => {
  const results =
    source && source.results && typeof source.results === "object"
      ? source.results
      : {};
  return Object.entries(results)
    .map(([matchId, value]) => ({
      matchId,
      text: normalizeString(
        typeof value === "string"
          ? value
          : value && (0, values_js_1.readProperty)(value, "text"),
      ),
      matchIndex: (0, rematches_js_1.parseInviteMatchIndex)(inviteId, matchId),
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
exports.getAutomatchResultFragments = getAutomatchResultFragments;
const hashText = (value) =>
  (0, node_crypto_1.createHash)("sha256").update(String(value)).digest("hex");
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
exports.evaluateAutomatchProjectionUpdate = evaluateAutomatchProjectionUpdate;
const buildAutomatchProjectionGuard = (projection) => ({
  schemaVersion: AUTOMATCH_PROJECTION_GUARD_VERSION,
  lifecycle: projection.lifecycle,
  sourceGeneration: normalizeGeneration(projection.sourceGeneration),
  sourceRevision: projection.sourceRevision,
  resultDigests: asObject(projection.resultDigests),
});
exports.buildAutomatchProjectionGuard = buildAutomatchProjectionGuard;
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
exports.renderMatchedAutomatchTelegramText = renderMatchedAutomatchTelegramText;
const buildSourceRevision = ({
  lifecycle,
  instanceKey,
  text,
  sourceGeneration,
}) =>
  (0, node_crypto_1.createHash)("sha256")
    .update(
      JSON.stringify({
        version: automatchSource_js_1.TELEGRAM_AUTOMATCH_VERSION,
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
  if (!lifecycle || !source) {
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
exports.buildAutomatchTelegramProjection = buildAutomatchTelegramProjection;
const isEventRatingUpdate = (ratingUpdate) =>
  ratingUpdate &&
  (ratingUpdate.isEventMatch === true ||
    ratingUpdate.eventOwned === true ||
    normalizeString(ratingUpdate.eventId) !== "");
exports.isEventRatingUpdate = isEventRatingUpdate;
const shouldProjectRatingTelegramUpdate = (ratingUpdate) =>
  !!ratingUpdate &&
  ratingUpdate.telegramDeliveryVersion ===
    automatchSource_js_1.TELEGRAM_AUTOMATCH_VERSION &&
  ratingUpdate.status === "done" &&
  !isEventRatingUpdate(ratingUpdate) &&
  normalizeString(ratingUpdate.inviteId) !== "" &&
  normalizeString(ratingUpdate.matchId) !== "" &&
  normalizeString(ratingUpdate.updateRatingMessage) !== "";
exports.shouldProjectRatingTelegramUpdate = shouldProjectRatingTelegramUpdate;
const mergeRatingResultFragment = (source, ratingUpdate) => {
  const record = source || {};
  if (
    !source ||
    record.version !== automatchSource_js_1.TELEGRAM_AUTOMATCH_VERSION ||
    !shouldProjectRatingTelegramUpdate(ratingUpdate)
  ) {
    return { changed: false, source, reason: "skipped" };
  }
  const matchId = normalizeString(ratingUpdate.matchId);
  const existingResults =
    record.results && typeof record.results === "object" ? record.results : {};
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
    typeof record.updatedAtMs === "number" &&
    Number.isFinite(record.updatedAtMs)
      ? Math.floor(record.updatedAtMs)
      : 0;
  const currentGeneration =
    typeof record.generation === "number" &&
    Number.isInteger(record.generation) &&
    record.generation >= 0
      ? record.generation
      : 0;
  return {
    changed: true,
    reason: "inserted",
    source: {
      ...record,
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
exports.mergeRatingResultFragment = mergeRatingResultFragment;
