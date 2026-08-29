import {
  createGameplayRepository,
  createRatingRepository,
  type GameplayRepository,
  type RatingProfileGameProjectionRepository,
} from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT,
  EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT,
  PROFILE_LINK_PROFILE_GAME_PROJECTION_OUTBOX_ROOT,
  getAutomatchProfileGameProjectionLockPath,
  getAutomatchProfileGameProjectionOutboxPath,
  getEventProfileGameProjectionLockPath,
  getEventProfileGameProjectionOutboxPath,
  getProfileLinkProfileGameProjectionLockPath,
  getProfileLinkProfileGameProjectionOutboxPath,
  parseAutomatchProfileGameProjectionOutbox,
  parseEventProfileGameProjectionOutbox,
  parseProfileLinkProfileGameProjectionOutbox,
} from "./profileGameProjectionOutbox.ts";
import {
  createEventProfileGameProjectionRuntime,
  createProfileGameProjectionRuntime,
  type EventProfileGameProjectionRuntime,
  type ProfileGameProjectionRuntime,
} from "./profileGameProjectionRepository.ts";
import {
  parseProfileGameProjectionTask,
  PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
  type AutomatchProfileGameProjectionTask,
  type EventProfileGameProjectionTask,
  type ProfileLinkProfileGameProjectionTask,
  type ProfileGameProjectionTask,
} from "./profileGameProjectionTasks.ts";
import {
  createProfileLinkProjectionRuntime,
  type ProfileLinkProjectionSummary,
} from "./profileLinkProfileGameProjection.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";

const PROFILE_GAME_PROJECTION_SWEEP_LIMIT = PROFILE_BACKGROUND_SWEEP_LIMIT;
const PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY = 10;
const MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS = 60;
const PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS = 5 * 60 * 1_000;
const AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_MS = 15 * 60 * 1_000;
const PROFILE_GAME_PROJECTION_LOCK_RELEASE_ATTEMPTS = 3;

type ProfileGameProjectionLogger = Pick<Console, "error" | "info">;
type ProfileLinkProjectionResult = Pick<
  ProfileLinkProjectionSummary,
  "didHitInviteCap" | "nextMatchCursor"
>;
type ProfileGameProjectionRtdb = Pick<
  GameplayRepository,
  "getRtdbPath" | "transactRtdbPath"
>;

type ProfileGameProjectionLock = {
  path: string;
  requestId?: string;
};

export type ProfileGameProjectionDependencies = {
  createEventRuntime?: (env: Env) => EventProfileGameProjectionRuntime;
  createRating?: (env: Env) => RatingProfileGameProjectionRepository;
  createRtdb?: (env: Env) => ProfileGameProjectionRtdb;
  createRequestId?: () => string;
  createRuntime?: (env: Env) => ProfileGameProjectionRuntime;
  logger?: ProfileGameProjectionLogger;
  now?: () => number;
  processProfileLink?: (input: {
    cleanupProfileIds: string[];
    loginUid: string;
    matchCursor: string | null;
    profileId: string;
    sourceUpdatedAtMs: number;
    withInviteProjectionLock<T>(
      inviteId: string,
      work: () => Promise<T>,
    ): Promise<T>;
  }) => Promise<ProfileLinkProjectionResult | null>;
};

type AutomatchSweepCandidate = {
  lastQueuedAtMs: number;
  task: AutomatchProfileGameProjectionTask;
};

type AutomatchSweepEntry =
  | { kind: "candidate"; value: AutomatchSweepCandidate }
  | { inviteId: string; kind: "invalid" };

type EventSweepCandidate = {
  lastQueuedAtMs: number;
  task: EventProfileGameProjectionTask;
};

type EventSweepEntry =
  | { kind: "candidate"; value: EventSweepCandidate }
  | { eventId: string; kind: "invalid" };

type ProfileLinkSweepCandidate = {
  lastQueuedAtMs: number;
  task: ProfileLinkProfileGameProjectionTask;
};

type ProfileLinkSweepEntry =
  | { kind: "candidate"; value: ProfileLinkSweepCandidate }
  | { kind: "invalid"; loginUid: string };

export type ProfileGameProjectionSweepResult = {
  automatch: number;
  event: number;
  profile: number;
  rating: number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validRatingProjectionRecord(
  operationId: string,
  update: Awaited<
    ReturnType<RatingProfileGameProjectionRepository["readRatingUpdate"]>
  >,
): update is NonNullable<typeof update> {
  return Boolean(
    update &&
    update.profileGameProjectionVersion ===
      PROFILE_GAME_PROJECTION_SCHEMA_VERSION &&
    Number.isSafeInteger(update.completedAtMs) &&
    (update.completedAtMs || 0) > 0 &&
    isSafeFirebaseKey(update.inviteId) &&
    isSafeFirebaseKey(update.matchId) &&
    operationId === `${update.inviteId}__${update.matchId}`,
  );
}

export function profileGameProjectionRetryDelaySeconds(
  attempts: number,
): number {
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  return Math.min(
    MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS,
    2 ** exponent,
  );
}

async function acquireProfileGameProjectionLock(
  lock: ProfileGameProjectionLock,
  ownerId: string,
  rtdb: ProfileGameProjectionRtdb,
  nowMs: number,
): Promise<void> {
  const value = {
    ownerId,
    ...(lock.requestId ? { requestId: lock.requestId } : {}),
    expiresAtMs: nowMs + AUTOMATCH_PROFILE_GAME_PROJECTION_LOCK_MS,
  };
  const result = await rtdb.transactRtdbPath(lock.path, (current) => {
    const record = toRecord(current);
    const expiresAtMs = record?.expiresAtMs;
    if (
      typeof record?.ownerId === "string" &&
      typeof expiresAtMs === "number" &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs > nowMs
    ) {
      return { commit: false, decision: "busy" };
    }
    return {
      value,
      decision: "acquired",
    };
  });
  if (!result.committed) {
    throw new Error("profile-game-projection-lock-busy");
  }
}

async function releaseProfileGameProjectionLock(
  lock: ProfileGameProjectionLock,
  ownerId: string,
  rtdb: ProfileGameProjectionRtdb,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < PROFILE_GAME_PROJECTION_LOCK_RELEASE_ATTEMPTS;
    attempt++
  ) {
    try {
      await rtdb.transactRtdbPath(lock.path, (current) =>
        toRecord(current)?.ownerId === ownerId
          ? { value: null, decision: "released" }
          : { commit: false, decision: "not-owner" },
      );
      return;
    } catch (error) {
      if (attempt === PROFILE_GAME_PROJECTION_LOCK_RELEASE_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
}

export async function settleAutomatchProfileGameProjectionOutbox(
  task: AutomatchProfileGameProjectionTask,
  rtdb: ProfileGameProjectionRtdb,
): Promise<boolean> {
  const result = await rtdb.transactRtdbPath(
    getAutomatchProfileGameProjectionOutboxPath(task.inviteId),
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

export async function processAutomatchProfileGameProjection(
  task: AutomatchProfileGameProjectionTask,
  rtdb: ProfileGameProjectionRtdb,
  runtime: ProfileGameProjectionRuntime,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
): Promise<"projected" | "stale" | "superseded"> {
  const lock = {
    path: getAutomatchProfileGameProjectionLockPath(task.inviteId),
    requestId: task.requestId,
  };
  await acquireProfileGameProjectionLock(lock, ownerId, rtdb, now());
  try {
    const outbox = parseAutomatchProfileGameProjectionOutbox(
      await rtdb.getRtdbPath(
        getAutomatchProfileGameProjectionOutboxPath(task.inviteId),
      ),
    );
    if (!outbox || outbox.requestId !== task.requestId) {
      return "stale";
    }
    await runtime.recomputeInviteProjection(task.inviteId, outbox.reason, {
      eventTimestampMs: outbox.sourceUpdatedAtMs,
    });
    return (await settleAutomatchProfileGameProjectionOutbox(task, rtdb))
      ? "projected"
      : "superseded";
  } finally {
    await releaseProfileGameProjectionLock(lock, ownerId, rtdb);
  }
}

export async function settleEventProfileGameProjectionOutbox(
  task: EventProfileGameProjectionTask,
  rtdb: ProfileGameProjectionRtdb,
): Promise<boolean> {
  const result = await rtdb.transactRtdbPath(
    getEventProfileGameProjectionOutboxPath(task.eventId),
    (current) => {
      const outbox = parseEventProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

export async function processEventProfileGameProjection(
  task: EventProfileGameProjectionTask,
  rtdb: ProfileGameProjectionRtdb,
  runtime: EventProfileGameProjectionRuntime,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
): Promise<"missing" | "projected" | "stale" | "superseded"> {
  const initialOutbox = parseEventProfileGameProjectionOutbox(
    await rtdb.getRtdbPath(
      getEventProfileGameProjectionOutboxPath(task.eventId),
    ),
  );
  if (!initialOutbox || initialOutbox.requestId !== task.requestId) {
    return "stale";
  }
  const lock = {
    path: getEventProfileGameProjectionLockPath(task.eventId),
    requestId: task.requestId,
  };
  await acquireProfileGameProjectionLock(lock, ownerId, rtdb, now());
  try {
    const outbox = parseEventProfileGameProjectionOutbox(
      await rtdb.getRtdbPath(
        getEventProfileGameProjectionOutboxPath(task.eventId),
      ),
    );
    if (!outbox || outbox.requestId !== task.requestId) {
      return "stale";
    }
    const result = await runtime.reconcileEventProjection(
      task.eventId,
      outbox.cleanupOwnerProfileIds,
    );
    return (await settleEventProfileGameProjectionOutbox(task, rtdb))
      ? result.status
      : "superseded";
  } finally {
    await releaseProfileGameProjectionLock(lock, ownerId, rtdb);
  }
}

export async function settleProfileLinkProfileGameProjectionOutbox(
  task: ProfileLinkProfileGameProjectionTask,
  rtdb: ProfileGameProjectionRtdb,
): Promise<boolean> {
  const result = await rtdb.transactRtdbPath(
    getProfileLinkProfileGameProjectionOutboxPath(task.loginUid),
    (current) => {
      const outbox = parseProfileLinkProfileGameProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

export async function processProfileLinkProfileGameProjection(
  task: ProfileLinkProfileGameProjectionTask,
  rtdb: ProfileGameProjectionRtdb,
  process: (input: {
    cleanupProfileIds: string[];
    loginUid: string;
    matchCursor: string | null;
    profileId: string;
    sourceUpdatedAtMs: number;
    withInviteProjectionLock<T>(
      inviteId: string,
      work: () => Promise<T>,
    ): Promise<T>;
  }) => Promise<ProfileLinkProjectionResult | null>,
  ownerId: string = crypto.randomUUID(),
  now: () => number = Date.now,
): Promise<"continued" | "missing" | "projected" | "stale" | "superseded"> {
  const initialOutbox = parseProfileLinkProfileGameProjectionOutbox(
    await rtdb.getRtdbPath(
      getProfileLinkProfileGameProjectionOutboxPath(task.loginUid),
    ),
  );
  if (!initialOutbox || initialOutbox.requestId !== task.requestId) {
    return "stale";
  }
  const lock = {
    path: getProfileLinkProfileGameProjectionLockPath(task.loginUid),
    requestId: task.requestId,
  };
  await acquireProfileGameProjectionLock(lock, ownerId, rtdb, now());
  try {
    const outbox = parseProfileLinkProfileGameProjectionOutbox(
      await rtdb.getRtdbPath(
        getProfileLinkProfileGameProjectionOutboxPath(task.loginUid),
      ),
    );
    if (!outbox || outbox.requestId !== task.requestId) {
      return "stale";
    }
    const projection = await process({
      cleanupProfileIds: outbox.cleanupProfileIds,
      loginUid: task.loginUid,
      matchCursor: outbox.matchCursor,
      profileId: outbox.profileId,
      sourceUpdatedAtMs: outbox.sourceUpdatedAtMs,
      withInviteProjectionLock: async (inviteId, work) => {
        const inviteOwnerId = crypto.randomUUID();
        const inviteLock = {
          path: getAutomatchProfileGameProjectionLockPath(inviteId),
        };
        await acquireProfileGameProjectionLock(
          inviteLock,
          inviteOwnerId,
          rtdb,
          now(),
        );
        try {
          return await work();
        } finally {
          await releaseProfileGameProjectionLock(
            inviteLock,
            inviteOwnerId,
            rtdb,
          );
        }
      },
    });
    if (!projection) {
      return (await settleProfileLinkProfileGameProjectionOutbox(task, rtdb))
        ? "missing"
        : "superseded";
    }
    if (projection.didHitInviteCap && !projection.nextMatchCursor) {
      throw new Error("profile-link-profile-game-projection-no-progress");
    }
    if (projection.nextMatchCursor) {
      const continued = await rtdb.transactRtdbPath(
        getProfileLinkProfileGameProjectionOutboxPath(task.loginUid),
        (current) => {
          const live = parseProfileLinkProfileGameProjectionOutbox(current);
          if (!live || live.requestId !== task.requestId) {
            return { commit: false, decision: "superseded" };
          }
          return {
            value: {
              ...toRecord(current),
              matchCursor: projection.nextMatchCursor,
              lastQueuedAtMs: now(),
            },
            decision: "continued",
          };
        },
      );
      return continued.committed ? "continued" : "superseded";
    }
    return (await settleProfileLinkProfileGameProjectionOutbox(task, rtdb))
      ? "projected"
      : "superseded";
  } finally {
    await releaseProfileGameProjectionLock(lock, ownerId, rtdb);
  }
}

function automatchSweepEntries(value: unknown): AutomatchSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([inviteId, raw]) => {
    const outbox = parseAutomatchProfileGameProjectionOutbox(raw);
    return outbox && isSafeFirebaseKey(inviteId)
      ? {
          kind: "candidate",
          value: {
            lastQueuedAtMs: outbox.lastQueuedAtMs,
            task: {
              kind: "automatch-profile-game-projection",
              inviteId,
              requestId: outbox.requestId,
            },
          },
        }
      : { inviteId, kind: "invalid" };
  });
}

function eventSweepEntries(value: unknown): EventSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([eventId, raw]) => {
    const outbox = parseEventProfileGameProjectionOutbox(raw);
    return outbox && isSafeFirebaseKey(eventId)
      ? {
          kind: "candidate",
          value: {
            lastQueuedAtMs: outbox.lastQueuedAtMs,
            task: {
              kind: "event-profile-game-projection",
              eventId,
              requestId: outbox.requestId,
            },
          },
        }
      : { eventId, kind: "invalid" };
  });
}

function profileLinkSweepEntries(value: unknown): ProfileLinkSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([loginUid, raw]) => {
    const outbox = parseProfileLinkProfileGameProjectionOutbox(raw);
    return outbox && isSafeFirebaseKey(loginUid)
      ? {
          kind: "candidate",
          value: {
            lastQueuedAtMs: outbox.lastQueuedAtMs,
            task: {
              kind: "profile-link-profile-game-projection",
              loginUid,
              requestId: outbox.requestId,
            },
          },
        }
      : { kind: "invalid", loginUid };
  });
}

async function claimAutomatchSweepCandidate(
  rtdb: ProfileGameProjectionRtdb,
  candidate: AutomatchSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await rtdb.transactRtdbPath(
    getAutomatchProfileGameProjectionOutboxPath(candidate.task.inviteId),
    (current) => {
      const outbox = parseAutomatchProfileGameProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.lastQueuedAtMs !== candidate.lastQueuedAtMs ||
        outbox.lastQueuedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...toRecord(current), lastQueuedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

async function claimEventSweepCandidate(
  rtdb: ProfileGameProjectionRtdb,
  candidate: EventSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await rtdb.transactRtdbPath(
    getEventProfileGameProjectionOutboxPath(candidate.task.eventId),
    (current) => {
      const outbox = parseEventProfileGameProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.lastQueuedAtMs !== candidate.lastQueuedAtMs ||
        outbox.lastQueuedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...toRecord(current), lastQueuedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

async function claimProfileLinkSweepCandidate(
  rtdb: ProfileGameProjectionRtdb,
  candidate: ProfileLinkSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await rtdb.transactRtdbPath(
    getProfileLinkProfileGameProjectionOutboxPath(candidate.task.loginUid),
    (current) => {
      const outbox = parseProfileLinkProfileGameProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.lastQueuedAtMs !== candidate.lastQueuedAtMs ||
        outbox.lastQueuedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...toRecord(current), lastQueuedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

type InvalidEventSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: EventProfileGameProjectionTask };

function salvageEventCleanupOwnerProfileIds(value: unknown): string[] {
  const raw = toRecord(value)?.cleanupOwnerProfileIds;
  const candidates =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw
        : Object.keys(toRecord(raw) || {});
  return Array.from(
    new Set(
      candidates.filter(
        (profileId): profileId is string =>
          typeof profileId === "string" && isSafeFirebaseKey(profileId),
      ),
    ),
  );
}

function salvageProfileLinkCleanupProfileIds(value: unknown): string[] {
  const raw = toRecord(value)?.cleanupProfileIds;
  const candidates = Array.isArray(raw)
    ? raw
    : Object.keys(toRecord(raw) || {});
  return Array.from(
    new Set(
      candidates.filter(
        (profileId): profileId is string =>
          typeof profileId === "string" && isSafeFirebaseKey(profileId),
      ),
    ),
  );
}

async function repairInvalidEventSweepEntry(
  rtdb: ProfileGameProjectionRtdb,
  eventId: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidEventSweepResult> {
  const safeEventId = isSafeFirebaseKey(eventId);
  const requestId = safeEventId ? createRequestId() : "";
  const result = await rtdb.transactRtdbPath(
    `${EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT}/${eventId}`,
    (current) => {
      if (
        current === null ||
        current === undefined ||
        (parseEventProfileGameProjectionOutbox(current) &&
          isSafeFirebaseKey(eventId))
      ) {
        return { commit: false, decision: "changed" };
      }
      if (!safeEventId) {
        return { value: null, decision: "removed-invalid" };
      }
      const cleanupOwnerProfileIds =
        salvageEventCleanupOwnerProfileIds(current);
      return {
        value: {
          schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
          status: "pending",
          requestId,
          lastQueuedAtMs: nowMs,
          cleanupOwnerProfileIds: Object.fromEntries(
            cleanupOwnerProfileIds.map((profileId) => [profileId, true]),
          ),
        },
        decision: "repaired-invalid",
      };
    },
  );
  if (!result.committed) {
    return { kind: "changed" };
  }
  return safeEventId
    ? {
        kind: "repaired",
        task: {
          kind: "event-profile-game-projection",
          eventId,
          requestId,
        },
      }
    : { kind: "removed" };
}

type InvalidProfileLinkSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: ProfileLinkProfileGameProjectionTask };

async function repairInvalidProfileLinkSweepEntry(
  rtdb: ProfileGameProjectionRtdb,
  loginUid: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidProfileLinkSweepResult> {
  const safeLoginUid = isSafeFirebaseKey(loginUid);
  const liveProfileId = safeLoginUid
    ? await rtdb.getRtdbPath(`players/${loginUid}/profile`)
    : null;
  const safeProfileId =
    typeof liveProfileId === "string" && isSafeFirebaseKey(liveProfileId)
      ? liveProfileId
      : "";
  const requestId = safeLoginUid && safeProfileId ? createRequestId() : "";
  const result = await rtdb.transactRtdbPath(
    `${PROFILE_LINK_PROFILE_GAME_PROJECTION_OUTBOX_ROOT}/${loginUid}`,
    (current) => {
      if (
        current === null ||
        current === undefined ||
        (parseProfileLinkProfileGameProjectionOutbox(current) && safeLoginUid)
      ) {
        return { commit: false, decision: "changed" };
      }
      if (!safeLoginUid || !safeProfileId) {
        return { value: null, decision: "removed-invalid" };
      }
      const cleanupProfileIds = salvageProfileLinkCleanupProfileIds(current);
      const recordedProfileId = toRecord(current)?.profileId;
      if (
        typeof recordedProfileId === "string" &&
        isSafeFirebaseKey(recordedProfileId) &&
        recordedProfileId !== safeProfileId
      ) {
        cleanupProfileIds.push(recordedProfileId);
      }
      return {
        value: {
          schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
          status: "pending",
          requestId,
          profileId: safeProfileId,
          cleanupProfileIds: Object.fromEntries(
            Array.from(new Set(cleanupProfileIds)).map((profileId) => [
              profileId,
              true,
            ]),
          ),
          matchCursor: null,
          sourceUpdatedAtMs: nowMs,
          lastQueuedAtMs: nowMs,
        },
        decision: "repaired-invalid",
      };
    },
  );
  if (!result.committed) {
    return { kind: "changed" };
  }
  return safeLoginUid && safeProfileId
    ? {
        kind: "repaired",
        task: {
          kind: "profile-link-profile-game-projection",
          loginUid,
          requestId,
        },
      }
    : { kind: "removed" };
}

type InvalidAutomatchSweepResult =
  | { kind: "changed" }
  | { kind: "removed" }
  | { kind: "repaired"; task: AutomatchProfileGameProjectionTask };

async function repairInvalidAutomatchSweepEntry(
  rtdb: ProfileGameProjectionRtdb,
  inviteId: string,
  nowMs: number,
  createRequestId: () => string,
): Promise<InvalidAutomatchSweepResult> {
  const safeInviteId = isSafeFirebaseKey(inviteId);
  const requestId = safeInviteId ? createRequestId() : "";
  const result = await rtdb.transactRtdbPath(
    getAutomatchProfileGameProjectionOutboxPath(inviteId),
    (current) => {
      const record = toRecord(current);
      if (
        current === null ||
        current === undefined ||
        (record &&
          parseAutomatchProfileGameProjectionOutbox(current) &&
          isSafeFirebaseKey(inviteId))
      ) {
        return { commit: false, decision: "changed" };
      }
      if (!safeInviteId) {
        return { value: null, decision: "removed-invalid" };
      }
      const sourceUpdatedAtMs = record?.sourceUpdatedAtMs;
      return {
        value: {
          schemaVersion: PROFILE_GAME_PROJECTION_SCHEMA_VERSION,
          status: "pending",
          requestId,
          reason:
            typeof record?.reason === "string" && record.reason.trim()
              ? record.reason.trim()
              : "automatch-queue",
          sourceUpdatedAtMs:
            typeof sourceUpdatedAtMs === "number" &&
            Number.isFinite(sourceUpdatedAtMs) &&
            sourceUpdatedAtMs >= 0
              ? Math.floor(sourceUpdatedAtMs)
              : nowMs,
          lastQueuedAtMs: nowMs,
        },
        decision: "repaired-invalid",
      };
    },
  );
  if (!result.committed) {
    return { kind: "changed" };
  }
  return safeInviteId
    ? {
        kind: "repaired",
        task: {
          kind: "automatch-profile-game-projection",
          inviteId,
          requestId,
        },
      }
    : { kind: "removed" };
}

async function collectSuccessfulClaims<T>(
  items: readonly T[],
  claim: (item: T) => Promise<boolean>,
): Promise<{ claimed: T[]; failure: Error | null }> {
  const claimed: T[] = [];
  let failure: Error | null = null;
  for (const item of items) {
    try {
      if (await claim(item)) {
        claimed.push(item);
      }
    } catch (error) {
      failure ||=
        error instanceof Error
          ? error
          : new Error("profile-game-projection-claim-failed");
    }
  }
  return { claimed, failure };
}

export async function processRatingProfileGameProjection(
  operationId: string,
  rating: RatingProfileGameProjectionRepository,
  runtime: ProfileGameProjectionRuntime,
  now: () => number,
  rtdb: ProfileGameProjectionRtdb,
  ownerId: string = crypto.randomUUID(),
): Promise<"dead" | "done" | "stale"> {
  const update = await rating.readRatingUpdate(operationId);
  if (!update || update.profileGameProjectionState !== "pending") {
    return "stale";
  }
  if (!validRatingProjectionRecord(operationId, update)) {
    await rating.markRatingProfileGameProjection(
      operationId,
      "dead",
      now(),
      "invalid-record",
    );
    return "dead";
  }
  const lock = {
    path: getAutomatchProfileGameProjectionLockPath(update.inviteId),
  };
  await acquireProfileGameProjectionLock(lock, ownerId, rtdb, now());
  try {
    if (
      (await rating.getRtdbPath(
        `invites/${update.inviteId}/matchesRatingUpdates/${update.matchId}`,
      )) !== true
    ) {
      throw new Error("profile-game-projection-marker-pending");
    }
    await runtime.recomputeInviteProjection(
      update.inviteId,
      "invite-match-rating-updated",
      {
        eventTimestampMs: update.completedAtMs,
        latestMatchIdHint: update.matchId,
      },
    );
  } finally {
    await releaseProfileGameProjectionLock(lock, ownerId, rtdb);
  }
  await rating.markRatingProfileGameProjection(operationId, "done", now());
  return "done";
}

export async function handleProfileGameProjectionMessage(
  message: Message<unknown>,
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<void> {
  const logger = dependencies.logger || console;
  const task = parseProfileGameProjectionTask(message.body);
  if (!task) {
    message.ack();
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_queue_invalid_message",
      }),
    );
    return;
  }
  const now = dependencies.now || Date.now;
  try {
    const ownerId = crypto.randomUUID();
    const rtdb = (
      dependencies.createRtdb ||
      ((workerEnv: Env) => createGameplayRepository(workerEnv))
    )(env);
    const runtime = (
      dependencies.createRuntime || createProfileGameProjectionRuntime
    )(env);
    let status: string;
    if (task.kind === "automatch-profile-game-projection") {
      status = await processAutomatchProfileGameProjection(
        task,
        rtdb,
        runtime,
        ownerId,
        now,
      );
    } else if (task.kind === "profile-link-profile-game-projection") {
      status = await processProfileLinkProfileGameProjection(
        task,
        rtdb,
        async (input) => {
          if (dependencies.processProfileLink) {
            return dependencies.processProfileLink(input);
          }
          const linkLogger = {
            error(event: string, context?: unknown) {
              logger.error(JSON.stringify({ event, context }));
            },
            info(event: string, context?: unknown) {
              logger.info(JSON.stringify({ event, context }));
            },
          };
          return createProfileLinkProjectionRuntime(env, {
            logger: linkLogger,
            now,
            projection: runtime,
            rtdb,
            withInviteProjectionLock: input.withInviteProjectionLock,
          }).process(input);
        },
        ownerId,
        now,
      );
      if (status === "continued") {
        await env.PROFILE_GAME_PROJECTION_QUEUE.send(task);
      }
    } else if (task.kind === "event-profile-game-projection") {
      status = await processEventProfileGameProjection(
        task,
        rtdb,
        (
          dependencies.createEventRuntime ||
          createEventProfileGameProjectionRuntime
        )(env),
        ownerId,
        now,
      );
    } else {
      status = await processRatingProfileGameProjection(
        task.operationId,
        (
          dependencies.createRating ||
          ((workerEnv: Env) =>
            createRatingRepository(
              workerEnv,
              createGameplayRepository(workerEnv),
            ))
        )(env),
        runtime,
        now,
        rtdb,
        ownerId,
      );
    }
    message.ack();
    logger.info(
      JSON.stringify({
        event: "profile_game_projection_queue_processed",
        kind: task.kind,
        status,
      }),
    );
  } catch (error) {
    message.retry({
      delaySeconds: profileGameProjectionRetryDelaySeconds(message.attempts),
    });
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_queue_failed",
        kind: task.kind,
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export async function handleProfileGameProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const rtdb = createGameplayRepository(env);
  const rating = createRatingRepository(env, rtdb);
  const runtime = createProfileGameProjectionRuntime(env, { rtdb });
  const eventRuntime = createEventProfileGameProjectionRuntime(env, { rtdb });
  for (const message of batch.messages) {
    await handleProfileGameProjectionMessage(message, env, {
      createEventRuntime: () => eventRuntime,
      createRating: () => rating,
      createRtdb: () => rtdb,
      createRuntime: () => runtime,
    });
  }
}

async function sendProfileGameProjectionTasks(
  queue: Queue<ProfileGameProjectionTask>,
  tasks: ProfileGameProjectionTask[],
): Promise<void> {
  for (let index = 0; index < tasks.length; index += 100) {
    await queue.sendBatch(
      tasks.slice(index, index + 100).map((task) => ({ body: task })),
    );
  }
}

async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (index < items.length) {
        const current = index++;
        await worker(items[current]);
      }
    },
  );
  await Promise.all(runners);
}

export async function sweepRatingProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const rating = (
    dependencies.createRating ||
    ((workerEnv: Env) =>
      createRatingRepository(workerEnv, createGameplayRepository(workerEnv)))
  )(env);
  const nowMs = now();
  const records = await rating.listDueRatingProfileGameProjections(
    nowMs,
    PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  );
  const tasks: ProfileGameProjectionTask[] = [];
  let firstFailure: unknown;
  await forEachConcurrent(
    records,
    PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
    async (record) => {
      try {
        const claimed = await rating.claimRatingProfileGameProjection(
          record.operationId,
          record.updateTime,
          nowMs,
        );
        if (!claimed) {
          return;
        }
        if (
          record.version !== PROFILE_GAME_PROJECTION_SCHEMA_VERSION ||
          !isSafeFirebaseKey(record.inviteId) ||
          !isSafeFirebaseKey(record.matchId) ||
          record.operationId !== `${record.inviteId}__${record.matchId}`
        ) {
          await rating.markRatingProfileGameProjection(
            record.operationId,
            "dead",
            now(),
            "invalid-recovery-marker",
          );
          return;
        }
        await rating.patchRtdbRoot({
          [`invites/${record.inviteId}/matchesRatingUpdates/${record.matchId}`]: true,
        });
        tasks.push({
          kind: "rating-profile-game-projection",
          operationId: record.operationId,
        });
      } catch (error) {
        firstFailure ||= error;
        logger.error(
          JSON.stringify({
            event: "profile_game_projection_recovery_record_failed",
            operationId: record.operationId,
          }),
        );
      }
    },
  );
  await sendProfileGameProjectionTasks(
    env.PROFILE_GAME_PROJECTION_QUEUE,
    tasks,
  );
  if (firstFailure) {
    throw firstFailure;
  }
  return tasks.length;
}

export async function sweepAutomatchProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const nowMs = now();
  const dueBeforeMs = nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
  const rtdb = (
    dependencies.createRtdb ||
    ((workerEnv: Env) => createGameplayRepository(workerEnv))
  )(env);
  const [dueValue, malformedValue] = await Promise.all([
    rtdb.getRtdbPath(AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      endAt: dueBeforeMs,
      limitToFirst: PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    }),
    rtdb.getRtdbPath(AUTOMATCH_PROFILE_GAME_PROJECTION_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      startAt: "",
      limitToFirst: PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    }),
  ]);
  const entries = [
    ...automatchSweepEntries(dueValue),
    ...automatchSweepEntries(malformedValue),
  ];
  const invalidInviteIds = entries.flatMap((entry) =>
    entry.kind === "invalid" ? [entry.inviteId] : [],
  );
  let invalidFailure: Error | null = null;
  const repairedTasks: AutomatchProfileGameProjectionTask[] = [];
  let invalidRemoved = 0;
  for (const inviteId of invalidInviteIds) {
    try {
      const result = await repairInvalidAutomatchSweepEntry(
        rtdb,
        inviteId,
        nowMs,
        createRequestId,
      );
      if (result.kind === "repaired") {
        repairedTasks.push(result.task);
      } else if (result.kind === "removed") {
        invalidRemoved++;
      }
    } catch (error) {
      invalidFailure ||=
        error instanceof Error
          ? error
          : new Error("profile-game-projection-invalid-record-failed");
    }
  }
  if (repairedTasks.length > 0 || invalidRemoved > 0) {
    logger.error(
      JSON.stringify({
        event: "profile_game_projection_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      }),
    );
  }
  const candidates = entries.flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
  const claims = await collectSuccessfulClaims(candidates, (candidate) =>
    claimAutomatchSweepCandidate(rtdb, candidate, nowMs),
  );
  const tasks: ProfileGameProjectionTask[] = [
    ...repairedTasks,
    ...claims.claimed.map(({ task }) => task),
  ];
  await sendProfileGameProjectionTasks(
    env.PROFILE_GAME_PROJECTION_QUEUE,
    tasks,
  );
  if (claims.failure) {
    throw claims.failure;
  }
  if (invalidFailure) {
    throw invalidFailure;
  }
  return tasks.length;
}

export async function sweepEventProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const nowMs = now();
  const dueBeforeMs = nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
  const rtdb = (
    dependencies.createRtdb ||
    ((workerEnv: Env) => createGameplayRepository(workerEnv))
  )(env);
  const [dueValue, malformedValue] = await Promise.all([
    rtdb.getRtdbPath(EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      endAt: dueBeforeMs,
      limitToFirst: PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    }),
    rtdb.getRtdbPath(EVENT_PROFILE_GAME_PROJECTION_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      startAt: "",
      limitToFirst: PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    }),
  ]);
  const entries = [
    ...eventSweepEntries(dueValue),
    ...eventSweepEntries(malformedValue),
  ];
  const invalidEventIds = Array.from(
    new Set(
      entries.flatMap((entry) =>
        entry.kind === "invalid" ? [entry.eventId] : [],
      ),
    ),
  );
  const failures: Error[] = [];
  const repairedTasks: EventProfileGameProjectionTask[] = [];
  let invalidRemoved = 0;
  for (const eventId of invalidEventIds) {
    try {
      const result = await repairInvalidEventSweepEntry(
        rtdb,
        eventId,
        nowMs,
        createRequestId,
      );
      if (result.kind === "repaired") {
        repairedTasks.push(result.task);
      } else if (result.kind === "removed") {
        invalidRemoved += 1;
      }
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error("event-profile-game-invalid-record-failed"),
      );
    }
  }
  if (repairedTasks.length > 0 || invalidRemoved > 0) {
    logger.error(
      JSON.stringify({
        event: "event_profile_game_projection_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      }),
    );
  }
  const candidateByEventId = new Map<string, EventSweepCandidate>();
  for (const entry of entries) {
    if (entry.kind === "candidate") {
      candidateByEventId.set(entry.value.task.eventId, entry.value);
    }
  }
  const claims = await collectSuccessfulClaims(
    Array.from(candidateByEventId.values()),
    (candidate) => claimEventSweepCandidate(rtdb, candidate, nowMs),
  );
  const tasks: ProfileGameProjectionTask[] = [
    ...repairedTasks,
    ...claims.claimed.map(({ task }) => task),
  ];
  await sendProfileGameProjectionTasks(
    env.PROFILE_GAME_PROJECTION_QUEUE,
    tasks,
  );
  if (claims.failure) {
    failures.push(claims.failure);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "event-profile-game-projection-sweep-failed",
    );
  }
  return tasks.length;
}

export async function sweepProfileLinkProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const nowMs = now();
  const dueBeforeMs = nowMs - PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS;
  const rtdb = (
    dependencies.createRtdb ||
    ((workerEnv: Env) => createGameplayRepository(workerEnv))
  )(env);
  const [dueValue, malformedValue] = await Promise.all([
    rtdb.getRtdbPath(PROFILE_LINK_PROFILE_GAME_PROJECTION_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      endAt: dueBeforeMs,
      limitToFirst: PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    }),
    rtdb.getRtdbPath(PROFILE_LINK_PROFILE_GAME_PROJECTION_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      startAt: "",
      limitToFirst: PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
    }),
  ]);
  const entries = [
    ...profileLinkSweepEntries(dueValue),
    ...profileLinkSweepEntries(malformedValue),
  ];
  const invalidLoginUids = Array.from(
    new Set(
      entries.flatMap((entry) =>
        entry.kind === "invalid" ? [entry.loginUid] : [],
      ),
    ),
  );
  const failures: Error[] = [];
  const repairedTasks: ProfileLinkProfileGameProjectionTask[] = [];
  let invalidRemoved = 0;
  for (const loginUid of invalidLoginUids) {
    try {
      const result = await repairInvalidProfileLinkSweepEntry(
        rtdb,
        loginUid,
        nowMs,
        createRequestId,
      );
      if (result.kind === "repaired") {
        repairedTasks.push(result.task);
      } else if (result.kind === "removed") {
        invalidRemoved += 1;
      }
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error("profile-link-profile-game-invalid-record-failed"),
      );
    }
  }
  if (repairedTasks.length > 0 || invalidRemoved > 0) {
    logger.error(
      JSON.stringify({
        event: "profile_link_profile_game_invalid_outboxes_recovered",
        repaired: repairedTasks.length,
        removed: invalidRemoved,
      }),
    );
  }
  const candidateByLoginUid = new Map<string, ProfileLinkSweepCandidate>();
  for (const entry of entries) {
    if (entry.kind === "candidate") {
      candidateByLoginUid.set(entry.value.task.loginUid, entry.value);
    }
  }
  const claims = await collectSuccessfulClaims(
    Array.from(candidateByLoginUid.values()),
    (candidate) => claimProfileLinkSweepCandidate(rtdb, candidate, nowMs),
  );
  const tasks: ProfileGameProjectionTask[] = [
    ...repairedTasks,
    ...claims.claimed.map(({ task }) => task),
  ];
  await sendProfileGameProjectionTasks(
    env.PROFILE_GAME_PROJECTION_QUEUE,
    tasks,
  );
  if (claims.failure) {
    failures.push(claims.failure);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "profile-link-profile-game-projection-sweep-failed",
    );
  }
  return tasks.length;
}

export async function sweepProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<ProfileGameProjectionSweepResult> {
  const [automatch, event, profile, rating] = await Promise.allSettled([
    sweepAutomatchProfileGameProjections(env, dependencies),
    sweepEventProfileGameProjections(env, dependencies),
    sweepProfileLinkProfileGameProjections(env, dependencies),
    sweepRatingProfileGameProjections(env, dependencies),
  ]);
  const failures = [automatch, event, profile, rating].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (
    failures.length > 0 ||
    automatch.status === "rejected" ||
    event.status === "rejected" ||
    profile.status === "rejected" ||
    rating.status === "rejected"
  ) {
    throw new AggregateError(failures, "profile-game-projection-sweep-failed");
  }
  return {
    automatch: automatch.value,
    event: event.value,
    profile: profile.value,
    rating: rating.value,
  };
}

export async function handleProfileGameProjectionSweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  const enqueued = await sweepProfileGameProjections(env);
  console.info(
    JSON.stringify({
      event: "profile_game_projection_sweep_completed",
      enqueued:
        enqueued.automatch +
        enqueued.event +
        enqueued.profile +
        enqueued.rating,
      automatchEnqueued: enqueued.automatch,
      eventEnqueued: enqueued.event,
      profileEnqueued: enqueued.profile,
      ratingEnqueued: enqueued.rating,
    }),
  );
}

export {
  MAX_PROFILE_GAME_PROJECTION_RETRY_DELAY_SECONDS,
  PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY,
  PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS,
  PROFILE_GAME_PROJECTION_SWEEP_LIMIT,
  acquireProfileGameProjectionLock,
  automatchSweepEntries,
  claimAutomatchSweepCandidate,
  claimEventSweepCandidate,
  claimProfileLinkSweepCandidate,
  eventSweepEntries,
  profileLinkSweepEntries,
  repairInvalidEventSweepEntry,
  repairInvalidProfileLinkSweepEntry,
  salvageProfileLinkCleanupProfileIds,
  salvageEventCleanupOwnerProfileIds,
  releaseProfileGameProjectionLock,
  repairInvalidAutomatchSweepEntry,
  sendProfileGameProjectionTasks,
  validRatingProjectionRecord,
};
