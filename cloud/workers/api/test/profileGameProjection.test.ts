import assert from "node:assert/strict";
import test from "node:test";
import type {
  RatingProfileGameProjectionRepository,
  RatingUpdateData,
} from "../src/gameplayRepository.ts";
import {
  claimAutomatchSweepCandidate,
  handleProfileGameProjectionMessage,
  processAutomatchProfileGameProjection,
  processEventProfileGameProjection,
  processProfileLinkProfileGameProjection,
  processRatingProfileGameProjection,
  profileGameProjectionRetryDelaySeconds,
  repairInvalidEventSweepEntry,
  repairInvalidProfileLinkSweepEntry,
  sweepAutomatchProfileGameProjections,
  sweepEventProfileGameProjections,
  sweepProfileLinkProfileGameProjections,
  sweepRatingProfileGameProjections,
} from "../src/profileGameProjection.ts";
import {
  buildAutomatchProfileGameProjectionOutboxUpdates,
  buildEventProfileGameProjectionOutboxUpdates,
  buildProfileLinkProfileGameProjectionOutbox,
  parseAutomatchProfileGameProjectionOutbox,
  parseEventProfileGameProjectionOutbox,
  parseProfileLinkProfileGameProjectionOutbox,
} from "../src/profileGameProjectionOutbox.ts";
import type {
  EventProfileGameProjectionRuntime,
  ProfileGameProjectionRuntime,
} from "../src/profileGameProjectionRepository.ts";
import {
  parseProfileGameProjectionTask,
  PROFILE_GAME_PROJECTION_QUEUE_NAME,
  type AutomatchProfileGameProjectionTask,
  type EventProfileGameProjectionTask,
  type ProfileLinkProfileGameProjectionTask,
  type ProfileGameProjectionTask,
} from "../src/profileGameProjectionTasks.ts";
import worker from "../src/workerHandler.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const operationId = "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa";

function ratingUpdate(
  overrides: Partial<RatingUpdateData> = {},
): RatingUpdateData {
  return {
    completedAtMs: 200,
    inviteId: "auto_aaaaaaaaaaa",
    leaseExpiresAtMs: 1,
    matchId: "auto_aaaaaaaaaaa",
    opponentId: "opponent",
    opponentProfileId: "opponent-profile",
    ownerToken: "owner",
    playerId: "player",
    playerProfileId: "player-profile",
    profileGameProjectionState: "pending",
    profileGameProjectionUpdatedAtMs: 200,
    profileGameProjectionVersion: 1,
    shouldUpdateFebruaryChallenge: false,
    startedAtMs: 1,
    status: "done",
    ...overrides,
  };
}

function ratingRepository(
  data: RatingUpdateData | null,
  state: {
    marker?: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  },
): RatingProfileGameProjectionRepository {
  return {
    applyFebruaryChallengeReplay: async () => undefined,
    claimRatingProfileGameProjection: async () => true,
    finalizeRatingUpdate: async () => ({ status: "lost" }),
    getRatingProfile: async () => null,
    getRtdbPath: async () => state.marker ?? null,
    listDueRatingProfileGameProjections: async () => [],
    markRatingProfileGameProjection: async (
      _operationId,
      projectionState,
      _updatedAtMs,
      reason,
    ) => {
      state.marks.push({
        state: projectionState,
        ...(reason ? { reason } : {}),
      });
    },
    patchRtdbRoot: async (updates) => {
      state.patches.push(updates);
    },
    readRatingUpdate: async () => data,
    tryAcquireRatingLease: async () => ({ status: "busy", data: null }),
  };
}

function runtime(
  calls: Array<{
    inviteId: string;
    options: Record<string, unknown>;
    reason: string;
  }>,
): ProfileGameProjectionRuntime {
  return {
    async recomputeInviteProjection(inviteId, reason, options = {}) {
      calls.push({ inviteId, reason, options });
      return {
        inviteId,
        ok: true,
        reason,
        skipped: 0,
        sourceCleanupSafe: true,
      };
    },
  };
}

function queueMessage<Body>(body: Body, attempts = 1) {
  let acknowledgements = 0;
  const retries: QueueRetryOptions[] = [];
  return {
    acknowledgements: () => acknowledgements,
    message: {
      id: "profile-game-projection-message",
      timestamp: new Date(0),
      body,
      attempts,
      ack: () => {
        acknowledgements += 1;
      },
      retry: (options?: QueueRetryOptions) => {
        retries.push(options || {});
      },
    } satisfies Message<Body>,
    retries,
  };
}

function automatchOutbox(
  requestId = "request-1",
  sourceUpdatedAtMs = 100,
  lastQueuedAtMs = 200,
) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId,
    reason: "automatch-queue",
    sourceUpdatedAtMs,
    lastQueuedAtMs,
  };
}

function automatchTask(
  requestId = "request-1",
): AutomatchProfileGameProjectionTask {
  return {
    kind: "automatch-profile-game-projection",
    inviteId: "auto_aaaaaaaaaaa",
    requestId,
  };
}

function eventOutbox(
  requestId = "event-request-1",
  lastQueuedAtMs = 200,
  cleanupOwnerProfileIds = ["stale-profile"],
) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId,
    lastQueuedAtMs,
    cleanupOwnerProfileIds: Object.fromEntries(
      cleanupOwnerProfileIds.map((profileId) => [profileId, true]),
    ),
  };
}

function eventTask(
  requestId = "event-request-1",
): EventProfileGameProjectionTask {
  return {
    kind: "event-profile-game-projection",
    eventId: "event-1",
    requestId,
  };
}

function profileLinkOutbox(
  requestId = "profile-request-1",
  lastQueuedAtMs = 200,
  matchCursor: string | null = null,
) {
  return {
    schemaVersion: 1,
    status: "pending",
    requestId,
    profileId: "profile-1",
    cleanupProfileIds: { "stale-profile": true },
    matchCursor,
    sourceUpdatedAtMs: 100,
    lastQueuedAtMs,
  };
}

function profileLinkTask(
  requestId = "profile-request-1",
): ProfileLinkProfileGameProjectionTask {
  return {
    kind: "profile-link-profile-game-projection",
    loginUid: "login-1",
    requestId,
  };
}

function eventRuntime(
  calls: Array<{ cleanupOwnerProfileIds: string[]; eventId: string }>,
  status: "missing" | "projected" = "projected",
): EventProfileGameProjectionRuntime {
  return {
    async reconcileEventProjection(eventId, cleanupOwnerProfileIds = []) {
      calls.push({ eventId, cleanupOwnerProfileIds });
      return {
        deleted: 0,
        ownerProfileIds: [],
        status,
        written: 0,
      };
    },
  };
}

function applyRtdbTransaction(
  current: unknown,
  updater: (value: unknown) => unknown,
): { committed: boolean; decision?: string; value: unknown } {
  const output = updater(current) as {
    commit?: false;
    decision?: string;
    value?: unknown;
  };
  return output.commit === false
    ? { committed: false, decision: output.decision, value: current }
    : { committed: true, decision: output.decision, value: output.value };
}

function projectionLockRtdb(values = new Map<string, unknown>()) {
  return {
    getRtdbPath: async (path: string) => values.get(path),
    transactRtdbPath: async (
      path: string,
      updater: (current: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(values.get(path), updater);
      if (result.committed) {
        values.set(path, result.value);
      }
      return result;
    },
  };
}

test("profile game projection tasks require exact safe payloads", () => {
  assert.deepEqual(
    parseProfileGameProjectionTask(automatchTask()),
    automatchTask(),
  );
  assert.equal(
    parseProfileGameProjectionTask({ ...automatchTask(), extra: true }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({
      ...automatchTask(),
      inviteId: "unsafe/path",
    }),
    null,
  );
  assert.deepEqual(parseProfileGameProjectionTask(eventTask()), eventTask());
  assert.equal(
    parseProfileGameProjectionTask({ ...eventTask(), extra: true }),
    null,
  );
  assert.deepEqual(
    parseProfileGameProjectionTask(profileLinkTask()),
    profileLinkTask(),
  );
  assert.equal(
    parseProfileGameProjectionTask({ ...profileLinkTask(), extra: true }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({
      ...profileLinkTask(),
      loginUid: "unsafe/path",
    }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({ ...eventTask(), eventId: "unsafe/path" }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({
      ...eventTask(),
      requestId: "unsafe/path",
    }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({
      ...automatchTask(),
      requestId: "unsafe/path",
    }),
    null,
  );
  assert.deepEqual(
    parseProfileGameProjectionTask({
      kind: "rating-profile-game-projection",
      operationId,
    }),
    { kind: "rating-profile-game-projection", operationId },
  );
  assert.equal(
    parseProfileGameProjectionTask({
      kind: "rating-profile-game-projection",
      operationId,
      extra: true,
    }),
    null,
  );
  assert.equal(
    parseProfileGameProjectionTask({
      kind: "rating-profile-game-projection",
      operationId: "unsafe/path",
    }),
    null,
  );
});

test("automatch outboxes preserve source and recovery timestamps", () => {
  assert.deepEqual(
    buildAutomatchProfileGameProjectionOutboxUpdates({
      inviteId: "auto_aaaaaaaaaaa",
      requestId: "request-1",
      timestamp: 100,
    }),
    {
      "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa": automatchOutbox(
        "request-1",
        100,
        100,
      ),
    },
  );
  assert.deepEqual(
    parseAutomatchProfileGameProjectionOutbox(automatchOutbox()),
    automatchOutbox(),
  );
  for (const invalid of [
    null,
    { ...automatchOutbox(), status: "dead" },
    { ...automatchOutbox(), requestId: "unsafe/path" },
    { ...automatchOutbox(), sourceUpdatedAtMs: null },
    { ...automatchOutbox(), lastQueuedAtMs: Number.NaN },
  ]) {
    assert.equal(parseAutomatchProfileGameProjectionOutbox(invalid), null);
  }
});

test("event outboxes preserve accumulated cleanup owners", () => {
  assert.deepEqual(
    buildEventProfileGameProjectionOutboxUpdates({
      cleanupOwnerProfileIds: ["owner-a", "owner-b", "owner-a"],
      eventId: "event-1",
      requestId: "event-request-1",
      timestamp: 100,
    }),
    {
      "profileGameProjectionOutbox/event/event-1/schemaVersion": 1,
      "profileGameProjectionOutbox/event/event-1/status": "pending",
      "profileGameProjectionOutbox/event/event-1/requestId": "event-request-1",
      "profileGameProjectionOutbox/event/event-1/lastQueuedAtMs": 100,
      "profileGameProjectionOutbox/event/event-1/reason": null,
      "profileGameProjectionOutbox/event/event-1/deadAtMs": null,
      "profileGameProjectionOutbox/event/event-1/cleanupOwnerProfileIds/owner-a": true,
      "profileGameProjectionOutbox/event/event-1/cleanupOwnerProfileIds/owner-b": true,
    },
  );
  assert.deepEqual(parseEventProfileGameProjectionOutbox(eventOutbox()), {
    schemaVersion: 1,
    status: "pending",
    requestId: "event-request-1",
    lastQueuedAtMs: 200,
    cleanupOwnerProfileIds: ["stale-profile"],
  });
  for (const invalid of [
    null,
    { ...eventOutbox(), status: "dead" },
    { ...eventOutbox(), requestId: "unsafe/path" },
    { ...eventOutbox(), lastQueuedAtMs: Number.NaN },
    {
      ...eventOutbox(),
      cleanupOwnerProfileIds: { "unsafe/path": true },
    },
    { ...eventOutbox(), cleanupOwnerProfileIds: { owner: false } },
  ]) {
    assert.equal(parseEventProfileGameProjectionOutbox(invalid), null);
  }
});

test("profile-link outboxes preserve current and cleanup profiles", () => {
  assert.deepEqual(
    buildProfileLinkProfileGameProjectionOutbox({
      cleanupProfileIds: ["stale-profile", "stale-profile"],
      lastQueuedAtMs: 200,
      profileId: "profile-1",
      requestId: "profile-request-1",
      sourceUpdatedAtMs: 100,
    }),
    profileLinkOutbox(),
  );
  assert.deepEqual(
    parseProfileLinkProfileGameProjectionOutbox(profileLinkOutbox()),
    {
      ...profileLinkOutbox(),
      cleanupProfileIds: ["stale-profile"],
    },
  );
  const omittedCleanup = Object.fromEntries(
    Object.entries(profileLinkOutbox()).filter(
      ([key]) => key !== "cleanupProfileIds",
    ),
  );
  assert.deepEqual(
    parseProfileLinkProfileGameProjectionOutbox(omittedCleanup),
    { ...profileLinkOutbox(), cleanupProfileIds: [] },
  );
  for (const invalid of [
    null,
    { ...profileLinkOutbox(), profileId: "unsafe/path" },
    { ...profileLinkOutbox(), requestId: "unsafe/path" },
    { ...profileLinkOutbox(), cleanupProfileIds: { owner: false } },
    { ...profileLinkOutbox(), sourceUpdatedAtMs: Number.NaN },
  ]) {
    assert.equal(parseProfileLinkProfileGameProjectionOutbox(invalid), null);
  }
});

test("automatch projection uses the immutable source timestamp and exact-clears", async () => {
  const path = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const values = new Map<string, unknown>([[path, automatchOutbox()]]);
  const calls: Array<{
    inviteId: string;
    options: Record<string, unknown>;
    reason: string;
  }> = [];
  const rtdb = {
    getRtdbPath: async (requestedPath: string) => values.get(requestedPath),
    transactRtdbPath: async (
      requestedPath: string,
      updater: (current: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(values.get(requestedPath), updater);
      if (result.committed) {
        values.set(requestedPath, result.value);
      }
      return result;
    },
  };
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask(),
      rtdb,
      runtime(calls),
    ),
    "projected",
  );
  assert.deepEqual(calls, [
    {
      inviteId: "auto_aaaaaaaaaaa",
      reason: "automatch-queue",
      options: { eventTimestampMs: 100 },
    },
  ]);
  assert.equal(values.get(path), null);

  values.set(path, automatchOutbox("request-new", 300, 300));
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask(),
      rtdb,
      runtime(calls),
    ),
    "stale",
  );
  assert.equal(calls.length, 1);
});

test("automatch projection serializes newer work behind the current invite", async () => {
  const outboxPath = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const values = new Map<string, unknown>([[outboxPath, automatchOutbox()]]);
  let projection = "initial";
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const rtdb = {
    getRtdbPath: async (path: string) => values.get(path),
    transactRtdbPath: async (
      path: string,
      updater: (current: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(values.get(path), updater);
      if (result.committed) {
        values.set(path, result.value);
      }
      return result;
    },
  };
  const first = processAutomatchProfileGameProjection(
    automatchTask(),
    rtdb,
    {
      recomputeInviteProjection: async () => {
        firstStarted?.();
        await firstBlocked;
        projection = "canceled";
        return {
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "automatch-queue",
          skipped: 0,
          sourceCleanupSafe: true,
        };
      },
    },
    "owner-a",
    () => 100,
  );
  await started;
  values.set(outboxPath, automatchOutbox("request-new", 300, 300));
  await assert.rejects(
    () =>
      processAutomatchProfileGameProjection(
        automatchTask("request-new"),
        rtdb,
        runtime([]),
        "owner-b",
        () => 200,
      ),
    /lock-busy/,
  );
  releaseFirst?.();
  assert.equal(await first, "superseded");
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask("request-new"),
      rtdb,
      {
        recomputeInviteProjection: async () => {
          projection = "matched";
          return {
            inviteId: "auto_aaaaaaaaaaa",
            ok: true,
            reason: "automatch-queue",
            skipped: 0,
            sourceCleanupSafe: true,
          };
        },
      },
      "owner-b",
      () => 300,
    ),
    "projected",
  );
  assert.equal(projection, "matched");
  assert.equal(values.get(outboxPath), null);
  assert.equal(
    await processProfileLinkProfileGameProjection(
      profileLinkTask(),
      rtdb,
      async () => ({ didHitInviteCap: false, nextMatchCursor: null }),
      "duplicate-owner",
      () => 400,
    ),
    "stale",
  );
});

test("profile-link recovery rebuilds malformed markers from the live link", async () => {
  let current: unknown = {
    status: "bad",
    profileId: "stale-profile",
    cleanupProfileIds: { "older-profile": true, "unsafe/path": true },
  };
  const result = await repairInvalidProfileLinkSweepEntry(
    {
      getRtdbPath: async (path) => {
        assert.equal(path, "players/login-1/profile");
        return "profile-1";
      },
      transactRtdbPath: async (_path, updater) => {
        const transaction = applyRtdbTransaction(current, updater);
        if (transaction.committed) current = transaction.value;
        return transaction;
      },
    },
    "login-1",
    600_000,
    () => "repair-request",
  );
  assert.deepEqual(result, {
    kind: "repaired",
    task: {
      kind: "profile-link-profile-game-projection",
      loginUid: "login-1",
      requestId: "repair-request",
    },
  });
  assert.deepEqual(current, {
    schemaVersion: 1,
    status: "pending",
    requestId: "repair-request",
    profileId: "profile-1",
    cleanupProfileIds: {
      "older-profile": true,
      "stale-profile": true,
    },
    matchCursor: null,
    sourceUpdatedAtMs: 600_000,
    lastQueuedAtMs: 600_000,
  });
});

test("event projection reconciles cleanup owners and exact-clears its outbox", async () => {
  const outboxPath = "profileGameProjectionOutbox/event/event-1";
  const values = new Map<string, unknown>([[outboxPath, eventOutbox()]]);
  const calls: Array<{ cleanupOwnerProfileIds: string[]; eventId: string }> =
    [];
  const rtdb = projectionLockRtdb(values);
  assert.equal(
    await processEventProfileGameProjection(
      eventTask(),
      rtdb,
      eventRuntime(calls),
      "event-owner",
      () => 300,
    ),
    "projected",
  );
  assert.deepEqual(calls, [
    { eventId: "event-1", cleanupOwnerProfileIds: ["stale-profile"] },
  ]);
  assert.equal(values.get(outboxPath), null);

  values.set(outboxPath, eventOutbox("event-request-new", 400));
  assert.equal(
    await processEventProfileGameProjection(
      eventTask(),
      rtdb,
      eventRuntime(calls),
      "event-owner",
      () => 400,
    ),
    "stale",
  );
  assert.equal(calls.length, 1);
});

test("event projection preserves a superseding outbox", async () => {
  const outboxPath = "profileGameProjectionOutbox/event/event-1";
  const values = new Map<string, unknown>([[outboxPath, eventOutbox()]]);
  const rtdb = projectionLockRtdb(values);
  const runtime: EventProfileGameProjectionRuntime = {
    async reconcileEventProjection() {
      values.set(outboxPath, eventOutbox("event-request-new", 400));
      return {
        deleted: 0,
        ownerProfileIds: [],
        status: "projected",
        written: 0,
      };
    },
  };
  assert.equal(
    await processEventProfileGameProjection(
      eventTask(),
      rtdb,
      runtime,
      "event-owner",
      () => 300,
    ),
    "superseded",
  );
  assert.deepEqual(
    values.get(outboxPath),
    eventOutbox("event-request-new", 400),
  );
});

test("profile-link projection uses nested invite locks and exact-clears", async () => {
  const outboxPath = "profileGameProjectionOutbox/profile/login-1";
  const values = new Map<string, unknown>([[outboxPath, profileLinkOutbox()]]);
  const rtdb = projectionLockRtdb(values);
  const calls: Array<Record<string, unknown>> = [];
  assert.equal(
    await processProfileLinkProfileGameProjection(
      profileLinkTask(),
      rtdb,
      async (input) => {
        calls.push({
          cleanupProfileIds: input.cleanupProfileIds,
          loginUid: input.loginUid,
          profileId: input.profileId,
        });
        await input.withInviteProjectionLock("invite-1", async () => undefined);
        return { didHitInviteCap: false, nextMatchCursor: null };
      },
      "profile-owner",
      () => 300,
    ),
    "projected",
  );
  assert.deepEqual(calls, [
    {
      cleanupProfileIds: ["stale-profile"],
      loginUid: "login-1",
      profileId: "profile-1",
    },
  ]);
  assert.equal(values.get(outboxPath), null);
});

test("profile-link projection advances capped work before clearing", async () => {
  const outboxPath = "profileGameProjectionOutbox/profile/login-1";
  const values = new Map<string, unknown>([[outboxPath, profileLinkOutbox()]]);
  const rtdb = projectionLockRtdb(values);
  assert.equal(
    await processProfileLinkProfileGameProjection(
      profileLinkTask(),
      rtdb,
      async () => ({
        didHitInviteCap: true,
        nextMatchCursor: "match-300",
      }),
      "profile-owner",
      () => 300,
    ),
    "continued",
  );
  assert.deepEqual(
    values.get(outboxPath),
    profileLinkOutbox("profile-request-1", 300, "match-300"),
  );
  assert.equal(
    await processProfileLinkProfileGameProjection(
      profileLinkTask(),
      rtdb,
      async (input) => {
        assert.equal(input.matchCursor, "match-300");
        return { didHitInviteCap: false, nextMatchCursor: null };
      },
      "profile-owner-next",
      () => 400,
    ),
    "projected",
  );
  assert.equal(values.get(outboxPath), null);
});

test("profile-link projection exact-settles missing links", async () => {
  const outboxPath = "profileGameProjectionOutbox/profile/login-1";
  const values = new Map<string, unknown>([[outboxPath, profileLinkOutbox()]]);
  const rtdb = projectionLockRtdb(values);
  assert.equal(
    await processProfileLinkProfileGameProjection(
      profileLinkTask(),
      rtdb,
      async () => null,
      "profile-owner",
      () => 300,
    ),
    "missing",
  );
  assert.equal(values.get(outboxPath), null);

  values.set(outboxPath, profileLinkOutbox());
  assert.equal(
    await processProfileLinkProfileGameProjection(
      profileLinkTask(),
      rtdb,
      async () => {
        values.set(outboxPath, profileLinkOutbox("profile-request-new", 400));
        return null;
      },
      "profile-owner-next",
      () => 400,
    ),
    "superseded",
  );
  assert.deepEqual(
    values.get(outboxPath),
    profileLinkOutbox("profile-request-new", 400),
  );
});

test("profile-link projection retains timed-out work without a cursor", async () => {
  const outboxPath = "profileGameProjectionOutbox/profile/login-1";
  const outbox = profileLinkOutbox();
  const values = new Map<string, unknown>([[outboxPath, outbox]]);
  await assert.rejects(
    processProfileLinkProfileGameProjection(
      profileLinkTask(),
      projectionLockRtdb(values),
      async () => ({ didHitInviteCap: true, nextMatchCursor: "" }),
      "profile-owner",
      () => 300,
    ),
    /no-progress/,
  );
  assert.deepEqual(values.get(outboxPath), outbox);
});

test("rating projection uses deterministic completion inputs and completes once", async () => {
  const calls: Array<{
    inviteId: string;
    options: Record<string, unknown>;
    reason: string;
  }> = [];
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  const status = await processRatingProfileGameProjection(
    operationId,
    ratingRepository(ratingUpdate(), state),
    runtime(calls),
    () => 300,
    projectionLockRtdb(),
  );
  assert.equal(status, "done");
  assert.deepEqual(calls, [
    {
      inviteId: "auto_aaaaaaaaaaa",
      reason: "invite-match-rating-updated",
      options: {
        eventTimestampMs: 200,
        latestMatchIdHint: "auto_aaaaaaaaaaa",
      },
    },
  ]);
  assert.deepEqual(state.marks, [{ state: "done" }]);

  assert.equal(
    await processRatingProfileGameProjection(
      operationId,
      ratingRepository(
        ratingUpdate({ profileGameProjectionState: "done" }),
        state,
      ),
      runtime(calls),
      () => 400,
      projectionLockRtdb(),
    ),
    "stale",
  );
  assert.equal(calls.length, 1);
});

test("rating projection does not re-enter an active projection lock", async () => {
  const values = new Map<string, unknown>();
  const rtdb = projectionLockRtdb(values);
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = processRatingProfileGameProjection(
    operationId,
    ratingRepository(ratingUpdate(), state),
    {
      recomputeInviteProjection: async () => {
        firstStarted?.();
        await firstBlocked;
        return {
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "invite-match-rating-updated",
          skipped: 0,
          sourceCleanupSafe: true,
        };
      },
    },
    () => 100,
    rtdb,
    "owner-a",
  );
  await started;
  await assert.rejects(
    () =>
      processRatingProfileGameProjection(
        operationId,
        ratingRepository(ratingUpdate(), state),
        runtime([]),
        () => 200,
        rtdb,
        "owner-a",
      ),
    /lock-busy/,
  );
  releaseFirst?.();
  assert.equal(await first, "done");
  assert.equal(
    values.get("profileGameProjectionLocks/automatch/auto_aaaaaaaaaaa"),
    null,
  );
});

test("rating projection retries lock release before marking completion", async () => {
  let current: unknown = null;
  let failRelease = true;
  let releaseAttempts = 0;
  const rtdb = {
    getRtdbPath: async () => null,
    transactRtdbPath: async (
      _path: string,
      updater: (value: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(current, updater);
      if (result.committed && result.value === null) {
        releaseAttempts++;
        if (failRelease) {
          failRelease = false;
          throw new Error("release-failed");
        }
      }
      if (result.committed) {
        current = result.value;
      }
      return result;
    },
  };
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  const calls: Array<{
    inviteId: string;
    options: Record<string, unknown>;
    reason: string;
  }> = [];
  assert.equal(
    await processRatingProfileGameProjection(
      operationId,
      ratingRepository(ratingUpdate(), state),
      runtime(calls),
      () => 100,
      rtdb,
      "owner-a",
    ),
    "done",
  );
  assert.equal(current, null);
  assert.equal(releaseAttempts, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(state.marks, [{ state: "done" }]);
});

test("rating projection dead-letters invalid records and retries missing markers", async () => {
  const invalidState = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  assert.equal(
    await processRatingProfileGameProjection(
      operationId,
      ratingRepository(
        ratingUpdate({ profileGameProjectionVersion: 2 }),
        invalidState,
      ),
      runtime([]),
      () => 300,
      projectionLockRtdb(),
    ),
    "dead",
  );
  assert.deepEqual(invalidState.marks, [
    { state: "dead", reason: "invalid-record" },
  ]);

  const missingState = { marker: null, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  await assert.rejects(
    () =>
      processRatingProfileGameProjection(
        operationId,
        ratingRepository(ratingUpdate(), missingState),
        runtime([]),
        () => 300,
        projectionLockRtdb(),
      ),
    /marker-pending/,
  );
  assert.deepEqual(missingState.marks, []);
});

test("profile game projection Queue acknowledges poison and retries transient work", async () => {
  const invalid = queueMessage({ invalid: true });
  await handleProfileGameProjectionMessage(invalid.message, TELEGRAM_TEST_ENV, {
    logger: { error() {}, info() {} },
  });
  assert.equal(invalid.acknowledgements(), 1);
  assert.deepEqual(invalid.retries, []);

  const failed = queueMessage(
    { kind: "rating-profile-game-projection", operationId },
    4,
  );
  await handleProfileGameProjectionMessage(failed.message, TELEGRAM_TEST_ENV, {
    createRating: () => {
      throw new Error("temporary");
    },
    logger: { error() {}, info() {} },
  });
  assert.equal(failed.acknowledgements(), 0);
  assert.deepEqual(failed.retries, [{ delaySeconds: 8 }]);
  assert.equal(profileGameProjectionRetryDelaySeconds(100), 60);
});

test("automatch Queue retries transient work without settling its outbox", async () => {
  const failed = queueMessage(automatchTask(), 3);
  const outboxPath = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const values = new Map<string, unknown>([[outboxPath, automatchOutbox()]]);
  let transactions = 0;
  await handleProfileGameProjectionMessage(failed.message, TELEGRAM_TEST_ENV, {
    createRtdb: () => ({
      getRtdbPath: async (path) => values.get(path),
      transactRtdbPath: async (path, updater) => {
        transactions++;
        const result = applyRtdbTransaction(values.get(path), updater);
        if (result.committed) {
          values.set(path, result.value);
        }
        return result;
      },
    }),
    createRuntime: () => ({
      recomputeInviteProjection: async () => {
        throw new Error("temporary-projection-failure");
      },
    }),
    logger: { error() {}, info() {} },
  });
  assert.equal(failed.acknowledgements(), 0);
  assert.deepEqual(failed.retries, [{ delaySeconds: 4 }]);
  assert.equal(transactions, 2);
  assert.deepEqual(values.get(outboxPath), automatchOutbox());
});

test("event Queue retries transient work without settling its outbox", async () => {
  const failed = queueMessage(eventTask(), 3);
  const outboxPath = "profileGameProjectionOutbox/event/event-1";
  const values = new Map<string, unknown>([[outboxPath, eventOutbox()]]);
  await handleProfileGameProjectionMessage(failed.message, TELEGRAM_TEST_ENV, {
    createEventRuntime: () => ({
      reconcileEventProjection: async () => {
        throw new Error("temporary-event-projection-failure");
      },
    }),
    createRtdb: () => projectionLockRtdb(values),
    logger: { error() {}, info() {} },
  });
  assert.equal(failed.acknowledgements(), 0);
  assert.deepEqual(failed.retries, [{ delaySeconds: 4 }]);
  assert.deepEqual(values.get(outboxPath), eventOutbox());
});

test("profile-link Queue immediately dispatches the next capped page", async () => {
  const message = queueMessage(profileLinkTask());
  const outboxPath = "profileGameProjectionOutbox/profile/login-1";
  const values = new Map<string, unknown>([[outboxPath, profileLinkOutbox()]]);
  const sent: unknown[] = [];
  await handleProfileGameProjectionMessage(
    message.message,
    {
      ...TELEGRAM_TEST_ENV,
      PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
        send: async (body: unknown) => {
          sent.push(body);
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      },
    },
    {
      createRtdb: () => projectionLockRtdb(values),
      createRuntime: () => runtime([]),
      logger: { error() {}, info() {} },
      now: () => 300,
      processProfileLink: async () => ({
        didHitInviteCap: true,
        nextMatchCursor: "match-300",
      }),
    },
  );
  assert.equal(message.acknowledgements(), 1);
  assert.deepEqual(sent, [profileLinkTask()]);
  assert.deepEqual(
    values.get(outboxPath),
    profileLinkOutbox("profile-request-1", 300, "match-300"),
  );
});

test("profile-link Queue reports missing after exact settlement", async () => {
  const message = queueMessage(profileLinkTask());
  const outboxPath = "profileGameProjectionOutbox/profile/login-1";
  const values = new Map<string, unknown>([[outboxPath, profileLinkOutbox()]]);
  const logs: string[] = [];
  await handleProfileGameProjectionMessage(message.message, TELEGRAM_TEST_ENV, {
    createRtdb: () => projectionLockRtdb(values),
    createRuntime: () => runtime([]),
    logger: {
      error() {},
      info: (entry) => logs.push(String(entry)),
    },
    processProfileLink: async () => null,
  });
  assert.equal(message.acknowledgements(), 1);
  assert.equal(values.get(outboxPath), null);
  assert.equal(JSON.parse(logs.at(-1) || "{}").status, "missing");
});

test("profile game projection Queue keeps exhausted infrastructure work pending", async () => {
  const exhausted = queueMessage(
    { kind: "rating-profile-game-projection", operationId },
    100,
  );
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  await handleProfileGameProjectionMessage(
    exhausted.message,
    TELEGRAM_TEST_ENV,
    {
      createRating: () => ratingRepository(ratingUpdate(), state),
      createRtdb: () => projectionLockRtdb(),
      createRuntime: () => ({
        recomputeInviteProjection: async () => {
          throw new Error("persistent-failure");
        },
      }),
      logger: { error() {}, info() {} },
      now: () => 300,
    },
  );
  assert.equal(exhausted.acknowledgements(), 0);
  assert.deepEqual(exhausted.retries, [{ delaySeconds: 60 }]);
  assert.deepEqual(state.marks, []);
});

test("Worker Queue routing selects the profile game projection consumer", async () => {
  const invalid = queueMessage({
    kind: "rating-profile-game-projection",
    operationId: "unsafe/path",
  } satisfies ProfileGameProjectionTask);
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (message) => {
    logs.push(String(message));
  };
  try {
    await worker.queue?.(
      {
        messages: [invalid.message],
        queue: PROFILE_GAME_PROJECTION_QUEUE_NAME,
        metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
        ackAll() {},
        retryAll() {},
      },
      TELEGRAM_TEST_ENV,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(invalid.acknowledgements(), 1);
  assert.equal(
    logs.some((entry) =>
      entry.includes("profile_game_projection_queue_invalid_message"),
    ),
    true,
  );
});

test("scheduled recovery claims, repairs, and batches valid projection records", async () => {
  const batches: ProfileGameProjectionTask[][] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(
          ({ body }) => body as ProfileGameProjectionTask,
        ),
      );
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    },
  } satisfies Queue;
  const env = {
    ...TELEGRAM_TEST_ENV,
    PROFILE_GAME_PROJECTION_QUEUE: queue,
  } satisfies Env;
  const state = { marker: null, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  const rating = ratingRepository(ratingUpdate(), state);
  rating.listDueRatingProfileGameProjections = async (
    updatedBeforeMs,
    limit,
  ) => {
    assert.equal(updatedBeforeMs, 600_000);
    assert.equal(limit, 10);
    return [
      {
        inviteId: "auto_aaaaaaaaaaa",
        matchId: "auto_aaaaaaaaaaa",
        operationId,
        updateTime: "2026-08-25T00:00:00Z",
        version: 1,
      },
      {
        inviteId: "bad",
        matchId: "bad",
        operationId: "mismatch",
        updateTime: "2026-08-25T00:00:01Z",
        version: 1,
      },
    ];
  };
  const claims: string[] = [];
  rating.claimRatingProfileGameProjection = async (claimedOperationId) => {
    claims.push(claimedOperationId);
    return true;
  };

  assert.equal(
    await sweepRatingProfileGameProjections(env, {
      createRating: () => rating,
      logger: { error() {}, info() {} },
      now: () => 600_000,
    }),
    1,
  );
  assert.deepEqual(claims.sort(), ["mismatch", operationId].sort());
  assert.deepEqual(state.patches, [
    {
      "invites/auto_aaaaaaaaaaa/matchesRatingUpdates/auto_aaaaaaaaaaa": true,
    },
  ]);
  assert.deepEqual(state.marks, [
    { state: "dead", reason: "invalid-recovery-marker" },
  ]);
  assert.deepEqual(batches.flat(), [
    { kind: "rating-profile-game-projection", operationId },
  ]);
});

test("scheduled recovery bounds concurrent claims", async () => {
  const rating = ratingRepository(null, {
    marker: null,
    marks: [],
    patches: [],
  });
  rating.listDueRatingProfileGameProjections = async () =>
    Array.from({ length: 25 }, (_, index) => ({
      inviteId: `auto_${String(index).padStart(11, "a")}`,
      matchId: `auto_${String(index).padStart(11, "a")}`,
      operationId: `operation-${index}`,
      updateTime: `update-${index}`,
      version: 1,
    }));
  let active = 0;
  let maximum = 0;
  rating.claimRatingProfileGameProjection = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return false;
  };
  assert.equal(
    await sweepRatingProfileGameProjections(TELEGRAM_TEST_ENV, {
      createRating: () => rating,
      now: () => 600_000,
    }),
    0,
  );
  assert.equal(maximum, 10);
});

test("event recovery normalizes every non-null malformed marker", async () => {
  const runRepair = async (value: unknown, eventId = "event-1") => {
    let current = value;
    const result = await repairInvalidEventSweepEntry(
      {
        getRtdbPath: async () => null,
        transactRtdbPath: async (_path, updater) => {
          const transaction = applyRtdbTransaction(current, updater);
          if (transaction.committed) {
            current = transaction.value;
          }
          return transaction;
        },
      },
      eventId,
      600_000,
      () => "repair-request",
    );
    return { current, result };
  };
  const repairedResult = {
    kind: "repaired" as const,
    task: {
      kind: "event-profile-game-projection" as const,
      eventId: "event-1",
      requestId: "repair-request",
    },
  };
  for (const [value, cleanupOwnerProfileIds] of [
    [
      {
        status: "bad",
        cleanupOwnerProfileIds: {
          "owner-object": false,
          "unsafe/path": true,
        },
      },
      ["owner-object"],
    ],
    [
      { status: "bad", cleanupOwnerProfileIds: "owner-string" },
      ["owner-string"],
    ],
    [
      {
        status: "bad",
        cleanupOwnerProfileIds: ["owner-array", "unsafe/path", 7],
      },
      ["owner-array"],
    ],
    ["corrupt", []],
    [false, []],
    [["corrupt"], []],
  ] as Array<[unknown, string[]]>) {
    assert.deepEqual(await runRepair(value), {
      result: repairedResult,
      current: {
        schemaVersion: 1,
        status: "pending",
        requestId: "repair-request",
        lastQueuedAtMs: 600_000,
        cleanupOwnerProfileIds: Object.fromEntries(
          cleanupOwnerProfileIds.map((profileId) => [profileId, true]),
        ),
      },
    });
  }

  const concurrent = eventOutbox("concurrent-request", 700_000);
  assert.deepEqual(await runRepair(null), {
    current: null,
    result: { kind: "changed" },
  });
  assert.deepEqual(await runRepair(concurrent), {
    current: concurrent,
    result: { kind: "changed" },
  });
  assert.deepEqual(await runRepair({ status: "bad" }, "unsafe/path"), {
    current: null,
    result: { kind: "removed" },
  });
});

test("event recovery claims due outboxes and repairs malformed records", async () => {
  const batches: ProfileGameProjectionTask[][] = [];
  const logs: string[] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(
          ({ body }) => body as ProfileGameProjectionTask,
        ),
      );
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    },
  } satisfies Queue;
  const values = new Map<string, unknown>([
    ["event-1", eventOutbox("event-request-1", 100)],
    [
      "event-bad",
      {
        ...eventOutbox("event-request-2", 200),
        status: "bad",
        cleanupOwnerProfileIds: { "stale-profile": false },
      },
    ],
    ["event-negative", { ...eventOutbox(), lastQueuedAtMs: -1 }],
    ["event-boolean", { ...eventOutbox(), lastQueuedAtMs: false }],
  ]);
  const rtdb = {
    getRtdbPath: async (path: string, query?: Record<string, unknown>) => {
      assert.equal(path, "profileGameProjectionOutbox/event");
      if (query?.endAt === 300_000) {
        return Object.fromEntries(values);
      }
      assert.deepEqual(query, {
        orderBy: "lastQueuedAtMs",
        startAt: "",
        limitToFirst: 10,
      });
      return null;
    },
    transactRtdbPath: async (
      path: string,
      updater: (current: unknown) => unknown,
    ) => {
      const eventId = path.split("/").at(-1) || "";
      const result = applyRtdbTransaction(values.get(eventId), updater);
      if (result.committed) {
        values.set(eventId, result.value);
      }
      return result;
    },
  };
  const requestIds = ["repair-bad", "repair-negative", "repair-boolean"];
  assert.equal(
    await sweepEventProfileGameProjections(
      {
        ...TELEGRAM_TEST_ENV,
        PROFILE_GAME_PROJECTION_QUEUE: queue,
      },
      {
        createRequestId: () => requestIds.shift() || "unexpected",
        createRtdb: () => rtdb,
        logger: { error: (message) => logs.push(String(message)), info() {} },
        now: () => 600_000,
      },
    ),
    4,
  );
  assert.deepEqual(batches.flat(), [
    {
      kind: "event-profile-game-projection",
      eventId: "event-bad",
      requestId: "repair-bad",
    },
    {
      kind: "event-profile-game-projection",
      eventId: "event-negative",
      requestId: "repair-negative",
    },
    {
      kind: "event-profile-game-projection",
      eventId: "event-boolean",
      requestId: "repair-boolean",
    },
    eventTask(),
  ]);
  assert.deepEqual(values.get("event-1"), {
    ...eventOutbox("event-request-1", 100),
    lastQueuedAtMs: 600_000,
  });
  assert.deepEqual(values.get("event-bad"), {
    schemaVersion: 1,
    status: "pending",
    requestId: "repair-bad",
    lastQueuedAtMs: 600_000,
    cleanupOwnerProfileIds: { "stale-profile": true },
  });
  assert.deepEqual(values.get("event-negative"), {
    schemaVersion: 1,
    status: "pending",
    requestId: "repair-negative",
    lastQueuedAtMs: 600_000,
    cleanupOwnerProfileIds: { "stale-profile": true },
  });
  assert.deepEqual(values.get("event-boolean"), {
    schemaVersion: 1,
    status: "pending",
    requestId: "repair-boolean",
    lastQueuedAtMs: 600_000,
    cleanupOwnerProfileIds: { "stale-profile": true },
  });
  assert.equal(
    logs.some(
      (entry) =>
        entry.includes(
          "event_profile_game_projection_invalid_outboxes_recovered",
        ) && entry.includes('"repaired":3'),
    ),
    true,
  );
});

test("automatch recovery claims due outboxes, repairs poison, and preserves source time", async () => {
  const batches: ProfileGameProjectionTask[][] = [];
  const logs: string[] = [];
  const queue = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(
          ({ body }) => body as ProfileGameProjectionTask,
        ),
      );
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    },
  } satisfies Queue;
  const values = new Map<string, unknown>([
    ["auto_aaaaaaaaaaa", automatchOutbox("request-1", 50, 100)],
    ["auto_bbbbbbbbbbb", { ...automatchOutbox("unsafe/path", 60, 200) }],
    [
      "auto_ccccccccccc",
      {
        schemaVersion: 1,
        status: "pending",
        requestId: "request-3",
        sourceUpdatedAtMs: 70,
      },
    ],
    ["auto_ddddddddddd", "invalid"],
    [
      "auto_eeeeeeeeeee",
      { ...automatchOutbox("request-5", 80, 200), lastQueuedAtMs: "bad" },
    ],
    [
      "auto_fffffffffff",
      {
        ...automatchOutbox("request-6", 90, 200),
        lastQueuedAtMs: { invalid: true },
      },
    ],
  ]);
  const rtdb = {
    getRtdbPath: async (path: string, query?: Record<string, unknown>) => {
      assert.equal(path, "profileGameProjectionOutbox/automatch");
      if (query?.endAt === 300_000) {
        return Object.fromEntries(
          [...values].filter(
            ([inviteId]) =>
              inviteId !== "auto_eeeeeeeeeee" &&
              inviteId !== "auto_fffffffffff",
          ),
        );
      }
      assert.deepEqual(query, {
        orderBy: "lastQueuedAtMs",
        startAt: "",
        limitToFirst: 10,
      });
      return Object.fromEntries(
        [...values].filter(
          ([inviteId]) =>
            inviteId === "auto_eeeeeeeeeee" || inviteId === "auto_fffffffffff",
        ),
      );
    },
    transactRtdbPath: async (
      path: string,
      updater: (current: unknown) => unknown,
    ) => {
      const inviteId = path.split("/").at(-1) || "";
      const result = applyRtdbTransaction(values.get(inviteId), updater);
      if (result.committed) {
        values.set(inviteId, result.value);
      }
      return result;
    },
  };
  const requestIds = [
    "repair-1",
    "repair-2",
    "repair-3",
    "repair-4",
    "repair-5",
  ];
  assert.equal(
    await sweepAutomatchProfileGameProjections(
      {
        ...TELEGRAM_TEST_ENV,
        PROFILE_GAME_PROJECTION_QUEUE: queue,
      },
      {
        createRequestId: () => requestIds.shift() || "unexpected",
        createRtdb: () => rtdb,
        logger: { error: (message) => logs.push(String(message)), info() {} },
        now: () => 600_000,
      },
    ),
    6,
  );
  assert.deepEqual(batches.flat(), [
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_bbbbbbbbbbb",
      requestId: "repair-1",
    },
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_ccccccccccc",
      requestId: "repair-2",
    },
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_ddddddddddd",
      requestId: "repair-3",
    },
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_eeeeeeeeeee",
      requestId: "repair-4",
    },
    {
      kind: "automatch-profile-game-projection",
      inviteId: "auto_fffffffffff",
      requestId: "repair-5",
    },
    automatchTask(),
  ]);
  assert.deepEqual(values.get("auto_aaaaaaaaaaa"), {
    ...automatchOutbox("request-1", 50, 100),
    lastQueuedAtMs: 600_000,
  });
  assert.deepEqual(
    values.get("auto_bbbbbbbbbbb"),
    automatchOutbox("repair-1", 60, 600_000),
  );
  assert.deepEqual(
    values.get("auto_ccccccccccc"),
    automatchOutbox("repair-2", 70, 600_000),
  );
  assert.deepEqual(
    values.get("auto_ddddddddddd"),
    automatchOutbox("repair-3", 600_000, 600_000),
  );
  assert.deepEqual(
    values.get("auto_eeeeeeeeeee"),
    automatchOutbox("repair-4", 80, 600_000),
  );
  assert.deepEqual(
    values.get("auto_fffffffffff"),
    automatchOutbox("repair-5", 90, 600_000),
  );
  assert.equal(
    logs.some(
      (entry) =>
        entry.includes("profile_game_projection_invalid_outboxes_recovered") &&
        entry.includes('"repaired":5') &&
        entry.includes('"removed":0'),
    ),
    true,
  );
});

test("automatch recovery claims an outbox only once", async () => {
  let current: unknown = automatchOutbox("request-1", 50, 100);
  const rtdb = {
    getRtdbPath: async () => current,
    transactRtdbPath: async (
      _path: string,
      updater: (value: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(current, updater);
      if (result.committed) {
        current = result.value;
      }
      return result;
    },
  };
  const candidate = {
    lastQueuedAtMs: 100,
    task: automatchTask(),
  };
  assert.deepEqual(
    await Promise.all([
      claimAutomatchSweepCandidate(rtdb, candidate, 600_000),
      claimAutomatchSweepCandidate(rtdb, candidate, 600_000),
    ]),
    [true, false],
  );
  assert.deepEqual(current, {
    ...automatchOutbox("request-1", 50, 100),
    lastQueuedAtMs: 600_000,
  });
});

test("profile-link recovery claims due markers on the existing Queue", async () => {
  const batches: ProfileGameProjectionTask[][] = [];
  let current: unknown = profileLinkOutbox("profile-request-1", 100);
  const queue = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
    sendBatch: async (messages: Iterable<MessageSendRequest<unknown>>) => {
      batches.push(
        Array.from(messages).map(
          ({ body }) => body as ProfileGameProjectionTask,
        ),
      );
      return {
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      };
    },
  } satisfies Queue;
  const rtdb = {
    getRtdbPath: async (_path: string, query?: Record<string, unknown>) =>
      query?.endAt === 300_000 ? { "login-1": current } : null,
    transactRtdbPath: async (
      _path: string,
      updater: (value: unknown) => unknown,
    ) => {
      const result = applyRtdbTransaction(current, updater);
      if (result.committed) current = result.value;
      return result;
    },
  };
  assert.equal(
    await sweepProfileLinkProfileGameProjections(
      {
        ...TELEGRAM_TEST_ENV,
        PROFILE_GAME_PROJECTION_QUEUE: queue,
      },
      {
        createRtdb: () => rtdb,
        now: () => 600_000,
      },
    ),
    1,
  );
  assert.deepEqual(batches.flat(), [profileLinkTask()]);
  assert.deepEqual(current, {
    ...profileLinkOutbox("profile-request-1", 100),
    lastQueuedAtMs: 600_000,
  });
});
