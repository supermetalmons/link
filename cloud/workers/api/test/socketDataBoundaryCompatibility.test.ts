import assert from "node:assert/strict";
import test from "node:test";
import {
  nextSocketAttachmentExpiry,
  readOptionalSocketAttachment,
  readSocketAttachment,
  readSocketMatchGroupKey,
  retainedSocketCanReceiveInvite,
  socketAttachmentChannel,
  socketAttachmentInviteKey,
  socketAttachmentMatchKey,
  socketAttachmentRequiresSession,
  socketMatchKeyBinding,
  unsupportedReactionAttachment,
  untrimmedSocketMatchKey,
} from "../src/socketAttachmentRecords.ts";
import {
  decodeStoredReaction,
  storedReactionUuid,
  type StoredReactionDocument,
  type StoredReactionSnapshot,
} from "../src/reactionRecords.ts";

test("resumed attachment observations preserve receiver, getters and raw keys", () => {
  const reads: string[] = [];
  const raw = {
    get channel() {
      reads.push("channel");
      return reads.length === 1 ? "metadata" : "reaction";
    },
    get schemaVersion() {
      reads.push("schema");
      return 2;
    },
    get matchId() {
      reads.push("match");
      return undefined;
    },
  };
  const socket = {
    deserializeAttachment() {
      assert.equal(this, socket);
      return raw;
    },
  };
  const attachment = readSocketAttachment(socket);
  assert.equal(attachment, raw);
  assert.deepEqual(reads, []);
  assert.equal(unsupportedReactionAttachment(attachment), false);
  assert.deepEqual(reads, ["channel", "channel", "schema"]);
  const key = socketAttachmentMatchKey(attachment);
  assert.equal(key, undefined);
  assert.equal(socketMatchKeyBinding(key), undefined);
  assert.throws(() => untrimmedSocketMatchKey(key), TypeError);
  const absent = readOptionalSocketAttachment(undefined);
  assert.equal(socketAttachmentChannel(absent), undefined);
  assert.equal(socketAttachmentInviteKey(absent), undefined);
  for (const value of [null, undefined]) {
    assert.throws(
      () => readSocketMatchGroupKey({ deserializeAttachment: () => value }),
      {
        name: "TypeError",
        message: `Cannot destructure property 'matchId' of 'socket.deserializeAttachment(...)' as it is ${String(value)}.`,
      },
    );
  }
});

test("session observations keep lazy tags and native expiry coercion", () => {
  const attachment = readSocketAttachment({
    deserializeAttachment: () => ({
      authenticated: true,
      authExpiresAtMs: "3",
    }),
  });
  assert.equal(
    socketAttachmentRequiresSession(attachment, () => {
      assert.fail("authenticated attachments do not read tags");
    }),
    true,
  );
  assert.equal(nextSocketAttachmentExpiry(5, attachment), 3);
  const read = (expiry: unknown) =>
    readSocketAttachment({
      deserializeAttachment: () => ({
        authenticated: true,
        authExpiresAtMs: expiry,
      }),
    });
  assert.equal(
    Number.isNaN(nextSocketAttachmentExpiry(null, read(undefined))),
    true,
  );
  assert.throws(() => nextSocketAttachmentExpiry(null, read(1n)), TypeError);
});

test("retained invite access keeps raw falsy results and short-circuit reads", () => {
  for (const authenticated of [undefined, null, false, 0, ""]) {
    const reads: string[] = [];
    const attachment = readSocketAttachment({
      deserializeAttachment: () => ({
        role: "host",
        get authenticated() {
          reads.push("authenticated");
          return authenticated;
        },
        get actorUid() {
          return assert.fail(
            "falsy authentication does not read actor identity",
          );
        },
      }),
    });
    const result = retainedSocketCanReceiveInvite(attachment, {
      get snapshot() {
        return assert.fail(
          "falsy host authentication does not read the invite",
        );
      },
      passwordProtected: false,
    });
    assert.equal(result, authenticated);
    assert.deepEqual(reads, ["authenticated"]);
  }
});

test("stored reaction snapshots retain all parsed JSON values and UUID error behavior", () => {
  const values = [
    "null",
    "false",
    "7",
    '"legacy"',
    "[]",
    '{"extra":1,"uuid":"id"}',
  ];
  const reactions = Object.fromEntries<StoredReactionDocument>(
    values.map((value, index) => [String(index), decodeStoredReaction(value)]),
  );
  const snapshot: StoredReactionSnapshot = {
    schemaVersion: 2,
    type: "snapshot",
    reactions,
    presentation: { matchId: "match", players: {} },
  };
  assert.equal(
    JSON.stringify(snapshot),
    '{"schemaVersion":2,"type":"snapshot","reactions":{"0":null,"1":false,"2":7,"3":"legacy","4":[],"5":{"extra":1,"uuid":"id"}},"presentation":{"matchId":"match","players":{}}}',
  );
  assert.equal(storedReactionUuid(reactions["5"]), "id");
  assert.equal(storedReactionUuid(reactions["2"]), undefined);
  assert.throws(() => storedReactionUuid(reactions["0"]), TypeError);
  assert.throws(() => decodeStoredReaction("{"), SyntaxError);
});
