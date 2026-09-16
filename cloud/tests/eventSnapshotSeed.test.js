"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  eventBookmarkEpoch,
  eventSnapshotEtag,
  isEventSnapshotSeed,
  MAX_EVENT_READ_RESPONSE_BYTES,
} = require("../runtime/shared/events");
const {
  isSessionEventBootstrapTarget,
  isSessionEventBootstrapResponse,
  SESSION_EVENT_BOOTSTRAP_MAX_RESPONSE_BYTES,
} = require("../runtime/shared/session-bootstrap");

const epoch = "00000000-0000-4000-8000-000000000001";
const seed = {
  snapshot: {
    ok: true,
    eventId: "event-one",
    revision: 2,
    event: { eventId: "event-one", status: "scheduled" },
    prizeSelections: {},
  },
  etag: eventSnapshotEtag("event-one", 2),
  bookmark: `mons-d1-v1:${epoch}:native-token`,
};

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

test("event bootstraps preserve exact target and token contracts", () => {
  const token = {
    ok: true,
    uid: "a".repeat(28),
    sessionId: epoch,
    accessToken: "header.payload.signature",
    accessExpiresAtMs: 1700000300000,
  };
  const response = {
    ...token,
    eventBootstrap: { eventId: "event-one", result: seed },
  };
  assert.equal(isSessionEventBootstrapResponse(response), true);
  assert.equal(
    isSessionEventBootstrapResponse({ ...response, gameBootstrap: {} }),
    false,
  );
  assert.equal(
    isSessionEventBootstrapResponse({
      ...response,
      eventBootstrap: { eventId: "event-two", result: seed },
    }),
    false,
  );
  assert.equal(
    isSessionEventBootstrapResponse({
      ...response,
      eventBootstrap: {
        eventId: "event-one",
        result: { ok: false, status: 503 },
      },
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
