const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
}: typeof import("node:fs") = require("node:fs");
const { tmpdir }: typeof import("node:os") = require("node:os");
const { join, resolve }: typeof import("node:path") = require("node:path");
const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
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
  listUniqueAddresses,
  parseArgs: parseAddressArgs,
  writeProtectedFile,
} = require("../cloud/admin/listAddresses.js");

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
    assert.match(source, /createProfileD1Reader/);
    assert.match(source, /readLeaderboard/);
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
    assert.equal(source.includes("admin.firestore"), false);
  }
});

test("D1 leaderboard entrypoints reject Firebase targets and log counts only", async () => {
  for (const [filename, exportName, metric] of [
    ["topGpWithEmojis.js", "logTopGpWithEmojis", "gp"],
    ["topMpWithEmojis.js", "logTopMpWithEmojis", "mp"],
  ]) {
    const entrypoint = require(
      resolve(repositoryRoot, "cloud/admin", filename),
    )[exportName] as (
      limit: number,
      adminArgs: string[],
      dependencies: Record<string, unknown>,
    ) => Promise<void>;
    await assert.rejects(
      entrypoint(1, ["--project", "staging"], {}),
      /not supported/,
    );
    const logs: string[] = [];
    let delivered = "";
    await entrypoint(1, [], {
      reader: {
        readLeaderboard: async () => [
          {
            id: "private-profile",
            nonce: 4,
            totalManaPoints: 8,
            emoji: 1,
            username: "PrivateName",
            eth: null,
            sol: null,
          },
        ],
      },
      sendCommand: async (command: { text: string }) => {
        delivered = command.text;
      },
      log: (message: string) => logs.push(message),
    });
    assert.match(delivered, new RegExp(`top 1 ${metric}`));
    assert.deepEqual(logs, [
      JSON.stringify({ event: `admin_top_${metric}_dispatched`, count: 1 }),
    ]);
    assert.doesNotMatch(logs.join("\n"), /PrivateName|private-profile/);
  }
});

test("canonical profile admin adapter rejects mutating SQL", async () => {
  const {
    cloudflareToken,
    createD1Query,
    isReadOnlySql,
  } = require("../cloud/admin/_d1.js");
  assert.throws(() => cloudflareToken({}), /CLOUDFLARE_API_TOKEN.*D1 Read/);
  assert.equal(
    cloudflareToken({ CLOUDFLARE_API_TOKEN: " read-token " }),
    "read-token",
  );
  const query = createD1Query({
    coordinates: {
      accountId: "a".repeat(32),
      databaseId: "15a77eea-19da-45a7-8433-9b4a22d371da",
    },
    fetcher: async () => {
      throw new Error("mutating SQL must not reach fetch");
    },
    token: "token",
  });
  await assert.rejects(
    query("DELETE FROM profile_records"),
    /read-only queries only/,
  );
  await assert.rejects(
    query("WITH selected AS (SELECT 1) DELETE FROM profile_records"),
    /read-only queries only/,
  );
  await assert.rejects(
    query("SELECT 1; DELETE FROM profile_records"),
    /read-only queries only/,
  );
  assert.equal(isReadOnlySql("SELECT 1"), true);
  assert.equal(isReadOnlySql("SELECT 1;"), true);
  assert.equal(isReadOnlySql("EXPLAIN QUERY PLAN SELECT 1"), true);
  assert.equal(isReadOnlySql("WITH selected AS (SELECT 1) SELECT 1"), false);
});

test("address export requires protected destinations and logs counts only", async () => {
  assert.throws(() => parseAddressArgs([]), /Usage/);
  assert.throws(() => parseAddressArgs(["--out-eth"]), /Usage/);
  assert.throws(
    () => parseAddressArgs(["--out-eth", "one", "--out-eth", "two"]),
    /Usage/,
  );
  assert.throws(
    () =>
      parseAddressArgs([
        "--out-eth",
        "/secure/same.txt",
        "--out-sol",
        "/secure/same.txt",
      ]),
    /Usage/,
  );
  assert.deepEqual(parseAddressArgs(["--out-eth", "/secure/eth.txt"]), {
    outEth: "/secure/eth.txt",
    outSol: null,
  });

  let readerCalled = false;
  await assert.rejects(
    listUniqueAddresses({
      reader: {
        listAddresses: async () => {
          readerCalled = true;
          return [];
        },
      },
    }),
    /Usage/,
  );
  assert.equal(readerCalled, false);

  const writes: Array<{ path: string; values: string[] }> = [];
  const logs: string[] = [];
  await listUniqueAddresses({
    outEth: "/secure/eth.txt",
    outSol: "/secure/sol.txt",
    reader: {
      listAddresses: async () => [
        { method: "eth", value: "0xABC" },
        { method: "sol", value: "private-sol-address" },
      ],
    },
    writeFile: (path: string, values: string[]) => {
      writes.push({ path, values });
    },
    log: (message: string) => logs.push(message),
  });
  assert.deepEqual(writes, [
    { path: "/secure/eth.txt", values: ["0xabc"] },
    { path: "/secure/sol.txt", values: ["private-sol-address"] },
  ]);
  assert.deepEqual(logs, [
    "ETH addresses exported: 1",
    "SOL addresses exported: 1",
  ]);
  assert.doesNotMatch(logs.join("\n"), /0xabc|private-sol|\/secure\//i);

  const directory = mkdtempSync(join(tmpdir(), "mons-address-export-"));
  const path = join(directory, "addresses.txt");
  try {
    writeProtectedFile(path, ["private-address"]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), "private-address\n");
    assert.throws(() => writeProtectedFile(path, ["replacement"]), /EEXIST/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("canonical profile admin reader parses bounded profiles", async () => {
  const { createProfileD1Reader } = require("../cloud/admin/_d1.js");
  const calls: Array<{ params: unknown[]; sql: string }> = [];
  const reader = createProfileD1Reader({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("profile_canonical_control")) {
        return [{ state: "active", imported_at_ms: 1 }];
      }
      return [
        {
          eth: null,
          eth_type: "null",
          gameplay_emoji: 7,
          metric_sort: 4,
          profile_id: "profile-1",
          sol: null,
          sol_type: "null",
          username: null,
          username_type: "null",
        },
      ];
    },
  });
  const profiles = await reader.readLeaderboard("gp", 15);
  assert.equal(profiles[0].id, "profile-1");
  assert.equal(profiles[0].emoji, 7);
  assert.deepEqual(calls[1].params, [15]);
  assert.match(calls[1].sql, /nonce_sort_present/);
  assert.match(calls[1].sql, /nonce_sort DESC/);
  assert.match(calls[1].sql, /nonce_sort AS metric_sort/);
  assert.match(calls[1].sql, /json_extract\(payload_json, '\$\.username'\)/);
  assert.doesNotMatch(calls[1].sql, /SELECT\s+payload_json/);
  assert.doesNotMatch(calls[1].sql, /legacy_fields_json/);
});

test("canonical MP admin reader returns only projected scalars", async () => {
  const { createProfileD1Reader } = require("../cloud/admin/_d1.js");
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE profile_canonical_control (
      singleton INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      imported_at_ms INTEGER
    );
    INSERT INTO profile_canonical_control VALUES (1, 'active', 1);
    CREATE TABLE profile_records (
      profile_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      gameplay_emoji_json TEXT NOT NULL,
      nonce_sort REAL,
      nonce_sort_present INTEGER NOT NULL,
      mana_points_sort REAL,
      mana_points_sort_present INTEGER NOT NULL
    );
  `);
  database
    .prepare(
      `INSERT INTO profile_records VALUES (?, 'active', ?, ?, 4, 1, 8, 1)`,
    )
    .run(
      "profile-1",
      JSON.stringify({
        eth: "0xabc",
        ignored: "x".repeat(700_000),
        sol: null,
        totalManaPoints: 8,
        username: "name",
      }),
      JSON.stringify("7"),
    );
  let leaderboardSql = "";
  const reader = createProfileD1Reader({
    query: async (sql: string, params: unknown[] = []) => {
      if (!sql.includes("profile_canonical_control")) leaderboardSql = sql;
      return database
        .prepare(sql)
        .all(...(params as Array<null | number | string>));
    },
  });
  try {
    assert.deepEqual(await reader.readLeaderboard("mp", 90), [
      {
        id: "profile-1",
        emoji: "7",
        username: "name",
        eth: "0xabc",
        sol: null,
        totalManaPoints: 8,
      },
    ]);
    assert.match(leaderboardSql, /json_extract\(payload_json/);
    assert.match(leaderboardSql, /json_extract\(gameplay_emoji_json/);
    assert.doesNotMatch(leaderboardSql, /SELECT\s+payload_json/);
    assert.doesNotMatch(leaderboardSql, /legacy_fields_json/);
  } finally {
    database.close();
  }
});

test("canonical GP admin reader preserves an explicitly null nonce", async () => {
  const { createProfileD1Reader } = require("../cloud/admin/_d1.js");
  const reader = createProfileD1Reader({
    query: async (sql: string) =>
      sql.includes("profile_canonical_control")
        ? [{ state: "frozen", imported_at_ms: 1 }]
        : [
            {
              gameplay_emoji: "",
              metric_sort: null,
              profile_id: "profile-1",
            },
          ],
  });
  const profiles = await reader.readLeaderboard("gp", 1);
  assert.equal(profiles[0].nonce, null);
  assert.equal(profiles[0].emoji, "");
});

test("canonical profile admin reader gates import finalization and paginates addresses", async () => {
  const { createProfileD1Reader } = require("../cloud/admin/_d1.js");
  for (const [state, importedAtMs] of [
    ["firestore", null],
    ["importing", null],
    ["verifying", 1],
  ] as const) {
    const inactive = createProfileD1Reader({
      query: async () => [{ state, imported_at_ms: importedAtMs }],
    });
    await assert.rejects(inactive.readLeaderboard("gp", 15), /not imported/);
  }

  let addressPage = 0;
  const calls: Array<{ params: unknown[]; sql: string }> = [];
  const reader = createProfileD1Reader({
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("profile_canonical_control")) {
        return [{ state: "active", imported_at_ms: 1 }];
      }
      addressPage += 1;
      if (addressPage === 1) {
        return Array.from({ length: 500 }, (_, index) => ({
          method: "eth",
          normalized_value: String(index).padStart(4, "0"),
          raw_value: `0x${String(index).padStart(40, "0")}`,
        }));
      }
      return [
        {
          method: "sol",
          normalized_value: "last",
          raw_value: "private-sol-address",
        },
      ];
    },
  });
  const addresses = await reader.listAddresses();
  assert.equal(addresses.length, 501);
  assert.deepEqual(calls[2].params.slice(0, 3), ["eth", "eth", "0499"]);
  assert.match(calls[1].sql, /LIMIT \?/);
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
