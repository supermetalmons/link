// Generated from src/shared/rematches.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHistoricalMatchIds =
  exports.deriveLatestMatchId =
  exports.selectInviteMatch =
  exports.getLatestApprovedRematchIndex =
  exports.getLatestRematchIndex =
  exports.getHintMatchIndex =
  exports.parseInviteMatchIndex =
  exports.createInviteCandidatesFromMatchId =
  exports.inviteMatchesPlayers =
  exports.rematchSeriesEnded =
  exports.parseRematchIndices =
    void 0;
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const parseCanonicalRematchIndex = (value) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const parseRematchIndices = (rawValue) => {
  if (typeof rawValue !== "string" || rawValue === "") {
    return [];
  }
  const normalized = rawValue.endsWith("x") ? rawValue.slice(0, -1) : rawValue;
  if (normalized === "") {
    return [];
  }
  return normalized
    .split(";")
    .map(parseCanonicalRematchIndex)
    .filter((value) => value !== null);
};
exports.parseRematchIndices = parseRematchIndices;
const rematchSeriesEnded = (inviteData) => {
  if (!inviteData || typeof inviteData !== "object") {
    return false;
  }
  const record = inviteData;
  const hostRematches =
    typeof record.hostRematches === "string" ? record.hostRematches : "";
  const guestRematches =
    typeof record.guestRematches === "string" ? record.guestRematches : "";
  return hostRematches.endsWith("x") || guestRematches.endsWith("x");
};
exports.rematchSeriesEnded = rematchSeriesEnded;
const inviteMatchesPlayers = (inviteData, playerId, opponentId) =>
  !!inviteData &&
  typeof inviteData === "object" &&
  ((inviteData.hostId === playerId && inviteData.guestId === opponentId) ||
    (inviteData.hostId === opponentId && inviteData.guestId === playerId));
exports.inviteMatchesPlayers = inviteMatchesPlayers;
const createInviteCandidatesFromMatchId = (matchId) => {
  const candidates = [];
  for (let splitIndex = matchId.length - 1; splitIndex > 0; splitIndex -= 1) {
    const suffix = matchId.slice(splitIndex);
    if (parseCanonicalRematchIndex(suffix) === null) {
      continue;
    }
    const prefix = matchId.slice(0, splitIndex);
    if (!candidates.includes(prefix)) {
      candidates.push(prefix);
    }
  }
  return candidates;
};
exports.createInviteCandidatesFromMatchId = createInviteCandidatesFromMatchId;
const parseInviteMatchIndex = (inviteId, matchId) => {
  if (
    typeof inviteId !== "string" ||
    inviteId === "" ||
    typeof matchId !== "string" ||
    matchId === ""
  ) {
    return null;
  }
  if (matchId === inviteId) {
    return 0;
  }
  if (!matchId.startsWith(inviteId)) {
    return null;
  }
  const suffix = matchId.slice(inviteId.length);
  return parseCanonicalRematchIndex(suffix);
};
exports.parseInviteMatchIndex = parseInviteMatchIndex;
const getHintMatchIndex = (inviteId, latestMatchIdHint) => {
  const rawIndex = parseInviteMatchIndex(inviteId, latestMatchIdHint);
  if (rawIndex !== null) {
    return rawIndex;
  }
  const normalizedInviteId = normalizeString(inviteId);
  const normalizedHint = normalizeString(latestMatchIdHint);
  if (!normalizedInviteId || !normalizedHint) {
    return 0;
  }
  return parseInviteMatchIndex(normalizedInviteId, normalizedHint) || 0;
};
exports.getHintMatchIndex = getHintMatchIndex;
const getLatestRematchIndex = (inviteData, minimumIndex = 0) => {
  const hostIndices = parseRematchIndices(
    inviteData ? inviteData.hostRematches : null,
  );
  const guestIndices = parseRematchIndices(
    inviteData ? inviteData.guestRematches : null,
  );
  let maxIndex =
    Number.isFinite(minimumIndex) && minimumIndex > 0
      ? Math.floor(minimumIndex)
      : 0;
  hostIndices.forEach((index) => {
    if (index > maxIndex) {
      maxIndex = index;
    }
  });
  guestIndices.forEach((index) => {
    if (index > maxIndex) {
      maxIndex = index;
    }
  });
  return maxIndex;
};
exports.getLatestRematchIndex = getLatestRematchIndex;
const getApprovedRematchIndices = (inviteData) => {
  const hostIndices = parseRematchIndices(
    inviteData ? inviteData.hostRematches : null,
  );
  const guestIndices = parseRematchIndices(
    inviteData ? inviteData.guestRematches : null,
  );
  const approved = [];
  for (
    let index = 0;
    index < Math.min(hostIndices.length, guestIndices.length);
    index++
  ) {
    if (hostIndices[index] !== guestIndices[index]) break;
    approved.push(hostIndices[index]);
  }
  return approved;
};
const getLatestApprovedRematchIndex = (inviteData) =>
  getApprovedRematchIndices(inviteData).at(-1) || 0;
exports.getLatestApprovedRematchIndex = getLatestApprovedRematchIndex;
const selectInviteMatch = (inviteId, inviteData, actorUid, options = {}) => {
  const hostIndices = parseRematchIndices(inviteData?.hostRematches);
  const guestIndices = parseRematchIndices(inviteData?.guestRematches);
  let index = getLatestApprovedRematchIndex(inviteData);
  const hasPendingProposal = Boolean(
    !options.preferApproved &&
    !rematchSeriesEnded(inviteData) &&
    actorUid &&
    ((inviteData?.hostId === actorUid &&
      hostIndices.length > guestIndices.length) ||
      (inviteData?.guestId === actorUid &&
        guestIndices.length > hostIndices.length)),
  );
  if (hasPendingProposal) index += 1;
  return {
    matchId: index > 0 ? `${inviteId}${index}` : inviteId,
    hasPendingProposal,
  };
};
exports.selectInviteMatch = selectInviteMatch;
const deriveLatestMatchId = (inviteId, inviteData, latestMatchIdHint) => {
  const hintedIndex = getHintMatchIndex(inviteId, latestMatchIdHint);
  const maxIndex = getLatestRematchIndex(inviteData, hintedIndex);
  return maxIndex > 0 ? `${inviteId}${maxIndex}` : inviteId;
};
exports.deriveLatestMatchId = deriveLatestMatchId;
const getHistoricalMatchIds = (inviteId, inviteData) => {
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId || !inviteData || typeof inviteData !== "object") {
    return [];
  }
  const approvedIndices = Array.from(
    new Set(getApprovedRematchIndices(inviteData)),
  );
  const latestProposedIndex = getLatestRematchIndex(inviteData);
  if (latestProposedIndex === 0) {
    return rematchSeriesEnded(inviteData) ? [normalizedInviteId] : [];
  }
  const candidateIndices = [0, ...approvedIndices];
  const historicalIndices = rematchSeriesEnded(inviteData)
    ? candidateIndices
    : candidateIndices.filter((index) => index < latestProposedIndex);
  return historicalIndices.map((index) =>
    index === 0 ? normalizedInviteId : `${normalizedInviteId}${index}`,
  );
};
exports.getHistoricalMatchIds = getHistoricalMatchIds;
