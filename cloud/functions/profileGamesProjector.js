const admin = require("./firebaseAdmin");
const {
  onValueCreated,
  onValueWritten,
} = require("firebase-functions/v2/database");
const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
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

const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 25;

const loginToProfileCache = new Map();
const profileSummaryCache = new Map();

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
    for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const matchSnapshot = await admin
          .database()
          .ref(`players/${normalizedLoginUid}/matches/${candidateMatchId}`)
          .once("value");
        if (!matchSnapshot.exists()) {
          break;
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
        break;
      } catch (error) {
        if (attempt >= READ_RETRY_ATTEMPTS) {
          console.error("projector:login-summary-rtdb-read-failed", {
            loginUid: normalizedLoginUid,
            matchId: candidateMatchId,
            attempts: attempt,
            error: error && error.message ? error.message : error,
          });
          break;
        }
        await delay(READ_RETRY_DELAY_MS);
      }
    }
  }

  cache.set(cacheKey, null);
  return null;
}

const readInviteExists = async (inviteId, inviteExistenceCache) => {
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
  const promise = admin
    .database()
    .ref(`invites/${inviteId}`)
    .once("value")
    .then((snapshot) => snapshot.exists())
    .catch((error) => {
      console.error("projector:invite-exists-read-failed", {
        inviteId,
        error: error && error.message ? error.message : error,
      });
      return false;
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

async function resolveProfileIdForLogin(loginUid) {
  const normalizedLoginUid = normalizeString(loginUid);
  if (!normalizedLoginUid) {
    return null;
  }

  if (loginToProfileCache.has(normalizedLoginUid)) {
    const cachedProfileId = loginToProfileCache.get(normalizedLoginUid);
    if (cachedProfileId) {
      return cachedProfileId;
    }
    loginToProfileCache.delete(normalizedLoginUid);
  }

  let profileId = null;

  try {
    const profileSnapshot = await admin
      .database()
      .ref(`players/${normalizedLoginUid}/profile`)
      .once("value");
    const profileValue = normalizeString(profileSnapshot.val());
    if (profileValue) {
      profileId = profileValue;
    }
  } catch (error) {
    console.error("projector:profile-resolve:rtdb-read-failed", {
      loginUid: normalizedLoginUid,
      error: error && error.message ? error.message : error,
    });
  }

  if (!profileId) {
    try {
      const usersSnapshot = await admin
        .firestore()
        .collection("users")
        .where("logins", "array-contains", normalizedLoginUid)
        .limit(1)
        .get();
      if (!usersSnapshot.empty) {
        profileId = usersSnapshot.docs[0].id;
      }
    } catch (error) {
      console.error("projector:profile-resolve:firestore-read-failed", {
        loginUid: normalizedLoginUid,
        error: error && error.message ? error.message : error,
      });
    }
  }

  if (profileId) {
    loginToProfileCache.set(normalizedLoginUid, profileId);
  }
  return profileId;
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
  for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const profileDoc = await admin
        .firestore()
        .collection("users")
        .doc(normalizedProfileId)
        .get();
      if (profileDoc.exists) {
        const profileData = profileDoc.data() || {};
        summary = {
          name: getProfileDisplayName(profileData),
          emoji: getProfileEmoji(profileData),
        };
      }
      break;
    } catch (error) {
      if (attempt >= READ_RETRY_ATTEMPTS) {
        console.error("projector:profile-summary-read-failed", {
          profileId: normalizedProfileId,
          attempts: attempt,
          error: error && error.message ? error.message : error,
        });
        break;
      }
      await delay(READ_RETRY_DELAY_MS);
    }
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
    };
  }

  const nowMs = readEventTimestampMs(options);
  const db = admin.database();
  const firestore = admin.firestore();

  const [inviteSnapshot, automatchSnapshot] = await Promise.all([
    db.ref(`invites/${normalizedInviteId}`).once("value"),
    db.ref(`automatch/${normalizedInviteId}`).once("value"),
  ]);

  const inviteData = inviteSnapshot.exists() ? inviteSnapshot.val() : null;
  const automatchData = automatchSnapshot.exists()
    ? automatchSnapshot.val()
    : null;

  const hostLoginId = normalizeString(inviteData ? inviteData.hostId : null);
  const guestLoginId = normalizeString(inviteData ? inviteData.guestId : null);

  const [hostProfileId, guestProfileId] = await Promise.all([
    resolveProfileIdForLogin(hostLoginId),
    resolveProfileIdForLogin(guestLoginId),
  ]);

  const ownerProfileIds = getOwnerProfileIds(hostProfileId, guestProfileId);

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
  const existingDocs = [];
  await Promise.all(
    ownerProfileIds.map(async (ownerProfileId) => {
      try {
        const ownerDocSnapshot = await firestore
          .collection("users")
          .doc(ownerProfileId)
          .collection("games")
          .doc(normalizedInviteId)
          .get();
        if (!ownerDocSnapshot.exists) {
          return;
        }
        existingDocsByOwnerProfileId.set(ownerProfileId, ownerDocSnapshot);
        existingDocs.push({ ownerProfileId, docSnapshot: ownerDocSnapshot });
      } catch (error) {
        console.error("projector:existing-doc-read-failed", {
          inviteId: normalizedInviteId,
          ownerProfileId,
          reason,
          error: error && error.message ? error.message : error,
        });
      }
    }),
  );

  const ownerSet = new Set(ownerProfileIds);
  const canPruneOwners =
    (!hostLoginId || !!hostProfileId) && (!guestLoginId || !!guestProfileId);
  const batch = firestore.batch();

  let setCount = 0;
  let deleteCount = 0;
  let skippedCount = 0;

  for (const existing of existingDocs) {
    if (
      !shouldProject ||
      (canPruneOwners && !ownerSet.has(existing.ownerProfileId))
    ) {
      batch.delete(existing.docSnapshot.ref);
      deleteCount += 1;
    }
  }

  if (!shouldProject || ownerProfileIds.length === 0) {
    if (!options.dryRun && deleteCount > 0) {
      await batch.commit();
    }
    return {
      ok: true,
      inviteId: normalizedInviteId,
      reason,
      shouldProject,
      ownerProfileIds,
      canPruneOwners,
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

    const opponentProfileSummary = ownerContext.opponentProfileId
      ? await readProfileSummary(ownerContext.opponentProfileId)
      : null;
    const opponentName =
      opponentProfileSummary && typeof opponentProfileSummary.name === "string"
        ? opponentProfileSummary.name
        : null;
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
    const opponentEmoji =
      opponentEmojiFromProfile !== null
        ? opponentEmojiFromProfile
        : opponentEmojiFromLogin !== null
          ? opponentEmojiFromLogin
          : existingOpponentEmoji;

    const requiresResolvedOpponentEmoji =
      status === "active" || status === "ended";
    if (requiresResolvedOpponentEmoji && opponentEmoji === null) {
      if (existingDocSnapshot) {
        batch.delete(ownerDocRef);
        deleteCount += 1;
      } else {
        skippedCount += 1;
      }
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

    const existingListSortMs = existingDocData
      ? readTimestampMillis(existingDocData.listSortAt)
      : null;
    const nextListSortMs = pickListSortMillis({
      options,
      status,
      automatchData,
      nowMs,
      existingListSortMs,
    });

    const existingCreatedAt = existingDocData
      ? existingDocData.createdAt
      : null;
    const existingEndedAt = existingDocData ? existingDocData.endedAt : null;

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

  if (!options.dryRun && (setCount > 0 || deleteCount > 0)) {
    await batch.commit();
  }

  return {
    ok: true,
    inviteId: normalizedInviteId,
    reason,
    shouldProject,
    ownerProfileIds,
    canPruneOwners,
    writes: setCount,
    deletes: deleteCount,
    skipped: skippedCount,
    dryRun: options.dryRun === true,
  };
}

async function syncAutomatchInviteMarkerFromQueue(inviteId, queueExists) {
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId) {
    return { ok: false, updated: false, reason: "invalid-invite-id" };
  }

  const inviteSnapshot = await admin
    .database()
    .ref(`invites/${normalizedInviteId}`)
    .once("value");
  if (!inviteSnapshot.exists()) {
    return { ok: true, updated: false, reason: "missing-invite" };
  }

  const inviteData = inviteSnapshot.val() || {};
  const guestId = normalizeString(inviteData.guestId);
  const currentHint = normalizeString(inviteData.automatchStateHint);
  const currentCanceledAt =
    typeof inviteData.automatchCanceledAt === "number"
      ? inviteData.automatchCanceledAt
      : null;

  const nextHint = queueExists ? "pending" : guestId ? "matched" : "canceled";
  const nextCanceledAt = nextHint === "canceled" ? Date.now() : null;

  const canceledAtChanged =
    nextHint === "canceled"
      ? currentCanceledAt === null
      : currentCanceledAt !== null;
  const hintChanged = currentHint !== nextHint;

  if (!hintChanged && !canceledAtChanged) {
    return { ok: true, updated: false, reason: "marker-unchanged" };
  }

  const updates = {};
  updates[`invites/${normalizedInviteId}/automatchStateHint`] = nextHint;
  updates[`invites/${normalizedInviteId}/automatchCanceledAt`] = nextCanceledAt;

  await admin.database().ref().update(updates);

  return {
    ok: true,
    updated: true,
    inviteId: normalizedInviteId,
    automatchStateHint: nextHint,
    automatchCanceledAt: nextCanceledAt,
  };
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
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (shouldContinue && !shouldContinue()) {
        return;
      }
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) {
        return;
      }
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
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

const onInviteCreated = onValueCreated("/invites/{inviteId}", async (event) => {
  const inviteId = event.params.inviteId;
  await recomputeInviteProjection(inviteId, "invite-created", {
    eventTimestampMs: Date.now(),
  });
});

const onInviteGuestIdChanged = onValueWritten(
  "/invites/{inviteId}/guestId",
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
  "/invites/{inviteId}/hostRematches",
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
  "/invites/{inviteId}/guestRematches",
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
  "/players/{loginUid}/matches/{matchId}",
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
  "/invites/{inviteId}/matchesRatingUpdates/{matchId}",
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
  "/automatch/{inviteId}",
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

    await syncAutomatchInviteMarkerFromQueue(inviteId, afterExists);
    await recomputeInviteProjection(inviteId, "automatch-queue", {
      eventTimestampMs: Date.now(),
    });
  },
);

const processProfileLinkCatchup = async ({
  loginUid,
  profileId,
  staleProfileId = null,
  eventLabel,
}) => {
  const startedAt = Date.now();
  const shouldContinue = () =>
    Date.now() - startedAt < PROFILE_LINK_CATCHUP_TIMEOUT_MS;

  const matchesSnapshot = await admin
    .database()
    .ref(`players/${loginUid}/matches`)
    .once("value");
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
    const inviteId = await resolveInviteIdFromMatchId(matchId, {
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
  const successfullyRecomputedInviteIds = [];

  await processWithConcurrency(
    inviteIds,
    PROFILE_LINK_CATCHUP_CONCURRENCY,
    async (inviteId) => {
      if (!shouldContinue()) {
        return;
      }
      try {
        await recomputeInviteProjection(inviteId, "profile-link-catchup", {
          eventTimestampMs: Date.now(),
          preserveNewerListSortAt: true,
        });
        successfullyRecomputedInviteIds.push(inviteId);
        processed += 1;
      } catch (error) {
        failed += 1;
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

  const didTimeout = !shouldContinue();
  const didHitInviteCap = inviteIds.length >= PROFILE_LINK_CATCHUP_MAX_INVITES;

  let staleCleanupDeleted = 0;
  let staleCleanupState = "skipped";
  if (staleProfileId && staleProfileId !== profileId) {
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
    } else if (successfullyRecomputedInviteIds.length === 0) {
      staleCleanupState = "no-successful-recomputes";
    } else {
      const staleProfileDeleted = await waitForProfileDeletion(staleRef);
      if (!staleProfileDeleted) {
        staleCleanupState = "stale-profile-still-exists";
      } else {
        staleCleanupState = "done";
        const deleteOps = successfullyRecomputedInviteIds.map((inviteId) => ({
          type: "delete",
          ref: firestore
            .collection("users")
            .doc(staleProfileId)
            .collection("games")
            .doc(inviteId),
        }));
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
    staleProfileId: staleProfileId || null,
    matchIdsScanned: matchIds.length,
    inviteIdsResolved: inviteIds.length,
    processed,
    failed,
    staleCleanupDeleted,
    staleCleanupState,
    didTimeout,
    didHitInviteCap,
    elapsedMs: Date.now() - startedAt,
  });
};

const onProfileLinkCreated = onValueCreated(
  "/players/{loginUid}/profile",
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
  "/players/{loginUid}/profile",
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
};
