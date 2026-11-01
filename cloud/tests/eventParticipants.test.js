"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { getEventParticipantIds } = require("../runtime/events/participants");
const { buildEventParticipantSnapshot } = require("../runtime/shared/events");
const {
  readEventParticipantsDocument,
} = require("../runtime/events/documents");
const { event, participant } = require("./fixtures/canonicalEvents");

const loginUid = "a".repeat(28);
const profile = Object.freeze({
  profileId: "profile-a",
  username: " Player ",
  eth: "0x1234567890abcdef",
  sol: "123456789ABCDEFG",
  emoji: 7,
  aura: "rainbow",
});

test("event participant input validation rejects malformed containers before eligibility", () => {
  assert.deepEqual(getEventParticipantIds(undefined), []);
  assert.deepEqual(getEventParticipantIds(null), []);
  assert.deepEqual(getEventParticipantIds(event()), []);
  for (const value of [
    null,
    "profile-a",
    [],
    { p1: null },
    { p1: "profile" },
    { p1: [] },
    { p1: { username: "Player" } },
  ]) {
    assert.equal(readEventParticipantsDocument(value), null);
  }
});

test("event participant eligibility keeps complete records in insertion order including profile-only membership", () => {
  const source = event({
    participants: {
      "profile-a": participant("profile-a"),
      "profile-c": participant("profile-c", { loginUid: null }),
      "profile-d": participant("profile-d"),
    },
  });
  assert.deepEqual(getEventParticipantIds(source), [
    "profile-a",
    "profile-c",
    "profile-d",
  ]);
});

test("builds a complete participant without changing profile identity or presentation data", () => {
  assert.deepEqual(buildEventParticipantSnapshot(profile, loginUid, 100), {
    profileId: "profile-a",
    loginUid,
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
  assert.equal(profile.emoji, 7);
});

test("keeps participant display-name fallback without emoji or rating decorations", () => {
  for (const [
    overrides,
    displayName,
  ] of /** @type {[Partial<Parameters<typeof buildEventParticipantSnapshot>[0]>, string][]} */ ([
    [{}, " Player "],
    [{ username: "" }, "0x12...cdef"],
    [{ username: "", eth: "" }, "1234...DEFG"],
    [{ username: "", eth: "", sol: "" }, "anon"],
  ])) {
    const snapshot = buildEventParticipantSnapshot(
      { ...profile, ...overrides },
      loginUid,
      0,
    );
    assert.ok(snapshot);
    assert.equal(snapshot.displayName, displayName);
  }
});

test("new participants accept catalog emoji numbers including zero and reject legacy coercions", () => {
  for (const emoji of [0, 7, 155, 1000, 1466]) {
    const snapshot = buildEventParticipantSnapshot(
      { ...profile, emoji },
      loginUid,
      0,
    );
    assert.ok(snapshot);
    assert.equal(snapshot.emojiId, emoji);
  }
  for (const emoji of [
    7.9,
    "7",
    "7.9",
    "",
    "invalid",
    Infinity,
    NaN,
    -1,
    156,
    1467,
  ]) {
    assert.equal(
      Reflect.apply(buildEventParticipantSnapshot, undefined, [
        { ...profile, emoji },
        loginUid,
        0,
      ]),
      null,
    );
  }
  for (const aura of ["", " rainbow ", "future", null]) {
    assert.equal(
      Reflect.apply(buildEventParticipantSnapshot, undefined, [
        { ...profile, aura },
        loginUid,
        0,
      ]),
      null,
    );
  }
});

test("new participants reject invalid profile IDs, noncanonical login IDs and timestamps", () => {
  for (const profileId of [
    "",
    " profile-a ",
    "invalid/id",
    "invalid\u0000id",
  ]) {
    assert.equal(
      buildEventParticipantSnapshot({ ...profile, profileId }, loginUid, 0),
      null,
    );
  }
  for (const invalidLogin of [
    "",
    ` ${loginUid}`,
    null,
    "a".repeat(129),
    "invalid/login",
  ]) {
    assert.equal(
      Reflect.apply(buildEventParticipantSnapshot, undefined, [
        profile,
        invalidLogin,
        0,
      ]),
      null,
    );
  }
  for (const invalidTime of [
    -1,
    0.5,
    "1",
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      Reflect.apply(buildEventParticipantSnapshot, undefined, [
        profile,
        loginUid,
        invalidTime,
      ]),
      null,
    );
  }
});

test("participant names retain exact UTF-8 limits while aura remains a fixed enum", () => {
  for (const username of ["x".repeat(256), "é".repeat(128)]) {
    assert.notEqual(
      buildEventParticipantSnapshot({ ...profile, username }, loginUid, 0),
      null,
    );
    assert.equal(
      buildEventParticipantSnapshot(
        { ...profile, username: `${username}x` },
        loginUid,
        0,
      ),
      null,
    );
  }
  assert.equal(
    buildEventParticipantSnapshot(
      { ...profile, username: ` ${"x".repeat(256)}` },
      loginUid,
      0,
    ),
    null,
  );
  assert.equal(
    Reflect.apply(buildEventParticipantSnapshot, undefined, [
      { ...profile, aura: "x".repeat(256) },
      loginUid,
      0,
    ]),
    null,
  );
});
