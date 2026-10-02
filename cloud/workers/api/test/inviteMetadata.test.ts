import { INVITE_METADATA_MAX_MESSAGE_BYTES } from "@mons/shared/invite-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";

const inviteId = "metadata-invite";
const invite = {
  hostId: "host-login",
  hostColor: "white",
  guestId: "guest-login",
};

test("metadata normalization exposes only the public snapshot and separate viewer inputs", () => {
  const operationId = crypto.randomUUID();
  const result = normalizeInviteMetadata(inviteId, {
    ...invite,
    hostRematches: "1;2x",
    guestRematches: "1;2",
    password: "private-password",
    automatchOperationIds: {
      "host-login": operationId,
      "guest-login": "invalid operation",
      "invalid/uid": operationId,
    },
    wagers: { secret: "wager" },
    eventRoundIndex: 3,
    unrelated: "not-public",
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.snapshot, {
    inviteId,
    revision: 0,
    hostId: "host-login",
    guestId: "guest-login",
    hostColor: "white",
    hostRematches: "1;2x",
    guestRematches: "1;2",
    automatchStateHint: null,
    eventId: null,
    eventOwned: false,
  });
  assert.equal(result.passwordProtected, true);
  assert.deepEqual(result.automatchOperationIds, { "host-login": operationId });
});

test("metadata normalization distinguishes missing sources from invalid and oversized sources", () => {
  assert.deepEqual(normalizeInviteMetadata(inviteId, null), {
    status: "missing",
  });
  for (const invalid of [
    [],
    { ...invite, hostId: "invalid/uid" },
    { ...invite, guestId: invite.hostId },
    { ...invite, hostColor: "invalid" },
    { ...invite, guestRematches: 1 },
    {
      ...invite,
      hostRematches: "😀".repeat(INVITE_METADATA_MAX_MESSAGE_BYTES / 2),
    },
  ]) {
    assert.deepEqual(normalizeInviteMetadata(inviteId, invalid), {
      status: "invalid",
    });
  }
});
