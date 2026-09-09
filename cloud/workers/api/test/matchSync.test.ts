import assert from "node:assert/strict";
import test from "node:test";
import {
  isMatchSyncMessage,
  isMatchSyncSnapshot,
  isReadMatchSyncResponse,
  MATCH_SYNC_MAX_MESSAGE_BYTES,
} from "../../../functions/shared/match-sync.js";
import {
  createMatchSyncSnapshot,
  isRegisteredSyncMatch,
  type MatchSyncMetadata,
} from "../src/matchSync.ts";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";

function metadata(value: Record<string, unknown> = {}): MatchSyncMetadata {
  const result = normalizeInviteMetadata("invite-10", {
    hostId: "host-login",
    guestId: "guest-login",
    hostColor: "white",
    ...value,
  });
  if (result.status !== "ok") throw new Error("invalid-fixture");
  return result;
}

const match = {
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "standard",
  fen: "initial",
  status: "",
  flatMovesString: "",
  timer: "",
};

test("match sync includes only normalized public fields and permits pending creation", () => {
  const snapshot = createMatchSyncSnapshot(
    metadata(),
    "invite-10",
    {
      ...match,
      sessionCreation: { secret: "private-receipt" },
      privateField: true,
    },
    null,
  );
  assert.deepEqual(snapshot.hostMatch, match);
  assert.equal(snapshot.guestMatch, null);
  assert.equal(isMatchSyncSnapshot(snapshot), true);
  assert.equal(isReadMatchSyncResponse({ ok: true, snapshot }), true);
  assert.equal(
    isMatchSyncMessage({ schemaVersion: 1, type: "snapshot", snapshot }),
    true,
  );
  assert.equal(
    isMatchSyncSnapshot(
      createMatchSyncSnapshot(
        metadata({ guestId: null }),
        "invite-10",
        null,
        null,
      ),
    ),
    true,
  );
  assert.equal(
    isMatchSyncSnapshot({
      ...snapshot,
      guestPlayerId: null,
      guestMatch: match,
    }),
    false,
  );
});

test("match sync rejects foreign targets, records, extra fields and invalid revisions", () => {
  const snapshot = createMatchSyncSnapshot(
    metadata(),
    "invite-10",
    match,
    null,
  );
  for (const invalid of [
    { ...snapshot, matchId: "elsewhere" },
    { ...snapshot, matchId: "invite-1001" },
    { ...snapshot, hostPlayerId: "bad/path" },
    { ...snapshot, guestPlayerId: snapshot.hostPlayerId },
    { ...snapshot, revision: -1 },
    { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, privateField: true },
    { ...snapshot, hostMatch: { ...match, privateField: true } },
  ])
    assert.equal(isMatchSyncSnapshot(invalid), false);
  assert.equal(
    isMatchSyncMessage({ schemaVersion: 2, type: "snapshot", snapshot }),
    false,
  );
  assert.equal(
    isReadMatchSyncResponse({ ok: true, snapshot, viewer: {} }),
    false,
  );
});

test("registered pending rematches are readable without accepting arbitrary suffixes", () => {
  const source = metadata({ hostRematches: "1;2", guestRematches: "1" });
  assert.equal(isRegisteredSyncMatch(source, "invite-10"), true);
  assert.equal(isRegisteredSyncMatch(source, "invite-101"), true);
  assert.equal(isRegisteredSyncMatch(source, "invite-102"), true);
  assert.equal(isRegisteredSyncMatch(source, "invite-103"), false);
  assert.equal(isRegisteredSyncMatch(source, "invite-1001"), false);
});

test("invalid upstream records are errors rather than missing records", () => {
  for (const value of [
    undefined,
    {},
    { ...match, fen: "" },
    { ...match, timer: 12 },
    { ...match, fen: "x".repeat(16 * 1024 + 1) },
  ]) {
    assert.throws(
      () => createMatchSyncSnapshot(metadata(), "invite-10", value, null),
      /source-invalid/,
    );
  }
});

test("pair envelope supports the largest escaped records allowed by the existing field limits", () => {
  const escaped = {
    ...match,
    fen: "\u0001".repeat(16 * 1024),
    flatMovesString: "\u0001".repeat(64 * 1024),
    status: "\u0001".repeat(1024),
    timer: "\u0001".repeat(1024),
    gameVariant: "\u0001".repeat(256),
    aura: "\u0001".repeat(32),
  };
  const snapshot = createMatchSyncSnapshot(metadata(), "invite-10", escaped, {
    ...escaped,
    color: "black",
  });
  const message = JSON.stringify({
    schemaVersion: 1,
    type: "snapshot",
    snapshot,
  });
  assert.equal(isMatchSyncMessage(JSON.parse(message)), true);
  assert.ok(
    new TextEncoder().encode(message).byteLength <=
      MATCH_SYNC_MAX_MESSAGE_BYTES,
  );
});
