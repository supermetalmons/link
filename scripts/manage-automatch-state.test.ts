import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createRemoteDependencies,
  createSqlDependencies,
  manageAutomatchState,
  parseArgs,
  execute,
  type RecordValue,
  type Dependencies,
} from "./manage-automatch-state.ts";
import { canonicalJson, digest, type SqlRunner } from "./operator/runtime.ts";
const VERSION = "ed41f283-8a34-4674-8bf4-a4774b1d0196";
const OTHER_VERSION = "ad41f283-8a34-4674-8bf4-a4774b1d0196";
function harness(t: test.TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), "automatch-operator-test-"));
  const db = new DatabaseSync(":memory:");
  for (const file of [
    "0007_gameplay_coordination.sql",
    "0009_automatch_state.sql",
    "0011_game_session_writer_fence.sql",
    "0012_automatch_admission_audit.sql",
    "0013_game_session_writer_owner_fence.sql",
  ])
    db.exec(
      readFileSync(resolve("cloud/workers/api/migrations", file), "utf8"),
    );
  db.prepare(
    "UPDATE automatch_runtime_control SET backend='d1',staged_at_ms=1,candidate_version_id=?,source_digest=?,import_digest=?,activated_at_ms=100,metadata_json=?",
  ).run(
    VERSION,
    "a".repeat(64),
    "a".repeat(64),
    canonicalJson({ verifiedAtMs: 99, activationCandidateVersionId: VERSION }),
  );
  db.exec("UPDATE game_session_legacy_fence SET enabled=1");
  let deployed = VERSION;
  const calls: string[] = [];
  const log: RecordValue[] = [];
  let sqlInterceptor:
    | ((sql: string, execute: () => RecordValue[]) => Promise<RecordValue[]>)
    | undefined;
  const run: SqlRunner = async (sql, database, params = []) => {
    assert.equal(database, "mons-link-profile-games");
    calls.push(sql);
    const execute = () => db.prepare(sql).all(...params) as RecordValue[];
    return sqlInterceptor ? sqlInterceptor(sql, execute) : execute();
  };
  const dependencies: Dependencies = createSqlDependencies(
    run,
    {
      async assertDeployment(version) {
        if (version !== deployed) throw new Error("deployment mismatch");
      },
    },
    () => 2000000,
  );
  dependencies.log = (value) => log.push(value);
  const command = async (operation: string, extra: string[] = []) =>
    manageAutomatchState(parseArgs([`--${operation}`, ...extra]), dependencies);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    directory,
    calls,
    log,
    dependencies,
    command,
    setDeployment: (value: string) => {
      deployed = value;
    },
    intercept: (value: typeof sqlInterceptor) => {
      sqlInterceptor = value;
    },
  };
}
function insertAdmission(
  h: ReturnType<typeof harness>,
  phase: string,
  proof: unknown = null,
  backend = "d1",
  admissionId = "admission-1",
) {
  h.db
    .prepare(
      "INSERT INTO automatch_write_admissions (admission_id,epoch,freeze_generation,backend,kind,created_at_ms,phase,proof_json,audit_revision,updated_at_ms,completed_at_ms) VALUES (?,1,0,?,'owned-patch',100,?,?,2,200,?)",
    )
    .run(
      admissionId,
      backend,
      phase,
      proof === null ? null : canonicalJson(proof),
      phase === "completed" ? 200 : null,
    );
}
async function inspectAdmission(h: ReturnType<typeof harness>) {
  const directory = resolve(h.directory, "admissions");
  await h.command("inspect-admissions", ["--directory", directory]);
  return resolve(
    directory,
    readdirSync(directory).find((name) => name.startsWith("admission-"))!,
  );
}
function completeAdmissionEvidence(file: string) {
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  evidence.requestFinishedAtMs = 1000;
  evidence.completionEvidence = {
    kind: "operator-investigation",
    reference: "protected-trace:request-1",
    explanation:
      "Original request completed; recorded write targets and operation receipt reconciled.",
  };
  writeFileSync(file, JSON.stringify(evidence));
  return evidence;
}
function completeNoSourceEffectsEvidence(file: string) {
  const evidence = completeAdmissionEvidence(file);
  evidence.noSourceEffects = true;
  evidence.completionEvidence.explanation =
    "The original request finished without dispatching source work.";
  evidence.scopeEvidence = {
    reference: "protected-trace:request-1",
    explanation:
      "The complete request trace proves no source work was dispatched.",
  };
  writeFileSync(file, JSON.stringify(evidence));
  return evidence;
}
function activateD1Sources(h: ReturnType<typeof harness>) {
  assert.equal(
    h.db.prepare("SELECT backend FROM automatch_runtime_control").get()
      ?.backend,
    "d1",
  );
}
test("D1 no-source-effects recovery clears only the named orphan and replays without source reads", async (t) => {
  for (const proof of [
    null,
    { schemaVersion: 1, kind: "patch", updates: {} },
  ]) {
    const h = harness(t);
    activateD1Sources(h);
    insertAdmission(h, "prepared", proof, "d1");
    const file = await inspectAdmission(h);
    completeNoSourceEffectsEvidence(file);
    insertAdmission(h, "prepared", null, "d1", "admission-2");
    const unrelated = await h.dependencies.readAdmissions("admission-2");
    const control = (await h.dependencies.status()).control;
    await h.command("reconcile-admission", ["--evidence", file]);
    assert.equal(h.log.at(-1)?.resolution, "operator-reconciled");
    assert.deepEqual(await h.dependencies.readAdmissions(), unrelated);
    assert.deepEqual((await h.dependencies.status()).control, control);
    await h.command("reconcile-admission", ["--evidence", file]);
    assert.equal(h.log.at(-1)?.alreadyAbsent, true);
    assert.deepEqual(await h.dependencies.readAdmissions(), unrelated);

    assert.equal(
      h.calls.filter((sql) =>
        sql.startsWith("DELETE FROM automatch_write_admissions"),
      ).length,
      1,
    );
  }
});

test("D1 no-source-effects recovery requires finished-request and complete scope evidence", async (t) => {
  for (const missing of [
    "completion",
    "timestamp",
    "scope-reference",
    "scope-explanation",
  ]) {
    const h = harness(t);
    activateD1Sources(h);
    insertAdmission(h, "prepared", null, "d1");
    const file = await inspectAdmission(h);
    const evidence = completeNoSourceEffectsEvidence(file);
    if (missing === "completion") evidence.completionEvidence = null;
    if (missing === "timestamp") evidence.requestFinishedAtMs = null;
    if (missing === "scope-reference") evidence.scopeEvidence.reference = "";
    if (missing === "scope-explanation")
      evidence.scopeEvidence.explanation = "";
    writeFileSync(file, JSON.stringify(evidence));
    const before = await h.dependencies.readAdmissions();
    await assert.rejects(
      h.command("reconcile-admission", ["--evidence", file]),
      /finished-request evidence|request scope/,
    );
    assert.deepEqual(await h.dependencies.readAdmissions(), before);
  }
});

test("D1 no-source-effects recovery rejects recorded targets and nonempty source snapshots", async (t) => {
  for (const contradiction of ["recorded-target", "source-snapshot"]) {
    const h = harness(t);
    activateD1Sources(h);
    insertAdmission(
      h,
      "prepared",
      contradiction === "recorded-target"
        ? {
            schemaVersion: 1,
            kind: "patch",
            updates: { "automatch/10": null },
          }
        : null,
      "d1",
    );
    const file = await inspectAdmission(h);
    const evidence = completeNoSourceEffectsEvidence(file);
    evidence.sources =
      contradiction === "recorded-target"
        ? []
        : [{ path: "automatch/10", digest: digest(null) }];
    writeFileSync(file, JSON.stringify(evidence));
    const before = await h.dependencies.readAdmissions();
    await assert.rejects(
      h.command("reconcile-admission", ["--evidence", file]),
    );
    assert.deepEqual(await h.dependencies.readAdmissions(), before);

    assert.ok(
      !h.calls.some((sql) =>
        sql.startsWith("DELETE FROM automatch_write_admissions"),
      ),
    );
  }
});

test("D1 prepared admissions need completed-request scope and D1 source evidence after invite activation", async (t) => {
  const h = harness(t);
  activateD1Sources(h);
  insertAdmission(h, "prepared", null, "d1");
  const file = await inspectAdmission(h);
  const template = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(template.admission.backend, "d1");
  assert.equal(template.admission.proofJson, null);
  assert.deepEqual(template.sources, []);

  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /finished-request evidence/,
  );
  const evidence = completeAdmissionEvidence(file);
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /complete bounded target snapshot/,
  );
  const receipt = {
    kind: "automatch",
    completedAtMs: 900,
    response: { ok: true },
  };
  h.db
    .prepare(
      "INSERT INTO game_session_mutation_receipts (record_key,payload_json,revision,updated_at_ms) VALUES ('operation',?,1,900)",
    )
    .run(canonicalJson(receipt));
  evidence.sources = [
    { path: "gameplayMutationReceipts/operation", digest: digest(receipt) },
  ];
  writeFileSync(file, JSON.stringify(evidence));
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /complete request scope/,
  );
  evidence.scopeEvidence = {
    reference: "protected-trace:request-1",
    explanation:
      "Trace identifies this D1 receipt as the only attempted write.",
  };
  writeFileSync(file, JSON.stringify(evidence));
  h.db.exec(
    "UPDATE game_session_mutation_receipts SET payload_json = '{}' WHERE record_key = 'operation'",
  );
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /sources changed/,
  );
  assert.equal((await h.dependencies.status()).admissions, 1);
  h.db
    .prepare(
      "UPDATE game_session_mutation_receipts SET payload_json = ? WHERE record_key = 'operation'",
    )
    .run(canonicalJson(receipt));
  insertAdmission(h, "prepared", null, "d1", "admission-2");
  const unrelated = await h.dependencies.readAdmissions("admission-2");
  await h.command("reconcile-admission", ["--evidence", file]);
  assert.deepEqual(await h.dependencies.readAdmissions(), unrelated);
  assert.equal(h.log.at(-1)?.resolution, "operator-reconciled");
  await h.command("reconcile-admission", ["--evidence", file]);
  assert.equal(h.log.at(-1)?.alreadyAbsent, true);
  assert.deepEqual(await h.dependencies.readAdmissions(), unrelated);
});

test("D1 admission reconciliation rejects a tuple changed after inspection", async (t) => {
  const h = harness(t);
  activateD1Sources(h);
  insertAdmission(h, "prepared", null, "d1");
  const file = await inspectAdmission(h);
  completeAdmissionEvidence(file);
  h.db.exec(
    "UPDATE automatch_write_admissions SET audit_revision = 3, updated_at_ms = 300 WHERE admission_id = 'admission-1'",
  );
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /changed after inspection/,
  );
  assert.equal((await h.dependencies.status()).admissions, 1);
});

test("D1 admission proofs read owned snapshots from SQL and reject retired match paths", async (t) => {
  const h = harness(t);
  activateD1Sources(h);
  const receipt = { completedAtMs: 900, response: { ok: true } };
  const expiration = { completedAtMs: 900 };
  h.db
    .prepare(
      "INSERT INTO game_session_mutation_receipts (record_key,payload_json,revision,expiration_json,expiration_revision,updated_at_ms) VALUES ('operation',?,1,?,1,900)",
    )
    .run(canonicalJson(receipt), canonicalJson(expiration));
  const updates = {
    "automatch/10": null,
    "gameplayMutationReceiptExpirations/operation": expiration,
    "gameplayMutationReceipts/operation": receipt,
  };
  insertAdmission(
    h,
    "prepared",
    { schemaVersion: 1, kind: "patch", updates },
    "d1",
  );
  const file = await inspectAdmission(h);
  const evidence = completeAdmissionEvidence(file);
  assert.deepEqual(
    evidence.sources,
    Object.entries(updates).map(([path, value]) => ({
      path,
      digest: digest(value),
    })),
  );

  const [admission] = await h.dependencies.readAdmissions();
  await assert.rejects(
    h.dependencies.readAdmissionPath(admission, "players/host/matches/10"),
    /retired admission source-proof path/,
  );

  await h.command("reconcile-admission", ["--evidence", file]);
  assert.equal((await h.dependencies.status()).admissions, 0);
});

test("transaction admissions retain bounded attempts and reject stale phase revisions before deletion", async (t) => {
  const h = harness(t);
  insertAdmission(h, "dispatching", {
    schemaVersion: 1,
    kind: "transaction",
    path: "telegramAutomatches/10",
    attempts: [
      {
        attemptId: "attempt-1",
        current: { generation: 2 },
        proposed: { generation: 3 },
        atMs: 150,
        etag: "private-etag",
      },
    ],
  });
  const file = await inspectAdmission(h);
  completeAdmissionEvidence(file);
  h.db.exec("UPDATE automatch_write_admissions SET audit_revision=3");
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /changed after inspection/,
  );
  assert.equal((await h.dependencies.status()).admissions, 1);
  assert.ok(!JSON.stringify(h.log).includes("private-etag"));
});
test("retired commands reject before credentials or provider requests", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("unexpected provider request");
  });
  for (const flag of [
    "--preflight",
    "--stage",
    "--export",
    "--import",
    "--verify",
    "--activate",
    "--inspect-legacy",
    "--reconcile-legacy",
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
test("D1 maintenance preserves records, receipts and original activation evidence while adopting the verified repair candidate", async (t) => {
  const h = harness(t);
  h.db
    .prepare(
      "INSERT INTO game_session_mutation_receipts(record_key,payload_json,revision,updated_at_ms) VALUES('retained',?,1,100)",
    )
    .run(canonicalJson({ response: { ok: true } }));
  const receipt = h.db
    .prepare("SELECT * FROM game_session_mutation_receipts")
    .all();
  const original = (await h.dependencies.status()).control;
  await h.command("freeze");
  assert.equal((await h.dependencies.status()).control.state, "frozen");
  h.setDeployment(OTHER_VERSION);
  await assert.rejects(
    h.command("resume", ["--candidate-version-id", VERSION]),
    /deployment mismatch/,
  );
  await h.command("resume", ["--candidate-version-id", OTHER_VERSION]);
  const updated = (await h.dependencies.status()).control;
  assert.deepEqual(updated, {
    ...original,
    state: "active",
    freezeGeneration: original.freezeGeneration + 1,
    candidateVersionId: OTHER_VERSION,
  });
  assert.deepEqual(
    h.db.prepare("SELECT * FROM game_session_mutation_receipts").all(),
    receipt,
  );

  assert.ok(!h.calls.some((sql) => sql.startsWith("DELETE FROM")));
  await h.command("freeze", ["--candidate-version-id", OTHER_VERSION]);
  await h.command("resume", ["--candidate-version-id", OTHER_VERSION]);
});
test("D1 resume refuses unresolved admissions and active candidate adoption without mutating control", async (t) => {
  const h = harness(t);
  h.setDeployment(OTHER_VERSION);
  await assert.rejects(
    h.command("resume", ["--candidate-version-id", OTHER_VERSION]),
    /freeze D1 writes/,
  );
  await h.command("freeze", ["--candidate-version-id", OTHER_VERSION]);
  insertAdmission(h, "prepared");
  const before = await h.dependencies.status();
  await assert.rejects(
    h.command("resume", ["--candidate-version-id", OTHER_VERSION]),
    /unresolved admissions/,
  );
  assert.deepEqual(await h.dependencies.status(), before);
});
test("retired source control and unexpected legacy writer evidence cannot be frozen or resumed", async (t) => {
  for (const scenario of ["rtdb", "legacy", "unverified"]) {
    const h = harness(t);
    if (scenario === "rtdb") {
      const status = h.dependencies.status;
      h.dependencies.status = async () => {
        const current = await status();
        return { ...current, control: { ...current.control, backend: "rtdb" } };
      };
    }
    if (scenario === "legacy")
      h.db.exec(
        "INSERT INTO game_session_legacy_releases(lock_id,owner_id,operation_id,expires_at_ms,released_at_ms) VALUES('lock','owner','op',1,2)",
      );
    if (scenario === "unverified")
      h.db.exec("UPDATE automatch_runtime_control SET activated_at_ms=NULL");
    const before = await h.dependencies.status();
    await assert.rejects(h.command("freeze"), /retired|legacy|unverified/);
    assert.deepEqual(await h.dependencies.status(), before);
  }
});
test("generation changes between inspection and maintenance writes fail the SQL guard", async (t) => {
  const h = harness(t);
  h.intercept(async (sql, run) => {
    if (sql.startsWith("UPDATE automatch_runtime_control"))
      h.db.exec(
        "UPDATE automatch_runtime_control SET freeze_generation=freeze_generation+1",
      );
    return run();
  });
  await assert.rejects(h.command("freeze"), /changed/);
  assert.equal((await h.dependencies.status()).control.state, "active");
});
test("D1 recovery rejects retired source evidence without attempting remote reads", async (t) => {
  const h = harness(t);
  insertAdmission(h, "prepared");
  const [admission] = await h.dependencies.readAdmissions();
  for (const path of [
    "invites/10",
    "players",
    "players/host",
    "players/host/profile",
    "players/host/matches",
    "players/host/matches/10",
  ])
    await assert.rejects(
      h.dependencies.readAdmissionPath(admission, path),
      /retired/,
    );
});
test("Legacy admissions reject even completed evidence and cannot be inspected or reconciled", async (t) => {
  for (const phase of ["prepared", "completed"]) {
    const h = harness(t);
    insertAdmission(h, phase, null, "rtdb");
    const [admission] = await h.dependencies.readAdmissions();
    const file = resolve(h.directory, "legacy-evidence.json");
    writeFileSync(
      file,
      canonicalJson({
        schemaVersion: 1,
        admission,
        admissionDigest: digest(admission),
      }),
      { mode: 0o600 },
    );
    await assert.rejects(inspectAdmission(h), /legacy admissions are retired/);
    await assert.rejects(
      h.command("reconcile-admission", ["--evidence", file]),
      /legacy admissions are retired/,
    );
    assert.equal((await h.dependencies.status()).admissions, 1);
  }
});
test("completed D1 admissions retain the exact recorded proof and replay safely", async (t) => {
  const h = harness(t);
  insertAdmission(h, "completed");
  const file = await inspectAdmission(h);
  await h.command("reconcile-admission", ["--evidence", file]);
  assert.equal((await h.dependencies.status()).admissions, 0);
  await h.command("reconcile-admission", ["--evidence", file]);
  assert.equal(h.log.at(-1)?.alreadyAbsent, true);
  assert.ok(
    readdirSync(resolve(h.directory, "admissions")).some((name) =>
      name.startsWith("admission-reconciliation-"),
    ),
  );
});
test("uncertain D1 patch reconciliation requires every recorded target and rejects changed sources", async (t) => {
  const h = harness(t);
  insertAdmission(h, "uncertain", {
    schemaVersion: 1,
    kind: "patch",
    updates: {
      "automatch/10": null,
      "gameplayMutationReceipts/operation": {
        completedAtMs: { ".sv": "timestamp" },
      },
    },
  });
  const file = await inspectAdmission(h);
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /finished-request evidence/,
  );
  const evidence = completeAdmissionEvidence(file),
    saved = evidence.sources;
  evidence.sources = evidence.sources.filter(
    (source: { path: string }) =>
      source.path !== "gameplayMutationReceipts/operation",
  );
  writeFileSync(file, JSON.stringify(evidence));
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /omits a recorded/,
  );
  evidence.sources = saved;
  writeFileSync(file, JSON.stringify(evidence));
  h.db.exec(
    "INSERT INTO automatch_entries(record_key,payload_json,revision,updated_at_ms) VALUES('10','{}',1,100)",
  );
  await assert.rejects(
    h.command("reconcile-admission", ["--evidence", file]),
    /sources changed/,
  );
  h.db.exec("DELETE FROM automatch_entries WHERE record_key='10'");
  await h.command("reconcile-admission", ["--evidence", file]);
  assert.equal((await h.dependencies.status()).admissions, 0);
});
test("remote dependency construction requires no source credentials or network", () => {
  let requests = 0;
  const deps = createRemoteDependencies({
    config: { name: "mons-link-api", account_id: "a".repeat(32) },
    fetcher: async () => {
      requests++;
      throw new Error("unexpected request");
    },
  });
  assert.deepEqual(Object.keys(deps), ["assertDeployment"]);
  assert.equal(requests, 0);
});
test("deployment verification preserves the exact 100-percent candidate and disabled previews", async () => {
  let enabled = false,
    version = VERSION;
  const urls: string[] = [];
  const deps = createRemoteDependencies({
    apiToken: "fixture-token",
    config: { name: "mons-link-api", account_id: "a".repeat(32) },
    fetcher: async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.equal(init?.method, "GET");
      return Response.json({
        success: true,
        result: url.endsWith("/deployments")
          ? {
              deployments: [
                { versions: [{ version_id: version, percentage: 100 }] },
              ],
            }
          : { enabled, previews_enabled: false },
      });
    },
  });
  await deps.assertDeployment(VERSION);
  enabled = true;
  await assert.rejects(deps.assertDeployment(VERSION), /disabled/);
  enabled = false;
  version = OTHER_VERSION;
  await assert.rejects(deps.assertDeployment(VERSION), /sole 100/);
  assert.ok(urls.every((url) => url.includes("api.cloudflare.com")));
});

test("D1 admissions with retired match source proofs remain untouched even when marked completed", async (t) => {
  for (const phase of ["prepared", "completed"]) {
    await t.test(phase, async (t) => {
      const h = harness(t);
      insertAdmission(h, phase, {
        schemaVersion: 1,
        kind: "patch",
        updates: { "players/host/matches/game": { fen: "retained-source" } },
      });
      const [admission] = await h.dependencies.readAdmissions();
      const file = resolve(h.directory, "retired-source-proof.json");
      writeFileSync(
        file,
        canonicalJson({
          schemaVersion: 1,
          admission,
          admissionDigest: digest(admission),
        }),
        { mode: 0o600 },
      );
      await assert.rejects(
        inspectAdmission(h),
        /retired or invalid admission source-proof path/,
      );
      await assert.rejects(
        h.command("reconcile-admission", ["--evidence", file]),
        /retired or invalid admission source-proof path/,
      );
      assert.deepEqual(await h.dependencies.readAdmissions(), [admission]);
      assert.ok(h.calls.every((sql) => !sql.startsWith("DELETE")));
    });
  }
});
