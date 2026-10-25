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
  inviteRatingWager,
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
import {
  inviteDocumentFixture,
  retainedInviteSourceFixture,
} from "./inviteDocumentFixture.ts";

const inviteId = "invite-document";

test("invite document observation preserves source identity and extensions", () => {
  const source = {
    hostId: "host",
    guestId: "guest",
    extension: { retained: true },
  };
  const keys = Reflect.ownKeys(source);
  const encoded = JSON.stringify(source);
  assert.equal(readInviteDocument(source), source);
  assert.deepEqual(Reflect.ownKeys(source), keys);
  assert.equal(JSON.stringify(source), encoded);
  assert.ok(readInviteDocument({}));
  for (const value of [undefined, null, false, 0, "", [], [source]]) {
    assert.equal(readInviteDocument(value), null);
  }
  const prototype = { inherited: true };
  const unusualRoot = Object.assign(Object.create(prototype), source);
  assert.equal(readInviteDocument(unusualRoot), unusualRoot);
});

test("canonical participants do not depend on full public metadata validity", () => {
  const source = inviteDocumentFixture({
    hostId: "host",
    guestId: "guest",
    hostColor: 19,
    hostRematches: false,
    guestRematches: [],
    eventId: { retained: true },
  });
  assert.equal(normalizeInviteMetadata(inviteId, source).status, "invalid");
  const participants = readCanonicalInviteParticipants(source);
  assert.equal(participants.status, "ok");
  assert.ok(participants.status === "ok");
  assert.equal(participants.source, source);
  assert.equal(inviteMatchesParticipants(source, "guest", "host"), true);
  assert.equal(inviteOpponent(source, "host"), "guest");
});

test("participant observations preserve each operation's whitespace and malformed-seat rules", () => {
  for (const guestId of [false, 0, {}, []]) {
    const source = inviteDocumentFixture({ hostId: " host ", guestId });
    assert.deepEqual(inviteMutationParticipants(source), {
      hostId: " host ",
      guestId: "",
    });
    assert.deepEqual(inviteTrimmedParticipants(source), {
      hostId: "host",
      guestId: "",
    });
    assert.equal(readCanonicalInviteParticipants(source).status, "invalid");
    assert.equal(inviteMatchesParticipants(source, "host", "guest"), false);
  }
  for (const guestId of [undefined, null]) {
    const source = inviteDocumentFixture({ hostId: "host", guestId });
    const result = readCanonicalInviteParticipants(source);
    assert.ok(result.status === "ok");
    assert.equal(result.guestId, null);
  }
  for (const hostId of [" host ", "a/b", "a".repeat(129), "\ud800"]) {
    assert.equal(readCanonicalInviteParticipants({ hostId }).status, "invalid");
  }
  assert.deepEqual(inviteHistoricalParticipants(inviteDocumentFixture({})), {
    hostId: "undefined",
    guestId: "undefined",
  });
});

test("password protection retains own-property presence rather than truthiness", () => {
  for (const password of [undefined, null, false, 0, ""]) {
    const result = readCanonicalInviteParticipants({
      hostId: "host",
      password,
    });
    assert.ok(result.status === "ok");
    assert.equal(result.passwordProtected, true);
  }
  const inherited = Object.assign(Object.create({ password: "inherited" }), {
    hostId: "host",
  });
  const result = readCanonicalInviteParticipants(inherited);
  assert.ok(result.status === "ok");
  assert.equal(result.passwordProtected, false);
});

test("presentation rematches retain bytes and spread extensions without gating on metadata", () => {
  const source = inviteDocumentFixture({
    hostId: "host",
    guestId: "guest",
    hostRematches: "2;1;2;x",
    guestRematches: false,
    extra: 7,
  });
  const read = readCanonicalInviteParticipants(source);
  assert.ok(read.status === "ok");
  assert.deepEqual(presentationInviteView(read), {
    hostId: "host",
    guestId: "guest",
    hostRematches: "2;1;2;x",
    guestRematches: undefined,
    extra: 7,
  });
  assert.deepEqual(inviteRematchState(source), {
    hostRematches: "2;1;2;x",
    guestRematches: undefined,
    hostColor: "white",
  });
});

test("event observations retain distinct timer and rating policies", () => {
  for (const eventId of ["", "   ", " event-one "]) {
    const source = inviteDocumentFixture({ eventOwned: true, eventId });
    assert.equal(inviteTimerEventId(source), eventId);
    assert.equal(inviteIsEventOwned(source), true);
    assert.deepEqual(inviteRatingEvent(source), {
      eventOwned: true,
      isEventMatch: true,
      eventId: eventId.trim() || null,
    });
  }
  const source = inviteDocumentFixture({
    eventOwned: false,
    eventId: " event-one ",
  });
  assert.equal(inviteIsEventOwned(source), true);
  assert.equal(inviteTimerEventId(source), null);
  assert.deepEqual(inviteRatingEvent(source), {
    eventOwned: false,
    isEventMatch: true,
    eventId: "event-one",
  });
});

test("projection observations keep non-finite stored numbers and strict delivery versions", () => {
  for (const automatchCanceledAt of [NaN, Infinity, -1]) {
    assert.ok(
      Object.is(
        inviteProjectionState(inviteDocumentFixture({ automatchCanceledAt }))
          .automatchCanceledAt,
        automatchCanceledAt,
      ),
    );
  }
  assert.equal(
    inviteProjectionState(
      inviteDocumentFixture({
        automatchCanceledAt: "1",
        telegramDeliveryVersion: "2",
      }),
    ).automatchCanceledAt,
    null,
  );
  assert.equal(
    inviteProjectionState(
      inviteDocumentFixture({ telegramDeliveryVersion: "2" }),
    ).telegramDeliveryVersion,
    null,
  );
});

test("Telegram fingerprint uses raw guest truthiness and preserves source extension ordering", () => {
  const source = { lifecycle: "pending", extra: { second: 2, first: 1 } };
  for (const guestId of [
    undefined,
    null,
    false,
    0,
    "",
    " guest ",
    { legacy: true },
    [],
  ]) {
    const invite = inviteDocumentFixture({ guestId });
    assert.equal(
      inviteTelegramFingerprint(source, invite),
      JSON.stringify({ source, guestId: guestId || null }),
    );
  }
});

test("rating wagers retain numeric coercion and exception behavior", () => {
  const source = inviteDocumentFixture({
    wagers: { match: { agreed: { material: " dust ", count: "2.4" } } },
  });
  assert.deepEqual(inviteRatingWager(source, "match"), {
    material: "dust",
    count: 2.4,
  });
  assert.ok(Number.isNaN(inviteRatingWager(source, "missing").count));
  assert.throws(
    () =>
      inviteRatingWager(
        inviteDocumentFixture({
          wagers: { match: { agreed: { count: Symbol("invalid") } } },
        }),
        "match",
      ),
    TypeError,
  );
});

test("manual construction and automatch operation merge preserve wire field ordering", () => {
  const manual = createManualInviteDocument({
    version: 2,
    hostId: "host",
    hostColor: "white",
    guestId: null,
  });
  assert.equal(
    JSON.stringify(manual),
    '{"version":2,"hostId":"host","hostColor":"white","guestId":null}',
  );
  const current = inviteDocumentFixture({
    automatchOperationIds: {
      host: "old",
      "invalid/key": "skip",
      guest: "bad/key",
      retained: "keep",
    },
  });
  const merged = mergeInviteAutomatchOperation(manual, current, "host", "new");
  assert.equal(
    JSON.stringify(merged),
    '{"version":2,"hostId":"host","hostColor":"white","guestId":null,"automatchOperationIds":{"host":"new","retained":"keep"}}',
  );
  assert.deepEqual(current, {
    automatchOperationIds: {
      host: "old",
      "invalid/key": "skip",
      guest: "bad/key",
      retained: "keep",
    },
  });
});

test("storage removes retired root fields before validating their children", () => {
  const cyclic: { child?: unknown } = {};
  cyclic.child = cyclic;
  const source = {
    hostId: "host",
    wagers: cyclic,
    reactions: undefined,
    matchesWagerResolutions: Symbol("retired"),
    extra: { retained: true },
  };
  assert.deepEqual(normalizeInviteSource(source), {
    hostId: "host",
    extra: { retained: true },
  });
  assert.throws(
    () => normalizeInviteSource({ extra: cyclic }),
    /invalid-invite-source-json/,
  );
  assert.throws(
    () => normalizeInviteSource({ extra: { value: undefined } }),
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
});

test("storage retains sparse arrays and root prototype behavior", () => {
  const sparse = new Array(2);
  sparse[1] = null;
  const source = Object.assign(Object.create({ inherited: "not-copied" }), {
    sparse,
  });
  const normalized = normalizeInviteSource(source);
  assert.deepEqual(normalized, { sparse });
  assert.equal(JSON.stringify(normalized), '{"sparse":[null,null]}');
  assert.throws(
    () => normalizeInviteSource({ sparse: [undefined, null] }),
    /invalid-invite-source-json/,
  );
  assert.throws(
    () => normalizeInviteSource({ nested: new Date() }),
    /invalid-invite-source-json/,
  );
});

test("wager composition replaces retained wager fields and keeps metadata private", async () => {
  const source = inviteDocumentFixture({
    hostId: "host",
    guestId: "guest",
    hostColor: "white",
    password: "private",
    wagers: { stale: true },
    matchesWagerResolutions: { stale: true },
    extension: { retained: true },
  });
  const states = [
    {
      inviteId,
      matchId: inviteId,
      revision: 1,
      wager: {
        agreed: {
          material: "dust",
          count: 2,
          proposerId: "host",
          accepterId: "guest",
        },
      },
      resolutionMarker: true,
    },
  ];
  const composed = composeInviteWagerSource(source, states);
  assert.notEqual(composed, source);
  assert.equal(
    JSON.stringify(composed),
    JSON.stringify({
      hostId: "host",
      guestId: "guest",
      hostColor: "white",
      password: "private",
      extension: { retained: true },
      wagers: { [inviteId]: states[0].wager },
      matchesWagerResolutions: { [inviteId]: true },
    }),
  );
  const publicWagers = await normalizeInviteWagers(inviteId, composed);
  assert.equal(publicWagers.status, "ok");
  assert.equal(JSON.stringify(publicWagers).includes("private"), false);
  assert.equal(JSON.stringify(publicWagers).includes("extension"), false);
  assert.deepEqual(composeInviteWagerSource(source, states, true), {
    hostId: "host",
    guestId: "guest",
    hostColor: "white",
    password: "private",
    extension: { retained: true },
    wagers: true,
    matchesWagerResolutions: true,
  });
  assert.deepEqual(source.wagers, { stale: true });
});

test("retained malformed source fixtures keep invalid distinct from missing", () => {
  for (const source of [undefined, null, false, 0, "legacy", []]) {
    const retained = retainedInviteSourceFixture(source);
    assert.equal(composeInviteWagerSource(retained, []), source);
    assert.equal(
      normalizeInviteMetadata(inviteId, retained).status,
      source === null || source === undefined ? "missing" : "invalid",
    );
  }
});
