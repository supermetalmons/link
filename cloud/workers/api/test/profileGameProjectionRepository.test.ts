import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthFirestoreClient,
  AuthFirestoreDocument,
} from "../src/authFirestore.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import {
  createEventProfileGameProjectionRuntime,
  createProfileGameProjectionRuntime,
} from "../src/profileGameProjectionRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const firestoreRoot = "projects/mons-link/databases/(default)/documents";

function firestoreDocument(
  name: string,
  fields: Record<string, unknown>,
): AuthFirestoreDocument {
  return {
    fields,
    id: name.split("/").pop() || "",
    name,
    rawFields: {},
    updateTime: "2026-08-25T00:00:00Z",
  };
}

test("Worker projection adapter writes the shared projector contract to D1", async () => {
  let d1Batches = 0;
  let firestoreCommits = 0;
  const d1 = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAMES_DB,
    async batch(statements: D1PreparedStatement[]) {
      d1Batches += 1;
      return TELEGRAM_TEST_ENV.PROFILE_GAMES_DB.batch(statements);
    },
  } satisfies D1Database;
  const profiles = new Map([
    [
      `${firestoreRoot}/users/host-profile`,
      firestoreDocument(`${firestoreRoot}/users/host-profile`, {
        custom: { emoji: 7 },
        username: "Host",
      }),
    ],
    [
      `${firestoreRoot}/users/guest-profile`,
      firestoreDocument(`${firestoreRoot}/users/guest-profile`, {
        custom: { emoji: 9 },
        username: "Guest",
      }),
    ],
  ]);
  const firestore = {
    batchGet: async () => new Map(),
    commitWrites: async () => {
      firestoreCommits += 1;
    },
    createDocumentId: () => "document-id",
    get: async (name) => profiles.get(name) || null,
    listPage: async () => ({ documents: [], nextPageToken: "" }),
    query: async () => [],
    runTransaction: async (work) =>
      (
        await work({
          batchGet: async () => new Map(),
          query: async () => [],
        })
      ).result,
  } satisfies AuthFirestoreClient;
  const values = new Map<string, unknown>([
    [
      "invites/auto_aaaaaaaaaaa",
      {
        guestId: "guest-login",
        hostId: "host-login",
        matchesRatingUpdates: { auto_aaaaaaaaaaa: true },
      },
    ],
    ["automatch/auto_aaaaaaaaaaa", null],
    ["players/host-login/profile", "host-profile"],
    ["players/guest-login/profile", "guest-profile"],
  ]);
  const rtdb = {
    getRtdbPath: async (path: string) => values.get(path) ?? null,
  } satisfies Pick<GameplayRepository, "getRtdbPath">;
  const runtime = createProfileGameProjectionRuntime(TELEGRAM_TEST_ENV, {
    d1,
    firestore,
    rtdb,
    wait: async () => undefined,
  });

  const result = await runtime.recomputeInviteProjection(
    "auto_aaaaaaaaaaa",
    "invite-match-rating-updated",
    {
      eventTimestampMs: 500,
      latestMatchIdHint: "auto_aaaaaaaaaaa",
    },
  );
  assert.equal(result.writes, 2);
  assert.equal(d1Batches, 1);
  assert.equal(firestoreCommits, 0);
});

test("Worker event projection adapter writes and deletes through D1", async () => {
  let firestoreCommits = 0;
  const documents = new Map([
    [
      `${firestoreRoot}/profileMergeTargets/source-profile`,
      firestoreDocument(`${firestoreRoot}/profileMergeTargets/source-profile`, {
        targetProfileId: "target-profile",
      }),
    ],
    [
      `${firestoreRoot}/users/target-profile`,
      firestoreDocument(`${firestoreRoot}/users/target-profile`, {}),
    ],
  ]);
  const firestore = {
    batchGet: async () => new Map(),
    commitWrites: async () => {
      firestoreCommits += 1;
    },
    createDocumentId: () => "document-id",
    get: async (name) => documents.get(name) || null,
    listPage: async () => ({ documents: [], nextPageToken: "" }),
    query: async () => [],
    runTransaction: async (work) =>
      (
        await work({
          batchGet: async () => new Map(),
          query: async () => [],
        })
      ).result,
  } satisfies AuthFirestoreClient;
  const event = {
    status: "active",
    updatedAtMs: 500,
    participants: {
      source: { profileId: "source-profile", joinedAtMs: 1 },
    },
  };
  const rtdb = {
    getRtdbPath: async (path: string) =>
      path === "events/event-1" ? event : null,
  } satisfies Pick<GameplayRepository, "getRtdbPath">;
  const runtime = createEventProfileGameProjectionRuntime(TELEGRAM_TEST_ENV, {
    firestore,
    rtdb,
    wait: async () => undefined,
  });
  const result = await runtime.reconcileEventProjection("event-1", [
    "stale-profile",
  ]);
  assert.deepEqual(result, {
    deleted: 2,
    ownerProfileIds: ["target-profile"],
    status: "projected",
    written: 1,
  });
  assert.equal(firestoreCommits, 0);
});
