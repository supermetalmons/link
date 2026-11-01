"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { event: eventFixture } = require("./fixtures/canonicalEvents");
const {
  eventBookmarkEpoch,
  eventSnapshotEtag,
  isEventSnapshotSeed,
  isEventUpdateMessage,
  MAX_EVENT_READ_RESPONSE_BYTES,
} = require("../runtime/shared/events");
const {
  isSessionEventBootstrapTarget,
  isSessionEventBootstrap,
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
} = require("../runtime/shared/session-bootstrap");

const epoch = "00000000-0000-4000-8000-000000000001";
const seed = {
  snapshot: {
    ok: true,
    eventId: "event-one",
    revision: 2,
    event: eventFixture({ eventId: "event-one" }),
    prizeSelections: {},
  },
  etag: eventSnapshotEtag("event-one", 2),
  bookmark: `mons-d1-v1:${epoch}:native-token`,
};

test("event update hints accept only canonical event, epoch and revision identities", () => {
  const message = {
    schemaVersion: 1,
    type: "event-changed",
    eventId: "event-one",
    epoch,
    revision: 2,
  };
  assert.equal(isEventUpdateMessage(message), true);
  assert.equal(isEventUpdateMessage({ ...message, revision: 0 }), true);
  for (const invalid of [
    null,
    { ...message, schemaVersion: 2 },
    { ...message, type: "snapshot" },
    { ...message, eventId: " event-one" },
    { ...message, eventId: "event/one" },
    { ...message, epoch: "wrong" },
    { ...message, epoch: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" },
    { ...message, revision: -1 },
    { ...message, revision: 1.5 },
    { ...message, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...message, revision: "2" },
    { ...message, event: seed.snapshot.event },
  ])
    assert.equal(isEventUpdateMessage(invalid), false);
});

test("snapshot seeds require matching revisions and scoped bookmarks", () => {
  assert.equal(isEventSnapshotSeed(seed), true);
  assert.equal(eventBookmarkEpoch(seed.bookmark), epoch);
  for (const invalid of [
    { ...seed, etag: eventSnapshotEtag("event-two", 2) },
    { ...seed, etag: eventSnapshotEtag("event-one", 1) },
    { ...seed, bookmark: "native-token" },
    { ...seed, bookmark: `mons-d1-v1:${epoch}:first-primary` },
    { ...seed, bookmark: `mons-d1-v1:${epoch}:first-unconstrained` },
    { ...seed, bookmark: `mons-d1-v1:${epoch}:${"x".repeat(2048)}` },
    { ...seed, extra: true },
  ])
    assert.equal(isEventSnapshotSeed(invalid), false);
  assert.equal(
    isEventSnapshotSeed({
      ...seed,
      snapshot: { ...seed.snapshot, event: null, revision: 0 },
      etag: eventSnapshotEtag("event-one", 0),
    }),
    true,
  );
});

test("event bootstraps preserve exact target and snapshot contracts", () => {
  const bootstrap = { eventId: "event-one", result: seed };
  assert.equal(isSessionEventBootstrap(bootstrap), true);
  assert.equal(
    isSessionEventBootstrap({ ...bootstrap, gameBootstrap: {} }),
    false,
  );
  assert.equal(
    isSessionEventBootstrap({ eventId: "event-two", result: seed }),
    false,
  );
  assert.equal(
    isSessionEventBootstrap({
      eventId: "event-one",
      result: { ok: false, status: 503 },
    }),
    true,
  );
  for (const target of [
    { eventId: "" },
    { eventId: " event-one" },
    { eventId: "event/one" },
    { eventId: "event-one", inviteId: "invite" },
  ])
    assert.equal(isSessionEventBootstrapTarget(target), false);
  assert.equal(
    SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
    MAX_EVENT_READ_RESPONSE_BYTES + 16_384,
  );
});
