const admin = require("./firebaseAdmin");
const { randomUUID } = require("node:crypto");
const {
  onValueCreated,
  onValueWritten,
} = require("firebase-functions/v2/database");
const { createInviteCandidatesFromMatchId } = require("@mons/shared/rematches");
const {
  buildInviteProjectionOwnerPlan,
  buildResolvedProfile,
  readExistingProjectionDocuments,
  recomputeInviteProjection,
} = require("./profileGamesProjectionFirebase");
const { normalizeString } = require("./events/gameProjectionModel");

const AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_MS = 15 * 60 * 1000;
const AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_ROOT =
  "profileGameProjectionLocks/automatch";

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

const withInviteProjectionLock = async (inviteId, work, dependencies = {}) => {
  const normalizedInviteId = normalizeString(inviteId);
  if (!normalizedInviteId) {
    throw new Error("projector:invalid-invite-id");
  }
  const ownerId = (dependencies.createOwnerId || randomUUID)();
  const nowMs = (dependencies.now || Date.now)();
  const lockRef = dependencies.lockRef
    ? dependencies.lockRef(normalizedInviteId)
    : admin
        .database()
        .ref(
          `${AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_ROOT}/${normalizedInviteId}`,
        );
  const acquired = await lockRef.transaction(
    (current) => {
      const expiresAtMs = current?.expiresAtMs;
      if (
        typeof current?.ownerId === "string" &&
        typeof expiresAtMs === "number" &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs > nowMs
      ) {
        return undefined;
      }
      return {
        ownerId,
        expiresAtMs: nowMs + AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_MS,
      };
    },
    undefined,
    false,
  );
  if (!acquired.committed) {
    throw new Error("projector:profile-game-projection-lock-busy");
  }
  try {
    return await work();
  } finally {
    await lockRef.transaction(
      (current) => (current?.ownerId === ownerId ? null : undefined),
      undefined,
      false,
    );
  }
};

const hasMeaningfulValueChange = (before, after) => {
  if (before === after) {
    return false;
  }
  return true;
};

const onInviteCreated = onValueCreated(
  { ref: "/invites/{inviteId}", retry: true },
  async (event) => {
    const inviteId = event.params.inviteId;
    await withInviteProjectionLock(inviteId, () =>
      recomputeInviteProjection(inviteId, "invite-created", {
        eventTimestampMs: Date.now(),
      }),
    );
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
    await withInviteProjectionLock(event.params.inviteId, () =>
      recomputeInviteProjection(event.params.inviteId, "invite-guest-id", {
        eventTimestampMs: Date.now(),
      }),
    );
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
    await withInviteProjectionLock(event.params.inviteId, () =>
      recomputeInviteProjection(
        event.params.inviteId,
        "invite-host-rematches",
        {
          eventTimestampMs: Date.now(),
        },
      ),
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
    await withInviteProjectionLock(event.params.inviteId, () =>
      recomputeInviteProjection(
        event.params.inviteId,
        "invite-guest-rematches",
        {
          eventTimestampMs: Date.now(),
        },
      ),
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

    await withInviteProjectionLock(inviteId, () =>
      recomputeInviteProjection(inviteId, "match-created", {
        eventTimestampMs: Date.now(),
        latestMatchIdHint: matchId,
      }),
    );
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
  readInviteExists,
  readExistingProjectionDocuments,
  recomputeInviteProjection,
  withInviteProjectionLock,
};
