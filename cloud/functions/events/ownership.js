"use strict";

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const profileOwnershipUnavailable = () => {
  const error = new Error("profile-ownership-unavailable");
  error.code = "unavailable";
  return error;
};

const uniqueStrings = (values) =>
  Array.from(new Set(values.map(normalizeString).filter(Boolean)));

const participantEntries = (event) =>
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

const buildEventOwnershipQuery = (
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

const getLoginProfileId = (snapshot, loginUid) => {
  const uid = normalizeString(loginUid);
  if (!uid || !snapshot?.loginOwnerByUid?.has(uid)) {
    throw profileOwnershipUnavailable();
  }
  return normalizeString(snapshot.loginOwnerByUid.get(uid)?.profileId) || null;
};

const getCanonicalProfileId = (snapshot, profileId) => {
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

const getOwnershipProfile = (snapshot, profileId) => {
  const id = normalizeString(profileId);
  const value = id ? snapshot?.profileById?.get(id) : null;
  return value && value.profile && typeof value.profile === "object"
    ? value.profile
    : null;
};

const resolveOwnedProfileReferences = (snapshot, references) => {
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

const directParticipantParticipation = (event, requesterUidInput) => {
  const requesterUid = normalizeString(requesterUidInput);
  const directMatches = participantEntries(event)
    .filter(({ loginUid }) => requesterUid && loginUid === requesterUid)
    .map(({ key }) => key);
  if (directMatches.length > 0) {
    return requesterParticipation(directMatches);
  }
  return requesterParticipation([]);
};

const directRequesterParticipation = (event, requesterUidInput) => {
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

const requesterParticipation = (profileIds) => {
  const uniqueProfileIds = uniqueStrings(profileIds);
  if (uniqueProfileIds.length > 1) {
    throw profileOwnershipUnavailable();
  }
  return {
    isParticipant: profileIds.some((profileId) => normalizeString(profileId)),
    profileId: uniqueProfileIds[0] || null,
  };
};

const resolveRequesterParticipation = (event, requesterUidInput, snapshot) => {
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

const resolveParticipantParticipation = (
  event,
  requesterUidInput,
  snapshot,
) => {
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

const requesterOwnsProfileReference = ({
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

const canonicalizeEventParticipants = (event, snapshot) => {
  const entries = participantEntries(event);
  if (entries.length === 0) {
    return { didChange: false, participantsById: {} };
  }
  const canonicalProfileIds = resolveOwnedProfileReferences(
    snapshot,
    entries.map(({ loginUid, profileId }) => ({ loginUid, profileId })),
  );
  const participantsById = {};
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

const resolvePrizeProjectionOwnerId = ({
  event,
  profileId: profileIdInput,
  snapshot,
}) => {
  const profileId = normalizeString(profileIdInput);
  const canonicalProfileId = getCanonicalProfileId(snapshot, profileId);
  if (!canonicalProfileId) return "";
  const participants = participantEntries(event).filter(
    ({ profileId: storedProfileId }) =>
      getCanonicalProfileId(snapshot, storedProfileId) === canonicalProfileId,
  );
  if (participants.length > 1) throw profileOwnershipUnavailable();
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

module.exports = {
  buildEventOwnershipQuery,
  canonicalizeEventParticipants,
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
