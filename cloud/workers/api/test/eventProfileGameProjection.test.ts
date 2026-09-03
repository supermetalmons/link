import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventProfileGameProjectionCore,
  type EventProfileGameProjectionRepository,
  type EventProjectionSourceFence,
  type EventProjectionWrite,
} from "../../../functions/eventProfileGameProjectionCore.js";

function createRepository(input: {
  canonicalProfileIds?: Record<string, string | null>;
  events?: Array<Record<string, unknown> | null>;
  loginProfileIds?: Record<string, string | null>;
}) {
  const writes: EventProjectionWrite[][] = [];
  const sourceFences: Array<EventProjectionSourceFence | undefined> = [];
  const events = input.events || [null];
  let eventReadIndex = 0;
  const repository: EventProfileGameProjectionRepository = {
    async commitProjectionWrites(nextWrites, sourceFence) {
      writes.push(nextWrites);
      sourceFences.push(sourceFence);
    },
    async getEvent() {
      const index = Math.min(eventReadIndex, events.length - 1);
      eventReadIndex += 1;
      return events[index];
    },
    async readProfileOwnershipSnapshot(query) {
      return {
        canonicalProfileIdByProfileId: new Map(
          query.profileIds.map((profileId) => [
            profileId,
            Object.hasOwn(input.canonicalProfileIds || {}, profileId)
              ? input.canonicalProfileIds?.[profileId] || null
              : null,
          ]),
        ),
        loginOwnerByUid: new Map(
          query.loginUids.map((loginUid) => {
            const profileId = input.loginProfileIds?.[loginUid] || null;
            return [loginUid, profileId ? { profileId, revision: 1 } : null];
          }),
        ),
      };
    },
  };
  return { repository, sourceFences, writes };
}

function runtime(input: Parameters<typeof createRepository>[0]) {
  const state = createRepository(input);
  return {
    ...state,
    core: createEventProfileGameProjectionCore({
      now: () => 999,
      repository: state.repository,
      wait: async () => undefined,
    }),
  };
}

test("event projection preserves the payload and stale-owner cleanup", async () => {
  const { core, writes } = runtime({
    canonicalProfileIds: {
      source: "target",
      stale: null,
    },
    loginProfileIds: { "login-1": "target" },
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
          loginUid: "login-1",
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
    listSortAt: 110,
    ownerProfileId: "target",
    startAt: 100,
    updatedAt: 120,
    endedAt: 130,
    participantCount: 1,
    participantPreview: [
      {
        profileId: "target",
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
    canonicalProfileIds: { source: null },
    loginProfileIds: { "login-1": null },
  });
  await assert.rejects(
    () =>
      missing.core.projectEvent("event-1", {
        participants: {
          source: { loginUid: "login-1", profileId: "source" },
        },
      }),
    /profile-ownership-unavailable/,
  );
  assert.deepEqual(missing.writes, []);

  const retired = runtime({
    canonicalProfileIds: { retired: "canonical" },
    loginProfileIds: { "login-1": "other-profile" },
  });
  await assert.rejects(
    () =>
      retired.core.projectEvent("event-1", {
        participants: {
          retired: { loginUid: "login-1", profileId: "retired" },
        },
      }),
    /profile-ownership-unavailable/,
  );
  assert.deepEqual(retired.writes, []);
});

test("missing events delete every accumulated cleanup owner", async () => {
  const { core, writes } = runtime({
    canonicalProfileIds: { a: null, b: null },
  });
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

test("live reconciliation projects one immutable event read", async () => {
  const { core, writes } = runtime({
    events: [
      {
        participants: {
          first: { loginUid: "login-first", profileId: "first" },
        },
      },
      {
        participants: {
          second: { loginUid: "login-second", profileId: "second" },
        },
      },
      {
        participants: {
          second: { loginUid: "login-second", profileId: "second" },
        },
      },
    ],
    canonicalProfileIds: {
      first: "first",
      second: "second",
      stale: null,
    },
    loginProfileIds: {
      "login-first": "first",
      "login-second": "second",
    },
  });
  const result = await core.reconcileEventProjection("event-1", ["stale"]);
  assert.equal(result.status, "projected");
  assert.equal(writes.length, 1);
  assert.deepEqual(
    writes[0].map(({ type, profileId }) => ({ type, profileId })),
    [
      { type: "merge", profileId: "first" },
      { type: "delete", profileId: "stale" },
    ],
  );
});

test("event projection reads one ownership snapshot", async () => {
  let ownershipReads = 0;
  const repository: EventProfileGameProjectionRepository = {
    commitProjectionWrites: async () => undefined,
    getEvent: async () => null,
    readProfileOwnershipSnapshot: async ({ loginUids, profileIds }) => {
      ownershipReads += 1;
      return {
        canonicalProfileIdByProfileId: new Map(
          profileIds.map((profileId) => [profileId, profileId]),
        ),
        loginOwnerByUid: new Map(
          loginUids.map((loginUid) => [
            loginUid,
            { profileId: loginUid.replace("login", "profile"), revision: 1 },
          ]),
        ),
      };
    },
  };
  const core = createEventProfileGameProjectionCore({
    repository,
  });
  await core.projectEvent("event-1", {
    participants: {
      "profile-1": { loginUid: "login-1", profileId: "profile-1" },
    },
  });
  assert.equal(ownershipReads, 1);
});

test("event projection forwards its monotonic source fence to the commit", async () => {
  const { core, sourceFences } = runtime({
    canonicalProfileIds: { "profile-1": "profile-1" },
    loginProfileIds: { "login-1": "profile-1" },
  });
  const sourceFence = { eventId: "event-1", generation: 3 };

  await core.projectEvent(
    "event-1",
    {
      participants: {
        "profile-1": { loginUid: "login-1", profileId: "profile-1" },
      },
    },
    [],
    { sourceFence },
  );

  assert.deepEqual(sourceFences, [sourceFence]);
});
