"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createProfileGamesProjectionCore,
} = require("../runtime/profileGamesProjectionCore");

const inviteId = "presentation-invite";
const guestMatchPath = `players/guest-login/matches/${inviteId}`;

function matchPresentation(matchId, emojis) {
  return {
    matchId,
    players: Object.fromEntries(
      Object.entries(emojis).map(([actorUid, emojiId]) => [
        actorUid,
        { matchId, actorUid, emojiId, aura: "", revision: 0 },
      ]),
    ),
  };
}

function fixture({
  readMatchPresentation,
  hostProfile = { username: "host", emoji: 2 },
  guestProfile = null,
  rematches = "x",
  beforeCommit = async () => undefined,
}) {
  const writes = [];
  const reads = [];
  const presentationReads = [];
  const projections = new Map();
  const profiles = new Map([
    ["host-profile", hostProfile],
    ...(guestProfile ? [["guest-profile", guestProfile]] : []),
  ]);
  const core = createProfileGamesProjectionCore({
    logger: { error() {} },
    repository: {
      async commitProjectionWrites(nextWrites) {
        await beforeCommit(nextWrites);
        for (const write of nextWrites) {
          writes.push(write);
          projections.set(write.profileId, {
            data: write.data,
            updateTime: String(writes.length),
          });
        }
      },
      getProjections: async (profileIds) =>
        new Map(
          profileIds
            .filter((profileId) => projections.has(profileId))
            .map((profileId) => [profileId, projections.get(profileId)]),
        ),
      async readInviteMetadata(readInviteId) {
        assert.equal(readInviteId, inviteId);
        return {
          hostId: "host-login",
          guestId: "guest-login",
          hostRematches: rematches,
          guestRematches: rematches,
        };
      },
      async readAutomatchEntry(inviteId) {
        const path = `automatch/${inviteId}`;
        reads.push(path);
        if (path === `automatch/${inviteId}`) return null;
        if (path === guestMatchPath) return { emojiId: 1, aura: "" };
        throw new Error(`unexpected-state-read:${path}`);
      },
      async readMatchPresentation(...args) {
        presentationReads.push(args);
        return readMatchPresentation(...args);
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
    recompute: (options = {}) =>
      core.recomputeInviteProjection(inviteId, "rating-completed", {
        eventTimestampMs: 100,
        ...options,
      }),
  };
}

test("recomputation replaces an anonymous opponent's seed emoji with live presentation", async () => {
  let emoji = 1;
  const state = fixture({
    readMatchPresentation: async (_inviteId, matchId) =>
      matchPresentation(matchId, { "guest-login": emoji }),
  });
  await state.recompute();
  emoji = 7;
  await state.recompute();

  assert.deepEqual(
    state.writes.map((write) => write.data.opponentEmoji),
    [1, 7],
  );
  assert.deepEqual(state.presentationReads, [
    [inviteId, inviteId],
    [inviteId, inviteId],
  ]);
  assert.equal(state.writes[1].data.status, "ended");
  assert.equal(state.reads.includes(guestMatchPath), false);
});

test("canonical profile avatars retain precedence without reading match presentation", async () => {
  const state = fixture({
    guestProfile: { username: "guest", emoji: 3 },
    readMatchPresentation: async () => {
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
    readMatchPresentation: async () => {
      throw new Error("presentation-unavailable");
    },
  });

  await assert.rejects(state.recompute(), /presentation-unavailable/);
  assert.deepEqual(state.presentationReads, [
    [inviteId, inviteId],
    [inviteId, inviteId],
  ]);
  assert.deepEqual(state.writes, []);
  assert.equal(state.reads.includes(guestMatchPath), false);
});

test("durable presentation misses never read legacy seed avatars", async () => {
  const state = fixture({
    readMatchPresentation: async (_inviteId, matchId) =>
      matchPresentation(matchId, {}),
  });
  await state.recompute();
  assert.equal(state.reads.includes(guestMatchPath), false);
  assert.deepEqual(state.writes, []);
});

test("appearance authority failures preserve projection state without legacy fallback", async () => {
  const state = fixture({
    readMatchPresentation: async () => {
      throw new Error("authority-unavailable");
    },
  });
  await assert.rejects(state.recompute(), /authority-unavailable/);
  assert.equal(state.reads.includes(guestMatchPath), false);
  assert.deepEqual(state.writes, []);
});

test("both owner projections share one match appearance snapshot", async () => {
  const state = fixture({
    hostProfile: { username: "host" },
    guestProfile: { username: "guest" },
    readMatchPresentation: async (_inviteId, matchId) =>
      matchPresentation(matchId, { "host-login": 4, "guest-login": 7 }),
  });

  await state.recompute();

  assert.deepEqual(state.presentationReads, [[inviteId, inviteId]]);
  assert.deepEqual(
    state.writes.map(({ profileId, data }) => [profileId, data.opponentEmoji]),
    [
      ["host-profile", 7],
      ["guest-profile", 4],
    ],
  );
});

for (const latestActor of ["host-login", "guest-login"]) {
  test(`partial snapshots preserve latest appearance for ${latestActor} and fallback for the other player`, async () => {
    const latestMatchId = `${inviteId}1`;
    const state = fixture({
      hostProfile: { username: "host" },
      guestProfile: { username: "guest" },
      rematches: "1x",
      readMatchPresentation: async (_inviteId, matchId) =>
        matchPresentation(
          matchId,
          matchId === latestMatchId
            ? { [latestActor]: 7 }
            : { "host-login": 4, "guest-login": 3 },
        ),
    });

    await state.recompute();

    assert.deepEqual(state.presentationReads, [
      [inviteId, latestMatchId],
      [inviteId, inviteId],
    ]);
    assert.deepEqual(
      state.writes.map(({ profileId, data }) => [
        profileId,
        data.opponentEmoji,
      ]),
      [
        ["host-profile", latestActor === "guest-login" ? 7 : 3],
        ["guest-profile", latestActor === "host-login" ? 7 : 4],
      ],
    );
  });
}

test("successful empty snapshots are shared between owner projections", async () => {
  const state = fixture({
    hostProfile: { username: "host" },
    guestProfile: { username: "guest" },
    readMatchPresentation: async (_inviteId, matchId) =>
      matchPresentation(matchId, {}),
  });

  const result = await state.recompute();

  assert.equal(result.blockedReason, "unresolved-opponent-emoji");
  assert.deepEqual(state.presentationReads, [[inviteId, inviteId]]);
  assert.deepEqual(state.writes, []);
});

test("a transient read failure retries the provider and shares the successful snapshot", async () => {
  let attempts = 0;
  const state = fixture({
    hostProfile: { username: "host" },
    guestProfile: { username: "guest" },
    readMatchPresentation: async (_inviteId, matchId) => {
      if (++attempts === 1) throw new Error("presentation-unavailable");
      return matchPresentation(matchId, { "host-login": 4, "guest-login": 7 });
    },
  });

  await state.recompute();

  assert.deepEqual(state.presentationReads, [
    [inviteId, inviteId],
    [inviteId, inviteId],
  ]);
  assert.deepEqual(
    state.writes.map(({ profileId, data }) => [profileId, data.opponentEmoji]),
    [
      ["host-profile", 7],
      ["guest-profile", 4],
    ],
  );
});

test("exhausted fallback reads discard all prepared projection writes", async () => {
  const latestMatchId = `${inviteId}1`;
  const state = fixture({
    hostProfile: { username: "host" },
    guestProfile: { username: "guest" },
    rematches: "1x",
    readMatchPresentation: async (_inviteId, matchId) => {
      if (matchId === inviteId) throw new Error("presentation-unavailable");
      return matchPresentation(matchId, { "guest-login": 7 });
    },
  });

  await assert.rejects(state.recompute(), /presentation-unavailable/);

  assert.deepEqual(state.presentationReads, [
    [inviteId, latestMatchId],
    [inviteId, inviteId],
    [inviteId, inviteId],
  ]);
  assert.deepEqual(state.writes, []);
});

test("concurrent recomputations on the same runtime use independent appearance snapshots", async () => {
  const firstCommitStarted = Promise.withResolvers();
  const releaseFirstCommit = Promise.withResolvers();
  let commits = 0;
  let emoji = 3;
  const state = fixture({
    hostProfile: { username: "host" },
    guestProfile: { username: "guest" },
    readMatchPresentation: async (_inviteId, matchId) =>
      matchPresentation(matchId, {
        "host-login": emoji,
        "guest-login": emoji + 1,
      }),
    beforeCommit: async () => {
      if (++commits === 1) {
        firstCommitStarted.resolve();
        await releaseFirstCommit.promise;
      }
    },
  });

  const first = state.recompute({ eventTimestampMs: 100 });
  await firstCommitStarted.promise;
  emoji = 7;
  try {
    await state.recompute({ eventTimestampMs: 200 });
  } finally {
    releaseFirstCommit.resolve();
    await first;
  }

  assert.deepEqual(state.presentationReads, [
    [inviteId, inviteId],
    [inviteId, inviteId],
  ]);
  for (const [time, hostEmoji, guestEmoji] of [
    [100, 3, 4],
    [200, 7, 8],
  ]) {
    assert.deepEqual(
      state.writes
        .filter(({ data }) => data.lastEventAt === time)
        .map(({ profileId, data }) => [profileId, data.opponentEmoji]),
      [
        ["host-profile", guestEmoji],
        ["guest-profile", hostEmoji],
      ],
    );
  }
});
