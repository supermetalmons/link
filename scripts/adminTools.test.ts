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
  buildCleanupQuery,
  cleanupCollection,
  deleteDocuments,
  parseArgs: parseCleanupArgs,
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
    assert.match(source, /sendCommand/);
    assert.match(source, /randomUUID/);
    assert.match(
      source,
      new RegExp(`createLeaderboardHeading\\("${metric}", limit\\)`),
    );
    assert.match(source, new RegExp(key));
    assert.match(source, /parseMode: "HTML"/);
    assert.equal(source.includes('ref("telegramMessages")'), false);
    assert.match(source, /if \(require\.main === module\)/);
  }
});

test("auth cooldown cleanup covers both canonical collections", () => {
  assert.deepEqual(AUTH_COOLDOWN_COLLECTIONS, [
    "authMethodRevocations",
    "authProfileMethodCooldowns",
  ]);
});

test("auth cooldown cleanup defaults safe and requires explicit execution", () => {
  assert.deepEqual(parseCleanupArgs([]), { dryRun: true });
  assert.deepEqual(parseCleanupArgs(["--project", "mons-link"]), {
    dryRun: true,
  });
  assert.deepEqual(
    parseCleanupArgs([
      "--project",
      "mons-link",
      "--database-url",
      "https://mons-link-default-rtdb.firebaseio.com",
    ]),
    { dryRun: true },
  );
  assert.deepEqual(parseCleanupArgs(["--project", "mons-link", "--execute"]), {
    dryRun: false,
  });
  for (const argv of [
    ["--dry-rnu"],
    ["--project"],
    ["--project", "--execute"],
    ["--dry-run", "--execute"],
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
      lastDoc: cursor,
      nowMs: 100,
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

test("auth cooldown cleanup reclassifies indexed candidates", async () => {
  const docs = [
    {
      data: () => ({ retryAtMs: 50 }),
      ref: { path: "authMethodRevocations/expired" },
      updateTime: { id: "expired" },
    },
    {
      data: () => ({ retryAtMs: 0, expiresAtMs: 200 }),
      ref: { path: "authMethodRevocations/active-fallback" },
      updateTime: { id: "active-fallback" },
    },
  ];
  const deletes: unknown[][] = [];
  let commits = 0;
  const query = {
    get: async () => ({ empty: false, size: docs.length, docs }),
    limit: () => query,
    orderBy: () => query,
    where: () => query,
  };
  const firestore = {
    batch: () => ({
      delete: (...args: unknown[]) => deletes.push(args),
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
      dryRun: false,
      nowMs: 100,
    }),
    {
      collection: "authMethodRevocations",
      candidatesScanned: 2,
      expired: 1,
      deleted: 1,
    },
  );
  assert.deepEqual(deletes, [
    [docs[0].ref, { lastUpdateTime: docs[0].updateTime }],
  ]);
  assert.equal(commits, 1);
});

test("auth cooldown dry-run reports indexed candidates without a batch", async () => {
  const doc = {
    data: () => ({ retryAtMs: 50 }),
    ref: { path: "authMethodRevocations/expired" },
    updateTime: { id: "expired" },
  };
  const query = {
    get: async () => ({ empty: false, size: 1, docs: [doc] }),
    limit: () => query,
    orderBy: () => query,
    where: () => query,
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
    dryRun: true,
    nowMs: 100,
  });

  assert.equal(summary.candidatesScanned, 1);
  assert.equal(summary.expired, 1);
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
      commit: async () => {
        throw conflict;
      },
    }),
  };

  await assert.rejects(
    deleteDocuments(firestore, [doc]),
    (error: unknown) => error === conflict,
  );
});
