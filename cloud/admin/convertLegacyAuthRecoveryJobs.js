#!/usr/bin/env node

"use strict";

const { isDeepStrictEqual } = require("node:util");
const { stdout } = require("node:process");
const { isEventPrizeId } = require("../functions/eventPrizeAwards");
const {
  MAX_PROFILE_MERGE_TARGET_HOPS,
} = require("../functions/profileMergeTargets");
const {
  isCanonicalFirebaseUid,
  isSafeFirebaseKey,
  isSafeFirestoreDocumentId,
} = require("../workers/api/src/firebaseKeys.ts");
const {
  ADC_FAILURE_MESSAGE,
  addApplicationDefaultCredentialHelp,
  admin,
  cleanupAdmin,
  initAdmin,
} = require("./_admin");

const COLLECTIONS = ["authClaimSyncBacklog", "authMergeGameBacklog", "users"];
const DEFAULT_LIMIT = 20;
const MAX_JOB_LOGIN_UIDS = 100;
const MAX_JOB_SOURCE_PROFILE_IDS = 100;
const MAX_LIMIT = 100;
const JOB_FIELDS = [
  "profileId",
  "loginUids",
  "sourceProfileIds",
  "sourcePhase",
  "prizeCursor",
  "phaseStartedAtMs",
  "lastEnqueuedAtMs",
  "createdAtMs",
  "updatedAtMs",
];
const PENDING_FIELDS = [
  "pendingClaimSyncLogins",
  "pendingClaimSyncOpId",
  "pendingClaimSyncUpdatedAtMs",
  "pendingMergeGameCopySourceProfileId",
  "pendingMergeGameCopyOpId",
  "pendingMergeGameCopyUpdatedAtMs",
  "pendingMergePrizeCopyCursor",
  "pendingMergePrizeCopyCompletedAtMs",
  "pendingMergePrizeCopyCompletedOpId",
];
const CLAIM_FIELDS = PENDING_FIELDS.slice(0, 3);
const GAME_FIELDS = PENDING_FIELDS.slice(3);
const USAGE =
  "Usage: node cloud/admin/convertLegacyAuthRecoveryJobs.js [--project <id>] [--database-url <url>] [--after <cursor>] [--limit <1-100>] [--dry-run | --execute]";

class ConversionBlocked extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ConversionBlocked";
    this.reason = reason;
  }
}

const block = (reason) => {
  throw new ConversionBlocked(reason);
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const exactProfileId = (value) =>
  typeof value === "string" &&
  isSafeFirestoreDocumentId(value) &&
  isSafeFirebaseKey(value)
    ? value
    : "";

const exactDocumentId = (value) =>
  typeof value === "string" && isSafeFirestoreDocumentId(value) ? value : "";

const finiteTimestamp = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

const uniqueSorted = (values) =>
  Array.from(new Set(values)).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

const cloneJob = (job) => ({
  ...job,
  loginUids: [...job.loginUids],
  sourceProfileIds: [...job.sourceProfileIds],
});

const readPositiveInteger = (value) => {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(USAGE);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_LIMIT) {
    throw new TypeError(USAGE);
  }
  return number;
};

const parseArgs = (argv) => {
  const options = {
    adminArgs: [],
    after: "",
    dryRun: true,
    limit: DEFAULT_LIMIT,
  };
  const seen = new Set();
  let modeSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--execute") {
      if (modeSet) {
        throw new TypeError(USAGE);
      }
      modeSet = true;
      options.dryRun = arg === "--dry-run";
      continue;
    }
    if (
      arg !== "--after" &&
      arg !== "--database-url" &&
      arg !== "--limit" &&
      arg !== "--project"
    ) {
      throw new TypeError(USAGE);
    }
    if (seen.has(arg)) {
      throw new TypeError(USAGE);
    }
    seen.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(USAGE);
    }
    index += 1;
    if (arg === "--after") {
      options.after = value;
    } else if (arg === "--limit") {
      options.limit = readPositiveInteger(value);
    } else {
      options.adminArgs.push(arg, value);
    }
  }
  return options;
};

const encodeCursor = ({ collectionIndex, after }) => {
  const payload = JSON.stringify({ v: 1, collectionIndex, after });
  return `v1.${Buffer.from(payload).toString("base64url")}`;
};

const decodeCursor = (value) => {
  if (!value) {
    return { collectionIndex: 0, after: "" };
  }
  if (typeof value !== "string" || !value.startsWith("v1.")) {
    throw new TypeError("invalid-cursor");
  }
  const encoded = value.slice(3);
  let payload;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new TypeError("invalid-cursor");
  }
  if (Buffer.from(payload).toString("base64url") !== encoded) {
    throw new TypeError("invalid-cursor");
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new TypeError("invalid-cursor");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 3 ||
    parsed.v !== 1 ||
    !Number.isInteger(parsed.collectionIndex) ||
    parsed.collectionIndex < 0 ||
    parsed.collectionIndex >= COLLECTIONS.length ||
    typeof parsed.after !== "string" ||
    (parsed.after && !exactDocumentId(parsed.after))
  ) {
    throw new TypeError("invalid-cursor");
  }
  return {
    collectionIndex: parsed.collectionIndex,
    after: parsed.after,
  };
};

const normalizeListedDocument = (collection, value) => {
  if (!isRecord(value) || !exactDocumentId(value.id)) {
    throw new Error(`invalid-list-result:${collection}`);
  }
  return { collection, id: value.id };
};

const collectCandidatePage = async ({ after, limit, listDocuments }) => {
  let state = decodeCursor(after);
  const candidates = [];
  while (
    state.collectionIndex < COLLECTIONS.length &&
    candidates.length < limit
  ) {
    const collection = COLLECTIONS[state.collectionIndex];
    const remaining = limit - candidates.length;
    const listed = await listDocuments(collection, state.after, remaining + 1);
    if (!Array.isArray(listed)) {
      throw new Error(`invalid-list-result:${collection}`);
    }
    const documents = listed.map((value) =>
      normalizeListedDocument(collection, value),
    );
    for (let index = 0; index < documents.length; index += 1) {
      if (
        (index > 0 && documents[index - 1].id >= documents[index].id) ||
        (index === 0 && state.after && state.after >= documents[index].id)
      ) {
        throw new Error(`unordered-list-result:${collection}`);
      }
    }
    const selected = documents.slice(0, remaining);
    candidates.push(...selected);
    if (documents.length > remaining) {
      state = {
        collectionIndex: state.collectionIndex,
        after: selected.at(-1).id,
      };
      return {
        candidates,
        hasMore: true,
        nextCursor: encodeCursor(state),
      };
    }
    state = { collectionIndex: state.collectionIndex + 1, after: "" };
  }
  if (state.collectionIndex < COLLECTIONS.length) {
    return {
      candidates,
      hasMore: true,
      nextCursor: encodeCursor(state),
    };
  }
  return { candidates, hasMore: false, nextCursor: null };
};

const documentKey = (collection, id) => `${collection}/${id}`;

const createReadContext = (readDocument) => {
  const documents = new Map();
  const read = async (collection, id) => {
    const key = documentKey(collection, id);
    if (!documents.has(key)) {
      const value = await readDocument(collection, id);
      if (
        value !== null &&
        (!isRecord(value) || value.id !== id || !isRecord(value.data))
      ) {
        throw new Error(`invalid-read-result:${key}`);
      }
      documents.set(
        key,
        value === null
          ? { collection, id, exists: false, data: null, version: null }
          : {
              collection,
              id,
              exists: true,
              data: value.data,
              version: value.version ?? null,
            },
      );
    }
    return documents.get(key);
  };
  return { documents, read };
};

const readUidArray = (value, reason) => {
  if (!Array.isArray(value)) {
    block(reason);
  }
  const result = [];
  const seen = new Set();
  for (const uid of value) {
    if (!isCanonicalFirebaseUid(uid)) {
      block("malformed-firebase-uid");
    }
    if (!seen.has(uid)) {
      seen.add(uid);
      result.push(uid);
    }
  }
  return result;
};

const validateOptionalTimestamps = (data, fields) => {
  for (const field of fields) {
    if (own(data, field) && finiteTimestamp(data[field]) === null) {
      block("malformed-candidate");
    }
  }
};

const readLegacyCandidate = (collection, id, data) => {
  if (!isRecord(data)) {
    block("malformed-candidate");
  }
  if (collection === "authClaimSyncBacklog") {
    if (data.status !== "pending" && data.status !== "queued") {
      block("malformed-candidate");
    }
    const opId = exactDocumentId(data.opId);
    const targetProfileId = exactProfileId(data.targetProfileId);
    if (!opId || opId !== id || !targetProfileId) {
      block("malformed-candidate");
    }
    const sourceProfileId =
      data.sourceProfileId === undefined || data.sourceProfileId === ""
        ? ""
        : exactProfileId(data.sourceProfileId);
    if (
      (data.sourceProfileId !== undefined &&
        data.sourceProfileId !== "" &&
        !sourceProfileId) ||
      !Array.isArray(data.failedLoginUids)
    ) {
      block("malformed-candidate");
    }
    const loginUids = readUidArray(data.failedLoginUids, "malformed-candidate");
    if (loginUids.length === 0) {
      block("malformed-candidate");
    }
    validateOptionalTimestamps(data, ["createdAtMs", "updatedAtMs"]);
    return {
      loginUids,
      sourceProfileId,
      targetProfileId,
      clearPendingFields: false,
    };
  }
  if (collection === "authMergeGameBacklog") {
    if (data.status !== "pending" && data.status !== "queued") {
      block("malformed-candidate");
    }
    const opId = exactDocumentId(data.opId);
    const sourceProfileId = exactProfileId(data.sourceProfileId);
    const targetProfileId = exactProfileId(data.targetProfileId);
    if (
      !opId ||
      opId !== id ||
      !sourceProfileId ||
      !targetProfileId ||
      sourceProfileId === targetProfileId
    ) {
      block("malformed-candidate");
    }
    validateOptionalTimestamps(data, ["createdAtMs", "updatedAtMs"]);
    return {
      loginUids: [],
      sourceProfileId,
      targetProfileId,
      clearPendingFields: false,
    };
  }
  if (collection !== "users") {
    block("malformed-candidate");
  }
  const hasClaim = CLAIM_FIELDS.some((field) => own(data, field));
  const hasGame = GAME_FIELDS.some((field) => own(data, field));
  if (!hasClaim && !hasGame) {
    return null;
  }
  let loginUids = [];
  if (hasClaim) {
    if (
      !CLAIM_FIELDS.every((field) => own(data, field)) ||
      !exactDocumentId(data.pendingClaimSyncOpId) ||
      finiteTimestamp(data.pendingClaimSyncUpdatedAtMs) === null
    ) {
      block("malformed-candidate");
    }
    loginUids = readUidArray(
      data.pendingClaimSyncLogins,
      "malformed-candidate",
    );
  }
  let sourceProfileId = "";
  if (hasGame) {
    if (
      !GAME_FIELDS.slice(0, 3).every((field) => own(data, field)) ||
      !(sourceProfileId = exactProfileId(
        data.pendingMergeGameCopySourceProfileId,
      )) ||
      sourceProfileId === id ||
      !exactDocumentId(data.pendingMergeGameCopyOpId) ||
      finiteTimestamp(data.pendingMergeGameCopyUpdatedAtMs) === null
    ) {
      block("malformed-candidate");
    }
    const hasCursor = own(data, "pendingMergePrizeCopyCursor");
    const hasCompletedAt = own(data, "pendingMergePrizeCopyCompletedAtMs");
    const hasCompletedOp = own(data, "pendingMergePrizeCopyCompletedOpId");
    if (
      (hasCursor &&
        (typeof data.pendingMergePrizeCopyCursor !== "string" ||
          !isSafeFirebaseKey(data.pendingMergePrizeCopyCursor) ||
          data.pendingMergePrizeCopyCursor !==
            data.pendingMergePrizeCopyCursor.trim())) ||
      hasCompletedAt !== hasCompletedOp ||
      (hasCompletedAt &&
        (finiteTimestamp(data.pendingMergePrizeCopyCompletedAtMs) === null ||
          data.pendingMergePrizeCopyCompletedOpId !==
            data.pendingMergeGameCopyOpId)) ||
      (hasCursor && hasCompletedAt)
    ) {
      block("malformed-candidate");
    }
  }
  return {
    loginUids,
    sourceProfileId,
    targetProfileId: id,
    clearPendingFields: true,
  };
};

const parseMergeTarget = (document, profileId) => {
  if (!document.exists) {
    return "";
  }
  const data = document.data;
  const targetProfileId = exactProfileId(data.targetProfileId);
  if (
    !targetProfileId ||
    targetProfileId === profileId ||
    (own(data, "sourceProfileId") && data.sourceProfileId !== profileId)
  ) {
    block("merge-target-inconsistent");
  }
  return targetProfileId;
};

const validateStoredLogins = (value) => {
  if (value === undefined) {
    return [];
  }
  return readUidArray(value, "malformed-firebase-uid");
};

const resolveProfilePath = async (startProfileId, context) => {
  if (!exactProfileId(startProfileId)) {
    block("unsafe-profile-id");
  }
  const path = [];
  const visited = new Set();
  let currentProfileId = startProfileId;
  for (let hop = 0; hop <= MAX_PROFILE_MERGE_TARGET_HOPS; hop += 1) {
    if (visited.has(currentProfileId)) {
      block("merge-target-cycle");
    }
    visited.add(currentProfileId);
    path.push(currentProfileId);
    const [marker, user] = await Promise.all([
      context.read("profileMergeTargets", currentProfileId),
      context.read("users", currentProfileId),
    ]);
    const nextProfileId = parseMergeTarget(marker, currentProfileId);
    if (!nextProfileId) {
      if (!user.exists) {
        block("missing-canonical-profile");
      }
      if (own(user.data, "mergedIntoProfileId")) {
        block("merge-target-inconsistent");
      }
      return {
        path,
        canonicalProfileId: currentProfileId,
        canonicalUser: user,
      };
    }
    if (user.exists) {
      if (user.data.mergedIntoProfileId !== nextProfileId) {
        block("merge-target-inconsistent");
      }
      if (validateStoredLogins(user.data.logins).length > 0) {
        block("merge-source-logins-not-empty");
      }
    }
    currentProfileId = nextProfileId;
  }
  block("merge-target-overflow");
};

const sourceOrder = (paths, canonicalProfileId) => {
  const depths = new Map();
  for (const path of paths) {
    if (path.at(-1) !== canonicalProfileId) {
      block("merge-target-inconsistent");
    }
    for (let index = 0; index < path.length - 1; index += 1) {
      const profileId = path[index];
      const depth = path.length - index - 1;
      depths.set(profileId, Math.max(depths.get(profileId) || 0, depth));
    }
  }
  return Array.from(depths)
    .sort(([leftId, leftDepth], [rightId, rightDepth]) =>
      leftDepth === rightDepth
        ? leftId < rightId
          ? -1
          : leftId > rightId
            ? 1
            : 0
        : rightDepth - leftDepth,
    )
    .map(([profileId]) => profileId);
};

const parseExistingJob = (document, profileId) => {
  if (!document.exists) {
    return null;
  }
  const data = document.data;
  if (
    Object.keys(data).sort().join("\0") !== [...JOB_FIELDS].sort().join("\0") ||
    data.profileId !== profileId ||
    !Array.isArray(data.loginUids) ||
    !Array.isArray(data.sourceProfileIds) ||
    !["prizes", "games", "finalize"].includes(data.sourcePhase) ||
    (data.prizeCursor !== null &&
      (typeof data.prizeCursor !== "string" ||
        !isSafeFirebaseKey(data.prizeCursor) ||
        data.prizeCursor !== data.prizeCursor.trim())) ||
    ["phaseStartedAtMs", "lastEnqueuedAtMs", "createdAtMs", "updatedAtMs"].some(
      (field) => finiteTimestamp(data[field]) === null,
    )
  ) {
    block("existing-job-malformed");
  }
  const loginUids = readUidArray(data.loginUids, "existing-job-malformed");
  const sourceProfileIds = [];
  const seenSources = new Set();
  for (const value of data.sourceProfileIds) {
    const sourceProfileId = exactProfileId(value);
    if (
      !sourceProfileId ||
      sourceProfileId === profileId ||
      seenSources.has(sourceProfileId)
    ) {
      block("existing-job-malformed");
    }
    seenSources.add(sourceProfileId);
    sourceProfileIds.push(sourceProfileId);
  }
  if (
    loginUids.length !== data.loginUids.length ||
    sourceProfileIds.length !== data.sourceProfileIds.length ||
    (sourceProfileIds.length === 0 &&
      (data.sourcePhase !== "finalize" || data.prizeCursor !== null)) ||
    sourceProfileIds.length > MAX_JOB_SOURCE_PROFILE_IDS ||
    loginUids.length > MAX_JOB_LOGIN_UIDS
  ) {
    block("existing-job-malformed");
  }
  return { ...data, loginUids, sourceProfileIds };
};

const validatePrizeMap = (value, profileId) => {
  if (value === null || value === undefined) {
    return new Map();
  }
  if (!isRecord(value)) {
    block("prize-assignment-invalid");
  }
  const result = new Map();
  for (const [eventId, assignment] of Object.entries(value)) {
    if (
      !eventId ||
      eventId !== eventId.trim() ||
      !isSafeFirebaseKey(eventId) ||
      !isRecord(assignment) ||
      assignment.eventId !== eventId ||
      assignment.profileId !== profileId ||
      ![1, 2, 3].includes(assignment.place) ||
      typeof assignment.prizeId !== "string" ||
      assignment.prizeId !== assignment.prizeId.trim() ||
      !isSafeFirebaseKey(assignment.prizeId) ||
      !isEventPrizeId(eventId, assignment.prizeId) ||
      !Number.isSafeInteger(assignment.assignedAtMs) ||
      assignment.assignedAtMs < 0
    ) {
      block("prize-assignment-invalid");
    }
    result.set(eventId, {
      eventId,
      place: assignment.place,
      prizeId: assignment.prizeId,
      assignedAtMs: assignment.assignedAtMs,
    });
  }
  return result;
};

const preflightPrizes = async ({ profileId, sourceProfileIds, readPrizes }) => {
  const profileIds = [profileId, ...sourceProfileIds];
  const raw = new Map();
  const assignments = new Map();
  for (const candidateProfileId of profileIds) {
    const value = await readPrizes(candidateProfileId);
    raw.set(candidateProfileId, value ?? null);
    const candidateAssignments = validatePrizeMap(value, candidateProfileId);
    for (const [eventId, assignment] of candidateAssignments) {
      const existing = assignments.get(eventId);
      if (existing && !isDeepStrictEqual(existing, assignment)) {
        block("prize-conflict");
      }
      assignments.set(eventId, assignment);
    }
  }
  return raw;
};

const analyzeCandidate = async ({
  candidate,
  nowMs,
  readDocument,
  readPrizes,
}) => {
  const context = createReadContext(readDocument);
  const liveCandidate = await context.read(candidate.collection, candidate.id);
  if (!liveCandidate.exists) {
    return { status: "gone" };
  }
  const legacy = readLegacyCandidate(
    candidate.collection,
    candidate.id,
    liveCandidate.data,
  );
  if (!legacy) {
    return { status: "clean" };
  }
  const targetResolution = await resolveProfilePath(
    legacy.targetProfileId,
    context,
  );
  const canonicalProfileId = targetResolution.canonicalProfileId;
  const paths = [targetResolution.path];
  if (legacy.sourceProfileId && legacy.sourceProfileId !== canonicalProfileId) {
    const sourceResolution = await resolveProfilePath(
      legacy.sourceProfileId,
      context,
    );
    if (
      sourceResolution.canonicalProfileId !== canonicalProfileId ||
      (candidate.collection === "authMergeGameBacklog" &&
        sourceResolution.path[1] !== legacy.targetProfileId) ||
      (candidate.collection === "users" &&
        !sourceResolution.path.includes(legacy.targetProfileId))
    ) {
      block("merge-target-inconsistent");
    }
    paths.push(sourceResolution.path);
  }
  const canonicalLogins = validateStoredLogins(
    targetResolution.canonicalUser.data.logins,
  );
  const ownedLogins = new Set(canonicalLogins);
  if (legacy.loginUids.some((uid) => !ownedLogins.has(uid))) {
    block("uid-not-owned-by-canonical-profile");
  }
  const jobDocument = await context.read(
    "authRecoveryJobs",
    canonicalProfileId,
  );
  const existingJob = parseExistingJob(jobDocument, canonicalProfileId);
  if (existingJob) {
    if (
      existingJob.lastEnqueuedAtMs > 0 ||
      (existingJob.sourceProfileIds.length > 0 &&
        (existingJob.sourcePhase !== "prizes" ||
          existingJob.prizeCursor !== null))
    ) {
      block("existing-job-in-progress");
    }
    for (const sourceProfileId of existingJob.sourceProfileIds) {
      const resolution = await resolveProfilePath(sourceProfileId, context);
      if (resolution.canonicalProfileId !== canonicalProfileId) {
        block("merge-target-inconsistent");
      }
      paths.push(resolution.path);
    }
  }
  const loginUids = uniqueSorted([
    ...(existingJob?.loginUids || []),
    ...legacy.loginUids,
  ]);
  if (loginUids.some((uid) => !ownedLogins.has(uid))) {
    block("uid-not-owned-by-canonical-profile");
  }
  const sourceProfileIds = sourceOrder(paths, canonicalProfileId);
  if (
    loginUids.length > MAX_JOB_LOGIN_UIDS ||
    sourceProfileIds.length > MAX_JOB_SOURCE_PROFILE_IDS
  ) {
    block("job-too-large");
  }
  const job = {
    profileId: canonicalProfileId,
    loginUids,
    sourceProfileIds,
    sourcePhase: sourceProfileIds.length > 0 ? "prizes" : "finalize",
    prizeCursor: null,
    phaseStartedAtMs: nowMs,
    lastEnqueuedAtMs: 0,
    createdAtMs: existingJob?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
  };
  const prizeSnapshots = await preflightPrizes({
    profileId: canonicalProfileId,
    sourceProfileIds,
    readPrizes,
  });
  return {
    status: "convertible",
    canonicalProfileId,
    clearPendingFields: legacy.clearPendingFields,
    expectedDocuments: Array.from(context.documents.values()),
    job,
    prizeSnapshots,
  };
};

const convertLegacyAuthRecoveryPage = async (
  options,
  { listDocuments, readDocument, readPrizes, commitConversion, now = Date.now },
) => {
  if (
    typeof listDocuments !== "function" ||
    typeof readDocument !== "function" ||
    typeof readPrizes !== "function" ||
    (!options.dryRun && typeof commitConversion !== "function")
  ) {
    throw new TypeError("converter-adapters-required");
  }
  const page = await collectCandidatePage({
    after: options.after,
    limit: options.limit,
    listDocuments,
  });
  const nowMs = now();
  const blockedCandidates = [];
  const plannedJobs = new Map();
  const results = [];
  for (const candidate of page.candidates) {
    try {
      const candidateReadDocument = async (collection, id) => {
        if (options.dryRun && collection === "authRecoveryJobs") {
          const planned = plannedJobs.get(id);
          if (planned) {
            return {
              id,
              data: cloneJob(planned),
              version: `dry-run:${id}`,
            };
          }
        }
        return readDocument(collection, id);
      };
      const analysis = await analyzeCandidate({
        candidate,
        nowMs,
        readDocument: candidateReadDocument,
        readPrizes,
      });
      if (analysis.status !== "convertible") {
        results.push({ ...candidate, status: analysis.status });
        continue;
      }
      if (!options.dryRun) {
        for (const [profileId, expected] of analysis.prizeSnapshots) {
          const live = (await readPrizes(profileId)) ?? null;
          if (!isDeepStrictEqual(live, expected)) {
            block("concurrent-prize-change");
          }
        }
        await commitConversion({
          candidate,
          canonicalProfileId: analysis.canonicalProfileId,
          clearPendingFields: analysis.clearPendingFields,
          expectedDocuments: analysis.expectedDocuments,
          job: analysis.job,
        });
      }
      if (options.dryRun) {
        plannedJobs.set(analysis.canonicalProfileId, analysis.job);
      }
      results.push({
        ...candidate,
        status: "convertible",
        executed: !options.dryRun,
        profileId: analysis.canonicalProfileId,
        job: analysis.job,
      });
    } catch (error) {
      if (!(error instanceof ConversionBlocked)) {
        throw error;
      }
      const blocked = {
        entityType: candidate.collection,
        id: candidate.id,
        reason: error.reason,
      };
      blockedCandidates.push(blocked);
      results.push({
        collection: candidate.collection,
        id: candidate.id,
        status: "blocked",
        reason: error.reason,
      });
    }
  }
  return {
    complete: blockedCandidates.length === 0,
    blockedCandidates,
    dryRun: options.dryRun,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    results,
  };
};

const firestoreVersion = (snapshot) => {
  if (!snapshot.exists) {
    return null;
  }
  const timestamp = snapshot.updateTime;
  return timestamp ? `${timestamp.seconds}:${timestamp.nanoseconds}` : null;
};

const createAdminAdapters = () => {
  const firestore = admin.firestore();
  const database = admin.database();
  const documentRef = (collection, id) =>
    firestore.collection(collection).doc(id);
  const readSnapshot = (snapshot) =>
    snapshot.exists
      ? {
          id: snapshot.id,
          data: snapshot.data() || {},
          version: firestoreVersion(snapshot),
        }
      : null;
  return {
    listDocuments: async (collection, after, limit) => {
      let query = firestore
        .collection(collection)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(limit);
      if (after) {
        query = query.startAfter(after);
      }
      const snapshot = await query.get();
      return snapshot.docs.map((document) => ({ id: document.id }));
    },
    readDocument: async (collection, id) =>
      readSnapshot(await documentRef(collection, id).get()),
    readPrizes: async (profileId) =>
      (
        await database.ref(`profileEventPrizes/${profileId}`).once("value")
      ).val(),
    commitConversion: async ({
      candidate,
      canonicalProfileId,
      clearPendingFields,
      expectedDocuments,
      job,
    }) => {
      await firestore.runTransaction(async (transaction) => {
        const expected = new Map(
          expectedDocuments.map((document) => [
            documentKey(document.collection, document.id),
            document,
          ]),
        );
        const snapshots = await Promise.all(
          Array.from(expected.values(), (document) =>
            transaction.get(documentRef(document.collection, document.id)),
          ),
        );
        for (const snapshot of snapshots) {
          const key = documentKey(snapshot.ref.parent.id, snapshot.id);
          const document = expected.get(key);
          if (
            !document ||
            snapshot.exists !== document.exists ||
            firestoreVersion(snapshot) !== document.version
          ) {
            block("concurrent-firestore-change");
          }
        }
        transaction.set(
          documentRef("authRecoveryJobs", canonicalProfileId),
          job,
        );
        if (clearPendingFields) {
          transaction.update(
            documentRef(candidate.collection, candidate.id),
            Object.fromEntries(
              PENDING_FIELDS.map((field) => [
                field,
                admin.firestore.FieldValue.delete(),
              ]),
            ),
          );
        } else {
          transaction.delete(documentRef(candidate.collection, candidate.id));
        }
      });
    },
  };
};

const main = async (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv);
  decodeCursor(options.after);
  if (!initAdmin(options.adminArgs)) {
    throw new Error(ADC_FAILURE_MESSAGE);
  }
  try {
    const result = await convertLegacyAuthRecoveryPage(
      options,
      createAdminAdapters(),
    );
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    throw addApplicationDefaultCredentialHelp(error);
  } finally {
    await cleanupAdmin();
  }
};

if (require.main === module) {
  main()
    .then((result) => {
      if (!result.complete) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    });
}

module.exports = {
  COLLECTIONS,
  ConversionBlocked,
  MAX_JOB_LOGIN_UIDS,
  MAX_JOB_SOURCE_PROFILE_IDS,
  PENDING_FIELDS,
  collectCandidatePage,
  convertLegacyAuthRecoveryPage,
  decodeCursor,
  encodeCursor,
  main,
  parseArgs,
};
