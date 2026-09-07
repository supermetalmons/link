const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isInviteMetadataSnapshot,
  isReadInviteMetadataResponse,
  isInviteMetadataMessage,
} = require("../functions/shared/invite-metadata");
const { isInviteRoomMessage } = require("../functions/shared/reactions");

const snapshot = {
  inviteId: "invite-one",
  revision: 1,
  hostId: "host-login",
  guestId: "guest-login",
  hostColor: "white",
  hostRematches: "1;2",
  guestRematches: "1x",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
};

test("metadata contract accepts pending and paired rooms with full rematch sequences", () => {
  assert.equal(isInviteMetadataSnapshot(snapshot), true);
  assert.equal(isInviteMetadataSnapshot({ ...snapshot, guestId: null }), true);
  assert.equal(
    isInviteMetadataSnapshot({ ...snapshot, hostRematches: "1;".repeat(4096) }),
    true,
  );
  for (const update of [
    { revision: -1 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { inviteId: "invite/one" },
    { hostId: " host-login" },
    { guestId: "host-login" },
    { hostColor: "blue" },
    { hostRematches: null },
    { eventId: "" },
    { automatchStateHint: "other" },
    { eventOwned: 1 },
    { password: "private" },
    { wagers: {} },
    { automatchOperationIds: {} },
  ])
    assert.equal(isInviteMetadataSnapshot({ ...snapshot, ...update }), false);
});

test("metadata viewer ownership matches its snapshot and remains HTTP-only", () => {
  const response = {
    ok: true,
    snapshot,
    viewer: {
      role: "host",
      actorUid: "host-login",
      automatchOperationId: null,
    },
  };
  assert.equal(isReadInviteMetadataResponse(response), true);
  for (const viewer of [
    { role: "watch", actorUid: null, automatchOperationId: null },
    {
      role: "guest",
      actorUid: "guest-login",
      automatchOperationId: "00000000-0000-4000-8000-000000000001",
    },
  ])
    assert.equal(isReadInviteMetadataResponse({ ...response, viewer }), true);
  for (const viewer of [
    { ...response.viewer, actorUid: "guest-login" },
    { ...response.viewer, role: "watch" },
    { ...response.viewer, automatchOperationId: "not-an-operation-id" },
    { ...response.viewer, otherLogin: "private" },
  ])
    assert.equal(isReadInviteMetadataResponse({ ...response, viewer }), false);
  const message = { schemaVersion: 1, type: "snapshot", snapshot };
  assert.equal(isInviteMetadataMessage(message), true);
  assert.equal(
    isInviteMetadataMessage({ ...message, viewer: response.viewer }),
    false,
  );
  assert.equal(isInviteRoomMessage(message), false);
});
