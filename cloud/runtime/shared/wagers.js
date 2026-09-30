// Generated from src/shared/wagers.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWagerProposalSendResponse =
  exports.isWagerProposalSendRequest =
  exports.isWagerProposalRemovalResponse =
  exports.isWagerProposalRemovalRequest =
  exports.isWagerProposalAcceptResponse =
  exports.isWagerProposalAcceptRequest =
  exports.isWagerOutcomeResolveResponse =
  exports.isWagerOutcomeResolveRequest =
  exports.isWagerFrozenReadResponse =
  exports.isWagerFrozenReadRequest =
  exports.isWagerAgreement =
  exports.WAGER_PROPOSAL_SEND_FAILURE_REASONS =
  exports.WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS =
  exports.WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS =
  exports.WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS =
  exports.WAGER_OUTCOME_RESOLVE_FAILURE_REASONS =
  exports.WAGER_FROZEN_READ_PATH =
  exports.WAGER_STORAGE_VERSION =
  exports.WAGER_STORAGE_VERSION_HEADER =
    void 0;
const mining_js_1 = require("./mining.js");
const ids_js_1 = require("./ids.js");
const WAGER_STORAGE_VERSION_HEADER = "X-Mons-Wager-Storage-Version";
exports.WAGER_STORAGE_VERSION_HEADER = WAGER_STORAGE_VERSION_HEADER;
const WAGER_STORAGE_VERSION = "1";
exports.WAGER_STORAGE_VERSION = WAGER_STORAGE_VERSION;
const WAGER_FROZEN_READ_PATH = "/wagers/frozen/read";
exports.WAGER_FROZEN_READ_PATH = WAGER_FROZEN_READ_PATH;
const WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
]);
exports.WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS =
  WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS;
const WAGER_PROPOSAL_SEND_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "insufficient-materials",
  "proposal-unavailable",
]);
exports.WAGER_PROPOSAL_SEND_FAILURE_REASONS =
  WAGER_PROPOSAL_SEND_FAILURE_REASONS;
const WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
  "insufficient-materials",
  "proposal-unavailable",
]);
exports.WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS =
  WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS;
const WAGER_OUTCOME_RESOLVE_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "match-not-found",
]);
exports.WAGER_OUTCOME_RESOLVE_FAILURE_REASONS =
  WAGER_OUTCOME_RESOLVE_FAILURE_REASONS;
const WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS = Object.freeze([
  "no-wager",
  "already-resolved",
]);
exports.WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS =
  WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS;
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, expectedKeys) => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};
const isWagerFrozenReadRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["playerUid"]) &&
  (0, ids_js_1.isSafeRecordKey)(value.playerUid) &&
  value.playerUid === value.playerUid.trim();
exports.isWagerFrozenReadRequest = isWagerFrozenReadRequest;
const isWagerFrozenReadResponse = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "playerUid", "revision", "frozen"]) &&
  value.ok === true &&
  (0, ids_js_1.isSafeRecordKey)(value.playerUid) &&
  value.playerUid === value.playerUid.trim() &&
  Number.isSafeInteger(value.revision) &&
  value.revision >= 0 &&
  isRecord(value.frozen) &&
  hasExactKeys(value.frozen, mining_js_1.MATERIAL_KEYS) &&
  mining_js_1.MATERIAL_KEYS.every(
    (key) => Number.isSafeInteger(value.frozen[key]) && value.frozen[key] >= 0,
  );
exports.isWagerFrozenReadResponse = isWagerFrozenReadResponse;
const isWagerProposalRemovalRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId"]) &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "";
exports.isWagerProposalAcceptRequest = isWagerProposalRemovalRequest;
exports.isWagerProposalRemovalRequest = isWagerProposalRemovalRequest;
const isWagerProposalSendRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId", "material", "count"]) &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "" &&
  (0, mining_js_1.isMaterialName)(value.material) &&
  typeof value.count === "number" &&
  Number.isFinite(value.count) &&
  Number.isSafeInteger((0, mining_js_1.normalizeCount)(value.count)) &&
  (0, mining_js_1.normalizeCount)(value.count) > 0;
exports.isWagerProposalSendRequest = isWagerProposalSendRequest;
const isWagerOutcomeResolveRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId"]) &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "";
exports.isWagerOutcomeResolveRequest = isWagerOutcomeResolveRequest;
const isWagerAgreement = (value) =>
  isRecord(value) &&
  hasExactKeys(value, [
    "material",
    "count",
    "total",
    "proposerId",
    "accepterId",
    "acceptedAt",
  ]) &&
  (0, mining_js_1.isMaterialName)(value.material) &&
  Number.isInteger(value.count) &&
  value.count > 0 &&
  Number.isInteger(value.total) &&
  value.total === value.count * 2 &&
  typeof value.proposerId === "string" &&
  value.proposerId.trim() !== "" &&
  typeof value.accepterId === "string" &&
  value.accepterId.trim() !== "" &&
  Number.isFinite(value.acceptedAt) &&
  value.acceptedAt >= 0;
exports.isWagerAgreement = isWagerAgreement;
const isWagerProposalRemovalResponse = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return hasExactKeys(value, ["ok"]);
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS.includes(value.reason)
  );
};
exports.isWagerProposalRemovalResponse = isWagerProposalRemovalResponse;
const isWagerProposalSendResponse = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    if (!Number.isInteger(value.count) || value.count <= 0) {
      return false;
    }
    if (hasExactKeys(value, ["ok", "count"])) {
      return true;
    }
    return (
      hasExactKeys(value, ["ok", "count", "agreed"]) &&
      isWagerAgreement(value.agreed) &&
      value.agreed.count === value.count
    );
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    WAGER_PROPOSAL_SEND_FAILURE_REASONS.includes(value.reason)
  );
};
exports.isWagerProposalSendResponse = isWagerProposalSendResponse;
const isWagerProposalAcceptResponse = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return (
      hasExactKeys(value, ["ok", "count"]) &&
      Number.isInteger(value.count) &&
      value.count > 0
    );
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS.includes(value.reason)
  );
};
exports.isWagerProposalAcceptResponse = isWagerProposalAcceptResponse;
const isWagerOutcomeResolveResponse = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    if (
      value.mining !== null &&
      !(0, mining_js_1.isMiningSnapshot)(value.mining)
    ) {
      return false;
    }
    if (hasExactKeys(value, ["ok", "mining"])) {
      return true;
    }
    return (
      hasExactKeys(value, ["ok", "reason", "mining"]) &&
      WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS.includes(value.reason)
    );
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    WAGER_OUTCOME_RESOLVE_FAILURE_REASONS.includes(value.reason)
  );
};
exports.isWagerOutcomeResolveResponse = isWagerOutcomeResolveResponse;
