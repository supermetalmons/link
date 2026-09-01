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

const rematchSeriesEnded = (inviteData) => {
  if (!inviteData || typeof inviteData !== "object") {
    return false;
  }
  const hostRematches =
    typeof inviteData.hostRematches === "string"
      ? inviteData.hostRematches
      : "";
  const guestRematches =
    typeof inviteData.guestRematches === "string"
      ? inviteData.guestRematches
      : "";
  return hostRematches.endsWith("x") || guestRematches.endsWith("x");
};

const inviteMatchesPlayers = (inviteData, playerId, opponentId) =>
  !!inviteData &&
  typeof inviteData === "object" &&
  ((inviteData.hostId === playerId && inviteData.guestId === opponentId) ||
    (inviteData.hostId === opponentId && inviteData.guestId === playerId));

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

const deriveLatestMatchId = (inviteId, inviteData, latestMatchIdHint) => {
  const hintedIndex = getHintMatchIndex(inviteId, latestMatchIdHint);
  const maxIndex = getLatestRematchIndex(inviteData, hintedIndex);
  return maxIndex > 0 ? `${inviteId}${maxIndex}` : inviteId;
};

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

module.exports = {
  parseRematchIndices,
  rematchSeriesEnded,
  inviteMatchesPlayers,
  createInviteCandidatesFromMatchId,
  parseInviteMatchIndex,
  getHintMatchIndex,
  getLatestRematchIndex,
  getLatestApprovedRematchIndex,
  deriveLatestMatchId,
  getHistoricalMatchIds,
};
