import assert from "node:assert/strict";
import test from "node:test";
import type { FirebaseRtdbQuery } from "../src/firebaseRtdb.ts";
import { createProfileLinkProjectionRuntime } from "../src/profileLinkProfileGameProjection.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("profile-link projection reads match and invite keys without full values", async () => {
  const reads: Array<{ path: string; query?: FirebaseRtdbQuery }> = [];
  const runtime = createProfileLinkProjectionRuntime(TELEGRAM_TEST_ENV as Env, {
    firestore: {
      get: async () => null,
    },
    logger: { error() {}, info() {} },
    projection: {
      async recomputeInviteProjection(inviteId, reason) {
        return {
          inviteId,
          ok: true,
          reason,
          skipped: 0,
          sourceCleanupSafe: true,
        };
      },
    },
    rtdb: {
      async getRtdbPath(path, query) {
        reads.push({ path, query });
        if (path === "players/login-uid/profile") {
          return "profile-id";
        }
        if (path === "players/login-uid/matches") {
          assert.deepEqual(query, { shallow: true });
          return { "invite-id": true };
        }
        if (path === "invites/invite-id") {
          assert.deepEqual(query, { shallow: true });
          return true;
        }
        return null;
      },
    },
    async withInviteProjectionLock(_inviteId, work) {
      return work();
    },
  });

  const result = await runtime.process({
    cleanupProfileIds: [],
    loginUid: "login-uid",
    matchCursor: null,
    profileId: "profile-id",
    sourceUpdatedAtMs: 1,
  });

  assert.equal(result?.processed, 1);
  assert.deepEqual(
    reads.filter(
      ({ path }) =>
        path === "players/login-uid/matches" || path === "invites/invite-id",
    ),
    [
      {
        path: "players/login-uid/matches",
        query: { shallow: true },
      },
      {
        path: "invites/invite-id",
        query: { shallow: true },
      },
    ],
  );
});
