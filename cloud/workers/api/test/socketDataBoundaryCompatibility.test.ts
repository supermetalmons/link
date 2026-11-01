import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSocketAttachment,
  nextSocketAttachmentExpiry,
  readOptionalSocketAttachment,
  readSocketAttachment,
  readSocketMatchGroupKey,
  socketCanReceiveInvite,
  socketAttachmentChannel,
  socketAttachmentInviteKey,
  socketAttachmentMatchKey,
  socketAttachmentRequiresSession,
  socketMatchKeyBinding,
  untrimmedSocketMatchKey,
} from "../src/socketAttachmentRecords.ts";
import {
  decodeStoredReaction,
  storedReactionUuid,
  type StoredReactionSnapshot,
} from "../src/reactionRecords.ts";
import { SOCKET_TEST_SESSION_ID } from "./socketTestSession.ts";

const session = {
  authenticated: true as const,
  sid: SOCKET_TEST_SESSION_ID,
  authExpiresAtMs: Date.now() + 60_000,
};
const reaction = {
  channel: "reaction" as const,
  schemaVersion: 2 as const,
  matchId: "match",
  ...session,
};

test("socket attachment reads return complete validated data and reject malformed retained values", () => {
  const socket = {
    deserializeAttachment() {
      assert.equal(this, socket);
      return reaction;
    },
  };
  const attachment = readSocketAttachment(socket);
  assert.deepEqual(attachment, reaction);
  assert.notEqual(attachment, reaction);
  assert.equal(socketAttachmentChannel(attachment), "reaction");
  assert.equal(socketAttachmentMatchKey(attachment), "match");
  assert.equal(
    socketMatchKeyBinding(socketAttachmentMatchKey(attachment)),
    "match",
  );
  assert.equal(
    untrimmedSocketMatchKey(socketAttachmentMatchKey(attachment)),
    false,
  );
  for (const value of [
    null,
    undefined,
    [],
    false,
    1,
    { ...reaction, extra: true },
    { ...reaction, schemaVersion: 1 },
    { ...reaction, matchId: "bad/key" },
    { ...reaction, sid: "invalid" },
    { ...reaction, authExpiresAtMs: "3" },
    { ...reaction, authExpiresAtMs: NaN },
    { ...reaction, authenticated: false },
  ]) {
    assert.equal(decodeSocketAttachment(value), null);
    assert.equal(
      readSocketMatchGroupKey({ deserializeAttachment: () => value }),
      null,
    );
  }
  assert.equal(
    readSocketAttachment({
      deserializeAttachment() {
        throw new Error("invalid attachment");
      },
    }),
    null,
  );
  assert.equal(readOptionalSocketAttachment(undefined), null);
  assert.equal(socketAttachmentInviteKey(null), null);
  assert.equal(untrimmedSocketMatchKey(null), true);
});

test("expiry and session policy use validated values while participant tags still require authentication", () => {
  const attachment = decodeSocketAttachment(reaction);
  assert.equal(
    socketAttachmentRequiresSession(attachment, () => {
      assert.fail("authenticated state need not read tags");
    }),
    true,
  );
  assert.equal(
    nextSocketAttachmentExpiry(null, attachment),
    session.authExpiresAtMs,
  );
  assert.equal(
    nextSocketAttachmentExpiry(session.authExpiresAtMs - 1, attachment),
    session.authExpiresAtMs - 1,
  );
  assert.equal(nextSocketAttachmentExpiry(5, null), 5);
  const spectator = decodeSocketAttachment({
    channel: "reaction",
    schemaVersion: 2,
    matchId: "match",
    authenticated: false,
  });
  assert.equal(
    socketAttachmentRequiresSession(spectator, () => []),
    false,
  );
  assert.equal(
    socketAttachmentRequiresSession(spectator, () => ["role:host"]),
    true,
  );
});

test("invite access rejects malformed identities and keeps host, guest and spectator privacy policy", () => {
  const source = {
    snapshot: { hostId: "host", guestId: "guest" },
    passwordProtected: true,
  };
  const host = decodeSocketAttachment({
    channel: "metadata",
    schemaVersion: 1,
    inviteId: "invite",
    role: "host",
    actorUid: "host",
    ...session,
  });
  assert.equal(socketCanReceiveInvite(host, source), true);
  assert.equal(
    socketCanReceiveInvite(host, {
      ...source,
      snapshot: { hostId: "other", guestId: "guest" },
    }),
    false,
  );
  assert.equal(socketCanReceiveInvite(null, source), false);
  assert.equal(
    decodeSocketAttachment({
      channel: "metadata",
      schemaVersion: 1,
      inviteId: "invite",
      role: "host",
      actorUid: "host",
      authenticated: false,
    }),
    null,
  );
  const spectator = decodeSocketAttachment({
    channel: "matches",
    schemaVersion: 1,
    inviteId: "invite",
    matchId: "match",
    role: "spectator",
    actorUid: null,
    ...session,
  });
  assert.equal(socketCanReceiveInvite(spectator, source), true);
  assert.equal(
    socketCanReceiveInvite(spectator, {
      ...source,
      snapshot: { hostId: "host", guestId: null },
    }),
    false,
  );
  assert.equal(
    socketCanReceiveInvite(spectator, {
      snapshot: { hostId: "host", guestId: null },
      passwordProtected: false,
    }),
    true,
  );
});

test("stored reaction snapshots accept only canonical reaction records", () => {
  const value = {
    uuid: "a69f77f5-44d8-4d43-ae09-0da8ed3575d2",
    kind: "yo",
    variation: 1,
    matchId: "match",
  };
  const decoded = decodeStoredReaction(JSON.stringify(value));
  assert.deepEqual(decoded, value);
  assert.equal(storedReactionUuid(decoded), value.uuid);
  const snapshot: StoredReactionSnapshot = {
    schemaVersion: 2,
    type: "snapshot",
    reactions: { host: decoded },
    presentation: { matchId: "match", players: {} },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).reactions.host, value);
  for (const malformed of [
    "null",
    "false",
    "7",
    '"legacy"',
    "[]",
    JSON.stringify({ ...value, extra: 1 }),
  ])
    assert.throws(
      () => decodeStoredReaction(malformed),
      /invalid-stored-reaction/,
    );
  assert.throws(() => decodeStoredReaction("{"), SyntaxError);
});
