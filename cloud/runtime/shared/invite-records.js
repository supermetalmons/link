// Generated from src/shared/invite-records.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInviteFieldDocument =
  exports.createEventInviteDocument =
  exports.createMatchedAutomatchInviteDocument =
  exports.createPendingAutomatchInviteDocument =
  exports.createManualInviteDocument =
    void 0;
exports.readInviteDocument = readInviteDocument;
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
exports.inviteRatingWager = inviteRatingWager;
const ids_js_1 = require("./ids.js");
const fields = (value) => value ?? {};
const string = (value) => (typeof value === "string" ? value : "");
function readInviteDocument(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}
function readCanonicalInviteParticipants(value) {
  if (value === null || value === undefined) return { status: "missing" };
  const source = readInviteDocument(value);
  if (!source) return { status: "invalid" };
  const invite = fields(source);
  const hostId = invite.hostId;
  const guestId = invite.guestId ?? null;
  if (
    !(0, ids_js_1.isCanonicalLoginUid)(hostId) ||
    (guestId !== null &&
      (!(0, ids_js_1.isCanonicalLoginUid)(guestId) || guestId === hostId))
  ) {
    return { status: "invalid" };
  }
  return {
    status: "ok",
    source,
    hostId,
    guestId,
    passwordProtected: Object.hasOwn(source, "password"),
  };
}
function inviteMutationParticipants(value) {
  const invite = fields(value);
  return { hostId: string(invite.hostId), guestId: string(invite.guestId) };
}
function inviteTrimmedParticipants(value) {
  const invite = fields(value);
  return {
    hostId: string(invite.hostId).trim(),
    guestId: string(invite.guestId).trim(),
  };
}
function inviteRematchState(value) {
  const invite = fields(value);
  return {
    hostRematches:
      typeof invite.hostRematches === "string"
        ? invite.hostRematches
        : undefined,
    guestRematches:
      typeof invite.guestRematches === "string"
        ? invite.guestRematches
        : undefined,
    hostColor: invite.hostColor === "black" ? "black" : "white",
  };
}
function presentationInviteView(value) {
  const rematches = inviteRematchState(value.source);
  return {
    ...value.source,
    hostId: value.hostId,
    guestId: value.guestId,
    hostRematches: rematches.hostRematches,
    guestRematches: rematches.guestRematches,
  };
}
function inviteOpponent(value, playerId) {
  const invite = fields(value);
  const opponentId =
    invite.hostId === playerId
      ? invite.guestId
      : invite.guestId === playerId
        ? invite.hostId
        : null;
  return typeof opponentId === "string" ? opponentId : null;
}
function inviteIsEventOwned(value) {
  const invite = fields(value);
  return (
    invite.eventOwned === true ||
    (typeof invite.eventId === "string" && invite.eventId.trim() !== "")
  );
}
function inviteTimerEventId(value) {
  const invite = fields(value);
  return invite.eventOwned === true && typeof invite.eventId === "string"
    ? invite.eventId
    : null;
}
function inviteRatingEvent(value) {
  const invite = fields(value);
  const eventId =
    typeof invite.eventId === "string" && invite.eventId.trim() !== ""
      ? invite.eventId.trim()
      : null;
  return {
    isEventMatch: invite.eventOwned === true || eventId !== null,
    eventOwned: invite.eventOwned === true,
    eventId,
  };
}
function inviteMatchesParticipants(value, playerId, opponentId) {
  if (!value) return false;
  const invite = fields(value);
  return (
    (invite.hostId === playerId && invite.guestId === opponentId) ||
    (invite.hostId === opponentId && invite.guestId === playerId)
  );
}
function inviteProjectionState(value) {
  const invite = fields(value);
  return {
    hostId: string(invite.hostId),
    guestId: string(invite.guestId),
    automatchStateHint:
      typeof invite.automatchStateHint === "string"
        ? invite.automatchStateHint
        : null,
    automatchCanceledAt:
      typeof invite.automatchCanceledAt === "number"
        ? invite.automatchCanceledAt
        : null,
    telegramDeliveryVersion: invite.telegramDeliveryVersion === 2 ? 2 : null,
  };
}
function inviteSourceEventState(value) {
  const invite = fields(value);
  return {
    hostId: typeof invite.hostId === "string" ? invite.hostId : undefined,
    guestId: typeof invite.guestId === "string" ? invite.guestId : undefined,
    eventId: typeof invite.eventId === "string" ? invite.eventId : undefined,
    eventOwned: invite.eventOwned === true,
  };
}
function inviteTelegramFingerprint(source, value) {
  return JSON.stringify({ source, guestId: fields(value).guestId || null });
}
const createManualInviteDocument = (value) => readInviteDocument(value);
exports.createManualInviteDocument = createManualInviteDocument;
const createPendingAutomatchInviteDocument = (value) =>
  readInviteDocument(value);
exports.createPendingAutomatchInviteDocument =
  createPendingAutomatchInviteDocument;
const createMatchedAutomatchInviteDocument = (value) =>
  readInviteDocument(value);
exports.createMatchedAutomatchInviteDocument =
  createMatchedAutomatchInviteDocument;
const createEventInviteDocument = (value) => readInviteDocument(value);
exports.createEventInviteDocument = createEventInviteDocument;
const createInviteFieldDocument = (value) => readInviteDocument(value);
exports.createInviteFieldDocument = createInviteFieldDocument;
function inviteHistoricalParticipants(value) {
  const invite = fields(value);
  return { hostId: String(invite.hostId), guestId: String(invite.guestId) };
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}
function mergeInviteAutomatchOperation(value, current, uid, operationId) {
  const operationIds = record(fields(current).automatchOperationIds);
  const valid = [];
  for (const [ownerUid, storedOperationId] of Object.entries(
    operationIds || {},
  )) {
    if (
      (0, ids_js_1.isSafeRecordKey)(ownerUid) &&
      typeof storedOperationId === "string" &&
      (0, ids_js_1.isSafeRecordKey)(storedOperationId)
    ) {
      valid.push([ownerUid, storedOperationId]);
    }
  }
  return readInviteDocument({
    ...value,
    automatchOperationIds: { ...Object.fromEntries(valid), [uid]: operationId },
  });
}
function inviteRatingWager(value, matchId) {
  const wagers = record(fields(value).wagers);
  const wager = record(wagers?.[matchId]);
  const agreed = record(wager?.agreed);
  return {
    material:
      typeof agreed?.material === "string" ? agreed.material.trim() : "",
    count: Number(agreed?.count),
  };
}
