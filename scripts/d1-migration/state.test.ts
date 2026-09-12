import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  artifact,
  loadManifest,
  manifestFiles,
  openMigrationDirectory,
  saveManifest,
  type MigrationManifest,
} from "./state.ts";

function directory(t: TestContext): string {
  const path = mkdtempSync(resolve(tmpdir(), "mons-d1-state-test-"));
  chmodSync(path, 0o700);
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function manifest(): MigrationManifest {
  return {
    schemaVersion: 1,
    revision: 0,
    previousDigest: null,
    runId: "test-migration",
    createdAt: "2026-09-12T12:00:00.000Z",
    accountId: "a".repeat(32),
    workerName: "mons-link-api",
    originalVersionId: "00000000-0000-4000-8000-000000000001",
    namespaceId: "00000000-0000-4000-8000-000000000002",
    configuration: {},
    databases: [],
    queues: [],
    controls: {},
    phases: {},
    versions: {},
    records: {},
  };
}

function lockFile(directory: string, value: unknown): string {
  const path = resolve(directory, "operator.lock");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

test("manifest revisions are private immutable files with a verified predecessor chain", (t) => {
  const path = directory(t);
  const value = manifest();
  saveManifest(path, value);
  assert.equal(value.revision, 1);
  assert.equal(value.previousDigest, null);
  assert.equal(
    statSync(resolve(path, "manifest-000001.json")).mode & 0o777,
    0o600,
  );
  const first = readFileSync(resolve(path, "manifest-000001.json"), "utf8");
  value.phases.preflight = "2026-09-12T12:01:00.000Z";
  saveManifest(path, value);
  assert.equal(value.revision, 2);
  assert.match(value.previousDigest!, /^[0-9a-f]{64}$/);
  assert.deepEqual(loadManifest(path), value);
  assert.equal(
    readFileSync(resolve(path, "manifest-000001.json"), "utf8"),
    first,
  );
  assert.deepEqual(manifestFiles(path), [
    "manifest-000001.json",
    "manifest-000002.json",
  ]);
});

test("stale concurrent saves cannot overwrite a newer manifest", (t) => {
  const path = directory(t);
  const first = manifest();
  saveManifest(path, first);
  const stale = structuredClone(first);
  first.records.new = "newer-state";
  saveManifest(path, first);
  stale.records.old = "stale-state";
  assert.throws(() => saveManifest(path, stale), /changed concurrently/);
  assert.deepEqual(loadManifest(path), first);
  assert.equal(stale.revision, 1);
});

test("manifest serialization failure does not advance the caller's revision", (t) => {
  const path = directory(t);
  const value = manifest();
  value.records.invalid = NaN;
  assert.throws(
    () => saveManifest(path, value),
    /unsafe-json-number|invalid|finite/i,
  );
  assert.equal(value.revision, 0);
  assert.equal(value.previousDigest, null);
  assert.deepEqual(manifestFiles(path), []);
});

test("the first save refuses a nonzero starting revision", (t) => {
  const path = directory(t);
  const value = manifest();
  value.revision = 7;
  assert.throws(() => saveManifest(path, value), /manifest|revision|chain/i);
  assert.deepEqual(manifestFiles(path), []);
});

for (const field of [
  "runId",
  "accountId",
  "workerName",
  "originalVersionId",
  "namespaceId",
] as const) {
  test(`manifest saves reject a changed migration identity field: ${field}`, (t) => {
    const path = directory(t);
    const value = manifest();
    saveManifest(path, value);
    const changed = structuredClone(value);
    changed[field] = `changed-${value[field]}`;
    assert.throws(
      () => saveManifest(path, changed),
      /identity|manifest|changed|run/i,
    );
    assert.deepEqual(loadManifest(path), value);
  });
}

test("manifest load detects changed historical content and mismatched revision filenames", (t) => {
  const path = directory(t);
  const value = manifest();
  saveManifest(path, value);
  saveManifest(path, value);
  const firstPath = resolve(path, "manifest-000001.json");
  const original = readFileSync(firstPath, "utf8");
  const altered = JSON.parse(original);
  altered.records.changed = true;
  writeFileSync(firstPath, JSON.stringify(altered));
  assert.throws(() => loadManifest(path), /chain|manifest/i);
  writeFileSync(firstPath, original);
  renameSync(
    resolve(path, "manifest-000002.json"),
    resolve(path, "manifest-000003.json"),
  );
  assert.throws(() => loadManifest(path), /chain|manifest|revision/i);
});

test("manifest reads reject public permissions and symlinks", (t) => {
  const path = directory(t);
  const value = manifest();
  saveManifest(path, value);
  const file = resolve(path, "manifest-000001.json");
  chmodSync(file, 0o644);
  assert.throws(() => loadManifest(path), /private regular file/);
  chmodSync(file, 0o600);
  renameSync(file, resolve(path, "original.json"));
  symlinkSync(resolve(path, "original.json"), file);
  assert.throws(() => loadManifest(path));
});

test("operator locking rejects an active owner and releases only its own lock", (t) => {
  const path = directory(t);
  const first = openMigrationDirectory(path);
  const file = resolve(path, "operator.lock");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(
    () => openMigrationDirectory(path),
    /still running|locked|claim/i,
  );
  first.release();
  assert.equal(existsSync(file), false);
  const second = openMigrationDirectory(path);
  lockFile(path, { pid: process.pid, token: "different-lock-owner" });
  assert.throws(() => second.release(), /lock changed/);
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).token,
    "different-lock-owner",
  );
});

test("a dead PID remains locked until an operator verifies and removes the stale lock", (t) => {
  const path = directory(t);
  const exitedPid = Number(
    execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    ),
  );
  assert.throws(
    () => process.kill(exitedPid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
  const original = { pid: exitedPid, token: "stale-owner" };
  lockFile(path, original);
  artifact(path, "retained.json", { keep: true });
  assert.throws(() => openMigrationDirectory(path), /stale|verify|recorded/i);
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(path, "operator.lock"), "utf8")),
    original,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(path, "retained.json"), "utf8")),
    { keep: true },
  );
});

test("permission errors and PID reuse never authorize stale-lock deletion", (t) => {
  const path = directory(t);
  const file = lockFile(path, { pid: 999_999, token: "retained-owner" });
  const original = readFileSync(file, "utf8");
  const kill = t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("process ownership unavailable"), {
      code: "EPERM",
    });
  });
  assert.throws(() => openMigrationDirectory(path), /ownership unavailable/);
  assert.equal(readFileSync(file, "utf8"), original);
  kill.mock.mockImplementation(() => true as const);
  assert.throws(
    () => openMigrationDirectory(path),
    /still running|locked|claim/i,
  );
  assert.equal(readFileSync(file, "utf8"), original);
});

test("a stale-lock reclaimer cannot unlink another operator's newly acquired lock", (t) => {
  const path = directory(t);
  const file = lockFile(path, { pid: 999_999, token: "stale-owner" });
  const replacement = { pid: process.pid, token: "concurrent-live-owner" };
  t.mock.method(process, "kill", () => {
    writeFileSync(file, JSON.stringify(replacement));
    throw Object.assign(new Error("stale PID gone"), { code: "ESRCH" });
  });
  assert.throws(
    () => openMigrationDirectory(path),
    /changed|concurrent|claim|lock/i,
  );
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), replacement);
});

test("invalid locks and public artifact directories fail closed", (t) => {
  const path = directory(t);
  const file = resolve(path, "operator.lock");
  for (const pid of [0, -1, 1.5, "123", null]) {
    lockFile(path, { pid, token: "invalid-owner" });
    assert.throws(() => openMigrationDirectory(path), /invalid.*lock/);
    assert.equal(existsSync(file), true);
    rmSync(file);
  }
  chmodSync(path, 0o755);
  assert.throws(() => openMigrationDirectory(path), /mode 0700/);
  assert.equal(statSync(path).mode & 0o777, 0o755);
});

test("named artifacts are immutable, private and cannot escape the migration directory", (t) => {
  const path = directory(t);
  artifact(path, "snapshot.json", { exact: "receipt" });
  artifact(path, "snapshot.json", { exact: "receipt" });
  assert.throws(
    () => artifact(path, "snapshot.json", { exact: "changed" }),
    /immutable artifact conflict/,
  );
  assert.equal(statSync(resolve(path, "snapshot.json")).mode & 0o777, 0o600);
  for (const name of [
    "../escape.json",
    "/tmp/escape.json",
    "nested/item.json",
    "bad.txt",
  ])
    assert.throws(() => artifact(path, name, {}), /invalid.*artifact name/);
});
