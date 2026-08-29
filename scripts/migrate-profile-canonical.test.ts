import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CANONICAL_IMPORT_PLAN_VERSION,
  CANONICAL_TABLES,
  MAX_D1_QUERY_REQUEST_BYTES,
  MAX_D1_ROW_ESTIMATE_BYTES,
  MAX_IMPORT_BATCH_STATEMENTS,
  ProfileCanonicalMigrationError,
  assertCanonicalImportPlanCompatible,
  batchImportStatements,
  buildCanonicalDataset,
  buildCanonicalImportPlan,
  canonicalImportGuardStatement,
  claimCanonicalImportPlan,
  d1QueryRequestBytes,
  estimateCanonicalRowBytes,
  execute,
  formatPublicFailure,
  parseArgs,
  publicSummary,
  readBoundedD1Response,
  readKeysetCollection,
  readStableCanonicalTarget,
  readTargetDataset,
  readTargetTable,
  targetPageStatement,
  validateCanonicalTarget,
  verificationSnapshot,
  type CanonicalDataset,
  type D1Client,
  type D1Statement,
  type SourceDocument,
} from "./migrate-profile-canonical.ts";

function sqliteD1Client(
  database: DatabaseSync,
  inspect?: (statements: D1Statement[]) => void,
): D1Client {
  return {
    async query(statements) {
      inspect?.(statements);
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          const prepared = database.prepare(statement.sql);
          return /^\s*(?:EXPLAIN|SELECT)\b/i.test(statement.sql)
            ? (prepared.all(...statement.params) as Record<string, unknown>[])
            : (prepared.run(...statement.params), []);
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function database(): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  value.exec(
    readFileSync(
      resolve(
        "cloud/workers/api/profile-migrations/0007_profile_canonical.sql",
      ),
      "utf8",
    ),
  );
  return value;
}

function setImporting(value: DatabaseSync): void {
  value.exec(`
    UPDATE profile_canonical_control
    SET state = 'importing'
    WHERE singleton = 1 AND state = 'firestore'
  `);
}

function sourceDocument(
  id: string,
  fields: Record<string, unknown>,
  nanoseconds = 1,
): SourceDocument {
  return {
    id,
    fields,
    updateTime: { seconds: 1_787_832_000, nanoseconds },
  };
}

function profileFields(overrides: Record<string, unknown> = {}) {
  return {
    logins: ["login-1"],
    nonce: 1,
    rating: 1500,
    totalManaPoints: 5,
    win: true,
    username: "Alice7",
    custom: { emoji: 2 },
    mining: {
      lastRockDate: "2026-08-27",
      materials: { dust: 1, slime: 2, gum: 3, metal: 4, ice: 5 },
    },
    ...overrides,
  };
}

function ratingFields(overrides: Record<string, unknown> = {}) {
  return {
    inviteId: "invite-1",
    leaseExpiresAtMs: 2_000,
    matchId: "match-1",
    opponentId: "login-2",
    ownerToken: "owner-token",
    ownerUid: "login-1",
    playerId: "login-1",
    startedAtMs: 1_000,
    status: "processing",
    updatedAtMs: 1_001,
    ...overrides,
  };
}

async function simpleDataset(
  overrides: Record<string, unknown> = {},
): Promise<CanonicalDataset> {
  return buildCanonicalDataset({
    users: [sourceDocument("profile-1", profileFields(overrides))],
  });
}

function control(database: DatabaseSync): Record<string, unknown> {
  return database
    .prepare(
      `SELECT state, import_digest, import_plan_version, imported_at_ms
       FROM profile_canonical_control WHERE singleton = 1`,
    )
    .get() as Record<string, unknown>;
}

function canonicalWriteBatch(statements: D1Statement[]): boolean {
  return statements.some((statement) =>
    CANONICAL_TABLES.some((table) =>
      new RegExp(`INSERT INTO\\s+${table}\\b`).test(statement.sql),
    ),
  );
}

test("parses one exact mode and only the production project", () => {
  assert.deepEqual(parseArgs([]), { mode: "dry-run", project: "mons-link" });
  for (const mode of ["execute", "verify", "verify-d1"] as const) {
    assert.deepEqual(parseArgs([`--${mode}`]), {
      mode,
      project: "mons-link",
    });
  }
  assert.throws(() => parseArgs(["--execute", "--verify"]));
  assert.throws(() => parseArgs(["--project", "demo"]));
  assert.throws(() => parseArgs(["--cursor", "private"]));
});

test("rebuilds authoritative owners and reports stale indexes", async () => {
  const eth = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const dataset = await buildCanonicalDataset({
    users: [
      sourceDocument(
        "profile-1",
        profileFields({ eth, logins: ["canonical-login"] }),
      ),
    ],
    usernameIndex: [
      sourceDocument("alice7", {
        profileId: "stale-profile",
        username: "Alice7",
      }),
    ],
    authMethodIndex: [
      sourceDocument("stale-method", {
        method: "eth",
        normalizedValue: eth,
        profileId: "stale-profile",
      }),
    ],
  });
  assert.equal(dataset.indexValidation.usernameStale, 1);
  assert.equal(dataset.indexValidation.authMethodStale, 1);
  assert.deepEqual(
    dataset.tables.profile_login_owners.map((row) => row.login_uid),
    ["canonical-login"],
  );
  assert.deepEqual(
    dataset.tables.profile_auth_methods.map((row) => row.profile_id),
    ["profile-1"],
  );
  await assert.rejects(
    buildCanonicalDataset({
      users: [
        sourceDocument("profile-1", profileFields()),
        sourceDocument("profile-2", profileFields({ username: "Bob8" }), 2),
      ],
    }),
    /duplicate-login-owner/,
  );
});

test("preserves legacy fields without interpreting them", async () => {
  const dataset = await buildCanonicalDataset({
    users: [
      sourceDocument(
        "source-profile",
        profileFields({
          logins: [],
          username: "",
          mergedIntoProfileId: "target-profile",
          mergedAtMs: 1_000,
          futurePrivateField: { nested: ["private-value"] },
          custom: { futureDecoration: true },
          emoji: 7,
        }),
      ),
      sourceDocument(
        "target-profile",
        profileFields({ logins: ["target-login"], username: "Target7" }),
        2,
      ),
    ],
    profileMergeTargets: [
      sourceDocument("source-profile", {
        sourceProfileId: "source-profile",
        targetProfileId: "target-profile",
        mergedAtMs: 1_000,
      }),
    ],
  });
  const source = dataset.tables.profile_records.find(
    (row) => row.profile_id === "source-profile",
  );
  assert.deepEqual(JSON.parse(String(source?.legacy_fields_json)), {
    custom: { futureDecoration: true },
    emoji: 7,
    futurePrivateField: { nested: ["private-value"] },
  });
  assert.equal(
    dataset.tables.profile_merge_targets[0].source_legacy_fields_json,
    source?.legacy_fields_json,
  );
});

test("blocks ambiguous presentation and malformed active namespaces", async () => {
  for (const overrides of [
    { aura: " " },
    { emoji: 0 },
    { custom: { emoji: "" } },
    { custom: "invalid" },
    { mining: { futureBalance: 1, materials: {} } },
    { mining: { materials: { futureMaterial: 1 } } },
    { nonce: "1" },
    { win: "true" },
  ]) {
    await assert.rejects(
      buildCanonicalDataset({
        users: [sourceDocument("profile-1", profileFields(overrides))],
      }),
    );
  }
});

test("requires canonical provider ownership and supports explicit null", async () => {
  await assert.doesNotReject(
    buildCanonicalDataset({
      users: [
        sourceDocument(
          "profile-1",
          profileFields({
            eth: null,
            sol: null,
            appleSub: null,
            xUserId: null,
          }),
        ),
      ],
    }),
  );
  const dataset = await simpleDataset({
    eth: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  });
  dataset.tables.profile_auth_methods[0].normalized_value =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.throws(() => validateCanonicalTarget(dataset));
});

test("rejects merge cycles and malformed recovery topology", async () => {
  await assert.rejects(
    buildCanonicalDataset({
      users: [],
      profileMergeTargets: [
        sourceDocument("a", { targetProfileId: "b" }),
        sourceDocument("b", { targetProfileId: "a" }, 2),
      ],
    }),
    /profile-merge-cycle/,
  );
  await assert.rejects(
    buildCanonicalDataset({
      users: [sourceDocument("profile-1", profileFields())],
      authRecoveryJobs: [
        sourceDocument("profile-1", {
          profileId: "profile-1",
          loginUids: ["login-1"],
          sourceProfileIds: ["missing-source"],
          sourcePhase: "finalize",
          prizeCursor: null,
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      ],
    }),
    /malformed-canonical-auth-recovery/,
  );
});

test("validates auth operations, ratings, and wager receipts", async () => {
  await assert.doesNotReject(
    buildCanonicalDataset({
      users: [sourceDocument("profile-1", profileFields())],
      authOps: [
        sourceDocument("unlink-op", {
          opId: "unlink-op",
          kind: "unlink",
          method: "eth",
          uid: "login-1",
          status: "success",
          meta: null,
          result: null,
          startedAtMs: 1,
          updatedAtMs: 2,
        }),
      ],
      ratingUpdates: [sourceDocument("invite-1__match-1", ratingFields(), 2)],
      wagerSettlements: [
        sourceDocument("wager-1", {
          fingerprint: "fingerprint",
          winnerProfileId: "profile-1",
          loserProfileId: "profile-2",
          material: "dust",
          count: 1,
          appliedAtMs: 2,
        }),
      ],
    }),
  );
  await assert.rejects(
    buildCanonicalDataset({
      users: [sourceDocument("profile-1", profileFields())],
      ratingUpdates: [
        sourceDocument(
          "invite-1__match-1",
          ratingFields({ leaseExpiresAtMs: "2000" }),
        ),
      ],
    }),
    /malformed-integer-field/,
  );
});

test("normalizes rating fallbacks into exact canonical materialization", async () => {
  const dataset = await buildCanonicalDataset({
    users: [sourceDocument("profile-1", profileFields())],
    ratingUpdates: [
      sourceDocument("invite-1__match-1", {
        ...ratingFields(),
        updatedAtMs: undefined,
      }),
    ],
  });
  const row = dataset.tables.rating_updates[0];
  const payload = JSON.parse(String(row.payload_json)) as Record<
    string,
    unknown
  >;
  assert.equal(payload.updatedAtMs, row.updated_at_ms);
  assert.equal(payload.completedAtMs, null);
  assert.doesNotThrow(() => validateCanonicalTarget(dataset));
});

test("preflights conservative D1 row size before creating a client", async () => {
  const oversized = await simpleDataset({
    privateArchive: "\\".repeat(950_000),
  });
  assert.ok(
    estimateCanonicalRowBytes(
      "profile_records",
      oversized.tables.profile_records[0],
    ) > MAX_D1_ROW_ESTIMATE_BYTES,
  );
  assert.throws(() => buildCanonicalImportPlan(oversized), /row-too-large/);
  let clients = 0;
  await assert.rejects(
    execute(["--execute"], {
      addCredentialHelp: (error) => error,
      cleanupFirebase: async () => undefined,
      createClient: () => {
        clients += 1;
        throw new Error("must not create client");
      },
      initializeFirebase: () => true,
      readSource: async () => oversized,
    }),
    /canonical-row-too-large/,
  );
  assert.equal(clients, 0);
});

test("builds deterministic bounded import batches including their guard", async () => {
  const dataset = await buildCanonicalDataset({
    users: Array.from({ length: 80 }, (_, index) =>
      sourceDocument(
        `profile-${index}`,
        profileFields({
          logins: [`login-${index}`],
          username: `Player${index}`,
        }),
        index + 1,
      ),
    ),
  });
  const first = buildCanonicalImportPlan(dataset);
  const second = buildCanonicalImportPlan(structuredClone(dataset));
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest.length, 64);
  assert.ok(first.batches.length > 1);
  const guard = canonicalImportGuardStatement(first.digest);
  for (const batch of first.batches) {
    assert.ok(batch.length + 1 <= MAX_IMPORT_BATCH_STATEMENTS);
    assert.ok(
      d1QueryRequestBytes([guard, ...batch]) <= MAX_D1_QUERY_REQUEST_BYTES,
    );
  }
  assert.deepEqual(
    batchImportStatements(first.statements, {
      maxStatements: MAX_IMPORT_BATCH_STATEMENTS - 1,
      prefixStatements: [guard],
    }),
    first.batches,
  );
});

test("keyset-pages Firestore and keyset-pages target rows", async () => {
  const doc = (id: string) => ({
    id,
    data: () => profileFields({ logins: [id], username: id }),
    updateTime: { seconds: 1_787_832_000, nanoseconds: 1 },
  });
  const firestore = {
    collection() {
      let limit = 2;
      const query = {
        orderBy: () => query,
        limit(value: number) {
          limit = value;
          return query;
        },
        startAfter() {
          return query;
        },
        async get() {
          const docs = [doc("a")].slice(0, limit);
          return { docs, empty: docs.length === 0, size: docs.length };
        },
      };
      return query;
    },
  };
  const source = await readKeysetCollection(firestore, "document-id", "users", {
    pageSize: 2,
  });
  assert.deepEqual(
    source.documents.map((entry) => entry.id),
    ["a"],
  );
  await assert.rejects(
    readBoundedD1Response(new Response("oversized"), 8),
    /profile-d1-response-too-large/,
  );
  const pages = [
    [
      {
        login_uid: "a",
        profile_id: "p-a",
        revision: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ],
    [],
  ];
  const targetRows = await readTargetTable(
    {
      async query() {
        return [pages.shift() || []];
      },
    },
    "profile_login_owners",
    { pageSize: 1 },
  );
  assert.deepEqual(
    targetRows.map((row) => row.login_uid),
    ["a"],
  );
  assert.match(
    targetPageStatement("profile_auth_methods", {
      method: "eth",
      normalized_value: "value",
    }).sql,
    /normalized_value > \?/,
  );
});

test("claims only one digest and rejects a different plan", async () => {
  const first = buildCanonicalImportPlan(await simpleDataset());
  const second = buildCanonicalImportPlan(
    await simpleDataset({ username: "Changed8" }),
  );
  const db = database();
  try {
    setImporting(db);
    const client = sqliteD1Client(db);
    await assertCanonicalImportPlanCompatible(client, first.digest);
    await claimCanonicalImportPlan(client, first.digest);
    await assert.rejects(
      assertCanonicalImportPlanCompatible(client, second.digest),
      /import-plan-mismatch/,
    );
    assert.deepEqual(
      { ...control(db) },
      {
        state: "importing",
        import_digest: first.digest,
        import_plan_version: CANONICAL_IMPORT_PLAN_VERSION,
        imported_at_ms: null,
      },
    );
  } finally {
    db.close();
  }

  const wrongVersion = database();
  try {
    setImporting(wrongVersion);
    wrongVersion
      .prepare(
        `UPDATE profile_canonical_control
         SET import_digest = ?, import_plan_version = ?
         WHERE singleton = 1`,
      )
      .run(first.digest, CANONICAL_IMPORT_PLAN_VERSION + 1);
    await assert.rejects(
      assertCanonicalImportPlanCompatible(
        sqliteD1Client(wrongVersion),
        first.digest,
      ),
      /import-plan-mismatch/,
    );
  } finally {
    wrongVersion.close();
  }
});

test("reruns from batch one after interruption at every batch", async () => {
  const source = await buildCanonicalDataset({
    users: Array.from({ length: 80 }, (_, index) =>
      sourceDocument(
        `profile-${index}`,
        profileFields({
          logins: [`login-${index}`],
          username: `Player${index}`,
        }),
        index + 1,
      ),
    ),
  });
  const plan = buildCanonicalImportPlan(source);
  assert.ok(plan.batches.length > 1);
  for (let failAt = 0; failAt < plan.batches.length; failAt += 1) {
    const db = database();
    try {
      setImporting(db);
      const base = sqliteD1Client(db);
      let batch = 0;
      const interrupted: D1Client = {
        async query(statements) {
          if (canonicalWriteBatch(statements) && batch++ === failAt) {
            throw new Error("interrupted");
          }
          return base.query(statements);
        },
      };
      await assert.rejects(
        execute(["--execute"], {
          addCredentialHelp: (error) => error,
          cleanupFirebase: async () => undefined,
          createClient: () => interrupted,
          initializeFirebase: () => true,
          readSource: async () => structuredClone(source),
        }),
        /interrupted/,
      );
      await execute(["--execute"], {
        addCredentialHelp: (error) => error,
        cleanupFirebase: async () => undefined,
        createClient: () => base,
        initializeFirebase: () => true,
        log: () => undefined,
        readSource: async () => structuredClone(source),
      });
      const target = await readTargetDataset(base);
      validateCanonicalTarget(target);
      assert.equal(
        verificationSnapshot(target).fingerprint,
        verificationSnapshot(source).fingerprint,
      );
      assert.equal(control(db).state, "frozen");
    } finally {
      db.close();
    }
  }
});

test("execute imports one stable plan, verifies it, and freezes", async () => {
  const source = await simpleDataset();
  const db = database();
  const output: string[] = [];
  try {
    setImporting(db);
    let reads = 0;
    await execute(["--execute"], {
      addCredentialHelp: (error) => error,
      cleanupFirebase: async () => undefined,
      createClient: () => sqliteD1Client(db),
      initializeFirebase: () => true,
      log: (value) => output.push(value),
      readSource: async () => {
        reads += 1;
        return structuredClone(source);
      },
    });
    assert.equal(reads, 3);
    assert.equal(output.length, 1);
    const finalControl = control(db);
    assert.equal(finalControl.state, "frozen");
    assert.equal(
      finalControl.import_digest,
      verificationSnapshot(source).fingerprint,
    );
    assert.equal(
      finalControl.import_plan_version,
      CANONICAL_IMPORT_PLAN_VERSION,
    );
    assert.ok(Number(finalControl.imported_at_ms) >= 0);
    const target = await readStableCanonicalTarget(sqliteD1Client(db));
    assert.equal(
      verificationSnapshot(target).fingerprint,
      verificationSnapshot(source).fingerprint,
    );
  } finally {
    db.close();
  }
});

test("execute withholds all D1 writes when source preflight differs", async () => {
  const source = await simpleDataset();
  const changed = await simpleDataset({ username: "Changed8" });
  const db = database();
  try {
    setImporting(db);
    let reads = 0;
    let clients = 0;
    await assert.rejects(
      execute(["--execute"], {
        addCredentialHelp: (error) => error,
        cleanupFirebase: async () => undefined,
        createClient: () => {
          clients += 1;
          return sqliteD1Client(db);
        },
        initializeFirebase: () => true,
        readSource: async () => (reads++ === 0 ? source : changed),
      }),
      /profile-source-changed-before-import/,
    );
    assert.equal(clients, 0);
    assert.equal(control(db).import_digest, null);
  } finally {
    db.close();
  }
});

test("dry-run performs full preflight without a D1 client", async () => {
  const source = await simpleDataset();
  let clients = 0;
  const output: string[] = [];
  await execute(["--dry-run"], {
    cleanupFirebase: async () => undefined,
    createClient: () => {
      clients += 1;
      throw new Error("must not create client");
    },
    initializeFirebase: () => true,
    log: (value) => output.push(value),
    readSource: async () => source,
  });
  assert.equal(clients, 0);
  assert.deepEqual(
    JSON.parse(output[0]),
    publicSummary("dry-run", source, false),
  );
});

test("removed migrator has no lease, replacement, prune, or source versions", () => {
  const source = readFileSync(
    resolve("scripts/migrate-profile-canonical.ts"),
    "utf8",
  );
  for (const pattern of [
    /profile_canonical_operation_lock/,
    /ControlLease/,
    /buildReplacementPreparationStatements/,
    /buildPruneStatements/,
    /source_update_seconds/,
    /source_update_nanos/,
    /upsertFreshness/,
  ]) {
    assert.doesNotMatch(source, pattern);
  }
});

test("public output and failures omit identities and private digests", async () => {
  const source = await buildCanonicalDataset({
    users: [
      sourceDocument(
        "private-profile-id",
        profileFields({ logins: ["private-login-id"] }),
      ),
    ],
  });
  const output = JSON.stringify(publicSummary("dry-run", source, false));
  assert.doesNotMatch(output, /private-profile-id|private-login-id|digest/i);
  assert.equal(
    formatPublicFailure(new Error("private-profile private-login")),
    "profile canonical migration failed: profile-canonical-migration-failed",
  );
  assert.equal(
    formatPublicFailure(new ProfileCanonicalMigrationError("fixed-code")),
    "profile canonical migration failed: fixed-code",
  );
});
