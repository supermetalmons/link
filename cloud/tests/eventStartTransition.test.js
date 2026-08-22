"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSeededRandom } = require("../functions/shared/ids");
const {
  buildScheduledEventDueUpdatesCore,
} = require("../functions/events/startTransitionCore");

const createParticipant = (index) => ({
  profileId: `profile-${index}`,
  loginUid: `login-${index}`,
  username: `player-${index}`,
  displayName: `player-${index}`,
  emojiId: index + 1,
  aura: "",
  joinedAtMs: index,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
});

const createEvent = (count) => ({
  eventId: "event-1",
  status: "scheduled",
  startAtMs: 100,
  supportsThirdPlaceMatch: true,
  thirdPlaceMatch: null,
  participants: Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `profile-${index}`,
      createParticipant(index),
    ]),
  ),
});

const transition = (count) =>
  buildScheduledEventDueUpdatesCore({
    eventId: "event-1",
    event: createEvent(count),
    nowMs: 100,
    random: createSeededRandom(`participants:${count}`),
    buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
  });

test("dismisses overdue events with fewer than two participants", async () => {
  for (const count of [0, 1]) {
    const result = await transition(count);
    assert.equal(result.didChange, true);
    assert.equal(result.updates["events/event-1/status"], "dismissed");
    assert.equal(result.updates["events/event-1/endedAtMs"], 100);
    assert.equal(
      Object.keys(result.updates).some((path) => path.startsWith("invites/")),
      false,
    );
  }
});

test("builds complete overdue brackets for supported participant counts", async () => {
  for (const [count, bracketSize, firstRoundInvites] of [
    [2, 2, 1],
    [3, 4, 1],
    [4, 4, 2],
    [32, 32, 16],
  ]) {
    const result = await transition(count);
    assert.equal(result.didChange, true);
    assert.equal(result.updates["events/event-1/status"], "active");
    assert.equal(result.updates["events/event-1/bracketSize"], bracketSize);
    assert.equal(
      Object.keys(result.updates).filter((path) => path.startsWith("invites/"))
        .length,
      firstRoundInvites,
    );
    assert.ok(result.updates["events/event-1/rounds"]);
    if (count >= 4) {
      assert.ok("events/event-1/thirdPlaceMatch" in result.updates);
    }
  }
});

test("leaves future and already-transitioned events unchanged", async () => {
  const future = createEvent(2);
  future.startAtMs = 101;
  assert.deepEqual(
    await buildScheduledEventDueUpdatesCore({
      eventId: "event-1",
      event: future,
      nowMs: 100,
      random: createSeededRandom("future"),
      buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    }),
    { didChange: false, updates: {} },
  );
  const active = createEvent(2);
  active.status = "active";
  assert.deepEqual(
    await buildScheduledEventDueUpdatesCore({
      eventId: "event-1",
      event: active,
      nowMs: 100,
      random: createSeededRandom("active"),
      buildRandomGameSeed: () => ({ gameVariant: "Classic", fen: "start-fen" }),
    }),
    { didChange: false, updates: {} },
  );
});
