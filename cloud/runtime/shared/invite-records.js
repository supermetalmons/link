// Generated from src/shared/invite-records.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInviteFieldDocument =
  exports.createEventInviteDocument =
  exports.createMatchedAutomatchInviteDocument =
  exports.createPendingAutomatchInviteDocument =
  exports.createManualInviteDocument =
  exports.readInviteDocument =
    void 0;
exports.isInviteTransitionEvidence = isInviteTransitionEvidence;
exports.isInviteAutomatchMessage = isInviteAutomatchMessage;
exports.isInviteDocument = isInviteDocument;
exports.readCanonicalInviteParticipants = readCanonicalInviteParticipants;
exports.inviteMutationParticipants = inviteMutationParticipants;
exports.inviteTrimmedParticipants = inviteTrimmedParticipants;
exports.inviteRematchState = inviteRematchState;
exports.presentationInviteView = presentationInviteView;
exports.inviteOpponent = inviteOpponent;
exports.inviteIsEventOwned = inviteIsEventOwned;
exports.inviteTimerEventId = inviteTimerEventId;
exports.inviteRatingEvent = inviteRatingEvent;
exports.inviteMatchesParticipants = inviteMatchesParticipants;
exports.inviteProjectionState = inviteProjectionState;
exports.inviteSourceEventState = inviteSourceEventState;
exports.inviteTelegramFingerprint = inviteTelegramFingerprint;
exports.inviteHistoricalParticipants = inviteHistoricalParticipants;
exports.mergeInviteAutomatchOperation = mergeInviteAutomatchOperation;
const ids_js_1 = require("./ids.js");
const rematches_js_1 = require("./rematches.js");
const FIELDS = [
  "schemaVersion",
  "version",
  "kind",
  "hostId",
  "guestId",
  "hostColor",
  "hostRematches",
  "guestRematches",
  "sessionTransition",
  "automatchMessage",
  "automatchOperationIds",
  "password",
  "automatchStateHint",
  "automatchCanceledAt",
  "telegramDeliveryVersion",
  "eventOwned",
  "eventId",
  "eventRoundIndex",
  "eventMatchKey",
];
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) =>
  record(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const key = (value) =>
  typeof value === "string" &&
  value.trim() === value &&
  (0, ids_js_1.isSafeRecordKey)(value);
const integer = (value, minimum = 0) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const operationIds = (value) =>
  record(value) &&
  Object.entries(value).every(
    ([uid, operation]) =>
      (0, ids_js_1.isCanonicalLoginUid)(uid) && key(operation),
  );
function isInviteTransitionEvidence(value) {
  return (
    exact(value, ["transitionId", "sequence", "digest"]) &&
    key(value.transitionId) &&
    integer(value.sequence) &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest)
  );
}
function isInviteAutomatchMessage(value) {
  return (
    exact(value, ["name", "text", "telegramMessageId"]) &&
    typeof value.name === "string" &&
    typeof value.text === "string" &&
    integer(value.telegramMessageId, 1)
  );
}
function isInviteDocument(value) {
  if (
    !exact(value, FIELDS) ||
    value.schemaVersion !== 1 ||
    value.version !== 2 ||
    !(0, ids_js_1.isCanonicalLoginUid)(value.hostId) ||
    !(
      value.guestId === null ||
      ((0, ids_js_1.isCanonicalLoginUid)(value.guestId) &&
        value.guestId !== value.hostId)
    ) ||
    (value.hostColor !== "white" && value.hostColor !== "black") ||
    !(0, rematches_js_1.isRematchSeries)(value.hostRematches) ||
    !(0, rematches_js_1.isRematchSeries)(value.guestRematches) ||
    !(
      value.sessionTransition === null ||
      isInviteTransitionEvidence(value.sessionTransition)
    ) ||
    !(
      value.automatchMessage === null ||
      isInviteAutomatchMessage(value.automatchMessage)
    ) ||
    !operationIds(value.automatchOperationIds)
  )
    return false;
  if (value.kind === "event")
    return (
      value.password === null &&
      value.automatchStateHint === null &&
      value.automatchCanceledAt === null &&
      value.telegramDeliveryVersion === null &&
      value.eventOwned === true &&
      key(value.eventId) &&
      (value.eventRoundIndex === null ||
        (integer(value.eventRoundIndex) && value.eventRoundIndex < 5)) &&
      key(value.eventMatchKey) &&
      value.guestId !== null &&
      value.automatchMessage === null &&
      Object.keys(value.automatchOperationIds).length === 0
    );
  if (
    value.eventOwned !== false ||
    value.eventId !== null ||
    value.eventRoundIndex !== null ||
    value.eventMatchKey !== null
  )
    return false;
  if (value.kind === "manual")
    return (
      value.password === null &&
      value.automatchStateHint === null &&
      value.automatchCanceledAt === null &&
      value.telegramDeliveryVersion === null &&
      value.automatchMessage === null &&
      Object.keys(value.automatchOperationIds).length === 0
    );
  return (
    value.kind === "automatch" &&
    typeof value.password === "string" &&
    value.password !== "" &&
    (value.automatchStateHint === null ||
      value.automatchStateHint === "pending" ||
      value.automatchStateHint === "matched" ||
      value.automatchStateHint === "canceled") &&
    (value.automatchCanceledAt === null ||
      integer(value.automatchCanceledAt)) &&
    (value.telegramDeliveryVersion === null ||
      value.telegramDeliveryVersion === 2) &&
    (value.automatchStateHint === "canceled"
      ? value.automatchCanceledAt !== null
      : value.automatchCanceledAt === null)
  );
}
const readInviteDocument = (value) => (isInviteDocument(value) ? value : null);
exports.readInviteDocument = readInviteDocument;
function readCanonicalInviteParticipants(value) {
  if (value === null || value === undefined) return { status: "missing" };
  const invite = (0, exports.readInviteDocument)(value);
  return invite === null
    ? { status: "invalid" }
    : {
        status: "ok",
        source: invite,
        hostId: invite.hostId,
        guestId: invite.guestId,
        passwordProtected: invite.password !== null,
      };
}
function inviteMutationParticipants(value) {
  return { hostId: value.hostId, guestId: value.guestId ?? "" };
}
function inviteTrimmedParticipants(value) {
  return { hostId: value?.hostId ?? "", guestId: value?.guestId ?? "" };
}
function inviteRematchState(value) {
  return {
    hostRematches: value.hostRematches,
    guestRematches: value.guestRematches,
    hostColor: value.hostColor,
  };
}
function presentationInviteView(value) {
  return {
    hostId: value.hostId,
    guestId: value.guestId,
    hostRematches: value.source.hostRematches,
    guestRematches: value.source.guestRematches,
  };
}
function inviteOpponent(value, playerId) {
  return value?.hostId === playerId
    ? value.guestId
    : value?.guestId === playerId
      ? value.hostId
      : null;
}
function inviteIsEventOwned(value) {
  return value?.kind === "event";
}
function inviteTimerEventId(value) {
  return value?.kind === "event" ? value.eventId : null;
}
function inviteRatingEvent(value) {
  return {
    isEventMatch: value?.kind === "event",
    eventOwned: value?.kind === "event",
    eventId: value?.eventId ?? null,
  };
}
function inviteMatchesParticipants(value, playerId, opponentId) {
  return (
    value !== null &&
    ((value.hostId === playerId && value.guestId === opponentId) ||
      (value.hostId === opponentId && value.guestId === playerId))
  );
}
function inviteProjectionState(value) {
  return {
    hostId: value?.hostId ?? "",
    guestId: value?.guestId ?? "",
    automatchStateHint: value?.automatchStateHint ?? null,
    automatchCanceledAt: value?.automatchCanceledAt ?? null,
    telegramDeliveryVersion: value?.telegramDeliveryVersion ?? null,
  };
}
function inviteSourceEventState(value) {
  return {
    hostId: value?.hostId,
    guestId: value?.guestId ?? undefined,
    eventId: value?.eventId ?? undefined,
    eventOwned: value?.eventOwned ?? false,
  };
}
function inviteTelegramFingerprint(source, value) {
  return JSON.stringify({ source, guestId: value?.guestId ?? null });
}
function base(value) {
  return {
    schemaVersion: 1,
    ...value,
    hostRematches: { state: "open", indices: [] },
    guestRematches: { state: "open", indices: [] },
    sessionTransition: null,
    automatchMessage: null,
    automatchOperationIds: {},
    password: null,
    automatchStateHint: null,
    automatchCanceledAt: null,
    telegramDeliveryVersion: null,
    eventOwned: false,
    eventId: null,
    eventRoundIndex: null,
    eventMatchKey: null,
  };
}
function requireInvite(value) {
  const invite = (0, exports.readInviteDocument)(value);
  if (!invite) throw new TypeError("invalid-invite-document");
  return invite;
}
const createManualInviteDocument = (value) =>
  requireInvite({ ...base(value), ...value, kind: "manual" });
exports.createManualInviteDocument = createManualInviteDocument;
const createPendingAutomatchInviteDocument = (value) =>
  requireInvite({ ...base(value), ...value, kind: "automatch" });
exports.createPendingAutomatchInviteDocument =
  createPendingAutomatchInviteDocument;
const createMatchedAutomatchInviteDocument = (value) =>
  requireInvite({ ...base(value), ...value, kind: "automatch" });
exports.createMatchedAutomatchInviteDocument =
  createMatchedAutomatchInviteDocument;
const createEventInviteDocument = (value) =>
  requireInvite({ ...base(value), ...value, kind: "event" });
exports.createEventInviteDocument = createEventInviteDocument;
const createInviteFieldDocument = (value) => structuredClone(value);
exports.createInviteFieldDocument = createInviteFieldDocument;
function inviteHistoricalParticipants(value) {
  return { hostId: value.hostId, guestId: value.guestId };
}
function mergeInviteAutomatchOperation(value, current, uid, operationId) {
  if (
    value.kind !== "automatch" ||
    !(0, ids_js_1.isCanonicalLoginUid)(uid) ||
    !key(operationId)
  )
    throw new TypeError("invalid-invite-operation");
  return {
    ...value,
    automatchOperationIds: {
      ...current?.automatchOperationIds,
      [uid]: operationId,
    },
  };
}
