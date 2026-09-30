import type { EventData, EventParticipant } from "./model.js";
export type EventOwnershipProfile = {
  aura: string;
  emoji: number | string;
  eth: string;
  profileId: string;
  rating: number;
  sol: string;
  username: string;
};
export type EventOwnershipSnapshot = Readonly<{
  canonicalProfileIdByProfileId: ReadonlyMap<string, string | null>;
  loginOwnerByUid: ReadonlyMap<
    string,
    Readonly<{ profileId: string; revision: number }> | null
  >;
  loginUidsByProfileId: ReadonlyMap<string, readonly string[]>;
  profileById: ReadonlyMap<
    string,
    Readonly<{ profile: EventOwnershipProfile; revision: number }>
  >;
}>;
export type EventOwnershipResolutionSnapshot = Pick<
  EventOwnershipSnapshot,
  "canonicalProfileIdByProfileId" | "loginOwnerByUid"
> &
  Partial<Pick<EventOwnershipSnapshot, "profileById">>;
type Signature_buildEventOwnershipQuery = (
  event: EventData,
  extras?: { loginUids?: string[]; profileIds?: string[] },
) => { loginUids: string[]; profileIds: string[] };
type Signature_canonicalizeEventParticipants = (
  event: EventData,
  snapshot: EventOwnershipSnapshot,
) => { didChange: boolean; participantsById: Record<string, EventParticipant> };
type Signature_directRequesterParticipation = (
  event: EventData,
  requesterUid: string,
) => { isParticipant: boolean; profileId: string | null };
type Signature_directParticipantParticipation = (
  event: EventData,
  requesterUid: string,
) => { isParticipant: boolean; profileId: string | null };
type Signature_getCanonicalProfileId = (
  snapshot: EventOwnershipResolutionSnapshot,
  profileId: string,
) => string | null;
type Signature_getLoginProfileId = (
  snapshot: EventOwnershipResolutionSnapshot,
  loginUid: string,
) => string | null;
type Signature_getOwnershipProfile = (
  snapshot: EventOwnershipSnapshot,
  profileId: string,
) => EventOwnershipProfile | null;
type Signature_requesterOwnsProfileReference = (input: {
  requesterUid: string;
  snapshot?: EventOwnershipSnapshot | null;
  storedLoginUid: string;
  storedProfileId: string;
}) => boolean;
type Signature_resolveOwnedProfileReferences = (
  snapshot: EventOwnershipResolutionSnapshot,
  references: Array<{ loginUid: unknown; profileId: unknown }>,
) => string[];
type Signature_resolvePrizeProjectionOwnerId = (input: {
  event: EventData;
  profileId: string;
  snapshot: EventOwnershipSnapshot;
}) => string;
type Signature_resolveParticipantParticipation = (
  event: EventData,
  requesterUid: string,
  snapshot?: EventOwnershipSnapshot | null,
) => { isParticipant: boolean; profileId: string | null };
type Signature_resolveRequesterParticipation = (
  event: EventData,
  requesterUid: string,
  snapshot?: EventOwnershipSnapshot | null,
) => { isParticipant: boolean; profileId: string | null };

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const profileOwnershipUnavailable = () => {
  const error = new Error("profile-ownership-unavailable") as Error & {
    code: "unavailable";
  };
  error.code = "unavailable";
  return error;
};

const uniqueStrings = (values: readonly unknown[]) =>
  Array.from(new Set(values.map(normalizeString).filter(Boolean)));

const participantEntries = (event: EventData | null | undefined) =>
  Object.entries(
    event && event.participants && typeof event.participants === "object"
      ? event.participants
      : {},
  ).flatMap(([profileId, value]) =>
    value && typeof value === "object"
      ? [
          {
            key: normalizeString(profileId),
            participant: value,
            profileId:
              normalizeString(value.profileId) || normalizeString(profileId),
            loginUid: normalizeString(value.loginUid),
          },
        ]
      : [],
  );

const buildEventOwnershipQuery: Signature_buildEventOwnershipQuery = (
  event,
  { loginUids = [], profileIds = [] } = {},
) => {
  const entries = participantEntries(event);
  const assignments =
    event &&
    event.prizeAssignments &&
    typeof event.prizeAssignments === "object"
      ? Object.values(event.prizeAssignments)
      : [];
  return {
    loginUids: uniqueStrings([
      ...loginUids,
      normalizeString(event && event.createdByLoginUid),
      ...entries.map(({ loginUid }) => loginUid),
    ]),
    profileIds: uniqueStrings([
      ...profileIds,
      normalizeString(event && event.createdByProfileId),
      ...entries.flatMap(({ key, profileId }) => [key, profileId]),
      ...assignments.map((assignment) =>
        normalizeString(assignment && assignment.profileId),
      ),
    ]),
  };
};

const getLoginProfileId: Signature_getLoginProfileId = (snapshot, loginUid) => {
  const uid = normalizeString(loginUid);
  if (!uid || !snapshot?.loginOwnerByUid?.has(uid)) {
    throw profileOwnershipUnavailable();
  }
  return normalizeString(snapshot.loginOwnerByUid.get(uid)?.profileId) || null;
};

const getCanonicalProfileId: Signature_getCanonicalProfileId = (
  snapshot,
  profileId,
) => {
  const id = normalizeString(profileId);
  if (!id) {
    throw profileOwnershipUnavailable();
  }
  if (!snapshot?.canonicalProfileIdByProfileId?.has(id)) {
    if (snapshot?.profileById?.has(id)) return id;
    throw profileOwnershipUnavailable();
  }
  return (
    normalizeString(snapshot.canonicalProfileIdByProfileId.get(id)) || null
  );
};

const getOwnershipProfile: Signature_getOwnershipProfile = (
  snapshot,
  profileId,
) => {
  const id = normalizeString(profileId);
  const value = id ? snapshot?.profileById?.get(id) : null;
  return value && value.profile && typeof value.profile === "object"
    ? value.profile
    : null;
};

const resolveOwnedProfileReferences: Signature_resolveOwnedProfileReferences = (
  snapshot,
  references,
) => {
  const canonicalProfileIds = [];
  const seen = new Set();
  for (const reference of references) {
    const loginUid = normalizeString(reference && reference.loginUid);
    const profileId = normalizeString(reference && reference.profileId);
    const canonicalProfileId = getCanonicalProfileId(snapshot, profileId);
    const ownerProfileId = getLoginProfileId(snapshot, loginUid);
    if (
      !canonicalProfileId ||
      !ownerProfileId ||
      ownerProfileId !== canonicalProfileId ||
      seen.has(canonicalProfileId)
    ) {
      throw profileOwnershipUnavailable();
    }
    seen.add(canonicalProfileId);
    canonicalProfileIds.push(canonicalProfileId);
  }
  return canonicalProfileIds;
};

const directParticipantParticipation: Signature_directParticipantParticipation =
  (event, requesterUidInput) => {
    const requesterUid = normalizeString(requesterUidInput);
    const directMatches = participantEntries(event)
      .filter(({ loginUid }) => requesterUid && loginUid === requesterUid)
      .map(({ key }) => key);
    if (directMatches.length > 0) {
      return requesterParticipation(directMatches);
    }
    return requesterParticipation([]);
  };

const directRequesterParticipation: Signature_directRequesterParticipation = (
  event,
  requesterUidInput,
) => {
  const requesterUid = normalizeString(requesterUidInput);
  const direct = directParticipantParticipation(event, requesterUid);
  if (direct.isParticipant) return direct;
  if (
    requesterUid &&
    normalizeString(event && event.createdByLoginUid) === requesterUid
  ) {
    return requesterParticipation([
      normalizeString(event && event.createdByProfileId),
    ]);
  }
  return requesterParticipation([]);
};

const requesterParticipation = (profileIds: readonly unknown[]) => {
  const uniqueProfileIds = uniqueStrings(profileIds);
  if (uniqueProfileIds.length > 1) {
    throw profileOwnershipUnavailable();
  }
  return {
    isParticipant: profileIds.some((profileId) => normalizeString(profileId)),
    profileId: uniqueProfileIds[0] || null,
  };
};

const resolveRequesterParticipation: Signature_resolveRequesterParticipation = (
  event,
  requesterUidInput,
  snapshot,
) => {
  const direct = directRequesterParticipation(event, requesterUidInput);
  if (direct.isParticipant || !snapshot) return direct;
  const requesterUid = normalizeString(requesterUidInput);
  const requesterProfileId = getLoginProfileId(snapshot, requesterUid);
  if (!requesterProfileId) return requesterParticipation([]);
  const matches = participantEntries(event).flatMap(({ key, profileId }) =>
    getCanonicalProfileId(snapshot, profileId) === requesterProfileId
      ? [key]
      : [],
  );
  if (matches.length > 0) return requesterParticipation(matches);
  const creatorProfileId = normalizeString(event && event.createdByProfileId);
  return requesterParticipation(
    creatorProfileId &&
      getCanonicalProfileId(snapshot, creatorProfileId) === requesterProfileId
      ? [creatorProfileId]
      : [],
  );
};

const resolveParticipantParticipation: Signature_resolveParticipantParticipation =
  (event, requesterUidInput, snapshot) => {
    const direct = directParticipantParticipation(event, requesterUidInput);
    if (direct.isParticipant || !snapshot) return direct;
    const requesterProfileId = getLoginProfileId(snapshot, requesterUidInput);
    if (!requesterProfileId) return requesterParticipation([]);
    return requesterParticipation(
      participantEntries(event).flatMap(({ key, profileId }) =>
        getCanonicalProfileId(snapshot, profileId) === requesterProfileId
          ? [key]
          : [],
      ),
    );
  };

const requesterOwnsProfileReference: Signature_requesterOwnsProfileReference =
  ({
    requesterUid: requesterUidInput,
    snapshot,
    storedLoginUid: storedLoginUidInput,
    storedProfileId: storedProfileIdInput,
  }) => {
    const requesterUid = normalizeString(requesterUidInput);
    if (requesterUid && requesterUid === normalizeString(storedLoginUidInput)) {
      return true;
    }
    if (!snapshot) return false;
    const requesterProfileId = getLoginProfileId(snapshot, requesterUid);
    return Boolean(
      requesterProfileId &&
      requesterProfileId ===
        getCanonicalProfileId(snapshot, normalizeString(storedProfileIdInput)),
    );
  };

const canonicalizeEventParticipants: Signature_canonicalizeEventParticipants = (
  event,
  snapshot,
) => {
  const entries = participantEntries(event);
  if (entries.length === 0) {
    return { didChange: false, participantsById: {} };
  }
  const canonicalProfileIds = resolveOwnedProfileReferences(
    snapshot,
    entries.map(({ loginUid, profileId }) => ({ loginUid, profileId })),
  );
  const participantsById: Record<string, EventParticipant> = {};
  let didChange = false;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const canonicalProfileId = canonicalProfileIds[index];
    participantsById[canonicalProfileId] = {
      ...entry.participant,
      profileId: canonicalProfileId,
    };
    if (
      entry.key !== canonicalProfileId ||
      entry.profileId !== canonicalProfileId
    ) {
      didChange = true;
    }
  }
  return { didChange, participantsById };
};

const canonicalizeEventPrizeSelections = <T>(
  event: EventData,
  value: Record<string, T> | null | undefined,
  snapshot: EventOwnershipSnapshot | null,
): { didChange: boolean; selectionsByProfileId: Record<string, T> } => {
  const isSelectionRecord =
    value && typeof value === "object" && !Array.isArray(value);
  const selections = isSelectionRecord ? value : {};
  const selectionEntries = Object.entries(selections);
  if (selectionEntries.length === 0) {
    return {
      didChange: value !== undefined && value !== null && !isSelectionRecord,
      selectionsByProfileId: {},
    };
  }
  const entries = participantEntries(event);
  if (entries.length === 0) {
    return { didChange: true, selectionsByProfileId: {} };
  }
  if (!snapshot) throw profileOwnershipUnavailable();
  const readCanonicalProfileId = (profileIdInput: unknown) => {
    const profileId = normalizeString(profileIdInput);
    if (!profileId) return "";
    if (snapshot.canonicalProfileIdByProfileId?.has(profileId)) {
      return normalizeString(
        snapshot.canonicalProfileIdByProfileId.get(profileId),
      );
    }
    return snapshot.profileById?.has(profileId) ? profileId : "";
  };
  const participantCandidates = entries.map((entry) => ({
    entry,
    canonicalProfileId: readCanonicalProfileId(entry.profileId),
  }));
  const selectionsByProfileId: Record<string, T> = {};
  for (const [sourceProfileId, selection] of selectionEntries) {
    const normalizedSourceProfileId = normalizeString(sourceProfileId);
    if (!normalizedSourceProfileId) continue;
    const sourceCanonicalProfileId = readCanonicalProfileId(
      normalizedSourceProfileId,
    );
    const matchingEntries = participantCandidates.filter(
      ({ entry, canonicalProfileId }) =>
        entry.key === normalizedSourceProfileId ||
        entry.profileId === normalizedSourceProfileId ||
        (sourceCanonicalProfileId &&
          canonicalProfileId === sourceCanonicalProfileId),
    );
    if (matchingEntries.length === 0) continue;
    let canonicalProfileId = "";
    for (const { entry } of matchingEntries) {
      const resolvedProfileId = resolveOwnedProfileReferences(snapshot, [
        { loginUid: entry.loginUid, profileId: entry.profileId },
      ])[0];
      if (canonicalProfileId && canonicalProfileId !== resolvedProfileId) {
        throw profileOwnershipUnavailable();
      }
      canonicalProfileId = resolvedProfileId;
    }
    if (!canonicalProfileId) continue;
    if (
      Object.hasOwn(selectionsByProfileId, canonicalProfileId) &&
      selectionsByProfileId[canonicalProfileId] !== selection
    ) {
      throw profileOwnershipUnavailable();
    }
    selectionsByProfileId[canonicalProfileId] = selection;
  }
  const canonicalEntries = Object.entries(selectionsByProfileId);
  const didChange =
    canonicalEntries.length !== selectionEntries.length ||
    selectionEntries.some(
      ([profileId, selection]) =>
        !Object.hasOwn(selectionsByProfileId, profileId) ||
        selectionsByProfileId[profileId] !== selection,
    );
  return { didChange, selectionsByProfileId };
};

const resolvePrizeProjectionOwnerId: Signature_resolvePrizeProjectionOwnerId =
  ({ event, profileId: profileIdInput, snapshot }) => {
    const profileId = normalizeString(profileIdInput);
    const canonicalProfileId = getCanonicalProfileId(snapshot, profileId);
    if (!canonicalProfileId) return "";
    const participants = participantEntries(event).filter(
      ({ profileId: storedProfileId }) =>
        getCanonicalProfileId(snapshot, storedProfileId) === canonicalProfileId,
    );
    for (const participant of participants) {
      if (
        participant.loginUid &&
        getLoginProfileId(snapshot, participant.loginUid) !== canonicalProfileId
      ) {
        throw profileOwnershipUnavailable();
      }
    }
    return canonicalProfileId;
  };

export {
  buildEventOwnershipQuery,
  canonicalizeEventParticipants,
  canonicalizeEventPrizeSelections,
  directParticipantParticipation,
  directRequesterParticipation,
  getCanonicalProfileId,
  getLoginProfileId,
  getOwnershipProfile,
  profileOwnershipUnavailable,
  requesterOwnsProfileReference,
  resolveOwnedProfileReferences,
  resolvePrizeProjectionOwnerId,
  resolveParticipantParticipation,
  resolveRequesterParticipation,
};
