"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildProfileEventPrizeMergeCopies,
  buildEventPrizeAssignments,
  normalizeEventPrizeAssignments,
} = require("../functions/eventPrizeAwards");

const placements = [
  { place: 1, profileId: "first" },
  { place: 2, profileId: "second" },
  { place: 3, profileId: "third" },
];

const build = (selections) =>
  buildEventPrizeAssignments({
    eventId: "NN3eRzoZo80",
    placements,
    selections,
    assignedAtMs: 1234,
  });

test("honors distinct ranked preferences", () => {
  const assignments = build({
    first: "1514",
    second: "1092",
    third: "1111",
  });
  assert.equal(assignments["1"].prizeId, "1514");
  assert.equal(assignments["2"].prizeId, "1092");
  assert.equal(assignments["3"].prizeId, "1111");
});

test("resolves preference conflicts in rank order", () => {
  const assignments = build({
    first: "1092",
    second: "1092",
    third: "1514",
  });
  assert.equal(assignments["1"].prizeId, "1092");
  assert.equal(assignments["2"].prizeId, "1111");
  assert.equal(assignments["3"].prizeId, "1514");
});

test("protects lower-ranked preferences from missing higher preferences", () => {
  const assignments = build({ second: "1092", third: "1111" });
  assert.equal(assignments["1"].prizeId, "1514");
  assert.equal(assignments["2"].prizeId, "1092");
  assert.equal(assignments["3"].prizeId, "1111");
});

test("uses stable fallbacks for missing and invalid preferences", () => {
  const assignments = build({ first: "invalid" });
  assert.equal(assignments["1"].prizeId, "1092");
  assert.equal(assignments["2"].prizeId, "1111");
  assert.equal(assignments["3"].prizeId, "1514");
});

test("normalizes only complete valid unique assignment entries", () => {
  const assignments = normalizeEventPrizeAssignments(
    {
      1: {
        eventId: "NN3eRzoZo80",
        profileId: "first",
        place: 1,
        prizeId: "1092",
        assignedAtMs: 1234.8,
      },
      2: {
        eventId: "NN3eRzoZo80",
        profileId: "second",
        place: 2,
        prizeId: "1092",
        assignedAtMs: 1234,
      },
    },
    "NN3eRzoZo80",
  );
  assert.deepEqual(Object.keys(assignments), ["1"]);
  assert.equal(assignments["1"].assignedAtMs, 1234);
});

test("copies source profile prizes to a merged target profile", () => {
  const copies = buildProfileEventPrizeMergeCopies({
    targetProfileId: "target",
    sourceProfileId: "source",
    targetPrizes: {},
    sourcePrizes: {
      NN3eRzoZo80: {
        eventId: "NN3eRzoZo80",
        profileId: "source",
        place: 2,
        prizeId: "1111",
        assignedAtMs: 1234,
      },
    },
  });
  assert.deepEqual(copies.NN3eRzoZo80, {
    eventId: "NN3eRzoZo80",
    profileId: "target",
    place: 2,
    prizeId: "1111",
    assignedAtMs: 1234,
  });
});

test("keeps an existing target prize when merged profiles share an event", () => {
  const copies = buildProfileEventPrizeMergeCopies({
    targetProfileId: "target",
    sourceProfileId: "source",
    targetPrizes: {
      NN3eRzoZo80: {
        eventId: "NN3eRzoZo80",
        profileId: "target",
        place: 1,
        prizeId: "1092",
        assignedAtMs: 1234,
      },
    },
    sourcePrizes: {
      NN3eRzoZo80: {
        eventId: "NN3eRzoZo80",
        profileId: "source",
        place: 2,
        prizeId: "1111",
        assignedAtMs: 1234,
      },
    },
  });
  assert.deepEqual(copies, {});
});
