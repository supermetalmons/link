import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowPublicationDependencies,
  parsePublishWorkflowArgs,
  parseWorkflowPublicationConfiguration,
  publishCloudflareWorkflows,
  type PublishWorkflowArguments,
} from "./publish-cloudflare-workflows.ts";

const WORKER_VERSION = "00000000-0000-4000-8000-000000000001";
const OLD_VERSION = "00000000-0000-4000-8000-000000000002";
const ACCOUNT = "a".repeat(32);
const TOKEN = "private-provider-token-never-log";
const workflowNames = [
  "mons-link-event-progress",
  "mons-link-event-prize-withdrawal",
];
const classes = ["EventProgressWorkflow", "EventPrizeWithdrawalWorkflow"];
const uuid = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
type JsonRecord = Record<string, unknown>;

function configurationText(): string {
  return JSON.stringify({
    name: "mons-link-api",
    account_id: ACCOUNT,
    workflows: workflowNames.map((name, index) => ({
      name,
      binding: `BINDING_${index}`,
      class_name: classes[index],
    })),
    queues: { consumers: [{ queue: "do-not-touch" }] },
    triggers: { crons: ["*/5 * * * *"] },
    routes: [{ pattern: "api.mons.link", custom_domain: true }],
  });
}

function fixture() {
  const configuration =
    parseWorkflowPublicationConfiguration(configurationText());
  const resources = new Map<string, JsonRecord>();
  const versions = new Map<string, JsonRecord>();
  for (let index = 0; index < workflowNames.length; index++) {
    const name = workflowNames[index];
    const id = uuid(index + 10);
    const versionId = uuid(index + 20);
    resources.set(name, {
      id,
      name,
      class_name: classes[index],
      script_name: "mons-link-api",
      version_id: versionId,
      is_deleted: 0,
      terminator_running: 0,
      ...(index === 0
        ? {
            schedules: [
              { cron: "0 12 * * 0", next_instance: "derived-provider-value" },
            ],
          }
        : {}),
    });
    versions.set(versionId, {
      id: versionId,
      workflow_id: id,
      class_name: classes[index],
      language: "javascript",
      has_dag: false,
      limits: { steps: 10000 },
      default_retention: {
        success_retention: 2592000000,
        error_retention: 2592000000,
      },
      ...(index === 0 ? { concurrency: { limit: 7 } } : {}),
    });
  }
  const state = {
    deployedVersion: WORKER_VERSION,
    latestUploadedVersion: WORKER_VERSION,
    deploymentPercentage: 100,
    splitDeployment: false,
    nextVersion: 30,
    failPutFor: "",
    invalidNewMetadata: false,
    invalidNewOptions: false,
    actualGetShape: false,
    minimalPutShape: false,
    emptyVersions: false,
    invalidListedOwner: false,
    before: undefined as ((path: string, method: string) => void) | undefined,
    calls: [] as Array<{
      path: string;
      method: string;
      body: JsonRecord | null;
    }>,
    logs: [] as unknown[],
  };
  const deps = createWorkflowPublicationDependencies({
    configuration,
    token: TOKEN,
    log: (value) => state.logs.push(value),
    fetcher: async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, "https://api.cloudflare.com");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${TOKEN}`,
      );
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      const path = parsed.pathname.slice(
        `/client/v4/accounts/${ACCOUNT}`.length,
      );
      const method = init?.method || "GET";
      const body = init?.body
        ? (JSON.parse(String(init.body)) as JsonRecord)
        : null;
      state.calls.push({ path, method, body });
      state.before?.(path, method);
      if (path === "/workers/scripts/mons-link-api/versions") {
        assert.equal(method, "GET");
        assert.equal(parsed.searchParams.get("page"), "1");
        assert.equal(parsed.searchParams.get("per_page"), "1");
        return Response.json({
          success: true,
          result: { items: [{ id: state.latestUploadedVersion }] },
        });
      }
      if (path === "/workers/scripts/mons-link-api/deployments") {
        assert.equal(method, "GET");
        return Response.json({
          success: true,
          result: {
            deployments: [
              {
                created_on: "2026-01-01T00:00:00.000Z",
                versions: [{ version_id: OLD_VERSION, percentage: 100 }],
              },
              {
                created_on: "2026-09-11T00:00:00.000Z",
                versions: state.splitDeployment
                  ? [
                      { version_id: state.deployedVersion, percentage: 99 },
                      { version_id: OLD_VERSION, percentage: 1 },
                    ]
                  : [
                      {
                        version_id: state.deployedVersion,
                        percentage: state.deploymentPercentage,
                      },
                    ],
              },
            ],
          },
        });
      }
      const versionList = /^\/workflows\/([^/]+)\/versions$/.exec(path);
      if (versionList) {
        assert.equal(method, "GET");
        assert.equal(parsed.searchParams.get("per_page"), "1");
        const resource = resources.get(versionList[1]);
        assert.ok(resource);
        const version = versions.get(String(resource.version_id));
        assert.ok(version);
        return Response.json({
          success: true,
          result: state.emptyVersions
            ? []
            : [
                {
                  ...structuredClone(version),
                  ...(state.invalidListedOwner
                    ? { workflow_id: uuid(99) }
                    : {}),
                },
              ],
        });
      }
      const versionMatch = /^\/workflows\/([^/]+)\/versions\/([^/]+)$/.exec(
        path,
      );
      if (versionMatch) {
        assert.equal(method, "GET");
        const version = versions.get(versionMatch[2]);
        if (!version) return Response.json({ success: false }, { status: 404 });
        return Response.json({
          success: true,
          result: structuredClone(version),
        });
      }
      const resourceMatch = /^\/workflows\/([^/]+)$/.exec(path);
      assert.ok(resourceMatch, `unexpected provider surface ${path}`);
      const name = resourceMatch[1];
      const resource = resources.get(name);
      assert.ok(resource);
      if (method === "GET") {
        const result = structuredClone(resource);
        if (state.actualGetShape) {
          delete result.version_id;
          delete result.is_deleted;
          delete result.terminator_running;
          result.instances = { running: 0, waiting: 6 };
        }
        return Response.json({
          success: true,
          result,
        });
      }
      assert.equal(method, "PUT");
      if (name === state.failPutFor)
        return Response.json(
          { success: false, errors: [{ message: TOKEN }] },
          { status: 503 },
        );
      assert.ok(body);
      const versionId = uuid(state.nextVersion++);
      const next = {
        id: versionId,
        workflow_id: state.invalidNewMetadata ? uuid(99) : resource.id,
        class_name: body.class_name,
        ...Object.fromEntries(
          ["default_retention", "limits", "concurrency"]
            .filter((key) => body[key] !== undefined)
            .map((key) => [key, body[key]]),
        ),
      };
      if (state.invalidNewOptions)
        Object.assign(next, { limits: { steps: 999 } });
      versions.set(versionId, next);
      resource.version_id = versionId;
      resource.script_name = body.script_name;
      resource.class_name = body.class_name;
      if (body.schedules !== undefined) resource.schedules = body.schedules;
      return Response.json({
        success: true,
        result: state.minimalPutShape
          ? { version_id: versionId }
          : structuredClone(resource),
      });
    },
  });
  const execute = (extra: Partial<PublishWorkflowArguments> = {}) =>
    publishCloudflareWorkflows(
      {
        versionId: WORKER_VERSION,
        workflows: [],
        dryRun: false,
        ...extra,
      },
      deps,
    );
  return { state, deps, resources, versions, execute };
}

test("requires an explicit Worker version and validates selected Workflow arguments", () => {
  assert.deepEqual(parsePublishWorkflowArgs(["--version-id", WORKER_VERSION]), {
    versionId: WORKER_VERSION,
    workflows: [],
    dryRun: false,
  });
  assert.deepEqual(
    parsePublishWorkflowArgs([
      "--dry-run",
      "--workflow",
      workflowNames[0],
      "--version-id",
      WORKER_VERSION,
    ]),
    { versionId: WORKER_VERSION, workflows: [workflowNames[0]], dryRun: true },
  );
  for (const args of [
    [],
    ["--dry-run"],
    ["--version-id", "latest"],
    ["--version-id", WORKER_VERSION, "--unknown", "x"],
    ["--version-id", WORKER_VERSION, "--dry-run", "--dry-run"],
    ["--version-id", WORKER_VERSION, "--workflow", "x", "--workflow", "x"],
  ]) {
    assert.throws(() => parsePublishWorkflowArgs(args));
  }
});

test("parses JSONC and excludes bindings owned by another Worker", () => {
  const source = JSON.parse(configurationText());
  source.workflows.push({
    name: "external",
    binding: "EXTERNAL",
    script_name: "different-worker",
  });
  const result = parseWorkflowPublicationConfiguration(
    `// tracked configuration\n${JSON.stringify(source)}`,
  );
  assert.equal(result.workflows.length, 2);
  assert.throws(
    () =>
      parseWorkflowPublicationConfiguration(
        JSON.stringify({ ...source, name: "other" }),
      ),
    /invalid tracked/,
  );
  source.workflows.push({ ...source.workflows[0] });
  assert.throws(
    () => parseWorkflowPublicationConfiguration(JSON.stringify(source)),
    /duplicate/,
  );
});

test("publishes owned Workflow definitions while preserving current options and reports distinct version IDs", async () => {
  const f = fixture();
  const result = await f.execute();
  assert.equal(result.mode, "published");
  assert.equal(result.workerVersionId, WORKER_VERSION);
  assert.equal(result.workflows.length, 2);
  const puts = f.state.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[0].body, {
    script_name: "mons-link-api",
    class_name: classes[0],
    limits: { steps: 10000 },
    default_retention: {
      success_retention: 2592000000,
      error_retention: 2592000000,
    },
    concurrency: { limit: 7 },
    schedules: [{ cron: "0 12 * * 0" }],
  });
  assert.equal("concurrency" in puts[1].body!, false);
  for (const row of result.workflows) {
    assert.equal("workflowVersionId" in row, true);
    assert.notEqual(
      "workflowVersionId" in row && row.workflowVersionId,
      WORKER_VERSION,
    );
  }
  assert.equal(JSON.stringify(f.state.logs).includes(TOKEN), false);
  assert.equal(
    f.state.calls.some((call) =>
      /\/(queues|instances|routes|schedules)(?:\/|$)/.test(call.path),
    ),
    false,
  );
});

test("dry-run performs only reads and previews the exact preserved definition", async () => {
  const f = fixture();
  const result = await f.execute({ dryRun: true });
  assert.equal(result.mode, "dry-run");
  assert.ok(f.state.calls.every((call) => call.method === "GET"));
  assert.equal(result.workflows[0].previousWorkflowVersionId, uuid(20));
  assert.deepEqual(result.workflows[0].publishBody.concurrency, { limit: 7 });
  assert.deepEqual(f.state.logs, []);
});

test("explicit selection touches only the selected configured Workflow", async () => {
  const f = fixture();
  const result = await f.execute({ workflows: [workflowNames[1]] });
  assert.equal(result.workflows.length, 1);
  assert.equal(
    f.state.calls.some((call) =>
      call.path.startsWith(`/workflows/${workflowNames[0]}`),
    ),
    false,
  );
  await assert.rejects(f.execute({ workflows: ["unowned"] }), /not owned/);
});

test("wrong or split Worker deployments fail before any Workflow publication", async () => {
  for (const change of ["wrong", "split", "percentage"]) {
    const f = fixture();
    if (change === "wrong") f.state.deployedVersion = OLD_VERSION;
    if (change === "split") f.state.splitDeployment = true;
    if (change === "percentage") f.state.deploymentPercentage = 99;
    await assert.rejects(f.execute(), /exact-Worker-version/);
    assert.ok(f.state.calls.every((call) => call.method === "GET"));
    assert.equal(
      f.state.calls.some((call) => call.path.startsWith("/workflows/")),
      false,
    );
  }
});

test("all ownership and metadata preflights finish before the first mutation", async () => {
  const f = fixture();
  f.resources.get(workflowNames[1])!.script_name = "unrelated-worker";
  await assert.rejects(f.execute(), /ownership-conflict/);
  assert.equal(f.state.calls.filter((call) => call.method === "PUT").length, 0);
  assert.ok(
    f.state.calls.some((call) =>
      call.path.includes(`/workflows/${workflowNames[0]}/versions/`),
    ),
  );
});

test("changed resource options between preparation and publication block the write", async () => {
  const f = fixture();
  let reads = 0;
  f.state.before = (path, method) => {
    if (
      path === `/workflows/${workflowNames[0]}` &&
      method === "GET" &&
      ++reads === 2
    )
      f.versions.get(uuid(20))!.limits = { steps: 20000 };
  };
  await assert.rejects(f.execute(), /changed after preparation/);
  assert.equal(f.state.calls.filter((call) => call.method === "PUT").length, 0);
});

test("Worker deployment is rechecked immediately before publication", async () => {
  const f = fixture();
  let reads = 0;
  f.state.before = (path, method) => {
    if (
      path === `/workflows/${workflowNames[0]}` &&
      method === "GET" &&
      ++reads === 2
    )
      f.state.deployedVersion = OLD_VERSION;
  };
  await assert.rejects(f.execute(), /exact-Worker-version/);
  assert.equal(f.state.calls.filter((call) => call.method === "PUT").length, 0);
});

test("mismatched new version metadata and changed options cannot be reported as verified", async () => {
  const metadata = fixture();
  metadata.state.invalidNewMetadata = true;
  await assert.rejects(metadata.execute(), /version-metadata-conflict/);
  assert.deepEqual(metadata.state.logs, []);
  const options = fixture();
  options.state.invalidNewOptions = true;
  await assert.rejects(options.execute(), /readback-conflict/);
  assert.deepEqual(options.state.logs, []);
});

test("non-2xx publication failure preserves previous success evidence and never prints provider errors", async () => {
  const f = fixture();
  f.state.failPutFor = workflowNames[1];
  await assert.rejects(
    f.execute(),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("PUT:503") &&
      !error.message.includes(TOKEN),
  );
  assert.equal(f.state.logs.length, 1);
  assert.equal((f.state.logs[0] as JsonRecord).name, workflowNames[0]);
  assert.equal(JSON.stringify(f.state.logs).includes(TOKEN), false);
});

test("provider failures and malformed success envelopes are sanitized", async () => {
  const configuration =
    parseWorkflowPublicationConfiguration(configurationText());
  for (const fetcher of [
    async () => {
      throw new Error(TOKEN);
    },
    async () => Response.json({ success: false, errors: [{ message: TOKEN }] }),
    async () => new Response(TOKEN),
    async () => Response.json({ success: true, result: {} }, { status: 503 }),
  ]) {
    const deps = createWorkflowPublicationDependencies({
      configuration,
      token: TOKEN,
      fetcher,
      log: () => undefined,
    });
    await assert.rejects(
      deps.request("/workflows/example"),
      (error: unknown) =>
        error instanceof Error && !error.message.includes(TOKEN),
    );
  }
});

test("unknown current option fields fail closed rather than being dropped", async () => {
  const f = fixture();
  f.versions.get(uuid(20))!.limits = { steps: 10000, future_option: 1 };
  await assert.rejects(f.execute(), /invalid-current-options/);
  assert.equal(f.state.calls.filter((call) => call.method === "PUT").length, 0);
});

test("actual GET resource shape resolves current Workflow version from its version list", async () => {
  const f = fixture();
  f.state.actualGetShape = true;
  const result = await f.execute({ dryRun: true });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.workflows[0].previousWorkflowVersionId, uuid(20));
  assert.equal(result.workflows[1].previousWorkflowVersionId, uuid(21));
  assert.equal(
    f.state.calls.filter((call) =>
      /^\/workflows\/[^/]+\/versions$/.test(call.path),
    ).length,
    2,
  );
  assert.ok(f.state.calls.every((call) => call.method === "GET"));
});

test("minimal PUT acknowledgment still requires full resource and version readback", async () => {
  const f = fixture();
  f.state.actualGetShape = true;
  f.state.minimalPutShape = true;
  const result = await f.execute();
  assert.equal(result.mode, "published");
  assert.equal(f.state.calls.filter((call) => call.method === "PUT").length, 2);
  assert.equal(
    "workflowVersionId" in result.workflows[0] &&
      result.workflows[0].workflowVersionId,
    uuid(30),
  );
});

test("unavailable or incorrectly owned latest Workflow versions fail before publication", async () => {
  for (const invalid of ["missing", "ownership"]) {
    const f = fixture();
    f.state.actualGetShape = true;
    f.state.emptyVersions = invalid === "missing";
    f.state.invalidListedOwner = invalid === "ownership";
    await assert.rejects(
      f.execute(),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.message.includes(
          invalid === "missing"
            ? "current-version-unavailable"
            : "version-metadata-conflict",
        ),
    );
    assert.equal(
      f.state.calls.filter((call) => call.method === "PUT").length,
      0,
    );
  }
});

test("a newer unpromoted Worker upload prevents publishing Workflow code under an older deployment proof", async () => {
  const f = fixture();
  f.state.latestUploadedVersion = uuid(99);
  await assert.rejects(f.execute(), /latest-uploaded-Worker-version/);
  assert.equal(f.state.calls.filter((call) => call.method === "PUT").length, 0);
});

test("latest uploaded Worker version is rechecked immediately before publication", async () => {
  const f = fixture();
  let reads = 0;
  f.state.before = (path, method) => {
    if (
      path === `/workflows/${workflowNames[0]}` &&
      method === "GET" &&
      ++reads === 2
    )
      f.state.latestUploadedVersion = uuid(99);
  };
  await assert.rejects(f.execute(), /latest-uploaded-Worker-version/);
  assert.equal(f.state.calls.filter((call) => call.method === "PUT").length, 0);
});
