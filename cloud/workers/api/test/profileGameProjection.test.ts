import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { Color, Game, GameVariant } from "mons-rules";
import { createEventProfileGameProjectionCore } from "../../../functions/eventProfileGameProjectionCore.js";
import { createEventLockManagerCore } from "../../../functions/events/lockManagerCore.js";
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
  sweepProfileGameProjections,
} from "../src/profileGameProjection.ts";
import {
  buildAutomatchProfileGameProjectionOutboxMergeUpdates,
  buildAutomatchProfileGameProjectionOutboxUpdates,
  buildEventProfileGameProjectionOutboxUpdates,
  buildProfileLinkProfileGameProjectionOutbox,
  parseAutomatchProfileGameProjectionOutbox,
  parseEventProfileGameProjectionOutbox,
  parseProfileLinkProfileGameProjectionOutbox,
  salvageProfileLinkCleanupProfileIds,
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
import { buildTransitionHistoricalMatchPair } from "../src/historicalMatches.ts";
import worker from "../src/workerHandler.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

import {
  ProfileGameProjectionLockFailure,
  PROFILE_GAME_PROJECTION_LOCK_MS,
  type ProfileGameProjectionLockStore,
} from "../src/profileGameProjectionLocksD1.ts";

let locks: ProfileGameProjectionLockStore;
let lockValues: Map<string, { ownerId: string; expiresAtMs: number }>;
beforeEach(() => {
  lockValues = new Map();
  locks = {
    async acquire(lock, ownerId, nowMs) {
      const key = lock.scope + ":" + lock.resourceId;
      if ((lockValues.get(key)?.expiresAtMs ?? -1) > nowMs) {
        throw new ProfileGameProjectionLockFailure("busy", lock.scope);
      }
      lockValues.set(key, {
        ownerId,
        expiresAtMs: nowMs + PROFILE_GAME_PROJECTION_LOCK_MS,
      });
    },
    async release(lock, ownerId) {
      const key = lock.scope + ":" + lock.resourceId;
      if (lockValues.get(key)?.ownerId === ownerId) lockValues.delete(key);
    },
    async deleteExpired() {
      return 0;
    },
  };
});

function assertActiveRtdbPath(path: string): void {
  assert.doesNotMatch(
    path,
    /^profileGameProjectionLocks\/(automatch|profile)(?:\/|$)/,
  );
}

const operationId = "auto_aaaaaaaaaaa__auto_aaaaaaaaaaa";
const transitionFen = new Game().toFen();
const silentLogger = {
  error: () => undefined,
  info: () => undefined,
};

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
    readProfileOwnershipSnapshot: async () => ({
      canonicalProfileIdByProfileId: new Map(),
      loginOwnerByUid: new Map(),
      loginUidsByProfileId: new Map(),
      profileById: new Map(),
    }),
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
    getRtdbPath: async (path: string) => {
      assertActiveRtdbPath(path);
      return values.get(path);
    },
    transactRtdbPath: async (
      path: string,
      updater: (current: unknown) => unknown,
    ) => {
      assertActiveRtdbPath(path);
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
  const merged = buildAutomatchProfileGameProjectionOutboxMergeUpdates({
    historicalMatches: [
      {
        finalizedAtMs: 50,
        guestPlayerId: "guest",
        hostPlayerId: "host",
        matchId: "auto_aaaaaaaaaaa",
        source: "transition",
      },
      {
        finalizedAtMs: 150,
        guestPlayerId: "guest",
        hostPlayerId: "host",
        matchId: "auto_aaaaaaaaaaa1",
        source: "transition",
      },
    ],
    inviteId: "auto_aaaaaaaaaaa",
    requestId: "request-new",
    timestamp: 200,
  });
  assert.deepEqual(
    Object.keys(merged)
      .filter((key) => key.includes("/historicalMatches/"))
      .map((key) => key.split("/historicalMatches/")[1])
      .sort(),
    ["auto_aaaaaaaaaaa", "auto_aaaaaaaaaaa1"],
  );
});

test("transition archives require complete terminal consistent pairs", () => {
  const hostMatch = {
    version: 2,
    color: "white" as const,
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: transitionFen,
    status: "surrendered",
    flatMovesString: "",
    timer: "",
  };
  const guestMatch = {
    ...hostMatch,
    color: "black" as const,
    emojiId: 2,
    status: "",
  };
  const input = {
    matchId: "auto_aaaaaaaaaaa",
    hostPlayerId: "host",
    guestPlayerId: "guest",
    hostMatch,
    guestMatch,
  };
  assert.ok(buildTransitionHistoricalMatchPair(input));
  assert.equal(
    buildTransitionHistoricalMatchPair({ ...input, guestMatch: null }),
    null,
  );
  assert.equal(
    buildTransitionHistoricalMatchPair({
      ...input,
      hostMatch: { ...hostMatch, status: "" },
    }),
    null,
  );
  assert.equal(
    buildTransitionHistoricalMatchPair({
      ...input,
      guestMatch: { ...guestMatch, color: "white" },
    }),
    null,
  );
  const normalizedVariant = buildTransitionHistoricalMatchPair({
    ...input,
    guestMatch: { ...guestMatch, gameVariant: "SwappedManaRows" },
  });
  assert.equal(normalizedVariant?.hostMatch?.gameVariant, "Classic");
  assert.equal(normalizedVariant?.guestMatch?.gameVariant, "Classic");

  const unrelatedGame = new Game();
  const unrelatedMove = unrelatedGame.suggestMove("fast");
  assert.ok(unrelatedMove);
  unrelatedGame.playFen(unrelatedMove.inputFen);
  assert.equal(
    buildTransitionHistoricalMatchPair({
      ...input,
      guestMatch: { ...guestMatch, fen: unrelatedGame.toFen() },
    }),
    null,
  );

  const swappedFen = new Game({
    variant: GameVariant.SwappedManaRows,
  }).toFen();
  const canonicalVariant = buildTransitionHistoricalMatchPair({
    ...input,
    hostMatch: {
      ...hostMatch,
      gameVariant: "x".repeat(257),
      fen: swappedFen,
    },
    guestMatch: {
      ...guestMatch,
      gameVariant: GameVariant.SwappedManaRows,
      fen: swappedFen,
    },
  });
  assert.equal(
    canonicalVariant?.hostMatch?.gameVariant,
    GameVariant.SwappedManaRows,
  );
  assert.equal(
    canonicalVariant?.guestMatch?.gameVariant,
    GameVariant.SwappedManaRows,
  );

  const completedGame = new Game();
  const moves = { white: [] as string[], black: [] as string[] };
  let whiteFen = completedGame.toFen();
  let blackFen = completedGame.toFen();
  for (let turn = 0; turn < 400 && completedGame.winner === undefined; turn++) {
    const color = completedGame.activeColor;
    const suggestion = completedGame.suggestMove("fast");
    assert.ok(suggestion);
    completedGame.playFen(suggestion.inputFen);
    if (color === Color.White) {
      moves.white.push(suggestion.inputFen);
      whiteFen = completedGame.toFen();
    } else {
      moves.black.push(suggestion.inputFen);
      blackFen = completedGame.toFen();
    }
  }
  assert.notEqual(completedGame.winner, undefined);
  assert.equal(
    buildTransitionHistoricalMatchPair({
      ...input,
      hostMatch: {
        ...hostMatch,
        status: "",
        flatMovesString: moves.white.join("-"),
      },
      guestMatch: {
        ...guestMatch,
        flatMovesString: moves.black.join("-"),
      },
    }),
    null,
  );
  assert.ok(
    buildTransitionHistoricalMatchPair({
      ...input,
      hostMatch: {
        ...hostMatch,
        fen: whiteFen,
        status: "",
        flatMovesString: moves.white.join("-"),
      },
      guestMatch: {
        ...guestMatch,
        fen: blackFen,
        flatMovesString: moves.black.join("-"),
      },
    }),
  );
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
    {
      ...profileLinkOutbox(),
      cleanupProfileIds: [],
    },
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
  assert.deepEqual(
    salvageProfileLinkCleanupProfileIds({
      cleanupProfileIds: {
        "older-profile": true,
        "ignored-profile": false,
        "unsafe/path": true,
      },
    }),
    ["older-profile"],
  );
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
      locks,
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
      locks,
    ),
    "stale",
  );
  assert.equal(calls.length, 1);
});

test("automatch projection archives accumulated historical descriptors", async () => {
  const outboxPath = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const descriptor = {
    finalizedAtMs: 150,
    guestPlayerId: "guest",
    hostPlayerId: "host",
    source: "transition",
  };
  const values = new Map<string, unknown>([
    [
      outboxPath,
      {
        ...automatchOutbox(),
        historicalMatches: { auto_aaaaaaaaaaa: descriptor },
      },
    ],
    [
      "players/host/matches/auto_aaaaaaaaaaa",
      {
        version: 2,
        color: "white",
        emojiId: 1,
        aura: "",
        gameVariant: "Classic",
        fen: transitionFen,
        status: "surrendered",
        flatMovesString: "",
        timer: "",
      },
    ],
    [
      "players/guest/matches/auto_aaaaaaaaaaa",
      {
        version: 2,
        color: "black",
        emojiId: 2,
        aura: "",
        gameVariant: "Classic",
        fen: transitionFen,
        status: "",
        flatMovesString: "",
        timer: "",
      },
    ],
  ]);
  const archived: unknown[] = [];
  const rtdb = projectionLockRtdb(values);
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask(),
      rtdb,
      {
        archiveHistoricalMatch: async (input) => {
          archived.push(input);
        },
        hasHistoricalMatch: async () => true,
        recomputeInviteProjection: async () => ({
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "automatch-queue",
          skipped: 0,
          sourceCleanupSafe: true,
        }),
      },
      locks,
    ),
    "projected",
  );
  assert.equal(archived.length, 1);
  assert.equal(
    (archived[0] as { pair: { matchId: string } }).pair.matchId,
    "auto_aaaaaaaaaaa",
  );
  assert.equal(values.get(outboxPath), null);
});

test("automatch projection settles descriptors already archived in D1", async () => {
  const outboxPath = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const values = new Map<string, unknown>([
    [
      outboxPath,
      {
        ...automatchOutbox(),
        historicalMatches: {
          auto_aaaaaaaaaaa: {
            finalizedAtMs: 150,
            guestPlayerId: "guest",
            hostPlayerId: "host",
            source: "transition",
          },
        },
      },
    ],
  ]);
  let archived = 0;
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask(),
      projectionLockRtdb(values),
      {
        archiveHistoricalMatch: async () => {
          archived++;
        },
        hasHistoricalMatch: async () => true,
        recomputeInviteProjection: async () => ({
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "automatch-queue",
          skipped: 0,
          sourceCleanupSafe: true,
        }),
      },
      locks,
      "owner",
      () => 300,
      silentLogger,
    ),
    "projected",
  );
  assert.equal(archived, 0);
  assert.equal(values.get(outboxPath), null);
});

test("automatch projection retries partial sources even when D1 has a row", async () => {
  const outboxPath = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const values = new Map<string, unknown>([
    [
      outboxPath,
      {
        ...automatchOutbox(),
        historicalMatches: {
          auto_aaaaaaaaaaa: {
            finalizedAtMs: 150,
            guestPlayerId: "guest",
            hostPlayerId: "host",
            source: "transition",
          },
        },
      },
    ],
    [
      "players/host/matches/auto_aaaaaaaaaaa",
      {
        version: 2,
        color: "white",
        emojiId: 1,
        aura: "",
        gameVariant: "Classic",
        fen: transitionFen,
        status: "surrendered",
        flatMovesString: "",
        timer: "",
      },
    ],
  ]);
  await assert.rejects(
    processAutomatchProfileGameProjection(
      automatchTask(),
      projectionLockRtdb(values),
      {
        archiveHistoricalMatch: async () => {
          throw new Error("must-not-archive-partial");
        },
        hasHistoricalMatch: async () => true,
        recomputeInviteProjection: async () => ({
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "automatch-queue",
          skipped: 0,
          sourceCleanupSafe: true,
        }),
      },
      locks,
      "owner",
      () => 300,
      silentLogger,
    ),
    /historical-match-source-unavailable/,
  );
  assert.notEqual(values.get(outboxPath), null);
});

test("automatch projection settles historical descriptors in bounded batches", async () => {
  const outboxPath = "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa";
  const matchIds = Array.from({ length: 11 }, (_, index) =>
    index === 0 ? "auto_aaaaaaaaaaa" : `auto_aaaaaaaaaaa${index}`,
  );
  const matchValue = {
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: transitionFen,
    status: "surrendered",
    flatMovesString: "",
    timer: "",
  };
  const values = new Map<string, unknown>([
    [
      outboxPath,
      {
        ...automatchOutbox(),
        historicalMatches: Object.fromEntries(
          matchIds.map((matchId) => [
            matchId,
            {
              finalizedAtMs: 150,
              guestPlayerId: "guest",
              hostPlayerId: "host",
              source: "transition",
            },
          ]),
        ),
      },
    ],
    ...matchIds.flatMap((matchId) => [
      [`players/host/matches/${matchId}`, matchValue] as const,
      [
        `players/guest/matches/${matchId}`,
        { ...matchValue, color: "black" },
      ] as const,
    ]),
  ]);
  const archived: unknown[] = [];
  assert.equal(
    await processAutomatchProfileGameProjection(
      automatchTask(),
      projectionLockRtdb(values),
      {
        archiveHistoricalMatch: async (input) => {
          archived.push(input);
        },
        recomputeInviteProjection: async () => ({
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "automatch-queue",
          skipped: 0,
          sourceCleanupSafe: true,
        }),
      },
      locks,
    ),
    "continued",
  );
  assert.equal(archived.length, 5);
  assert.equal(
    parseAutomatchProfileGameProjectionOutbox(values.get(outboxPath))
      ?.historicalMatches?.length,
    6,
  );
});

test("automatch projection settles later descriptors when an earlier one retries", async () => {
  const inviteId = "auto_aaaaaaaaaaa";
  const activeMatchId = inviteId;
  const finalMatchId = `${inviteId}1`;
  const outboxPath = `profileGameProjectionOutbox/automatch/${inviteId}`;
  const matchValue = {
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: transitionFen,
    status: "",
    flatMovesString: "",
    timer: "",
  };
  const values = new Map<string, unknown>([
    [
      outboxPath,
      {
        ...automatchOutbox(),
        historicalMatches: {
          [activeMatchId]: {
            finalizedAtMs: 150,
            guestPlayerId: "guest",
            hostPlayerId: "host",
            source: "transition",
          },
          [finalMatchId]: {
            finalizedAtMs: 160,
            guestPlayerId: "guest",
            hostPlayerId: "host",
            source: "transition",
          },
        },
      },
    ],
    [`players/host/matches/${activeMatchId}`, matchValue],
    [
      `players/guest/matches/${activeMatchId}`,
      { ...matchValue, color: "black" },
    ],
    [
      `players/host/matches/${finalMatchId}`,
      { ...matchValue, status: "surrendered" },
    ],
    [
      `players/guest/matches/${finalMatchId}`,
      { ...matchValue, color: "black" },
    ],
  ]);
  const archived: string[] = [];
  await assert.rejects(
    processAutomatchProfileGameProjection(
      automatchTask(),
      projectionLockRtdb(values),
      {
        archiveHistoricalMatch: async ({ pair }) => {
          archived.push(pair.matchId);
        },
        recomputeInviteProjection: async () => ({
          inviteId,
          ok: true,
          reason: "automatch-queue",
          skipped: 0,
          sourceCleanupSafe: true,
        }),
      },
      locks,
      "owner",
      () => 300,
      silentLogger,
    ),
    /historical-match-source-unavailable/,
  );
  assert.deepEqual(archived, [finalMatchId]);
  assert.deepEqual(
    parseAutomatchProfileGameProjectionOutbox(
      values.get(outboxPath),
    )?.historicalMatches?.map(({ matchId }) => matchId),
    [activeMatchId],
  );
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
      assertActiveRtdbPath(path);
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
    locks,
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
        locks,
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
      locks,
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
      locks,
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
    cleanupProfileIds: {
      "ignored-profile": false,
      "older-profile": true,
      "unsafe/path": true,
    },
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

test("event projection cannot write after its lease is taken over", async () => {
  const outboxPath = "profileGameProjectionOutbox/event/event-1";
  const lockPath = "profileGameProjectionLocks/event/event-1";
  const values = new Map<string, unknown>([
    [outboxPath, eventOutbox("event-request-1", 200, [])],
  ]);
  const rtdb = projectionLockRtdb(values);
  const writes: unknown[][] = [];
  let nowMs = 0;
  let tookOver = false;
  const core = createEventProfileGameProjectionCore({
    now: () => nowMs,
    repository: {
      async commitProjectionWrites(nextWrites) {
        writes.push(nextWrites);
      },
      async getEvent() {
        return {
          eventId: "event-1",
          status: "scheduled",
          startAtMs: 100,
          updatedAtMs: 100,
          participants: {
            "removed-profile": {
              profileId: "removed-profile",
              loginUid: "removed-login",
            },
          },
        };
      },
      async readProfileOwnershipSnapshot({ loginUids, profileIds }) {
        if (!tookOver) {
          tookOver = true;
          nowMs = 31_000;
          const contender = createEventLockManagerCore({
            createLockId: () => "successor-lock",
            includeLegacyOwnerId: true,
            lockRoot: "profileGameProjectionLocks/event",
            now: () => nowMs,
            transactPath: rtdb.transactRtdbPath,
          });
          assert.ok(
            await contender.acquireEventLock("event-1", "successor-owner"),
          );
          values.delete(outboxPath);
        }
        return {
          canonicalProfileIdByProfileId: new Map(
            profileIds.map((profileId) => [
              profileId,
              profileId === "removed-profile" ? profileId : null,
            ]),
          ),
          loginOwnerByUid: new Map(
            loginUids.map((loginUid) => [
              loginUid,
              loginUid === "removed-login"
                ? { profileId: "removed-profile", revision: 1 }
                : null,
            ]),
          ),
        };
      },
    },
    wait: async () => undefined,
  });

  await assert.rejects(
    processEventProfileGameProjection(
      eventTask(),
      rtdb,
      core,
      "stale-owner",
      () => nowMs,
    ),
    /profile-game-projection-lock-lost/,
  );
  assert.deepEqual(writes, []);
  assert.equal(values.has(outboxPath), false);
  assert.equal(
    (values.get(lockPath) as { ownerUid?: string })?.ownerUid,
    "successor-owner",
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
      locks,
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
      locks,
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
      locks,
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
      locks,
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
      locks,
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
      locks,
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
    locks,
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
      locks,
    ),
    "stale",
  );
  assert.equal(calls.length, 1);
});

test("rating projection archives the frozen rating pair", async () => {
  const match = {
    version: 2,
    color: "white" as const,
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "fen",
    status: "surrendered",
    flatMovesString: "move",
    timer: "",
  };
  const pair = {
    matchId: "auto_aaaaaaaaaaa",
    hostPlayerId: "host",
    guestPlayerId: "guest",
    hostMatch: match,
    guestMatch: { ...match, color: "black" as const },
  };
  const archived: unknown[] = [];
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  assert.equal(
    await processRatingProfileGameProjection(
      operationId,
      ratingRepository(
        ratingUpdate({
          historicalMatchArchiveVersion: 1,
          historicalMatchPair: pair,
        }),
        state,
      ),
      {
        archiveHistoricalMatch: async (input) => {
          archived.push(input);
        },
        recomputeInviteProjection: async () => ({
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "invite-match-rating-updated",
          skipped: 0,
          sourceCleanupSafe: true,
        }),
      },
      () => 300,
      locks,
    ),
    "done",
  );
  assert.deepEqual(archived, [
    {
      finalizedAtMs: 200,
      inviteId: "auto_aaaaaaaaaaa",
      pair,
      source: "rating",
    },
  ]);

  const failedState = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  await assert.rejects(
    processRatingProfileGameProjection(
      operationId,
      ratingRepository(
        ratingUpdate({
          historicalMatchArchiveVersion: 1,
          historicalMatchPair: pair,
        }),
        failedState,
      ),
      {
        archiveHistoricalMatch: async () => {
          throw new Error("archive-failed");
        },
        recomputeInviteProjection: async () => ({
          inviteId: "auto_aaaaaaaaaaa",
          ok: true,
          reason: "invite-match-rating-updated",
          skipped: 0,
          sourceCleanupSafe: true,
        }),
      },
      () => 300,
      locks,
    ),
    /archive-failed/,
  );
  assert.deepEqual(failedState.marks, []);
});

test("new rating projections never complete without their frozen pair", async () => {
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  await assert.rejects(
    processRatingProfileGameProjection(
      operationId,
      ratingRepository(
        ratingUpdate({ historicalMatchArchiveVersion: 1 }),
        state,
      ),
      runtime([]),
      () => 300,
      locks,
    ),
    /historical-match-pair-missing/,
  );
  assert.deepEqual(state.marks, []);
});

test("rating projection does not re-enter an active projection lock", async () => {
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
    locks,
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
        locks,
        "owner-a",
      ),
    /lock-busy/,
  );
  releaseFirst?.();
  assert.equal(await first, "done");
  assert.equal(lockValues.size, 0);
});

test("rating projection keeps completion pending when lock release fails", async () => {
  const state = { marker: true, marks: [], patches: [] } as {
    marker: unknown;
    marks: Array<{ state: string; reason?: string }>;
    patches: Array<Record<string, unknown>>;
  };
  const release = locks.release;
  locks.release = async () => {
    throw new ProfileGameProjectionLockFailure("release", "invite");
  };
  await assert.rejects(
    processRatingProfileGameProjection(
      operationId,
      ratingRepository(ratingUpdate(), state),
      runtime([]),
      () => 100,
      locks,
      "owner-a",
    ),
    /lock-release-failed/,
  );
  assert.deepEqual(state.marks, []);
  assert.equal(lockValues.get("invite:auto_aaaaaaaaaaa")?.ownerId, "owner-a");
  locks.release = release;
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
      locks,
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
        locks,
      ),
    /marker-pending/,
  );
  assert.deepEqual(missingState.marks, []);
});

test("profile game projection Queue acknowledges poison and retries transient work", async () => {
  const invalid = queueMessage({ invalid: true });
  await handleProfileGameProjectionMessage(invalid.message, TELEGRAM_TEST_ENV, {
    createLocks: () => locks,
    logger: { error() {}, info() {} },
  });
  assert.equal(invalid.acknowledgements(), 1);
  assert.deepEqual(invalid.retries, []);

  const failed = queueMessage(
    { kind: "rating-profile-game-projection", operationId },
    4,
  );
  await handleProfileGameProjectionMessage(failed.message, TELEGRAM_TEST_ENV, {
    createLocks: () => locks,
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
    createLocks: () => locks,
    createRtdb: () => ({
      getRtdbPath: async (path) => values.get(path),
      transactRtdbPath: async (path, updater) => {
        transactions++;
        assertActiveRtdbPath(path);
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
  assert.equal(transactions, 0);
  assert.deepEqual(values.get(outboxPath), automatchOutbox());
});

test("event Queue retries transient work without settling its outbox", async () => {
  const failed = queueMessage(eventTask(), 3);
  const outboxPath = "profileGameProjectionOutbox/event/event-1";
  const values = new Map<string, unknown>([[outboxPath, eventOutbox()]]);
  await handleProfileGameProjectionMessage(failed.message, TELEGRAM_TEST_ENV, {
    createLocks: () => locks,
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
      createLocks: () => locks,
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
    createLocks: () => locks,
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
      createLocks: () => locks,
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
          "owner-true": true,
          "owner-object": false,
          "unsafe/path": true,
        },
      },
      ["owner-true"],
    ],
    [{ status: "bad", cleanupOwnerProfileIds: "owner-string" }, []],
    [
      {
        status: "bad",
        cleanupOwnerProfileIds: ["owner-array", "unsafe/path", 7],
      },
      [],
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
    cleanupOwnerProfileIds: {},
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

test("automatch, rating, and nested profile-link work share one invite lock", async () => {
  const values = new Map<string, unknown>([
    [
      "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa",
      automatchOutbox(),
    ],
    ["profileGameProjectionOutbox/profile/login-1", profileLinkOutbox()],
  ]);
  const rtdb = projectionLockRtdb(values);
  const invite = { scope: "invite" as const, resourceId: "auto_aaaaaaaaaaa" };
  await locks.acquire(invite, "existing-owner", 100);
  await assert.rejects(
    processAutomatchProfileGameProjection(
      automatchTask(),
      rtdb,
      runtime([]),
      locks,
      "automatch-owner",
      () => 200,
    ),
    /lock-busy/,
  );
  const state = { marker: true, marks: [], patches: [] };
  await assert.rejects(
    processRatingProfileGameProjection(
      operationId,
      ratingRepository(ratingUpdate(), state),
      runtime([]),
      () => 200,
      locks,
      "rating-owner",
    ),
    /lock-busy/,
  );
  let nestedRan = false;
  await assert.rejects(
    processProfileLinkProfileGameProjection(
      profileLinkTask(),
      rtdb,
      async (input) => {
        assert.equal(
          lockValues.get("profile-link:login-1")?.ownerId,
          "profile-owner",
        );
        await input.withInviteProjectionLock(invite.resourceId, async () => {
          nestedRan = true;
        });
        return null;
      },
      locks,
      "profile-owner",
      () => 200,
    ),
    /lock-busy/,
  );
  assert.equal(nestedRan, false);
  assert.equal(lockValues.has("profile-link:login-1"), false);
  assert.equal(
    lockValues.get("invite:auto_aaaaaaaaaaa")?.ownerId,
    "existing-owner",
  );
  assert.deepEqual(state.marks, []);
  assert.deepEqual(
    values.get("profileGameProjectionOutbox/profile/login-1"),
    profileLinkOutbox(),
  );
});

test("D1 lock acquisition failures retry without running or settling projections", async () => {
  for (const task of [automatchTask(), profileLinkTask()]) {
    const message = queueMessage(task, 2);
    const scope =
      task.kind === "automatch-profile-game-projection"
        ? "invite"
        : "profile-link";
    const outboxPath =
      task.kind === "automatch-profile-game-projection"
        ? "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa"
        : "profileGameProjectionOutbox/profile/login-1";
    const outbox = scope === "invite" ? automatchOutbox() : profileLinkOutbox();
    const values = new Map<string, unknown>([[outboxPath, outbox]]);
    const logs: string[] = [];
    let projected = false;
    await handleProfileGameProjectionMessage(
      message.message,
      TELEGRAM_TEST_ENV,
      {
        createLocks: () => ({
          ...locks,
          acquire: async () => {
            throw new ProfileGameProjectionLockFailure("acquire", scope);
          },
        }),
        createRtdb: () => projectionLockRtdb(values),
        createRuntime: () => ({
          recomputeInviteProjection: async () => {
            projected = true;
            throw new Error("unexpected-work");
          },
        }),
        processProfileLink: async () => {
          projected = true;
          return null;
        },
        logger: { info() {}, error: (entry) => logs.push(String(entry)) },
      },
    );
    assert.equal(projected, false);
    assert.equal(message.acknowledgements(), 0);
    assert.deepEqual(message.retries, [{ delaySeconds: 2 }]);
    assert.deepEqual(values.get(outboxPath), outbox);
    assert.equal(JSON.parse(logs.at(-1) || "{}").lockScope, scope);
  }
});

test("projection sweep cleans locks once and preserves enqueue work on cleanup failure", async () => {
  let cleanups = 0;
  let sends = 0;
  const values = new Map<string, unknown>([
    [
      "profileGameProjectionOutbox/automatch",
      {
        auto_aaaaaaaaaaa: automatchOutbox("request-1", 1, 1),
      },
    ],
    [
      "profileGameProjectionOutbox/automatch/auto_aaaaaaaaaaa",
      automatchOutbox("request-1", 1, 1),
    ],
  ]);
  const state = { marker: true, marks: [], patches: [] };
  const logs: string[] = [];
  await assert.rejects(
    sweepProfileGameProjections(
      {
        ...TELEGRAM_TEST_ENV,
        PROFILE_GAME_PROJECTION_QUEUE: {
          ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
          sendBatch: async (messages) => {
            sends += Array.from(messages).length;
            return {
              metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
            };
          },
        },
      },
      {
        createLocks: () => ({
          ...locks,
          deleteExpired: async (nowMs) => {
            assert.equal(nowMs, 1_000_000);
            cleanups++;
            throw new ProfileGameProjectionLockFailure("cleanup", "cleanup");
          },
        }),
        createRtdb: () => projectionLockRtdb(values),
        createRating: () => ratingRepository(null, state),
        now: () => 1_000_000,
        logger: { info() {}, error: (entry) => logs.push(String(entry)) },
      },
    ),
    /profile-game-projection-sweep-failed/,
  );
  assert.equal(cleanups, 1);
  assert.equal(sends, 1);
  assert.ok(
    logs.some(
      (entry) =>
        JSON.parse(entry).event ===
        "profile_game_projection_lock_cleanup_failed",
    ),
  );
});
