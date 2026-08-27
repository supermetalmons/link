import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventProjectionOwnerPlan,
  createEventProfileGameProjectionCore,
  type EventProfileGameProjectionRepository,
  type EventProjectionWrite,
} from "../../../functions/eventProfileGameProjectionCore.js";

function createRepository(input: {
  events?: Array<Record<string, unknown> | null>;
  mergeTargets?: Record<string, Record<string, unknown> | null>;
  profiles?: Record<string, Record<string, unknown> | null>;
}) {
  const writes: EventProjectionWrite[][] = [];
  const events = input.events || [null];
  let eventReadIndex = 0;
  const repository: EventProfileGameProjectionRepository = {
    async commitProjectionWrites(nextWrites) {
      writes.push(nextWrites);
    },
    async getEvent() {
      const index = Math.min(eventReadIndex, events.length - 1);
      eventReadIndex += 1;
      return events[index];
    },
    async getMergeTarget(profileId) {
      return input.mergeTargets?.[profileId] ?? null;
    },
    async getProfile(profileId) {
      const profile = input.profiles?.[profileId];
      return profile === undefined || profile === null
        ? null
        : { data: profile, updateTime: `update-${profileId}` };
    },
  };
  return { repository, writes };
}

function runtime(input: Parameters<typeof createRepository>[0]) {
  const state = createRepository(input);
  return {
    ...state,
    core: createEventProfileGameProjectionCore({
      now: () => 999,
      repository: state.repository,
      timestampFromMillis: (millis) => ({ timestamp: Math.max(1, millis) }),
      wait: async () => undefined,
    }),
  };
}

test("event owner plans write canonical owners before raw cleanup paths", () => {
  assert.deepEqual(
    buildEventProjectionOwnerPlan({
      afterOwnerPaths: [["source", "middle", "target"]],
      cleanupOwnerPaths: [["stale", "target"]],
      rawAfterOwnerProfileIds: ["source"],
    }),
    {
      afterOwnerProfileIds: ["target"],
      allOwnerProfileIds: ["target", "source", "middle", "stale"],
    },
  );
});

test("event projection preserves the payload and stale-owner cleanup", async () => {
  const { core, writes } = runtime({
    mergeTargets: {
      source: { targetProfileId: "target" },
      target: null,
      stale: null,
    },
    profiles: { target: {} },
  });
  const result = await core.projectEvent(
    "event-1",
    {
      status: "active",
      startAtMs: 100,
      startedAtMs: 110,
      updatedAtMs: 120,
      endedAtMs: 130,
      winnerDisplayName: " Winner ",
      participants: {
        source: {
          profileId: "source",
          displayName: "Player",
          emojiId: 7,
          aura: "gold",
          joinedAtMs: 1,
        },
      },
    },
    ["stale"],
  );
  assert.deepEqual(result, {
    deleted: 2,
    ownerProfileIds: ["target"],
    written: 1,
  });
  assert.deepEqual(
    writes[0].map(({ type, profileId }) => ({ type, profileId })),
    [
      { type: "merge", profileId: "target" },
      { type: "delete", profileId: "source" },
      { type: "delete", profileId: "stale" },
    ],
  );
  assert.deepEqual(writes[0][0].data, {
    schemaVersion: 1,
    source: "event-projector",
    entityType: "event",
    id: "event_event-1",
    eventId: "event-1",
    status: "active",
    sortBucket: 40,
    listSortAt: { timestamp: 110 },
    ownerProfileId: "target",
    startAt: { timestamp: 100 },
    updatedAt: { timestamp: 120 },
    endedAt: { timestamp: 130 },
    participantCount: 1,
    participantPreview: [
      {
        profileId: "source",
        displayName: "Player",
        emojiId: 7,
        aura: "gold",
      },
    ],
    winnerDisplayName: "Winner",
  });
});

test("event projection refuses missing and retired canonical owners", async () => {
  const missing = runtime({
    mergeTargets: { source: { targetProfileId: "missing" } },
    profiles: {},
  });
  await assert.rejects(
    () =>
      missing.core.projectEvent("event-1", {
        participants: { source: { profileId: "source" } },
      }),
    /projector:event-owner-missing:missing/,
  );
  assert.deepEqual(missing.writes, []);

  const retired = runtime({
    profiles: { retired: { mergedIntoProfileId: "canonical" } },
  });
  await assert.rejects(
    () =>
      retired.core.projectEvent("event-1", {
        participants: { retired: { profileId: "retired" } },
      }),
    /projector:event-owner-retired:retired/,
  );
  assert.deepEqual(retired.writes, []);
});

test("missing events delete every accumulated cleanup owner", async () => {
  const { core, writes } = runtime({ profiles: {} });
  assert.deepEqual(await core.reconcileEventProjection("event-1", ["a", "b"]), {
    deleted: 2,
    ownerProfileIds: [],
    status: "missing",
    written: 0,
  });
  assert.deepEqual(writes[0], [
    { type: "delete", profileId: "a", eventId: "event-1" },
    { type: "delete", profileId: "b", eventId: "event-1" },
  ]);
});

test("live reconciliation retains every observed owner until state converges", async () => {
  const { core, writes } = runtime({
    events: [
      { participants: { first: { profileId: "first" } } },
      { participants: { second: { profileId: "second" } } },
      { participants: { second: { profileId: "second" } } },
    ],
    profiles: { first: {}, second: {} },
  });
  const result = await core.reconcileEventProjection("event-1", ["stale"]);
  assert.equal(result.status, "projected");
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes[1].map(({ type, profileId }) => ({ type, profileId })),
    [
      { type: "merge", profileId: "second" },
      { type: "delete", profileId: "stale" },
      { type: "delete", profileId: "first" },
    ],
  );
});

test("event projection resolves owner paths with bounded concurrency", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `profile-${index}`);
  let active = 0;
  let maximum = 0;
  const repository: EventProfileGameProjectionRepository = {
    commitProjectionWrites: async () => undefined,
    getEvent: async () => null,
    getMergeTarget: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return null;
    },
    getProfile: async () => null,
  };
  const core = createEventProfileGameProjectionCore({
    repository,
    timestampFromMillis: (millis) => millis,
  });
  const paths = await core.resolveProfilePaths([...ids, ...ids]);
  assert.equal(paths.size, ids.length);
  assert.equal(maximum, 10);
});
