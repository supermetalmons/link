"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { getEventParticipantIds } = require("../runtime/events/participants");
const { buildEventParticipantSnapshot } = require("../runtime/shared/events");

const profile = Object.freeze({
  profileId: " profile-a ",
  username: " Player ",
  eth: "0x1234567890abcdef",
  sol: "123456789ABCDEFG",
  emoji: "7.9",
  aura: " rainbow ",
});

test("event participant eligibility rejects missing and malformed containers", () => {
  assert.deepEqual(getEventParticipantIds(), []);
  assert.deepEqual(getEventParticipantIds(null), []);
  assert.deepEqual(getEventParticipantIds({ participants: null }), []);
  assert.deepEqual(getEventParticipantIds({ participants: "profile-a" }), []);
});

test("event participant eligibility keeps object-backed entries in order", () => {
  const event = {
    participants: {
      "profile-a": { username: "a" },
      tombstone: null,
      scalar: "profile-b",
      "profile-c": [],
      "profile-d": { username: "d" },
    },
  };

  assert.deepEqual(getEventParticipantIds(event), [
    "profile-a",
    "profile-c",
    "profile-d",
  ]);
});

test("builds a validated participant without changing profile or login identities", () => {
  assert.deepEqual(buildEventParticipantSnapshot(profile, " login-a ", 100), {
    profileId: " profile-a ",
    loginUid: " login-a ",
    username: "Player",
    displayName: " Player ",
    emojiId: 7,
    aura: "rainbow",
    joinedAtMs: 100,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  });
  assert.equal(profile.username, " Player ");
  assert.equal(profile.aura, " rainbow ");
  assert.equal(profile.emoji, "7.9");
});

test("keeps the participant display-name fallback without emoji or rating decorations", () => {
  const cases = [
    [{}, " Player "],
    [{ username: "" }, "0x12...cdef"],
    [{ username: "", eth: "" }, "1234...DEFG"],
    [{ username: "", eth: "", sol: "" }, "anon"],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(
      buildEventParticipantSnapshot({ ...profile, ...overrides }, "login", 0)
        .displayName,
      expected,
    );
  }
});

test("normalizes numeric and string emoji IDs with the same safe-integer policy", () => {
  const cases = [
    [7, 7],
    [7.9, 7],
    ["7", 7],
    ["7.9", 7],
    [0, 0],
    ["", 0],
    ["invalid", 0],
    ["Infinity", 0],
    [Infinity, 0],
    [-Infinity, 0],
    [NaN, 0],
    [-1, 0],
    ["-1", 0],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER + 1, 0],
  ];
  for (const [emoji, expected] of cases) {
    assert.equal(
      buildEventParticipantSnapshot({ ...profile, emoji }, "login", 0).emojiId,
      expected,
      String(emoji),
    );
  }
});

test("rejects invalid participant identifiers and timestamps", () => {
  for (const invalidId of ["", " ", "invalid/id", "invalid\u0000id"]) {
    assert.equal(
      buildEventParticipantSnapshot(
        { ...profile, profileId: invalidId },
        "login",
        0,
      ),
      null,
    );
    assert.equal(buildEventParticipantSnapshot(profile, invalidId, 0), null);
  }
  for (const invalidTime of [
    -1,
    0.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      buildEventParticipantSnapshot(profile, "login", invalidTime),
      null,
    );
  }
});

test("enforces participant text limits in UTF-8 bytes including the raw display name", () => {
  for (const field of ["username", "aura"]) {
    for (const text of ["x".repeat(256), "é".repeat(128)]) {
      assert.notEqual(
        buildEventParticipantSnapshot(
          { ...profile, [field]: text },
          "login",
          0,
        ),
        null,
      );
      assert.equal(
        buildEventParticipantSnapshot(
          { ...profile, [field]: `${text}x` },
          "login",
          0,
        ),
        null,
      );
    }
  }
  assert.equal(
    buildEventParticipantSnapshot(
      { ...profile, username: ` ${"x".repeat(256)}` },
      "login",
      0,
    ),
    null,
  );
});
