import assert from "node:assert/strict";
import test from "node:test";
import {
  authDocumentName,
  type AuthFirestoreClient,
  type AuthFirestoreDocument,
  type AuthFirestorePage,
} from "../src/authFirestore.ts";
import {
  enqueueProfileReadProjection,
  handleProfileReadProjectionMessage,
  handleProfileReadProjectionQueue,
  processProfileReadProjectionTask,
  reconcileProfileReadProjections,
} from "../src/profileReadProjection.ts";
import { PROFILE_PROJECTION_SCHEMA_VERSION } from "../src/profileProjectionModel.ts";
import {
  parseProfileReadProjectionTask,
  PROFILE_READ_PROJECTION_QUEUE_NAME,
} from "../src/profileReadProjectionTasks.ts";
import worker from "../src/workerHandler.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const D1_META = {
  changed_db: false,
  changes: 0,
  duration: 0,
  last_row_id: 0,
  rows_read: 0,
  rows_written: 0,
  size_after: 0,
};

type ReconciliationRow = {
  is_deleted: number | null;
  is_failure: number;
  login_uids_complete: number | null;
  login_uids_source_nanos: number | null;
  login_uids_source_seconds: number | null;
  profile_id: string;
  projection_schema_source_nanos: number;
  projection_schema_source_seconds: number;
  projection_schema_version: number;
  source_update_nanos: number;
  source_update_seconds: number;
};

async function d1Raw<T = unknown[]>(options: {
  columnNames: true;
}): Promise<[string[], ...T[]]>;
async function d1Raw<T = unknown[]>(options?: {
  columnNames?: false;
}): Promise<T[]>;
async function d1Raw<T = unknown[]>(options?: {
  columnNames?: boolean;
}): Promise<T[] | [string[], ...T[]]> {
  return options?.columnNames ? [[]] : [];
}

function profileDocument(
  profileId: string,
  updateTime: string,
  fields: Record<string, unknown> = { logins: ["login-1"] },
): AuthFirestoreDocument {
  return {
    id: profileId,
    name: authDocumentName("users", profileId),
    fields,
    rawFields: {},
    updateTime,
  };
}

function firestoreClient({
  documents = new Map<string, AuthFirestoreDocument | null>(),
  pages = [{ documents: [], nextPageToken: "" }],
}: {
  documents?: Map<string, AuthFirestoreDocument | null>;
  pages?: AuthFirestorePage[];
} = {}): AuthFirestoreClient {
  let pageIndex = 0;
  return {
    batchGet: async (names) =>
      new Map(names.map((name) => [name, documents.get(name) || null])),
    commitWrites: async () => undefined,
    createDocumentId: () => "document-1",
    get: async () => null,
    listPage: async () => pages[pageIndex++] || pages.at(-1)!,
    query: async () => [],
    runTransaction: async (work) =>
      (
        await work({
          batchGet: async () => new Map(),
          query: async () => [],
        })
      ).result,
  };
}

function d1Database(
  rows: unknown[] = [],
  options: {
    all?: () => Promise<void>;
    batch?: () => Promise<void>;
    onBind?: (sql: string, values: unknown[]) => void;
    run?: () => Promise<void>;
  } = {},
): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      all: async <T>() => {
        await options.all?.();
        return {
          success: true,
          results: rows as T[],
          meta: D1_META,
        };
      },
      bind: (...values) => {
        options.onBind?.(sql, values);
        return statement;
      },
      first: async () => null,
      raw: d1Raw,
      run: async <T>() => {
        await options.run?.();
        return { success: true, results: [] as T[], meta: D1_META };
      },
    };
    return statement;
  };
  return {
    batch: async (statements) => {
      await options.batch?.();
      return statements.map(() => ({
        success: true,
        results: [],
        meta: D1_META,
      }));
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
    prepare,
    withSession: () => {
      throw new Error("test-session-unavailable");
    },
  };
}

function message<T>(body: T): Message<T> & { acknowledgements: number } {
  let acknowledgements = 0;
  return {
    id: "message-1",
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack: () => acknowledgements++,
    retry: () => undefined,
    get acknowledgements() {
      return acknowledgements;
    },
  };
}

function queueEnv(
  sendBatch: Queue["sendBatch"] = TELEGRAM_TEST_ENV.PROFILE_PROJECTION_QUEUE
    .sendBatch,
): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    PROFILE_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.PROFILE_PROJECTION_QUEUE,
      sendBatch,
    },
  } as Env;
}

test("parses new and legacy profile tasks by validated profile ID", () => {
  assert.deepEqual(parseProfileReadProjectionTask({ profileId: "profile-1" }), {
    profileId: "profile-1",
  });
  assert.deepEqual(
    parseProfileReadProjectionTask({
      kind: "profile-read-projection",
      schemaVersion: 1,
      profileId: "profile-1",
      requestId: "legacy-request",
    }),
    { profileId: "profile-1" },
  );
  assert.equal(
    parseProfileReadProjectionTask({ profileId: "unsafe/path" }),
    null,
  );
  assert.equal(
    parseProfileReadProjectionTask({ kind: "profile-read-projection-sweep" }),
    null,
  );
});

test("stops legacy projection enqueueing in canonical D1 modes", async () => {
  let sends = 0;
  const env = {
    ...TELEGRAM_TEST_ENV,
    PROFILE_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.PROFILE_PROJECTION_QUEUE,
      send: async () => {
        sends += 1;
        return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
      },
    },
  } as unknown as Env;
  await enqueueProfileReadProjection(
    { ...env, PROFILE_STORAGE_MODE: "d1" } as unknown as Env,
    "profile-1",
  );
  assert.equal(sends, 0);
  await enqueueProfileReadProjection(
    { ...env, PROFILE_STORAGE_MODE: "firestore" } as Env,
    "profile-1",
  );
  assert.equal(sends, 1);
});

test("Queue consumer batch-reads and deduplicates current profiles", async () => {
  const profile = profileDocument("profile-1", "2026-08-27T12:00:00Z");
  let batchGets = 0;
  let projections = 0;
  const firestore = firestoreClient({
    documents: new Map([[profile.name, profile]]),
  });
  const originalBatchGet = firestore.batchGet;
  firestore.batchGet = async (names) => {
    batchGets++;
    assert.deepEqual(names, [profile.name]);
    return originalBatchGet(names);
  };
  const first = message({ profileId: "profile-1" });
  const duplicate = message({
    kind: "profile-read-projection",
    schemaVersion: 1,
    profileId: "profile-1",
    requestId: "legacy",
  });
  await handleProfileReadProjectionQueue(
    {
      messages: [first, duplicate],
      queue: PROFILE_READ_PROJECTION_QUEUE_NAME,
      metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
      ackAll: () => undefined,
      retryAll: () => undefined,
    },
    TELEGRAM_TEST_ENV as Env,
    {
      db: d1Database([], {
        batch: async () => {
          projections++;
        },
      }),
      firestore,
      logger: { info: () => undefined, error: () => undefined },
      now: () => 1_000,
    },
  );
  assert.equal(batchGets, 1);
  assert.equal(projections, 1);
  assert.equal(first.acknowledgements, 1);
  assert.equal(duplicate.acknowledgements, 1);
});

test("missing profiles use current D1 state for a CAS tombstone", async () => {
  const profileName = authDocumentName("users", "profile-1");
  let deletions = 0;
  let reads = 0;
  const firestore = firestoreClient({
    documents: new Map([[profileName, null]]),
  });
  const batchGet = firestore.batchGet;
  firestore.batchGet = async (names) => {
    reads++;
    return batchGet(names);
  };
  const status = await processProfileReadProjectionTask(
    { profileId: "profile-1" },
    TELEGRAM_TEST_ENV as Env,
    {
      db: d1Database(
        [
          {
            profile_id: "profile-1",
            source_update_seconds: 1_787_832_000,
            source_update_nanos: 200,
            is_deleted: 0,
            is_failure: 0,
            login_uids_complete: null,
            login_uids_source_nanos: null,
            login_uids_source_seconds: null,
            projection_schema_source_seconds: 1_787_832_000,
            projection_schema_source_nanos: 200,
            projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
          },
        ],
        {
          batch: async () => {
            deletions++;
          },
        },
      ),
      firestore,
      now: () => 1_000,
    },
  );
  assert.equal(status, "deleted");
  assert.equal(deletions, 1);
  assert.equal(reads, 2);
});

test("rechecks Firestore after capturing D1 state before deletion", async () => {
  const profile = profileDocument(
    "profile-1",
    "2026-08-27T12:00:00.000000200Z",
  );
  const events: string[] = [];
  let firestoreReads = 0;
  const firestore = firestoreClient();
  firestore.batchGet = async () => {
    firestoreReads++;
    events.push(`firestore-${firestoreReads}`);
    return new Map([[profile.name, firestoreReads === 1 ? null : profile]]);
  };
  const status = await processProfileReadProjectionTask(
    { profileId: profile.id },
    TELEGRAM_TEST_ENV as Env,
    {
      db: d1Database(
        [
          {
            profile_id: profile.id,
            source_update_seconds: 1_787_832_000,
            source_update_nanos: 100,
            is_deleted: 0,
            is_failure: 0,
            login_uids_complete: null,
            login_uids_source_nanos: null,
            login_uids_source_seconds: null,
            projection_schema_source_seconds: 1_787_832_000,
            projection_schema_source_nanos: 100,
            projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
          },
        ],
        {
          all: async () => {
            events.push("d1");
          },
          batch: async () => {
            events.push("projection");
          },
        },
      ),
      firestore,
      now: () => 1_000,
    },
  );

  assert.equal(status, "projected");
  assert.deepEqual(events, ["firestore-1", "d1", "firestore-2", "projection"]);
});

test("invalid projections write a failure fence and are acknowledged", async () => {
  const profile = profileDocument("profile-1", "2026-08-27T12:00:00Z", {
    logins: ["login-2", 7, "", "login-1", "login-2"],
  });
  let failureWrites = 0;
  let failureLoginIds = "";
  let failureLoginMetadata: unknown[] = [];
  const queued = message({ profileId: "profile-1" });
  await handleProfileReadProjectionMessage(queued, TELEGRAM_TEST_ENV as Env, {
    db: d1Database([], {
      onBind: (sql, values) => {
        if (sql.includes("INSERT INTO profile_projection_failures")) {
          failureLoginIds = String(values[4]);
          failureLoginMetadata = values.slice(5, 8);
        }
      },
      run: async () => {
        failureWrites++;
      },
    }),
    firestore: firestoreClient({
      documents: new Map([[profile.name, profile]]),
    }),
    logger: { info: () => undefined, error: () => undefined },
    now: () => 1_000,
  });
  assert.equal(failureWrites, 1);
  assert.equal(failureLoginIds, '["login-1","login-2"]');
  assert.deepEqual(failureLoginMetadata, [1_787_832_000, 0, 1]);
  assert.equal(queued.acknowledgements, 1);
});

test("oversized failure logins write a compact global marker", async () => {
  const profile = profileDocument("profile-1", "2026-08-27T12:00:00Z", {
    logins: [
      ...Array.from({ length: 1_001 }, (_, index) => `login-${index}`),
      7,
    ],
  });
  let failureLoginMetadata: unknown[] = [];
  const queued = message({ profileId: "profile-1" });
  await handleProfileReadProjectionMessage(queued, TELEGRAM_TEST_ENV as Env, {
    db: d1Database([], {
      onBind: (sql, values) => {
        if (sql.includes("INSERT INTO profile_projection_failures")) {
          failureLoginMetadata = values.slice(4, 8);
        }
      },
    }),
    firestore: firestoreClient({
      documents: new Map([[profile.name, profile]]),
    }),
    logger: { info: () => undefined, error: () => undefined },
    now: () => 1_000,
  });

  assert.deepEqual(failureLoginMetadata, ["[]", 1_787_832_000, 0, 0]);
  assert.equal(queued.acknowledgements, 1);
});

test("caught infrastructure failures are acknowledged without retry chains", async () => {
  const profile = profileDocument("profile-1", "2026-08-27T12:00:00Z");
  const queued = message({ profileId: "profile-1" });
  await handleProfileReadProjectionMessage(queued, TELEGRAM_TEST_ENV as Env, {
    db: d1Database([], {
      batch: async () => {
        throw new Error("temporary-D1-failure");
      },
    }),
    firestore: firestoreClient({
      documents: new Map([[profile.name, profile]]),
    }),
    logger: { info: () => undefined, error: () => undefined },
    now: () => 1_000,
  });
  assert.equal(queued.acknowledgements, 1);
});

test("reconciliation compares profiles, failures, and deletion candidates", async () => {
  const firstPage = {
    documents: [
      profileDocument("current", "2026-08-27T12:00:00.000000100Z"),
      profileDocument("invalid", "2026-08-27T12:00:00.000000300Z"),
      profileDocument("new", "2026-08-27T12:00:00.000000100Z"),
    ],
    nextPageToken: "page-2",
  };
  const secondPage = {
    documents: [
      profileDocument("repaired", "2026-08-27T12:00:00.000000400Z"),
      profileDocument("failure-schema-old", "2026-08-27T12:00:00.000000700Z"),
      profileDocument(
        "failure-schema-source-stale",
        "2026-08-27T12:00:00.000000800Z",
      ),
      profileDocument("failure-login-stale", "2026-08-27T12:00:00.000000900Z"),
      profileDocument(
        "failure-login-oversized",
        "2026-08-27T12:00:00.000000901Z",
      ),
      profileDocument("schema-old", "2026-08-27T12:00:00.000000500Z"),
      profileDocument("schema-source-stale", "2026-08-27T12:00:00.000000600Z"),
      profileDocument("stale", "2026-08-27T12:00:00.000000200Z"),
      profileDocument("tombstone", "2026-08-27T12:00:00.000000100Z"),
    ],
    nextPageToken: "",
  };
  const rows: ReconciliationRow[] = [
    ["current", 100, 0, 0],
    ["invalid", 100, 0, 0],
    ["invalid", 300, null, 1],
    ["repaired", 400, 0, 0],
    ["repaired", 300, null, 1],
    ["stale", 100, 0, 0],
    ["deleted", 100, 0, 0],
    ["tombstone", 100, 1, 0],
    ["failure-only", 100, null, 1],
  ].map(([profileId, nanos, isDeleted, isFailure]) => ({
    profile_id: String(profileId),
    source_update_seconds: 1_787_832_000,
    source_update_nanos: Number(nanos),
    projection_schema_source_seconds: 1_787_832_000,
    projection_schema_source_nanos: Number(nanos),
    projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
    is_deleted: isDeleted === null ? null : Number(isDeleted),
    is_failure: Number(isFailure),
    login_uids_complete: Number(isFailure) === 1 ? 1 : null,
    login_uids_source_nanos: Number(isFailure) === 1 ? Number(nanos) : null,
    login_uids_source_seconds: Number(isFailure) === 1 ? 1_787_832_000 : null,
  }));
  rows.push(
    {
      profile_id: "failure-schema-old",
      source_update_seconds: 1_787_832_000,
      source_update_nanos: 700,
      projection_schema_source_seconds: 1_787_832_000,
      projection_schema_source_nanos: 700,
      projection_schema_version: 1,
      is_deleted: null,
      is_failure: 1,
      login_uids_complete: 1,
      login_uids_source_nanos: 700,
      login_uids_source_seconds: 1_787_832_000,
    },
    {
      profile_id: "failure-schema-source-stale",
      source_update_seconds: 1_787_832_000,
      source_update_nanos: 800,
      projection_schema_source_seconds: 1_787_832_000,
      projection_schema_source_nanos: 700,
      projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
      is_deleted: null,
      is_failure: 1,
      login_uids_complete: 1,
      login_uids_source_nanos: 800,
      login_uids_source_seconds: 1_787_832_000,
    },
    {
      profile_id: "failure-login-stale",
      source_update_seconds: 1_787_832_000,
      source_update_nanos: 900,
      projection_schema_source_seconds: 1_787_832_000,
      projection_schema_source_nanos: 900,
      projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
      is_deleted: null,
      is_failure: 1,
      login_uids_complete: 0,
      login_uids_source_nanos: 0,
      login_uids_source_seconds: -1,
    },
    {
      profile_id: "failure-login-oversized",
      source_update_seconds: 1_787_832_000,
      source_update_nanos: 901,
      projection_schema_source_seconds: 1_787_832_000,
      projection_schema_source_nanos: 901,
      projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
      is_deleted: null,
      is_failure: 1,
      login_uids_complete: 0,
      login_uids_source_nanos: 901,
      login_uids_source_seconds: 1_787_832_000,
    },
    {
      profile_id: "schema-old",
      source_update_seconds: 1_787_832_000,
      source_update_nanos: 500,
      projection_schema_source_seconds: 1_787_832_000,
      projection_schema_source_nanos: 500,
      projection_schema_version: 1,
      is_deleted: 0,
      is_failure: 0,
      login_uids_complete: null,
      login_uids_source_nanos: null,
      login_uids_source_seconds: null,
    },
    {
      profile_id: "schema-source-stale",
      source_update_seconds: 1_787_832_000,
      source_update_nanos: 600,
      projection_schema_source_seconds: 1_787_832_000,
      projection_schema_source_nanos: 500,
      projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
      is_deleted: 0,
      is_failure: 0,
      login_uids_complete: null,
      login_uids_source_nanos: null,
      login_uids_source_seconds: null,
    },
  );
  const queued: unknown[] = [];
  const env = queueEnv(async (messages) => {
    queued.push(...Array.from(messages, (entry) => entry.body));
    return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
  });
  const firestore = firestoreClient({ pages: [firstPage, secondPage] });
  const listCalls: unknown[][] = [];
  const originalListPage = firestore.listPage;
  firestore.listPage = async (...args) => {
    listCalls.push(args);
    return originalListPage(...args);
  };
  const count = await reconcileProfileReadProjections(env, {
    db: d1Database(rows),
    firestore,
    logger: { info: () => undefined, error: () => undefined },
  });
  assert.equal(count, 11);
  assert.deepEqual(queued, [
    { profileId: "deleted" },
    { profileId: "failure-login-stale" },
    { profileId: "failure-only" },
    { profileId: "failure-schema-old" },
    { profileId: "failure-schema-source-stale" },
    { profileId: "new" },
    { profileId: "repaired" },
    { profileId: "schema-old" },
    { profileId: "schema-source-stale" },
    { profileId: "stale" },
    { profileId: "tombstone" },
  ]);
  assert.deepEqual(listCalls, [
    ["", "users", "", ["nonce"]],
    ["", "users", "page-2", ["nonce"]],
  ]);
});

test("reconciliation sends at most 100 profile IDs per Queue batch", async () => {
  const rows: ReconciliationRow[] = Array.from({ length: 205 }, (_, index) => ({
    profile_id: `deleted-${String(index).padStart(3, "0")}`,
    source_update_seconds: 1_787_832_000,
    source_update_nanos: 100,
    projection_schema_source_seconds: 1_787_832_000,
    projection_schema_source_nanos: 100,
    projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
    is_deleted: 0,
    is_failure: 0,
    login_uids_complete: null,
    login_uids_source_nanos: null,
    login_uids_source_seconds: null,
  }));
  const batchSizes: number[] = [];
  const env = queueEnv(async (messages) => {
    batchSizes.push(Array.from(messages).length);
    return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
  });
  const count = await reconcileProfileReadProjections(env, {
    db: d1Database(rows),
    firestore: firestoreClient(),
    logger: { info: () => undefined, error: () => undefined },
  });
  assert.equal(count, 205);
  assert.deepEqual(batchSizes, [100, 100, 5]);
});

test("reconciliation logs and propagates Queue failures", async () => {
  const errors: string[] = [];
  const env = queueEnv(async () => {
    throw new Error("queue-unavailable");
  });
  await assert.rejects(
    reconcileProfileReadProjections(env, {
      db: d1Database([
        {
          profile_id: "deleted",
          source_update_seconds: 1_787_832_000,
          source_update_nanos: 100,
          is_deleted: 0,
          is_failure: 0,
          login_uids_complete: null,
          login_uids_source_nanos: null,
          login_uids_source_seconds: null,
          projection_schema_source_seconds: 1_787_832_000,
          projection_schema_source_nanos: 100,
          projection_schema_version: PROFILE_PROJECTION_SCHEMA_VERSION,
        },
      ]),
      firestore: firestoreClient(),
      logger: { info: () => undefined, error: (value) => errors.push(value) },
    }),
    /queue-unavailable/,
  );
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /deleted|queue-unavailable/);
});

test("Worker Queue routing selects the profile projection consumer", async () => {
  const queued = message({ profileId: "unsafe/path" });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await worker.queue?.(
      {
        messages: [queued],
        queue: PROFILE_READ_PROJECTION_QUEUE_NAME,
        metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
        ackAll: () => undefined,
        retryAll: () => undefined,
      },
      TELEGRAM_TEST_ENV as Env,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(queued.acknowledgements, 1);
});
