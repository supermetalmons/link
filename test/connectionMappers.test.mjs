import { canonicalEvent } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  decodeEventView,
  decodeEventPrizeAssignmentView,
  normalizeEventPrizeId,
} = await import("@mons/shared/events");
const { mapProfileGameProjection } = await import("@mons/shared/navigation");
const { normalizeFiniteNumber, normalizeString, normalizeStringOrNull } =
  await import("../src/connection/valueNormalizers.ts");

test("normalizes primitive stored values", () => {
  assert.equal(normalizeString("value"), "value");
  assert.equal(normalizeString(2), "");
  assert.equal(normalizeStringOrNull(""), null);
  assert.equal(normalizeFiniteNumber("12.9"), 12);
  assert.equal(normalizeFiniteNumber("bad", 7), 7);
});

test("maps navigation games with canonical appearance values", () => {
  assert.deepEqual(
    mapProfileGameProjection(
      {
        schemaVersion: 3,
        projectorVersion: 3,
        source: "game-projector",
        entityType: "game",
        inviteId: "invite-1",
        latestMatchId: "invite-1",
        ownerProfileId: "profile",
        ownerRole: "host",
        ownerLoginId: null,
        hostLoginId: null,
        guestLoginId: null,
        hostProfileId: null,
        guestProfileId: null,
        opponentProfileId: null,
        opponentLoginId: null,
        sortBucket: 40,
        isPendingAutomatch: false,
        automatchStateHint: null,
        automatchCanceledAt: null,
        createdAt: 1234,
        updatedAt: 1234,
        endedAt: null,
        lastEventFingerprint: "test",
        lastEventType: null,
        lastEventReason: null,
        lastEventAt: 1234,
        kind: "auto",
        status: "active",
        opponentEmoji: 25,
        opponentName: "guest",
        listSortAt: 1234,
      },
      "invite-1",
    ),
    {
      id: "invite-1",
      entityType: "game",
      inviteId: "invite-1",
      kind: "auto",
      status: "active",
      sortBucket: 40,
      listSortAtMs: 1234,
      hostLoginId: null,
      guestLoginId: null,
      opponentProfileId: null,
      opponentName: "guest",
      opponentEmoji: 25,
      automatchStateHint: null,
      isPendingAutomatch: false,
    },
  );
  assert.equal(
    mapProfileGameProjection(
      { status: "ended", opponentEmoji: null },
      "invite-2",
    ),
    null,
  );
});

test("maps event navigation previews and rejects pending projections", () => {
  assert.equal(
    mapProfileGameProjection(
      { entityType: "event", eventId: "event-1", status: "pending" },
      "fallback",
    ),
    null,
  );
  const item = mapProfileGameProjection(
    {
      schemaVersion: 2,
      source: "event-projector",
      id: "event_event-1",
      ownerProfileId: "profile",
      sortBucket: 40,
      startAt: null,
      updatedAt: 10,
      endedAt: null,
      participantCount: 1,
      winnerDisplayName: null,
      entityType: "event",
      eventId: "event-1",
      status: "active",
      listSortAt: 10,
      participantPreview: [
        { profileId: "p1", displayName: "One", emojiId: 5, aura: "none" },
      ],
    },
    "event_event-1",
  );
  assert.equal(item?.entityType, "event");
  assert.deepEqual(item?.participantPreview, [
    { profileId: "p1", displayName: "One", emojiId: 5, aura: "none" },
  ]);
  assert.equal(item?.participantCount, 1);
});

test("canonical event views require complete records and an explicit Sunday Mons flag", () => {
  for (const eventId of ["NN3eRzoZo80", "ordinary-event"]) {
    assert.equal(decodeEventView({}, eventId), null);
    for (const isSundayMons of [true, false]) {
      const event = canonicalEvent({ eventId, isSundayMons });
      assert.strictEqual(decodeEventView(event, eventId), event);
    }
    const valid = canonicalEvent({ eventId });
    for (const isSundayMons of [undefined, "true", 1, null]) {
      assert.equal(decodeEventView({ ...valid, isSundayMons }, eventId), null);
    }
  }
});

test("canonical nested events retain catalog-independent historical prize assignments", () => {
  const eventId = "NN3eRzoZo80";
  const event = canonicalEvent({
    eventId,
    status: "ended",
    participants: { p1: { displayName: "One", emojiId: 7, state: "winner" } },
    prizeAssignments: {
      1: {
        eventId,
        profileId: "p1",
        place: 1,
        prizeId: "1092",
        assignedAtMs: 20,
      },
      2: {
        eventId,
        profileId: "p2",
        place: 2,
        prizeId: "historical-prize",
        assignedAtMs: 20,
      },
    },
  });
  assert.strictEqual(decodeEventView(event, eventId), event);
  assert.ok(event.participants.p1);
  assert.ok(event.rounds["0"]?.matches["0_0"]);
  assert.ok(event.prizeAssignments["2"]);
  assert.equal(event.participants.p1.profileId, "p1");
  assert.equal(event.rounds["0"].matches["0_0"].matchKey, "0_0");
  assert.equal(event.prizeAssignments["2"].prizeId, "historical-prize");
  assert.equal(normalizeEventPrizeId("future-prize", "future-event"), null);
  assert.equal(
    decodeEventPrizeAssignmentView(
      { eventId, profileId: "p1", place: 4, prizeId: "1092", assignedAtMs: 20 },
      eventId,
    ),
    null,
  );
});
