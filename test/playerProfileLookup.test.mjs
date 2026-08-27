import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePlayerProfile,
  resolvePlayerProfileWithRetry,
} from "../src/connection/playerProfileLookup.ts";

const profile = (id, username) => ({ id, username });

test("resolves a matched player's profile through the stable profile link", async () => {
  const calls = [];
  const expected = profile("profile-1", "named-player");

  const result = await resolvePlayerProfile("login-1", {
    readLinkedProfileId: async (loginId) => {
      calls.push(["link", loginId]);
      return " profile-1 ";
    },
    getProfileById: async (profileId) => {
      calls.push(["profile", profileId]);
      return expected;
    },
    getProfileByLoginId: async (loginId) => {
      calls.push(["query", loginId]);
      throw new Error("unexpected-query");
    },
  });

  assert.equal(result, expected);
  assert.deepEqual(calls, [
    ["link", "login-1"],
    ["profile", "profile-1"],
  ]);
});

test("falls back to the login query when the player has no usable profile link", async () => {
  const expected = profile("profile-2", "fallback-player");

  const result = await resolvePlayerProfile("login-2", {
    readLinkedProfileId: async () => "",
    getProfileById: async () => null,
    getProfileByLoginId: async (loginId) => {
      assert.equal(loginId, "login-2");
      return expected;
    },
  });

  assert.equal(result, expected);
});

test("falls back when a linked profile cannot be read", async () => {
  const expected = profile("profile-3", "recovered-player");

  const result = await resolvePlayerProfile("login-3", {
    readLinkedProfileId: async () => "profile-3",
    getProfileById: async () => null,
    getProfileByLoginId: async () => expected,
  });

  assert.equal(result, expected);
});

test("propagates a linked profile lookup failure", async () => {
  let loginLookups = 0;

  await assert.rejects(
    resolvePlayerProfile("login-4", {
      readLinkedProfileId: async () => "profile-4",
      getProfileById: async () => {
        throw new Error("profile-service-unavailable");
      },
      getProfileByLoginId: async () => {
        loginLookups += 1;
        return profile("profile-4", "unexpected");
      },
    }),
    /profile-service-unavailable/,
  );

  assert.equal(loginLookups, 0);
});

test("retries one current lookup and returns exactly once", async () => {
  const expected = profile("profile-5", "retried-player");
  let waits = 0;
  let attempts = 0;

  const result = await resolvePlayerProfileWithRetry(
    "login-5",
    {
      readLinkedProfileId: async () => "profile-5",
      getProfileById: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary-failure");
        }
        return expected;
      },
      getProfileByLoginId: async () => profile("fallback", "unexpected"),
    },
    () => true,
    async () => {
      waits += 1;
    },
  );

  assert.equal(result, expected);
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test("does not retry after lookup cleanup", async () => {
  let isCurrent = true;
  let attempts = 0;

  const result = await resolvePlayerProfileWithRetry(
    "login-6",
    {
      readLinkedProfileId: async () => "profile-6",
      getProfileById: async () => {
        attempts += 1;
        throw new Error("temporary-failure");
      },
      getProfileByLoginId: async () => profile("fallback", "unexpected"),
    },
    () => isCurrent,
    async () => {
      isCurrent = false;
    },
  );

  assert.equal(result, null);
  assert.equal(attempts, 1);
});
