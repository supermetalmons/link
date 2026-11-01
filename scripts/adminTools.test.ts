import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  cloudflareToken,
  createD1Query,
  createProfileD1Reader,
  isReadOnlySql,
  parseD1Rows,
  type D1Value,
} from "../cloud/admin/_d1.ts";
import { logTopGpWithEmojis } from "../cloud/admin/topGpWithEmojis.ts";
import { logTopMpWithEmojis } from "../cloud/admin/topMpWithEmojis.ts";

import {
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  createLeaderboardHeading,
  parseLeaderboardLimit,
} from "../cloud/admin/leaderboardCli.ts";
import {
  listUniqueAddresses,
  parseArgs as parseAddressArgs,
  writeProtectedFile,
} from "../cloud/admin/listAddresses.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

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
  ] as const) {
    assert.throws(() => parseLeaderboardLimit(argv), /limit/i, argv.join(" "));
  }
});

test("both leaderboard entrypoints parse arguments and preserve delivery keys", () => {
  for (const [filename, key, metric] of [
    ["topGpWithEmojis.ts", "admin:top-gp:", "gp"],
    ["topMpWithEmojis.ts", "admin:top-mp:", "mp"],
  ] as const) {
    const source = readFileSync(
      resolve(repositoryRoot, "cloud/admin", filename),
      "utf8",
    );
    assert.match(source, /parseBridgeSecretFile\(argv\)/);
    assert.match(source, /parseLeaderboardLimit\(remainingArgs\)/);
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
    assert.match(
      source,
      /resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/,
    );
    assert.equal(source.includes("admin.firestore"), false);
  }
});

test("D1 leaderboard entrypoints log counts only", async () => {
  for (const [entrypoint, metric] of [
    [logTopGpWithEmojis, "gp"],
    [logTopMpWithEmojis, "mp"],
  ] as const) {
    const logs: string[] = [];
    let delivered = "";
    await entrypoint(1, {
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
      sendCommand: async (command) => {
        assert.equal(command.kind, "send");
        if (command.kind !== "send")
          throw new Error("Expected a send command.");
        delivered = command.text;
        return {
          ok: true,
          messageKey: command.messageKey,
          revision: "revision",
        };
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

test("admin D1 responses reject malformed rows instead of dropping data", async () => {
  const coordinates = {
    accountId: "a".repeat(32),
    databaseId: "15a77eea-19da-45a7-8433-9b4a22d371da",
  };
  const expected = [
    { profile_id: "profile-1", metric_sort: 4, username: null },
  ];
  const query = createD1Query({
    coordinates,
    token: "test-token",
    fetcher: async () =>
      Response.json({
        success: true,
        result: [{ success: true, results: expected }],
      }),
  });
  assert.deepEqual(await query("SELECT 1"), expected);

  for (const results of [
    null,
    [null],
    [[]],
    [{ nonce: true }],
    [{ nonce: {} }],
    [{ nonce: [4] }],
  ]) {
    const malformed = createD1Query({
      coordinates,
      token: "test-token",
      fetcher: async () =>
        Response.json({
          success: true,
          result: [{ success: true, results }],
        }),
    });
    await assert.rejects(
      malformed("SELECT 1"),
      /Invalid Cloudflare D1 response/,
    );
  }
  assert.throws(
    () => parseD1Rows([{ nonce: Number.NaN }]),
    /Invalid Cloudflare D1 response/,
  );
  assert.throws(
    () => parseD1Rows([{ nonce: Number.POSITIVE_INFINITY }]),
    /Invalid Cloudflare D1 response/,
  );
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
  const calls: Array<{ params: readonly D1Value[]; sql: string }> = [];
  const reader = createProfileD1Reader({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes("profile_canonical_control")) {
        return [{ state: "active" }];
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
  const profile = profiles[0];
  const leaderboardCall = calls[1];
  assert.ok(profile);
  assert.ok(leaderboardCall);
  assert.equal(profile.id, "profile-1");
  assert.equal(profile.emoji, 7);
  assert.deepEqual(leaderboardCall.params, [15]);
  assert.match(leaderboardCall.sql, /nonce_sort_present/);
  assert.match(leaderboardCall.sql, /nonce_sort DESC/);
  assert.match(leaderboardCall.sql, /nonce_sort AS metric_sort/);
  assert.match(
    leaderboardCall.sql,
    /json_extract\(payload_json, '\$\.username'\)/,
  );
  assert.doesNotMatch(leaderboardCall.sql, /SELECT\s+payload_json/);
  assert.doesNotMatch(leaderboardCall.sql, /legacy_fields_json/);
});

test("canonical MP admin reader returns only projected scalars", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE profile_canonical_control (
      singleton INTEGER PRIMARY KEY,
      state TEXT NOT NULL
    );
    INSERT INTO profile_canonical_control VALUES (1, 'active');
    CREATE TABLE profile_records_canonical (
      profile_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      gameplay_emoji INTEGER NOT NULL,
      nonce_sort REAL,
      nonce_sort_present INTEGER NOT NULL,
      mana_points_sort REAL,
      mana_points_sort_present INTEGER NOT NULL
    );
  `);
  database
    .prepare(
      `INSERT INTO profile_records_canonical VALUES (?, 'active', ?, ?, 4, 1, 8, 1)`,
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
      7,
    );
  let leaderboardSql = "";
  const reader = createProfileD1Reader({
    query: async (sql, params = []) => {
      if (!sql.includes("profile_canonical_control")) leaderboardSql = sql;
      return parseD1Rows(database.prepare(sql).all(...params));
    },
  });
  try {
    assert.deepEqual(await reader.readLeaderboard("mp", 90), [
      {
        id: "profile-1",
        emoji: 7,
        username: "name",
        eth: "0xabc",
        sol: null,
        totalManaPoints: 8,
      },
    ]);
    assert.match(leaderboardSql, /json_extract\(payload_json/);
    assert.match(leaderboardSql, /gameplay_emoji,/);
    assert.doesNotMatch(leaderboardSql, /gameplay_emoji_json/);
    assert.doesNotMatch(leaderboardSql, /SELECT\s+payload_json/);
    assert.doesNotMatch(leaderboardSql, /legacy_fields_json/);
  } finally {
    database.close();
  }
});

test("canonical GP admin reader preserves an explicitly null nonce", async () => {
  const reader = createProfileD1Reader({
    query: async (sql: string) =>
      sql.includes("profile_canonical_control")
        ? [{ state: "frozen" }]
        : [
            {
              gameplay_emoji: 0,
              metric_sort: null,
              profile_id: "profile-1",
            },
          ],
  });
  const profiles = await reader.readLeaderboard("gp", 1);
  const profile = profiles[0];
  assert.ok(profile);
  assert.equal(profile.nonce, null);
  assert.equal(profile.emoji, 0);
});

test("canonical profile admin reader requires an operational state and paginates addresses", async () => {
  for (const state of ["unknown", "retired", ""] as const) {
    const inactive = createProfileD1Reader({
      query: async () => [{ state }],
    });
    await assert.rejects(inactive.readLeaderboard("gp", 15), /unavailable/);
  }

  let addressPage = 0;
  const calls: Array<{ params: readonly D1Value[]; sql: string }> = [];
  const reader = createProfileD1Reader({
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes("profile_canonical_control")) {
        return [{ state: "active" }];
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
  const firstPage = calls[1];
  const secondPage = calls[2];
  assert.ok(firstPage);
  assert.ok(secondPage);
  assert.deepEqual(secondPage.params.slice(0, 3), ["eth", "eth", "0499"]);
  assert.match(firstPage.sql, /LIMIT \?/);
});
