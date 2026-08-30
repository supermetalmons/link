import assert from "node:assert/strict";
import test from "node:test";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  getCanonicalProfileId,
  getLoginProfileId,
  getOwnershipProfile,
  getProfileLoginUids,
  loginOwnsProfile,
  loginsShareProfile,
  profilesShareCanonicalProfile,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipReader,
  type ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";

const presentation = {
  aura: "blue",
  emoji: 7,
  eth: "0x1",
  profileId: "profile-1",
  rating: 1512,
  sol: "sol-1",
  username: "Alice",
};

function emptySnapshot(): ProfileOwnershipSnapshot {
  return {
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  };
}

test("equal login UIDs share ownership without a snapshot lookup", () => {
  assert.equal(loginsShareProfile(emptySnapshot(), "same", "same"), true);
});

test("reads and compares one normalized ownership snapshot", async () => {
  const reads: Array<{
    loginUids: readonly string[];
    profileIds: readonly string[];
  }> = [];
  const repository: ProfileOwnershipReader = {
    async readProfileOwnershipSnapshot(query) {
      reads.push(query);
      return {
        canonicalProfileIdByProfileId: new Map([
          ["source-profile", "profile-1"],
          ["target-profile", "profile-1"],
          ["missing-profile", null],
        ]),
        loginOwnerByUid: new Map([
          ["first", { profileId: "profile-1", revision: 2 }],
          ["second", { profileId: "profile-1", revision: 3 }],
          ["missing-login", null],
        ]),
        loginUidsByProfileId: new Map([["profile-1", ["first", "second"]]]),
        profileById: new Map([
          ["profile-1", { profile: presentation, revision: 4 }],
        ]),
      };
    },
  };

  const snapshot = await requireProfileOwnershipSnapshot(repository, {
    loginUids: ["first", "second", "first", "missing-login"],
    profileIds: [
      "source-profile",
      "target-profile",
      "missing-profile",
      "source-profile",
    ],
  });

  assert.deepEqual(reads, [
    {
      loginUids: ["first", "second", "missing-login"],
      profileIds: ["source-profile", "target-profile", "missing-profile"],
    },
  ]);
  assert.equal(getLoginProfileId(snapshot, "first"), "profile-1");
  assert.equal(getLoginProfileId(snapshot, "missing-login"), null);
  assert.equal(getCanonicalProfileId(snapshot, "source-profile"), "profile-1");
  assert.equal(getCanonicalProfileId(snapshot, "missing-profile"), null);
  assert.deepEqual(getOwnershipProfile(snapshot, "profile-1"), {
    profile: presentation,
    revision: 4,
  });
  assert.deepEqual(getProfileLoginUids(snapshot, "profile-1"), [
    "first",
    "second",
  ]);
  assert.equal(loginsShareProfile(snapshot, "first", "second"), true);
  assert.equal(
    profilesShareCanonicalProfile(snapshot, "source-profile", "target-profile"),
    true,
  );
  assert.equal(loginOwnsProfile(snapshot, "first", "source-profile"), true);
});

test("invalid ownership snapshots map to availability failure", async () => {
  const repository: ProfileOwnershipReader = {
    async readProfileOwnershipSnapshot() {
      return emptySnapshot();
    },
  };

  await assert.rejects(
    requireProfileOwnershipSnapshot(repository, {
      loginUids: ["first"],
      profileIds: [],
    }),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "profile-ownership-unavailable",
  );
});

test("ownership reader failures map to availability failure", async () => {
  const repository: ProfileOwnershipReader = {
    async readProfileOwnershipSnapshot() {
      throw new Error("d1-unavailable");
    },
  };

  await assert.rejects(
    requireProfileOwnershipSnapshot(repository, {
      loginUids: ["first"],
      profileIds: [],
    }),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "profile-ownership-unavailable",
  );
});

test("validates a high-cardinality owner snapshot", async () => {
  const loginUids = Array.from({ length: 513 }, (_, index) => `login-${index}`);
  const repository: ProfileOwnershipReader = {
    async readProfileOwnershipSnapshot(query) {
      return {
        canonicalProfileIdByProfileId: new Map(),
        loginOwnerByUid: new Map(
          query.loginUids.map((loginUid) => [
            loginUid,
            { profileId: "profile-1", revision: 1 },
          ]),
        ),
        loginUidsByProfileId: new Map([["profile-1", loginUids]]),
        profileById: new Map([
          ["profile-1", { profile: presentation, revision: 1 }],
        ]),
      };
    },
  };

  const snapshot = await requireProfileOwnershipSnapshot(repository, {
    loginUids,
    profileIds: [],
  });
  assert.equal(snapshot.loginOwnerByUid.size, loginUids.length);
});
