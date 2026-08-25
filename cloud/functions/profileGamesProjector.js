const admin = require("./firebaseAdmin");
const {
  onValueCreated,
  onValueWritten,
} = require("firebase-functions/v2/database");
const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
const {
  PROFILE_MERGE_TARGETS_COLLECTION,
  resolveProfileMergeTargetPath,
} = require("./profileMergeTargets");
const { createInviteCandidatesFromMatchId } = require("@mons/shared/rematches");
const {
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  readExistingProjectionDocuments,
  recomputeInviteProjection,
} = require("./profileGamesProjectionFirebase");
const { normalizeString } = require("./events/gameProjectionModel");

const PROFILE_LINK_CATCHUP_MAX_INVITES = 300;
const PROFILE_LINK_CATCHUP_CONCURRENCY = 20;
const PROFILE_LINK_CATCHUP_TIMEOUT_MS = 50000;
const PROFILE_DELETE_GAMES_CLEANUP_BATCH_SIZE = 400;
const PROFILE_DELETE_GAMES_CLEANUP_TIMEOUT_MS = 50000;
const AUTOMATCH_MARKER_RECONCILE_ATTEMPTS = 3;
const PROFILE_LINK_RECONCILE_ATTEMPTS = 3;

const READ_RETRY_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 25;

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

const readMergeTarget = async (firestore, profileId) => {
  const snapshot = await readWithRetries(() =>
    firestore.collection(PROFILE_MERGE_TARGETS_COLLECTION).doc(profileId).get(),
  );
  return snapshot.exists ? snapshot.data() : null;
};

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
              preserveListSortAt: true,
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
    const firestore = dependencies.firestore || admin.firestore();
    const staleRef = firestore.collection("users").doc(staleProfileId);
    const mergePath = await resolveProfileMergeTargetPath({
      profileId: staleProfileId,
      readMergeTarget: (candidateProfileId) =>
        readMergeTarget(firestore, candidateProfileId),
    });
    if (mergePath.length < 2 || mergePath[mergePath.length - 1] !== profileId) {
      staleCleanupState = "merge-target-mismatch";
    } else if (successfullyRecomputedInviteIds.size === 0) {
      staleCleanupState = "no-successful-recomputes";
    } else {
      const staleSnapshot = await staleRef.get();
      if (staleSnapshot.exists) {
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
    const deletedProfile = event.data?.data?.() || {};
    if (normalizeString(deletedProfile.mergedIntoProfileId)) {
      console.log("projector:profile-delete-games-cleanup:recovery-owned", {
        profileId,
      });
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
  onInviteCreated,
  onInviteGuestIdChanged,
  onInviteHostRematchesChanged,
  onInviteGuestRematchesChanged,
  onMatchCreated,
  onAutomatchQueueWritten,
  onProfileLinkCreated,
  onProfileLinkWritten,
  onProfileDeleted,
  processProfileLinkCatchup,
  processWithConcurrency,
  readInviteExists,
  readExistingProjectionDocuments,
  recomputeInviteProjection,
  resolveProfileLinkCatchupState,
  syncAutomatchInviteMarkerFromQueue,
};
