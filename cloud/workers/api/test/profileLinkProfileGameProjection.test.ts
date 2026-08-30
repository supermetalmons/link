import assert from "node:assert/strict";
import test from "node:test";
import type { FirebaseRtdbQuery } from "../src/firebaseRtdb.ts";
import { createProfileLinkProjectionRuntime } from "../src/profileLinkProfileGameProjection.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

test("profile-link projection reads a bounded match page", async () => {
  const reads: Array<{ path: string; query?: FirebaseRtdbQuery }> = [];
  const runtime = createProfileLinkProjectionRuntime(TELEGRAM_TEST_ENV as Env, {
    readProfileOwnershipSnapshot: async ({ loginUids, profileIds }) => {
      assert.deepEqual(loginUids, ["login-uid"]);
      assert.deepEqual(profileIds, []);
      return {
        profileIdByLoginUid: new Map([["login-uid", "profile-id"]]),
      };
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
          throw new Error("unexpected-rtdb-profile-owner-read");
        }
        if (path === "players/login-uid/matches") {
          assert.deepEqual(query, { orderBy: "$key", limitToFirst: 21 });
          return { "invite-id": {} };
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
  assert.equal(
    reads.some(({ path }) => path === "players/login-uid/profile"),
    false,
  );
  assert.deepEqual(
    reads.filter(
      ({ path }) =>
        path === "players/login-uid/matches" || path === "invites/invite-id",
    ),
    [
      {
        path: "players/login-uid/matches",
        query: { orderBy: "$key", limitToFirst: 21 },
      },
      {
        path: "invites/invite-id",
        query: { shallow: true },
      },
    ],
  );
});
