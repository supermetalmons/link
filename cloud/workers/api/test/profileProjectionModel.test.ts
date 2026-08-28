import assert from "node:assert/strict";
import test from "node:test";
import {
  createProfileProjection,
  createProfileProjectionFailureLoginMetadata,
  parseFirestoreUpdateTime,
  PROFILE_PROJECTION_SCHEMA_VERSION,
} from "../src/profileProjectionModel.ts";

test("normalizes profile projection fields and preserves sort-field absence", async () => {
  const projection = await createProfileProjection({
    profileId: "profile-1",
    updateTime: "2026-08-27T12:00:00.123456789Z",
    fields: {
      logins: ["login-2", "login-1", "login-1"],
      custom: { emoji: "12", completedProblems: [] },
      mining: { materials: { dust: 4 } },
    },
  });
  assert.deepEqual(projection.sourceVersion, {
    seconds: 1_787_832_000,
    nanos: 123_456_789,
  });
  assert.deepEqual(projection.logins, ["login-1", "login-2"]);
  assert.equal(projection.profile.rating, 1500);
  assert.deepEqual(projection.profile.completedProblemIds, []);
  assert.equal(projection.sortValues.rating, null);
  assert.equal(projection.sortValues.dust, 4);
  assert.equal(projection.sortValues.slime, null);
  assert.equal(projection.sortPresence.rating, false);
  assert.equal(projection.sortPresence.dust, true);
  assert.equal(projection.sortPresence.slime, false);
  assert.equal(projection.schemaVersion, PROFILE_PROJECTION_SCHEMA_VERSION);
  assert.match(projection.digest, /^[0-9a-f]{64}$/);
});

test("preserves explicit nulls for all leaderboard sort fields", async () => {
  const projection = await createProfileProjection({
    profileId: "profile-null",
    updateTime: "2026-08-27T12:00:00Z",
    fields: {
      rating: null,
      totalManaPoints: null,
      mining: {
        materials: {
          dust: null,
          slime: null,
          gum: null,
          metal: null,
          ice: null,
        },
      },
    },
  });
  assert.deepEqual(projection.sortValues, {
    rating: null,
    mp: null,
    dust: null,
    slime: null,
    gum: null,
    metal: null,
    ice: null,
  });
  assert.deepEqual(projection.sortPresence, {
    rating: true,
    mp: true,
    dust: true,
    slime: true,
    gum: true,
    metal: true,
    ice: true,
  });
  assert.equal(projection.profile.rating, 1500);
  assert.equal(projection.profile.totalManaPoints, 0);
  assert.deepEqual(projection.profile.mining.materials, {
    dust: 0,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  });
});

test("projection digests are canonical for equivalent objects", async () => {
  const first = await createProfileProjection({
    profileId: "profile-1",
    updateTime: "2026-08-27T12:00:00Z",
    fields: {
      rating: 1600,
      custom: { aura: "rainbow", emoji: 3 },
      mining: { materials: { ice: 2, dust: 1 } },
    },
  });
  const second = await createProfileProjection({
    profileId: "profile-1",
    updateTime: "2026-08-27T12:00:01Z",
    fields: {
      mining: { materials: { dust: 1, ice: 2 } },
      custom: { emoji: 3, aura: "rainbow" },
      rating: 1600,
    },
  });
  assert.equal(first.digest, second.digest);
});

test("rejects malformed Firestore update timestamps", () => {
  assert.throws(
    () => parseFirestoreUpdateTime("2026-08-27"),
    /invalid-profile-source-update-time/,
  );
});

test("rejects present nonnumeric leaderboard fields", async () => {
  for (const fields of [
    { rating: "1500" },
    { totalManaPoints: "5" },
    { mining: { materials: { dust: Number.NaN } } },
  ]) {
    await assert.rejects(
      createProfileProjection({
        profileId: "profile-1",
        updateTime: "2026-08-27T12:00:00Z",
        fields,
      }),
      /invalid-profile-sort-field/,
    );
  }
});

test("rejects malformed login mappings instead of clearing them", async () => {
  for (const logins of [null, "login-1", ["login-1", 7], [""]]) {
    await assert.rejects(
      createProfileProjection({
        profileId: "profile-1",
        updateTime: "2026-08-27T12:00:00Z",
        fields: { logins },
      }),
      /invalid-profile-logins/,
    );
  }
});

test("extracts valid login IDs from malformed projection fields", () => {
  assert.deepEqual(
    createProfileProjectionFailureLoginMetadata({
      logins: ["login-2", 7, "", " login-3", "login-1", null, "login-2"],
    }),
    { complete: true, loginUids: ["login-1", "login-2"] },
  );
  assert.deepEqual(
    createProfileProjectionFailureLoginMetadata({ logins: "login-1" }),
    { complete: true, loginUids: [] },
  );
  assert.deepEqual(createProfileProjectionFailureLoginMetadata({}), {
    complete: true,
    loginUids: [],
  });
});

test("compacts oversized failure metadata without changing active projections", async () => {
  const tooMany = Array.from({ length: 1_001 }, (_, index) => `login-${index}`);
  const tooManyBytes = Array.from(
    { length: 140 },
    (_, index) => `${String(index).padStart(3, "0")}${"😀".repeat(125)}`,
  );
  for (const logins of [tooMany, tooManyBytes]) {
    assert.deepEqual(createProfileProjectionFailureLoginMetadata({ logins }), {
      complete: false,
      loginUids: [],
    });
    const projection = await createProfileProjection({
      profileId: "profile-1",
      updateTime: "2026-08-27T12:00:00Z",
      fields: { logins },
    });
    assert.equal(projection.logins.length, logins.length);
  }
});
