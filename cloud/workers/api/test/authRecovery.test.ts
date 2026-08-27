import assert from "node:assert/strict";
import test from "node:test";
import { getEventPrizeDefinition } from "@mons/shared/event-prizes";
import {
  AUTH_FIRESTORE_DATABASE_ROOT,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestoreTransaction,
  type AuthFirestoreWrite,
  authDocumentName,
  encodeFields,
} from "../src/authFirestore.ts";
import {
  AUTH_RECOVERY_JOBS_COLLECTION,
  authRecoveryJobName,
  createAuthRecoveryService,
  enqueueAuthRecovery,
  ensureFirebaseProfileClaim,
  handleAuthRecoveryMessage,
  newAuthRecoveryJob,
  parseAuthRecoveryJob,
  parseTask,
  sweepAuthRecoveryJobs,
} from "../src/authRecovery.ts";
import type { FirebaseAuthAdminClient } from "../src/firebaseAuthAdmin.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decode(value: unknown): unknown {
  const field = record(value);
  if (Object.hasOwn(field, "nullValue")) return null;
  if (typeof field.stringValue === "string") return field.stringValue;
  if (typeof field.booleanValue === "boolean") return field.booleanValue;
  if (field.integerValue !== undefined) return Number(field.integerValue);
  if (typeof field.doubleValue === "number") return field.doubleValue;
  const array = record(field.arrayValue);
  if (Array.isArray(array.values)) return array.values.map(decode);
  const map = record(field.mapValue);
  if (map.fields) return decodeFields(record(map.fields));
  return null;
}

function decodeFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decode(value)]),
  );
}

function document(
  collection: string,
  id: string,
  fields: Record<string, unknown>,
): AuthFirestoreDocument {
  const name = authDocumentName(collection, id);
  return {
    id,
    name,
    fields: structuredClone(fields),
    rawFields: encodeFields(fields),
    updateTime: "2026-08-23T00:00:00Z",
  };
}

function memoryFirestore(seed: AuthFirestoreDocument[]) {
  const documents = new Map(seed.map((entry) => [entry.name, entry]));
  const commitBatches: AuthFirestoreWrite[][] = [];
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
        if (Object.hasOwn(incoming, path)) fields[path] = incoming[path];
        else delete fields[path];
      }
      const id = write.update.name.split("/").at(-1) || "";
      documents.set(write.update.name, {
        id,
        name: write.update.name,
        fields,
        rawFields: encodeFields(fields),
        updateTime: "2026-08-23T00:00:01Z",
      });
    }
  };
  const client: AuthFirestoreClient = {
    batchGet,
    commitWrites: async (writes) => {
      commitBatches.push(writes);
      apply(writes);
    },
    createDocumentId: () => "generated",
    get: async (name) => documents.get(name) || null,
    listPage: async (parent, collectionId) => {
      const relativePrefix = parent
        ? `${parent}/${collectionId}/`
        : `${collectionId}/`;
      const prefix = `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/${relativePrefix}`;
      return {
        documents: Array.from(documents.values()).filter((entry) => {
          if (!entry.name.startsWith(prefix)) return false;
          return entry.name.slice(prefix.length).split("/").length === 1;
        }),
        nextPageToken: "",
      };
    },
    query: async () => [],
    runTransaction: async <T>(
      work: (
        transaction: AuthFirestoreTransaction,
      ) => Promise<{ result: T; writes: AuthFirestoreWrite[] }>,
    ) => {
      const operation = await work({ batchGet, query: async () => [] });
      apply(operation.writes);
      return operation.result;
    },
  };
  return { client, commitBatches, documents };
}

function externalDependencies(firestore: AuthFirestoreClient) {
  const claims = new Map<string, Record<string, unknown>>();
  const values = new Map<string, unknown>();
  const reads: string[] = [];
  const queries: Array<{ path: string; query: unknown }> = [];
  const authClient: FirebaseAuthAdminClient = {
    getUser: async (uid) => {
      reads.push(`auth:${uid}`);
      return { uid, customClaims: claims.get(uid) || {} };
    },
    setCustomUserClaims: async (uid, customClaims) => {
      claims.set(uid, customClaims);
    },
  };
  const rtdb: FirebaseRtdbClient = {
    getPath: async (path, query) => {
      reads.push(`rtdb:${path}`);
      queries.push({ path, query });
      return values.get(path) ?? null;
    },
    patchRoot: async (updates) => {
      for (const [path, value] of Object.entries(updates)) {
        values.set(path, value);
      }
    },
    transactPath: async (path, updater) => {
      const current = values.get(path) ?? null;
      const decision = record(updater(current));
      if (decision.commit === false) {
        return { committed: false, value: current };
      }
      values.set(path, decision.value);
      return { committed: true, value: decision.value };
    },
  };
  return { authClient, claims, firestore, queries, reads, rtdb, values };
}

function queueMessage(body: unknown) {
  let acknowledgements = 0;
  const retries: QueueRetryOptions[] = [];
  return {
    message: {
      id: "auth-recovery-message",
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: () => acknowledgements++,
      retry: (options?: QueueRetryOptions) => retries.push(options || {}),
    } satisfies Message<unknown>,
    acknowledgements: () => acknowledgements,
    retries,
  };
}

test("enqueues and strictly parses the exact recovery task", async () => {
  const tasks: Array<{ body: unknown; options: unknown }> = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    AUTH_RECOVERY_QUEUE: {
      ...TELEGRAM_TEST_ENV.AUTH_RECOVERY_QUEUE,
      send: async (body: unknown, options?: QueueSendOptions) => {
        tasks.push({ body, options });
        return {
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        };
      },
    },
  } as Env;
  await enqueueAuthRecovery(env, "profile-1");
  assert.deepEqual(tasks, [
    {
      body: { kind: "auth-profile-recovery", profileId: "profile-1" },
      options: { delaySeconds: 60 },
    },
  ]);
  assert.deepEqual(parseTask(tasks[0].body), tasks[0].body);
  assert.equal(
    parseTask({ kind: "auth-profile-recovery", profileId: " profile-1 " }),
    null,
  );
  assert.equal(
    parseTask({ kind: "auth-profile-recovery", profileId: "profile/1" }),
    null,
  );
});

test("acknowledges completed and invalid tasks and retries failures", async () => {
  const completed = queueMessage({
    kind: "auth-profile-recovery",
    profileId: "profile-1",
  });
  const invalid = queueMessage({ nope: true });
  const incomplete = queueMessage({
    kind: "auth-profile-recovery",
    profileId: "profile-1",
  });
  await handleAuthRecoveryMessage(
    completed.message,
    TELEGRAM_TEST_ENV as Env,
    async () => true,
  );
  await handleAuthRecoveryMessage(
    invalid.message,
    TELEGRAM_TEST_ENV as Env,
    async () => false,
  );
  await handleAuthRecoveryMessage(
    incomplete.message,
    TELEGRAM_TEST_ENV as Env,
    async () => false,
  );
  assert.equal(completed.acknowledgements(), 1);
  assert.equal(invalid.acknowledgements(), 1);
  assert.deepEqual(incomplete.retries, [{ delaySeconds: 60 }]);
});

test("keeps stored login UIDs byte-exact in recovery jobs", () => {
  const fields = newAuthRecoveryJob(
    "profile-1",
    [" login-1 ", "login-1", " login-1 "],
    ["source-2", "source-1", "source-2"],
    100,
  );
  const parsed = parseAuthRecoveryJob(
    document(AUTH_RECOVERY_JOBS_COLLECTION, "profile-1", fields),
  );
  assert.deepEqual(parsed?.loginUids, [" login-1 ", "login-1"]);
  assert.deepEqual(parsed?.sourceProfileIds, ["source-2", "source-1"]);
});

test("repairs canonical UIDs and leaves malformed legacy UIDs internal", async () => {
  const job = newAuthRecoveryJob(
    "profile-1",
    ["legacy/login", "login-1"],
    [],
    100,
  );
  const memory = memoryFirestore([
    document(AUTH_RECOVERY_JOBS_COLLECTION, "profile-1", job),
  ]);
  const external = externalDependencies(memory.client);
  const recovery = createAuthRecoveryService(TELEGRAM_TEST_ENV as Env, {
    ...external,
    now: () => 200,
  });
  assert.equal(await recovery.recoverProfile("profile-1"), false);
  assert.equal(external.claims.get("login-1")?.profileId, "profile-1");
  assert.equal(external.values.get("players/login-1/profile"), "profile-1");
  assert.equal(
    external.reads.some((value) => value.includes("legacy/login")),
    false,
  );
  assert.deepEqual(
    memory.documents.get(authRecoveryJobName("profile-1"))?.fields.loginUids,
    ["legacy/login"],
  );
});

test("profile claim changes persist a recoverable link marker before enqueue", async () => {
  const external = externalDependencies(memoryFirestore([]).client);
  external.values.set("players/login-1/profile", "source-profile");
  external.values.set("profileGameProjectionOutbox/profile/login-1", {
    schemaVersion: 1,
    status: "pending",
    requestId: "older-request",
    profileId: "middle-profile",
    cleanupProfileIds: { "older-profile": true },
    matchCursor: null,
    sourceUpdatedAtMs: 50,
    lastQueuedAtMs: 50,
  });
  const tasks: unknown[] = [];
  const logs: string[] = [];
  await ensureFirebaseProfileClaim("login-1", "target-profile", {
    authClient: external.authClient,
    createRequestId: () => "profile-request",
    enqueueProfileLinkProjection: async (task) => {
      tasks.push(task);
      throw new Error("queue-unavailable");
    },
    logger: { error: (message) => logs.push(String(message)) },
    now: () => 100,
    rtdb: external.rtdb,
  });
  assert.equal(
    external.values.get("players/login-1/profile"),
    "target-profile",
  );
  assert.deepEqual(
    external.values.get("profileGameProjectionOutbox/profile/login-1"),
    {
      schemaVersion: 1,
      status: "pending",
      requestId: "profile-request",
      profileId: "target-profile",
      cleanupProfileIds: {
        "older-profile": true,
        "source-profile": true,
      },
      matchCursor: null,
      sourceUpdatedAtMs: 100,
      lastQueuedAtMs: 100,
    },
  );
  assert.deepEqual(tasks, [
    {
      kind: "profile-link-profile-game-projection",
      loginUid: "login-1",
      requestId: "profile-request",
    },
  ]);
  assert.equal(logs.length, 1);
});

test("copies prize assignments in bounded lexical pages", async () => {
  const job = newAuthRecoveryJob("target-profile", [], ["source-profile"], 100);
  const memory = memoryFirestore([
    document(AUTH_RECOVERY_JOBS_COLLECTION, "target-profile", job),
  ]);
  const external = externalDependencies(memory.client);
  external.values.set(
    "profileEventPrizes/source-profile",
    Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => {
        const eventId = `event-${String(index).padStart(2, "0")}`;
        return [
          eventId,
          {
            eventId,
            profileId: "source-profile",
            place: 1,
            prizeId: `prize-${index}`,
            assignedAtMs: index,
          },
        ];
      }),
    ),
  );
  const recovery = createAuthRecoveryService(TELEGRAM_TEST_ENV as Env, {
    ...external,
    buildPrizeCopy: (_source, target, eventId, value) => ({
      ...record(value),
      eventId,
      profileId: target,
    }),
    now: () => 200,
  });
  assert.equal(await recovery.recoverProfile("target-profile"), false);
  const first = memory.documents.get(authRecoveryJobName("target-profile"));
  assert.equal(first?.fields.sourcePhase, "prizes");
  assert.equal(first?.fields.prizeCursor, "event-19");
  assert.equal(await recovery.recoverProfile("target-profile"), false);
  const second = memory.documents.get(authRecoveryJobName("target-profile"));
  assert.equal(second?.fields.sourcePhase, "games");
  assert.equal(second?.fields.prizeCursor, "event-20");
  assert.deepEqual(
    external.queries.filter(({ path }) =>
      path.startsWith("profileEventPrizes/source-profile"),
    ),
    [
      {
        path: "profileEventPrizes/source-profile",
        query: { orderBy: "$key", limitToFirst: 21 },
      },
      {
        path: "profileEventPrizes/source-profile",
        query: {
          orderBy: "$key",
          startAt: "event-19",
          limitToFirst: 22,
        },
      },
    ],
  );
});

test("keeps a distinct target prize and blocks source finalization", async () => {
  const job = newAuthRecoveryJob("target-profile", [], ["source-profile"], 100);
  const memory = memoryFirestore([
    document(AUTH_RECOVERY_JOBS_COLLECTION, "target-profile", job),
  ]);
  const external = externalDependencies(memory.client);
  external.values.set("profileEventPrizes/source-profile", {
    "event-1": {
      eventId: "event-1",
      profileId: "source-profile",
      place: 1,
      prizeId: "source-prize",
      assignedAtMs: 1,
    },
  });
  external.values.set("profileEventPrizes/target-profile/event-1", {
    eventId: "event-1",
    profileId: "target-profile",
    place: 2,
    prizeId: "target-prize",
    assignedAtMs: 2,
  });
  const logs: string[] = [];
  const recovery = createAuthRecoveryService(TELEGRAM_TEST_ENV as Env, {
    ...external,
    buildPrizeCopy: (_source, target, eventId, value) => ({
      ...record(value),
      eventId,
      profileId: target,
    }),
    logger: { error: (value) => logs.push(String(value)), info: () => {} },
    now: () => 200,
  });
  assert.equal(await recovery.recoverProfile("target-profile"), false);
  assert.equal(
    memory.documents.get(authRecoveryJobName("target-profile"))?.fields
      .sourcePhase,
    "prizes",
  );
  assert.equal(
    record(external.values.get("profileEventPrizes/target-profile/event-1"))
      .prizeId,
    "target-prize",
  );
  assert.equal(
    logs.some((value) => value.includes("prize_conflict")),
    true,
  );
});

test("does not copy an already withdrawn source prize", async () => {
  const eventId = "FRkdorMWaYW";
  const prizeId = "1866";
  const definition = getEventPrizeDefinition(eventId, prizeId);
  assert.ok(definition);
  const job = newAuthRecoveryJob("target-profile", [], ["source-profile"], 100);
  const memory = memoryFirestore([
    document(AUTH_RECOVERY_JOBS_COLLECTION, "target-profile", job),
  ]);
  const external = externalDependencies(memory.client);
  external.values.set("profileEventPrizes/source-profile", {
    [eventId]: {
      eventId,
      profileId: "source-profile",
      place: 1,
      prizeId,
      assignedAtMs: 1,
    },
  });
  external.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    status: "completed",
    eventId,
    prizeId,
    assetAddress: definition.assetAddress,
    assetStandard: definition.standard,
  });
  const recovery = createAuthRecoveryService(TELEGRAM_TEST_ENV as Env, {
    ...external,
    now: () => 200,
  });

  assert.equal(await recovery.recoverProfile("target-profile"), false);
  assert.equal(
    external.values.has(`profileEventPrizes/target-profile/${eventId}`),
    false,
  );
  assert.equal(
    memory.documents.get(authRecoveryJobName("target-profile"))?.fields
      .sourcePhase,
    "games",
  );
});

test("finalizes a source whose merge target resolves through a chain", async () => {
  let nowMs = 100_000;
  const job = {
    ...newAuthRecoveryJob("target-profile", [], ["source-a"], 0),
    sourcePhase: "finalize" as const,
  };
  const source = document("users", "source-a", {
    logins: [],
    mergedIntoProfileId: "source-b",
  });
  const memory = memoryFirestore([
    document(AUTH_RECOVERY_JOBS_COLLECTION, "target-profile", job),
    source,
    document("users", "target-profile", { logins: [] }),
    document("profileMergeTargets", "source-a", {
      targetProfileId: "source-b",
    }),
    document("profileMergeTargets", "source-b", {
      targetProfileId: "target-profile",
    }),
  ]);
  const recovery = createAuthRecoveryService(TELEGRAM_TEST_ENV as Env, {
    ...externalDependencies(memory.client),
    now: () => nowMs,
  });
  assert.equal(await recovery.recoverProfile("target-profile"), false);
  assert.equal(memory.documents.has(source.name), false);
  assert.deepEqual(
    memory.documents.get(authRecoveryJobName("target-profile"))?.fields
      .sourceProfileIds,
    ["source-a"],
  );
  nowMs += 60_000;
  assert.equal(await recovery.recoverProfile("target-profile"), false);
  assert.equal(await recovery.recoverProfile("target-profile"), false);
  nowMs += 60_000;
  assert.equal(await recovery.recoverProfile("target-profile"), true);
});

test("sweeps only jobs whose last enqueue is older than two hours", async () => {
  const nowMs = 8_000_000;
  const oldJob = {
    ...newAuthRecoveryJob("old-profile", [], [], 1),
    lastEnqueuedAtMs: 1,
  };
  const freshJob = {
    ...newAuthRecoveryJob("fresh-profile", [], [], nowMs),
    lastEnqueuedAtMs: nowMs - 1_000,
  };
  const memory = memoryFirestore([
    document(AUTH_RECOVERY_JOBS_COLLECTION, "old-profile", oldJob),
    document(AUTH_RECOVERY_JOBS_COLLECTION, "fresh-profile", freshJob),
  ]);
  const tasks: unknown[] = [];
  const env = {
    ...TELEGRAM_TEST_ENV,
    AUTH_RECOVERY_QUEUE: {
      ...TELEGRAM_TEST_ENV.AUTH_RECOVERY_QUEUE,
      send: async (body: unknown) => {
        tasks.push(body);
        return {
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        };
      },
    },
  } as Env;
  assert.equal(
    await sweepAuthRecoveryJobs(env, {
      firestore: memory.client,
      now: () => nowMs,
    }),
    1,
  );
  assert.deepEqual(tasks, [
    { kind: "auth-profile-recovery", profileId: "old-profile" },
  ]);
  assert.equal(
    memory.documents.get(authRecoveryJobName("old-profile"))?.fields
      .lastEnqueuedAtMs,
    nowMs,
  );
});

test("missing recovery jobs are already complete", async () => {
  const memory = memoryFirestore([]);
  const recovery = createAuthRecoveryService(TELEGRAM_TEST_ENV as Env, {
    ...externalDependencies(memory.client),
  });
  assert.equal(await recovery.recoverProfile("missing-profile"), true);
  assert.equal(await recovery.recoverProfile("missing-profile"), true);
});

test("keeps an empty caller job as a short merge barrier", async () => {
  let nowMs = 100;
  const job = newAuthRecoveryJob("profile-1", [], [], nowMs);
  const memory = memoryFirestore([
    document(AUTH_RECOVERY_JOBS_COLLECTION, "profile-1", job),
  ]);
  const recovery = createAuthRecoveryService(TELEGRAM_TEST_ENV as Env, {
    ...externalDependencies(memory.client),
    now: () => nowMs,
  });
  assert.equal(await recovery.recoverProfile("profile-1"), false);
  assert.equal(memory.documents.has(authRecoveryJobName("profile-1")), true);
  nowMs += 60_000;
  assert.equal(await recovery.recoverProfile("profile-1"), true);
  assert.equal(memory.documents.has(authRecoveryJobName("profile-1")), false);
});

test("does not delete work added while an empty job is expiring", async () => {
  let nowMs = 60_100;
  const name = authRecoveryJobName("profile-1");
  const memory = memoryFirestore([
    document(
      AUTH_RECOVERY_JOBS_COLLECTION,
      "profile-1",
      newAuthRecoveryJob("profile-1", [], [], 0),
    ),
  ]);
  const runTransaction = memory.client.runTransaction;
  let injected = false;
  memory.client.runTransaction = (work) => {
    if (!injected) {
      injected = true;
      const job = memory.documents.get(name);
      if (job) {
        job.fields.loginUids = ["late/login"];
        job.fields.updatedAtMs = nowMs;
        job.rawFields = encodeFields(job.fields);
      }
    }
    return runTransaction(work);
  };
  const recovery = createAuthRecoveryService(TELEGRAM_TEST_ENV as Env, {
    ...externalDependencies(memory.client),
    now: () => nowMs,
  });

  assert.equal(await recovery.recoverProfile("profile-1"), false);
  assert.deepEqual(memory.documents.get(name)?.fields.loginUids, [
    "late/login",
  ]);

  const job = memory.documents.get(name);
  assert.ok(job);
  job.fields.loginUids = [];
  job.fields.updatedAtMs = nowMs;
  job.rawFields = encodeFields(job.fields);
  nowMs += 60_000;
  assert.equal(await recovery.recoverProfile("profile-1"), true);
});
