import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_FIRESTORE_DATABASE_ROOT,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestoreWrite,
  authFieldFilter,
  encodeFields,
} from "../src/authFirestore.ts";
import {
  AUTH_RECOVERY_DLQ_NAME,
  enqueueAuthRecovery,
  handleAuthRecoveryMessage,
  parseTask,
  sweepLegacyAuthClaimBacklogs,
  sweepLegacyAuthGameBacklogs,
} from "../src/authRecovery.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function firestoreDocument(
  collection: string,
  id: string,
  fields: Record<string, unknown>,
): AuthFirestoreDocument {
  return {
    id,
    name: `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/${collection}/${id}`,
    fields,
    rawFields: encodeFields(fields),
    updateTime: "2026-08-23T00:00:00Z",
  };
}

function decodeFirestoreValue(value: Record<string, unknown>): unknown {
  if (Object.hasOwn(value, "nullValue")) {
    return null;
  }
  if (typeof value.stringValue === "string") {
    return value.stringValue;
  }
  if (
    typeof value.integerValue === "string" ||
    typeof value.integerValue === "number"
  ) {
    return Number(value.integerValue);
  }
  const array = value.arrayValue as
    { values?: Array<Record<string, unknown>> } | undefined;
  if (array) {
    return (array.values || []).map(decodeFirestoreValue);
  }
  throw new TypeError("unsupported-test-firestore-value");
}

function applyWrites(
  documents: Map<string, AuthFirestoreDocument>,
  writes: AuthFirestoreWrite[],
): void {
  for (const write of writes) {
    if ("delete" in write) {
      documents.delete(write.delete);
      continue;
    }
    let document = documents.get(write.update.name);
    if (!document) {
      document = {
        id: write.update.name.split("/").pop() || "",
        name: write.update.name,
        fields: {},
        rawFields: {},
        updateTime: "2026-08-23T00:00:00Z",
      };
      documents.set(document.name, document);
    }
    for (const fieldPath of write.updateMask.fieldPaths) {
      const value = write.update.fields[fieldPath];
      if (value) {
        document.fields[fieldPath] = decodeFirestoreValue(value);
      } else {
        delete document.fields[fieldPath];
      }
    }
    document.rawFields = encodeFields(document.fields);
  }
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
      ack: () => {
        acknowledgements++;
      },
      retry: (options?: QueueRetryOptions) => {
        retries.push(options || {});
      },
    } satisfies Message<unknown>,
    acknowledgements: () => acknowledgements,
    retries,
  };
}

function legacyGameBacklogFixture(targetFields: Record<string, unknown> = {}) {
  const backlog = firestoreDocument(
    "authMergeGameBacklog",
    "legacy-game-operation:copy",
    {
      status: "pending",
      opId: "legacy-game-operation",
      targetProfileId: "target-profile",
      sourceProfileId: "source-profile",
      stage: "copy",
    },
  );
  const target = firestoreDocument("users", "target-profile", {
    logins: ["login-1"],
    mergedSourceProfileId: "source-profile",
    ...targetFields,
  });
  const source = firestoreDocument("users", "source-profile", {
    logins: [],
    mergedIntoProfileId: "target-profile",
    mergeSourceRetainedForGameCopy: true,
    pendingClaimSyncLogins: ["login-2"],
    pendingClaimSyncOpId: "retired-source-claim-repair",
    pendingClaimSyncUpdatedAtMs: 123,
  });
  const mergeTarget = firestoreDocument(
    "profileMergeTargets",
    "source-profile",
    {
      sourceProfileId: "source-profile",
      targetProfileId: "target-profile",
    },
  );
  return {
    backlog,
    source,
    target,
    documents: new Map([
      [backlog.name, backlog],
      [target.name, target],
      [source.name, source],
      [mergeTarget.name, mergeTarget],
    ]),
  };
}

function legacyGameSweepFirestore(
  documents: Map<string, AuthFirestoreDocument>,
  candidates: AuthFirestoreDocument[],
): Pick<AuthFirestoreClient, "query" | "runTransaction"> {
  return {
    query: async (
      collectionId,
      where,
      limit,
      fieldPaths,
      startAfterDocumentId,
    ) => {
      assert.equal(collectionId, "authMergeGameBacklog");
      assert.deepEqual(where, authFieldFilter("status", "EQUAL", "pending"));
      assert.equal(limit, 10);
      assert.deepEqual(fieldPaths, [
        "opId",
        "sourceProfileId",
        "targetProfileId",
      ]);
      assert.equal(startAfterDocumentId, "");
      return candidates;
    },
    runTransaction: async (work) => {
      const operation = await work({
        id: "transaction",
        batchGet: async (names) =>
          new Map(names.map((name) => [name, documents.get(name) || null])),
        query: async () => [],
      });
      applyWrites(documents, operation.writes);
      return operation.result;
    },
  };
}

test("enqueues the exact auth recovery task", async () => {
  assert.equal(AUTH_RECOVERY_DLQ_NAME, "mons-link-auth-recovery-dlq");
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
});

test("acknowledges completed and invalid recovery tasks", async () => {
  const completed = queueMessage({
    kind: "auth-profile-recovery",
    profileId: "profile-1",
  });
  const invalid = queueMessage({ nope: true });
  await handleAuthRecoveryMessage(
    completed.message,
    TELEGRAM_TEST_ENV as Env,
    async (profileId) => profileId === "profile-1",
  );
  await handleAuthRecoveryMessage(
    invalid.message,
    TELEGRAM_TEST_ENV as Env,
    async () => false,
  );
  assert.equal(completed.acknowledgements(), 1);
  assert.equal(invalid.acknowledgements(), 1);
  assert.deepEqual(completed.retries, []);
  assert.deepEqual(invalid.retries, []);
});

test("retries incomplete and failed recovery tasks", async () => {
  const incomplete = queueMessage({
    kind: "auth-profile-recovery",
    profileId: "profile-1",
  });
  const failed = queueMessage({
    kind: "auth-profile-recovery",
    profileId: "profile-1",
  });
  await handleAuthRecoveryMessage(
    incomplete.message,
    TELEGRAM_TEST_ENV as Env,
    async () => false,
  );
  await handleAuthRecoveryMessage(
    failed.message,
    TELEGRAM_TEST_ENV as Env,
    async () => {
      throw new Error("temporary-failure");
    },
  );
  assert.deepEqual(incomplete.retries, [{ delaySeconds: 60 }]);
  assert.deepEqual(failed.retries, [{ delaySeconds: 60 }]);
  assert.equal(incomplete.acknowledgements(), 0);
  assert.equal(failed.acknowledgements(), 0);
});

test("strictly validates auth recovery tasks", () => {
  assert.deepEqual(
    parseTask({ kind: "auth-profile-recovery", profileId: " profile-1 " }),
    { kind: "auth-profile-recovery", profileId: "profile-1" },
  );
  assert.equal(
    parseTask({
      kind: "auth-profile-recovery",
      profileId: "profile/1",
    }),
    null,
  );
});

test("sweeps legacy claim backlogs into the existing profile recovery path", async () => {
  const backlog = firestoreDocument("authClaimSyncBacklog", "legacy-op", {
    status: "pending",
    targetProfileId: "profile-1",
    failedLoginUids: ["login-2", "moved-login"],
  });
  const target = firestoreDocument("users", "profile-1", {
    logins: ["login-1", "login-2", "login-3"],
    pendingClaimSyncLogins: ["login-1"],
    pendingClaimSyncOpId: "legacy-op",
  });
  const redundantBacklog = firestoreDocument(
    "authClaimSyncBacklog",
    "redundant-op",
    {
      status: "pending",
      targetProfileId: "profile-1",
      failedLoginUids: ["login-3", "moved-login"],
    },
  );
  const missingTarget = firestoreDocument(
    "authClaimSyncBacklog",
    "missing-target-op",
    {
      status: "pending",
      targetProfileId: "missing-profile",
      failedLoginUids: ["login-3"],
    },
  );
  const invalidTarget = firestoreDocument(
    "authClaimSyncBacklog",
    "invalid-target-op",
    {
      status: "pending",
      targetProfileId: "invalid/profile",
      failedLoginUids: ["login-4"],
    },
  );
  const documents = new Map([
    [backlog.name, backlog],
    [target.name, target],
    [redundantBacklog.name, redundantBacklog],
    [missingTarget.name, missingTarget],
    [invalidTarget.name, invalidTarget],
  ]);
  const writes: AuthFirestoreWrite[] = [];
  const firestore: Pick<AuthFirestoreClient, "query" | "runTransaction"> = {
    query: async (
      collectionId,
      where,
      limit,
      fieldPaths,
      startAfterDocumentId,
    ) => {
      assert.equal(collectionId, "authClaimSyncBacklog");
      assert.deepEqual(where, authFieldFilter("status", "EQUAL", "pending"));
      assert.equal(limit, 10);
      assert.deepEqual(fieldPaths, ["targetProfileId"]);
      assert.equal(startAfterDocumentId, "");
      return [backlog, redundantBacklog, missingTarget, invalidTarget];
    },
    runTransaction: async (work) => {
      const operation = await work({
        id: "transaction",
        batchGet: async (names) =>
          new Map(names.map((name) => [name, documents.get(name) || null])),
        query: async () => [],
      });
      writes.push(...operation.writes);
      applyWrites(documents, operation.writes);
      return operation.result;
    },
  };
  const enqueued: string[] = [];
  assert.equal(
    await sweepLegacyAuthClaimBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      now: () => 123,
      enqueue: async (profileId) => {
        enqueued.push(profileId);
      },
    }),
    1,
  );
  assert.deepEqual(enqueued, ["profile-1"]);
  assert.deepEqual(documents.get(target.name)?.fields.pendingClaimSyncLogins, [
    "login-1",
    "login-2",
    "login-3",
  ]);
  assert.equal(
    documents.get(target.name)?.fields.pendingClaimSyncOpId,
    "legacy-op",
  );
  assert.equal(documents.get(backlog.name)?.fields.status, "queued");
  assert.equal(documents.has(redundantBacklog.name), false);
  assert.equal(documents.has(missingTarget.name), false);
  assert.equal(documents.has(invalidTarget.name), false);
  assert.equal(
    writes.some(
      (write) =>
        "update" in write &&
        write.update.name === backlog.name &&
        decodeFirestoreValue(write.update.fields.status) === "queued",
    ),
    true,
  );
});

test("keeps a materialized legacy backlog pending when enqueue fails", async () => {
  const backlog = firestoreDocument("authClaimSyncBacklog", "legacy-op", {
    status: "pending",
    targetProfileId: "profile-1",
    failedLoginUids: ["login-1"],
  });
  const target = firestoreDocument("users", "profile-1", {
    logins: ["login-1"],
  });
  const documents = new Map([
    [backlog.name, backlog],
    [target.name, target],
  ]);
  const firestore: Pick<AuthFirestoreClient, "query" | "runTransaction"> = {
    query: async () => [backlog],
    runTransaction: async (work) => {
      const operation = await work({
        id: "transaction",
        batchGet: async (names) =>
          new Map(names.map((name) => [name, documents.get(name) || null])),
        query: async () => [],
      });
      applyWrites(documents, operation.writes);
      return operation.result;
    },
  };
  await assert.rejects(
    sweepLegacyAuthClaimBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      now: () => 123,
      enqueue: async () => {
        throw new Error("queue-unavailable");
      },
    }),
    /queue-unavailable/,
  );
  assert.equal(documents.get(backlog.name)?.fields.status, "pending");
  assert.equal(
    documents.get(target.name)?.fields.pendingClaimSyncOpId,
    "legacy-op",
  );
});

test("materializes and queues a legacy game backlog before deleting it", async () => {
  const { backlog, source, target, documents } = legacyGameBacklogFixture();
  const firestore = legacyGameSweepFirestore(documents, [backlog]);
  const enqueued: string[] = [];
  assert.equal(
    await sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      now: () => 456,
      enqueue: async (profileId) => {
        assert.equal(documents.has(backlog.name), true);
        assert.equal(
          documents.get(target.name)?.fields
            .pendingMergeGameCopySourceProfileId,
          "source-profile",
        );
        enqueued.push(profileId);
      },
    }),
    1,
  );
  assert.deepEqual(enqueued, ["target-profile"]);
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopyOpId,
    "legacy-game-operation",
  );
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopyUpdatedAtMs,
    456,
  );
  assert.equal(documents.has(backlog.name), false);
  assert.equal(
    documents.get(source.name)?.fields.pendingClaimSyncLogins,
    undefined,
  );
  assert.equal(
    documents.get(source.name)?.fields.pendingClaimSyncOpId,
    undefined,
  );
  assert.equal(
    documents.get(source.name)?.fields.pendingClaimSyncUpdatedAtMs,
    undefined,
  );
});

test("recovers orphaned source games after the source parent was deleted", async () => {
  const { backlog, source, target, documents } = legacyGameBacklogFixture();
  documents.delete(source.name);
  const firestore = legacyGameSweepFirestore(documents, [backlog]);
  const enqueued: string[] = [];
  assert.equal(
    await sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      now: () => 456,
      enqueue: async (profileId) => {
        enqueued.push(profileId);
      },
    }),
    1,
  );
  assert.deepEqual(enqueued, ["target-profile"]);
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopySourceProfileId,
    "source-profile",
  );
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopyOpId,
    "legacy-game-operation",
  );
  assert.equal(documents.has(backlog.name), false);
});

test("materializes a legacy game backlog on the canonical merge target", async () => {
  const { backlog, documents } = legacyGameBacklogFixture();
  const intermediate = firestoreDocument("users", "target-profile", {
    logins: [],
    mergedIntoProfileId: "canonical-profile",
    mergeSourceRetainedForGameCopy: true,
  });
  const intermediateMergeTarget = firestoreDocument(
    "profileMergeTargets",
    "target-profile",
    {
      sourceProfileId: "target-profile",
      targetProfileId: "canonical-profile",
    },
  );
  const canonical = firestoreDocument("users", "canonical-profile", {
    logins: ["login-1", "login-2"],
    mergedSourceProfileId: "target-profile",
  });
  for (const document of [intermediate, intermediateMergeTarget, canonical]) {
    documents.set(document.name, document);
  }
  const firestore = legacyGameSweepFirestore(documents, [backlog]);
  const enqueued: string[] = [];
  assert.equal(
    await sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      now: () => 789,
      enqueue: async (profileId) => {
        enqueued.push(profileId);
      },
    }),
    1,
  );
  assert.deepEqual(enqueued, ["canonical-profile"]);
  assert.equal(
    documents.get(canonical.name)?.fields.pendingMergeGameCopySourceProfileId,
    "source-profile",
  );
  assert.equal(
    documents.get(canonical.name)?.fields.pendingMergeGameCopyOpId,
    "legacy-game-operation",
  );
  assert.equal(
    documents.get(intermediate.name)?.fields
      .pendingMergeGameCopySourceProfileId,
    undefined,
  );
  assert.equal(documents.has(backlog.name), false);
});

test("resolves the full supported legacy merge-target depth", async () => {
  const { backlog, documents } = legacyGameBacklogFixture();
  for (let hop = 0; hop < 32; hop++) {
    const profileId = hop === 0 ? "target-profile" : `chain-${hop}`;
    const nextProfileId = `chain-${hop + 1}`;
    const mergeTarget = firestoreDocument("profileMergeTargets", profileId, {
      sourceProfileId: profileId,
      targetProfileId: nextProfileId,
    });
    documents.set(mergeTarget.name, mergeTarget);
  }
  const canonical = firestoreDocument("users", "chain-32", {
    logins: ["login-1", "login-2"],
  });
  documents.set(canonical.name, canonical);
  const firestore = legacyGameSweepFirestore(documents, [backlog]);
  const enqueued: string[] = [];
  assert.equal(
    await sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      enqueue: async (profileId) => {
        enqueued.push(profileId);
      },
    }),
    1,
  );
  assert.deepEqual(enqueued, ["chain-32"]);
  assert.equal(
    documents.get(canonical.name)?.fields.pendingMergeGameCopySourceProfileId,
    "source-profile",
  );
  assert.equal(documents.has(backlog.name), false);
});

test("preserves a legacy game backlog when enqueue fails", async () => {
  const { backlog, target, documents } = legacyGameBacklogFixture();
  const firestore = legacyGameSweepFirestore(documents, [backlog]);
  await assert.rejects(
    sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      now: () => 456,
      enqueue: async () => {
        assert.equal(documents.has(backlog.name), true);
        throw new Error("queue-unavailable");
      },
    }),
    /queue-unavailable/,
  );
  assert.equal(documents.get(backlog.name)?.fields.status, "pending");
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopySourceProfileId,
    "source-profile",
  );
});

test("enqueues without overwriting a conflicting game-recovery marker", async () => {
  const { backlog, target, documents } = legacyGameBacklogFixture({
    pendingMergeGameCopySourceProfileId: "other-source",
    pendingMergeGameCopyOpId: "other-operation",
    pendingMergeGameCopyUpdatedAtMs: 123,
  });
  const firestore = legacyGameSweepFirestore(documents, [backlog]);
  let enqueueCalls = 0;
  assert.equal(
    await sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      now: () => 456,
      enqueue: async () => {
        enqueueCalls++;
      },
    }),
    1,
  );
  assert.equal(enqueueCalls, 1);
  assert.equal(documents.has(backlog.name), true);
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopySourceProfileId,
    "other-source",
  );
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopyOpId,
    "other-operation",
  );
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopyUpdatedAtMs,
    123,
  );
});

test("deletes terminal game backlogs without deleting a marker conflict", async () => {
  const { backlog, documents } = legacyGameBacklogFixture({
    pendingMergeGameCopySourceProfileId: "other-source",
    pendingMergeGameCopyOpId: "other-operation",
  });
  const invalid = firestoreDocument("authMergeGameBacklog", "invalid", {
    status: "pending",
    targetProfileId: "invalid/profile",
    sourceProfileId: "source-profile",
  });
  const missingSource = firestoreDocument(
    "authMergeGameBacklog",
    "missing-source",
    {
      status: "pending",
      targetProfileId: "target-profile",
      sourceProfileId: "missing-source",
    },
  );
  const staleMapping = firestoreDocument(
    "authMergeGameBacklog",
    "stale-mapping",
    {
      status: "pending",
      targetProfileId: "target-profile",
      sourceProfileId: "stale-source",
    },
  );
  const staleSource = firestoreDocument("users", "stale-source", {
    logins: [],
    mergedIntoProfileId: "target-profile",
    mergeSourceRetainedForGameCopy: true,
  });
  const staleMergeTarget = firestoreDocument(
    "profileMergeTargets",
    "stale-source",
    {
      sourceProfileId: "stale-source",
      targetProfileId: "different-target",
    },
  );
  for (const document of [
    invalid,
    missingSource,
    staleMapping,
    staleSource,
    staleMergeTarget,
  ]) {
    documents.set(document.name, document);
  }
  const firestore = legacyGameSweepFirestore(documents, [
    invalid,
    missingSource,
    staleMapping,
    backlog,
  ]);
  let enqueueCalls = 0;
  assert.equal(
    await sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      enqueue: async () => {
        enqueueCalls++;
      },
    }),
    1,
  );
  assert.equal(enqueueCalls, 1);
  assert.equal(documents.has(invalid.name), false);
  assert.equal(documents.has(missingSource.name), false);
  assert.equal(documents.has(staleMapping.name), false);
  assert.equal(documents.has(backlog.name), true);
});

test("rotates past poison rows and drains a current game outbox record", async () => {
  const { source, target, documents } = legacyGameBacklogFixture();
  for (const name of Array.from(documents.keys())) {
    if (name.includes("/authMergeGameBacklog/")) {
      documents.delete(name);
    }
  }
  const poison = firestoreDocument("authMergeGameBacklog", "a-poison", {
    status: "pending",
    opId: "poison-operation",
    targetProfileId: "target-profile",
    sourceProfileId: "source-profile",
  });
  const current = firestoreDocument(
    "authMergeGameBacklog",
    "current-game-operation",
    {
      status: "pending",
      opId: "current-game-operation",
      targetProfileId: "target-profile",
      sourceProfileId: "source-profile",
      createdAtMs: 100,
      updatedAtMs: 100,
    },
  );
  documents.set(poison.name, poison);
  documents.set(current.name, current);
  const cursorName = `${AUTH_FIRESTORE_DATABASE_ROOT}/documents/authRecoverySweepCursors/authMergeGameBacklog`;
  const queryCursors: string[] = [];
  const firestore: Pick<AuthFirestoreClient, "query" | "runTransaction"> = {
    query: async (
      collectionId,
      where,
      limit,
      fieldPaths,
      startAfterDocumentId,
    ) => {
      assert.equal(collectionId, "authMergeGameBacklog");
      assert.deepEqual(where, authFieldFilter("status", "EQUAL", "pending"));
      assert.equal(limit, 10);
      assert.deepEqual(fieldPaths, [
        "opId",
        "sourceProfileId",
        "targetProfileId",
      ]);
      queryCursors.push(startAfterDocumentId || "");
      if (!startAfterDocumentId) {
        return [poison];
      }
      return startAfterDocumentId === poison.id ? [current] : [];
    },
    runTransaction: async (work) => {
      const operation = await work({
        id: "transaction",
        batchGet: async (names) => {
          if (names.includes(poison.name)) {
            throw new Error("poison-backlog");
          }
          return new Map(
            names.map((name) => [name, documents.get(name) || null]),
          );
        },
        query: async () => [],
      });
      applyWrites(documents, operation.writes);
      return operation.result;
    },
  };
  const enqueued: string[] = [];

  await assert.rejects(
    sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      enqueue: async () => undefined,
      logger: { error: () => undefined },
    }),
    /poison-backlog/,
  );
  assert.equal(documents.get(cursorName)?.fields.afterDocumentId, poison.id);

  assert.equal(
    await sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      enqueue: async (profileId) => {
        enqueued.push(profileId);
      },
    }),
    1,
  );
  assert.deepEqual(enqueued, ["target-profile"]);
  assert.equal(documents.has(current.name), false);
  assert.equal(documents.get(cursorName)?.fields.afterDocumentId, current.id);
  assert.equal(
    documents.get(target.name)?.fields.pendingMergeGameCopySourceProfileId,
    "source-profile",
  );
  assert.equal(documents.has(source.name), true);

  assert.equal(
    await sweepLegacyAuthGameBacklogs(TELEGRAM_TEST_ENV as Env, {
      firestore,
      enqueue: async () => undefined,
    }),
    0,
  );
  assert.deepEqual(queryCursors, ["", poison.id, current.id]);
  assert.equal(documents.get(cursorName)?.fields.afterDocumentId, "");
});
