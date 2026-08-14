import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlayerProfile } from "../src/connection/playerProfileLookup.ts";

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
