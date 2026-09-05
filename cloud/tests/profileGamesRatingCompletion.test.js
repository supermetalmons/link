"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createProfileGamesProjectionCore,
} = require("../functions/profileGamesProjectionCore");

const inviteId = "rating-event-invite";

const fixture = ({
  inviteFields = {},
  readCompletion = async () => false,
} = {}) => {
  const writes = [];
  const completionReads = [];
  const profiles = new Map([
    ["host-profile", { username: "host", emoji: 1 }],
    ["guest-profile", { username: "guest", emoji: 2 }],
  ]);
  const core = createProfileGamesProjectionCore({
    repository: {
      async commitProjectionWrites(nextWrites) {
        writes.push(...nextWrites);
      },
      getProjection: async () => null,
      async getRtdbPath(path) {
        if (path === `invites/${inviteId}`) {
          return {
            eventOwned: true,
            hostId: "host-login",
            guestId: "guest-login",
            ...inviteFields,
          };
        }
        if (path === `automatch/${inviteId}`) return null;
        throw new Error(`unexpected-rtdb-read:${path}`);
      },
      async hasCompletedRatingUpdate(readInviteId, matchId) {
        completionReads.push([readInviteId, matchId]);
        return readCompletion(readInviteId, matchId);
      },
      readProfileOwnershipSnapshot: async () => ({
        profileDataById: profiles,
        profileIdByLoginUid: new Map([
          ["host-login", "host-profile"],
          ["guest-login", "guest-profile"],
        ]),
      }),
    },
    wait: async () => undefined,
  });
  return {
    completionReads,
    recompute: (options = {}) =>
      core.recomputeInviteProjection(inviteId, "rating-completed", {
        eventTimestampMs: 100,
        ...options,
      }),
    writes,
  };
};

test("event games end from canonical rating completion without Firebase markers", async () => {
  const { completionReads, recompute, writes } = fixture({
    readCompletion: async () => true,
  });
  await recompute();

  assert.deepEqual(completionReads, [[inviteId, inviteId]]);
  assert.equal(writes.length, 2);
  assert.ok(writes.every((write) => write.data.status === "ended"));
});

test("Firebase completion markers cannot end an event game", async () => {
  const { recompute, writes } = fixture({
    inviteFields: { matchesRatingUpdates: { [inviteId]: true } },
  });
  await recompute();

  assert.equal(writes.length, 2);
  assert.ok(writes.every((write) => write.data.status === "active"));
});

test("event projection reads completion only for the latest match", async () => {
  const { completionReads, recompute, writes } = fixture({
    inviteFields: { hostRematches: "1", guestRematches: "1" },
    readCompletion: async (_inviteId, matchId) => matchId === inviteId,
  });
  await recompute({ latestMatchIdHint: inviteId });

  assert.deepEqual(completionReads, [[inviteId, `${inviteId}1`]]);
  assert.ok(writes.every((write) => write.data.status === "active"));
});

test("event projection retries completion failures without changing projections", async () => {
  const { completionReads, recompute, writes } = fixture({
    readCompletion: async () => {
      throw new Error("rating-completion-unavailable");
    },
  });

  await assert.rejects(recompute(), /rating-completion-unavailable/);
  assert.equal(completionReads.length, 2);
  assert.deepEqual(writes, []);
});

test("ordinary games do not read event rating completion", async () => {
  const { completionReads, recompute, writes } = fixture({
    inviteFields: { eventOwned: false },
    readCompletion: async () => {
      throw new Error("unexpected-rating-completion-read");
    },
  });
  await recompute();

  assert.deepEqual(completionReads, []);
  assert.ok(writes.every((write) => write.data.status === "active"));
});
