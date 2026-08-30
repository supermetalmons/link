import assert from "node:assert/strict";
import test from "node:test";
import { ensureFirebaseProfileClaim } from "../src/authRecovery.ts";

test("claim repair preserves cleanup IDs from a malformed profile-link outbox", async () => {
  const outboxPath = "profileGameProjectionOutbox/profile/firebase-uid";
  const patches: Array<Record<string, unknown>> = [];

  await ensureFirebaseProfileClaim("firebase-uid", "current-profile", {
    authClient: {
      getUser: async () => ({
        uid: "firebase-uid",
        customClaims: { profileId: "current-profile" },
      }),
      setCustomUserClaims: async () => undefined,
    },
    createRequestId: () => "repair-request",
    now: () => 500,
    rtdb: {
      getPath: async (path) => {
        if (path === "players/firebase-uid/profile") {
          return "previous-profile";
        }
        assert.equal(path, outboxPath);
        return {
          status: "malformed",
          profileId: "recorded-profile",
          cleanupProfileIds: {
            "ignored-profile": false,
            "older-profile": true,
            "page-profile": true,
            "unsafe/path": true,
          },
        };
      },
      patchRoot: async (updates) => {
        patches.push(updates);
      },
    },
  });

  assert.deepEqual(patches, [
    {
      "players/firebase-uid/profile": "current-profile",
      [outboxPath]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "repair-request",
        profileId: "current-profile",
        cleanupProfileIds: {
          "older-profile": true,
          "page-profile": true,
          "previous-profile": true,
          "recorded-profile": true,
        },
        matchCursor: null,
        sourceUpdatedAtMs: 500,
        lastQueuedAtMs: 500,
      },
    },
  ]);
});
