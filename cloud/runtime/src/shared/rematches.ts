export interface RematchInviteData {
  hostRematches?: unknown;
  guestRematches?: unknown;
}

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const parseCanonicalRematchIndex = (value: unknown) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const parseRematchIndices = (rawValue: unknown): number[] => {
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

const rematchSeriesEnded = (inviteData: unknown): boolean => {
  if (!inviteData || typeof inviteData !== "object") {
    return false;
  }
  const record = inviteData as Record<string, unknown>;
  const hostRematches =
    typeof record.hostRematches === "string" ? record.hostRematches : "";
  const guestRematches =
    typeof record.guestRematches === "string" ? record.guestRematches : "";
  return hostRematches.endsWith("x") || guestRematches.endsWith("x");
};

const inviteMatchesPlayers = (
  inviteData: unknown,
  playerId: string,
  opponentId: string,
): boolean =>
  !!inviteData &&
  typeof inviteData === "object" &&
  (((inviteData as Record<string, unknown>).hostId === playerId &&
    (inviteData as Record<string, unknown>).guestId === opponentId) ||
    ((inviteData as Record<string, unknown>).hostId === opponentId &&
      (inviteData as Record<string, unknown>).guestId === playerId));

const createInviteCandidatesFromMatchId = (matchId: string): string[] => {
  const candidates: string[] = [];
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

const parseInviteMatchIndex = (
  inviteId: unknown,
  matchId: unknown,
): number | null => {
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

const getHintMatchIndex = (
  inviteId: unknown,
  latestMatchIdHint: unknown,
): number => {
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

const getLatestRematchIndex = (
  inviteData: RematchInviteData | null | undefined,
  minimumIndex: number = 0,
): number => {
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

const getApprovedRematchIndices = (
  inviteData: RematchInviteData | null | undefined,
) => {
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

const getLatestApprovedRematchIndex = (
  inviteData: RematchInviteData | null | undefined,
): number => getApprovedRematchIndices(inviteData).at(-1) || 0;

const selectInviteMatch = (
  inviteId: string,
  inviteData: RematchInviteData & { hostId?: unknown; guestId?: unknown },
  actorUid: string | null,
  options: { preferApproved?: boolean } = {},
): { matchId: string; hasPendingProposal: boolean } => {
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

const deriveLatestMatchId = (
  inviteId: string,
  inviteData: RematchInviteData | null | undefined,
  latestMatchIdHint?: unknown,
): string => {
  const hintedIndex = getHintMatchIndex(inviteId, latestMatchIdHint);
  const maxIndex = getLatestRematchIndex(inviteData, hintedIndex);
  return maxIndex > 0 ? `${inviteId}${maxIndex}` : inviteId;
};

const getHistoricalMatchIds = (
  inviteId: string,
  inviteData: RematchInviteData | null | undefined,
): string[] => {
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

export {
  parseRematchIndices,
  rematchSeriesEnded,
  inviteMatchesPlayers,
  createInviteCandidatesFromMatchId,
  parseInviteMatchIndex,
  getHintMatchIndex,
  getLatestRematchIndex,
  getLatestApprovedRematchIndex,
  selectInviteMatch,
  deriveLatestMatchId,
  getHistoricalMatchIds,
};
