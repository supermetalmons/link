import assert from "node:assert/strict";
import test from "node:test";
import { ALPHANUMERIC_CHARACTERS } from "@mons/shared/ids";
import { AuthApiFailure } from "../src/authErrors.ts";
import { acquireGameSessionMutationLease } from "../src/gameSessionMutationRunner.ts";
import type { GameSessionMutationLockStore } from "../src/gameplayCoordinationD1.ts";
import {
  buildAvailableAutoInviteId,
  isRetiredInviteId,
  RETIRED_INVITE_IDS,
} from "../src/retiredInvites.ts";

function randomFor(...inviteIds: string[]): () => number {
  const values = inviteIds.flatMap((inviteId) =>
    [...inviteId.slice(5)].map(
      (character) =>
        (ALPHANUMERIC_CHARACTERS.indexOf(character) + 0.5) /
        ALPHANUMERIC_CHARACTERS.length,
    ),
  );
  return () => {
    const value = values.shift();
    assert.notEqual(value, undefined);
    return value!;
  };
}

test("retired invite mutations return the normal missing-invite error before acquiring a lock", async () => {
  let acquisitions = 0;
  const store: GameSessionMutationLockStore = {
    acquire: async () => {
      acquisitions++;
    },
    refresh: async () => {},
    release: async () => {},
    deleteExpired: async () => 0,
  };
  for (const inviteId of RETIRED_INVITE_IDS) {
    await assert.rejects(
      acquireGameSessionMutationLease(inviteId, "operation", "owner", store, 1),
      (error: unknown) =>
        error instanceof AuthApiFailure &&
        error.status === 404 &&
        error.code === "not-found" &&
        error.message === "invite-not-found",
    );
  }
  assert.equal(acquisitions, 0);
  await acquireGameSessionMutationLease(
    "ordinary-invite",
    "operation",
    "owner",
    store,
    1,
  );
  assert.equal(acquisitions, 1);
});

test("automatch rerolls both retired IDs before returning an available ID", () => {
  assert.equal(
    buildAvailableAutoInviteId(
      randomFor(...RETIRED_INVITE_IDS, "auto_abcdefghijk"),
    ),
    "auto_abcdefghijk",
  );
});

test("automatch repeated collisions have a bounded failure", () => {
  const random = randomFor(...Array<string>(8).fill(RETIRED_INVITE_IDS[0]));
  assert.throws(
    () => buildAvailableAutoInviteId(random),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 503,
  );
});

test("retirement lookup does not reject adjacent names or unrelated invitations", () => {
  for (const inviteId of RETIRED_INVITE_IDS) {
    assert.equal(isRetiredInviteId(inviteId), true);
    assert.equal(isRetiredInviteId(`${inviteId}x`), false);
    assert.equal(isRetiredInviteId(inviteId.toUpperCase()), false);
  }
  assert.equal(isRetiredInviteId("ordinary-invite"), false);
});
