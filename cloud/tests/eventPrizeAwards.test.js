"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AAHNGEEZ_PRIZES_EVENT_ID,
  CAKES_PRIZES_EVENT_ID,
  CARD_NFT_2_PRIZES_EVENT_ID,
  FLOPAWRETTES_PRIZES_EVENT_ID,
  MI_NOTE_CARDS_PRIZES_EVENT_ID,
  PEER_STUDY_3_AFELLA_2_PRIZES_EVENT_ID,
  PICKME_PORTS_PRIZES_EVENT_ID,
  PLASTIC_FOOLS_POCKET_PRIZES_EVENT_ID,
  SHELVES_PRIZES_EVENT_ID,
  VEHICLE_WAMMIN_PRIZES_EVENT_ID,
} = require("@mons/shared/event-prizes");
const {
  buildEventPrizeAssignments,
  isEventPrizeId,
  normalizeEventPrizeAssignments,
} = require("../runtime/eventPrizeAwards");

/** @type {import("../runtime/events/model").EventPlacement[]} */
const placements = [
  { place: 1, profileId: "first" },
  { place: 2, profileId: "second" },
  { place: 3, profileId: "third" },
];

/** @param {Readonly<Record<string, string>>} selections @param {string} [eventId] */
const build = (selections, eventId = "NN3eRzoZo80") =>
  buildEventPrizeAssignments({
    eventId,
    placements,
    selections,
    assignedAtMs: 1234,
  });

/** @param {Record<string, import("../runtime/eventReads").EventPrizeAssignmentRecord>} values @param {string | number} place */
function assignment(values, place) {
  const value = values[place];
  assert.ok(value);
  return value;
}

test("honors distinct ranked preferences", () => {
  const assignments = build({
    first: "1514",
    second: "1092",
    third: "1111",
  });
  assert.equal(assignment(assignments, "1").prizeId, "1514");
  assert.equal(assignment(assignments, "2").prizeId, "1092");
  assert.equal(assignment(assignments, "3").prizeId, "1111");
});

test("resolves preference conflicts in rank order", () => {
  const assignments = build({
    first: "1092",
    second: "1092",
    third: "1514",
  });
  assert.equal(assignment(assignments, "1").prizeId, "1092");
  assert.equal(assignment(assignments, "2").prizeId, "1111");
  assert.equal(assignment(assignments, "3").prizeId, "1514");
});

test("protects lower-ranked preferences from missing higher preferences", () => {
  const assignments = build({ second: "1092", third: "1111" });
  assert.equal(assignment(assignments, "1").prizeId, "1514");
  assert.equal(assignment(assignments, "2").prizeId, "1092");
  assert.equal(assignment(assignments, "3").prizeId, "1111");
});

test("uses stable fallbacks for missing and invalid preferences", () => {
  const assignments = build({ first: "invalid" });
  assert.equal(assignment(assignments, "1").prizeId, "1092");
  assert.equal(assignment(assignments, "2").prizeId, "1111");
  assert.equal(assignment(assignments, "3").prizeId, "1514");
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
  assert.equal(assignment(preferred, "1").prizeId, "6793");
  assert.equal(assignment(preferred, "2").prizeId, "1866");
  assert.equal(assignment(preferred, "3").prizeId, "1682");

  const fallback = build({}, eventId);
  assert.equal(assignment(fallback, "1").prizeId, "1866");
  assert.equal(assignment(fallback, "2").prizeId, "1682");
  assert.equal(assignment(fallback, "3").prizeId, "6793");
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
  assert.equal(assignment(preferred, "1").prizeId, "280");
  assert.equal(assignment(preferred, "2").prizeId, "282");
  assert.equal(assignment(preferred, "3").prizeId, "283");

  const conflict = build(
    {
      first: "283",
      second: "283",
      third: "280",
    },
    eventId,
  );
  assert.equal(assignment(conflict, "1").prizeId, "283");
  assert.equal(assignment(conflict, "2").prizeId, "282");
  assert.equal(assignment(conflict, "3").prizeId, "280");

  const fallback = build({}, eventId);
  assert.equal(assignment(fallback, "1").prizeId, "282");
  assert.equal(assignment(fallback, "2").prizeId, "283");
  assert.equal(assignment(fallback, "3").prizeId, "280");
});

test("assigns second Artifact Magazine 3 prizes by preference with the supplied fallback order", () => {
  const eventId = "oXAceF6anag";
  const preferred = build(
    {
      first: "284",
      second: "281",
      third: "279",
    },
    eventId,
  );
  assert.equal(assignment(preferred, "1").prizeId, "284");
  assert.equal(assignment(preferred, "2").prizeId, "281");
  assert.equal(assignment(preferred, "3").prizeId, "279");

  const conflict = build(
    {
      first: "279",
      second: "279",
      third: "284",
    },
    eventId,
  );
  assert.equal(assignment(conflict, "1").prizeId, "279");
  assert.equal(assignment(conflict, "2").prizeId, "281");
  assert.equal(assignment(conflict, "3").prizeId, "284");

  const fallback = build({}, eventId);
  assert.equal(assignment(fallback, "1").prizeId, "281");
  assert.equal(assignment(fallback, "2").prizeId, "279");
  assert.equal(assignment(fallback, "3").prizeId, "284");
});

test("assigns Rare Weitsmans prizes by preference with the supplied fallback order", () => {
  const eventId = "RpPjMNyrJJa";
  const preferred = build(
    {
      first: "221",
      second: "217",
      third: "220",
    },
    eventId,
  );
  assert.equal(assignment(preferred, "1").prizeId, "221");
  assert.equal(assignment(preferred, "2").prizeId, "217");
  assert.equal(assignment(preferred, "3").prizeId, "220");

  const conflict = build(
    {
      first: "220",
      second: "220",
      third: "221",
    },
    eventId,
  );
  assert.equal(assignment(conflict, "1").prizeId, "220");
  assert.equal(assignment(conflict, "2").prizeId, "217");
  assert.equal(assignment(conflict, "3").prizeId, "221");

  const fallback = build({}, eventId);
  assert.equal(assignment(fallback, "1").prizeId, "217");
  assert.equal(assignment(fallback, "2").prizeId, "220");
  assert.equal(assignment(fallback, "3").prizeId, "221");
});

test("assigns Planet Peppa prizes by preference with the supplied fallback order", () => {
  const eventId = "z3oj52Iiime";
  const preferred = build(
    {
      first: "3729",
      second: "3727",
      third: "3728",
    },
    eventId,
  );
  assert.equal(assignment(preferred, "1").prizeId, "3729");
  assert.equal(assignment(preferred, "2").prizeId, "3727");
  assert.equal(assignment(preferred, "3").prizeId, "3728");

  const conflict = build(
    {
      first: "3728",
      second: "3728",
      third: "3729",
    },
    eventId,
  );
  assert.equal(assignment(conflict, "1").prizeId, "3728");
  assert.equal(assignment(conflict, "2").prizeId, "3727");
  assert.equal(assignment(conflict, "3").prizeId, "3729");

  const fallback = build({}, eventId);
  assert.equal(assignment(fallback, "1").prizeId, "3727");
  assert.equal(assignment(fallback, "2").prizeId, "3728");
  assert.equal(assignment(fallback, "3").prizeId, "3729");
});

for (const [
  collectionName,
  eventId,
  prizeIds,
] of /** @type {[string, string, [string, string, string]][]} */ ([
  ["Shelves", SHELVES_PRIZES_EVENT_ID, ["865", "1643", "1213"]],
  ["Vehicle Wammin", VEHICLE_WAMMIN_PRIZES_EVENT_ID, ["1241", "443", "1274"]],
  ["MI Note Cards", MI_NOTE_CARDS_PRIZES_EVENT_ID, ["561", "1025", "1195"]],
  ["Flopawrettes", FLOPAWRETTES_PRIZES_EVENT_ID, ["3749", "4174", "1173"]],
  [
    "peer study 3: afella 2",
    PEER_STUDY_3_AFELLA_2_PRIZES_EVENT_ID,
    ["228", "184", "339"],
  ],
  ["Cakes", CAKES_PRIZES_EVENT_ID, ["17", "13", "15"]],
  [
    "Plastic Fools Pocket",
    PLASTIC_FOOLS_POCKET_PRIZES_EVENT_ID,
    ["100", "914", "1015"],
  ],
  ["Card NFT 2", CARD_NFT_2_PRIZES_EVENT_ID, ["2046", "5121", "462"]],
  ["pick-me ports", PICKME_PORTS_PRIZES_EVENT_ID, ["298", "894", "1031"]],
  ["aahngeez!", AAHNGEEZ_PRIZES_EVENT_ID, ["172", "104", "149"]],
])) {
  test(`assigns ${collectionName} prizes by preference with the supplied fallback order`, () => {
    const [firstPrizeId, secondPrizeId, thirdPrizeId] = prizeIds;
    const preferred = build(
      {
        first: thirdPrizeId,
        second: firstPrizeId,
        third: secondPrizeId,
      },
      eventId,
    );
    assert.equal(assignment(preferred, "1").prizeId, thirdPrizeId);
    assert.equal(assignment(preferred, "2").prizeId, firstPrizeId);
    assert.equal(assignment(preferred, "3").prizeId, secondPrizeId);

    const conflict = build(
      {
        first: secondPrizeId,
        second: secondPrizeId,
        third: thirdPrizeId,
      },
      eventId,
    );
    assert.equal(assignment(conflict, "1").prizeId, secondPrizeId);
    assert.equal(assignment(conflict, "2").prizeId, firstPrizeId);
    assert.equal(assignment(conflict, "3").prizeId, thirdPrizeId);

    const fallback = build({}, eventId);
    assert.deepEqual(
      [1, 2, 3].map((place) => assignment(fallback, place).prizeId),
      prizeIds,
    );
  });
}

test("validates prize IDs against their configured event", () => {
  assert.equal(isEventPrizeId("NN3eRzoZo80", "1092"), true);
  assert.equal(isEventPrizeId("NN3eRzoZo80", "1866"), false);
  assert.equal(isEventPrizeId("FRkdorMWaYW", "1866"), true);
  assert.equal(isEventPrizeId("FRkdorMWaYW", "1092"), false);
  assert.equal(isEventPrizeId("VOxalSrexcA", "282"), true);
  assert.equal(isEventPrizeId("VOxalSrexcA", "1866"), false);
  assert.equal(isEventPrizeId("oXAceF6anag", "281"), true);
  assert.equal(isEventPrizeId("oXAceF6anag", "282"), false);
  assert.equal(isEventPrizeId("RpPjMNyrJJa", "217"), true);
  assert.equal(isEventPrizeId("RpPjMNyrJJa", "281"), false);
  assert.equal(isEventPrizeId("z3oj52Iiime", "3727"), true);
  assert.equal(isEventPrizeId("z3oj52Iiime", "217"), false);
  assert.equal(isEventPrizeId(SHELVES_PRIZES_EVENT_ID, "865"), true);
  assert.equal(isEventPrizeId(SHELVES_PRIZES_EVENT_ID, "1241"), false);
  assert.equal(isEventPrizeId(VEHICLE_WAMMIN_PRIZES_EVENT_ID, "1241"), true);
  assert.equal(isEventPrizeId(VEHICLE_WAMMIN_PRIZES_EVENT_ID, "865"), false);
  assert.equal(isEventPrizeId(MI_NOTE_CARDS_PRIZES_EVENT_ID, "561"), true);
  assert.equal(isEventPrizeId(MI_NOTE_CARDS_PRIZES_EVENT_ID, "1092"), false);
  assert.deepEqual(build({ first: "1092" }, "unsupported"), {});
});

test("canonical assignments reject fractional timestamps, duplicate prizes and partial entries", () => {
  const first = {
    eventId: "NN3eRzoZo80",
    profileId: "first",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 1234,
  };
  const valid = { 1: first };
  assert.deepEqual(normalizeEventPrizeAssignments(valid, first.eventId), valid);
  for (const assignments of [
    { 1: { ...first, assignedAtMs: 1234.8 } },
    { 1: { ...first, assignedAtMs: "1234" } },
    { 1: first, 2: { ...first, profileId: "second", place: 2 } },
    { 1: { profileId: "first", prizeId: "1092" } },
    { 1: { ...first, extension: true } },
  ])
    assert.throws(() =>
      normalizeEventPrizeAssignments(assignments, first.eventId),
    );
});
