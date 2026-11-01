"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decodeAutomatchEntry } = require("../runtime/automatchRecords");
const {
  createProfileGamesProjectionCore,
} = require("../runtime/profileGamesProjectionCore");

const { invite, profile } = require("./fixtures/canonicalProfileGames");
const { readInviteDocument } = require("../runtime/shared/invite-records");

const inviteId = "rating-event-invite";

/**
 * @typedef {import("../runtime/profileGamesProjectionCore").ProfileGamesProjectionRepository} Repository
 */
/** @param {{inviteFields?: Parameters<typeof invite>[0], readCompletion?: Repository["hasCompletedRatingUpdate"], readMetadata?: Repository["readInviteMetadata"]}} [input] */
const fixture = ({
  inviteFields = {},
  readCompletion = async () => false,
  readMetadata,
} = {}) => {
  /** @type {import("../runtime/profileGamesProjectionCore").ProjectionWrite[]} */
  const writes = [];
  /** @type {[string, string][]} */
  const completionReads = [];
  /** @type {string[]} */
  const metadataReads = [];
  const profiles = new Map([
    ["host-profile", profile({ username: "host", emoji: 1 })],
    ["guest-profile", profile({ username: "guest", emoji: 2 })],
  ]);
  const core = createProfileGamesProjectionCore({
    repository: {
      async commitProjectionWrites(nextWrites) {
        writes.push(...nextWrites);
      },
      getProjections: async () => new Map(),
      async readInviteMetadata(readInviteId) {
        metadataReads.push(readInviteId);
        assert.equal(readInviteId, inviteId);
        return readMetadata
          ? readMetadata(readInviteId)
          : invite({
              kind: "event",
              eventId: "event-1",
              eventRoundIndex: 0,
              eventMatchKey: "0_0",
              eventOwned: true,
              hostId: "host-login",
              guestId: "guest-login",
              ...inviteFields,
            });
      },
      async readAutomatchEntry(inviteId) {
        const path = `automatch/${inviteId}`;
        if (path === `automatch/${inviteId}`) return decodeAutomatchEntry(null);
        throw new Error(`unexpected-state-read:${path}`);
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
    metadataReads,
    /** @param {import("../runtime/profileGamesProjectionCore").RecomputeInviteProjectionOptions} [options] */
    recompute: (options = {}) =>
      core.recomputeInviteProjection(inviteId, "rating-completed", {
        eventTimestampMs: 100,
        ...options,
      }),
    writes,
  };
};

test("event games end from canonical rating completion without legacy markers", async () => {
  const { completionReads, recompute, writes } = fixture({
    readCompletion: async () => true,
  });
  await recompute();

  assert.deepEqual(completionReads, [[inviteId, inviteId]]);
  assert.equal(writes.length, 2);
  assert.ok(
    writes.every(
      (write) => write.type !== "delete" && write.data.status === "ended",
    ),
  );
});

test("invite metadata failures retry without falling back to an aggregate read", async () => {
  let attempts = 0;
  const { metadataReads, recompute, writes } = fixture({
    readMetadata: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("invite-metadata-unavailable");
      return invite({ hostId: "host-login", guestId: "guest-login" });
    },
  });
  await recompute();

  assert.deepEqual(metadataReads, [inviteId, inviteId]);
  assert.equal(writes.length, 2);
  assert.ok(
    writes.every(
      (write) => write.type !== "delete" && write.data.status === "active",
    ),
  );
});

test("legacy completion markers are rejected by the canonical invite boundary", () => {
  const canonical = invite({
    hostId: "host-login",
    guestId: "guest-login",
    kind: "event",
    eventOwned: true,
    eventId: "event-1",
    eventRoundIndex: 0,
    eventMatchKey: "0_0",
  });
  assert.equal(
    readInviteDocument({
      ...canonical,
      matchesRatingUpdates: { [inviteId]: true },
    }),
    null,
  );
});

test("event projection reads completion only for the latest match", async () => {
  const { completionReads, recompute, writes } = fixture({
    inviteFields: {
      hostRematches: { state: "open", indices: [1] },
      guestRematches: { state: "open", indices: [1] },
    },
    readCompletion: async (_inviteId, matchId) => matchId === inviteId,
  });
  await recompute({ latestMatchIdHint: inviteId });

  assert.deepEqual(completionReads, [[inviteId, `${inviteId}1`]]);
  assert.ok(
    writes.every(
      (write) => write.type !== "delete" && write.data.status === "active",
    ),
  );
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
    inviteFields: {
      kind: "manual",
      eventOwned: false,
      eventId: null,
      eventRoundIndex: null,
      eventMatchKey: null,
    },
    readCompletion: async () => {
      throw new Error("unexpected-rating-completion-read");
    },
  });
  await recompute();

  assert.deepEqual(completionReads, []);
  assert.ok(
    writes.every(
      (write) => write.type !== "delete" && write.data.status === "active",
    ),
  );
});
