// Generated from src/profileGameProjectionRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retainProfileGameProjection = retainProfileGameProjection;
exports.createGameProjection = createGameProjection;
exports.createEventProjection = createEventProjection;
exports.retainProjectionProfile = retainProjectionProfile;
exports.createProjectionProfile = createProjectionProfile;
exports.projectionOwnerLoginId = projectionOwnerLoginId;
exports.projectionOwnerRole = projectionOwnerRole;
exports.projectionOpponentName = projectionOpponentName;
exports.projectionOpponentEmoji = projectionOpponentEmoji;
exports.projectionFreshness = projectionFreshness;
exports.projectionLastFingerprint = projectionLastFingerprint;
exports.projectionTime = projectionTime;
exports.projectionMergeFreshness = projectionMergeFreshness;
exports.copyProjectionOwner = copyProjectionOwner;
const fields = (value) => {
  const retained = value;
  return retained;
};
const text = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const timestamp = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
const emoji = (value) => {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
};
function retainProfileGameProjection(value) {
  return value;
}
function createGameProjection(value) {
  const retained = value;
  return retained;
}
function createEventProjection(value) {
  const retained = value;
  return retained;
}
function retainProjectionProfile(value) {
  return value;
}
function createProjectionProfile(value) {
  const retained = value;
  return retained;
}
function projectionOwnerLoginId(value) {
  return text(fields(value).ownerLoginId);
}
function projectionOwnerRole(profileId, value) {
  const data = value && fields(value);
  const ownerRole = text(data && data.ownerRole);
  if (ownerRole === "host" || ownerRole === "guest") return ownerRole;
  const ownerProfileId = text(data && data.ownerProfileId) || profileId;
  if (ownerProfileId === text(data && data.hostProfileId)) return "host";
  if (ownerProfileId === text(data && data.guestProfileId)) return "guest";
  return null;
}
function projectionOpponentName(value) {
  const data = value && fields(value);
  return text(data ? (data.opponentName ?? data.opponentDisplayName) : null);
}
function projectionOpponentEmoji(value) {
  const data = value && fields(value);
  return emoji(data ? (data.opponentEmoji ?? data.opponentEmojiId) : null);
}
function projectionFreshness(value) {
  const data = fields(value);
  return [
    data.updatedAt,
    data.lastEventAt,
    data.listSortAt,
    data.createdAt,
  ].reduce((current, value) => {
    const millis = timestamp(value);
    return Number.isFinite(millis) ? Math.max(current, millis) : current;
  }, Number.NEGATIVE_INFINITY);
}
function projectionLastFingerprint(value) {
  const data = value && fields(value);
  return data && typeof data.lastEventFingerprint === "string"
    ? data.lastEventFingerprint
    : null;
}
function projectionTime(value, field) {
  const data = value && fields(value);
  return timestamp(data && data[field]);
}
function projectionMergeFreshness(value) {
  const data = fields(value);
  return Math.max(
    timestamp(data.updatedAt) ?? 0,
    timestamp(data.listSortAt) ?? 0,
  );
}
function copyProjectionOwner(value, ownerProfileId) {
  return retainProfileGameProjection({ ...value, ownerProfileId });
}
