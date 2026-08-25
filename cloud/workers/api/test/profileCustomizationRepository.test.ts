import assert from "node:assert/strict";
import test from "node:test";
import {
  authDocumentName,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestoreTransaction,
  type AuthFirestoreWrite,
} from "../src/authFirestore.ts";
import { createProfileCustomizationRepository } from "../src/profileCustomizationRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function document(
  id: string,
  overrides: Record<string, unknown> = {},
): AuthFirestoreDocument {
  return {
    id,
    name: authDocumentName("users", id),
    fields: {
      custom: { aura: "", emoji: 7 },
      eth: "",
      logins: ["firebase-uid"],
      sol: "sol-address",
      ...overrides,
    },
    rawFields: {},
    updateTime: "2026-08-25T00:00:00.000000Z",
  };
}

function firestore(
  documents: AuthFirestoreDocument[],
  transactionAttempts = 1,
) {
  const writes: AuthFirestoreWrite[][] = [];
  const filters: Record<string, unknown>[] = [];
  const client: AuthFirestoreClient = {
    batchGet: async () => new Map(),
    commitWrites: async () => {
      throw new Error("unexpected direct commit");
    },
    createDocumentId: () => "document-id",
    get: async () => null,
    listPage: async () => ({ documents: [], nextPageToken: "" }),
    query: async () => {
      throw new Error("unexpected non-transactional query");
    },
    async runTransaction<T>(
      work: (
        transaction: AuthFirestoreTransaction,
      ) => Promise<{ result: T; writes: AuthFirestoreWrite[] }>,
    ) {
      let result!: T;
      for (let attempt = 0; attempt < transactionAttempts; attempt++) {
        const operation = await work({
          batchGet: async () => new Map(),
          query: async (_collection, where) => {
            filters.push(where);
            return documents;
          },
        });
        result = operation.result;
        if (attempt === transactionAttempts - 1) {
          writes.push(operation.writes);
        }
      }
      return result;
    },
  };
  return { client, filters, writes };
}

test("transactionally updates both avatar fields for the verified login", async () => {
  const state = firestore([document("profile-1")]);
  const repository = createProfileCustomizationRepository(
    TELEGRAM_TEST_ENV as Env,
    { firestore: state.client },
  );
  assert.equal(
    await repository.updateCustomization(
      "firebase-uid",
      {
        field: "emojiAndAura",
        value: { emoji: 1009, aura: "rainbow" },
      },
      async (profile) => {
        assert.equal(
          profile.documentName,
          authDocumentName("users", "profile-1"),
        );
        assert.equal(profile.sol, "sol-address");
      },
    ),
    "updated",
  );
  assert.deepEqual(state.filters, [
    {
      fieldFilter: {
        field: { fieldPath: "logins" },
        op: "ARRAY_CONTAINS",
        value: { stringValue: "firebase-uid" },
      },
    },
  ]);
  assert.deepEqual(state.writes, [
    [
      {
        update: {
          name: authDocumentName("users", "profile-1"),
          fields: {
            custom: {
              mapValue: {
                fields: {
                  aura: { stringValue: "rainbow" },
                  emoji: { integerValue: "1009" },
                },
              },
            },
          },
        },
        updateMask: { fieldPaths: ["custom.emoji", "custom.aura"] },
      },
    ],
  ]);
});

test("transactionally updates one regular customization field", async () => {
  const state = firestore([document("profile-1")]);
  const repository = createProfileCustomizationRepository(
    TELEGRAM_TEST_ENV as Env,
    { firestore: state.client },
  );
  assert.equal(
    await repository.updateCustomization(
      "firebase-uid",
      { field: "cardStickers", value: '{"bottom-right":"star"}' },
      async () => undefined,
    ),
    "updated",
  );
  const write = state.writes[0][0];
  assert.ok("update" in write);
  assert.deepEqual(write.updateMask, {
    fieldPaths: ["custom.cardStickers"],
  });
});

test("does not write missing, ambiguous, or retired profiles", async () => {
  for (const [documents, expected] of [
    [[], "profile-not-found"],
    [[document("profile-1"), document("profile-2")], "login-profile-conflict"],
    [
      [document("profile-1", { mergedIntoProfileId: "profile-2" })],
      "login-profile-conflict",
    ],
  ] as const) {
    const state = firestore([...documents]);
    const repository = createProfileCustomizationRepository(
      TELEGRAM_TEST_ENV as Env,
      { firestore: state.client },
    );
    assert.equal(
      await repository.updateCustomization(
        "firebase-uid",
        { field: "tutorialCompleted", value: true },
        async () => undefined,
      ),
      expected,
    );
    assert.deepEqual(state.writes, [[]]);
  }
});

test("re-authorizes when the Firestore transaction retries", async () => {
  const state = firestore([document("profile-1")], 2);
  const repository = createProfileCustomizationRepository(
    TELEGRAM_TEST_ENV as Env,
    { firestore: state.client },
  );
  let authorizations = 0;
  assert.equal(
    await repository.updateCustomization(
      "firebase-uid",
      { field: "profileCounter", value: "mp" },
      async () => {
        authorizations++;
      },
    ),
    "updated",
  );
  assert.equal(authorizations, 2);
  assert.equal(state.filters.length, 2);
  assert.equal(state.writes.length, 1);
});

test("does not write when collectible authorization fails", async () => {
  const state = firestore([document("profile-1")]);
  const repository = createProfileCustomizationRepository(
    TELEGRAM_TEST_ENV as Env,
    { firestore: state.client },
  );
  await assert.rejects(
    repository.updateCustomization(
      "firebase-uid",
      { field: "cardBackgroundId", value: 100 },
      async () => {
        throw new Error("not-owned");
      },
    ),
    /not-owned/,
  );
  assert.deepEqual(state.writes, []);
});
