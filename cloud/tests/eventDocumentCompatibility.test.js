"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  readEventDocument,
  readPlainEventDocument,
  readEventParticipantDocument,
  readEventRoundDocument,
  readEventMatchDocument,
  cloneEventDocument,
  copyEventParticipant,
  copyEventParticipantToMatchSlot,
} = require("../runtime/events/documents");
const {
  applyMatchResolution,
  assignWinnerToNextRound,
  recomputeRoundStatuses,
} = require("../runtime/events/startTransitionCore");
const {
  event,
  participant,
  match,
  round,
} = require("./fixtures/canonicalEvents");

test("canonical event documents retain identity and clone only complete records", () => {
  const source = event({ participants: { p1: participant("p1") } });
  assert.strictEqual(readEventDocument(source), source);
  assert.strictEqual(readPlainEventDocument(source), source);
  for (const mode of /** @type {const} */ ([undefined, "structured"])) {
    const copy = cloneEventDocument(source, mode);
    assert.notStrictEqual(copy, source);
    assert.notStrictEqual(copy.participants, source.participants);
    assert.deepEqual(copy, source);
  }
  for (const invalid of [
    [],
    { eventId: source.eventId },
    { ...source, extension: true },
    { ...source, legacyUndefined: undefined },
    { ...source, startAtMs: "1" },
  ]) {
    assert.equal(readEventDocument(invalid), null);
    assert.equal(readPlainEventDocument(invalid), null);
  }
});

test("participant copies preserve exact fields and reject partial or extended source values", () => {
  const source = participant("p1", { displayName: " Player ", emojiId: 7 });
  const copied = copyEventParticipant(source, { profileId: "p2" });
  assert.deepEqual(copied, { ...source, profileId: "p2" });
  assert.notStrictEqual(copied, source);
  assert.equal(source.profileId, "p1");
  for (const invalid of [
    { loginUid: "u1" },
    { ...source, emojiId: "7.9" },
    { ...source, futureField: true },
  ]) {
    assert.equal(readEventParticipantDocument(invalid), null);
  }
  assert.throws(
    () =>
      Reflect.apply(copyEventParticipant, undefined, [
        source,
        { emojiId: "7.9" },
      ]),
    /invalid-canonical-event-participant/,
  );
});

test("slot copies write complete appearance and clear every field explicitly", () => {
  const target = match("0_0");
  const player = participant("p1", {
    loginUid: "u1",
    displayName: "Player",
    emojiId: 0,
  });
  assert.equal(copyEventParticipantToMatchSlot(target, "host", player), true);
  assert.equal(copyEventParticipantToMatchSlot(target, "host", player), false);
  assert.equal(target.hostDisplayName, "Player");
  assert.equal(target.hostEmojiId, 0);
  assert.equal(target.hostAura, "none");
  assert.equal(copyEventParticipantToMatchSlot(target, "host", null), true);
  assert.deepEqual(target, match("0_0"));
});

test("round readers reject absent, array and extension-based match containers", () => {
  const valid = round(0, {
    status: "upcoming",
    matches: { "0_0": match("0_0") },
  });
  const { matches, ...missing } = valid;
  assert.equal(Object.keys(matches).length, 1);
  for (const invalid of [
    missing,
    { ...valid, matches: [] },
    { ...valid, matches: { "0_0": "retained" } },
    { ...valid, futureField: true },
  ]) {
    assert.equal(readEventRoundDocument(invalid), null);
  }
});

test("round status recomputation preserves canonical timestamp and resolution semantics", () => {
  const final = match("0_0", {
    status: "pending",
    hostProfileId: "p1",
    guestProfileId: "p2",
  });
  const rounds = {
    0: round(0, { status: "active", matches: { "0_0": final } }),
  };
  assert.ok(rounds[0].matches["0_0"]);
  assert.equal(
    applyMatchResolution(
      rounds[0].matches["0_0"],
      { status: "host", winnerProfileId: "p1", loserProfileId: "p2" },
      42,
    ),
    true,
  );
  assert.deepEqual(recomputeRoundStatuses({ rounds, nowMs: 42 }), {
    didChange: true,
    finalRoundIndex: 0,
    earliestUnresolvedRoundIndex: null,
    finalRoundWinnerProfileId: "p1",
  });
  assert.equal(rounds[0].status, "completed");
  assert.equal(rounds[0].completedAtMs, 42);
  assert.equal(recomputeRoundStatuses({ rounds, nowMs: 99 }).didChange, false);
  assert.equal(rounds[0].completedAtMs, 42);
});

test("match readers reject padded statuses, numeric timestamps and retained extension fields", () => {
  const valid = match("0_0", {
    status: "host",
    hostProfileId: "p1",
    guestProfileId: "p2",
  });
  for (const patch of [
    { status: " host " },
    { winnerProfileId: " p1 " },
    { resolvedAtMs: "1" },
    { custom: { retained: true } },
  ]) {
    assert.equal(readEventMatchDocument({ ...valid, ...patch }), null);
  }
});

test("winner advancement uses typed participant slots and does not overwrite unrelated slots", () => {
  const first = participant("p1");
  const second = participant("p2");
  const rounds = {
    1: round(1, {
      status: "upcoming",
      matches: {
        "1_0": match("1_0", { guestProfileId: "p2" }, { p2: second }),
      },
    }),
  };
  assert.equal(
    assignWinnerToNextRound({
      rounds,
      roundIndex: 0,
      matchIndex: 0,
      winnerProfileId: "p1",
      participantsById: { p1: first, p2: second },
    }),
    true,
  );
  assert.ok(rounds[1].matches["1_0"]);
  assert.equal(rounds[1].matches["1_0"].hostProfileId, "p1");
  assert.equal(rounds[1].matches["1_0"].guestProfileId, "p2");
  assert.equal(rounds[1].matches["1_0"].hostAura, "none");
});
