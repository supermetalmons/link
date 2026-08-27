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

const { mapDatabaseEventRecord, mapEventPrizeAssignment } =
  await import("../src/connection/eventMappers.ts");
const { mapProfileGameProjection } = await import("@mons/shared/navigation");
const {
  normalizeFiniteNumber,
  normalizeString,
  normalizeStringOrNull,
  readTimestampMillis,
} = await import("../src/connection/valueNormalizers.ts");

test("normalizes primitive Firebase and Firestore values", () => {
  assert.equal(normalizeString("value"), "value");
  assert.equal(normalizeString(2), "");
  assert.equal(normalizeStringOrNull(""), null);
  assert.equal(normalizeFiniteNumber("12.9"), 12);
  assert.equal(normalizeFiniteNumber("bad", 7), 7);
  assert.equal(readTimestampMillis({ toMillis: () => 42.9 }), 42);
  assert.equal(readTimestampMillis({ toMillis: () => NaN }), 0);
});

test("maps navigation games with legacy aliases and validation", () => {
  assert.deepEqual(
    mapProfileGameProjection(
      {
        kind: "auto",
        status: "active",
        opponentEmojiId: "25",
        opponentDisplayName: "guest",
        listSortAt: { toMillis: () => 1234 },
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
      entityType: "event",
      eventId: "event-1",
      status: "active",
      listSortAt: 10,
      participantPreview: [
        { profileId: "p1", displayName: "One", emojiId: "5", aura: "a" },
        null,
      ],
    },
    "fallback",
  );
  assert.equal(item?.entityType, "event");
  assert.deepEqual(item?.participantPreview, [
    { profileId: "p1", displayName: "One", emojiId: 5, aura: "a" },
  ]);
  assert.equal(item?.participantCount, 1);
});

test("maps nested event records and validates configured prizes", () => {
  const eventId = "NN3eRzoZo80";
  const event = mapDatabaseEventRecord(
    {
      status: "active",
      createdAtMs: "10",
      participants: {
        p1: { displayName: "One", emojiId: "7", state: "winner" },
      },
      rounds: {
        1: {
          status: "completed",
          matches: {
            m1: { status: "host", hostProfileId: "p1" },
          },
        },
      },
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
          prizeId: "not-a-prize",
          assignedAtMs: 20,
        },
      },
    },
    eventId,
  );

  assert.equal(event?.eventId, eventId);
  assert.equal(event?.participants.p1.profileId, "p1");
  assert.equal(event?.rounds["1"].matches.m1.matchKey, "m1");
  assert.equal(event?.prizeAssignments?.["1"]?.prizeId, "1092");
  assert.equal(event?.prizeAssignments?.["2"], undefined);
  assert.equal(
    mapEventPrizeAssignment(
      {
        eventId,
        profileId: "p1",
        place: 4,
        prizeId: "1092",
        assignedAtMs: 20,
      },
      eventId,
    ),
    null,
  );
});
