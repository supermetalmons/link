const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const parseRematchIndices = (rawValue) => {
  if (typeof rawValue !== "string" || rawValue === "") {
    return [];
  }
  const normalized = rawValue.replace(/x+$/, "");
  if (normalized === "") {
    return [];
  }
  return normalized
    .split(";")
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isFinite(value) && value > 0);
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
    if (!/^\d+$/.test(suffix)) {
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
  if (!/^\d+$/.test(suffix)) {
    return null;
  }
  const parsed = Number.parseInt(suffix, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

const deriveLatestMatchId = (inviteId, inviteData, latestMatchIdHint) => {
  const hintedIndex = getHintMatchIndex(inviteId, latestMatchIdHint);
  const maxIndex = getLatestRematchIndex(inviteData, hintedIndex);
  return maxIndex > 0 ? `${inviteId}${maxIndex}` : inviteId;
};

module.exports = {
  parseRematchIndices,
  rematchSeriesEnded,
  inviteMatchesPlayers,
  createInviteCandidatesFromMatchId,
  parseInviteMatchIndex,
  getHintMatchIndex,
  getLatestRematchIndex,
  deriveLatestMatchId,
};
