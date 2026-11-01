import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createManualInviteDocument,
  inviteHistoricalParticipants,
  inviteIsEventOwned,
  inviteMatchesParticipants,
  inviteMutationParticipants,
  inviteOpponent,
  inviteProjectionState,
  inviteRatingEvent,
  inviteRematchState,
  inviteTelegramFingerprint,
  inviteTimerEventId,
  inviteTrimmedParticipants,
  mergeInviteAutomatchOperation,
  presentationInviteView,
  readCanonicalInviteParticipants,
  readInviteDocument,
} from "@mons/shared/invite-records";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import { composeInviteWagerSource } from "../src/inviteWagerSource.ts";
import { normalizeInviteWagers } from "../src/inviteWagers.ts";
import {
  decodeInviteSourceSnapshot,
  normalizeInviteSource,
} from "../src/inviteSourceD1.ts";
import { inviteDocumentFixture } from "./inviteDocumentFixture.ts";
import { agreedWagerFixture } from "./wagerRecordFixture.ts";

const inviteId = "invite-document";
const paired = inviteDocumentFixture({ hostId: "host", guestId: "guest" });

test("invite document reads preserve canonical source identity and reject extensions", () => {
  const encoded = JSON.stringify(paired);
  assert.equal(readInviteDocument(paired), paired);
  assert.equal(JSON.stringify(paired), encoded);
  for (const value of [
    undefined,
    null,
    false,
    0,
    "",
    [],
    {},
    { hostId: "host" },
    { ...paired, extension: { retained: true } },
  ]) {
    assert.equal(readInviteDocument(value), null);
  }
});

test("participant reads require complete valid metadata", () => {
  for (const patch of [
    { hostColor: 19 },
    { hostRematches: false },
    { guestRematches: [] },
    { eventId: { retained: true } },
  ]) {
    const source = { ...paired, ...patch };
    assert.equal(normalizeInviteMetadata(inviteId, source).status, "invalid");
    assert.equal(readCanonicalInviteParticipants(source).status, "invalid");
  }
  const participants = readCanonicalInviteParticipants(paired);
  assert.ok(participants.status === "ok");
  assert.equal(participants.source, paired);
  assert.equal(inviteMatchesParticipants(paired, "guest", "host"), true);
  assert.equal(inviteOpponent(paired, "host"), "guest");
});

test("participant reads reject malformed seats without normalizing IDs", () => {
  for (const guestId of [undefined, false, 0, {}, [], " guest ", "host"]) {
    assert.equal(
      readCanonicalInviteParticipants({ ...paired, guestId }).status,
      "invalid",
    );
  }
  for (const hostId of [" host ", "a/b", "a".repeat(129), "\ud800"]) {
    assert.equal(
      readCanonicalInviteParticipants({ ...paired, hostId }).status,
      "invalid",
    );
  }
  const pending = inviteDocumentFixture({ hostId: "host" });
  assert.deepEqual(inviteMutationParticipants(pending), {
    hostId: "host",
    guestId: "",
  });
  assert.deepEqual(inviteTrimmedParticipants(pending), {
    hostId: "host",
    guestId: "",
  });
  assert.deepEqual(inviteHistoricalParticipants(pending), {
    hostId: "host",
    guestId: null,
  });
});

test("password protection follows the canonical invite kind", () => {
  const manual = readCanonicalInviteParticipants(paired);
  const automatch = readCanonicalInviteParticipants(
    inviteDocumentFixture({ hostId: "host", password: "private" }),
  );
  assert.ok(manual.status === "ok" && automatch.status === "ok");
  assert.equal(manual.passwordProtected, false);
  assert.equal(automatch.passwordProtected, true);
  for (const password of [undefined, false, 0, ""]) {
    assert.equal(readInviteDocument({ ...paired, password }), null);
  }
});

test("presentation and mutation views retain canonical rematch series", () => {
  const source = inviteDocumentFixture({
    ...paired,
    hostRematches: { state: "ended", indices: [1, 2] },
    guestRematches: { state: "open", indices: [1] },
  });
  const read = readCanonicalInviteParticipants(source);
  assert.ok(read.status === "ok");
  assert.deepEqual(presentationInviteView(read), {
    hostId: "host",
    guestId: "guest",
    hostRematches: source.hostRematches,
    guestRematches: source.guestRematches,
  });
  assert.deepEqual(inviteRematchState(source), {
    hostRematches: source.hostRematches,
    guestRematches: source.guestRematches,
    hostColor: "white",
  });
  for (const hostRematches of [
    "1;2x",
    "2;1",
    { state: "open", indices: [2, 1] },
  ])
    assert.equal(readInviteDocument({ ...source, hostRematches }), null);
});

test("event observations agree on canonical ownership and event identity", () => {
  const source = inviteDocumentFixture({
    ...paired,
    kind: "event",
    eventOwned: true,
    eventId: "event-one",
    eventRoundIndex: 0,
    eventMatchKey: "0_0",
  });
  assert.equal(inviteTimerEventId(source), "event-one");
  assert.equal(inviteIsEventOwned(source), true);
  assert.deepEqual(inviteRatingEvent(source), {
    eventOwned: true,
    isEventMatch: true,
    eventId: "event-one",
  });
  assert.equal(inviteTimerEventId(paired), null);
  assert.deepEqual(inviteRatingEvent(paired), {
    eventOwned: false,
    isEventMatch: false,
    eventId: null,
  });
  for (const eventId of ["", "   ", " event-one "])
    assert.equal(readInviteDocument({ ...source, eventId }), null);
});

test("projection observations accept only canonical timestamps and delivery versions", () => {
  const source = inviteDocumentFixture({
    hostId: "host",
    kind: "automatch",
    automatchStateHint: "canceled",
    automatchCanceledAt: 10,
    telegramDeliveryVersion: 2,
  });
  assert.deepEqual(inviteProjectionState(source), {
    hostId: "host",
    guestId: "",
    automatchStateHint: "canceled",
    automatchCanceledAt: 10,
    telegramDeliveryVersion: 2,
  });
  for (const automatchCanceledAt of [NaN, Infinity, -1, "1"])
    assert.equal(readInviteDocument({ ...source, automatchCanceledAt }), null);
  for (const telegramDeliveryVersion of [1, "2"])
    assert.equal(
      readInviteDocument({ ...source, telegramDeliveryVersion }),
      null,
    );
});

test("Telegram fingerprints preserve source bytes with canonical guest identity", () => {
  const source = { lifecycle: "pending", extra: { second: 2, first: 1 } };
  for (const guestId of [null, "guest"]) {
    const invite = inviteDocumentFixture({ hostId: "host", guestId });
    assert.equal(
      inviteTelegramFingerprint(source, invite),
      JSON.stringify({ source, guestId }),
    );
  }
});

test("rating wager data cannot be retained inside invite documents", () => {
  for (const wagers of [
    {},
    { match: { agreed: { material: " dust ", count: "2.4" } } },
  ]) {
    assert.equal(readInviteDocument({ ...paired, wagers }), null);
    assert.throws(
      () => normalizeInviteSource({ ...paired, wagers }),
      /invalid-invite-source-json/,
    );
  }
});

test("constructors produce canonical records and operation merges preserve existing owners", () => {
  const manual = createManualInviteDocument({
    version: 2,
    hostId: "host",
    hostColor: "white",
    guestId: null,
  });
  assert.equal(readInviteDocument(manual), manual);
  const current = inviteDocumentFixture({
    hostId: "host",
    password: "private",
    automatchOperationIds: { host: "old", guest: "retained" },
  });
  const before = structuredClone(current);
  const merged = mergeInviteAutomatchOperation(current, current, "host", "new");
  assert.deepEqual(merged.automatchOperationIds, {
    host: "new",
    guest: "retained",
  });
  assert.deepEqual(current, before);
  assert.throws(
    () => mergeInviteAutomatchOperation(manual, current, "host", "new"),
    /invalid-invite-operation/,
  );
});

test("storage rejects retired roots and malformed children before persistence", () => {
  const cyclic: { child?: unknown } = {};
  cyclic.child = cyclic;
  for (const patch of [
    { wagers: cyclic },
    { reactions: undefined },
    { matchesWagerResolutions: Symbol("retired") },
    { extra: cyclic },
  ])
    assert.throws(
      () => normalizeInviteSource({ ...paired, ...patch }),
      /invalid-invite-source-json/,
    );
  assert.throws(
    () =>
      decodeInviteSourceSnapshot(inviteId, {
        source_json: '{"wagers":null}',
        revision: 1,
      }),
    /invite-source-corrupt/,
  );
  assert.deepEqual(normalizeInviteSource(paired), paired);
});

test("storage rejects sparse rematch arrays and unknown root fields", () => {
  const sparse = new Array(2);
  sparse[1] = 2;
  for (const source of [
    { ...paired, hostRematches: { state: "open", indices: sparse } },
    { ...paired, sparse },
    { ...paired, nested: new Date() },
  ])
    assert.throws(
      () => normalizeInviteSource(source),
      /invalid-invite-source-json/,
    );
});

test("wager composition keeps metadata separate and public output excludes private fields", async () => {
  const source = inviteDocumentFixture({
    hostId: "host",
    guestId: "guest",
    password: "private",
  });
  const before = structuredClone(source);
  const wager = agreedWagerFixture();
  const states = [
    { inviteId, matchId: inviteId, revision: 1, wager, resolutionMarker: true },
  ];
  const composed = composeInviteWagerSource(source, states);
  assert.deepEqual(composed, {
    invite: source,
    wagers: { [inviteId]: wager },
    resolutionMarkers: { [inviteId]: true },
  });
  const publicWagers = await normalizeInviteWagers(inviteId, composed);
  assert.equal(publicWagers.status, "ok");
  assert.equal(JSON.stringify(publicWagers).includes("private"), false);
  assert.deepEqual(source, before);
});

test("missing invite metadata remains distinct from malformed raw records", () => {
  assert.equal(composeInviteWagerSource(null, []), null);
  assert.equal(normalizeInviteMetadata(inviteId, null).status, "missing");
  for (const source of [false, 0, "legacy", [], {}])
    assert.equal(normalizeInviteMetadata(inviteId, source).status, "invalid");
});
