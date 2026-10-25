// Generated from src/events/ownership.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRequesterParticipation =
  exports.resolveParticipantParticipation =
  exports.resolvePrizeProjectionOwnerId =
  exports.resolveOwnedProfileReferences =
  exports.requesterOwnsProfileReference =
  exports.profileOwnershipUnavailable =
  exports.getOwnershipProfile =
  exports.getLoginProfileId =
  exports.getCanonicalProfileId =
  exports.directRequesterParticipation =
  exports.directParticipantParticipation =
  exports.canonicalizeEventPrizeSelections =
  exports.canonicalizeEventParticipants =
  exports.buildEventOwnershipQuery =
    void 0;
const documents_js_1 = require("./documents.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const profileOwnershipUnavailable = () => {
  const error = new Error("profile-ownership-unavailable");
  error.code = "unavailable";
  return error;
};
exports.profileOwnershipUnavailable = profileOwnershipUnavailable;
const uniqueStrings = (values) =>
  Array.from(new Set(values.map(normalizeString).filter(Boolean)));
const participantEntries = (event) =>
  (0, documents_js_1.eventParticipantEntries)(
    (0, documents_js_1.eventParticipants)(event),
  ).map(([profileId, participant]) => {
    const value = (0, documents_js_1.eventParticipantState)(participant);
    return {
      key: normalizeString(profileId),
      participant,
      profileId: normalizeString(value.profileId) || normalizeString(profileId),
      loginUid: normalizeString(value.loginUid),
    };
  });
const buildEventOwnershipQuery = (
  event,
  { loginUids = [], profileIds = [] } = {},
) => {
  const entries = participantEntries(event);
  return {
    loginUids: uniqueStrings([
      ...loginUids,
      normalizeString((0, documents_js_1.eventState)(event).createdByLoginUid),
      ...entries.map(({ loginUid }) => loginUid),
    ]),
    profileIds: uniqueStrings([
      ...profileIds,
      normalizeString((0, documents_js_1.eventState)(event).createdByProfileId),
      ...entries.flatMap(({ key, profileId }) => [key, profileId]),
      ...(0, documents_js_1.eventPrizeOwnerProfileIds)(event),
    ]),
  };
};
exports.buildEventOwnershipQuery = buildEventOwnershipQuery;
const getLoginProfileId = (snapshot, loginUid) => {
  const uid = normalizeString(loginUid);
  if (!uid || !snapshot?.loginOwnerByUid?.has(uid)) {
    throw profileOwnershipUnavailable();
  }
  return normalizeString(snapshot.loginOwnerByUid.get(uid)?.profileId) || null;
};
exports.getLoginProfileId = getLoginProfileId;
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
exports.getCanonicalProfileId = getCanonicalProfileId;
const getOwnershipProfile = (snapshot, profileId) => {
  const id = normalizeString(profileId);
  const value = id ? snapshot?.profileById?.get(id) : null;
  return value && value.profile && typeof value.profile === "object"
    ? value.profile
    : null;
};
exports.getOwnershipProfile = getOwnershipProfile;
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
exports.resolveOwnedProfileReferences = resolveOwnedProfileReferences;
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
exports.directParticipantParticipation = directParticipantParticipation;
const directRequesterParticipation = (event, requesterUidInput) => {
  const requesterUid = normalizeString(requesterUidInput);
  const direct = directParticipantParticipation(event, requesterUid);
  if (direct.isParticipant) return direct;
  if (
    requesterUid &&
    normalizeString((0, documents_js_1.eventState)(event).createdByLoginUid) ===
      requesterUid
  ) {
    return requesterParticipation([
      normalizeString((0, documents_js_1.eventState)(event).createdByProfileId),
    ]);
  }
  return requesterParticipation([]);
};
exports.directRequesterParticipation = directRequesterParticipation;
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
  const creatorProfileId = normalizeString(
    (0, documents_js_1.eventState)(event).createdByProfileId,
  );
  return requesterParticipation(
    creatorProfileId &&
      getCanonicalProfileId(snapshot, creatorProfileId) === requesterProfileId
      ? [creatorProfileId]
      : [],
  );
};
exports.resolveRequesterParticipation = resolveRequesterParticipation;
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
exports.resolveParticipantParticipation = resolveParticipantParticipation;
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
exports.requesterOwnsProfileReference = requesterOwnsProfileReference;
const canonicalizeEventParticipants = (event, snapshot) => {
  const entries = participantEntries(event);
  if (entries.length === 0) {
    return {
      didChange: false,
      participantsById: (0, documents_js_1.createEventParticipantsDocument)(),
    };
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
    participantsById[canonicalProfileId] = (0,
    documents_js_1.copyEventParticipant)(entry.participant, {
      profileId: canonicalProfileId,
    });
    if (
      entry.key !== canonicalProfileId ||
      entry.profileId !== canonicalProfileId
    ) {
      didChange = true;
    }
  }
  return {
    didChange,
    participantsById: (0, documents_js_1.createEventParticipantsDocument)(
      participantsById,
    ),
  };
};
exports.canonicalizeEventParticipants = canonicalizeEventParticipants;
const canonicalizeEventPrizeSelections = (event, value, snapshot) => {
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
  const readCanonicalProfileId = (profileIdInput) => {
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
  const selectionsByProfileId = {};
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
exports.canonicalizeEventPrizeSelections = canonicalizeEventPrizeSelections;
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
exports.resolvePrizeProjectionOwnerId = resolvePrizeProjectionOwnerId;
