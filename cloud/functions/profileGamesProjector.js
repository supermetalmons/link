const admin = require("./firebaseAdmin");
const { FieldPath } = require("firebase-admin/firestore");
const {
  onValueCreated,
  onValueWritten,
} = require("firebase-functions/v2/database");
const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
const {
  orderProfileMergeCleanupIds,
  PROFILE_MERGE_TARGETS_COLLECTION,
  resolveProfileMergeTargetPath,
} = require("./profileMergeTargets");
const {
  createInviteCandidatesFromMatchId,
  deriveLatestMatchId,
} = require("@mons/shared/rematches");
const { inferAutomatchStateHint } = require("@mons/shared/navigation");
const { isAutoInviteId } = require("@mons/shared/ids");
const {
  PROJECTOR_SCHEMA_VERSION,
  deriveProjectionStatus,
  fingerprintForProjection,
  getEmojiId,
  getNavigationSortBucket,
  getOwnerContext,
  getOwnerProfileIds,
  getProfileDisplayName,
  getProfileEmoji,
  normalizeString,
  pickListSortMillis,
  readEventTimestampMs,
  readTimestampMillis,
  shouldProjectInvite,
} = require("./events/gameProjectionModel");

const PROFILE_LINK_CATCHUP_MAX_INVITES = 300;
const PROFILE_LINK_CATCHUP_CONCURRENCY = 20;
const PROFILE_LINK_CATCHUP_TIMEOUT_MS = 50000;
const PROFILE_LINK_STALE_CLEANUP_MERGE_WINDOW_MS = 15 * 60 * 1000;
const PROFILE_LINK_STALE_CLEANUP_WAIT_MAX_MS = 4000;
const PROFILE_LINK_STALE_CLEANUP_WAIT_STEP_MS = 250;
const PROFILE_DELETE_GAMES_CLEANUP_BATCH_SIZE = 400;
const PROFILE_DELETE_GAMES_CLEANUP_TIMEOUT_MS = 50000;
const PROFILE_MERGE_RECONCILE_CONCURRENCY = 10;
const PROFILE_MERGE_RECONCILE_PAGE_SIZE = 200;
const AUTOMATCH_MARKER_RECONCILE_ATTEMPTS = 3;
const PROFILE_LINK_RECONCILE_ATTEMPTS = 3;

const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 25;

const profileSummaryCache = new Map();

const readMergeTarget = async (firestore, profileId) => {
  const snapshot = await readWithRetries(() =>
    firestore.collection(PROFILE_MERGE_TARGETS_COLLECTION).doc(profileId).get(),
  );
  return snapshot.exists ? snapshot.data() : null;
};

const buildResolvedProfile = (profilePath, pendingSourcePath = []) => {
  const profileId = profilePath[profilePath.length - 1] || null;
  if (!profileId) {
    return { cleanupProfileIds: [], profileId: null };
  }
  const cleanupProfileIds = [...profilePath];
  if (
    pendingSourcePath.length > 1 &&
    pendingSourcePath[pendingSourcePath.length - 1] === profileId
  ) {
    cleanupProfileIds.unshift(...pendingSourcePath.slice(0, -1));
  }
  return {
    cleanupProfileIds: Array.from(new Set(cleanupProfileIds)),
    profileId,
  };
};

const buildInviteProjectionOwnerPlan = (
  hostProfile,
  guestProfile,
  cleanupProfileIds = [],
) => {
  const ownerProfileIds = getOwnerProfileIds(
    hostProfile.profileId,
    guestProfile.profileId,
  );
  return {
    cleanupProfileIds: orderProfileMergeCleanupIds(
      [
        ...hostProfile.cleanupProfileIds,
        ...guestProfile.cleanupProfileIds,
        ...cleanupProfileIds,
        ...ownerProfileIds,
      ],
      ownerProfileIds,
    ),
    ownerProfileIds,
  };
};

const readExistingProjectionDocuments = async ({
  attempts = READ_RETRY_ATTEMPTS,
  inviteId,
  profileIds,
  readDocument,
  reason,
  retryDelayMs = READ_RETRY_DELAY_MS,
  logger = console,
  wait = delay,
}) => {
  const results = await Promise.allSettled(
    profileIds.map(async (profileId) => {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return { profileId, snapshot: await readDocument(profileId) };
        } catch (error) {
          if (attempt >= attempts) {
            throw error;
          }
          await wait(retryDelayMs);
        }
      }
      throw new Error("projector:existing-doc-read-retry-exhausted");
    }),
  );
  const documents = [];
  let didFail = false;
  let failure = null;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      if (!didFail) {
        didFail = true;
        failure = result.reason;
      }
      logger.error("projector:existing-doc-read-failed", {
        inviteId,
        ownerProfileId: profileIds[index],
        reason,
        error:
          result.reason && result.reason.message
            ? result.reason.message
            : result.reason,
      });
      return;
    }
    if (result.value.snapshot.exists) {
      documents.push(result.value);
    }
  });
  if (didFail) {
    throw failure;
  }
  return documents;
};

const getStoredProjectionOwnerRole = (profileId, data) => {
  const ownerRole = normalizeString(data && data.ownerRole);
  if (ownerRole === "host" || ownerRole === "guest") {
    return ownerRole;
  }
  const ownerProfileId =
    normalizeString(data && data.ownerProfileId) || profileId;
  if (ownerProfileId === normalizeString(data && data.hostProfileId)) {
    return "host";
  }
  if (ownerProfileId === normalizeString(data && data.guestProfileId)) {
    return "guest";
  }
  return null;
};

const findFreshestSourceProjectionData = ({
  existingDocs,
  ownerContext,
  ownerProfileId,
  requiresResolvedOpponentEmoji,
}) => {
  let freshest = null;
  let freshestMs = Number.NEGATIVE_INFINITY;
  for (const existing of existingDocs) {
    if (existing.profileId === ownerProfileId) {
      continue;
    }
    const data = existing.snapshot.data() || {};
    const storedOwnerLoginId = normalizeString(data.ownerLoginId);
    const ownerLoginId = normalizeString(ownerContext.ownerLoginId);
    if (
      storedOwnerLoginId &&
      ownerLoginId &&
      storedOwnerLoginId !== ownerLoginId
    ) {
      continue;
    }
    if (
      (!storedOwnerLoginId || !ownerLoginId) &&
      getStoredProjectionOwnerRole(existing.profileId, data) !==
        ownerContext.ownerRole
    ) {
      continue;
    }
    if (
      requiresResolvedOpponentEmoji &&
      getEmojiId(data.opponentEmoji ?? data.opponentEmojiId) === null
    ) {
      continue;
    }
    const freshnessMs = [
      data.updatedAt,
      data.lastEventAt,
      data.listSortAt,
      data.createdAt,
    ].reduce((current, value) => {
      const millis = readTimestampMillis(value);
      return Number.isFinite(millis) ? Math.max(current, millis) : current;
    }, Number.NEGATIVE_INFINITY);
    if (!freshest || freshnessMs > freshestMs) {
      freshest = data;
      freshestMs = freshnessMs;
    }
  }
  return freshest;
};

const toTimestamp = (millis) => {
  const normalized = Number.isFinite(millis)
    ? Math.floor(Number(millis))
    : Date.now();
  return admin.firestore.Timestamp.fromMillis(Math.max(1, normalized));
};

const delay = async (ms) => {
  const safeDelay = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  if (safeDelay <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, safeDelay));
};

const readWithRetries = async (
  read,
  attempts = READ_RETRY_ATTEMPTS,
  retryDelayMs = READ_RETRY_DELAY_MS,
) => {
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      failure = error;
      if (attempt < attempts) {
        await delay(retryDelayMs);
      }
    }
  }
  throw failure;
};

async function readLoginSummaryFromRtdbMatches(
  loginUid,
  latestMatchId,
  inviteId,
  cache,
) {
  const normalizedLoginUid = normalizeString(loginUid);
  if (!normalizedLoginUid) {
    return null;
  }

  const normalizedLatestMatchId = normalizeString(latestMatchId);
  const normalizedInviteId = normalizeString(inviteId);
  const cacheKey = `${normalizedLoginUid}|${normalizedLatestMatchId || ""}|${normalizedInviteId || ""}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const candidateMatchIds = [];
  if (normalizedLatestMatchId) {
    candidateMatchIds.push(normalizedLatestMatchId);
  }
  if (normalizedInviteId && normalizedInviteId !== normalizedLatestMatchId) {
    candidateMatchIds.push(normalizedInviteId);
  }

  for (const candidateMatchId of candidateMatchIds) {
    try {
      const matchSnapshot = await readWithRetries(() =>
        admin
          .database()
          .ref(`players/${normalizedLoginUid}/matches/${candidateMatchId}`)
          .once("value"),
      );
      if (!matchSnapshot.exists()) {
        continue;
      }
      const matchData = matchSnapshot.val() || {};
      const emoji = getEmojiId(matchData.emojiId);
      if (emoji !== null) {
        const summary = {
          name: null,
          emoji,
        };
        cache.set(cacheKey, summary);
        return summary;
      }
    } catch (error) {
      console.error("projector:login-summary-rtdb-read-failed", {
        loginUid: normalizedLoginUid,
        matchId: candidateMatchId,
        attempts: READ_RETRY_ATTEMPTS,
        error: error && error.message ? error.message : error,
      });
      throw error;
    }
  }

  cache.set(cacheKey, null);
  return null;
}

const readInviteExists = async (
  inviteId,
  inviteExistenceCache,
  dependencies = {},
) => {
  if (!inviteId) {
    return false;
  }
  if (inviteExistenceCache && inviteExistenceCache.has(inviteId)) {
    const cached = inviteExistenceCache.get(inviteId);
    if (typeof cached === "boolean") {
      return cached;
    }
    return await cached;
  }
  const readInvite =
    dependencies.readInvite ||
    (() => admin.database().ref(`invites/${inviteId}`).once("value"));
  const promise = readWithRetries(() => readInvite(inviteId))
    .then((snapshot) => snapshot.exists())
    .catch((error) => {
      console.error("projector:invite-exists-read-failed", {
        inviteId,
        attempts: READ_RETRY_ATTEMPTS,
        error: error && error.message ? error.message : error,
      });
      throw error;
    });
  if (inviteExistenceCache) {
    inviteExistenceCache.set(inviteId, promise);
  }
  const exists = await promise;
  if (inviteExistenceCache) {
    inviteExistenceCache.set(inviteId, exists);
  }
  return exists;
};

async function resolveInviteIdFromMatchId(matchId, options = {}) {
  const normalizedMatchId = normalizeString(matchId);
  if (!normalizedMatchId) {
    return null;
  }

  const inviteExistenceCache = options.inviteExistenceCache;

  if (await readInviteExists(normalizedMatchId, inviteExistenceCache)) {
    return normalizedMatchId;
  }

  const candidates = createInviteCandidatesFromMatchId(normalizedMatchId);
  if (candidates.length === 0) {
    return null;
  }

  const existingCandidates = [];
  for (const candidate of candidates) {
    if (await readInviteExists(candidate, inviteExistenceCache)) {
      existingCandidates.push(candidate);
    }
  }

  if (existingCandidates.length === 0) {
    return null;
  }

  if (existingCandidates.length > 1) {
    console.log("projector:match-resolver:multiple-candidates", {
      matchId: normalizedMatchId,
      candidates: existingCandidates,
      resolution: "rejected-ambiguous",
    });
    return null;
  }

  return existingCandidates[0];
}

const readCurrentProfileLink = async (loginUid) => {
  const snapshot = await readWithRetries(() =>
    admin.database().ref(`players/${loginUid}/profile`).once("value"),
  );
  return normalizeString(snapshot.val());
};

const resolveProfileLinkCatchupState = async (
  { eventProfileId, loginUid, staleProfileId },
  dependencies = {},
) => {
  const readProfileLink =
    dependencies.readCurrentProfileLink || readCurrentProfileLink;
  const profileId = await readProfileLink(loginUid);
  if (!profileId) {
    return null;
  }
  return {
    cleanupProfileIds: Array.from(
      new Set([staleProfileId, eventProfileId, profileId].filter(Boolean)),
    ),
    profileId,
  };
};

async function resolveProfileForLogin(loginUid) {
  const normalizedLoginUid = normalizeString(loginUid);
  if (!normalizedLoginUid) {
    return { cleanupProfileIds: [], profileId: null };
  }

  let rawProfileId = null;
  let profileLinkReadError = null;
  let profileQueryReadError = null;

  try {
    const profileSnapshot = await readWithRetries(() =>
      admin
        .database()
        .ref(`players/${normalizedLoginUid}/profile`)
        .once("value"),
    );
    const profileValue = normalizeString(profileSnapshot.val());
    if (profileValue) {
      rawProfileId = profileValue;
    }
  } catch (error) {
    profileLinkReadError = error;
    console.error("projector:profile-resolve:rtdb-read-failed", {
      loginUid: normalizedLoginUid,
      attempts: READ_RETRY_ATTEMPTS,
      error: error && error.message ? error.message : error,
    });
  }

  if (!rawProfileId) {
    try {
      const usersSnapshot = await readWithRetries(() =>
        admin
          .firestore()
          .collection("users")
          .where("logins", "array-contains", normalizedLoginUid)
          .limit(1)
          .get(),
      );
      if (!usersSnapshot.empty) {
        rawProfileId = usersSnapshot.docs[0].id;
      }
    } catch (error) {
      profileQueryReadError = error;
      console.error("projector:profile-resolve:firestore-read-failed", {
        loginUid: normalizedLoginUid,
        attempts: READ_RETRY_ATTEMPTS,
        error: error && error.message ? error.message : error,
      });
    }
  }

  if (!rawProfileId) {
    if (profileQueryReadError || profileLinkReadError) {
      throw profileQueryReadError || profileLinkReadError;
    }
    return { cleanupProfileIds: [], profileId: null };
  }
  const firestore = admin.firestore();
  const profilePath = await resolveProfileMergeTargetPath({
    profileId: rawProfileId,
    readMergeTarget: (candidateProfileId) =>
      readMergeTarget(firestore, candidateProfileId),
  });
  const profileId = profilePath[profilePath.length - 1] || null;
  if (!profileId) {
    return { cleanupProfileIds: [], profileId: null };
  }
  let pendingSourcePath = [];
  const profileSnapshot = await readWithRetries(() =>
    firestore.collection("users").doc(profileId).get(),
  );
  const pendingSourceProfileId = normalizeString(
    profileSnapshot.exists
      ? (profileSnapshot.data() || {}).pendingMergeGameCopySourceProfileId
      : null,
  );
  if (pendingSourceProfileId) {
    pendingSourcePath = await resolveProfileMergeTargetPath({
      profileId: pendingSourceProfileId,
      readMergeTarget: (candidateProfileId) =>
        readMergeTarget(firestore, candidateProfileId),
    });
  }
  return buildResolvedProfile(profilePath, pendingSourcePath);
}

async function readProfileSummary(profileId) {
  const normalizedProfileId = normalizeString(profileId);
  if (!normalizedProfileId) {
    return null;
  }
  if (profileSummaryCache.has(normalizedProfileId)) {
    return profileSummaryCache.get(normalizedProfileId);
  }

  let summary = null;
  try {
    const profileDoc = await readWithRetries(() =>
      admin.firestore().collection("users").doc(normalizedProfileId).get(),
    );
    if (profileDoc.exists) {
      const profileData = profileDoc.data() || {};
      summary = {
        name: getProfileDisplayName(profileData),
        emoji: getProfileEmoji(profileData),
      };
    }
  } catch (error) {
    console.error("projector:profile-summary-read-failed", {
      profileId: normalizedProfileId,
      attempts: READ_RETRY_ATTEMPTS,
      error: error && error.message ? error.message : error,
    });
    throw error;
  }

  profileSummaryCache.set(normalizedProfileId, summary);
  return summary;
}

async function recomputeInviteProjection(inviteId, reason, options = {}) {
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId) {
    return {
      ok: false,
      inviteId: inviteId || null,
      reason,
      skipped: true,
      skipReason: "invalid-invite-id",
      sourceCleanupSafe: false,
      blockedReason: "invalid-invite-id",
    };
  }

  const nowMs = readEventTimestampMs(options);
  const db = admin.database();
  const firestore = admin.firestore();

  const [inviteSnapshot, automatchSnapshot] = await Promise.all([
    readWithRetries(() =>
      db.ref(`invites/${normalizedInviteId}`).once("value"),
    ),
    readWithRetries(() =>
      db.ref(`automatch/${normalizedInviteId}`).once("value"),
    ),
  ]);

  const inviteData = inviteSnapshot.exists() ? inviteSnapshot.val() : null;
  const automatchData = automatchSnapshot.exists()
    ? automatchSnapshot.val()
    : null;

  const hostLoginId = normalizeString(inviteData ? inviteData.hostId : null);
  const guestLoginId = normalizeString(inviteData ? inviteData.guestId : null);

  const [hostProfile, guestProfile] = await Promise.all([
    resolveProfileForLogin(hostLoginId),
    resolveProfileForLogin(guestLoginId),
  ]);
  const hostProfileId = hostProfile.profileId;
  const guestProfileId = guestProfile.profileId;

  const { cleanupProfileIds, ownerProfileIds } = buildInviteProjectionOwnerPlan(
    hostProfile,
    guestProfile,
    options.cleanupProfileIds,
  );

  const automatchStateHint = inferAutomatchStateHint({
    inviteId: normalizedInviteId,
    queueValue: automatchData,
    hasGuest: !!guestLoginId,
    storedStateHint: inviteData ? inviteData.automatchStateHint : null,
  });
  const latestMatchId = deriveLatestMatchId(
    normalizedInviteId,
    inviteData,
    options.latestMatchIdHint || null,
  );
  const status = deriveProjectionStatus({
    inviteId: normalizedInviteId,
    inviteData,
    automatchStateHint,
    latestMatchId,
  });
  const shouldProject = shouldProjectInvite({
    inviteId: normalizedInviteId,
    inviteData,
    automatchStateHint,
  });
  const sortBucket = getNavigationSortBucket(status);
  const loginSummaryCache = new Map();

  const existingDocsByOwnerProfileId = new Map();
  const existingDocs = await readExistingProjectionDocuments({
    inviteId: normalizedInviteId,
    profileIds: cleanupProfileIds,
    readDocument: (ownerProfileId) =>
      firestore
        .collection("users")
        .doc(ownerProfileId)
        .collection("games")
        .doc(normalizedInviteId)
        .get(),
    reason,
  });
  existingDocs.forEach(({ profileId, snapshot }) => {
    existingDocsByOwnerProfileId.set(profileId, snapshot);
  });

  const ownerSet = new Set(ownerProfileIds);
  const hasUnresolvedOwner = Boolean(
    shouldProject &&
    (ownerProfileIds.length === 0 ||
      !hostLoginId ||
      !hostProfileId ||
      (guestLoginId && !guestProfileId)),
  );
  let sourceCleanupSafe = !hasUnresolvedOwner;
  let blockedReason = hasUnresolvedOwner ? "unresolved-owner-profile" : null;
  const batch = firestore.batch();

  let setCount = 0;
  let deleteCount = 0;
  let skippedCount = 0;

  if (!shouldProject || ownerProfileIds.length === 0) {
    if (sourceCleanupSafe) {
      for (const existing of existingDocs) {
        batch.delete(existing.snapshot.ref);
        deleteCount += 1;
      }
    }
    if (!options.dryRun && deleteCount > 0) {
      await batch.commit();
    }
    return {
      ok: true,
      inviteId: normalizedInviteId,
      reason,
      shouldProject,
      ownerProfileIds,
      sourceCleanupSafe,
      ...(blockedReason ? { blockedReason } : {}),
      writes: 0,
      deletes: deleteCount,
      skipped: 0,
      dryRun: options.dryRun === true,
    };
  }

  const commonProjection = {
    schemaVersion: PROJECTOR_SCHEMA_VERSION,
    projectorVersion: PROJECTOR_SCHEMA_VERSION,
    source: "rtdb-projector",
    entityType: "game",
    inviteId: normalizedInviteId,
    kind: isAutoInviteId(normalizedInviteId) ? "auto" : "direct",
    hostLoginId,
    guestLoginId,
    hostProfileId,
    guestProfileId,
    status,
    sortBucket,
    isPendingAutomatch: status === "pending",
    automatchStateHint,
    automatchCanceledAt:
      typeof (inviteData && inviteData.automatchCanceledAt) === "number"
        ? inviteData.automatchCanceledAt
        : null,
    latestMatchId,
  };
  for (const ownerProfileId of ownerProfileIds) {
    const ownerContext = getOwnerContext({
      ownerProfileId,
      hostProfileId,
      guestProfileId,
      hostLoginId,
      guestLoginId,
    });
    const ownerDocRef = firestore
      .collection("users")
      .doc(ownerProfileId)
      .collection("games")
      .doc(normalizedInviteId);
    const existingDocSnapshot =
      existingDocsByOwnerProfileId.get(ownerProfileId);
    const existingDocData = existingDocSnapshot
      ? existingDocSnapshot.data()
      : null;
    const requiresResolvedOpponentEmoji =
      status === "active" || status === "ended";
    const sourceProjectionData = findFreshestSourceProjectionData({
      existingDocs,
      ownerContext,
      ownerProfileId,
      requiresResolvedOpponentEmoji,
    });

    const opponentProfileSummary = ownerContext.opponentProfileId
      ? await readProfileSummary(ownerContext.opponentProfileId)
      : null;
    const existingOpponentName = normalizeString(
      existingDocData
        ? (existingDocData.opponentName ?? existingDocData.opponentDisplayName)
        : null,
    );
    const sourceOpponentName = normalizeString(
      sourceProjectionData
        ? (sourceProjectionData.opponentName ??
            sourceProjectionData.opponentDisplayName)
        : null,
    );
    const opponentName =
      opponentProfileSummary && typeof opponentProfileSummary.name === "string"
        ? opponentProfileSummary.name
        : existingOpponentName || sourceOpponentName;
    const opponentEmojiFromProfile =
      opponentProfileSummary &&
      opponentProfileSummary.emoji !== null &&
      opponentProfileSummary.emoji !== undefined
        ? opponentProfileSummary.emoji
        : null;
    let opponentEmojiFromLogin = null;
    if (opponentEmojiFromProfile === null && ownerContext.opponentLoginId) {
      const opponentLoginSummary = await readLoginSummaryFromRtdbMatches(
        ownerContext.opponentLoginId,
        latestMatchId,
        normalizedInviteId,
        loginSummaryCache,
      );
      opponentEmojiFromLogin =
        opponentLoginSummary &&
        opponentLoginSummary.emoji !== null &&
        opponentLoginSummary.emoji !== undefined
          ? opponentLoginSummary.emoji
          : null;
    }
    const existingOpponentEmoji = getEmojiId(
      existingDocData
        ? (existingDocData.opponentEmoji ?? existingDocData.opponentEmojiId)
        : null,
    );
    const sourceOpponentEmoji = getEmojiId(
      sourceProjectionData
        ? (sourceProjectionData.opponentEmoji ??
            sourceProjectionData.opponentEmojiId)
        : null,
    );
    const opponentEmoji =
      opponentEmojiFromProfile !== null
        ? opponentEmojiFromProfile
        : opponentEmojiFromLogin !== null
          ? opponentEmojiFromLogin
          : existingOpponentEmoji !== null
            ? existingOpponentEmoji
            : sourceOpponentEmoji;

    if (requiresResolvedOpponentEmoji && opponentEmoji === null) {
      sourceCleanupSafe = false;
      blockedReason ||= "unresolved-opponent-emoji";
      skippedCount += 1;
      continue;
    }

    const projectionFingerprintPayload = {
      schemaVersion: PROJECTOR_SCHEMA_VERSION,
      inviteId: normalizedInviteId,
      ownerProfileId,
      kind: commonProjection.kind,
      hostLoginId,
      guestLoginId,
      hostProfileId,
      guestProfileId,
      status,
      sortBucket,
      isPendingAutomatch: commonProjection.isPendingAutomatch,
      automatchStateHint,
      automatchCanceledAt: commonProjection.automatchCanceledAt,
      latestMatchId,
      ownerRole: ownerContext.ownerRole,
      ownerLoginId: ownerContext.ownerLoginId,
      opponentProfileId: ownerContext.opponentProfileId,
      opponentLoginId: ownerContext.opponentLoginId,
      opponentName,
      opponentEmoji,
    };

    const nextFingerprint = fingerprintForProjection(
      projectionFingerprintPayload,
    );
    const previousFingerprint =
      existingDocData &&
      typeof existingDocData.lastEventFingerprint === "string"
        ? existingDocData.lastEventFingerprint
        : null;

    if (previousFingerprint && previousFingerprint === nextFingerprint) {
      skippedCount += 1;
      continue;
    }

    const canonicalListSortMs = existingDocData
      ? readTimestampMillis(existingDocData.listSortAt)
      : null;
    const sourceListSortMs = readTimestampMillis(
      sourceProjectionData?.listSortAt,
    );
    const existingListSortMs = Number.isFinite(canonicalListSortMs)
      ? canonicalListSortMs
      : sourceListSortMs;
    const nextListSortMs =
      !Number.isFinite(canonicalListSortMs) && Number.isFinite(sourceListSortMs)
        ? sourceListSortMs
        : pickListSortMillis({
            options,
            status,
            automatchData,
            nowMs,
            existingListSortMs,
          });

    const existingCreatedAt =
      (existingDocData && existingDocData.createdAt) ||
      (sourceProjectionData && sourceProjectionData.createdAt) ||
      null;
    const existingEndedAt =
      (existingDocData && existingDocData.endedAt) ||
      (sourceProjectionData && sourceProjectionData.endedAt) ||
      null;

    const projectionDocData = {
      ...commonProjection,
      ownerProfileId,
      ownerRole: ownerContext.ownerRole,
      ownerLoginId: ownerContext.ownerLoginId,
      opponentProfileId: ownerContext.opponentProfileId,
      opponentLoginId: ownerContext.opponentLoginId,
      opponentName,
      opponentDisplayName: opponentName,
      opponentEmoji,
      opponentEmojiId: opponentEmoji,
      listSortAt: toTimestamp(nextListSortMs),
      createdAt: existingCreatedAt || toTimestamp(nowMs),
      updatedAt: toTimestamp(nowMs),
      endedAt:
        status === "ended" ? existingEndedAt || toTimestamp(nowMs) : null,
      lastEventFingerprint: nextFingerprint,
      lastEventType: normalizeString(reason) || null,
      lastEventReason: normalizeString(reason) || null,
      lastEventAt: toTimestamp(nowMs),
    };

    batch.set(ownerDocRef, projectionDocData, { merge: true });
    setCount += 1;
  }

  if (sourceCleanupSafe) {
    for (const existing of existingDocs) {
      if (!ownerSet.has(existing.profileId)) {
        batch.delete(existing.snapshot.ref);
        deleteCount += 1;
      }
    }
  }

  if (!options.dryRun && (setCount > 0 || deleteCount > 0)) {
    await batch.commit();
  }

  return {
    ok: true,
    inviteId: normalizedInviteId,
    reason,
    shouldProject,
    ownerProfileIds,
    sourceCleanupSafe,
    ...(blockedReason ? { blockedReason } : {}),
    writes: setCount,
    deletes: deleteCount,
    skipped: skippedCount,
    dryRun: options.dryRun === true,
  };
}

async function syncAutomatchInviteMarkerFromQueue(inviteId) {
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId) {
    return { ok: false, updated: false, reason: "invalid-invite-id" };
  }
  const database = admin.database();
  const inviteRef = database.ref(`invites/${normalizedInviteId}`);
  const queueRef = database.ref(`automatch/${normalizedInviteId}`);
  const readState = async () => {
    const [inviteSnapshot, queueSnapshot] = await Promise.all([
      readWithRetries(() => inviteRef.once("value")),
      readWithRetries(() => queueRef.once("value")),
    ]);
    if (!inviteSnapshot.exists()) {
      return null;
    }
    const inviteData = inviteSnapshot.val() || {};
    const nextHint = queueSnapshot.exists()
      ? "pending"
      : normalizeString(inviteData.guestId)
        ? "matched"
        : "canceled";
    const currentCanceledAt =
      typeof inviteData.automatchCanceledAt === "number"
        ? inviteData.automatchCanceledAt
        : null;
    const markerMatches =
      normalizeString(inviteData.automatchStateHint) === nextHint &&
      (nextHint === "canceled"
        ? currentCanceledAt !== null
        : currentCanceledAt === null);
    return { currentCanceledAt, markerMatches, nextHint };
  };

  let updated = false;
  for (
    let attempt = 0;
    attempt < AUTOMATCH_MARKER_RECONCILE_ATTEMPTS;
    attempt += 1
  ) {
    const state = await readState();
    if (!state) {
      return { ok: true, updated, reason: "missing-invite" };
    }
    if (state.markerMatches) {
      return {
        ok: true,
        updated,
        reason: updated ? "marker-reconciled" : "marker-unchanged",
        inviteId: normalizedInviteId,
        automatchStateHint: state.nextHint,
        automatchCanceledAt: state.currentCanceledAt,
      };
    }
    const nextCanceledAt = state.nextHint === "canceled" ? Date.now() : null;
    await inviteRef.update({
      automatchStateHint: state.nextHint,
      automatchCanceledAt: nextCanceledAt,
    });
    updated = true;
  }
  throw new Error("projector:automatch-marker-reconcile-exhausted");
}

const hasMeaningfulValueChange = (before, after) => {
  if (before === after) {
    return false;
  }
  return true;
};

const processWithConcurrency = async (
  items,
  concurrency,
  worker,
  shouldContinue,
) => {
  if (items.length === 0) {
    return;
  }
  let index = 0;
  let didFail = false;
  let failure = null;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      try {
        if (didFail || (shouldContinue && !shouldContinue())) {
          return;
        }
        const currentIndex = index;
        index += 1;
        if (currentIndex >= items.length) {
          return;
        }
        await worker(items[currentIndex], currentIndex);
      } catch (error) {
        if (!didFail) {
          didFail = true;
          failure = error;
        }
        return;
      }
    }
  });
  await Promise.all(runners);
  if (didFail) {
    throw failure;
  }
};

const readNumericMillis = (value) => {
  const fromTimestamp = readTimestampMillis(value);
  if (Number.isFinite(fromTimestamp)) {
    return fromTimestamp;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
};

const hasRecentMergeMarkerForSource = (targetData, staleProfileId) => {
  const mergedSourceProfileId = normalizeString(
    targetData && targetData.mergedSourceProfileId,
  );
  if (!mergedSourceProfileId || mergedSourceProfileId !== staleProfileId) {
    return false;
  }
  const mergedAtMs = readNumericMillis(targetData && targetData.mergedAtMs);
  if (!Number.isFinite(mergedAtMs)) {
    return false;
  }
  return Date.now() - mergedAtMs <= PROFILE_LINK_STALE_CLEANUP_MERGE_WINDOW_MS;
};

const waitForProfileDeletion = async (profileRef) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= PROFILE_LINK_STALE_CLEANUP_WAIT_MAX_MS) {
    const snapshot = await profileRef.get();
    if (!snapshot.exists) {
      return true;
    }
    await delay(PROFILE_LINK_STALE_CLEANUP_WAIT_STEP_MS);
  }
  const finalSnapshot = await profileRef.get();
  return !finalSnapshot.exists;
};

const deleteProfileGamesProjectionDocs = async (profileRef) => {
  const startedAt = Date.now();
  let deleted = 0;
  while (Date.now() - startedAt <= PROFILE_DELETE_GAMES_CLEANUP_TIMEOUT_MS) {
    const snapshot = await profileRef
      .collection("games")
      .limit(PROFILE_DELETE_GAMES_CLEANUP_BATCH_SIZE)
      .get();
    if (snapshot.empty) {
      return { deleted, complete: true };
    }
    const batch = profileRef.firestore.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    deleted += snapshot.size;
  }
  const remainingSnapshot = await profileRef.collection("games").limit(1).get();
  return {
    deleted,
    complete: remainingSnapshot.empty,
  };
};

const classifyProfileGameProjection = (docId, data = {}) => {
  const normalizedDocId = normalizeString(docId);
  const storedEventId = normalizeString(data.eventId);
  const isEvent =
    data.entityType === "event" ||
    data.source === "event-projector" ||
    !!storedEventId ||
    (normalizedDocId && normalizedDocId.startsWith("event_"));
  if (isEvent) {
    const eventId =
      storedEventId ||
      (normalizedDocId && normalizedDocId.startsWith("event_")
        ? normalizedDocId.slice("event_".length)
        : null);
    return eventId ? { entityType: "event", id: eventId } : null;
  }
  const inviteId = normalizeString(data.inviteId) || normalizedDocId;
  return inviteId ? { entityType: "game", id: inviteId } : null;
};

const reconcileProfileMergeProjections = async (
  { dryRun = false, sourceProfileId, targetProfileId },
  dependencies = {},
) => {
  const normalizedSourceProfileId = normalizeString(sourceProfileId);
  const normalizedTargetProfileId = normalizeString(targetProfileId);
  if (
    !normalizedSourceProfileId ||
    !normalizedTargetProfileId ||
    normalizedSourceProfileId === normalizedTargetProfileId
  ) {
    throw new Error("profile-merge-reconcile-invalid-target");
  }
  const firestore = dependencies.firestore || admin.firestore();
  const profileIds = await resolveProfileMergeTargetPath({
    profileId: normalizedSourceProfileId,
    readMergeTarget: (profileId) => readMergeTarget(firestore, profileId),
  });
  if (profileIds[1] !== normalizedTargetProfileId) {
    throw new Error("profile-merge-reconcile-target-mismatch");
  }
  const requestedPageSize = Math.floor(Number(dependencies.pageSize));
  const pageSize =
    Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0
      ? Math.min(requestedPageSize, PROFILE_MERGE_RECONCILE_PAGE_SIZE)
      : PROFILE_MERGE_RECONCILE_PAGE_SIZE;
  const database = dependencies.database;
  const eventProjectorImpl = require("./eventProjector");
  const projectEventImpl =
    dependencies.projectEvent || eventProjectorImpl.projectEvent;
  const reconcileLiveEventProjectionImpl =
    dependencies.reconcileLiveEventProjection ||
    eventProjectorImpl.reconcileLiveEventProjection;
  const recomputeInviteProjectionImpl =
    dependencies.recomputeInviteProjection || recomputeInviteProjection;
  let scannedGameDocuments = 0;
  let projectionCount = 0;
  let pagesScanned = 0;
  const blockedProjections = new Map();
  const scannedProfileIds =
    dependencies.scannedProfileIds instanceof Set
      ? dependencies.scannedProfileIds
      : null;
  const projectionProfileIds = [
    profileIds[profileIds.length - 1],
    ...profileIds.slice(0, -1),
  ].filter(Boolean);
  for (const profileId of projectionProfileIds) {
    if (scannedProfileIds && scannedProfileIds.has(profileId)) {
      continue;
    }
    const games = firestore
      .collection("users")
      .doc(profileId)
      .collection("games");
    const terminalSnapshot = await games
      .orderBy(FieldPath.documentId(), "desc")
      .limit(1)
      .get();
    if (terminalSnapshot.empty) {
      scannedProfileIds?.add(profileId);
      continue;
    }
    let profileBlocked = false;
    const terminalId = terminalSnapshot.docs[0].id;
    let cursor = null;
    while (true) {
      let query = games
        .orderBy(FieldPath.documentId())
        .endAt(terminalId)
        .limit(pageSize);
      if (cursor) {
        query = query.startAfter(cursor);
      }
      const snapshot = await query.get();
      if (snapshot.empty) {
        break;
      }
      pagesScanned += 1;
      scannedGameDocuments += snapshot.size;
      const projections = new Map();
      for (const doc of snapshot.docs) {
        const projection = classifyProfileGameProjection(
          doc.id,
          doc.data() || {},
        );
        if (projection) {
          projections.set(
            `${projection.entityType}:${projection.id}`,
            projection,
          );
        }
      }
      projectionCount += projections.size;
      await processWithConcurrency(
        Array.from(projections.values()),
        PROFILE_MERGE_RECONCILE_CONCURRENCY,
        async (projection) => {
          if (projection.entityType === "event") {
            await reconcileLiveEventProjectionImpl(
              projection.id,
              null,
              null,
              { cleanupProfileIds: profileIds, dryRun },
              {
                projectEvent: projectEventImpl,
                readLiveEvent: async () => {
                  const eventSnapshot = await (database || admin.database())
                    .ref(`events/${projection.id}`)
                    .once("value");
                  return eventSnapshot.exists() ? eventSnapshot.val() : null;
                },
              },
            );
            return;
          }
          const result = await recomputeInviteProjectionImpl(
            projection.id,
            "profile-merge-reconciliation",
            {
              cleanupProfileIds: profileIds,
              dryRun,
              eventTimestampMs: Date.now(),
              preserveNewerListSortAt: true,
            },
          );
          if (result && result.sourceCleanupSafe === false) {
            profileBlocked = true;
            const blockedProjection = {
              entityType: projection.entityType,
              id: projection.id,
              reason: result.blockedReason || "source-cleanup-unsafe",
            };
            blockedProjections.set(
              `${projection.entityType}:${projection.id}`,
              blockedProjection,
            );
          }
        },
      );
      cursor = snapshot.docs[snapshot.docs.length - 1].id;
      if (snapshot.size < pageSize) {
        break;
      }
    }
    if (!profileBlocked) {
      scannedProfileIds?.add(profileId);
    }
  }
  return {
    complete: blockedProjections.size === 0,
    blockedProjections: Array.from(blockedProjections.values()),
    dryRun: dryRun === true,
    pagesScanned,
    profileIds,
    projectionCount,
    scannedGameDocuments,
  };
};

const onInviteCreated = onValueCreated(
  { ref: "/invites/{inviteId}", retry: true },
  async (event) => {
    const inviteId = event.params.inviteId;
    await recomputeInviteProjection(inviteId, "invite-created", {
      eventTimestampMs: Date.now(),
    });
  },
);

const onInviteGuestIdChanged = onValueWritten(
  { ref: "/invites/{inviteId}/guestId", retry: true },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    if (!hasMeaningfulValueChange(before, after)) {
      return;
    }
    await recomputeInviteProjection(event.params.inviteId, "invite-guest-id", {
      eventTimestampMs: Date.now(),
    });
  },
);

const onInviteHostRematchesChanged = onValueWritten(
  { ref: "/invites/{inviteId}/hostRematches", retry: true },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    if (!hasMeaningfulValueChange(before, after)) {
      return;
    }
    await recomputeInviteProjection(
      event.params.inviteId,
      "invite-host-rematches",
      {
        eventTimestampMs: Date.now(),
      },
    );
  },
);

const onInviteGuestRematchesChanged = onValueWritten(
  { ref: "/invites/{inviteId}/guestRematches", retry: true },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();
    if (!hasMeaningfulValueChange(before, after)) {
      return;
    }
    await recomputeInviteProjection(
      event.params.inviteId,
      "invite-guest-rematches",
      {
        eventTimestampMs: Date.now(),
      },
    );
  },
);

const onMatchCreated = onValueCreated(
  { ref: "/players/{loginUid}/matches/{matchId}", retry: true },
  async (event) => {
    const matchId = normalizeString(event.params.matchId);
    if (!matchId) {
      return;
    }

    const inviteId = await resolveInviteIdFromMatchId(matchId);
    if (!inviteId) {
      console.log("projector:match-created:invite-unresolved", {
        loginUid: event.params.loginUid,
        matchId,
      });
      return;
    }

    await recomputeInviteProjection(inviteId, "match-created", {
      eventTimestampMs: Date.now(),
      latestMatchIdHint: matchId,
    });
  },
);

const onInviteMatchRatingUpdated = onValueCreated(
  {
    ref: "/invites/{inviteId}/matchesRatingUpdates/{matchId}",
    retry: true,
  },
  async (event) => {
    const matchId = normalizeString(event.params.matchId);
    if (!matchId) {
      return;
    }
    await recomputeInviteProjection(
      event.params.inviteId,
      "invite-match-rating-updated",
      {
        eventTimestampMs: Date.now(),
        latestMatchIdHint: matchId,
      },
    );
  },
);

const onAutomatchQueueWritten = onValueWritten(
  { ref: "/automatch/{inviteId}", retry: true },
  async (event) => {
    const inviteId = event.params.inviteId;
    const beforeExists = event.data.before.exists();
    const afterExists = event.data.after.exists();
    const beforeVal = beforeExists ? event.data.before.val() : null;
    const afterVal = afterExists ? event.data.after.val() : null;

    if (
      beforeExists === afterExists &&
      JSON.stringify(beforeVal) === JSON.stringify(afterVal)
    ) {
      return;
    }

    await syncAutomatchInviteMarkerFromQueue(inviteId);
    await recomputeInviteProjection(inviteId, "automatch-queue", {
      eventTimestampMs: Date.now(),
    });
  },
);

const processProfileLinkCatchup = async (
  { loginUid, profileId: eventProfileId, staleProfileId = null, eventLabel },
  dependencies = {},
) => {
  const startedAt = Date.now();
  const shouldContinue = () =>
    Date.now() - startedAt < PROFILE_LINK_CATCHUP_TIMEOUT_MS;
  const readProfileLink =
    dependencies.readCurrentProfileLink || readCurrentProfileLink;
  const recomputeInviteProjectionImpl =
    dependencies.recomputeInviteProjection || recomputeInviteProjection;
  const resolveInviteIdImpl =
    dependencies.resolveInviteIdFromMatchId || resolveInviteIdFromMatchId;
  const state = await resolveProfileLinkCatchupState(
    {
      eventProfileId,
      loginUid,
      staleProfileId,
    },
    {
      readCurrentProfileLink: readProfileLink,
    },
  );
  if (!state) {
    return;
  }
  const observedProfileIds = new Set(state.cleanupProfileIds);
  let profileId = state.profileId;

  const matchesSnapshot = dependencies.readMatches
    ? await dependencies.readMatches(loginUid)
    : await readWithRetries(() =>
        admin.database().ref(`players/${loginUid}/matches`).once("value"),
      );
  if (!matchesSnapshot.exists()) {
    return;
  }

  const matches = matchesSnapshot.val() || {};
  const matchIds = Object.keys(matches);
  const inviteExistenceCache = new Map();
  const inviteIds = [];
  const inviteSet = new Set();

  for (const matchId of matchIds) {
    if (!shouldContinue()) {
      break;
    }
    if (inviteIds.length >= PROFILE_LINK_CATCHUP_MAX_INVITES) {
      break;
    }
    const inviteId = await resolveInviteIdImpl(matchId, {
      inviteExistenceCache,
    });
    if (!inviteId || inviteSet.has(inviteId)) {
      continue;
    }
    inviteSet.add(inviteId);
    inviteIds.push(inviteId);
  }

  let processed = 0;
  let failed = 0;
  let didConverge = false;
  let convergenceAttempts = 0;
  let successfullyRecomputedInviteIds = new Set();
  for (
    let attempt = 0;
    attempt < PROFILE_LINK_RECONCILE_ATTEMPTS;
    attempt += 1
  ) {
    convergenceAttempts = attempt + 1;
    observedProfileIds.add(profileId);
    const cleanupProfileIds = Array.from(observedProfileIds);
    let attemptedThisRound = 0;
    let roundProcessed = 0;
    let roundFailed = 0;
    const roundSuccessfulInviteIds = new Set();
    await processWithConcurrency(
      inviteIds,
      PROFILE_LINK_CATCHUP_CONCURRENCY,
      async (inviteId) => {
        if (!shouldContinue()) {
          return;
        }
        attemptedThisRound += 1;
        try {
          const result = await recomputeInviteProjectionImpl(
            inviteId,
            "profile-link-catchup",
            {
              cleanupProfileIds,
              eventTimestampMs: Date.now(),
              preserveNewerListSortAt: true,
            },
          );
          if (result && result.sourceCleanupSafe === false) {
            throw new Error(
              `projector:profile-link-catchup-blocked:${result.blockedReason || "source-cleanup-unsafe"}`,
            );
          }
          roundSuccessfulInviteIds.add(inviteId);
          roundProcessed += 1;
        } catch (error) {
          roundFailed += 1;
          console.error("projector:profile-link-catchup:recompute-failed", {
            loginUid,
            profileId,
            inviteId,
            error: error && error.message ? error.message : error,
          });
        }
      },
      shouldContinue,
    );
    processed = roundProcessed;
    failed = roundFailed;
    successfullyRecomputedInviteIds = roundSuccessfulInviteIds;
    if (attemptedThisRound !== inviteIds.length) {
      break;
    }
    const nextProfileId = await readProfileLink(loginUid);
    if (nextProfileId === profileId) {
      didConverge = true;
      break;
    }
    if (!nextProfileId) {
      break;
    }
    profileId = nextProfileId;
  }

  const didTimeout = !shouldContinue();
  const didHitInviteCap = inviteIds.length >= PROFILE_LINK_CATCHUP_MAX_INVITES;

  let staleCleanupDeleted = 0;
  let staleCleanupState = "skipped";
  if (didConverge && staleProfileId && staleProfileId !== profileId) {
    const firestore = admin.firestore();
    const targetRef = firestore.collection("users").doc(profileId);
    const staleRef = firestore.collection("users").doc(staleProfileId);
    const targetSnapshot = await targetRef.get();
    if (!targetSnapshot.exists) {
      staleCleanupState = "target-profile-missing";
    } else if (
      !hasRecentMergeMarkerForSource(
        targetSnapshot.data() || {},
        staleProfileId,
      )
    ) {
      staleCleanupState = "merge-marker-mismatch";
    } else if (successfullyRecomputedInviteIds.size === 0) {
      staleCleanupState = "no-successful-recomputes";
    } else {
      const staleProfileDeleted = await waitForProfileDeletion(staleRef);
      if (!staleProfileDeleted) {
        staleCleanupState = "stale-profile-still-exists";
      } else {
        staleCleanupState = "done";
        const deleteOps = Array.from(successfullyRecomputedInviteIds).map(
          (inviteId) => ({
            type: "delete",
            ref: firestore
              .collection("users")
              .doc(staleProfileId)
              .collection("games")
              .doc(inviteId),
          }),
        );
        while (deleteOps.length > 0) {
          const batch = firestore.batch();
          const chunk = deleteOps.splice(0, 400);
          chunk.forEach((op) => {
            batch.delete(op.ref);
          });
          await batch.commit();
          staleCleanupDeleted += chunk.length;
        }
      }
    }
  }

  console.log("projector:profile-link-catchup:done", {
    event: eventLabel,
    loginUid,
    profileId,
    eventProfileId,
    staleProfileId: staleProfileId || null,
    matchIdsScanned: matchIds.length,
    inviteIdsResolved: inviteIds.length,
    processed,
    failed,
    staleCleanupDeleted,
    staleCleanupState,
    didTimeout,
    didHitInviteCap,
    didConverge,
    convergenceAttempts,
    elapsedMs: Date.now() - startedAt,
  });
  if (failed > 0) {
    throw new Error("projector:profile-link-catchup-incomplete");
  }
  if (!didConverge) {
    throw new Error("projector:profile-link-catchup-profile-changed");
  }
};

const onProfileLinkCreated = onValueCreated(
  { ref: "/players/{loginUid}/profile", retry: true },
  async (event) => {
    const loginUid = normalizeString(event.params.loginUid);
    const profileId = normalizeString(event.data.val());
    if (!loginUid || !profileId) {
      return;
    }
    await processProfileLinkCatchup({
      loginUid,
      profileId,
      staleProfileId: null,
      eventLabel: "created",
    });
  },
);

const onProfileLinkWritten = onValueWritten(
  { ref: "/players/{loginUid}/profile", retry: true },
  async (event) => {
    if (!event.data.before.exists()) {
      return;
    }
    const loginUid = normalizeString(event.params.loginUid);
    const beforeProfileId = normalizeString(event.data.before.val());
    const afterProfileId = normalizeString(event.data.after.val());
    if (!loginUid || !afterProfileId || afterProfileId === beforeProfileId) {
      return;
    }
    await processProfileLinkCatchup({
      loginUid,
      profileId: afterProfileId,
      staleProfileId: beforeProfileId || null,
      eventLabel: "written",
    });
  },
);

const onProfileDeleted = onDocumentDeleted(
  {
    document: "users/{profileId}",
    retry: true,
  },
  async (event) => {
    const profileId = normalizeString(event.params.profileId);
    if (!profileId) {
      return;
    }
    const profileRef = admin.firestore().collection("users").doc(profileId);
    const cleanup = await deleteProfileGamesProjectionDocs(profileRef);
    console.log("projector:profile-delete-games-cleanup:done", {
      profileId,
      deleted: cleanup.deleted,
      complete: cleanup.complete,
    });
    if (!cleanup.complete) {
      throw new Error(
        `projector:profile-delete-games-cleanup-incomplete:${profileId}`,
      );
    }
  },
);

module.exports = {
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  classifyProfileGameProjection,
  onInviteCreated,
  onInviteGuestIdChanged,
  onInviteHostRematchesChanged,
  onInviteGuestRematchesChanged,
  onMatchCreated,
  onInviteMatchRatingUpdated,
  onAutomatchQueueWritten,
  onProfileLinkCreated,
  onProfileLinkWritten,
  onProfileDeleted,
  processProfileLinkCatchup,
  processWithConcurrency,
  readInviteExists,
  readExistingProjectionDocuments,
  reconcileProfileMergeProjections,
  recomputeInviteProjection,
  resolveProfileLinkCatchupState,
  syncAutomatchInviteMarkerFromQueue,
};
