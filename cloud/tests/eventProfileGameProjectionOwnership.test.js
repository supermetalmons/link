"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createEventProfileGameProjectionCore,
} = require("../functions/eventProfileGameProjectionCore");

const ownershipSnapshot = ({ canonical = {}, logins = {} } = {}) => ({
  canonicalProfileIdByProfileId: new Map(Object.entries(canonical)),
  loginOwnerByUid: new Map(
    Object.entries(logins).map(([loginUid, profileId]) => [
      loginUid,
      profileId ? { profileId, revision: 1 } : null,
    ]),
  ),
});

const event = (participants) => ({
  createdAtMs: 1,
  participants,
  startAtMs: 2,
  status: "scheduled",
  updatedAtMs: 3,
});

test("event projection resolves and validates every owner in one snapshot", async () => {
  const writes = [];
  const queries = [];
  const core = createEventProfileGameProjectionCore({
    repository: {
      commitProjectionWrites: async (nextWrites) => writes.push(...nextWrites),
      getEvent: async () => null,
      async readProfileOwnershipSnapshot(query) {
        queries.push(query);
        return ownershipSnapshot({
          canonical: {
            "source-profile": "target-profile",
            "target-profile": "target-profile",
          },
          logins: { "login-1": "target-profile" },
        });
      },
    },
  });

  await core.projectEvent(
    "event-1",
    event({
      "source-profile": {
        displayName: "Player",
        joinedAtMs: 1,
        loginUid: "login-1",
        profileId: "source-profile",
      },
    }),
    ["target-profile"],
  );

  assert.deepEqual(queries, [
    {
      loginUids: ["login-1"],
      profileIds: ["source-profile", "target-profile"],
    },
  ]);
  assert.deepEqual(
    writes.map(({ profileId, type }) => ({ profileId, type })),
    [
      { profileId: "target-profile", type: "merge" },
      { profileId: "source-profile", type: "delete" },
    ],
  );
  assert.equal(
    writes[0].data.participantPreview[0].profileId,
    "target-profile",
  );
});

test("event projection rejects contradictory participant ownership before writing", async () => {
  let snapshots = 0;
  let commits = 0;
  const core = createEventProfileGameProjectionCore({
    repository: {
      commitProjectionWrites: async () => {
        commits += 1;
      },
      getEvent: async () => null,
      async readProfileOwnershipSnapshot() {
        snapshots += 1;
        return ownershipSnapshot({
          canonical: { "profile-1": "profile-1" },
          logins: { "login-1": "other-profile" },
        });
      },
    },
  });

  await assert.rejects(
    core.projectEvent(
      "event-1",
      event({
        "profile-1": {
          loginUid: "login-1",
          profileId: "profile-1",
        },
      }),
    ),
    /profile-ownership-unavailable/,
  );
  assert.equal(snapshots, 1);
  assert.equal(commits, 0);
});

test("event projection rejects owners that converge in the same snapshot", async () => {
  let commits = 0;
  const core = createEventProfileGameProjectionCore({
    repository: {
      commitProjectionWrites: async () => {
        commits += 1;
      },
      getEvent: async () => null,
      readProfileOwnershipSnapshot: async () =>
        ownershipSnapshot({
          canonical: {
            "source-a": "target-profile",
            "source-b": "target-profile",
          },
          logins: {
            "login-a": "target-profile",
            "login-b": "target-profile",
          },
        }),
    },
  });

  await assert.rejects(
    core.projectEvent(
      "event-1",
      event({
        "source-a": { loginUid: "login-a", profileId: "source-a" },
        "source-b": { loginUid: "login-b", profileId: "source-b" },
      }),
    ),
    /profile-ownership-unavailable/,
  );
  assert.equal(commits, 0);
});

test("event projection propagates snapshot failures without writing", async () => {
  let commits = 0;
  const core = createEventProfileGameProjectionCore({
    repository: {
      commitProjectionWrites: async () => {
        commits += 1;
      },
      getEvent: async () => null,
      readProfileOwnershipSnapshot: async () => {
        throw new Error("d1-unavailable");
      },
    },
  });

  await assert.rejects(
    core.projectEvent(
      "event-1",
      event({
        "profile-1": {
          loginUid: "login-1",
          profileId: "profile-1",
        },
      }),
    ),
    /d1-unavailable/,
  );
  assert.equal(commits, 0);
});
