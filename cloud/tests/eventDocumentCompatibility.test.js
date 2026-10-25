"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  readEventDocument,
  readPlainEventDocument,
  readEventParticipantDocument,
  cloneEventDocument,
  copyEventParticipant,
  copyEventParticipantToMatchSlot,
} = require("../runtime/events/documents");
const {
  applyMatchResolution,
  assignWinnerToNextRound,
  buildScheduledEventDueUpdatesCore,
  recomputeRoundStatuses,
} = require("../runtime/events/startTransitionCore");
const { getEventPrizePlacements } = require("../runtime/events/bracket");
const { getEventField } = require("../runtime/eventCommands");
const { createSeededRandom } = require("../runtime/shared/ids");

test("event documents keep source identity and explicit clone serialization boundaries", () => {
  const source = {
    eventId: "event-one",
    status: "scheduled",
    participants: {},
    extension: { retained: [true, null, 3] },
    legacyUndefined: undefined,
  };
  const document = readEventDocument(source);
  assert.strictEqual(document, source);
  assert.deepEqual(Object.getOwnPropertySymbols(document), []);
  assert.strictEqual(readPlainEventDocument(source), source);
  assert.equal(readPlainEventDocument([]), null);
  const jsonClone = cloneEventDocument(document);
  const structuredCopy = cloneEventDocument(document, "structured");
  assert.notStrictEqual(jsonClone, source);
  assert.notStrictEqual(jsonClone.extension, source.extension);
  assert.equal(Object.hasOwn(jsonClone, "legacyUndefined"), false);
  assert.equal(Object.hasOwn(structuredCopy, "legacyUndefined"), true);
  assert.equal(JSON.stringify(jsonClone), JSON.stringify(source));
  assert.deepEqual(structuredCopy, source);
});

test("participant copies retain raw legacy fields and change only their explicit patch", () => {
  const source = {
    loginUid: " u1 ",
    displayName: " Player ",
    emojiId: "7.9",
    futureField: { retained: true },
  };
  const copied = copyEventParticipant(readEventParticipantDocument(source), {
    profileId: "p1",
  });
  assert.deepEqual(copied, { ...source, profileId: "p1" });
  assert.notStrictEqual(copied, source);
  assert.strictEqual(copied.futureField, source.futureField);
  assert.equal(Object.hasOwn(source, "profileId"), false);
});

test("slot copies preserve assigned undefined until the original JSON boundary", () => {
  const match = { hostDisplayName: "previous", hostEmojiId: 9 };
  assert.equal(
    copyEventParticipantToMatchSlot(match, "host", {
      profileId: "p1",
      loginUid: "u1",
    }),
    true,
  );
  assert.equal(Object.hasOwn(match, "hostDisplayName"), true);
  assert.equal(Object.hasOwn(match, "hostEmojiId"), true);
  assert.equal(match.hostDisplayName, undefined);
  assert.equal(match.hostEmojiId, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(match)), {
    hostProfileId: "p1",
    hostLoginUid: "u1",
    hostAura: null,
    hostSlotBlocked: false,
  });
});

test("round status updates distinguish missing matches from an empty array", () => {
  const missing = { 0: { status: "active", futureField: true } };
  const array = { 0: { status: "active", matches: [], futureField: true } };
  assert.deepEqual(recomputeRoundStatuses({ rounds: missing, nowMs: 42 }), {
    didChange: false,
    finalRoundIndex: 0,
    earliestUnresolvedRoundIndex: null,
    finalRoundWinnerProfileId: null,
  });
  assert.deepEqual(missing, { 0: { status: "active", futureField: true } });
  assert.deepEqual(recomputeRoundStatuses({ rounds: array, nowMs: 42 }), {
    didChange: true,
    finalRoundIndex: 0,
    earliestUnresolvedRoundIndex: 0,
    finalRoundWinnerProfileId: null,
  });
  assert.deepEqual(array, {
    0: {
      status: "upcoming",
      matches: [],
      futureField: true,
      completedAtMs: null,
    },
  });
});

test("match resolution compares raw statuses but retains normalized identity equivalence", () => {
  const match = {
    status: " host ",
    winnerProfileId: " p1 ",
    resolvedAtMs: "12.9",
    custom: { retained: true },
  };
  assert.equal(
    applyMatchResolution(
      match,
      { status: "host", winnerProfileId: "p1", loserProfileId: null },
      42,
    ),
    true,
  );
  assert.deepEqual(match, {
    status: "host",
    winnerProfileId: " p1 ",
    resolvedAtMs: 42,
    custom: { retained: true },
  });
  assert.equal(Object.hasOwn(match, "loserProfileId"), false);
});

test("prize fallback retains truthy scalar match entries and string match containers", () => {
  const participantsById = Object.fromEntries(
    ["p1", "p2", "p3"].map((profileId) => [
      profileId,
      { profileId, loginUid: `${profileId}-login` },
    ]),
  );
  for (const matches of [
    { "0_0": "retained" },
    { "0_0": 42 },
    { "0_0": true },
    "retained",
  ]) {
    assert.deepEqual(
      getEventPrizePlacements({
        event: { winnerProfileId: "p1" },
        rounds: { 0: { matches } },
        participantsById,
      }),
      [
        { place: 1, profileId: "p1" },
        { place: 2, profileId: "p2" },
        { place: 3, profileId: "p3" },
      ],
    );
  }
  for (const matches of [{ "0_0": "" }, { "0_0": false }, { "0_0": 0 }, ""]) {
    assert.deepEqual(
      getEventPrizePlacements({
        event: { winnerProfileId: "p1" },
        rounds: { 0: { matches } },
        participantsById,
      }),
      [],
    );
  }
});

test("advancing into a truthy scalar match retains the mutation failure", () => {
  for (const value of ["retained", 42, true]) {
    const rounds = { 1: { matches: { "1_0": value } } };
    const before = structuredClone(rounds);
    assert.throws(
      () =>
        assignWinnerToNextRound({
          rounds,
          roundIndex: 0,
          matchIndex: 0,
          winnerProfileId: "p1",
          participantsById: { p1: { profileId: "p1", loginUid: "u1" } },
        }),
      TypeError,
    );
    assert.deepEqual(rounds, before);
  }
});

test("scheduled plans keep participant fallback IDs and strict match-seed emoji behavior", async () => {
  const eventId = "event-document-compatibility";
  const participants = {
    p1: {
      loginUid: "u1",
      displayName: " P1 ",
      emojiId: "7.9",
      aura: "",
      futureField: { retained: true },
    },
    p2: {
      profileId: "p2",
      loginUid: "u2",
      displayName: "P2",
      emojiId: 8,
      aura: null,
    },
  };
  const event = {
    eventId,
    status: "scheduled",
    startAtMs: 100,
    updatedAtMs: 1,
    participants,
    rounds: {},
  };
  const ownershipSnapshot = {
    canonicalProfileIdByProfileId: new Map([
      ["p1", "p1"],
      ["p2", "p2"],
    ]),
    loginOwnerByUid: new Map([
      ["u1", { profileId: "p1", revision: 1 }],
      ["u2", { profileId: "p2", revision: 1 }],
    ]),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  };
  const result = await buildScheduledEventDueUpdatesCore({
    eventId,
    event,
    nowMs: 100,
    random: createSeededRandom("event-document-compatibility"),
    buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    ownershipSnapshot,
  });
  assert.equal(result.didChange, true);
  assert.deepEqual(
    result.updates.map((command) => command.field ?? command.kind),
    [
      "invite",
      "match-creation",
      "match-creation",
      "status",
      "startedAtMs",
      "updatedAtMs",
      "currentRoundIndex",
      "bracketSize",
      "roundCount",
      "rounds",
    ],
  );
  const firstPlayerMatch = result.updates.find(
    (command) => command.kind === "match-creation" && command.playerId === "u1",
  );
  assert.equal(firstPlayerMatch.value.emojiId, 0);
  assert.equal(
    getEventField(result.updates, eventId, "participants"),
    undefined,
  );
  assert.deepEqual(event.participants.p1, {
    ...participants.p1,
    profileId: "p1",
  });
  const match = getEventField(result.updates, eventId, "rounds")["0"].matches[
    "0_0"
  ];
  const slot = match.hostProfileId === "p1" ? "host" : "guest";
  assert.equal(match[`${slot}EmojiId`], "7.9");
  assert.equal(match[`${slot}DisplayName`], " P1 ");
  assert.equal(Object.hasOwn(participants.p1, "profileId"), false);
});
