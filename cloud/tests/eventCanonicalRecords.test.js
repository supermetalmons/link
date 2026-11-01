"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isEventRecord,
  isEventSnapshotResponse,
  decodeEventView,
} = require("../runtime/shared/events");
const {
  isEventPrizeAssignmentWireRecord,
} = require("../runtime/shared/event-prizes");
const { parseEventMutations } = require("../runtime/eventCommandCodec");
const {
  readEventDocument,
  createEventParticipantsDocument,
} = require("../runtime/events/documents");
const {
  buildScheduledEventDueUpdatesCore,
} = require("../runtime/events/startTransitionCore");
const {
  canonicalEvent,
  canonicalParticipant,
} = require("../../test/fixtures/canonicalData.mjs");

test("canonical events round-trip every nested lifecycle through the HTTP validator", () => {
  for (const status of /** @type {const} */ ([
    "scheduled",
    "active",
    "ended",
    "dismissed",
  ])) {
    const event = canonicalEvent({ status });
    const encoded = /** @type {unknown} */ (JSON.parse(JSON.stringify(event)));
    assert.equal(isEventRecord(encoded), true);
    assert.deepEqual(readEventDocument(encoded), event);
    assert.deepEqual(decodeEventView(encoded, event.eventId), event);
    assert.equal(
      isEventSnapshotResponse({
        ok: true,
        eventId: event.eventId,
        revision: 1,
        event: encoded,
        prizeSelections: {},
      }),
      true,
    );
  }
});

test("canonical event reads reject old versions, extensions and coerced nested values", () => {
  const participant = canonicalParticipant({
    profileId: "profile",
    loginUid: "login",
  });
  const event = canonicalEvent({ participants: { profile: participant } });
  const invalid = [
    { eventId: event.eventId, status: "scheduled" },
    { ...event, schemaVersion: 2 },
    { ...event, extension: true },
    { ...event, startAtMs: "1" },
    { ...event, startedAtMs: 1 },
    { ...event, participants: [] },
    ...[
      { emojiId: "1" },
      { aura: "" },
      { aura: "future" },
      { extra: true },
      { state: "eliminated" },
    ].map((patch) => ({
      ...event,
      participants: { profile: { ...participant, ...patch } },
    })),
  ];
  for (const value of invalid) {
    assert.equal(isEventRecord(value), false);
    assert.equal(readEventDocument(value), null);
    assert.equal(decodeEventView(value, event.eventId), null);
    assert.equal(
      isEventSnapshotResponse({
        ok: true,
        eventId: event.eventId,
        revision: 1,
        event: value,
        prizeSelections: {},
      }),
      false,
    );
  }
});

test("new event starts produce canonical complete match and round records", async () => {
  const participantRows = {
    host: canonicalParticipant({ profileId: "host", loginUid: "host-login" }),
    guest: canonicalParticipant({
      profileId: "guest",
      loginUid: "guest-login",
    }),
  };
  for (const player of Object.values(participantRows))
    assert.ok(
      require("../runtime/shared/events").isEventParticipantRecord(player),
    );
  const participants = createEventParticipantsDocument(
    /** @type {Record<string, import("../runtime/shared/events").EventParticipantRecord>} */ (
      participantRows
    ),
  );
  const event = canonicalEvent({ participants, supportsThirdPlaceMatch: true });
  const ownershipSnapshot = {
    canonicalProfileIdByProfileId: new Map([
      ["host", "host"],
      ["guest", "guest"],
    ]),
    loginOwnerByUid: new Map([
      ["host-login", { profileId: "host", revision: 1 }],
      ["guest-login", { profileId: "guest", revision: 1 }],
    ]),
    loginUidsByProfileId: new Map([
      ["host", ["host-login"]],
      ["guest", ["guest-login"]],
    ]),
    profileById: new Map(
      Object.entries(participants).map(([id, participant]) => [
        id,
        {
          revision: 1,
          profile: {
            profileId: id,
            username: participant.username,
            emoji: participant.emojiId,
            aura: participant.aura,
            eth: "",
            sol: "",
            rating: 1500,
          },
        },
      ]),
    ),
  };
  const result = await buildScheduledEventDueUpdatesCore({
    eventId: event.eventId,
    event,
    nowMs: 100,
    random: () => 0.25,
    buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "initial" }),
    ownershipSnapshot,
  });
  assert.equal(result.didChange, true);
  assert.equal(event.status, "active");
  assert.equal(isEventRecord(event), true);
  assert.ok(event.rounds["0"]?.matches["0_0"]);
  assert.equal(event.rounds["0"].matches["0_0"].status, "pending");
  assert.equal(event.rounds["0"].matches["0_0"].hostAura, "none");
  assert.equal(
    result.updates.filter((command) => command.kind === "match-creation")
      .length,
    2,
  );
});

test("event assignments retain historical IDs with an exact schema", () => {
  const assignment = {
    eventId: "historical-event",
    profileId: "winner",
    place: 1,
    prizeId: "historical-prize",
    assignedAtMs: 10,
  };
  assert.equal(isEventPrizeAssignmentWireRecord(assignment), true);
  assert.equal(
    isEventPrizeAssignmentWireRecord({ ...assignment, futureMetadata: {} }),
    false,
  );
  assert.equal(
    isEventPrizeAssignmentWireRecord({ ...assignment, assignedAtMs: "10" }),
    false,
  );
});

test("persisted event commands use complete named records and reject path dictionaries", () => {
  const commands = [
    { kind: "event", eventId: "event-1", value: canonicalEvent() },
    {
      kind: "event-field",
      eventId: "event-1",
      field: "winnerProfileId",
      value: null,
    },
  ];
  assert.deepEqual(
    parseEventMutations(
      /** @type {unknown} */ (JSON.parse(JSON.stringify(commands))),
    ),
    commands,
  );
  assert.throws(
    () => parseEventMutations({ "events/event-1/status": "active" }),
    /invalid-canonical-event-command/,
  );
  assert.throws(
    () =>
      parseEventMutations([
        {
          kind: "event-field",
          eventId: "event-1",
          field: "updatedAtMs",
          value: "2",
        },
      ]),
    /invalid-canonical-event-command/,
  );
  assert.throws(
    () =>
      parseEventMutations([
        {
          kind: "event-field",
          eventId: "event-1",
          field: "announceOnTelegram",
          value: true,
        },
      ]),
    /invalid-canonical-event-command/,
  );
});
