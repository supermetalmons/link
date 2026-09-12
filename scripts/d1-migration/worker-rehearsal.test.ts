import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { D1_BINDINGS, type D1Binding } from "../operator/configuration.ts";
import { captureSchema, type SqlQuery } from "./clone.ts";
import {
  apiRecord,
  CloudflareRequestFailure,
  type CloudflareProvider,
} from "./provider.ts";
import type { MigrationManifest } from "./state.ts";
import { runWorkerRehearsal } from "./worker-rehearsal.ts";

const VERSION = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_VERSION = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_VERSION = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT_WORKFLOW_VERSION = "44444444-4444-4444-8444-444444444444";
const SOURCE_NAMESPACE = "a".repeat(32);
const SCRATCH_NAMESPACE = "b".repeat(32);

function sqlQuery(db: DatabaseSync): SqlQuery {
  return async (sql, params = []) =>
    db.prepare(sql).all(...params) as Record<string, unknown>[];
}

async function fixture(t: TestContext, attemptId?: string) {
  const directory = mkdtempSync(
    resolve(tmpdir(), "mons-worker-rehearsal-test-"),
  );
  chmodSync(directory, 0o700);
  const stores = new Map<string, DatabaseSync>();
  t.after(() => {
    for (const db of stores.values()) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const manifest: MigrationManifest = {
    schemaVersion: 1,
    revision: 0,
    previousDigest: null,
    runId: randomUUID(),
    createdAt: "2026-09-12T00:00:00.000Z",
    accountId: "c".repeat(32),
    workerName: "mons-link-api",
    originalVersionId: VERSION,
    namespaceId: SOURCE_NAMESPACE,
    configuration: {
      main: "src/index.ts",
      compatibility_date: "2026-08-09",
      compatibility_flags: ["nodejs_compat"],
      secrets: {
        required: [
          "SESSION_JWT_KEYS",
          "TELEGRAM_QUEUE_BRIDGE_SECRET",
          "FIXTURE_DECLARED_SECRET",
        ],
      },
    },
    databases: [],
    queues: [],
    controls: {},
    phases: { preflight: "2026-09-12T00:00:00.000Z" },
    versions: {},
    records: {},
  };
  for (const [sourceName, binding] of Object.entries(D1_BINDINGS)) {
    const sourceId = randomUUID();
    const destinationId = randomUUID();
    const source = new DatabaseSync(":memory:");
    const destination = new DatabaseSync(":memory:");
    stores.set(sourceId, source);
    stores.set(destinationId, destination);
    source.exec(
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
    );
    source.exec(
      "INSERT INTO d1_migrations(name,applied_at) VALUES ('0001_fixture.sql','2026-09-12')",
    );
    source.exec(
      "CREATE TABLE fixture_data (id INTEGER PRIMARY KEY, value TEXT)",
    );
    source.exec("INSERT INTO fixture_data VALUES (1,'source-only-data')");
    if (binding !== "AUTH_STATE_DB") {
      const table = `${binding.toLowerCase()}_control`;
      source.exec(
        `CREATE TABLE ${table} (singleton INTEGER PRIMARY KEY, state TEXT, freeze_generation INTEGER)`,
      );
      source.exec(`INSERT INTO ${table} VALUES (1,'active',3)`);
      manifest.controls[`${binding}.${table}`] = [
        { singleton: 1, state: "active", freeze_generation: 3 },
      ];
    }
    source.exec(
      "CREATE TRIGGER z_original BEFORE INSERT ON fixture_data BEGIN SELECT RAISE(IGNORE); END",
    );
    source.exec(
      "CREATE TRIGGER a_original BEFORE UPDATE ON fixture_data BEGIN SELECT RAISE(IGNORE); END",
    );
    manifest.databases.push({
      binding,
      sourceId,
      sourceName,
      sourceRegion: "WNAM",
      destinationId,
      destinationName: `${sourceName}-enam`,
      creationStartedAt: "2026-09-12T00:00:01.000Z",
      schema: await captureSchema(sqlQuery(source)),
    });
  }
  const commands: string[][] = [];
  const mutations: Array<{ databaseId: string; sql: string }> = [];
  const workerName = `mons-link-d1-enam-rehearsal-${manifest.runId.slice(0, 8)}${attemptId ? `-${attemptId.slice(0, 8)}` : ""}`;
  const workflowName = `${workerName}-progress`;
  let workflowExists = false;
  let keepWorkflowVersion = false;
  let omitDefinitionVersion = false;
  let corruptVersionOwner = false;
  let rejectForeignBookmark = false;
  let rejectCurrentBookmark = false;
  let unsignedHttpLag = 0;
  let signedHttpLag = 0;
  let workerVersion = VERSION;
  let workflowVersion = WORKFLOW_VERSION;
  let workflowInstance: Record<string, unknown> | null = null;
  let pendingStatus: string | null = null;
  let holdInitialCreation = false;
  let holdCleanupDeletion = false;
  let coarseRunningSleep = false;
  let readsRemaining = 0;
  const workflowCalls: Array<{ path: string; method: string; body?: unknown }> =
    [];
  const creations: unknown[] = [];
  const propagationWaits: Array<{ milliseconds: number; stage: string }> = [];
  let boundToProduction = false;
  let workerExists = false;
  let secret = "";
  const provider: CloudflareProvider = {
    async request(path, method = "GET", body) {
      if (path.startsWith("workflows/")) {
        assert.ok(
          path === `workflows/${workflowName}` ||
            path.startsWith(`workflows/${workflowName}/`),
        );
        workflowCalls.push({ path, method, body });
        const resource = `workflows/${workflowName}`;
        if (path === resource && method === "GET") {
          if (!workflowExists)
            throw new CloudflareRequestFailure(
              404,
              [],
              "scratch Workflow missing",
            );
          return {
            id: "55555555-5555-4555-8555-555555555555",
            name: workflowName,
            script_name: workerName,
            class_name: "EventProgressWorkflow",
            ...(omitDefinitionVersion ? {} : { version_id: workflowVersion }),
          };
        }
        if (
          path === `${resource}/versions?per_page=1` ||
          path.startsWith(`${resource}/versions/`)
        ) {
          const version = {
            id: path.includes("?") ? workflowVersion : path.split("/").at(-1),
            workflow_id: corruptVersionOwner
              ? "66666666-6666-4666-8666-666666666666"
              : "55555555-5555-4555-8555-555555555555",
            class_name: "EventProgressWorkflow",
          };
          return path.includes("?") ? [version] : version;
        }
        const journal = apiRecord(
          apiRecord(manifest.records.workerRehearsal).workflow,
        );
        if (path === resource && method === "DELETE") {
          assert.equal(journal.stage, "definition-delete-requested");
          assert.equal(workflowInstance, null);
          workflowExists = false;
          return { status: "ok", success: true };
        }
        if (path === `${resource}/instances?per_page=100&page=1`)
          return workflowInstance
            ? [
                {
                  id: workflowInstance.id,
                  status: workflowInstance.status,
                  version_id: workflowInstance.versionId,
                },
              ]
            : [];
        if (path === `${resource}/instances` && method === "POST") {
          assert.ok(
            ["create-requested", "recreate-requested"].includes(
              String(journal.stage),
            ),
          );
          assert.equal(workflowInstance, null);
          const input = apiRecord(body);
          const params = apiRecord(input.params);
          const hash = createHash("sha256")
            .update(`${params.eventId}\n${params.sourceKey}`)
            .digest("hex");
          assert.equal(input.instance_id, `event-progress-${hash}`);
          assert.equal(params.outboxId, `ep_${hash}`);
          assert.equal(
            params.sourceKey,
            `start:${params.eventId}:${params.runAtMs}`,
          );
          assert.equal(params.reason, "scheduled-start");
          assert.equal(Object.keys(params).length, 6);
          if (creations.length) assert.deepEqual(input, creations[0]);
          creations.push(structuredClone(input));
          workflowInstance = {
            id: input.instance_id,
            params,
            status: "queued",
            versionId: workflowVersion,
            steps: [],
            step_count: 0,
            error: null,
            output: null,
          };
          readsRemaining = 2;
          pendingStatus = "waiting";
          return {
            id: input.instance_id,
            version_id: workflowVersion,
            status: "queued",
          };
        }
        if (
          path === `${resource}/instances/batch/delete` &&
          method === "POST"
        ) {
          assert.ok(
            ["delete-requested", "cleanup-delete-requested"].includes(
              String(journal.stage),
            ),
          );
          assert.equal(workflowInstance?.status, "terminated");
          assert.deepEqual(apiRecord(body).instances, [workflowInstance?.id]);
          readsRemaining = 1;
          pendingStatus = "deleted";
          return { deleted: [workflowInstance?.id] };
        }
        if (path.endsWith("/status") && method === "PATCH") {
          const action = apiRecord(body).status;
          assert.equal(
            path,
            `${resource}/instances/${workflowInstance?.id}/status`,
          );
          if (action === "pause") {
            assert.ok(
              ["pause-requested", "cleanup-pause-requested"].includes(
                String(journal.stage),
              ),
            );
            assert.ok(
              ["waiting", "running"].includes(String(workflowInstance?.status)),
            );
            workflowInstance!.status = "waitingForPause";
            pendingStatus = "paused";
          } else {
            assert.equal(action, "terminate");
            assert.equal(apiRecord(body).rollback, false);
            assert.ok(
              ["terminate-requested", "cleanup-terminate-requested"].includes(
                String(journal.stage),
              ),
            );
            assert.equal(workflowInstance?.status, "paused");
            pendingStatus = "terminated";
          }
          readsRemaining = 1;
          return { success: true };
        }
        if (method === "GET" && path.startsWith(`${resource}/instances/`)) {
          if (
            pendingStatus &&
            !(
              holdCleanupDeletion &&
              creations.length === 2 &&
              pendingStatus === "deleted"
            ) &&
            !(
              holdInitialCreation &&
              creations.length === 1 &&
              pendingStatus === "waiting"
            ) &&
            readsRemaining-- === 0
          ) {
            if (pendingStatus === "deleted") workflowInstance = null;
            else {
              workflowInstance!.status =
                pendingStatus === "waiting" && coarseRunningSleep
                  ? "running"
                  : pendingStatus;
              if (pendingStatus === "waiting") {
                const params = apiRecord(workflowInstance!.params);
                workflowInstance!.steps = [
                  {
                    name: "wait for scheduled event-1",
                    type: "sleep",
                    end: new Date(Number(params.runAtMs)).toISOString(),
                    finished: false,
                    error: null,
                  },
                ];
                workflowInstance!.step_count = 1;
              }
              if (pendingStatus === "terminated") {
                (workflowInstance!.steps as unknown[]).push({
                  type: "termination",
                });
                workflowInstance!.step_count = 2;
              }
            }
            pendingStatus = null;
          }
          if (!workflowInstance)
            throw new CloudflareRequestFailure(
              404,
              [],
              "scratch instance missing",
            );
          assert.equal(path, `${resource}/instances/${workflowInstance.id}`);
          return structuredClone(workflowInstance);
        }
        throw new Error(`unexpected Workflow operation ${method} ${path}`);
      }
      if (path === "workers/scripts/mons-link-api/settings")
        return {
          bindings: manifest.databases.map((db) => ({
            name: db.binding,
            type: "d1",
            id: boundToProduction ? db.destinationId : db.sourceId,
          })),
        };
      if (path === "workers/scripts")
        return workerExists ? [{ id: workerName }] : [];
      const target = manifest.databases.find(
        (db) => path === `d1/database/${db.destinationId}`,
      );
      if (target)
        return {
          uuid: target.destinationId,
          name: target.destinationName,
          running_in_region: "ENAM",
        };
      if (path === `workers/scripts/${workerName}/deployments`)
        return {
          deployments: [
            { versions: [{ version_id: workerVersion, percentage: 100 }] },
          ],
        };
      if (path === `workers/scripts/${workerName}/versions/${VERSION}`)
        return {
          id: VERSION,
          metadata: { created_on: new Date(Date.now() + 60_000).toISOString() },
        };
      if (path === "workers/durable_objects/namespaces")
        return [
          {
            id: SOURCE_NAMESPACE,
            script: manifest.workerName,
            class: "InviteReactions",
          },
          {
            id: SCRATCH_NAMESPACE,
            script: workerName,
            class: "InviteReactions",
          },
        ];
      if (path === `workers/scripts/${workerName}/settings`)
        return {
          bindings: [
            ...manifest.databases.map((db) => ({
              name: db.binding,
              type: "d1",
              id: db.destinationId,
            })),
            {
              name: "EVENT_PROGRESS_WORKFLOW",
              type: "workflow",
              workflow_name: workflowName,
            },
          ],
        };
      if (path === "workers/subdomain") return { subdomain: "rehearsal-test" };
      throw new Error(`unexpected provider path ${path}`);
    },
    async query(databaseId, sql, params = []) {
      const db = stores.get(databaseId);
      assert.ok(db);
      if (manifest.databases.some((entry) => entry.sourceId === databaseId))
        assert.match(sql, /^SELECT \* FROM "d1_migrations" ORDER BY id$/);
      if (/^(CREATE|INSERT|UPDATE|DELETE|DROP)\b/.test(sql)) {
        assert.equal(
          apiRecord(manifest.records.workerRehearsal).workerName,
          workerName,
        );
        mutations.push({ databaseId, sql });
      }
      try {
        return await sqlQuery(db)(sql, params);
      } catch {
        throw new CloudflareRequestFailure(400, [7500], "fixture SQL");
      }
    },
    async list() {
      return [];
    },
    async envelope() {
      throw new Error("unexpected envelope");
    },
  };
  const runCommand = async (
    _label: string,
    executable: string,
    args: string[],
    commandEnv?: NodeJS.ProcessEnv,
  ) => {
    assert.equal(executable, process.execPath);
    commands.push(args);
    assert.equal(
      apiRecord(manifest.records.workerRehearsal).workerName,
      workerName,
    );
    const config = JSON.parse(
      readFileSync(args[args.indexOf("--config") + 1], "utf8"),
    );
    assert.equal(config.name, workerName);
    assert.equal(
      config.main,
      resolve(import.meta.dirname, "../../cloud/workers/api/src/index.ts"),
    );
    assert.equal(config.workers_dev, true);
    assert.equal(config.vars.API_MAINTENANCE, "true");
    assert.equal(config.vars.D1_MIGRATION_RUN_ID, manifest.runId);
    for (const field of ["queues", "triggers", "routes", "secrets"])
      assert.equal(config[field], undefined);
    assert.deepEqual(config.workflows, [
      {
        binding: "EVENT_PROGRESS_WORKFLOW",
        name: workflowName,
        class_name: "EventProgressWorkflow",
      },
    ]);
    assert.deepEqual(
      config.d1_databases.map((db: { database_id: string }) => db.database_id),
      manifest.databases.map((db) => db.destinationId),
    );
    assert.ok(Object.values(commandEnv || {}).every((value) => value === ""));
    if (args.includes("deploy")) {
      workerExists = true;
      workflowExists = true;
      if (config.vars.REHEARSAL_BINDING_GENERATION === "2") {
        assert.equal(
          apiRecord(apiRecord(manifest.records.workerRehearsal).workflow).stage,
          "replacement-deploy-requested",
        );
        workerVersion = REPLACEMENT_VERSION;
        if (!keepWorkflowVersion)
          workflowVersion = REPLACEMENT_WORKFLOW_VERSION;
      } else assert.equal(config.vars.REHEARSAL_BINDING_GENERATION, "1");
    } else {
      assert.equal(args[1], "secret");
      assert.equal(args[2], "bulk");
      assert.equal(statSync(args[3]).mode & 0o777, 0o600);
      const values = JSON.parse(readFileSync(args[3], "utf8"));
      assert.deepEqual(Object.keys(values), ["TELEGRAM_QUEUE_BRIDGE_SECRET"]);
      secret = values.TELEGRAM_QUEUE_BRIDGE_SECRET;
      assert.match(secret, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(args).includes(secret), false);
    }
    return "";
  };
  function status(binding: D1Binding) {
    const db = manifest.databases.find((entry) => entry.binding === binding)!;
    const target = stores.get(db.destinationId!)!;
    const names = db.schema!.tables.flatMap((table) =>
      ["insert", "update", "delete"].map(
        (operation) =>
          `d1_migration_fence_${binding}_${table.name}_${operation}`,
      ),
    );
    const actual = target
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'd1_migration_fence_%'",
      )
      .get() as { count: number };
    return {
      binding,
      drained: true,
      schemaDigest: "a".repeat(64),
      fence: {
        triggerNames: names,
        installedTriggers: actual.count,
        complete: names.length === actual.count,
      },
      valid: true,
      bookmark: `native-${binding}`,
      bookmarkAccepted: true,
      migrationCount: 1,
      foreignKeyViolations: 0,
      integrityCheckKind: "quick_check",
      integrityCheck: ["ok"],
    };
  }
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.ok(
        String(input).startsWith(
          `https://${workerName}.rehearsal-test.workers.dev/`,
        ),
      );
      if (!init?.body)
        return Response.json(
          {
            runId: manifest.runId,
            versionId: unsignedHttpLag-- > 0 ? VERSION : workerVersion,
            message: "api-maintenance",
          },
          { status: 503 },
        );
      const body = String(init.body);
      const headers = new Headers(init.headers);
      assert.equal(
        headers.get("X-Mons-Telegram-Signature"),
        createHmac("sha256", secret)
          .update(`${headers.get("X-Mons-Telegram-Timestamp")}.${body}`)
          .digest("base64url"),
      );
      const command = JSON.parse(body);
      assert.equal(command.expectedVersionId, workerVersion);
      assert.equal(command.runId, manifest.runId);
      if (signedHttpLag-- > 0)
        return Response.json({
          ok: true,
          runId: manifest.runId,
          versionId: VERSION,
          databases: [],
        });
      const common = {
        ok: true,
        runId: manifest.runId,
        versionId: workerVersion,
      };
      if (command.operation === "barrier")
        return Response.json({
          ...common,
          objectId: "d".repeat(64),
          canonicalDigest: "e".repeat(64),
          effectDigest: "f".repeat(64),
          pendingEffects: 0,
          source: { inviteId: null },
        });
      if (command.operation === "fence") {
        const db = manifest.databases.find(
          (entry) => entry.binding === command.binding,
        )!;
        const target = stores.get(db.destinationId!)!;
        for (const table of db.schema!.tables)
          for (const operation of ["INSERT", "UPDATE", "DELETE"])
            target.exec(
              `CREATE TRIGGER "d1_migration_fence_${db.binding}_${table.name}_${operation.toLowerCase()}" BEFORE ${operation} ON "${table.name}" BEGIN SELECT RAISE(ABORT,'d1-migration-source-frozen'); END`,
            );
        return Response.json({ ...common, databases: [status(db.binding)] });
      }
      if (
        command.operation === "verify" &&
        command.bookmark &&
        rejectForeignBookmark &&
        command.bookmark !== "first-primary" &&
        command.bookmark !== `native-${command.binding}`
      ) {
        assert.equal(command.bookmark, "native-PROFILE_GAMES_DB");
        assert.equal(command.binding, "AUTH_STATE_DB");
        return Response.json({
          ...common,
          databases: [
            {
              ...status(command.binding),
              valid: false,
              bookmark: null,
              bookmarkAccepted: false,
              migrationCount: null,
              bookmarkError: "native cross-database token rejected",
            },
          ],
        });
      }
      if (
        command.operation === "verify" &&
        command.bookmark === "native-AUTH_STATE_DB" &&
        rejectCurrentBookmark
      ) {
        return Response.json({
          ...common,
          databases: [
            {
              ...status(command.binding),
              valid: false,
              bookmark: null,
              bookmarkAccepted: false,
              migrationCount: null,
            },
          ],
        });
      }
      return Response.json({
        ...common,
        databases: command.binding
          ? [status(command.binding)]
          : manifest.databases.map((db) => status(db.binding)),
      });
    },
  );
  return {
    directory,
    attemptId,
    manifest,
    provider,
    runCommand,
    commands,
    mutations,
    stores,
    workerName,
    workflowCalls,
    creations,
    propagationWaits,
    waitForPropagation: async (milliseconds: number) => {
      propagationWaits.push({
        milliseconds,
        stage: String(
          apiRecord(apiRecord(manifest.records.workerRehearsal).workflow).stage,
        ),
      });
    },
    workflowState: () => ({ workflowExists, workflowInstance }),
    keepWorkflowVersion: () => {
      keepWorkflowVersion = true;
    },
    actualGetShape: () => {
      omitDefinitionVersion = true;
    },
    corruptVersionOwner: () => {
      corruptVersionOwner = true;
    },
    rejectForeignBookmark: () => {
      rejectForeignBookmark = true;
    },
    rejectCurrentBookmark: () => {
      rejectCurrentBookmark = true;
    },
    lagHttpResponses: (unsigned: number, signed: number) => {
      unsignedHttpLag = unsigned;
      signedHttpLag = signed;
    },
    holdInitialCreation: (hold: boolean) => {
      holdInitialCreation = hold;
    },
    holdCleanupDeletion: (hold: boolean) => {
      holdCleanupDeletion = hold;
    },
    completePendingCleanup: () => {
      workflowInstance = null;
      pendingStatus = null;
    },
    coarseRunningSleep: () => {
      coarseRunningSleep = true;
    },
    productionBinding: () => {
      boundToProduction = true;
    },
    existingWorker: () => {
      workerExists = true;
    },
  };
}

test("Worker rehearsal uses only empty owned destinations, restores trigger order, and returns private reset evidence", async (t) => {
  const f = await fixture(t);
  let persisted = 0;
  const result = await runWorkerRehearsal({
    ...f,
    persist: async () => {
      persisted++;
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.workerName, f.workerName);
  assert.equal(result.namespaceId, SCRATCH_NAMESPACE);
  assert.equal(result.versionId, REPLACEMENT_VERSION);
  assert.equal(result.retirementRequired, true);
  assert.equal(result.databases.length, 6);
  assert.equal(f.commands.length, 3);
  assert.equal(
    result.workflowHandoff.originalWorkflowVersionId,
    WORKFLOW_VERSION,
  );
  assert.equal(
    result.workflowHandoff.replacementWorkflowVersionId,
    REPLACEMENT_WORKFLOW_VERSION,
  );
  assert.equal(result.workflowHandoff.originalWorkerVersionId, VERSION);
  assert.equal(
    result.workflowHandoff.replacementWorkerVersionId,
    REPLACEMENT_VERSION,
  );
  assert.equal(result.workflowHandoff.deleted, true);
  assert.equal(result.bookmarkCompatibility.accepted, true);
  assert.equal(result.bookmarkCompatibility.recoveryVerified, true);
  assert.notEqual(
    result.bookmarkCompatibility.sourceDatabaseId,
    result.bookmarkCompatibility.targetDatabaseId,
  );
  assert.equal(f.creations.length, 2);
  assert.ok(
    f.propagationWaits.some((wait) => wait.stage === "create-requested"),
  );
  assert.ok(f.propagationWaits.every((wait) => wait.milliseconds === 500));
  assert.equal(
    f.propagationWaits.filter((wait) => wait.stage === "definition-inspection")
      .length,
    0,
  );
  assert.deepEqual(f.workflowState(), {
    workflowExists: false,
    workflowInstance: null,
  });
  assert.ok(persisted > 10);
  for (const db of f.manifest.databases) {
    const originalTriggers = f.mutations.filter(
      (entry) =>
        entry.databaseId === db.destinationId &&
        /^CREATE TRIGGER/.test(entry.sql),
    );
    assert.match(originalTriggers[0].sql, /^CREATE TRIGGER z_original/);
    assert.match(originalTriggers[1].sql, /^CREATE TRIGGER a_original/);
    assert.equal(
      (
        f.stores
          .get(db.destinationId!)!
          .prepare("SELECT COUNT(*) AS count FROM fixture_data")
          .get() as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        f.stores
          .get(db.sourceId)!
          .prepare("SELECT COUNT(*) AS count FROM fixture_data")
          .get() as { count: number }
      ).count,
      1,
    );
    const evidence = result.databases.find(
      (entry) => entry.binding === db.binding,
    )!;
    assert.ok(evidence.fenceTriggers.length > 0);
    assert.ok(
      evidence.fenceTriggers.every((name) =>
        evidence.schema.objects.some((object) => object.name === name),
      ),
    );
  }
  assert.equal(
    statSync(resolve(f.directory, "worker-rehearsal-evidence.json")).mode &
      0o777,
    0o600,
  );
  assert.equal(apiRecord(f.manifest.records.workerRehearsal).phase, "complete");
});

test("Worker rehearsal rejects copy or quiescence state before any remote mutation", async (t) => {
  const f = await fixture(t);
  f.manifest.databases[0].copyStarted = true;
  await assert.rejects(runWorkerRehearsal(f), /never-live/);
  f.manifest.databases[0].copyStarted = false;
  f.manifest.phases.quiesce = "2026-09-12T00:00:01.000Z";
  await assert.rejects(runWorkerRehearsal(f), /before quiesce or copy/);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.commands.length, 0);
});

test("Worker rehearsal refuses a destination already bound to production", async (t) => {
  const f = await fixture(t);
  f.productionBinding();
  await assert.rejects(runWorkerRehearsal(f), /already bound to the live API/);
  assert.equal(f.mutations.length, 0);
});

test("Worker rehearsal checks all six targets are empty before writing the first fixture", async (t) => {
  const f = await fixture(t);
  f.stores
    .get(f.manifest.databases.at(-1)!.destinationId!)!
    .exec("CREATE TABLE unrelated_data (id INTEGER)");
  await assert.rejects(runWorkerRehearsal(f), /empty destination/);
  assert.equal(f.mutations.length, 0);
});

test("Worker rehearsal refuses a preexisting scratch Worker without adopting it", async (t) => {
  const f = await fixture(t);
  f.existingWorker();
  await assert.rejects(
    runWorkerRehearsal(f),
    /already exists without owned creation evidence/,
  );
  assert.equal(f.mutations.length, 0);
});

test("Workflow handoff stops after bounded reads if the replacement definition does not advance", async (t) => {
  const f = await fixture(t);
  f.keepWorkflowVersion();
  await assert.rejects(
    runWorkerRehearsal(f),
    /replacement Workflow publication remains pending/,
  );
  assert.equal(f.workflowState().workflowInstance?.status, "paused");
  assert.equal(f.creations.length, 1);
  assert.equal(
    f.workflowCalls.filter(
      (call) =>
        call.method === "PATCH" && apiRecord(call.body).status === "terminate",
    ).length,
    0,
  );
  assert.equal(
    apiRecord(apiRecord(f.manifest.records.workerRehearsal).workflow).stage,
    "replacement-worker-deployed",
  );
  assert.equal(
    f.propagationWaits.filter(
      (wait) => wait.stage === "replacement-worker-deployed",
    ).length,
    119,
  );
  assert.equal(
    f.commands.filter((command) => command.includes("bulk")).length,
    1,
  );
});

test("Workflow rehearsal resolves versions from the actual GET shape without version_id", async (t) => {
  const f = await fixture(t);
  f.actualGetShape();
  const result = await runWorkerRehearsal(f);
  assert.equal(
    result.workflowHandoff.originalWorkflowVersionId,
    WORKFLOW_VERSION,
  );
  assert.equal(
    result.workflowHandoff.replacementWorkflowVersionId,
    REPLACEMENT_WORKFLOW_VERSION,
  );
  assert.ok(
    f.workflowCalls.some((call) => call.path.endsWith("/versions?per_page=1")),
  );
  assert.ok(
    f.workflowCalls.some((call) =>
      call.path.endsWith(`/versions/${REPLACEMENT_WORKFLOW_VERSION}`),
    ),
  );
});

test("Workflow rehearsal rejects a latest version belonging to another Workflow", async (t) => {
  const f = await fixture(t);
  f.actualGetShape();
  f.corruptVersionOwner();
  await assert.rejects(
    runWorkerRehearsal(f),
    /Workflow version metadata conflict/,
  );
  assert.equal(f.creations.length, 0);
});

test("Worker rehearsal records a rejected native cross-database bookmark without changing read policy", async (t) => {
  const f = await fixture(t);
  f.rejectForeignBookmark();
  const result = await runWorkerRehearsal(f);
  assert.equal(result.bookmarkCompatibility.accepted, false);
  assert.equal(
    result.bookmarkCompatibility.error,
    "native cross-database token rejected",
  );
  assert.equal(
    result.bookmarkCompatibility.sourceBookmark,
    "native-PROFILE_GAMES_DB",
  );
  assert.equal(result.bookmarkCompatibility.targetBookmark, null);
  assert.equal(result.bookmarkCompatibility.recoveryVerified, true);
  assert.deepEqual(
    result.bookmarkCompatibility.recoveryChecks?.map(
      ({ kind, constraint }) => ({ kind, constraint }),
    ),
    [
      { kind: "legacy-raw", constraint: "first-primary" },
      { kind: "foreign-scope", constraint: "first-primary" },
      { kind: "current-scope", constraint: "native-AUTH_STATE_DB" },
    ],
  );
  assert.equal(apiRecord(f.manifest.records.workerRehearsal).phase, "complete");
});

test("Bookmark recovery requires the matching-scope native read as well as both legacy resets", async (t) => {
  const f = await fixture(t);
  f.rejectForeignBookmark();
  f.rejectCurrentBookmark();
  const result = await runWorkerRehearsal(f);
  assert.equal(result.bookmarkCompatibility.accepted, false);
  assert.equal(result.bookmarkCompatibility.recoveryVerified, false);
  assert.equal(result.bookmarkCompatibility.recoveryChecks?.length, 2);
  assert.match(
    result.bookmarkCompatibility.recoveryError || "",
    /current-scope native bookmark recovery read failed/,
  );
});

test("Worker rehearsal records an optional attempt UUID and gives scratch resources a fresh name", async (t) => {
  const attemptId = randomUUID();
  const f = await fixture(t, attemptId);
  const result = await runWorkerRehearsal(f);
  assert.equal(result.attemptId, attemptId);
  assert.equal(
    apiRecord(f.manifest.records.workerRehearsal).attemptId,
    attemptId,
  );
  assert.ok(result.workerName.endsWith(`-${attemptId.slice(0, 8)}`));
  assert.equal(
    result.workflowHandoff.workflowName,
    `${result.workerName}-progress`,
  );
  assert.ok(result.workflowHandoff.workflowName.length <= 64);
});

test("Worker rehearsal rejects an invalid attempt UUID before remote work", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runWorkerRehearsal({ ...f, attemptId: "invalid" }),
    /attemptId must be a UUID/,
  );
  assert.equal(f.commands.length, 0);
  assert.equal(f.mutations.length, 0);
});

test("Worker HTTP evidence waits only between stale edge responses using the injected propagation delay", async (t) => {
  const f = await fixture(t);
  f.lagHttpResponses(2, 2);
  const result = await runWorkerRehearsal(f);
  assert.equal(result.passed, true);
  const waits = f.propagationWaits.filter((wait) => wait.stage === "complete");
  assert.equal(waits.length, 4);
  assert.ok(waits.every((wait) => wait.milliseconds === 500));
});

test("Worker HTTP evidence does not wait after the final failed edge check", async (t) => {
  const f = await fixture(t);
  f.lagHttpResponses(100, 0);
  await assert.rejects(
    runWorkerRehearsal(f),
    /HTTP verification remained unconfirmed/,
  );
  assert.equal(
    f.propagationWaits.filter((wait) => wait.stage === "complete").length,
    7,
  );
  assert.equal(
    apiRecord(apiRecord(f.manifest.records.workerRehearsal).workflowHandoff)
      .deleted,
    true,
  );
});

test("Workflow rehearsal accepts a coarse running status only with the exact future initial sleep", async (t) => {
  const f = await fixture(t);
  f.coarseRunningSleep();
  const result = await runWorkerRehearsal(f);
  assert.equal(result.workflowHandoff.originalSleep.status, "running");
  assert.equal(result.workflowHandoff.recreatedSleep.status, "running");
  assert.equal(result.workflowHandoff.deleted, true);
});

test("Worker rehearsal resumes its exact owned initial creation without redeploying or resetting six fixtures", async (t) => {
  const f = await fixture(t, randomUUID());
  f.holdInitialCreation(true);
  await assert.rejects(
    runWorkerRehearsal(f),
    /Workflow waiting remains pending/,
  );
  assert.equal(
    apiRecord(f.manifest.records.workerRehearsal).phase,
    "workflow:create-requested",
  );
  const fixtureMutations = f.mutations.length;
  assert.equal(f.commands.length, 2);
  assert.equal(f.creations.length, 1);
  f.holdInitialCreation(false);
  f.coarseRunningSleep();
  const result = await runWorkerRehearsal(f);
  assert.equal(result.resumed, true);
  assert.equal(f.commands.length, 3);
  assert.equal(f.creations.length, 2);
  assert.equal(
    f.mutations
      .slice(fixtureMutations)
      .filter((entry) => /^(CREATE|INSERT|DROP)\b/.test(entry.sql)).length,
    0,
  );
  assert.equal(result.workflowHandoff.deleted, true);
});

test("Worker rehearsal resume rejects changed fixture data before mutating its saved Workflow", async (t) => {
  const f = await fixture(t, randomUUID());
  f.holdInitialCreation(true);
  await assert.rejects(
    runWorkerRehearsal(f),
    /Workflow waiting remains pending/,
  );
  const db = f.stores.get(f.manifest.databases[0].destinationId!)!;
  db.exec("DROP TRIGGER z_original");
  db.exec("INSERT INTO fixture_data VALUES (7,'unexpected')");
  db.exec(
    "CREATE TRIGGER z_original BEFORE INSERT ON fixture_data BEGIN SELECT RAISE(IGNORE); END",
  );
  const writes = f.workflowCalls.filter((call) => call.method !== "GET").length;
  await assert.rejects(
    runWorkerRehearsal(f),
    /empty destination application schemas|unexpected application data/,
  );
  assert.equal(
    f.workflowCalls.filter((call) => call.method !== "GET").length,
    writes,
  );
  assert.equal(f.commands.length, 2);
});

test("Older owned rehearsal intent can qualify unchanged source through its deployment timestamp", async (t) => {
  const f = await fixture(t, randomUUID());
  f.holdInitialCreation(true);
  await assert.rejects(
    runWorkerRehearsal(f),
    /Workflow waiting remains pending/,
  );
  const progress = apiRecord(f.manifest.records.workerRehearsal);
  delete progress.sourceSha256;
  const latest = readdirSync(f.directory)
    .filter((name) => /^worker-rehearsal-progress-\d{4}\.json$/.test(name))
    .sort()
    .at(-1)!;
  writeFileSync(resolve(f.directory, latest), JSON.stringify(progress));
  f.holdInitialCreation(false);
  const result = await runWorkerRehearsal(f);
  assert.equal(result.resumed, true);
  assert.equal(f.commands.length, 3);
  assert.equal(f.creations.length, 2);
});

for (const alreadyDeleted of [false, true])
  test(`Workflow cleanup tail resumes without recreating or redeploying (already deleted: ${alreadyDeleted})`, async (t) => {
    const f = await fixture(t, randomUUID());
    f.holdCleanupDeletion(true);
    await assert.rejects(
      runWorkerRehearsal(f),
      /synthetic instance deletion remains pending/,
    );
    assert.equal(
      apiRecord(f.manifest.records.workerRehearsal).phase,
      "workflow:cleanup-delete-requested",
    );
    assert.equal(f.commands.length, 3);
    assert.equal(f.creations.length, 2);
    const fixtureMutations = f.mutations.length;
    f.holdCleanupDeletion(false);
    if (alreadyDeleted) f.completePendingCleanup();
    const result = await runWorkerRehearsal(f);
    assert.equal(result.resumed, true);
    assert.equal(result.workflowHandoff.deleted, true);
    assert.equal(f.commands.length, 3);
    assert.equal(f.creations.length, 2);
    assert.equal(
      f.mutations
        .slice(fixtureMutations)
        .filter((entry) => /^(CREATE|INSERT|DROP)\b/.test(entry.sql)).length,
      0,
    );
    assert.deepEqual(f.workflowState(), {
      workflowExists: false,
      workflowInstance: null,
    });
  });
