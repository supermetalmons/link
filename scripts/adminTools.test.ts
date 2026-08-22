const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { readFileSync }: typeof import("node:fs") = require("node:fs");
const { resolve }: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");

const repositoryRoot = resolve(__dirname, "..");
const {
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  createLeaderboardHeading,
  parseLeaderboardArgs,
  parseLeaderboardLimit,
} = require("../cloud/admin/leaderboardCli.js");
const {
  AUTH_COOLDOWN_COLLECTIONS,
  PAGE_SIZE,
  applyCooldownMutations,
  buildCleanupQuery,
  classifyCooldown,
  cleanupCollection,
  deleteDocuments,
  hasCanonicalRetryAtMs,
  parseArgs: parseCleanupArgs,
  resolveRetryAtMs,
} = require("../cloud/admin/cleanupAuthMethodRevocations.js");

test("leaderboard CLIs retain 15 as the default and accept a bounded limit", () => {
  assert.equal(DEFAULT_LEADERBOARD_LIMIT, 15);
  assert.equal(MAX_LEADERBOARD_LIMIT, 90);
  assert.equal(parseLeaderboardLimit([]), 15);
  assert.equal(parseLeaderboardLimit(["1"]), 1);
  assert.equal(parseLeaderboardLimit([" 25 "]), 25);
  assert.equal(parseLeaderboardLimit(["90"]), 90);
  assert.equal(createLeaderboardHeading("gp", 15), "<b>top 15 gp</b>\n\n");
  assert.equal(createLeaderboardHeading("mp", 15), "<b>top 15 mp</b>\n\n");
});

test("leaderboard CLIs reject unsafe or ambiguous limits", () => {
  for (const argv of [
    [""],
    ["0"],
    ["-1"],
    ["1.5"],
    ["91"],
    ["100"],
    ["Infinity"],
    ["15", "16"],
  ]) {
    assert.throws(() => parseLeaderboardLimit(argv), /limit/i, argv.join(" "));
  }
});

test("leaderboard CLIs preserve Firebase Admin flags alongside a limit", () => {
  assert.deepEqual(
    parseLeaderboardArgs([
      "--project",
      "mons-link",
      "25",
      "--database-url",
      "https://mons-link-default-rtdb.firebaseio.com",
    ]),
    {
      adminArgs: [
        "--project",
        "mons-link",
        "--database-url",
        "https://mons-link-default-rtdb.firebaseio.com",
      ],
      limit: 25,
    },
  );
  assert.deepEqual(parseLeaderboardArgs(["--project", "mons-link"]), {
    adminArgs: ["--project", "mons-link"],
    limit: DEFAULT_LEADERBOARD_LIMIT,
  });
  assert.throws(() => parseLeaderboardArgs(["--project"]), /requires a value/);
});

test("both leaderboard entrypoints parse arguments and preserve delivery keys", () => {
  for (const [filename, key, metric] of [
    ["topGpWithEmojis.js", "admin:top-gp:", "gp"],
    ["topMpWithEmojis.js", "admin:top-mp:", "mp"],
  ]) {
    const source = readFileSync(
      resolve(repositoryRoot, "cloud/admin", filename),
      "utf8",
    );
    assert.match(source, /parseBridgeSecretFile\(argv\)/);
    assert.match(source, /parseLeaderboardArgs\(remainingArgs\)/);
    assert.match(source, /initAdmin\(adminArgs\)/);
    assert.match(source, /dispatchDelivery/);
    assert.match(
      source,
      new RegExp(`createLeaderboardHeading\\("${metric}", limit\\)`),
    );
    assert.match(source, new RegExp(key));
    assert.match(source, /parseMode: "HTML"/);
    assert.match(source, /if \(require\.main === module\)/);
  }
});

test("auth cooldown cleanup covers both collections and expiry formats", () => {
  assert.deepEqual(AUTH_COOLDOWN_COLLECTIONS, [
    "authMethodRevocations",
    "authProfileMethodCooldowns",
  ]);
  assert.equal(resolveRetryAtMs({ retryAtMs: 20, expiresAtMs: 30 }), 20);
  assert.equal(resolveRetryAtMs({ retryAtMs: 20.5 }), 20);
  assert.equal(resolveRetryAtMs({ expiresAtMs: 30 }), 30);
  assert.equal(resolveRetryAtMs({ startedAtMs: 40, cooldownMs: 5 }), 45);
  assert.equal(hasCanonicalRetryAtMs({ retryAtMs: 20 }), true);
  assert.equal(hasCanonicalRetryAtMs({ retryAtMs: "20" }), false);
  assert.equal(hasCanonicalRetryAtMs({ retryAtMs: 20.5 }), false);
  assert.equal(classifyCooldown({}, 50), "unknown");
  assert.equal(classifyCooldown({ retryAtMs: 51 }, 50), "active");
  assert.equal(classifyCooldown({ retryAtMs: 50 }, 50), "expired");
});

test("auth cooldown cleanup defaults safe and requires explicit execution", () => {
  assert.deepEqual(parseCleanupArgs([]), {
    dryRun: true,
    scanLegacy: false,
  });
  assert.deepEqual(parseCleanupArgs(["--project", "mons-link"]), {
    dryRun: true,
    scanLegacy: false,
  });
  assert.deepEqual(
    parseCleanupArgs([
      "--project",
      "mons-link",
      "--database-url",
      "https://mons-link-default-rtdb.firebaseio.com",
    ]),
    { dryRun: true, scanLegacy: false },
  );
  assert.deepEqual(parseCleanupArgs(["--project", "mons-link", "--execute"]), {
    dryRun: false,
    scanLegacy: false,
  });
  assert.deepEqual(parseCleanupArgs(["--scan-legacy", "--dry-run"]), {
    dryRun: true,
    scanLegacy: true,
  });
  for (const argv of [
    ["--dry-rnu"],
    ["--project"],
    ["--project", "--execute"],
    ["--dry-run", "--execute"],
    ["--scan-legacy", "--scan-legacy"],
  ]) {
    assert.throws(() => parseCleanupArgs(argv), /Usage/);
  }
});

test("auth cooldown deletes require the scanned document version", async () => {
  const deletes: unknown[][] = [];
  let committed = false;
  const firestore = {
    batch: () => ({
      delete: (...args: unknown[]) => deletes.push(args),
      commit: async () => {
        committed = true;
      },
    }),
  };
  const ref = { path: "authMethodRevocations/method" };
  const updateTime = { seconds: 123 };

  assert.equal(await deleteDocuments(firestore, [{ ref, updateTime }]), 1);
  assert.deepEqual(deletes, [[ref, { lastUpdateTime: updateTime }]]);
  assert.equal(committed, true);
});

test("auth cooldown recurring cleanup uses the retryAtMs index", () => {
  const calls: unknown[][] = [];
  const cursor = { id: "cursor" };
  const query = {
    where: (...args: unknown[]) => {
      calls.push(["where", ...args]);
      return query;
    },
    orderBy: (...args: unknown[]) => {
      calls.push(["orderBy", ...args]);
      return query;
    },
    startAfter: (...args: unknown[]) => {
      calls.push(["startAfter", ...args]);
      return query;
    },
    limit: (...args: unknown[]) => {
      calls.push(["limit", ...args]);
      return query;
    },
  };
  const firestore = {
    collection: (...args: unknown[]) => {
      calls.push(["collection", ...args]);
      return query;
    },
  };

  assert.strictEqual(
    buildCleanupQuery({
      firestore,
      collectionName: "authMethodRevocations",
      documentIdField: "__name__",
      lastDoc: cursor,
      nowMs: 100,
      scanLegacy: false,
    }),
    query,
  );
  assert.deepEqual(calls, [
    ["collection", "authMethodRevocations"],
    ["where", "retryAtMs", "<=", 100],
    ["orderBy", "retryAtMs"],
    ["startAfter", cursor],
    ["limit", PAGE_SIZE],
  ]);
});

test("auth cooldown legacy cleanup explicitly uses a document scan", () => {
  const calls: unknown[][] = [];
  const documentIdField = { field: "__name__" };
  const query = {
    orderBy: (...args: unknown[]) => {
      calls.push(["orderBy", ...args]);
      return query;
    },
    startAfter: (...args: unknown[]) => {
      calls.push(["startAfter", ...args]);
      return query;
    },
    limit: (...args: unknown[]) => {
      calls.push(["limit", ...args]);
      return query;
    },
  };
  const firestore = {
    collection: (...args: unknown[]) => {
      calls.push(["collection", ...args]);
      return query;
    },
  };

  assert.strictEqual(
    buildCleanupQuery({
      firestore,
      collectionName: "authMethodRevocations",
      documentIdField,
      lastDoc: null,
      nowMs: 100,
      scanLegacy: true,
    }),
    query,
  );
  assert.deepEqual(calls, [
    ["collection", "authMethodRevocations"],
    ["orderBy", documentIdField],
    ["limit", PAGE_SIZE],
  ]);
});

test("auth cooldown legacy execution deletes expired and normalizes active records", async () => {
  const createDoc = (id: string, data: Record<string, unknown>) => ({
    data: () => data,
    ref: { path: `authMethodRevocations/${id}` },
    updateTime: { id },
  });
  const docs = [
    createDoc("expired", { revokedAtMs: 80, cooldownMs: 10 }),
    createDoc("expires", { expiresAtMs: 130 }),
    createDoc("string", { retryAtMs: "140" }),
    createDoc("canonical", { retryAtMs: 150 }),
    createDoc("unknown", {}),
  ];
  const deletes: unknown[][] = [];
  const updates: unknown[][] = [];
  let commits = 0;
  const query = {
    get: async () => ({ empty: false, size: docs.length, docs }),
    limit: () => query,
    orderBy: () => query,
  };
  const firestore = {
    batch: () => ({
      delete: (...args: unknown[]) => deletes.push(args),
      update: (...args: unknown[]) => updates.push(args),
      commit: async () => {
        commits += 1;
      },
    }),
    collection: () => query,
  };

  assert.deepEqual(
    await cleanupCollection({
      firestore,
      collectionName: "authMethodRevocations",
      documentIdField: "__name__",
      dryRun: false,
      nowMs: 100,
      scanLegacy: true,
    }),
    {
      collection: "authMethodRevocations",
      mode: "legacy-compatible",
      candidatesScanned: 5,
      expired: 1,
      deleted: 1,
      activeSkipped: 3,
      unknownSkipped: 1,
      normalizable: 2,
      normalized: 2,
    },
  );
  assert.deepEqual(deletes, [
    [docs[0].ref, { lastUpdateTime: docs[0].updateTime }],
  ]);
  assert.deepEqual(updates, [
    [docs[1].ref, { retryAtMs: 130 }, { lastUpdateTime: docs[1].updateTime }],
    [docs[2].ref, { retryAtMs: 140 }, { lastUpdateTime: docs[2].updateTime }],
  ]);
  assert.equal(commits, 1);
});

test("auth cooldown dry-run reports legacy work without creating a batch", async () => {
  const doc = {
    data: () => ({ expiresAtMs: 130 }),
    ref: { path: "authMethodRevocations/active" },
    updateTime: { id: "active" },
  };
  const query = {
    get: async () => ({ empty: false, size: 1, docs: [doc] }),
    limit: () => query,
    orderBy: () => query,
  };
  const firestore = {
    batch: () => {
      throw new Error("dry-run must not create a batch");
    },
    collection: () => query,
  };

  const summary = await cleanupCollection({
    firestore,
    collectionName: "authMethodRevocations",
    documentIdField: "__name__",
    dryRun: true,
    nowMs: 100,
    scanLegacy: true,
  });

  assert.equal(summary.normalizable, 1);
  assert.equal(summary.normalized, 0);
  assert.equal(summary.deleted, 0);
});

test("auth cooldown cleanup advances after a full page", async () => {
  const docs = Array.from({ length: PAGE_SIZE }, (_, index) => ({
    data: () => ({ retryAtMs: index + 1 }),
    ref: { path: `authMethodRevocations/${index}` },
    updateTime: { index },
  }));
  const snapshots = [
    { empty: false, size: PAGE_SIZE, docs },
    { empty: true, size: 0, docs: [] },
  ];
  const cursors: unknown[] = [];
  const query = {
    get: async () => snapshots.shift(),
    limit: () => query,
    orderBy: () => query,
    startAfter: (cursor: unknown) => {
      cursors.push(cursor);
      return query;
    },
    where: () => query,
  };
  const firestore = {
    collection: () => query,
  };

  const summary = await cleanupCollection({
    firestore,
    collectionName: "authMethodRevocations",
    documentIdField: "__name__",
    dryRun: true,
    nowMs: PAGE_SIZE,
  });

  assert.equal(summary.candidatesScanned, PAGE_SIZE);
  assert.equal(summary.expired, PAGE_SIZE);
  assert.deepEqual(cursors, [docs[docs.length - 1]]);
});

test("auth cooldown mutation failures are not reported as successful", async () => {
  const conflict = new Error("document changed");
  const doc = {
    ref: { path: "authMethodRevocations/conflict" },
    updateTime: { id: "conflict" },
  };
  const firestore = {
    batch: () => ({
      delete: () => {},
      update: () => {},
      commit: async () => {
        throw conflict;
      },
    }),
  };

  await assert.rejects(
    applyCooldownMutations(firestore, [doc], []),
    (error: unknown) => error === conflict,
  );
});
