import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  backfillHistoricalMatches,
  compareFirebaseKeys,
  parseArgs,
  summarizeBackfill,
  type BackfillOptions,
} from "./backfill-historical-matches.ts";

const base: BackfillOptions = {
  baseUrl: "https://api.mons.link",
  execute: false,
  failureFile: null,
  pageSize: 2,
  project: "mons-link",
  startAt: null,
};

test("parses dry-run and protected execute modes", () => {
  assert.deepEqual(
    parseArgs([
      "--project",
      "mons-link",
      "--base-url",
      "https://api.mons.link",
    ]),
    { ...base, pageSize: 100 },
  );
  assert.throws(() =>
    parseArgs([
      "--project",
      "mons-link",
      "--base-url",
      "https://api.mons.link",
      "--execute",
    ]),
  );
  assert.equal(
    parseArgs([
      "--project",
      "mons-link",
      "--base-url",
      "https://api.mons.link",
      "--execute",
      "--failure-file",
      "/secure/failures.json",
    ]).execute,
    true,
  );
});

test("paginates inclusively and derives historical matches without writes", async () => {
  const cursors: Array<string | null> = [];
  const result = await backfillHistoricalMatches(base, {
    archive: async () => {
      throw new Error("dry-run-must-not-archive");
    },
    log: () => undefined,
    readPage: async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? [
            {
              inviteId: "a",
              value: { hostRematches: "1", guestRematches: "1" },
            },
            {
              inviteId: "b",
              value: { hostRematches: "1x", guestRematches: "1" },
            },
            { inviteId: "c", value: {} },
          ]
        : [
            { inviteId: "b", value: {} },
            { inviteId: "c", value: {} },
          ];
    },
  });
  assert.deepEqual(cursors, [null, "b"]);
  assert.equal(result.invites, 3);
  assert.equal(result.discovered, 3);
  assert.equal(result.archived, 0);
});

test("uses Firebase key ordering across unordered pages", async () => {
  assert.deepEqual(
    [
      "z",
      "A",
      "a",
      "Z",
      "10",
      "2",
      "9",
      "01",
      "001",
      "2147483648",
      "-2147483649",
      "0",
    ].sort(compareFirebaseKeys),
    [
      "0",
      "01",
      "001",
      "2",
      "9",
      "10",
      "-2147483649",
      "2147483648",
      "A",
      "Z",
      "a",
      "z",
    ],
  );
  const all = ["2", "9", "10", "A"];
  const cursors: Array<string | null> = [];
  const result = await backfillHistoricalMatches(base, {
    archive: async () => true,
    log: () => undefined,
    readPage: async (cursor, limit) => {
      cursors.push(cursor);
      return all
        .filter(
          (inviteId) =>
            cursor === null || compareFirebaseKeys(inviteId, cursor) >= 0,
        )
        .slice(0, limit)
        .reverse()
        .map((inviteId) => ({
          inviteId,
          value: { hostRematches: "x" },
        }));
    },
  });
  assert.deepEqual(cursors, [null, "9", "A"]);
  assert.equal(result.invites, 4);
  assert.equal(result.discovered, 4);
});

test("records unresolved execute items in a protected failure report", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mons-history-backfill-"));
  const failureFile = join(directory, "failures.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let pageReads = 0;
  const result = await backfillHistoricalMatches(
    { ...base, execute: true, failureFile },
    {
      archive: async (_inviteId, matchId) => matchId !== "a1",
      log: () => undefined,
      readPage: async () => {
        pageReads++;
        return [
          {
            inviteId: "a",
            value: { hostRematches: "1x", guestRematches: "1" },
          },
          { inviteId: "b", value: {} },
          { inviteId: "c", value: {} },
        ];
      },
    },
  );
  assert.equal(result.discovered, 2);
  assert.equal(result.archived, 1);
  assert.deepEqual(result.failures, ["a/a1"]);
  assert.equal(result.lastCursor, null);
  assert.equal(pageReads, 1);
  assert.equal(statSync(failureFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(failureFile, "utf8")), {
    failures: ["a/a1"],
  });
  assert.deepEqual(summarizeBackfill(result), {
    archived: 1,
    cursor: null,
    discovered: 2,
    failures: 1,
    invites: 2,
  });
  assert.equal(
    JSON.stringify(summarizeBackfill(result)).includes("a/a1"),
    false,
  );
});

test("reserves the failure report before reading or archiving", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mons-history-backfill-"));
  const existingFile = join(directory, "existing.json");
  const unavailableFile = join(directory, "missing", "failures.json");
  writeFileSync(existingFile, "existing", { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let archives = 0;
  let pageReads = 0;
  const dependencies = {
    archive: async () => {
      archives++;
      return true;
    },
    log: () => undefined,
    readPage: async () => {
      pageReads++;
      return [{ inviteId: "a", value: { hostRematches: "x" } }];
    },
  };
  await assert.rejects(
    backfillHistoricalMatches(
      { ...base, execute: true, failureFile: existingFile },
      dependencies,
    ),
  );
  await assert.rejects(
    backfillHistoricalMatches(
      { ...base, execute: true, failureFile: unavailableFile },
      dependencies,
    ),
  );
  assert.equal(readFileSync(existingFile, "utf8"), "existing");
  assert.equal(pageReads, 0);
  assert.equal(archives, 0);
});

test("archives every match in long series with bounded concurrency", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mons-history-backfill-"));
  const failureFile = join(directory, "failures.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const rematches = Array.from({ length: 257 }, (_, index) => index + 1).join(
    ";",
  );
  const seen = new Set<string>();
  let active = 0;
  let maxActive = 0;
  const result = await backfillHistoricalMatches(
    { ...base, execute: true, failureFile },
    {
      archive: async (_inviteId, matchId) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolveImmediate) =>
          setImmediate(resolveImmediate),
        );
        seen.add(matchId);
        active--;
        return true;
      },
      log: () => undefined,
      readPage: async () => [
        {
          inviteId: "series",
          value: {
            hostRematches: `${rematches}x`,
            guestRematches: rematches,
          },
        },
      ],
    },
  );
  assert.equal(result.discovered, 258);
  assert.equal(result.archived, 258);
  assert.equal(result.failures.length, 0);
  assert.equal(seen.size, 258);
  assert.ok(maxActive <= 4);
  assert.deepEqual(JSON.parse(readFileSync(failureFile, "utf8")), {
    failures: [],
  });
});
