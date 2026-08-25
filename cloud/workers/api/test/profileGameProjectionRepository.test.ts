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
  createProfileGameProjectionRuntime,
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
