const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PRESENTATION_MAX_MESSAGE_BYTES,
  isMatchPresentation,
  isMatchPresentationSnapshot,
  isUpdateMatchPresentationRequest,
  isReadMatchPresentationResponse,
  isUpdateMatchPresentationResponse,
  isMatchPresentationConflictResponse,
} = require("../functions/shared/match-presentation");
const {
  isInviteReactionMessage,
  isInviteRoomMessage,
} = require("../functions/shared/reactions");

const presentation = {
  matchId: "invite-one",
  actorUid: "host-login",
  emojiId: 1000,
  aura: "rainbow",
  revision: 2,
};
const snapshot = {
  matchId: "invite-one",
  players: { "host-login": presentation },
};
const update = {
  operationId: "00000000-0000-4000-8000-000000000001",
  expectedRevision: 2,
  emojiId: 1000,
  aura: "rainbow",
};

test("presentation responses preserve bounded legacy appearances and reject malformed ownership or revisions", () => {
  assert.equal(isMatchPresentation(presentation), true);
  assert.equal(
    isMatchPresentation({ ...presentation, emojiId: -10, aura: "legacy" }),
    true,
  );
  for (const value of [
    { ...presentation, revision: -1 },
    { ...presentation, revision: 1.5 },
    { ...presentation, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...presentation, emojiId: "1000" },
    { ...presentation, aura: "x".repeat(33) },
    { ...presentation, actorUid: " host-login" },
    { ...presentation, actorUid: "x".repeat(129) },
    { ...presentation, matchId: "invite/one" },
    { ...presentation, ignored: true },
  ])
    assert.equal(isMatchPresentation(value), false);
  assert.equal(isMatchPresentationSnapshot(snapshot), true);
  assert.equal(
    isMatchPresentationSnapshot({
      ...snapshot,
      players: { other: presentation },
    }),
    false,
  );
  assert.equal(
    isMatchPresentationSnapshot({ ...snapshot, matchId: "other" }),
    false,
  );
  assert.equal(
    isMatchPresentationSnapshot({
      ...snapshot,
      players: Object.fromEntries(
        ["a", "b", "c"].map((actorUid) => [
          actorUid,
          { ...presentation, actorUid },
        ]),
      ),
    }),
    false,
  );
  assert.equal(
    isReadMatchPresentationResponse({ ok: true, presentation: snapshot }),
    true,
  );
  assert.equal(
    isUpdateMatchPresentationResponse({ ok: true, presentation }),
    true,
  );
  assert.equal(
    isMatchPresentationConflictResponse({
      ok: false,
      error: "presentation-conflict",
      presentation,
    }),
    true,
  );
  assert.equal(
    isMatchPresentationConflictResponse({
      ok: false,
      error: "other",
      presentation,
    }),
    false,
  );
});

test("presentation writes reuse profile cosmetic constraints and require exact UUID/CAS payloads", () => {
  for (const value of [
    update,
    { ...update, emojiId: 155, aura: "" },
    { ...update, emojiId: 1466 },
  ])
    assert.equal(isUpdateMatchPresentationRequest(value), true);
  for (const value of [
    { ...update, emojiId: 0 },
    { ...update, emojiId: 156, aura: "" },
    { ...update, emojiId: 1467 },
    { ...update, aura: "legacy" },
    { ...update, operationId: "not-a-uuid" },
    { ...update, expectedRevision: -1 },
    { ...update, actorUid: "host-login" },
  ])
    assert.equal(isUpdateMatchPresentationRequest(value), false);
});

test("v2 room messages require appearance snapshots while preserving strict v1 validation", () => {
  const v1 = { schemaVersion: 1, type: "snapshot", reactions: {} };
  const v2 = {
    schemaVersion: 2,
    type: "snapshot",
    reactions: {},
    presentation: snapshot,
  };
  assert.equal(isInviteReactionMessage(v1), true);
  assert.equal(isInviteRoomMessage(v1), true);
  assert.equal(isInviteReactionMessage(v2), false);
  assert.equal(isInviteRoomMessage(v2), true);
  assert.equal(isInviteRoomMessage({ ...v1, schemaVersion: 2 }), false);
  assert.equal(
    isInviteRoomMessage({
      schemaVersion: 2,
      type: "presentation",
      presentation,
    }),
    true,
  );
  assert.equal(
    isInviteRoomMessage({
      schemaVersion: 1,
      type: "presentation",
      presentation,
    }),
    false,
  );
  const reaction = {
    uuid: update.operationId,
    kind: "yo",
    variation: 1,
    matchId: "invite-one",
  };
  assert.equal(
    isInviteRoomMessage({
      schemaVersion: 2,
      type: "reaction",
      senderUid: "host-login",
      reaction,
    }),
    true,
  );
  assert.equal(isInviteRoomMessage({ ...v2, extra: true }), false);
});

test("bounded v2 envelopes fit the largest Firebase keys including JSON escaping and Unicode", () => {
  for (const matchId of ['"\\'.repeat(384), "🫠".repeat(192)]) {
    const actors = ['"\\'.repeat(63) + "a", '"\\'.repeat(63) + "b"];
    const players = Object.fromEntries(
      actors.map((actorUid) => [
        actorUid,
        { ...presentation, matchId, actorUid, aura: '"\\'.repeat(16) },
      ]),
    );
    const reactions = Object.fromEntries(
      actors.map((actorUid) => [
        actorUid,
        {
          uuid: update.operationId,
          matchId,
          kind: "sticker",
          variation: 900316,
        },
      ]),
    );
    const message = {
      schemaVersion: 2,
      type: "snapshot",
      reactions,
      presentation: { matchId, players },
    };
    const serialized = JSON.stringify(message);
    assert.ok(new TextEncoder().encode(serialized).byteLength > 4096);
    assert.ok(
      new TextEncoder().encode(serialized).byteLength <=
        PRESENTATION_MAX_MESSAGE_BYTES,
    );
    assert.equal(isInviteRoomMessage(JSON.parse(serialized)), true);
    const response = JSON.stringify({
      ok: true,
      presentation: message.presentation,
    });
    assert.ok(
      new TextEncoder().encode(response).byteLength <=
        PRESENTATION_MAX_MESSAGE_BYTES,
    );
    assert.equal(isReadMatchPresentationResponse(JSON.parse(response)), true);
  }
});
