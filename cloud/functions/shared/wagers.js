const { isMaterialName, normalizeCount } = require("./mining");

const WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
]);

const WAGER_PROPOSAL_SEND_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "insufficient-materials",
  "proposal-unavailable",
]);

const WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
  "insufficient-materials",
  "proposal-unavailable",
]);

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value, expectedKeys) => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};

const isWagerProposalRemovalRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId"]) &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "";

const isWagerProposalSendRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId", "material", "count"]) &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "" &&
  isMaterialName(value.material) &&
  typeof value.count === "number" &&
  Number.isFinite(value.count) &&
  normalizeCount(value.count) > 0;

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
  isMaterialName(value.material) &&
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

module.exports = {
  WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS,
  WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS,
  WAGER_PROPOSAL_SEND_FAILURE_REASONS,
  isWagerAgreement,
  isWagerProposalAcceptRequest: isWagerProposalRemovalRequest,
  isWagerProposalAcceptResponse,
  isWagerProposalRemovalRequest,
  isWagerProposalRemovalResponse,
  isWagerProposalSendRequest,
  isWagerProposalSendResponse,
};
