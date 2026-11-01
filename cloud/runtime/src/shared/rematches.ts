export type RematchSeries = { state: "open" | "ended"; indices: number[] };
export interface RematchInviteData {
  hostRematches: RematchSeries;
  guestRematches: RematchSeries;
}
export function isRematchSeries(value: unknown): value is RematchSeries {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const row: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  if (
    Object.keys(row).length !== 2 ||
    !Object.hasOwn(row, "state") ||
    !Object.hasOwn(row, "indices") ||
    (row.state !== "open" && row.state !== "ended") ||
    !Array.isArray(row.indices)
  )
    return false;
  const indices: unknown[] = row.indices;
  let previous = 0;
  for (const index of indices) {
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index <= previous
    )
      return false;
    previous = index;
  }
  return true;
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

const parseRematchIndices = (
  value: RematchSeries | null | undefined,
): number[] => {
  if (value === null || value === undefined) return [];
  if (!isRematchSeries(value)) throw new TypeError("invalid-rematch-series");
  return [...value.indices];
};

const rematchSeriesEnded = (
  inviteData: RematchInviteData | null | undefined,
): boolean =>
  inviteData?.hostRematches.state === "ended" ||
  inviteData?.guestRematches.state === "ended";

const inviteMatchesPlayers = (
  inviteData: { hostId: string; guestId: string | null } | null | undefined,
  playerId: string,
  opponentId: string,
): boolean =>
  inviteData !== null &&
  inviteData !== undefined &&
  ((inviteData.hostId === playerId && inviteData.guestId === opponentId) ||
    (inviteData.hostId === opponentId && inviteData.guestId === playerId));

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
  inviteData: RematchInviteData & { hostId: string; guestId: string | null },
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
};
