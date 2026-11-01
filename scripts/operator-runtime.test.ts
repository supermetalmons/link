import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
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
  canonicalJson,
  digest,
  createWranglerRunner,
  privateDirectory,
  readPrivateJson,
  writePrivateImmutable,
  readResponseJson,
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
  chmodSync(file, 0o400);
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
        let operator;
        fs.linkSync = (...args) => { link(...args); operator.readPrivateJson(args[1]); };
        syncBuiltinESMExports();
        operator = await import(${JSON.stringify(new URL("./operator/runtime.ts", import.meta.url).href)});
        operator.writePrivateImmutable(process.argv[1], { retained: true });
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
  assert.throws(() => readPrivateJson(partial), /hard links/);
  assert.equal(lstatSync(file).nlink, 2);
  assert.deepEqual(readPrivateJson(file), { retained: true });
  assert.equal(existsSync(partial), false);
});

test("65 MiB private artifacts require an explicit bounded allowance through replay and conflict reads", (t) => {
  const { directory } = harness(t),
    path = resolve(directory, "large-evidence.json"),
    payload = "x".repeat(65 * 1024 * 1024),
    evidence = { payload },
    options = { maximumBytes: 128 * 1024 * 1024 };
  assert.throws(
    () => writePrivateImmutable(path, evidence),
    /exceeds the 64 MiB limit/,
  );
  assert.equal(existsSync(path), false);
  writePrivateImmutable(path, evidence, options);
  assert.ok(lstatSync(path).size > 65 * 1024 * 1024);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.throws(() => readPrivateJson(path), /no larger than 64 MiB/);
  const restored = readPrivateJson(path, options) as { payload: string };
  assert.equal(restored.payload, payload);
  writePrivateImmutable(path, evidence, options);
  assert.throws(
    () => writePrivateImmutable(path, { payload, changed: true }, options),
    /immutable artifact conflict/,
  );
  assert.deepEqual(readdirSync(directory), ["large-evidence.json"]);
});

test("explicit size allowance reaches the publication race read without weakening conflict checks", (t) => {
  const { directory } = harness(t);
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const options = { maximumBytes: 128 * 1024 * 1024 };
      const payload = "x".repeat(65 * 1024 * 1024);
      const read = fs.readFileSync, write = fs.writeFileSync;
      const operator = await import(${JSON.stringify(new URL("./operator/runtime.ts", import.meta.url).href)});
      let conflict = false, raceReads = 0;
      fs.linkSync = (temporary, path) => {
        const value = conflict ? JSON.stringify({ payload, changed: true }) : read(temporary);
        write(path, value, { mode: 0o600, flag: "wx" });
        const error = new Error("publication-race");
        error.code = "EEXIST";
        throw error;
      };
      fs.readFileSync = (...args) => { raceReads++; return read(...args); };
      syncBuiltinESMExports();
      const equalPath = process.argv[1] + "/equal.json";
      operator.writePrivateImmutable(equalPath, { payload }, options);
      assert.equal(raceReads, 1);
      conflict = true;
      assert.throws(() => operator.writePrivateImmutable(process.argv[1] + "/conflict.json", { payload }, options), /publication-race/);
      assert.equal(raceReads, 2);
      assert.deepEqual(fs.readdirSync(process.argv[1]).sort(), ["conflict.json", "equal.json"]);
    `,
      directory,
    ],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(child.status, 0, child.stderr);
});

test("invalid and above-ceiling private artifact limits fail before filesystem access", (t) => {
  const { directory } = harness(t);
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const operator = await import(${JSON.stringify(new URL("./operator/runtime.ts", import.meta.url).href)});
      let calls = 0;
      for (const name of ["openSync", "readFileSync", "existsSync", "writeFileSync", "linkSync"]) fs[name] = () => { calls++; throw new Error("filesystem-access-forbidden"); };
      syncBuiltinESMExports();
      for (const maximumBytes of [0, -1, 0.5, NaN, Infinity, -Infinity, 128 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER + 1, null, "128 MiB"]) {
        const options = { maximumBytes };
        assert.throws(() => operator.readPrivateJson(process.argv[1], options), /invalid-private-artifact-size-limit/);
        assert.throws(() => operator.writePrivateImmutable(process.argv[1], { safe: true }, options), /invalid-private-artifact-size-limit/);
      }
      assert.equal(calls, 0);
    `,
      resolve(directory, "nonexistent.json"),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(readdirSync(directory), []);
});

test("private artifacts above 128 MiB fail the stat bound before content allocation", (t) => {
  const { directory } = harness(t),
    path = resolve(directory, "over-limit.json");
  const fd = openSync(path, "wx", 0o600);
  try {
    ftruncateSync(fd, 128 * 1024 * 1024 + 1);
  } finally {
    closeSync(fd);
  }
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const operator = await import(${JSON.stringify(new URL("./operator/runtime.ts", import.meta.url).href)});
      let reads = 0;
      fs.readFileSync = () => { reads++; throw new Error("content-allocation-forbidden"); };
      syncBuiltinESMExports();
      assert.throws(() => operator.readPrivateJson(process.argv[1], { maximumBytes: 128 * 1024 * 1024 }), /no larger than 128 MiB/);
      assert.throws(() => operator.readPrivateJson(process.argv[1]), /no larger than 64 MiB/);
      assert.equal(reads, 0);
    `,
      path,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
});

test("an explicit size allowance preserves hard-link and symlink rejection", (t) => {
  const { directory } = harness(t),
    path = resolve(directory, "evidence.json"),
    unrelated = resolve(directory, "unrelated.json"),
    alias = resolve(directory, "alias.json"),
    options = { maximumBytes: 128 * 1024 * 1024 };
  writePrivateImmutable(path, { kept: true }, options);
  linkSync(path, unrelated);
  assert.throws(() => readPrivateJson(path, options), /hard links/);
  assert.throws(
    () => writePrivateImmutable(path, { kept: true }, options),
    /hard links/,
  );
  unlinkSync(unrelated);
  symlinkSync(path, alias);
  assert.throws(() => readPrivateJson(alias, options));
  assert.throws(() => writePrivateImmutable(alias, { kept: true }, options));
  assert.deepEqual(readPrivateJson(path, options), { kept: true });
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
  assert.ok(requests[0]);
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

test("exact typed REAL evidence round-trips every finite double without loosening untyped integers", async (t) => {
  const { directory } = harness(t);
  const values = [
    0,
    1512.5,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    2 ** 53,
    -(2 ** 53),
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ];
  const evidence = {
    rows: values.map((value) => ({ rating: { kind: "real", value } })),
  };
  const path = resolve(directory, "real-evidence.json");
  writePrivateImmutable(path, evidence);
  writePrivateImmutable(path, evidence);
  const restored = readPrivateJson(path);
  assert.deepEqual(restored, evidence);
  assert.equal(digest(restored), digest(evidence));
  assert.deepEqual(await readResponseJson(Response.json(evidence)), evidence);
  assert.equal(
    canonicalJson({ value: 1.5, kind: "real" }),
    '{"kind":"real","value":1.5}',
  );
  for (const value of [
    2 ** 53,
    -(2 ** 53),
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ]) {
    assert.throws(() => canonicalJson({ rating: value }), /unsafe-json-number/);
    await assert.rejects(
      readResponseJson(Response.json({ rating: value })),
      /unsafe-json-number/,
    );
  }
});

test("REAL evidence tags reject nonfinite values and cannot disguise unsafe integers in other shapes", () => {
  for (const value of [NaN, Infinity, -Infinity])
    assert.throws(
      () => canonicalJson({ kind: "real", value }),
      /unsafe-json-number/,
    );
  for (const value of [
    { kind: "real", value: 2 ** 53, extra: true },
    { kind: "integer", value: 2 ** 53 },
    { kind: "real", value: { nested: 2 ** 53 } },
    { value: 2 ** 53 },
  ])
    assert.throws(() => canonicalJson(value), /unsafe-json-number/);
  assert.equal(
    canonicalJson({ kind: "integer", decimal: "9223372036854775807" }),
    '{"decimal":"9223372036854775807","kind":"integer"}',
  );
});
