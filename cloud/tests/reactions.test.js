const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FIXED_STICKER_IDS,
  STICKER_ID_WHITELIST,
  isReaction,
  isInviteReaction,
  isInviteReactionForInvite,
  isInviteReactionMessage,
  isSendInviteReactionResponse,
} = require("../functions/shared/reactions");
const { VALID_REACTION_IDS } = require("../functions/shared/nfts");

const reaction = {
  uuid: "12345678-1234-4123-8123-123456789012",
  kind: "yo",
  variation: 1,
};
const inviteReaction = { ...reaction, matchId: "invite123" };

test("accepts existing voice variations and every available sticker", () => {
  for (const [kind, max] of Object.entries({
    yo: 4,
    gg: 2,
    wahoo: 1,
    drop: 1,
    slurp: 1,
  })) {
    for (let variation = 1; variation <= max; variation++) {
      assert.equal(isReaction({ ...reaction, kind, variation }), true);
    }
    assert.equal(isReaction({ ...reaction, kind, variation: max + 1 }), false);
  }
  assert.deepEqual(
    new Set(STICKER_ID_WHITELIST),
    new Set([...FIXED_STICKER_IDS, ...VALID_REACTION_IDS]),
  );
  for (const variation of STICKER_ID_WHITELIST) {
    assert.equal(isReaction({ ...reaction, kind: "sticker", variation }), true);
  }
  assert.equal(
    isReaction({ ...reaction, kind: "sticker", variation: 42 }),
    false,
  );
});

test("rejects malformed payloads and client-supplied identity fields", () => {
  for (const value of [
    null,
    [],
    {},
    { ...reaction, uuid: "invalid" },
    { ...reaction, kind: "../voice" },
    { ...reaction, kind: "constructor" },
    { ...reaction, variation: 0 },
    { ...reaction, variation: 1.5 },
    { ...reaction, variation: Infinity },
    { ...reaction, senderUid: "host" },
  ]) {
    assert.equal(isReaction(value), false);
  }
  assert.equal(isReaction(inviteReaction), false);
  assert.equal(isInviteReaction(reaction), false);
  assert.equal(
    isInviteReaction({ ...inviteReaction, senderUid: "host" }),
    false,
  );
  for (const matchId of [
    "",
    " invite123",
    "invite123/1",
    "invite123\n",
    "x".repeat(769),
  ]) {
    assert.equal(isInviteReaction({ ...inviteReaction, matchId }), false);
  }
});

test("restricts reactions to the invite and canonical rematch IDs", () => {
  for (const matchId of ["invite123", "invite1231", "invite12323"]) {
    assert.equal(
      isInviteReactionForInvite("invite123", { ...inviteReaction, matchId }),
      true,
    );
  }
  for (const matchId of [
    "other",
    "invite12301",
    "invite1230",
    "invite123-1",
    "invite1239007199254740992",
  ]) {
    assert.equal(
      isInviteReactionForInvite("invite123", { ...inviteReaction, matchId }),
      false,
    );
  }
  assert.equal(isInviteReactionForInvite(" invite123", inviteReaction), false);
});

test("validates protocol version, sender keys, and bounded latest-player snapshots", () => {
  const snapshot = {
    schemaVersion: 1,
    type: "snapshot",
    reactions: { host: inviteReaction },
  };
  const event = {
    schemaVersion: 1,
    type: "reaction",
    senderUid: "host",
    reaction: inviteReaction,
  };
  assert.equal(isInviteReactionMessage(snapshot), true);
  assert.equal(isInviteReactionMessage({ ...snapshot, reactions: {} }), true);
  assert.equal(isInviteReactionMessage(event), true);
  for (const value of [
    { ...event, schemaVersion: 2 },
    { ...event, senderUid: "host/other" },
    { ...event, type: "publish" },
    { ...event, extra: true },
    { ...snapshot, reactions: [] },
    { ...snapshot, reactions: { host: reaction } },
    {
      ...snapshot,
      reactions: {
        host: inviteReaction,
        guest: inviteReaction,
        spectator: inviteReaction,
      },
    },
  ]) {
    assert.equal(isInviteReactionMessage(value), false);
  }
  assert.equal(isSendInviteReactionResponse({ ok: true }), true);
  assert.equal(isSendInviteReactionResponse({ ok: false }), false);
  assert.equal(
    isSendInviteReactionResponse({ ok: true, senderUid: "host" }),
    false,
  );
});
