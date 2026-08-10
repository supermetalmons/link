"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildProfileEventPrizeMergeCopies,
  buildEventPrizeAssignments,
  isEventPrizeId,
  normalizeEventPrizeAssignments,
} = require("../functions/eventPrizeAwards");

const placements = [
  { place: 1, profileId: "first" },
  { place: 2, profileId: "second" },
  { place: 3, profileId: "third" },
];

const build = (selections, eventId = "NN3eRzoZo80") =>
  buildEventPrizeAssignments({
    eventId,
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

test("assigns compressed prizes by preference with the supplied fallback order", () => {
  const eventId = "FRkdorMWaYW";
  const preferred = build(
    {
      first: "6793",
      second: "1866",
      third: "1682",
    },
    eventId,
  );
  assert.equal(preferred["1"].prizeId, "6793");
  assert.equal(preferred["2"].prizeId, "1866");
  assert.equal(preferred["3"].prizeId, "1682");

  const fallback = build({}, eventId);
  assert.equal(fallback["1"].prizeId, "1866");
  assert.equal(fallback["2"].prizeId, "1682");
  assert.equal(fallback["3"].prizeId, "6793");
});

test("assigns Artifact Magazine 3 prizes by preference with the supplied fallback order", () => {
  const eventId = "VOxalSrexcA";
  const preferred = build(
    {
      first: "280",
      second: "282",
      third: "283",
    },
    eventId,
  );
  assert.equal(preferred["1"].prizeId, "280");
  assert.equal(preferred["2"].prizeId, "282");
  assert.equal(preferred["3"].prizeId, "283");

  const conflict = build(
    {
      first: "283",
      second: "283",
      third: "280",
    },
    eventId,
  );
  assert.equal(conflict["1"].prizeId, "283");
  assert.equal(conflict["2"].prizeId, "282");
  assert.equal(conflict["3"].prizeId, "280");

  const fallback = build({}, eventId);
  assert.equal(fallback["1"].prizeId, "282");
  assert.equal(fallback["2"].prizeId, "283");
  assert.equal(fallback["3"].prizeId, "280");
});

test("validates prize IDs against their configured event", () => {
  assert.equal(isEventPrizeId("NN3eRzoZo80", "1092"), true);
  assert.equal(isEventPrizeId("NN3eRzoZo80", "1866"), false);
  assert.equal(isEventPrizeId("FRkdorMWaYW", "1866"), true);
  assert.equal(isEventPrizeId("FRkdorMWaYW", "1092"), false);
  assert.equal(isEventPrizeId("VOxalSrexcA", "282"), true);
  assert.equal(isEventPrizeId("VOxalSrexcA", "1866"), false);
  assert.deepEqual(build({ first: "1092" }, "unsupported"), {});
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

test("copies a compressed event prize to a merged target profile", () => {
  const copies = buildProfileEventPrizeMergeCopies({
    targetProfileId: "target",
    sourceProfileId: "source",
    targetPrizes: {},
    sourcePrizes: {
      FRkdorMWaYW: {
        eventId: "FRkdorMWaYW",
        profileId: "source",
        place: 1,
        prizeId: "1866",
        assignedAtMs: 5678,
      },
    },
  });
  assert.deepEqual(copies.FRkdorMWaYW, {
    eventId: "FRkdorMWaYW",
    profileId: "target",
    place: 1,
    prizeId: "1866",
    assignedAtMs: 5678,
  });
});
