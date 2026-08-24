import assert from "node:assert/strict";
import test from "node:test";
import type { AuthMethodKey, AuthProfileResponse } from "@mons/shared/auth";
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
import {
  authRecoveryJobName,
  newAuthRecoveryJob,
} from "../src/authRecovery.ts";
import type { FirebaseAuthAdminClient } from "../src/firebaseAuthAdmin.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import {
  getMethodKey,
  hashMethodValue,
  uniqueStoredFirebaseUids,
} from "../src/authPolicy.ts";
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

test("keeps a recovery job when Queue enqueue fails", async (t) => {
  const memory = memoryFirestore([]);
  const deps = dependencies(memory.client);
  t.mock.method(console, "error", () => undefined);
  const service = createAuthIdentityService(
    {
      ...env,
      AUTH_RECOVERY_QUEUE: {
        ...env.AUTH_RECOVERY_QUEUE,
        send: async () => {
          throw new Error("queue-unavailable");
        },
      },
    } as Env,
    {
      ...deps,
      now: () => 2_000_000,
    },
  );
  const input = {
    uid: "login-1",
    method: "sol",
    methodValueRaw: "11111111111111111111111111111111",
    normalizedMethodValue: "11111111111111111111111111111111",
    intentId: "intent-sol",
    requestEmoji: 4,
    requestAura: "rainbow",
    preferredAddress: "11111111111111111111111111111111",
    opId: "intent:intent-sol",
  } as const;
  const response = await service.linkVerifiedMethod(input);
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
  assert.deepEqual(
    memory.documents.get(authRecoveryJobName("generated-1"))?.fields.loginUids,
    [],
  );
  const intentFields = {
    uid: "login-1",
    method: "sol",
    nonce: "nonce-sol",
    consumedAtMs: 1_999_999,
    consumedByOpId: input.opId,
    expiresAtMs: 1_999_999,
  };
  memory.documents.set(authDocumentName("authIntents", input.intentId), {
    id: input.intentId,
    name: authDocumentName("authIntents", input.intentId),
    fields: intentFields,
    rawFields: encodeFields(intentFields),
    updateTime: "2026-08-22T00:00:00Z",
  });
  const replayIntent = await service.readIntent(
    input.uid,
    input.method,
    input.intentId,
    input.opId,
  );
  assert.equal(
    (await service.prepareVerifiedMethod(input, replayIntent))?.profileId,
    response.profileId,
  );
});

test("rejects a successful replay with different immutable context", async () => {
  const memory = memoryFirestore([]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 2_050_000,
  });
  const input = {
    uid: "login-1",
    method: "sol" as const,
    methodValueRaw: "11111111111111111111111111111111",
    normalizedMethodValue: "11111111111111111111111111111111",
    requestEmoji: 1,
    requestAura: null,
    preferredAddress: "11111111111111111111111111111111",
    opId: "immutable-replay",
  };
  await service.linkVerifiedMethod(input);
  await assert.rejects(
    service.linkVerifiedMethod({
      ...input,
      methodValueRaw: "22222222222222222222222222222222",
      normalizedMethodValue: "22222222222222222222222222222222",
      preferredAddress: "22222222222222222222222222222222",
    }),
    (error) =>
      error instanceof Error && error.message === "op-context-mismatch",
  );
});

test("does not resume a successful verification whose live effect is gone", async () => {
  const nowMs = 2_075_000;
  const sol = "11111111111111111111111111111111";
  const opId = "stale-successful-verification";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["login-1"],
        eth: "0x1111111111111111111111111111111111111111",
      },
    },
    {
      collection: "authOps",
      id: opId,
      fields: {
        uid: "login-1",
        kind: "verify",
        method: "sol",
        status: "success",
        meta: { methodValueHash: hashMethodValue("sol", sol) },
        result: {
          ok: true,
          uid: "login-1",
          profileId: "profile-1",
          username: null,
          linkedMethods: { apple: false, eth: false, sol: true, x: false },
          appleLinked: false,
          emoji: 1,
          opId,
        },
        updatedAtMs: nowMs,
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => nowMs,
  });

  await assert.rejects(
    service.linkVerifiedMethod({
      uid: "login-1",
      method: "sol",
      methodValueRaw: sol,
      normalizedMethodValue: sol,
      requestEmoji: 1,
      requestAura: null,
      preferredAddress: sol,
      opId,
    }),
    (error) =>
      error instanceof Error && error.message === "profile-merged-retry",
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields.sol,
    undefined,
  );
  assert.equal(
    memory.documents.has(
      authDocumentName("authMethodIndex", getMethodKey("sol", sol)),
    ),
    false,
  );
  assert.equal(
    memory.documents.get(authDocumentName("authOps", opId))?.fields.status,
    "success",
  );
});

test("merges profiles into one recovery job and repairs only the caller", async () => {
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
  const tasks: unknown[] = [];
  const recoveryEnv = {
    ...env,
    AUTH_RECOVERY_QUEUE: {
      ...env.AUTH_RECOVERY_QUEUE,
      send: async (body: unknown) => {
        tasks.push(body);
        return {
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        };
      },
    },
  } as Env;
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(recoveryEnv, {
    ...deps,
    now: () => 2_100_000,
  });
  const response = await service.linkVerifiedMethod({
    uid: "login-1",
    method: "sol",
    methodValueRaw: sol,
    normalizedMethodValue: sol,
    requestEmoji: 1,
    requestAura: null,
    preferredAddress: sol,
    opId: "merge-operation",
  });
  assert.equal(response.profileId, "target-profile");
  assert.equal(deps.claims.get("login-1")?.profileId, "target-profile");
  assert.deepEqual(
    memory.documents.get(authRecoveryJobName("target-profile"))?.fields
      .loginUids,
    ["login-2"],
  );
  assert.deepEqual(
    memory.documents.get(authRecoveryJobName("target-profile"))?.fields
      .sourceProfileIds,
    ["source-profile"],
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "source-profile"))?.fields
      .mergedIntoProfileId,
    "target-profile",
  );
  assert.equal(tasks.length > 0, true);
});

test("rejects a merge while either profile has a recovery job", async () => {
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
    {
      collection: "authRecoveryJobs",
      id: "source-profile",
      fields: newAuthRecoveryJob("source-profile", ["login-2"], [], 1),
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 2_150_000,
  });
  await assert.rejects(
    service.linkVerifiedMethod({
      uid: "login-1",
      method: "sol",
      methodValueRaw: sol,
      normalizedMethodValue: sol,
      requestEmoji: 1,
      requestAura: null,
      preferredAddress: sol,
      opId: "blocked-merge",
    }),
    (error) =>
      error instanceof Error && error.message === "merge-recovery-pending",
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
    {
      collection: "authOps",
      id: "x-redirect:flow-1",
      fields: {
        uid: "login-1",
        kind: "verify",
        method: "x",
        status: "success",
        meta: { methodValueHash: hashMethodValue("x", "12345") },
        updatedAtMs: 2_600_000,
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

test("rebuilds a successful replay from the live canonical profile", async () => {
  const staleResult: AuthProfileResponse = {
    ok: true,
    uid: "login-1",
    profileId: "retired-profile",
    username: "Retired",
    linkedMethods: { apple: false, eth: false, sol: false, x: true },
    appleLinked: false,
    emoji: 1,
    opId: "canonical-replay",
  };
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "canonical-profile",
      fields: {
        logins: ["login-1"],
        xUserId: "12345",
        username: "Canonical",
        custom: { emoji: 2 },
      },
    },
    {
      collection: "authOps",
      id: "canonical-replay",
      fields: {
        uid: "login-1",
        kind: "verify",
        method: "x",
        status: "success",
        meta: { methodValueHash: hashMethodValue("x", "12345") },
        result: staleResult,
        updatedAtMs: 2_650_000,
      },
    },
  ]);
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 2_650_000,
  });
  const replay = await service.peekVerifyReplay(
    "canonical-replay",
    "x",
    "login-1",
  );
  assert.equal(replay?.profileId, "canonical-profile");
  assert.equal(replay?.username, "Canonical");
  assert.equal(replay?.emoji, 2);
  assert.equal(deps.claims.get("login-1")?.profileId, "canonical-profile");
  assert.deepEqual(
    memory.documents.get(authRecoveryJobName("canonical-profile"))?.fields
      .loginUids,
    [],
  );
});

test("synchronizes the current caller through the recovery barrier", async () => {
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "canonical-profile",
      fields: {
        logins: ["login-1"],
        appleSub: "apple-subject",
        sol: "11111111111111111111111111111111",
      },
    },
  ]);
  const deps = dependencies(memory.client);
  deps.claims.set("login-1", { admin: true, profileId: "retired-profile" });
  deps.rtdbValues.set("players/login-1/profile", "retired-profile");
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => 2_700_000,
  });

  const result = await service.syncCurrentCallerProfile("login-1");

  assert.equal(result.profileId, "canonical-profile");
  assert.deepEqual(result.linkedMethods, {
    apple: true,
    eth: false,
    sol: true,
    x: false,
  });
  assert.deepEqual(deps.claims.get("login-1"), {
    admin: true,
    profileId: "canonical-profile",
  });
  assert.equal(
    deps.rtdbValues.get("players/login-1/profile"),
    "canonical-profile",
  );
  assert.deepEqual(
    memory.documents.get(authRecoveryJobName("canonical-profile"))?.fields
      .loginUids,
    [],
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
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(env, {
    ...deps,
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
  assert.deepEqual(
    memory.documents.get(authRecoveryJobName("profile-1"))?.fields.loginUids,
    [],
  );
  assert.equal(deps.claims.get("login-1")?.profileId, "profile-1");
});

test("retries unlinking on the canonical profile after a merge", async () => {
  const eth = "0x1111111111111111111111111111111111111111";
  const sol = "11111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "source-profile",
      fields: { logins: ["login-1"], eth, sol },
    },
    {
      collection: "users",
      id: "target-profile",
      fields: { logins: [], eth, sol },
    },
    {
      collection: "authMethodIndex",
      id: getMethodKey("eth", eth),
      fields: { profileId: "source-profile", method: "eth" },
    },
  ]);
  const runTransaction = memory.client.runTransaction;
  let merged = false;
  memory.client.runTransaction = (work) => {
    if (!merged) {
      merged = true;
      const source = memory.documents.get(
        authDocumentName("users", "source-profile"),
      );
      const target = memory.documents.get(
        authDocumentName("users", "target-profile"),
      );
      const index = memory.documents.get(
        authDocumentName("authMethodIndex", getMethodKey("eth", eth)),
      );
      assert.ok(source);
      assert.ok(target);
      assert.ok(index);
      source.fields = {
        logins: [],
        mergedIntoProfileId: "target-profile",
      };
      target.fields.logins = ["login-1"];
      index.fields.profileId = "target-profile";
    }
    return runTransaction(work);
  };
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => 3_100_000,
  });

  const response = await service.unlinkMethod(
    "login-1",
    "eth",
    "unlink-after-merge",
  );

  assert.equal(response.profileId, "target-profile");
  assert.deepEqual(response.linkedMethods, {
    apple: false,
    eth: false,
    sol: true,
    x: false,
  });
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

test("rebuilds an unlink replay from the live canonical profile", async () => {
  const nowMs = 3_600_000;
  const opId = "canonical-unlink-replay";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "canonical-profile",
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
        status: "success",
        result: {
          ok: true,
          profileId: "retired-profile",
          linkedMethods: { apple: false, eth: false, sol: false, x: true },
          appleLinked: false,
        },
        updatedAtMs: nowMs,
      },
    },
    {
      collection: "authRecoveryJobs",
      id: "canonical-profile",
      fields: newAuthRecoveryJob("canonical-profile", ["login-1"], [], nowMs),
    },
  ]);
  const deps = dependencies(memory.client);
  const service = createAuthIdentityService(env, {
    ...deps,
    now: () => nowMs,
  });

  const replay = await service.unlinkMethod("login-1", "eth", opId);

  assert.equal(replay.profileId, "canonical-profile");
  assert.deepEqual(replay.linkedMethods, {
    apple: false,
    eth: false,
    sol: true,
    x: false,
  });
  assert.equal(deps.claims.get("login-1")?.profileId, "canonical-profile");
  assert.equal(
    deps.rtdbValues.get("players/login-1/profile"),
    "canonical-profile",
  );
});

test("does not resume a successful unlink whose live effect is gone", async () => {
  const nowMs = 3_700_000;
  const opId = "stale-successful-unlink";
  const eth = "0x1111111111111111111111111111111111111111";
  const memory = memoryFirestore([
    {
      collection: "users",
      id: "profile-1",
      fields: {
        logins: ["login-1"],
        eth,
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
        status: "success",
        result: {
          ok: true,
          profileId: "profile-1",
          linkedMethods: { apple: false, eth: false, sol: true, x: false },
          appleLinked: false,
        },
        updatedAtMs: nowMs,
      },
    },
  ]);
  const service = createAuthIdentityService(env, {
    ...dependencies(memory.client),
    now: () => nowMs,
  });

  await assert.rejects(
    service.unlinkMethod("login-1", "eth", opId),
    (error) =>
      error instanceof Error && error.message === "profile-merged-retry",
  );
  assert.equal(
    memory.documents.get(authDocumentName("users", "profile-1"))?.fields.eth,
    eth,
  );
  assert.equal(
    memory.documents.has(
      authDocumentName("authMethodRevocations", getMethodKey("eth", eth)),
    ),
    false,
  );
  assert.equal(
    memory.documents.has(
      authDocumentName("authProfileMethodCooldowns", "profile-1:eth"),
    ),
    false,
  );
  assert.equal(
    memory.documents.get(authDocumentName("authOps", opId))?.fields.status,
    "success",
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

test("normalizes every supported method in the in-memory test boundary", () => {
  const methods: AuthMethodKey[] = ["eth", "sol", "apple", "x"];
  assert.deepEqual(methods, ["eth", "sol", "apple", "x"]);
});
