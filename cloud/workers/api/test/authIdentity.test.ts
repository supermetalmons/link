import assert from "node:assert/strict";
import test from "node:test";
import type { AuthMethodKey, AuthProfileResponse } from "@mons/shared/auth";
import { buildProfileEventPrizeMergeCopies } from "../../../functions/eventPrizeAwards.js";
import {
  getEventPrizeWithdrawalPath,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
} from "../../../functions/eventPrizeWithdrawalState.js";
import {
  AUTH_FIRESTORE_DATABASE_ROOT,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestoreTransaction,
  type AuthFirestoreWrite,
  authDocumentName,
  encodeFields,
} from "../src/authFirestore.ts";
import { createAuthIdentityService } from "../src/authIdentity.ts";
import { createAuthMergeRecovery } from "../src/authMergeRecovery.ts";
import type { FirebaseAuthAdminClient } from "../src/firebaseAuthAdmin.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { getMethodKey, uniqueStoredFirebaseUids } from "../src/authPolicy.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decode(value: unknown): unknown {
  const record = toRecord(value);
  if (Object.hasOwn(record, "nullValue")) return null;
  if (typeof record.stringValue === "string") return record.stringValue;
  if (typeof record.booleanValue === "boolean") return record.booleanValue;
  if (record.integerValue !== undefined) return Number(record.integerValue);
  if (typeof record.doubleValue === "number") return record.doubleValue;
  const array = toRecord(record.arrayValue);
  if (Array.isArray(array.values)) return array.values.map(decode);
  const map = toRecord(record.mapValue);
  if (map.fields) return decodeFields(toRecord(map.fields));
  return null;
}

function decodeFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decode(value)]),
  );
}

function collectionOf(name: string): string {
  return name.split("/documents/")[1]?.split("/")[0] || "";
}

function memoryFirestore(
  seed: Array<{
    collection: string;
    id: string;
    fields: Record<string, unknown>;
  }>,
) {
  const documents = new Map<string, AuthFirestoreDocument>();
  let idSequence = 0;
  for (const item of seed) {
    const name = authDocumentName(item.collection, item.id);
    documents.set(name, {
      id: item.id,
      name,
      fields: structuredClone(item.fields),
      rawFields: encodeFields(item.fields),
      updateTime: "2026-08-22T00:00:00Z",
    });
  }

  const matches = (
    document: AuthFirestoreDocument,
    where: Record<string, unknown>,
  ) => {
    const filter = toRecord(where.fieldFilter);
    const field = String(toRecord(filter.field).fieldPath || "");
    const expected = decode(filter.value);
    if (filter.op === "ARRAY_CONTAINS") {
      return (
        Array.isArray(document.fields[field]) &&
        document.fields[field].includes(expected)
      );
    }
    return document.fields[field] === expected;
  };

  const query = async (
    collectionId: string,
    where: Record<string, unknown>,
    limit = 100,
  ) =>
    Array.from(documents.values())
      .filter(
        (document) =>
          collectionOf(document.name) === collectionId &&
          document.name.split("/documents/")[1].split("/").length === 2 &&
          matches(document, where),
      )
      .slice(0, limit);

  const batchGet = async (names: string[]) =>
    new Map(names.map((name) => [name, documents.get(name) || null] as const));

  const apply = (writes: AuthFirestoreWrite[]) => {
    for (const write of writes) {
      if ("delete" in write) {
        documents.delete(write.delete);
        continue;
      }
      const current = documents.get(write.update.name);
      const fields = { ...(current?.fields || {}) };
      const incoming = decodeFields(write.update.fields);
      for (const path of write.updateMask.fieldPaths) {
        if (Object.hasOwn(incoming, path)) {
          fields[path] = incoming[path];
        } else {
          delete fields[path];
        }
      }
      const id = write.update.name.split("/").at(-1) || "";
      documents.set(write.update.name, {
        id,
        name: write.update.name,
        fields,
        rawFields: encodeFields(fields),
        updateTime: "2026-08-22T00:00:00Z",
      });
    }
  };

  const client: AuthFirestoreClient = {
    batchGet,
    commitWrites: async (writes) => apply(writes),
    createDocumentId: () => `generated-${++idSequence}`,
    get: async (name) => documents.get(name) || null,
    listPage: async (parent, collectionId) => {
      const prefix = `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/${parent}/${collectionId}/`;
      return {
        documents: Array.from(documents.values()).filter((document) =>
          document.name.startsWith(prefix),
        ),
        nextPageToken: "",
      };
    },
    query,
    runTransaction: async <T>(
      work: (
        transaction: AuthFirestoreTransaction,
      ) => Promise<{ result: T; writes: AuthFirestoreWrite[] }>,
    ) => {
      const operation = await work({ batchGet, query });
      apply(operation.writes);
      return operation.result;
    },
  };
  return { client, documents };
}

function dependencies(firestore: AuthFirestoreClient) {
  const claims = new Map<string, Record<string, unknown>>();
  const rtdbValues = new Map<string, unknown>();
  const rtdbTransactions: string[] = [];
  const authClient: FirebaseAuthAdminClient = {
    getUser: async (uid) => ({ uid, customClaims: claims.get(uid) || {} }),
    setCustomUserClaims: async (uid, value) => {
      claims.set(uid, value);
    },
  };
  const rtdb: FirebaseRtdbClient = {
    getPath: async (path) => rtdbValues.get(path) ?? null,
    patchRoot: async (updates) => {
      for (const [path, value] of Object.entries(updates)) {
        rtdbValues.set(path, value);
      }
    },
    transactPath: async (path, updater) => {
      rtdbTransactions.push(path);
      const output = toRecord(updater(rtdbValues.get(path) ?? null));
      if (output.commit === false) {
        return { committed: false, value: rtdbValues.get(path) ?? null };
      }
      rtdbValues.set(path, output.value);
      return { committed: true, value: output.value };
    },
  };
  return {
    authClient,
    claims,
    firestore,
    rtdb,
    rtdbTransactions,
    rtdbValues,
  };
}

const env = TELEGRAM_TEST_ENV as Env;

test("checkpoints bounded prize recovery pages", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: {
        pendingMergeGameCopySourceProfileId: "source-profile",
        pendingMergeGameCopyOpId: "merge-operation",
      },
    },
  ]);
  const deps = dependencies(memory.client);
  deps.rtdbValues.set("profileEventPrizes/source-profile", {
    FRkdorMWaYW: {
      eventId: "FRkdorMWaYW",
      profileId: "source-profile",
      place: 1,
      prizeId: "1866",
      assignedAtMs: 1,
    },
    NN3eRzoZo80: {
      eventId: "NN3eRzoZo80",
      profileId: "source-profile",
      place: 2,
      prizeId: "1111",
      assignedAtMs: 2,
    },
  });
  const recovery = createAuthMergeRecovery({
    buildPrizeCopies: buildProfileEventPrizeMergeCopies,
    durableFirestore: memory.client,
    firestore: memory.client,
    getWithdrawalPath: getEventPrizeWithdrawalPath,
    isCompletedWithdrawal: isCompletedEventPrizeWithdrawal,
    isMatchingAssignment: isMatchingProfileEventPrizeAssignment,
    mergeGameBacklogName: (opId) =>
      authDocumentName("authMergeGameBacklog", opId),
    now: () => 123,
    prizePageSize: 1,
    rtdb: deps.rtdb,
  });
  const input = {
    opId: "merge-operation",
    sourceProfileId: "source-profile",
    targetName: authDocumentName("users", "target-profile"),
    targetProfileId: "target-profile",
  };
  assert.equal(await recovery.reconcileProfilePrizes(input), false);
  assert.equal(
    memory.documents.get(input.targetName)?.fields.pendingMergePrizeCopyCursor,
    "FRkdorMWaYW",
  );
  assert.equal(await recovery.reconcileProfilePrizes(input), true);
  assert.equal(
    memory.documents.get(input.targetName)?.fields
      .pendingMergePrizeCopyCompletedOpId,
    "merge-operation",
  );
  assert.ok(
    deps.rtdbValues.get("profileEventPrizes/target-profile/FRkdorMWaYW"),
  );
  assert.ok(
    deps.rtdbValues.get("profileEventPrizes/target-profile/NN3eRzoZo80"),
  );
});

test("consumes an exact auth intent once inside a transaction", async () => {
  const nowMs = 1_000_000;
  const memory = memoryFirestore([
    {
      collection: "authIntents",
      id: "intent-1",
      fields: {
        uid: "login-1",
        method: "sol",
        nonce: "nonce-1",
        consumedAtMs: null,
        expiresAtMs: nowMs + 1_000,
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => nowMs,
  });
  const preview = await service.readIntent("login-1", "sol", "intent-1");
  assert.equal(preview.nonce, "nonce-1");
  assert.equal(
    memory.documents.get(authDocumentName("authIntents", "intent-1"))?.fields
      .consumedAtMs,
    null,
  );
  const result = await service.consumeIntent(
    "login-1",
    "sol",
    "intent-1",
    "intent:intent-1",
  );
  assert.equal(result.nonce, "nonce-1");
  assert.equal(
    memory.documents.get(authDocumentName("authIntents", "intent-1"))?.fields
      .consumedAtMs,
    nowMs,
  );
  assert.equal(
    memory.documents.get(authDocumentName("authIntents", "intent-1"))?.fields
      .consumedByOpId,
    "intent:intent-1",
  );
  await assert.rejects(
    service.consumeIntent("login-1", "sol", "intent-1"),
    (error) => error instanceof Error && error.message === "intent-consumed",
  );
});

test("keeps stored Firebase UIDs byte-exact", async () => {
  assert.deepEqual(
    uniqueStoredFirebaseUids(["", " login-1 ", "login-1"], ["", " login-1 "]),
    ["", " login-1 ", "login-1"],
  );
  const memory = memoryFirestore([
    {
      collection: "authIntents",
      id: "legacy-intent",
      fields: {
        uid: " login-1 ",
        method: "sol",
        nonce: "nonce-1",
        consumedAtMs: null,
        expiresAtMs: 1_001_000,
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 1_000_000,
  });
  await assert.rejects(
    service.readIntent("login-1", "sol", "legacy-intent"),
    (error) =>
      error instanceof Error && error.message === "intent-user-mismatch",
  );
});

test("rereads a consumed Apple intent only for its unfinished operation", async () => {
  const nowMs = 1_000_000;
  const memory = memoryFirestore([
    {
      collection: "authIntents",
      id: "intent-apple",
      fields: {
        uid: "login-1",
        method: "apple",
        nonce: "nonce-apple",
        consumedAtMs: nowMs - 1,
        expiresAtMs: nowMs - 1,
      },
    },
    {
      collection: "authOps",
      id: "intent:intent-apple",
      fields: {
        uid: "login-1",
        kind: "verify",
        method: "apple",
        status: "started",
        meta: { intentId: "intent-apple" },
        startedAtMs: nowMs - 1,
        updatedAtMs: nowMs - 1,
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => nowMs,
  });
  const retry = await service.readIntent(
    "login-1",
    "apple",
    "intent-apple",
    "intent:intent-apple",
  );
  assert.equal(retry.nonce, "nonce-apple");
  await assert.rejects(
    service.readIntent("login-1", "apple", "intent-apple"),
    (error) => error instanceof Error && error.message === "intent-expired",
  );
});

test("starts a verification operation before consuming its intent", async () => {
  const nowMs = 1_500_000;
  const memory = memoryFirestore([
    {
      collection: "authIntents",
      id: "intent-sol",
      fields: {
        uid: "login-1",
        method: "sol",
        nonce: "nonce-sol",
        consumedAtMs: null,
        expiresAtMs: nowMs + 1_000,
      },
    },
  ]);
  const runTransaction = memory.client.runTransaction;
  memory.client.runTransaction = async <T>(
    work: Parameters<AuthFirestoreClient["runTransaction"]>[0],
  ) => {
    assert.equal(
      memory.documents.has(authDocumentName("authOps", "intent:intent-sol")),
      true,
    );
    return runTransaction(work) as Promise<T>;
  };
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => nowMs,
  });
  const intent = await service.readIntent(
    "login-1",
    "sol",
    "intent-sol",
    "intent:intent-sol",
  );
  const input = {
    uid: "login-1",
    method: "sol" as const,
    methodValueRaw: "11111111111111111111111111111111",
    normalizedMethodValue: "11111111111111111111111111111111",
    intentId: "intent-sol",
    requestEmoji: 1,
    requestAura: null,
    preferredAddress: "11111111111111111111111111111111",
    opId: "intent:intent-sol",
  };
  assert.equal(await service.prepareVerifiedMethod(input, intent), null);
  const retryIntent = await service.readIntent(
    "login-1",
    "sol",
    "intent-sol",
    "intent:intent-sol",
  );
  assert.equal(retryIntent.consumedAtMs, nowMs);
  assert.equal(retryIntent.consumedByOpId, "intent:intent-sol");
  assert.equal(await service.prepareVerifiedMethod(input, retryIntent), null);
});

test("does not let a second X operation reuse a consumed intent", async () => {
  const nowMs = 1_600_000;
  const memory = memoryFirestore([
    {
      collection: "authIntents",
      id: "intent-x",
      fields: {
        uid: "login-1",
        method: "x",
        nonce: "nonce-x",
        consumedAtMs: null,
        expiresAtMs: nowMs + 1_000,
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => nowMs,
  });
  const firstIntent = await service.readIntent(
    "login-1",
    "x",
    "intent-x",
    "x-redirect:first",
  );
  const secondIntent = await service.readIntent(
    "login-1",
    "x",
    "intent-x",
    "x-redirect:second",
  );
  const input = (opId: string) => ({
    uid: "login-1",
    method: "x" as const,
    methodValueRaw: "12345",
    normalizedMethodValue: "12345",
    intentId: "intent-x",
    requestEmoji: 1,
    requestAura: null,
    preferredAddress: null,
    opId,
  });

  assert.equal(
    await service.prepareVerifiedMethod(input("x-redirect:first"), firstIntent),
    null,
  );
  await assert.rejects(
    service.prepareVerifiedMethod(input("x-redirect:second"), secondIntent),
    (error) => error instanceof Error && error.message === "intent-consumed",
  );
  assert.equal(
    memory.documents.get(authDocumentName("authIntents", "intent-x"))?.fields
      .consumedByOpId,
    "x-redirect:first",
  );
});

test("creates a new profile, method index, replay, claim, and RTDB link", async () => {
  const memory = memoryFirestore([]);
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 2_000_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: "11111111111111111111111111111111",
    normalizedMethodValue: "11111111111111111111111111111111",
    requestEmoji: 4,
    requestAura: "rainbow",
    preferredAddress: "11111111111111111111111111111111",
    opId: "intent:intent-sol",
  });
  assert.equal(response.profileId, "generated-1");
  assert.equal(response.emoji, 4);
  assert.equal(response.linkedMethods.sol, true);
  assert.equal(deps.claims.get("login-1")?.profileId, "generated-1");
  assert.equal(deps.rtdbValues.get("players/login-1/profile"), "generated-1");
  assert.equal(
    memory.documents.get(
      authDocumentName(
        "authMethodIndex",
        getMethodKey("sol", "11111111111111111111111111111111"),
      ),
    )?.fields.profileId,
    "generated-1",
  );
  assert.equal(
    memory.documents.get(authDocumentName("authOps", "intent:intent-sol"))
      ?.fields.status,
    "success",
  );
});

test("rechecks login ownership before creating a first profile", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: { logins: ["login-1"], custom: { emoji: 1 } },
    },
  ]);
  const query = memory.client.query;
  let loginQueries = 0;
  memory.client.query = async (collectionId, where, limit) => {
    const filter = toRecord(where.fieldFilter);
    const fieldPath = String(toRecord(filter.field).fieldPath || "");
    if (
      collectionId === "users" &&
      fieldPath === "logins" &&
      loginQueries++ === 0
    ) {
      return [];
    }
    return query(collectionId, where, limit);
  };
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 2_250_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: null,
    preferredAddress: sol,
    opId: "concurrent-first-profile",
  });
  assert.equal(response.profileId, "profile-1");
  assert.equal(
    memory.documents.has(authDocumentName("users", "generated-1")),
    false,
  );
});

test("converges on a login profile that appears before method attachment", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "login-profile",
      fields: { logins: ["login-1"], custom: { emoji: 1 } },
    },
    {
      collection: "users",
      id: "method-profile",
      fields: { logins: ["login-2"], sol, custom: { emoji: 2 } },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: {
        profileId: "method-profile",
        method: "sol",
        normalizedValue: sol,
      },
    },
  ]);
  const query = memory.client.query;
  let loginQueries = 0;
  memory.client.query = async (collectionId, where, limit) => {
    const filter = toRecord(where.fieldFilter);
    const fieldPath = String(toRecord(filter.field).fieldPath || "");
    if (
      collectionId === "users" &&
      fieldPath === "logins" &&
      loginQueries++ === 0
    ) {
      return [];
    }
    return query(collectionId, where, limit);
  };
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 2_300_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: null,
    preferredAddress: sol,
    opId: "concurrent-method-profile",
  });
  assert.equal(response.profileId, "login-profile");
  assert.equal(
    memory.documents.has(authDocumentName("users", "method-profile")),
    true,
  );
});

test("finalizes a link on the canonical profile after a concurrent merge", async () => {
  const xUserId = "2244994945";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "source-profile",
      fields: {
        logins: ["login-1"],
        appleSub: "apple-subject-1",
        custom: { emoji: 1 },
      },
    },
  ]);
  const runTransaction = memory.client.runTransaction;
  let transactions = 0;
  memory.client.runTransaction = async <T>(
    work: Parameters<AuthFirestoreClient["runTransaction"]>[0],
  ) => {
    const result = await runTransaction(work);
    transactions++;
    if (transactions === 1) {
      const sourceName = authDocumentName("users", "source-profile");
      const source = memory.documents.get(sourceName);
      assert.ok(source);
      const targetName = authDocumentName("users", "target-profile");
      const targetFields = structuredClone(source.fields);
      memory.documents.set(targetName, {
        id: "target-profile",
        name: targetName,
        fields: targetFields,
        rawFields: encodeFields(targetFields),
        updateTime: "2026-08-22T00:00:01Z",
      });
      source.fields = {
        logins: [],
        mergedIntoProfileId: "target-profile",
        mergeSourceRetainedForGameCopy: true,
      };
      source.rawFields = encodeFields(source.fields);
      const indexName = authDocumentName(
        "authMethodIndex",
        getMethodKey("x", xUserId),
      );
      const index = memory.documents.get(indexName);
      assert.ok(index);
      index.fields.profileId = "target-profile";
      index.rawFields = encodeFields(index.fields);
    }
    return result as T;
  };
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 2_350_000,
    randomInteger: () => 0,
  });

  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "x",
    methodValueRaw: xUserId,
    normalizedMethodValue: xUserId,
    requestEmoji: 1,
    requestAura: null,
    preferredAddress: null,
    xUsername: "Mons",
    opId: "concurrent-final-profile",
  });

  assert.equal(response.profileId, "target-profile");
  assert.equal(response.username, "Mons");
  assert.equal(deps.claims.get("login-1")?.profileId, "target-profile");
  assert.equal(
    deps.rtdbValues.get("players/login-1/profile"),
    "target-profile",
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "source-profile"))?.fields
      .username,
    undefined,
  );
});

test("rejects legacy Ethereum owners split across checksum representations", async () => {
  const normalized = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const checksummed = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "checksummed-profile",
      fields: { logins: ["login-1"], eth: checksummed },
    },
    {
      collection: "users",
      id: "normalized-profile",
      fields: { logins: ["login-2"], eth: normalized },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 2_400_000,
  });
  await assert.rejects(
    service.linkVerifiedMethod({
      uid: "login-new",
      method: "eth",
      methodValueRaw: normalized,
      methodValueLookupRaw: checksummed,
      normalizedMethodValue: normalized,
      requestEmoji: 1,
      requestAura: null,
      preferredAddress: normalized,
      opId: "legacy-eth-duplicate-operation",
    }),
    (error) =>
      error instanceof Error &&
      error.message === "legacy-method-duplicate-ownership",
  );
  assert.equal(
    memory.documents.has(
      authDocumentName("authMethodIndex", getMethodKey("eth", normalized)),
    ),
    false,
  );
});

test("keeps a committed link successful when claim repair is pending", async () => {
  const memory = memoryFirestore([]);
  const deps = dependencies(memory.client);
  deps.authClient.getUser = async () => {
    throw new Error("temporary-auth-failure");
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 2_500_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: "11111111111111111111111111111111",
    normalizedMethodValue: "11111111111111111111111111111111",
    requestEmoji: 4,
    requestAura: "rainbow",
    preferredAddress: "11111111111111111111111111111111",
    opId: "claim-repair-operation",
  });
  assert.equal(response.ok, true);
  assert.equal(
    memory.documents.get(authDocumentName("authOps", "claim-repair-operation"))
      ?.fields.status,
    "success",
  );
  assert.deepEqual(
    memory.documents.get(authDocumentName("users", response.profileId))?.fields
      .pendingClaimSyncLogins,
    ["login-1"],
  );
});

test("waits for both claim writes when one sibling fails", async () => {
  const memory = memoryFirestore([]);
  const deps = dependencies(memory.client);
  let rtdbSettled = false;
  deps.authClient.setCustomUserClaims = async () => {
    throw new Error("temporary-auth-failure");
  };
  deps.rtdb.patchRoot = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    rtdbSettled = true;
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 2_550_000,
  });

  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: "11111111111111111111111111111111",
    normalizedMethodValue: "11111111111111111111111111111111",
    requestEmoji: 1,
    requestAura: null,
    preferredAddress: "11111111111111111111111111111111",
    opId: "claim-sibling-settlement",
  });

  assert.equal(response.ok, true);
  assert.equal(rtdbSettled, true);
});

test("retries a committed link when claim recovery cannot be persisted", async () => {
  const sol = "11111111111111111111111111111111";
  const opId = "claim-marker-write-failure";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: { logins: ["login-1"], sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "profile-1", method: "sol" },
    },
  ]);
  const runTransaction = memory.client.runTransaction;
  let markerWriteFailures = 2;
  memory.client.runTransaction = async <T>(
    work: Parameters<AuthFirestoreClient["runTransaction"]>[0],
  ) =>
    runTransaction(async (transaction) => {
      const operation = await work(transaction);
      const persistsClaimBacklog = operation.writes.some(
        (write) =>
          "update" in write &&
          write.update.name.includes("/documents/authClaimSyncBacklog/") &&
          decodeFields(write.update.fields).status === "pending",
      );
      if (persistsClaimBacklog && markerWriteFailures > 0) {
        markerWriteFailures--;
        throw new Error("temporary-claim-marker-failure");
      }
      return operation;
    }) as Promise<T>;
  const recoveryTasks: unknown[] = [];
  const recoveryEnv = {
    ...env,
    AUTH_RECOVERY_QUEUE: {
      ...env.AUTH_RECOVERY_QUEUE,
      send: async (body: unknown, options?: QueueSendOptions) => {
        recoveryTasks.push({ body, options });
        return env.AUTH_RECOVERY_QUEUE.send(body, options);
      },
    },
  } as Env;
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(recoveryEnv, {
    ...deps,
    now: () => 2_600_000,
  });
  const input = {
    uid: "login-1",
    method: "sol" as const,
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId,
  };
  await assert.rejects(
    service.linkVerifiedMethod(input),
    (error) =>
      error instanceof Error &&
      error.message === "temporary-claim-marker-failure",
  );
  assert.equal(markerWriteFailures, 0);
  assert.deepEqual(recoveryTasks, []);
  assert.equal(deps.claims.has("login-1"), false);
  assert.equal(deps.rtdbValues.has("players/login-1/profile"), false);
  assert.equal(
    memory.documents.get(authDocumentName("authOps", opId))?.fields.status,
    "success",
  );

  const replay = await service.linkVerifiedMethod(input);
  assert.equal(replay.profileId, "profile-1");
  assert.equal(deps.claims.get("login-1")?.profileId, "profile-1");
  assert.equal(deps.rtdbValues.get("players/login-1/profile"), "profile-1");
  assert.equal(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields
      .pendingClaimSyncLogins,
    undefined,
  );
});

test("queues claim repair when another operation owns the profile lock", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: { logins: ["login-1"], sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "profile-1", method: "sol", normalizedValue: sol },
    },
    {
      collection: "mergeLocks",
      id: "profile:profile-1",
      fields: { opId: "other-operation", expiresAtMs: 4_000_000 },
    },
  ]);
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 3_000_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "contending-operation",
  });
  assert.equal(response.ok, true);
  assert.equal(deps.claims.has("login-1"), false);
  assert.deepEqual(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields
      .pendingClaimSyncLogins,
    ["login-1"],
  );
});

test("rejects an active merge lock owned by another invocation of the same operation", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const opId = "duplicate-merge-operation";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: ["login-1"], eth },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: { logins: ["login-2"], sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
    {
      collection: "mergeLocks",
      id: "profile:target-profile",
      fields: {
        opId: "first-invocation",
        operationId: opId,
        ownerId: "first-invocation",
        expiresAtMs: 4_000_000,
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    createLockOwnerId: () => "second-invocation",
    now: () => 3_000_000,
  });
  await assert.rejects(
    service.linkVerifiedMethod({
      uid: "login-1",
      method: "sol",
      methodValueRaw: sol,
      normalizedMethodValue: sol,
      requestEmoji: 1,
      requestAura: "",
      preferredAddress: sol,
      opId,
    }),
    (error) => error instanceof Error && error.message === "merge-lock-active",
  );
  assert.equal(
    memory.documents.get(
      authDocumentName("mergeLocks", "profile:target-profile"),
    )?.fields.opId,
    "first-invocation",
  );
  assert.equal(
    memory.documents.get(
      authDocumentName("mergeLocks", "profile:target-profile"),
    )?.fields.operationId,
    opId,
  );
  assert.equal(
    memory.documents.has(authDocumentName("users", "source-profile")),
    true,
  );
});

test("uses a twenty-minute mixed-version-safe lease and preserves its successor", async () => {
  const sol = "11111111111111111111111111111111";
  const opId = "claim-repair-operation";
  const lockName = authDocumentName("mergeLocks", "profile:profile-1");
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: { logins: ["login-1"], sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "profile-1", method: "sol", normalizedValue: sol },
    },
  ]);
  const deps = dependencies(memory.client);
  deps.authClient.getUser = async (uid) => {
    const lock = memory.documents.get(lockName);
    assert.equal(lock?.fields.opId, "first-invocation");
    assert.equal(lock?.fields.ownerId, "first-invocation");
    assert.equal(lock?.fields.operationId, opId);
    assert.notEqual(lock?.fields.opId, opId);
    assert.equal(lock?.fields.expiresAtMs, 4_200_000);
    assert.equal(
      Number(lock?.fields.expiresAtMs) > 3_000_000 &&
        String(lock?.fields.opId) !== opId,
      true,
    );
    if (lock) {
      lock.fields.opId = "successor-invocation";
      lock.fields.ownerId = "successor-invocation";
      lock.rawFields = encodeFields(lock.fields);
    }
    return { uid, customClaims: {} };
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    createLockOwnerId: () => "first-invocation",
    now: () => 3_000_000,
  });
  await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId,
  });
  assert.equal(
    memory.documents.get(lockName)?.fields.ownerId,
    "successor-invocation",
  );
  assert.equal(
    memory.documents.get(lockName)?.fields.opId,
    "successor-invocation",
  );
  assert.equal(memory.documents.get(lockName)?.fields.operationId, opId);
  assert.equal(memory.documents.get(lockName)?.fields.expiresAtMs, 4_200_000);
});

test("does not start a service-wide cleanup deadline", () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  assert.ok(descriptor);
  const deadlines: number[] = [];
  Object.defineProperty(AbortSignal, "timeout", {
    ...descriptor,
    value: (milliseconds: number) => {
      deadlines.push(milliseconds);
      return descriptor.value.call(AbortSignal, milliseconds) as AbortSignal;
    },
  });
  try {
    createAuthIdentityService(env);
  } finally {
    Object.defineProperty(AbortSignal, "timeout", descriptor);
  }
  assert.deepEqual(deadlines, []);
});

test("recovers a committed verification from an incomplete operation", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([]);
  const commitWrites = memory.client.commitWrites;
  let failedSuccessWrites = 0;
  memory.client.commitWrites = async (writes) => {
    const writesSuccess = writes.some(
      (write) =>
        "update" in write &&
        decodeFields(write.update.fields).status === "success",
    );
    if (writesSuccess && failedSuccessWrites < 3) {
      failedSuccessWrites++;
      throw new Error("temporary-auth-op-failure");
    }
    await commitWrites(writes);
  };
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 3_250_000,
  });
  const initial = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "incomplete-verify-operation",
  });
  assert.equal(initial.ok, true);
  assert.equal(
    memory.documents.get(
      authDocumentName("authOps", "incomplete-verify-operation"),
    )?.fields.status,
    "started",
  );
  const replay = await service.peekVerifyReplay(
    "incomplete-verify-operation",
    "sol",
    "login-1",
  );
  assert.equal(replay?.profileId, initial.profileId);
  assert.equal(
    memory.documents.get(
      authDocumentName("authOps", "incomplete-verify-operation"),
    )?.fields.status,
    "success",
  );
});

test("refreshes a completed result only while its profile owns the method", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["login-1"],
        xUserId: "12345",
        username: "Mons123",
        custom: { emoji: 1 },
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 2_600_000,
  });
  const stored: AuthProfileResponse = {
    ok: true,
    uid: "login-1",
    profileId: "profile-1",
    username: "OldName",
    linkedMethods: { apple: false, eth: false, sol: false, x: true },
    appleLinked: false,
    emoji: 1,
    opId: "x-redirect:flow-1",
  };
  const refreshed = await service.refreshCompletedVerifyResult(
    stored,
    "x",
    "login-1",
    "12345",
  );
  assert.equal(refreshed?.username, "Mons123");
  assert.equal(
    await service.refreshCompletedVerifyResult(stored, "x", "login-1", "67890"),
    null,
  );
  const profile = memory.documents.get(authDocumentName("users", "profile-1"));
  if (profile) {
    delete profile.fields.xUserId;
  }
  assert.equal(
    await service.refreshCompletedVerifyResult(stored, "x", "login-1", "12345"),
    null,
  );
});

test("does not let an older claim repair clear a newer marker", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["login-1"],
        sol,
        pendingClaimSyncLogins: ["login-1"],
        pendingClaimSyncOpId: "newer-claim-operation",
      },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "profile-1", method: "sol", normalizedValue: sol },
    },
  ]);
  const deps = dependencies(memory.client);
  let claimReads = 0;
  deps.authClient.getUser = async (uid) => {
    claimReads++;
    if (claimReads <= 2) {
      throw new Error("temporary-auth-failure");
    }
    return { uid, customClaims: {} };
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 2_750_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "older-auth-operation",
  });
  assert.equal(response.ok, true);
  assert.equal(claimReads, 3);
  assert.equal(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields
      .pendingClaimSyncOpId,
    "newer-claim-operation",
  );
});

test("preserves unattempted claim repairs from the same operation", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["login-1", "login-2"],
        sol,
        pendingClaimSyncLogins: ["login-2"],
        pendingClaimSyncOpId: "claim-repair-operation",
      },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "profile-1", method: "sol", normalizedValue: sol },
    },
  ]);
  const deps = dependencies(memory.client);
  deps.authClient.getUser = async (uid) => {
    if (uid === "login-2") {
      throw new Error("temporary-auth-failure");
    }
    return { uid, customClaims: deps.claims.get(uid) || {} };
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 2_800_000,
  });
  await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "claim-repair-operation",
  });
  assert.deepEqual(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields
      .pendingClaimSyncLogins,
    ["login-2"],
  );
  assert.deepEqual(
    memory.documents.get(
      authDocumentName("authClaimSyncBacklog", "claim-repair-operation"),
    )?.fields.failedLoginUids,
    ["login-2"],
  );
});

test("keeps queue-owned claim recovery out of the pending sweep", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["login-1"],
        pendingClaimSyncLogins: ["login-1"],
        pendingClaimSyncOpId: "claim-repair-operation",
      },
    },
  ]);
  const deps = dependencies(memory.client);
  deps.authClient.getUser = async () => {
    throw new Error("temporary-auth-failure");
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    claimBacklogStatus: "queued",
    now: () => 2_900_000,
  });
  assert.equal(await service.recoverPendingProfile("profile-1"), false);
  assert.equal(
    memory.documents.get(
      authDocumentName("authClaimSyncBacklog", "claim-repair-operation"),
    )?.fields.status,
    "queued",
  );
});

test("clears retired-source claim recovery without external writes", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "source-profile",
      fields: {
        logins: [],
        mergedIntoProfileId: "target-profile",
        mergeSourceRetainedForGameCopy: true,
        pendingClaimSyncLogins: ["login-1"],
        pendingClaimSyncOpId: "claim-repair-operation",
        pendingClaimSyncUpdatedAtMs: 2_900_000,
      },
    },
    {
      collection: "authClaimSyncBacklog",
      id: "claim-repair-operation",
      fields: {
        status: "queued",
        targetProfileId: "source-profile",
        failedLoginUids: ["login-1"],
      },
    },
  ]);
  const deps = dependencies(memory.client);
  let externalReads = 0;
  deps.authClient.getUser = async () => {
    externalReads++;
    throw new Error("unexpected-auth-read");
  };
  deps.rtdb.getPath = async () => {
    externalReads++;
    throw new Error("unexpected-rtdb-read");
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    claimBacklogStatus: "queued",
    now: () => 3_000_000,
  });
  assert.equal(await service.recoverPendingProfile("source-profile"), true);
  assert.equal(externalReads, 0);
  const source = memory.documents.get(
    authDocumentName("users", "source-profile"),
  );
  assert.equal(source?.fields.pendingClaimSyncLogins, undefined);
  assert.equal(source?.fields.pendingClaimSyncOpId, undefined);
  assert.equal(source?.fields.pendingClaimSyncUpdatedAtMs, undefined);
  assert.equal(
    memory.documents.has(
      authDocumentName("authClaimSyncBacklog", "claim-repair-operation"),
    ),
    false,
  );
});

test("unlinks a non-final method and writes both cooldown records", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: { logins: ["login-1"], eth, sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("eth", eth),
      fields: { profileId: "profile-1", method: "eth", normalizedValue: eth },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 3_000_000,
  });
  const response = await service.unlinkMethod("login-1", "eth", "unlink-1");
  assert.deepEqual(response.linkedMethods, {
    apple: false,
    eth: false,
    sol: true,
    x: false,
  });
  assert.equal(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields.eth,
    undefined,
  );
  assert.ok(
    memory.documents.has(
      authDocumentName("authMethodRevocations", getMethodKey("eth", eth)),
    ),
  );
  assert.ok(
    memory.documents.has(
      authDocumentName("authProfileMethodCooldowns", "profile-1:eth"),
    ),
  );
  assert.equal(
    memory.documents.get(authDocumentName("authOps", "unlink-1"))?.fields
      .status,
    "success",
  );
});

test("does not replace a successful unlink replay with a raced failure", async () => {
  const nowMs = 3_500_000;
  const opId = "raced-unlink";
  const operationName = authDocumentName("authOps", opId);
  const savedResult = {
    ok: true as const,
    profileId: "profile-1",
    linkedMethods: { apple: false, eth: false, sol: true, x: false },
    appleLinked: false,
  };
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["login-1"],
        sol: "11111111111111111111111111111111",
      },
    },
    {
      collection: "authOps",
      id: opId,
      fields: {
        opId,
        kind: "unlink",
        method: "eth",
        uid: "login-1",
        status: "started",
        startedAtMs: nowMs,
        updatedAtMs: nowMs,
      },
    },
  ]);
  const get = memory.client.get;
  let operationReads = 0;
  memory.client.get = async (name) => {
    const document = await get(name);
    if (name !== operationName || !document || ++operationReads !== 3) {
      return document;
    }
    const stale = structuredClone(document);
    document.fields = {
      ...document.fields,
      status: "success",
      result: savedResult,
      updatedAtMs: nowMs,
    };
    document.rawFields = encodeFields(document.fields);
    return stale;
  };
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => nowMs,
  });
  await assert.rejects(
    service.unlinkMethod("login-1", "eth", opId),
    (error) => error instanceof Error && error.message === "method-not-linked",
  );
  assert.equal(memory.documents.get(operationName)?.fields.status, "success");
  assert.deepEqual(
    await service.unlinkMethod("login-1", "eth", opId),
    savedResult,
  );
});

test("refuses to unlink the final authentication method", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: { logins: ["login-1"], sol },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 4_000_000,
  });
  await assert.rejects(
    service.unlinkMethod("login-1", "sol", "unlink-final"),
    (error) =>
      error instanceof Error && error.message === "cannot-remove-last-method",
  );
});

test("merges conflicting profiles and finalizes game cleanup after recovery delay", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: {
        logins: ["login-1"],
        eth,
        username: "Target123",
        usernameLookupKey: "target123",
        xUsername: "stale-target-name",
        win: [],
        custom: { emoji: 3, aura: "   ", completedProblems: ["one"] },
        mining: { lastRockDate: null, materials: {} },
        pendingMergePrizeCopyCursor: "stale-event",
        pendingMergePrizeCopyCompletedAtMs: 1,
        pendingMergePrizeCopyCompletedOpId: "stale-operation",
      },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: {
        logins: ["login-2"],
        sol,
        xUserId: "12345",
        xUsername: "source-name",
        win: "source-win",
        custom: { emoji: 7, aura: "source-aura", completedProblems: ["two"] },
        mining: { lastRockDate: null, materials: {} },
      },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: {
        profileId: "source-profile",
        method: "sol",
        normalizedValue: sol,
      },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("eth", eth),
      fields: {
        profileId: "stale-method-owner",
        method: "eth",
        normalizedValue: eth,
      },
    },
    {
      collection: "usernameIndex",
      id: "target123",
      fields: {
        profileId: "stale-username-owner",
        username: "Target123",
      },
    },
    {
      collection: "users",
      id: "stale-lookup-profile",
      fields: {
        logins: [],
        username: "Other123",
        usernameLookupKey: "target123",
      },
    },
  ]);
  const deps = dependencies(memory.client);
  deps.rtdbValues.set("profileEventPrizes/source-profile", {
    NN3eRzoZo80: {
      eventId: "NN3eRzoZo80",
      profileId: "source-profile",
      place: 2,
      prizeId: "1111",
      assignedAtMs: 1234,
    },
    FRkdorMWaYW: {
      eventId: "FRkdorMWaYW",
      profileId: "source-profile",
      place: 1,
      prizeId: "1866",
      assignedAtMs: 5678,
    },
  });
  deps.rtdbValues.set("profileEventPrizes/target-profile/NN3eRzoZo80", {
    eventId: "NN3eRzoZo80",
    profileId: "target-profile",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 1234,
  });
  let nowMs = 5_000_000;
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => nowMs,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "merge-operation",
  });
  assert.equal(response.profileId, "target-profile");
  assert.equal(response.linkedMethods.eth, true);
  assert.equal(response.linkedMethods.sol, true);
  assert.equal(response.aura, "source-aura");
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .win,
    "source-win",
  );
  assert.equal(
    memory.documents.get(
      authDocumentName("authMethodIndex", getMethodKey("eth", eth)),
    )?.fields.profileId,
    "target-profile",
  );
  assert.equal(
    memory.documents.get(authDocumentName("usernameIndex", "target123"))?.fields
      .profileId,
    "target-profile",
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .xUsername,
    "source-name",
  );
  assert.equal(
    memory.documents.has(authDocumentName("users", "source-profile")),
    true,
  );
  assert.equal(
    memory.documents.get(
      authDocumentName("profileMergeTargets", "source-profile"),
    )?.fields.targetProfileId,
    "target-profile",
  );
  assert.equal(deps.claims.get("login-1")?.profileId, "target-profile");
  assert.equal(deps.claims.get("login-2")?.profileId, "target-profile");
  const mergedTarget = memory.documents.get(
    authDocumentName("users", "target-profile"),
  );
  assert.equal(mergedTarget?.fields.pendingMergePrizeCopyCursor, undefined);
  assert.equal(
    mergedTarget?.fields.pendingMergePrizeCopyCompletedAtMs,
    undefined,
  );
  assert.equal(
    mergedTarget?.fields.pendingMergePrizeCopyCompletedOpId,
    undefined,
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
    "source-profile",
  );
  nowMs += 60_000;
  assert.equal(await service.recoverPendingProfile("target-profile"), true);
  assert.equal(deps.claims.get("login-1")?.profileId, "target-profile");
  assert.equal(deps.claims.get("login-2")?.profileId, "target-profile");
  assert.equal(
    memory.documents.has(authDocumentName("users", "source-profile")),
    false,
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
    undefined,
  );
  assert.equal(
    memory.documents.has(
      authDocumentName("authMergeGameBacklog", "merge-operation:copy"),
    ),
    false,
  );
  assert.deepEqual(deps.rtdbTransactions, [
    "profileEventPrizes/target-profile/FRkdorMWaYW",
    "profileEventPrizes/target-profile/NN3eRzoZo80",
  ]);
  assert.deepEqual(
    deps.rtdbValues.get("profileEventPrizes/target-profile/FRkdorMWaYW"),
    {
      eventId: "FRkdorMWaYW",
      profileId: "target-profile",
      place: 1,
      prizeId: "1866",
      assignedAtMs: 5678,
    },
  );
});

test("derives merged values from the transaction snapshots", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: ["login-1"], eth, totalManaPoints: 1 },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: { logins: ["login-2"], sol, totalManaPoints: 2 },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
  ]);
  const originalRunTransaction = memory.client.runTransaction;
  let transactions = 0;
  memory.client.runTransaction = async <T>(
    work: Parameters<AuthFirestoreClient["runTransaction"]>[0],
  ) => {
    transactions++;
    if (transactions === 3) {
      const name = authDocumentName("users", "target-profile");
      const profile = memory.documents.get(name);
      if (profile) {
        profile.fields.totalManaPoints = 10;
        profile.rawFields = encodeFields(profile.fields);
      }
    }
    return originalRunTransaction(work) as Promise<T>;
  };
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 5_500_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "live-merge-operation",
  });
  assert.equal(response.totalManaPoints, 12);
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .usernameLookupKey,
    undefined,
  );
});

test("does not merge a retained source twice after a transaction retry", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: ["login-1"], eth, rating: 1800 },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: { logins: ["login-2"], sol, rating: 1900 },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
  ]);
  const originalRunTransaction = memory.client.runTransaction;
  let transactions = 0;
  memory.client.runTransaction = async <T>(
    work: Parameters<AuthFirestoreClient["runTransaction"]>[0],
  ) => {
    transactions++;
    if (transactions === 3) {
      await originalRunTransaction(work);
    }
    return originalRunTransaction(work) as Promise<T>;
  };
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 5_550_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "retried-merge-operation",
  });
  assert.equal(response.rating, 1800);
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .rating,
    1800,
  );
});

test("does not skip a live source with incomplete merge metadata", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: ["login-1"], eth, rating: 1800 },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: {
        logins: ["login-2"],
        sol,
        rating: 1700,
        mergedIntoProfileId: "target-profile",
      },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
    {
      collection: "profileMergeTargets",
      id: "source-profile",
      fields: { targetProfileId: "target-profile" },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 5_560_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "incomplete-merge-operation",
  });
  assert.equal(response.rating, 1700);
  assert.equal(response.linkedMethods.sol, true);
});

test("repairs prizes when a concurrent merge already deleted the source", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const eventId = "FRkdorMWaYW";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: {
        logins: ["login-1"],
        eth,
        pendingMergePrizeCopyCursor: "stale-event",
        pendingMergePrizeCopyCompletedAtMs: 1,
        pendingMergePrizeCopyCompletedOpId: "stale-operation",
      },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: { logins: ["login-2"], sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
    {
      collection: "profileMergeTargets",
      id: "source-profile",
      fields: { targetProfileId: "target-profile" },
    },
  ]);
  const originalRunTransaction = memory.client.runTransaction;
  let transactions = 0;
  memory.client.runTransaction = <T>(
    work: Parameters<AuthFirestoreClient["runTransaction"]>[0],
  ) => {
    transactions++;
    if (transactions === 3) {
      memory.documents.delete(authDocumentName("users", "source-profile"));
    }
    return originalRunTransaction(work) as Promise<T>;
  };
  const deps = dependencies(memory.client);
  deps.rtdbValues.set("profileEventPrizes/source-profile", {
    [eventId]: {
      eventId,
      profileId: "source-profile",
      place: 1,
      prizeId: "1866",
      assignedAtMs: 1,
    },
  });
  const getPath = deps.rtdb.getPath;
  let failures = 1;
  deps.rtdb.getPath = async (path, query, signal) => {
    if (path === "profileEventPrizes/source-profile" && failures > 0) {
      failures--;
      throw new Error("temporary-rtdb-failure");
    }
    return getPath(path, query, signal);
  };
  let nowMs = 5_565_000;
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => nowMs,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "missing-source-merge-operation",
  });
  assert.equal(response.profileId, "target-profile");
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergePrizeCopyCursor,
    undefined,
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
    "source-profile",
  );
  assert.equal(
    memory.documents.has(
      authDocumentName(
        "authMergeGameBacklog",
        "missing-source-merge-operation:copy",
      ),
    ),
    false,
  );
  nowMs += 60_000;
  const pendingReplay = await service.peekVerifyReplay(
    "missing-source-merge-operation",
    "sol",
    "login-1",
  );
  assert.equal(pendingReplay?.ok, true);
  assert.equal(
    deps.rtdbValues.get(`profileEventPrizes/target-profile/${eventId}`),
    undefined,
  );
  const replay = await service.peekVerifyReplay(
    "missing-source-merge-operation",
    "sol",
    "login-1",
  );
  assert.equal(replay?.ok, true);
  assert.deepEqual(
    deps.rtdbValues.get(`profileEventPrizes/target-profile/${eventId}`),
    {
      eventId,
      profileId: "target-profile",
      place: 1,
      prizeId: "1866",
      assignedAtMs: 1,
    },
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
    undefined,
  );
  assert.equal(
    memory.documents.has(
      authDocumentName(
        "authMergeGameBacklog",
        "missing-source-merge-operation:copy",
      ),
    ),
    false,
  );
});

test("expires owned merge locks when deletion keeps failing", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const nowMs = 5_575_000;
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: { logins: ["login-1"], eth },
    },
  ]);
  const originalRunTransaction = memory.client.runTransaction;
  let releaseFailures = 0;
  memory.client.runTransaction = <T>(
    work: Parameters<AuthFirestoreClient["runTransaction"]>[0],
  ) =>
    originalRunTransaction(async (transaction) => {
      const operation = await work(transaction);
      const deletesLock = operation.writes.some(
        (write) => "delete" in write && write.delete.includes("/mergeLocks/"),
      );
      if (deletesLock && releaseFailures < 3) {
        releaseFailures++;
        throw new Error("temporary-lock-release-failure");
      }
      return operation;
    }) as Promise<T>;
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => nowMs,
  });
  await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "lock-release-operation",
  });
  assert.equal(releaseFailures, 3);
  assert.equal(
    memory.documents.get(authDocumentName("mergeLocks", "profile:profile-1"))
      ?.fields.expiresAtMs,
    nowMs - 1,
  );
});

test("removes a copied prize after its withdrawal completes", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const eventId = "FRkdorMWaYW";
  const prizeId = "1866";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: ["login-1"], eth },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: { logins: ["login-2"], sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
  ]);
  const deps = dependencies(memory.client);
  deps.rtdbValues.set("profileEventPrizes/source-profile", {
    [eventId]: {
      eventId,
      profileId: "source-profile",
      place: 1,
      prizeId,
      assignedAtMs: 1,
    },
  });
  const getPath = deps.rtdb.getPath;
  let withdrawalReads = 0;
  deps.rtdb.getPath = async (path, query, signal) => {
    if (path === `eventPrizeWithdrawals/${eventId}/${prizeId}`) {
      withdrawalReads++;
      return withdrawalReads === 1
        ? null
        : {
            status: "completed",
            eventId,
            prizeId,
            assetAddress: "2KNT8rbXC7G8w5AChbEHHi6i4FN7EAZCtdWX65ZSuQp6",
            assetStandard: "compressed",
          };
    }
    return getPath(path, query, signal);
  };
  let nowMs = 5_600_000;
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => nowMs,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "withdrawn-prize-merge",
  });
  assert.equal(response.ok, true);
  assert.equal(withdrawalReads, 0);
  nowMs += 60_000;
  assert.equal(await service.recoverPendingProfile("target-profile"), true);
  assert.equal(withdrawalReads, 2);
  assert.equal(
    deps.rtdbValues.get(`profileEventPrizes/target-profile/${eventId}`),
    null,
  );
});

test("clears retired source claim markers before pending prize recovery", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: ["login-1"], eth },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: {
        logins: ["login-2"],
        sol,
        pendingClaimSyncLogins: ["login-2"],
        pendingClaimSyncOpId: "older-claim-repair",
        pendingClaimSyncUpdatedAtMs: 5_700_000,
      },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
  ]);
  const deps = dependencies(memory.client);
  const recoveryTasks: Array<{ body: unknown; options: unknown }> = [];
  const recoveryEnv = {
    ...env,
    AUTH_RECOVERY_QUEUE: {
      ...env.AUTH_RECOVERY_QUEUE,
      send: async (body: unknown, options?: QueueSendOptions) => {
        recoveryTasks.push({ body, options });
        return env.AUTH_RECOVERY_QUEUE.send(body, options);
      },
    },
  } as Env;
  deps.rtdbValues.set("profileEventPrizes/source-profile", {
    FRkdorMWaYW: {
      eventId: "FRkdorMWaYW",
      profileId: "source-profile",
      place: 1,
      prizeId: "1866",
      assignedAtMs: 5678,
    },
  });
  const transactPath = deps.rtdb.transactPath;
  let failures = 1;
  deps.rtdb.transactPath = async (path, updater, signal) => {
    if (failures > 0) {
      failures--;
      throw new Error("temporary-rtdb-failure");
    }
    return transactPath(path, updater, signal);
  };
  let nowMs = 5_750_000;
  const service = createAuthIdentityService(recoveryEnv, {
    ...deps,
    now: () => nowMs,
  });
  await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "merge-prize-recovery",
  });
  assert.ok(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
  );
  const retainedSource = memory.documents.get(
    authDocumentName("users", "source-profile"),
  );
  assert.ok(retainedSource);
  assert.equal(retainedSource.fields.pendingClaimSyncLogins, undefined);
  assert.equal(retainedSource.fields.pendingClaimSyncOpId, undefined);
  assert.equal(retainedSource.fields.pendingClaimSyncUpdatedAtMs, undefined);
  assert.equal(
    deps.rtdbValues.get("profileEventPrizes/target-profile/FRkdorMWaYW"),
    undefined,
  );
  assert.deepEqual(recoveryTasks, [
    {
      body: {
        kind: "auth-profile-recovery",
        profileId: "target-profile",
      },
      options: { delaySeconds: 60 },
    },
  ]);
  nowMs += 60_000;
  const pendingReplay = await service.peekVerifyReplay(
    "merge-prize-recovery",
    "sol",
    "login-1",
  );
  assert.equal(pendingReplay?.ok, true);
  assert.equal(
    memory.documents.has(authDocumentName("users", "source-profile")),
    true,
  );
  const replay = await service.peekVerifyReplay(
    "merge-prize-recovery",
    "sol",
    "login-1",
  );
  assert.equal(replay?.ok, true);
  assert.equal(
    memory.documents.has(authDocumentName("users", "source-profile")),
    false,
  );
  assert.deepEqual(
    deps.rtdbValues.get("profileEventPrizes/target-profile/FRkdorMWaYW"),
    {
      eventId: "FRkdorMWaYW",
      profileId: "target-profile",
      place: 1,
      prizeId: "1866",
      assignedAtMs: 5678,
    },
  );
  assert.equal(deps.claims.get("login-2")?.profileId, "target-profile");
  assert.equal(
    deps.rtdbValues.get("players/login-2/profile"),
    "target-profile",
  );
});

test("requires a durable game-recovery wake-up before retry succeeds", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: ["login-1"], eth },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: { logins: ["login-2"], sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
  ]);
  let queueUnavailable = true;
  let sends = 0;
  const recoveryEnv = {
    ...env,
    AUTH_RECOVERY_QUEUE: {
      ...env.AUTH_RECOVERY_QUEUE,
      send: async (body: unknown, options?: QueueSendOptions) => {
        sends++;
        if (queueUnavailable) {
          throw new Error("queue-unavailable");
        }
        return env.AUTH_RECOVERY_QUEUE.send(body, options);
      },
    },
  } as Env;
  const deps = dependencies(memory.client);
  const getPath = deps.rtdb.getPath;
  deps.rtdb.getPath = async (path, query, signal) => {
    if (path === "profileEventPrizes/source-profile") {
      throw new Error("prize-copy-unavailable");
    }
    return getPath(path, query, signal);
  };
  const service = createAuthIdentityService(recoveryEnv, {
    ...deps,
    now: () => 5_800_000,
  });
  const input = {
    uid: "login-1",
    method: "sol" as const,
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: sol,
    opId: "strict-game-recovery-enqueue",
  };
  await assert.rejects(service.linkVerifiedMethod(input), /queue-unavailable/);
  assert.equal(sends, 1);
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
    "source-profile",
  );
  assert.equal(
    memory.documents.get(authDocumentName("authMergeGameBacklog", input.opId))
      ?.fields.status,
    "pending",
  );

  queueUnavailable = false;
  const replay = await service.peekVerifyReplay(
    input.opId,
    input.method,
    input.uid,
  );
  assert.equal(replay?.profileId, "target-profile");
  assert.equal(sends, 2);
  assert.equal(
    memory.documents.has(authDocumentName("authMergeGameBacklog", input.opId)),
    false,
  );
});

test("does not overwrite an older pending merge marker", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: {
        logins: ["login-1"],
        sol,
        pendingMergeGameCopySourceProfileId: "source-a",
        pendingMergeGameCopyOpId: "source-a-operation",
      },
    },
    {
      collection: "users",
      id: "source-a",
      fields: { logins: [] },
    },
    {
      collection: "users",
      id: "source-b",
      fields: { logins: ["login-2"], xUserId: "12345" },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("x", "12345"),
      fields: { profileId: "source-b", method: "x" },
    },
  ]);
  const deps = dependencies(memory.client);
  const getPath = deps.rtdb.getPath;
  deps.rtdb.getPath = async (path, query, signal) => {
    if (path === "profileEventPrizes/source-a") {
      throw new Error("temporary-rtdb-failure");
    }
    return getPath(path, query, signal);
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 5_900_000,
  });
  await assert.rejects(
    service.linkVerifiedMethod({
      uid: "login-1",
      method: "x",
      methodValueRaw: "12345",
      normalizedMethodValue: "12345",
      requestEmoji: 1,
      requestAura: "",
      preferredAddress: null,
      opId: "new-merge-operation",
    }),
    (error) =>
      error instanceof Error && error.message === "merge-recovery-pending",
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
    "source-a",
  );
  assert.equal(
    memory.documents.has(authDocumentName("users", "source-b")),
    true,
  );
});

test("does not merge a source profile with pending recovery", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: ["login-1"], eth },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: {
        logins: ["login-2"],
        sol,
        pendingMergeGameCopySourceProfileId: "older-source",
        pendingMergeGameCopyOpId: "older-operation",
      },
    },
    {
      collection: "users",
      id: "older-source",
      fields: { logins: [] },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: { profileId: "source-profile", method: "sol" },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 5_950_000,
  });
  await assert.rejects(
    service.linkVerifiedMethod({
      uid: "login-1",
      method: "sol",
      methodValueRaw: sol,
      normalizedMethodValue: sol,
      requestEmoji: 1,
      requestAura: "",
      preferredAddress: sol,
      opId: "new-merge-operation",
    }),
    (error) =>
      error instanceof Error && error.message === "merge-recovery-pending",
  );
  assert.equal(
    memory.documents.has(authDocumentName("users", "source-profile")),
    true,
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .sol,
    undefined,
  );
});

test("does not reuse a legacy username that lacks a lookup-key field", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "legacy-profile",
      fields: { username: "Alice7", logins: ["legacy-login"] },
    },
    {
      collection: "usernameIndex",
      id: "Alice7",
      fields: { profileId: "legacy-profile", username: "Alice7" },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 6_000_000,
    randomInteger: () => 0,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-x",
    method: "x",
    methodValueRaw: "12345",
    normalizedMethodValue: "12345",
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: null,
    xUsername: "Alice7",
    opId: "legacy-username-operation",
  });
  assert.equal(response.username, "Aaaa000");
  assert.equal(
    memory.documents.get(authDocumentName("users", "legacy-profile"))?.fields
      .username,
    "Alice7",
  );
});

test("ignores stale lookup-key fields when assigning a preferred username", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "stale-profile",
      fields: {
        username: "Other7",
        usernameLookupKey: "alice7",
        logins: ["other-login"],
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 6_250_000,
    randomInteger: () => 0,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-x",
    method: "x",
    methodValueRaw: "12345",
    normalizedMethodValue: "12345",
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: null,
    xUsername: "Alice7",
    opId: "stale-lookup-operation",
  });
  assert.equal(response.username, "Alice7");
});

test("finds a live username owner after multiple stale lookup rows", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "stale-profile-1",
      fields: {
        username: "Other1",
        usernameLookupKey: "alice7",
        logins: ["stale-login-1"],
      },
    },
    {
      collection: "users",
      id: "stale-profile-2",
      fields: {
        username: "Other2",
        usernameLookupKey: "alice7",
        logins: ["stale-login-2"],
      },
    },
    {
      collection: "users",
      id: "username-owner",
      fields: {
        username: "aLiCe7",
        usernameLookupKey: "alice7",
        logins: ["owner-login"],
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 6_300_000,
    randomInteger: () => 0,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-x",
    method: "x",
    methodValueRaw: "12345",
    normalizedMethodValue: "12345",
    requestEmoji: 1,
    requestAura: "",
    preferredAddress: null,
    xUsername: "Alice7",
    opId: "hidden-username-owner-operation",
  });
  assert.equal(response.username, "Aaaa000");
});

test("recovers legacy pending claim logins without an operation marker", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["login-1"],
        pendingClaimSyncLogins: ["login-1"],
      },
    },
  ]);
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 6_400_000,
  });
  assert.equal(await service.recoverPendingProfile("profile-1"), true);
  assert.equal(deps.claims.get("login-1")?.profileId, "profile-1");
  assert.equal(deps.rtdbValues.get("players/login-1/profile"), "profile-1");
  assert.equal(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields
      .pendingClaimSyncLogins,
    undefined,
  );
});

test("keeps unsafe stored UIDs pending without building RTDB paths", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["legacy/login"],
        pendingClaimSyncLogins: ["legacy/login"],
        pendingClaimSyncOpId: "legacy-claim-repair",
      },
    },
  ]);
  const deps = dependencies(memory.client);
  let externalReads = 0;
  deps.authClient.getUser = async () => {
    externalReads++;
    throw new Error("unexpected-auth-read");
  };
  deps.rtdb.getPath = async () => {
    externalReads++;
    throw new Error("unexpected-rtdb-read");
  };
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 6_450_000,
  });
  assert.equal(await service.recoverPendingProfile("profile-1"), false);
  assert.equal(externalReads, 0);
  assert.deepEqual(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields
      .pendingClaimSyncLogins,
    ["legacy/login"],
  );
});

test("recovers a legacy marker-only game merge without a backlog", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: {
        logins: [],
        pendingMergeGameCopySourceProfileId: "source-profile",
      },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: {
        logins: [],
        mergedIntoProfileId: "target-profile",
        mergeSourceRetainedForGameCopy: true,
      },
    },
    {
      collection: "profileMergeTargets",
      id: "source-profile",
      fields: { targetProfileId: "target-profile" },
    },
  ]);
  const sourceGameName = `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/users/source-profile/games/invite-legacy`;
  memory.documents.set(sourceGameName, {
    id: "invite-legacy",
    name: sourceGameName,
    fields: { listSortAt: 10, status: "ended" },
    rawFields: encodeFields({ listSortAt: 10, status: "ended" }),
    updateTime: "2026-08-22T00:00:00Z",
  });
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 6_500_000,
  });

  assert.equal(await service.recoverPendingProfile("target-profile"), true);
  assert.equal(memory.documents.has(sourceGameName), false);
  assert.equal(
    memory.documents.get(
      `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/users/target-profile/games/invite-legacy`,
    )?.fields.status,
    "ended",
  );
  assert.equal(
    memory.documents.has(authDocumentName("users", "source-profile")),
    false,
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
    undefined,
  );
});

test("resumes a pending game merge during profile recovery", async () => {
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "target-profile",
      fields: {
        logins: ["login-1"],
        sol,
        pendingMergeGameCopySourceProfileId: "source-profile",
        pendingMergeGameCopyOpId: "original-operation",
      },
    },
    {
      collection: "users",
      id: "source-profile",
      fields: { logins: [] },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("sol", sol),
      fields: {
        profileId: "target-profile",
        method: "sol",
        normalizedValue: sol,
      },
    },
    {
      collection: "authMergeGameBacklog",
      id: "original-operation",
      fields: {
        opId: "original-operation",
        sourceProfileId: "source-profile",
        targetProfileId: "target-profile",
        status: "pending",
        createdAtMs: 6_400_000,
        updatedAtMs: 6_400_000,
      },
    },
  ]);
  const sourceGameName = `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/users/source-profile/games/invite-1`;
  memory.documents.set(sourceGameName, {
    id: "invite-1",
    name: sourceGameName,
    fields: { listSortAt: 10, status: "ended" },
    rawFields: encodeFields({ listSortAt: 10, status: "ended" }),
    updateTime: "2026-08-22T00:00:00Z",
  });
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 6_500_000,
  });
  assert.equal(await service.recoverPendingProfile("target-profile"), true);
  assert.equal(memory.documents.has(sourceGameName), false);
  assert.equal(
    memory.documents.get(
      `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/users/target-profile/games/invite-1`,
    )?.fields.status,
    "ended",
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "target-profile"))?.fields
      .pendingMergeGameCopySourceProfileId,
    undefined,
  );
  assert.equal(
    memory.documents.has(
      authDocumentName("authMergeGameBacklog", "original-operation"),
    ),
    false,
  );
});

test("normalizes every supported method in the in-memory test boundary", () => {
  const methods: AuthMethodKey[] = ["eth", "sol", "apple", "x"];
  assert.deepEqual(methods, ["eth", "sol", "apple", "x"]);
});
