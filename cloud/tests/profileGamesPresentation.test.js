"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decodeAutomatchEntry } = require("../runtime/automatchRecords");
const {
  createProfileGamesProjectionCore,
} = require("../runtime/profileGamesProjectionCore");

const { invite, profile } = require("./fixtures/canonicalProfileGames");

const inviteId = "presentation-invite";
const guestMatchPath = `players/guest-login/matches/${inviteId}`;

/**
 * @typedef {import("../runtime/profileGamesProjectionCore").ProfileGamesProjectionRepository} Repository
 * @typedef {import("../runtime/profileGamesProjectionCore").ProjectionRecord} ProjectionRecord
 * @typedef {import("../runtime/profileGamesProjectionCore").ProjectionWrite} ProjectionWrite
 */
/** @param {string} matchId @param {Record<string, number>} emojis @returns {import("../runtime/shared/match-presentation").MatchPresentationSnapshot} */
function matchPresentation(matchId, emojis) {
  return {
    matchId,
    players: Object.fromEntries(
      Object.entries(emojis).map(([actorUid, emojiId]) => [
        actorUid,
        { matchId, actorUid, emojiId, aura: "none", revision: 0 },
      ]),
    ),
  };
}

/** @param {{readMatchPresentation: NonNullable<Repository["readMatchPresentation"]>, hostProfile?: Parameters<typeof profile>[0], guestProfile?: Parameters<typeof profile>[0] | null, rematches?: import("../runtime/shared/rematches").RematchSeries, beforeCommit?: Repository["commitProjectionWrites"]}} input */
function fixture({
  readMatchPresentation,
  hostProfile = { username: "host", emoji: 2 },
  guestProfile = null,
  rematches = { state: "ended", indices: [] },
  beforeCommit = async () => undefined,
}) {
  /** @type {ProjectionWrite[]} */
  const writes = [];
  /** @type {string[]} */
  const reads = [];
  /** @type {[string, string][]} */
  const presentationReads = [];
  /** @type {Map<string, ProjectionRecord>} */
  const projections = new Map();
  const profiles = new Map([["host-profile", profile(hostProfile)]]);
  if (guestProfile) profiles.set("guest-profile", profile(guestProfile));
  const core = createProfileGamesProjectionCore({
    logger: { error() {} },
    repository: {
      async commitProjectionWrites(nextWrites) {
        await beforeCommit(nextWrites);
        for (const write of nextWrites) {
          const current = projections.get(write.profileId);
          if (
            (write.type === "create" && current) ||
            (write.type === "update" &&
              (!current || write.expectedVersion !== current.version))
          ) {
            throw new Error("projection-precondition-failed");
          }
        }
        for (const write of nextWrites) {
          writes.push(write);
          if (write.type === "delete") {
            projections.delete(write.profileId);
            continue;
          }
          const current = projections.get(write.profileId);
          projections.set(write.profileId, {
            data: write.data,
            version: (current?.version || 0) + 1,
          });
        }
      },
      getProjections: async (profileIds) =>
        new Map(
          profileIds
            .filter((profileId) => projections.has(profileId))
            .map((profileId) => {
              const current = projections.get(profileId);
              assert.ok(current);
              return /** @type {[string, ProjectionRecord]} */ ([
                profileId,
                current,
              ]);
            }),
        ),
      async readInviteMetadata(readInviteId) {
        assert.equal(readInviteId, inviteId);
        return invite({
          hostId: "host-login",
          guestId: "guest-login",
          hostRematches: rematches,
          guestRematches: rematches,
        });
      },
      async readAutomatchEntry(inviteId) {
        const path = `automatch/${inviteId}`;
        reads.push(path);
        if (path === `automatch/${inviteId}`) return decodeAutomatchEntry(null);
        if (path === guestMatchPath)
          return decodeAutomatchEntry({ emojiId: 1, aura: "none" });
        throw new Error(`unexpected-state-read:${path}`);
      },
      hasCompletedRatingUpdate: async () =>
        assert.fail("unexpected-rating-completion-read"),
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
    /** @param {import("../runtime/profileGamesProjectionCore").RecomputeInviteProjectionOptions} [options] */
    recompute: (options = {}) =>
      core.recomputeInviteProjection(inviteId, "rating-completed", {
        eventTimestampMs: 100,
        ...options,
      }),
  };
}

/** @param {ProjectionWrite | undefined} write */
function writtenGame(write) {
  assert.ok(
    write && write.type !== "delete" && write.data.entityType === "game",
  );
  return write.data;
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
    state.writes.map((write) => writtenGame(write).opponentEmoji),
    [1, 7],
  );
  assert.deepEqual(state.presentationReads, [
    [inviteId, inviteId],
    [inviteId, inviteId],
  ]);
  assert.equal(writtenGame(state.writes[1]).status, "ended");
  assert.equal(state.reads.includes(guestMatchPath), false);
  assert.ok(
    state.writes.every(
      (write) =>
        write.type === "merge" && !Object.hasOwn(write, "expectedVersion"),
    ),
  );
});

test("catchup updates use the numeric version from their latest projection read", async () => {
  let emoji = 1;
  const state = fixture({
    readMatchPresentation: async (_inviteId, matchId) =>
      matchPresentation(matchId, { "guest-login": emoji }),
  });
  for (const eventTimestampMs of [100, 200, 300]) {
    await state.recompute({ eventTimestampMs, preserveListSortAt: true });
    emoji += 1;
  }

  assert.ok(state.writes[0]);
  assert.equal(state.writes[0].type, "create");
  assert.equal(Object.hasOwn(state.writes[0], "expectedVersion"), false);
  assert.deepEqual(
    state.writes.slice(1).map(({ type, expectedVersion }) => ({
      type,
      expectedVersion,
    })),
    [
      { type: "update", expectedVersion: 1 },
      { type: "update", expectedVersion: 2 },
    ],
  );
  assert.deepEqual(
    state.writes.map((write) => [
      writtenGame(write).createdAt,
      writtenGame(write).listSortAt,
    ]),
    [
      [100, 100],
      [100, 100],
      [100, 100],
    ],
  );
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
    writtenGame(
      state.writes.find((write) => write.profileId === "host-profile"),
    ).opponentEmoji,
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
    state.writes.map((write) => [
      write.profileId,
      writtenGame(write).opponentEmoji,
    ]),
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
      rematches: { state: "ended", indices: [1] },
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
      state.writes.map((write) => [
        write.profileId,
        writtenGame(write).opponentEmoji,
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
    state.writes.map((write) => [
      write.profileId,
      writtenGame(write).opponentEmoji,
    ]),
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
    rematches: { state: "ended", indices: [1] },
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
  /** @type {PromiseWithResolvers<void>} */
  const firstCommitStarted = Promise.withResolvers();
  /** @type {PromiseWithResolvers<void>} */
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
        .filter((write) => writtenGame(write).lastEventAt === time)
        .map((write) => [write.profileId, writtenGame(write).opponentEmoji]),
      [
        ["host-profile", guestEmoji],
        ["guest-profile", hostEmoji],
      ],
    );
  }
});
