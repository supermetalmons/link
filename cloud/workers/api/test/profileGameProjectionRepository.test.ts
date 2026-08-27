import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthFirestoreClient,
  AuthFirestoreDocument,
  AuthFirestoreWrite,
} from "../src/authFirestore.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { decodeFirestoreFields } from "../src/gameplayRepository.ts";
import {
  createEventProfileGameProjectionRuntime,
  createProfileGameProjectionRuntime,
  eventProjectionDocumentName,
  projectionDocumentName,
  timestampFromMillis,
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

test("Worker projection adapter preserves the shared projector document contract", async () => {
  const writes: AuthFirestoreWrite[][] = [];
  const commitOrder: string[] = [];
  const d1 = {
    ...TELEGRAM_TEST_ENV.PROFILE_GAMES_DB,
    async batch(statements: D1PreparedStatement[]) {
      commitOrder.push("d1");
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
    commitWrites: async (batch) => {
      commitOrder.push("firestore");
      writes.push(batch);
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
    storageMode: "dual",
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
  assert.deepEqual(commitOrder, ["d1", "firestore"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 2);
  for (const write of writes[0]) {
    assert.equal("update" in write, true);
    if ("update" in write) {
      assert.deepEqual(write.update.fields.updatedAt, {
        timestampValue: "1970-01-01T00:00:00.500Z",
      });
      assert.deepEqual(write.update.fields.listSortAt, {
        timestampValue: "1970-01-01T00:00:00.500Z",
      });
    }
  }
  const decoded = writes[0].map((write) =>
    "update" in write ? decodeFirestoreFields(write.update.fields) : null,
  );
  assert.deepEqual(decoded.map((fields) => fields?.ownerProfileId).sort(), [
    "guest-profile",
    "host-profile",
  ]);
  for (const fields of decoded) {
    assert.equal(fields?.schemaVersion, 2);
    assert.equal(fields?.status, "active");
    assert.deepEqual(fields?.updatedAt, timestampFromMillis(500));
    assert.equal(fields?.lastEventReason, "invite-match-rating-updated");
  }
  assert.equal(
    projectionDocumentName("host-profile", "auto_aaaaaaaaaaa"),
    `${firestoreRoot}/users/host-profile/games/auto_aaaaaaaaaaa`,
  );
});

test("Worker event projection adapter writes and deletes exact Firestore documents", async () => {
  const writes: AuthFirestoreWrite[][] = [];
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
    commitWrites: async (batch) => {
      writes.push(batch);
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
    storageMode: "dual",
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
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 3);
  assert.equal(
    "update" in writes[0][0] ? writes[0][0].update.name : "",
    eventProjectionDocumentName("target-profile", "event-1"),
  );
  assert.deepEqual(
    "update" in writes[0][0] ? writes[0][0].update.fields.updatedAt : null,
    { timestampValue: "1970-01-01T00:00:00.500Z" },
  );
  assert.deepEqual(
    writes[0].slice(1).map((write) => ("delete" in write ? write.delete : "")),
    [
      eventProjectionDocumentName("source-profile", "event-1"),
      eventProjectionDocumentName("stale-profile", "event-1"),
    ],
  );
});
