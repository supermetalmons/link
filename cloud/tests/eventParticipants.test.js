"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { getEventParticipantIds } = require("../functions/events/participants");

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
