import assert from "node:assert/strict";
import { test } from "node:test";
import { INVITE_METADATA_MAX_MESSAGE_BYTES } from "@mons/shared/invite-metadata";
import {
  createInviteMetadataReader,
  normalizeInviteMetadata,
} from "../src/inviteMetadata.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

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

test("metadata reads normalize each fresh source and recover after read failures", async () => {
  let value: unknown = invite;
  let fail = false;
  const inviteIds: string[] = [];
  const read = createInviteMetadataReader(TELEGRAM_TEST_ENV, {
    readSource: async (id) => {
      inviteIds.push(id);
      if (fail) throw new Error("source-unavailable");
      return value;
    },
  });
  assert.deepEqual(
    await read(inviteId),
    normalizeInviteMetadata(inviteId, invite),
  );
  value = { ...invite, hostRematches: "1", password: "private" };
  assert.deepEqual(
    await read(inviteId),
    normalizeInviteMetadata(inviteId, value),
  );
  fail = true;
  await assert.rejects(read(inviteId), /source-unavailable/);
  fail = false;
  value = null;
  assert.deepEqual(await read(inviteId), { status: "missing" });
  value = { ...invite, hostColor: "invalid" };
  assert.deepEqual(await read(inviteId), { status: "invalid" });
  assert.deepEqual(inviteIds, Array(5).fill(inviteId));
});
