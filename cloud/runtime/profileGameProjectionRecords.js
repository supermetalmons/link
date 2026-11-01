// Generated from src/profileGameProjectionRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isProfileGameProjectionRecord =
  exports.parseProfileGameProjectionRecord = void 0;
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
const appearance_js_1 = require("./shared/appearance.js");
const profile_game_projections_js_1 = require("./shared/profile-game-projections.js");
var profile_game_projections_js_2 = require("./shared/profile-game-projections.js");
Object.defineProperty(exports, "parseProfileGameProjectionRecord", {
  enumerable: true,
  get: function () {
    return profile_game_projections_js_2.parseProfileGameProjectionRecord;
  },
});
Object.defineProperty(exports, "isProfileGameProjectionRecord", {
  enumerable: true,
  get: function () {
    return profile_game_projections_js_2.isProfileGameProjectionRecord;
  },
});
function retainProfileGameProjection(value) {
  return (0, profile_game_projections_js_1.parseProfileGameProjectionRecord)(
    value,
  );
}
function createGameProjection(value) {
  return (0, profile_game_projections_js_1.parseProfileGameProjectionRecord)(
    value,
  );
}
function createEventProjection(value) {
  return (0, profile_game_projections_js_1.parseProfileGameProjectionRecord)(
    value,
  );
}
function retainProjectionProfile(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid-projection-profile");
  const fields = Object.fromEntries(Object.entries(value));
  if (
    Object.keys(fields).length !== 4 ||
    typeof fields.eth !== "string" ||
    typeof fields.sol !== "string" ||
    typeof fields.username !== "string" ||
    !(fields.emoji === null || (0, appearance_js_1.isEmojiId)(fields.emoji))
  )
    throw new TypeError("invalid-projection-profile");
  return {
    eth: fields.eth,
    sol: fields.sol,
    username: fields.username,
    emoji: fields.emoji,
  };
}
function createProjectionProfile(value) {
  return retainProjectionProfile(value);
}
function projectionOwnerLoginId(value) {
  return value.entityType === "game" ? value.ownerLoginId : null;
}
function projectionOwnerRole(_profileId, value) {
  return value?.entityType === "game" ? value.ownerRole : null;
}
function projectionOpponentName(value) {
  return value?.entityType === "game" ? value.opponentName : null;
}
function projectionOpponentEmoji(value) {
  return value?.entityType === "game" ? value.opponentEmoji : null;
}
function projectionFreshness(value) {
  return value.entityType === "game"
    ? Math.max(
        value.updatedAt,
        value.lastEventAt,
        value.listSortAt,
        value.createdAt,
      )
    : Math.max(value.updatedAt, value.listSortAt);
}
function projectionLastFingerprint(value) {
  return value?.entityType === "game" ? value.lastEventFingerprint : null;
}
function projectionTime(value, field) {
  if (value === null) return null;
  if (field === "createdAt")
    return value.entityType === "game" ? value.createdAt : null;
  return value[field];
}
function projectionMergeFreshness(value) {
  return Math.max(value.updatedAt, value.listSortAt);
}
function copyProjectionOwner(value, ownerProfileId) {
  return (0, profile_game_projections_js_1.parseProfileGameProjectionRecord)({
    ...value,
    ownerProfileId,
  });
}
