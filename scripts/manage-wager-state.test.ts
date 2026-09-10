import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createSqlDependencies,
  manageWagerState,
  parseArgs,
  execute,
} from "./manage-wager-state.ts";
import {
  canonicalJson,
  digest,
  createWranglerRunner,
  privateDirectory,
  readPrivateJson,
  writePrivateImmutable,
  readResponseJson,
  type SqlRunner,
} from "./operator/runtime.ts";
const VERSION = "11111111-1111-4111-8111-111111111111";
function harness(t: test.TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), "operator-artifact-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory };
}
test("private recovery artifacts are immutable and directory scope rejects repository paths and symlinks", async (t) => {
  const h = harness(t);

  assert.equal(lstatSync(h.directory).mode & 0o777, 0o700);
  for (const name of readdirSync(h.directory))
    assert.equal(lstatSync(resolve(h.directory, name)).mode & 0o777, 0o600);
  assert.throws(
    () => privateDirectory(resolve(import.meta.dirname, "..")),
    /outside/,
  );
  const link = resolve(h.directory, "linked");
  symlinkSync(h.directory, link);
  assert.throws(() => privateDirectory(link), /symlink/);
  const file = resolve(h.directory, "private.json");
  writePrivateImmutable(file, { secret: "private-test-value" });
  writePrivateImmutable(file, { secret: "private-test-value" });
  assert.throws(
    () => writePrivateImmutable(file, { secret: "changed" }),
    /immutable/,
  );
  chmodSync(file, 0o644);
  assert.throws(() => readPrivateJson(file), /private/);
  chmodSync(file, 0o600);
  writeFileSync(file, '{"private-test-value":broken}', { mode: 0o600 });
  assert.throws(
    () => readPrivateJson(file),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("private-test-value"),
  );
});

test("a publisher tolerates a reader recovering its partial link before cleanup", (t) => {
  const h = harness(t);
  const path = resolve(h.directory, "publication.json");
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const link = fs.linkSync;
        let migration;
        fs.linkSync = (...args) => { link(...args); migration.readPrivateJson(args[1]); };
        syncBuiltinESMExports();
        migration = await import(${JSON.stringify(new URL("./operator/runtime.ts", import.meta.url).href)});
        migration.writePrivateImmutable(process.argv[1], { retained: true });
      `,
      path,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(readPrivateJson(path), { retained: true });
  assert.equal(lstatSync(path).nlink, 1);
  assert.deepEqual(readdirSync(h.directory), ["publication.json"]);
});

test("publication recovery rejects unrelated links, extra links and symlinks", (t) => {
  const h = harness(t);
  const file = resolve(h.directory, "private.json");
  const partial = resolve(h.directory, `.partial-${VERSION}`);
  const unrelated = resolve(h.directory, "unrelated.json");
  writePrivateImmutable(file, { retained: true });
  linkSync(file, unrelated);
  assert.throws(() => readPrivateJson(file), /hard links/);
  symlinkSync(file, partial);
  assert.throws(() => readPrivateJson(file), /hard links/);
  assert.throws(() => readPrivateJson(partial));
  assert.equal(lstatSync(partial).isSymbolicLink(), true);
  unlinkSync(partial);
  linkSync(file, partial);
  assert.throws(() => readPrivateJson(file), /hard links/);
  assert.equal(lstatSync(file).nlink, 3);
  unlinkSync(unrelated);
  assert.throws(() => readPrivateJson(file, true), /hard links/);
  assert.throws(() => readPrivateJson(partial), /hard links/);
  assert.equal(lstatSync(file).nlink, 2);
  assert.deepEqual(readPrivateJson(file), { retained: true });
  assert.equal(existsSync(partial), false);
});

test("D1 runner sends query bindings in authenticated HTTP bodies and rejects bulk import summaries", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const run = createWranglerRunner({
    apiToken: "test-api-token",
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init! });
      return Response.json({
        success: true,
        result: [{ success: true, results: [{ singleton: 1 }] }],
      });
    }) as typeof fetch,
  });
  const sql = "INSERT INTO fixture VALUES (?) RETURNING singleton";
  assert.deepEqual(
    await run(sql, "mons-link-profiles", ["private-wager-content"]),
    [{ singleton: 1 }],
  );
  assert.match(
    requests[0].url,
    /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/d1\/database\/[a-f0-9-]{36}\/query$/,
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    sql,
    params: ["private-wager-content"],
  });
  assert.equal(
    (requests[0].init.headers as Record<string, string>).Authorization,
    "Bearer test-api-token",
  );
  assert.equal(requests[0].init.redirect, "error");
  const invalid = createWranglerRunner({
    apiToken: "test-api-token",
    fetcher: (async () =>
      Response.json({
        success: true,
        result: [{ success: true, results: [{ "Total queries executed": 1 }] }],
      })) as typeof fetch,
  });
  await assert.rejects(
    invalid("SELECT singleton FROM fixture"),
    /bulk import summary/,
  );
  const noToken = createWranglerRunner({ apiToken: "" });
  await assert.rejects(
    noToken(sql, "mons-link-profiles", ["private-wager-content"]),
    /private values/,
  );
});
test("retired commands reject before credentials or provider requests", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("unexpected provider request");
  });
  for (const flag of [
    "--preflight",
    "--export",
    "--import",
    "--verify",
    "--activate",
    "--resume",
  ]) {
    assert.throws(() => parseArgs([flag]), /retired/);
    await assert.rejects(execute([flag]), /retired/);
  }
  assert.equal(requests, 0);
  assert.deepEqual(parseArgs(["--status"]).operation, "status");
  assert.throws(() =>
    parseArgs(["--status", "--firebase-credentials", "/missing"]),
  );
});
test("wager status preserves activation, maintenance and row-count diagnostics using read-only SQL", async () => {
  const queries: string[] = [];
  const activation: Record<string, unknown> = { activation_epoch: 1 };
  for (const field of [
    "import_attempt_id",
    "source_digest",
    "import_digest",
    "baseline_digest",
    "verified_baseline_digest",
    "source_wager_count",
    "source_marker_count",
    "source_row_count",
    "imported_row_count",
    "verified_freeze_generation",
    "verified_at_ms",
    "activated_at_ms",
    "candidate_version_id",
  ])
    activation[field] = null;
  activation.activated_at_ms = 10;
  const run: SqlRunner = async (sql, database) => {
    queries.push(sql);
    assert.match(sql, /^SELECT /);
    if (sql.includes("wager_state_activation")) return [activation];
    if (sql.includes("profile.state"))
      return [
        {
          profile_state: "active",
          reservation_state: "d1",
          freeze_generation: 4,
          admissions: 0,
        },
      ];
    if (database === "mons-link-profile-games") return [{ count: 0 }];
    return [
      {
        row_count: 3,
        wager_count: 2,
        marker_count: 1,
        non_initial_revisions: 2,
      },
    ];
  };
  const deps = createSqlDependencies(run, () => 100);
  const logs: Record<string, unknown>[] = [];
  deps.log = (value) => logs.push(value);
  await manageWagerState(parseArgs(["--status"]), deps);
  assert.equal(queries.length, 4);
  assert.deepEqual(logs[0].destination, {
    rowCount: 3,
    wagerCount: 2,
    markerCount: 1,
    nonInitialRevisions: 2,
  });
  assert.equal(
    (logs[0].activation as { activatedAtMs: number }).activatedAtMs,
    10,
  );
});
test("shared evidence encoding preserves sorted JSON and rejects unsafe numbers", () => {
  assert.equal(
    canonicalJson({ z: [false, null, 2], a: { b: 1 } }),
    '{"a":{"b":1},"z":[false,null,2]}',
  );
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ x: NaN }), /unsafe/);
  assert.throws(
    () => canonicalJson({ x: Number.MAX_SAFE_INTEGER + 1 }),
    /unsafe/,
  );
});
test("bounded response reader cancels oversized evidence without logging payloads", async () => {
  await assert.rejects(
    readResponseJson(Response.json({ private: "payload" }), 5),
    /exceeds/,
  );
  await assert.rejects(
    readResponseJson(new Response("private-body", { status: 500 })),
    (error) =>
      error instanceof Error && !error.message.includes("private-body"),
  );
});
test("publication resumes after a process exits between linking and partial cleanup", (t) => {
  const h = harness(t);
  const path = resolve(h.directory, "evidence.json");
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const link=fs.linkSync;fs.linkSync=(...args)=>{link(...args);process.exit(23);};syncBuiltinESMExports();const helper=await import(${JSON.stringify(new URL("./operator/runtime.ts", import.meta.url).href)});helper.writePrivateImmutable(process.argv[1],{retained:true});`,
      path,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 23, child.stderr);
  assert.equal(lstatSync(path).nlink, 2);
  assert.deepEqual(readPrivateJson(path), { retained: true });
  assert.equal(lstatSync(path).nlink, 1);
  assert.deepEqual(readdirSync(h.directory), ["evidence.json"]);
});
