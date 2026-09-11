"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createProfileGamesProjectionCore,
} = require("../runtime/profileGamesProjectionCore");

const inviteId = "presentation-invite";
const guestMatchPath = `players/guest-login/matches/${inviteId}`;

function fixture({ getMatchEmoji, guestProfile = null }) {
  const writes = [];
  const reads = [];
  const presentationReads = [];
  const projections = new Map();
  const profiles = new Map([
    ["host-profile", { username: "host", emoji: 2 }],
    ...(guestProfile ? [["guest-profile", guestProfile]] : []),
  ]);
  const core = createProfileGamesProjectionCore({
    logger: { error() {} },
    repository: {
      async commitProjectionWrites(nextWrites) {
        for (const write of nextWrites) {
          writes.push(write);
          projections.set(write.profileId, {
            data: write.data,
            updateTime: String(writes.length),
          });
        }
      },
      getProjection: async (profileId) => projections.get(profileId) || null,
      async getStatePath(path) {
        reads.push(path);
        if (path === `invites/${inviteId}`) {
          return {
            hostId: "host-login",
            guestId: "guest-login",
            hostRematches: "x",
            guestRematches: "x",
          };
        }
        if (path === `automatch/${inviteId}`) return null;
        if (path === guestMatchPath) return { emojiId: 1, aura: "" };
        throw new Error(`unexpected-state-read:${path}`);
      },
      async getMatchEmoji(...args) {
        presentationReads.push(args);
        return getMatchEmoji(...args);
      },
      readProfileOwnershipSnapshot: async () => ({
        profileDataById: profiles,
        profileIdByLoginUid: new Map([
          ["host-login", "host-profile"],
          ["guest-login", guestProfile ? "guest-profile" : null],
        ]),
      }),
    },
    wait: async () => undefined,
  });
  return {
    reads,
    presentationReads,
    writes,
    recompute: () =>
      core.recomputeInviteProjection(inviteId, "rating-completed", {
        eventTimestampMs: 100,
      }),
  };
}

test("recomputation replaces an anonymous opponent's seed emoji with live presentation", async () => {
  let emoji = 1;
  const state = fixture({ getMatchEmoji: async () => emoji });
  await state.recompute();
  emoji = 7;
  await state.recompute();

  assert.deepEqual(
    state.writes.map((write) => write.data.opponentEmoji),
    [1, 7],
  );
  assert.deepEqual(state.presentationReads, [
    [inviteId, inviteId, "guest-login"],
    [inviteId, inviteId, "guest-login"],
  ]);
  assert.equal(state.writes[1].data.status, "ended");
  assert.equal(state.reads.includes(guestMatchPath), false);
});

test("canonical profile avatars retain precedence without reading match presentation", async () => {
  const state = fixture({
    guestProfile: { username: "guest", emoji: 3 },
    getMatchEmoji: async () => {
      throw new Error("unexpected-presentation-read");
    },
  });
  await state.recompute();

  assert.equal(
    state.writes.find((write) => write.profileId === "host-profile").data
      .opponentEmoji,
    3,
  );
  assert.deepEqual(state.presentationReads, []);
  assert.equal(state.reads.includes(guestMatchPath), false);
});

test("presentation failures retry without publishing a stale seed avatar", async () => {
  const state = fixture({
    getMatchEmoji: async () => {
      throw new Error("presentation-unavailable");
    },
  });

  await assert.rejects(state.recompute(), /presentation-unavailable/);
  assert.deepEqual(state.presentationReads, [
    [inviteId, inviteId, "guest-login"],
    [inviteId, inviteId, "guest-login"],
  ]);
  assert.deepEqual(state.writes, []);
  assert.equal(state.reads.includes(guestMatchPath), false);
});

test("durable presentation misses never read legacy seed avatars", async () => {
  const state = fixture({
    getMatchEmoji: async () => null,
  });
  await state.recompute();
  assert.equal(state.reads.includes(guestMatchPath), false);
  assert.deepEqual(state.writes, []);
});

test("appearance authority failures preserve projection state without legacy fallback", async () => {
  const state = fixture({
    getMatchEmoji: async () => {
      throw new Error("authority-unavailable");
    },
  });
  await assert.rejects(state.recompute(), /authority-unavailable/);
  assert.equal(state.reads.includes(guestMatchPath), false);
  assert.deepEqual(state.writes, []);
});
