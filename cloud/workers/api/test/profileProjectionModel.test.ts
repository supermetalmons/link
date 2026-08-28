import assert from "node:assert/strict";
import test from "node:test";
import {
  createProfileProjection,
  parseFirestoreUpdateTime,
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
  assert.match(projection.digest, /^[0-9a-f]{64}$/);
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
    { rating: null },
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
