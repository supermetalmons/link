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
const {
  ownerProfileIds: eventProjectionOwnerProfileIds,
  parseArgs: parseEventProjectionArgs,
  selectSampleEvent,
  writeRecoveryOutbox,
} = require("../cloud/admin/reconcileEventProfileGames.js");
const {
  auditOrphanedProfileGamesPage,
  parseArgs: parseOrphanAuditArgs,
} = require("../cloud/admin/auditOrphanedProfileGames.js");
const {
  parseArgs: parsePrizeReconciliationArgs,
  reconcileProfileEventPrizesPage,
} = require("../cloud/admin/reconcileProfileEventPrizes.js");
const {
  getEventPrizeAssetAddress,
  getEventPrizeAssetStandard,
} = require("../cloud/functions/eventPrizeProjectionState.js");
const {
  parseArgs: parseProfileLinkReconciliationArgs,
  verifyCanonicalOwnership,
  writeProfileLinkOutbox,
} = require("../cloud/admin/reconcileProfileLinkGames.js");

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

test("event profile-game reconciliation defaults safe and requires a target", () => {
  assert.deepEqual(parseEventProjectionArgs(["--sample"]), {
    adminArgs: [],
    dryRun: true,
    eventId: "",
    sample: true,
    wait: false,
  });
  assert.deepEqual(
    parseEventProjectionArgs([
      "--event-id",
      "event-1",
      "--project",
      "mons-link",
      "--execute",
      "--wait",
    ]),
    {
      adminArgs: ["--project", "mons-link"],
      dryRun: false,
      eventId: "event-1",
      sample: false,
      wait: true,
    },
  );
  for (const argv of [
    [],
    ["--sample", "--event-id", "event-1"],
    ["--sample", "--wait"],
    ["--event-id", "unsafe/path"],
    ["--sample", "--dry-run", "--execute"],
  ]) {
    assert.throws(() => parseEventProjectionArgs(argv), /Usage/);
  }
});

test("event profile-game recovery merges cleanup owners into one due marker", async () => {
  let current: unknown = {
    status: "pending",
    requestId: "old-request",
    cleanupOwnerProfileIds: { "old-owner": true },
  };
  const ref = {
    transaction: async (updater: (value: unknown) => unknown) => {
      current = updater(current);
      return { committed: true };
    },
  };
  await writeRecoveryOutbox({
    database: {
      ref: (path: string) => {
        assert.equal(path, "profileGameProjectionOutbox/event/event-1");
        return ref;
      },
    },
    eventId: "event-1",
    profileIds: ["new-owner"],
    requestId: "manual-request",
  });
  assert.deepEqual(current, {
    schemaVersion: 1,
    status: "pending",
    requestId: "manual-request",
    lastQueuedAtMs: 0,
    reason: null,
    deadAtMs: null,
    cleanupOwnerProfileIds: {
      "old-owner": true,
      "new-owner": true,
    },
  });
  assert.deepEqual(
    eventProjectionOwnerProfileIds({
      participants: {
        a: { profileId: "profile-a" },
        b: { profileId: "unsafe/path" },
      },
    }),
    ["profile-a"],
  );
});

test("event profile-game sample selection paginates by key", async () => {
  const pages = [
    Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `event-${String(index).padStart(3, "0")}`,
        { participants: {} },
      ]),
    ),
    {
      "event-099": { participants: {} },
      "event-100": {
        participants: { owner: { profileId: "profile-a" } },
      },
    },
  ];
  let page = 0;
  const query = {
    limitToFirst: () => query,
    once: async () => {
      const values = pages[page++] || {};
      return {
        forEach: (
          iteratee: (child: { key: string; val: () => unknown }) => unknown,
        ) => {
          for (const [key, value] of Object.entries(values)) {
            iteratee({ key, val: () => value });
          }
        },
      };
    },
    orderByKey: () => query,
    startAt: (cursor: string) => {
      assert.equal(cursor, "event-099");
      return query;
    },
  };
  assert.deepEqual(await selectSampleEvent({ ref: () => query }), {
    eventId: "event-100",
    event: {
      participants: { owner: { profileId: "profile-a" } },
    },
  });
});

test("new projection migration tools default safe and validate modes", () => {
  assert.deepEqual(parseOrphanAuditArgs([]), {
    adminArgs: [],
    after: "",
    dryRun: true,
    limit: 100,
  });
  assert.deepEqual(
    parsePrizeReconciliationArgs([
      "--project",
      "mons-link",
      "--limit",
      "10",
      "--execute",
    ]),
    {
      adminArgs: ["--project", "mons-link"],
      after: "",
      dryRun: false,
      limit: 10,
    },
  );
  assert.deepEqual(parseProfileLinkReconciliationArgs(["--sample"]), {
    adminArgs: [],
    dryRun: true,
    loginUid: "",
    sample: true,
    wait: false,
  });
  for (const parse of [parseOrphanAuditArgs, parsePrizeReconciliationArgs]) {
    assert.throws(() => parse(["--dry-run", "--execute"]), /Usage/);
    assert.throws(() => parse(["--limit", "0"]), /Usage/);
  }
  assert.throws(
    () => parseProfileLinkReconciliationArgs(["--sample", "--wait"]),
    /Usage/,
  );
});

test("new projection migration tools reject duplicate value flags", () => {
  const cases: Array<[(argv: string[]) => unknown, string[]]> = [
    [
      parseOrphanAuditArgs,
      ["--project", "project-1", "--project", "project-2"],
    ],
    [
      parseOrphanAuditArgs,
      ["--database-url", "url-1", "--database-url", "url-2"],
    ],
    [parseOrphanAuditArgs, ["--after", "game-1", "--after", "game-2"]],
    [parseOrphanAuditArgs, ["--limit", "1", "--limit", "2"]],
    [
      parsePrizeReconciliationArgs,
      ["--project", "project-1", "--project", "project-2"],
    ],
    [
      parsePrizeReconciliationArgs,
      ["--database-url", "url-1", "--database-url", "url-2"],
    ],
    [
      parsePrizeReconciliationArgs,
      ["--after", "profile-1", "--after", "profile-2"],
    ],
    [parsePrizeReconciliationArgs, ["--limit", "1", "--limit", "2"]],
    [
      parseProfileLinkReconciliationArgs,
      ["--project", "project-1", "--project", "project-2"],
    ],
    [
      parseProfileLinkReconciliationArgs,
      ["--database-url", "url-1", "--database-url", "url-2"],
    ],
    [
      parseProfileLinkReconciliationArgs,
      ["--login-uid", "login-1", "--login-uid", "login-2"],
    ],
  ];
  for (const [parse, argv] of cases) {
    assert.throws(() => parse(argv), /Usage/, argv.join(" "));
  }
});

test("profile-link reconciliation writes one due request-fenced marker", async () => {
  let current: unknown = {
    cleanupProfileIds: { "older-profile": true },
    requestId: "old-request",
    status: "pending",
  };
  await writeProfileLinkOutbox({
    cleanupProfileIds: ["source-profile", "target-profile"],
    database: {
      ref: (path: string) => {
        assert.equal(path, "profileGameProjectionOutbox/profile/login-1");
        return {
          transaction: async (updater: (value: unknown) => unknown) => {
            current = updater(current);
            return { committed: true };
          },
        };
      },
    },
    loginUid: "login-1",
    profileId: "target-profile",
    requestId: "manual-request",
  });
  assert.deepEqual(current, {
    schemaVersion: 1,
    status: "pending",
    requestId: "manual-request",
    profileId: "target-profile",
    cleanupProfileIds: {
      "older-profile": true,
      "source-profile": true,
    },
    matchCursor: null,
    sourceUpdatedAtMs: (current as Record<string, unknown>).sourceUpdatedAtMs,
    lastQueuedAtMs: 0,
  });
  assert.equal(
    Number.isSafeInteger(
      (current as Record<string, unknown>).sourceUpdatedAtMs,
    ),
    true,
  );
});

test("profile-link verification rejects missing canonical coverage", async () => {
  const values = new Map<string, unknown>([
    ["players/login-1/profile", "profile-1"],
    ["players/login-1/matches", { "invite-1": {} }],
    ["invites/invite-1", { hostId: "login-1", guestId: "guest-1" }],
  ]);
  const snapshot = (value: unknown) => ({
    exists: () => value !== null && value !== undefined,
    val: () => value ?? null,
  });
  const database = {
    ref: (path: string) => ({
      once: async () => snapshot(values.get(path)),
    }),
  };
  const canonicalDocuments: unknown[] = [];
  const firestore = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => ({ docs: canonicalDocuments }),
        }),
      }),
    }),
    collectionGroup: () => ({
      where: () => ({
        get: async () => ({ docs: [], size: 0 }),
      }),
    }),
  };
  await assert.rejects(
    verifyCanonicalOwnership({
      database,
      firestore,
      loginUid: "login-1",
      profileId: "profile-1",
    }),
    /Missing profile game projections: invite-1/,
  );
  canonicalDocuments.push({
    id: "invite-1",
    data: () => ({ ownerLoginId: "login-1" }),
  });
  assert.deepEqual(
    await verifyCanonicalOwnership({
      database,
      firestore,
      loginUid: "login-1",
      profileId: "profile-1",
    }),
    {
      checked: 0,
      expectedInviteIds: ["invite-1"],
      profileId: "profile-1",
    },
  );
});

test("profile-link verification rejects a changed or missing live link", async () => {
  for (const liveProfileId of ["profile-2", null]) {
    const reads: string[] = [];
    const database = {
      ref: (path: string) => {
        reads.push(path);
        return {
          once: async () => ({ val: () => liveProfileId }),
        };
      },
    };
    const firestore = {
      collection: () => assert.fail("must not read projections"),
      collectionGroup: () => assert.fail("must not read projections"),
    };
    await assert.rejects(
      verifyCanonicalOwnership({
        database,
        firestore,
        loginUid: "login-1",
        profileId: "profile-1",
      }),
      /Profile link login-1 no longer points to profile-1/,
    );
    assert.deepEqual(reads, ["players/login-1/profile"]);
  }
});

test("orphan profile-game audit is dry-run safe and deletes confirmed orphans", async () => {
  const existingProfileRef = { path: "users/existing" };
  const missingProfileRef = { path: "users/missing" };
  const documents = [
    {
      ref: {
        path: "users/existing/games/invite-1",
        parent: { parent: existingProfileRef },
      },
    },
    {
      ref: {
        path: "users/missing/games/invite-2",
        parent: { parent: missingProfileRef },
      },
    },
  ];
  const deleted: string[] = [];
  const query = {
    get: async () => ({ docs: documents }),
    limit: () => query,
    orderBy: () => query,
    startAfter: () => query,
  };
  const firestore = {
    batch: () => ({
      delete: (ref: { path: string }) => deleted.push(ref.path),
      commit: async () => undefined,
    }),
    collectionGroup: () => query,
    getAll: async (...refs: Array<{ path: string }>) =>
      refs.map((ref) => ({ exists: ref.path === existingProfileRef.path })),
  };
  const dryRun = await auditOrphanedProfileGamesPage(
    { after: "", dryRun: true, limit: 2 },
    { firestore },
  );
  assert.deepEqual(dryRun.orphaned, ["users/missing/games/invite-2"]);
  assert.deepEqual(deleted, []);
  const execute = await auditOrphanedProfileGamesPage(
    { after: "", dryRun: false, limit: 2 },
    { firestore },
  );
  assert.equal(execute.deleted, 1);
  assert.deepEqual(deleted, ["users/missing/games/invite-2"]);

  const partial = await auditOrphanedProfileGamesPage(
    { after: "", dryRun: true, limit: 1 },
    { firestore },
  );
  assert.equal(partial.hasMore, true);
  assert.equal(partial.complete, false);
});

test("profile-event-prize reconciliation reports conflicts without overwriting", async () => {
  const sourceAssignment = {
    eventId: "NN3eRzoZo80",
    profileId: "source-profile",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 100,
  };
  const values = new Map<string, unknown>([
    ["profileEventPrizes/source-profile", { NN3eRzoZo80: sourceAssignment }],
    [
      "profileEventPrizes/target-profile/NN3eRzoZo80",
      { ...sourceAssignment, profileId: "target-profile", prizeId: "1111" },
    ],
  ]);
  const mapping = {
    id: "source-profile",
    data: () => ({ targetProfileId: "target-profile" }),
  };
  const query = {
    get: async () => ({ docs: [mapping] }),
    limit: () => query,
    orderBy: () => query,
    startAfter: () => query,
  };
  const firestore = {
    collection: () => ({
      doc: (id: string) => ({
        get: async () =>
          id === "source-profile"
            ? { exists: true, data: mapping.data }
            : { exists: false, data: () => null },
      }),
      orderBy: () => query,
    }),
  };
  const database = {
    ref: (path: string) => ({
      once: async () => ({ val: () => values.get(path) ?? null }),
      transaction: async () => ({ committed: false }),
    }),
  };
  const result = await reconcileProfileEventPrizesPage(
    { after: "", dryRun: true, limit: 20 },
    { database, firestore },
  );
  assert.equal(result.complete, false);
  assert.deepEqual(result.conflicts, [
    {
      eventId: "NN3eRzoZo80",
      sourceProfileId: "source-profile",
      targetProfileId: "target-profile",
    },
  ]);
});

test("profile-event-prize reconciliation removes a copy raced by withdrawal", async () => {
  const eventId = "NN3eRzoZo80";
  const prizeId = "1092";
  const sourceAssignment = {
    eventId,
    profileId: "source-profile",
    place: 1,
    prizeId,
    assignedAtMs: 100,
  };
  const sourcePath = "profileEventPrizes/source-profile";
  const targetPath = `profileEventPrizes/target-profile/${eventId}`;
  const withdrawalPath = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
  const completedWithdrawal = {
    status: "completed",
    eventId,
    prizeId,
    assetAddress: getEventPrizeAssetAddress(eventId, prizeId),
    assetStandard: getEventPrizeAssetStandard(eventId, prizeId),
  };
  const values = new Map<string, unknown>([
    [sourcePath, { [eventId]: sourceAssignment }],
    [targetPath, null],
  ]);
  let withdrawalReads = 0;
  const mapping = {
    id: "source-profile",
    data: () => ({ targetProfileId: "target-profile" }),
  };
  const query = {
    get: async () => ({ docs: [mapping] }),
    limit: () => query,
    orderBy: () => query,
    startAfter: () => query,
  };
  const firestore = {
    collection: () => ({
      doc: (id: string) => ({
        get: async () =>
          id === mapping.id
            ? { exists: true, data: mapping.data }
            : { exists: false, data: () => null },
      }),
      orderBy: () => query,
    }),
  };
  const database = {
    ref: (path: string) => ({
      once: async () => ({
        val: () => {
          if (path === withdrawalPath) {
            withdrawalReads += 1;
            return withdrawalReads === 1 ? null : completedWithdrawal;
          }
          return values.get(path) ?? null;
        },
      }),
      transaction: async (updater: (value: unknown) => unknown) => {
        const next = updater(values.get(path) ?? null);
        if (next === undefined) return { committed: false };
        values.set(path, next);
        return { committed: true };
      },
    }),
  };

  await reconcileProfileEventPrizesPage(
    { after: "", dryRun: false, limit: 20 },
    { database, firestore },
  );

  assert.equal(withdrawalReads, 2);
  assert.equal(values.get(targetPath), null);
});

test("profile-event-prize reconciliation does not complete before the last page", async () => {
  const mapping = {
    id: "source-profile",
    data: () => ({ targetProfileId: "target-profile" }),
  };
  const query = {
    get: async () => ({ docs: [mapping, { id: "later-profile" }] }),
    limit: () => query,
    orderBy: () => query,
    startAfter: () => query,
  };
  const firestore = {
    collection: () => ({
      doc: (id: string) => ({
        get: async () =>
          id === mapping.id
            ? { exists: true, data: mapping.data }
            : { exists: false, data: () => null },
      }),
      orderBy: () => query,
    }),
  };
  const database = {
    ref: () => ({
      once: async () => ({ val: () => null }),
    }),
  };

  const result = await reconcileProfileEventPrizesPage(
    { after: "", dryRun: true, limit: 1 },
    { database, firestore },
  );

  assert.equal(result.hasMore, true);
  assert.equal(result.complete, false);
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
