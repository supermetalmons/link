import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  convertV4MiniflareOptions,
  Log,
  LogLevel,
  Miniflare,
  MiniflareOptionsSchema,
  type RemoteProxyConnectionString,
} from "miniflare";
import {
  openNativeMaintenanceBindings,
  openRemoteD1Transport,
  remoteD1Configuration,
  type RemoteD1Binding,
  openRemoteMaintenanceTransport,
  remoteMaintenanceChildEnvironment,
  remoteMaintenanceConfiguration,
  remoteMaintenanceDiagnostic,
  RemoteMaintenanceFailure,
  remoteMaintenanceRuntimeOptions,
  requireExistingWorkersSubdomain,
  type NativeMaintenanceDependencies,
} from "./operator/remoteMaintenanceBinding.ts";

const ACCOUNT = "a".repeat(32);
const IDS = {
  PROFILE_GAMES_DB: "11111111-1111-4111-8111-111111111111",
  PROFILE_DB: "22222222-2222-4222-8222-222222222222",
  EVENT_DB: "33333333-3333-4333-8333-333333333333",
  AUTH_STATE_DB: "44444444-4444-4444-8444-444444444444",
  TELEGRAM_DB: "55555555-5555-4555-8555-555555555555",
};
const CONTROL = {
  singleton: 1,
  generation: 3,
  data_epoch: 1,
  phase: "active",
  migration_id: null,
};
const confirmed = (rows: Record<string, unknown>[] = [], changes = 0) => ({
  success: true,
  results: rows,
  meta: { changes },
});
type LocalStatement = {
  bind(...values: (string | number | null)[]): LocalStatement;
};
type LocalDatabase = {
  prepare(sql: string): LocalStatement;
  batch(
    statements: LocalStatement[],
  ): Promise<Array<{ results: Record<string, unknown>[] }>>;
};

function configuration(t: test.TestContext, targetBinding?: RemoteD1Binding) {
  const directory = mkdtempSync(resolve(tmpdir(), "remote-maintenance-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "source.json");
  writeFileSync(
    path,
    JSON.stringify({
      account_id: ACCOUNT,
      name: "production-worker",
      compatibility_date: "2026-08-09",
      vars: { UNRELATED_SECRET: "must-not-be-copied" },
      services: [{ binding: "UNRELATED", service: "unrelated" }],
      d1_databases: Object.entries(IDS).map(([binding, database_id]) => ({
        binding,
        database_id,
        database_name: binding,
        preview_database_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      })),
    }),
  );
  return {
    path,
    directory,
    value: targetBinding
      ? remoteD1Configuration(targetBinding, path)
      : remoteMaintenanceConfiguration("PROFILE_DB", path),
  };
}

function nativeFixture(t: test.TestContext, targetBinding?: RemoteD1Binding) {
  const source = configuration(t, targetBinding);
  type Runtime = Awaited<
    ReturnType<NativeMaintenanceDependencies["createRuntime"]>
  >;
  type Database = Awaited<ReturnType<Runtime["getBindings"]>>[string];
  type Prepared = ReturnType<Database["prepare"]>;
  const calls: string[] = [],
    batches: Array<{
      binding: string;
      statements: Array<{ sql: string; bindings: (string | number | null)[] }>;
    }> = [];
  const prepared = new Map<
    Prepared,
    { sql: string; bindings: (string | number | null)[] }
  >();
  const f = {
    failPreflight: false,
    failStart: false,
    failCreate: false,
    failBindings: false,
    failBatch: false,
    failLocalDispose: false,
    failRemoteDispose: false,
    extraBinding: false,
  };
  const makeDatabase = (binding: string): Database => {
    const prepare = (
      sql: string,
      values: (string | number | null)[] = [],
    ): Prepared => {
      const statement = {
        bind(...bindings: (string | number | null)[]) {
          return prepare(sql, bindings);
        },
        async all() {
          calls.push(`all:${binding}:${sql}`);
          return confirmed([CONTROL]);
        },
      };
      prepared.set(statement, { sql, bindings: values });
      return statement;
    };
    return {
      prepare,
      withSession(constraint) {
        calls.push(`session:${binding}:${constraint}`);
        return { prepare };
      },
      async batch(statements) {
        calls.push(`batch:${binding}`);
        batches.push({
          binding,
          statements: statements.map((statement) => prepared.get(statement)!),
        });
        if (f.failBatch) throw new Error("private-provider-message");
        return statements.map(() => confirmed([], 1));
      },
    };
  };
  const dependencies: NativeMaintenanceDependencies = {
    async preflight() {
      calls.push("preflight");
      if (f.failPreflight) throw new Error("subdomain-absent");
    },
    async startSession(input) {
      calls.push("start-remote");
      if (f.failStart)
        throw Object.assign(new Error("private-token-in-provider-message"), {
          code: 10000,
          status: 403,
        });
      assert.equal(input.configuration.accountId, ACCOUNT);
      assert.deepEqual(
        input.configuration.databases.map((row) => row.binding),
        source.value.databases.map((row) => row.binding),
      );
      return {
        remoteProxyConnectionString: new URL(
          "http://127.0.0.1:12345",
        ) as RemoteProxyConnectionString,
        async dispose() {
          calls.push("dispose-remote");
          if (f.failRemoteDispose) throw Error("remote-dispose-failed");
        },
      };
    },
    async createRuntime(_input, session) {
      calls.push("create-local");
      assert.equal(
        session.remoteProxyConnectionString.href,
        "http://127.0.0.1:12345/",
      );
      if (f.failCreate) throw new Error("runtime-construction-failed");
      return {
        async getBindings() {
          calls.push("bindings");
          if (f.failBindings) throw new Error("bindings-failed");
          return {
            ...Object.fromEntries(
              source.value.databases.map((row) => [
                row.binding,
                makeDatabase(row.binding),
              ]),
            ),
            ...(f.extraBinding ? { EVENT_DB: makeDatabase("EVENT_DB") } : {}),
          };
        },
        async dispose() {
          calls.push("dispose-local");
          if (f.failLocalDispose) throw Error("local-dispose-failed");
        },
      };
    },
  };
  return {
    f,
    source,
    calls,
    batches,
    open: () =>
      openNativeMaintenanceBindings(
        {
          configuration: source.value,
          directory: source.directory,
          apiToken: "private-test-token",
        },
        dependencies,
      ),
  };
}

test("native transport sends one prepared batch in order and reads central control from first-primary", async (t) => {
  const f = nativeFixture(t),
    session = await f.open();
  assert.deepEqual(await session.transport.readControl(), [CONTROL]);
  const statements = [
    {
      sql: "INSERT INTO application_write_context VALUES (?, ?)",
      bindings: [1, "op"],
    },
    {
      sql: "UPDATE profile_canonical_control SET generation = ? WHERE singleton = ?",
      bindings: [3, 1],
    },
    {
      sql: "DELETE FROM application_write_context WHERE operation_id = ?",
      bindings: ["op"],
    },
  ];
  assert.equal(
    (await session.transport.atomicBatch("PROFILE_DB", statements)).length,
    3,
  );
  assert.deepEqual(f.batches, [{ binding: "PROFILE_DB", statements }]);
  assert.ok(f.calls.includes("session:PROFILE_GAMES_DB:first-primary"));
  await session.dispose();
  await session.dispose();
  assert.equal(f.calls.filter((entry) => entry === "dispose-local").length, 1);
  assert.equal(f.calls.filter((entry) => entry === "dispose-remote").length, 1);
  await assert.rejects(session.transport.readControl(), /session-closed/);
});

test("missing preflight qualification never starts a remote proxy", async (t) => {
  const f = nativeFixture(t);
  f.f.failPreflight = true;
  await assert.rejects(f.open(), /startup-unconfirmed/);
  assert.deepEqual(f.calls, ["preflight"]);
});

test("startup failure disposes every acquired handle and unexpected bindings fail closed", async (t) => {
  for (const flag of ["failCreate", "failBindings", "extraBinding"] as const) {
    const f = nativeFixture(t);
    f.f[flag] = true;
    await assert.rejects(f.open(), /startup-unconfirmed/);
    assert.ok(f.calls.includes("dispose-remote"));
    assert.equal(f.calls.includes("dispose-local"), flag !== "failCreate");
    assert.equal(f.batches.length, 0);
  }
});

test("both disposals are attempted when one fails", async (t) => {
  const f = nativeFixture(t),
    session = await f.open();
  f.f.failLocalDispose = true;
  await assert.rejects(session.dispose(), /disposal-unconfirmed/);
  assert.ok(f.calls.includes("dispose-remote"));
});

test("native batch failure is never retried and cannot widen selected database coverage", async (t) => {
  const f = nativeFixture(t),
    session = await f.open();
  f.f.failBatch = true;
  await assert.rejects(
    session.transport.atomicBatch("PROFILE_DB", [
      { sql: "SELECT ?", bindings: [1] },
    ]),
  );
  assert.equal(f.batches.length, 1);
  await assert.rejects(
    session.transport.atomicBatch("EVENT_DB", [
      { sql: "SELECT 1", bindings: [] },
    ]),
    /binding-outside-session/,
  );
  assert.equal(f.batches.length, 1);
  await session.dispose();
});

test("child environment excludes ambient credentials, endpoint overrides and Node injection", () => {
  const env = remoteMaintenanceChildEnvironment("/private/task", {
    HOME: "/original/home",
    PATH: "/usr/bin",
    CLOUDFLARE_API_TOKEN: "private-token",
    CLOUDFLARE_API_BASE_URL: "https://untrusted.invalid",
    CF_API_TOKEN: "other-token",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    CLOUDFLARE_ENV: "other",
    NODE_OPTIONS: "--import untrusted",
    HTTPS_PROXY: "http://other",
  });
  assert.equal(env.HOME, "/original/home");
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CF_API_TOKEN",
    "CLOUDFLARE_API_BASE_URL",
    "CLOUDFLARE_ENV",
    "NODE_OPTIONS",
    "HTTPS_PROXY",
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.CLOUDFLARE_INCLUDE_PROCESS_ENV, "false");
  assert.equal(env.WRANGLER_LOG, "none");
});

class FakeChild extends EventEmitter {
  connected = true;
  pid = 123456;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  messages: Record<string, unknown>[] = [];
  startFailure = false;
  invalidResponse = false;
  failureDiagnostic: unknown;
  send(value: unknown, callback: (error: Error | null) => void) {
    const message = value as Record<string, unknown>;
    this.messages.push(message);
    queueMicrotask(() => {
      if (this.invalidResponse) {
        this.emit("message", { id: "invalid", ok: true });
        return;
      }
      const data =
        message.kind === "readControl"
          ? [CONTROL]
          : message.kind === "atomicBatch"
            ? (message.payload as { statements: unknown[] }).statements.map(
                () => confirmed([], 1),
              )
            : null;
      this.emit("message", {
        id: message.id,
        ok: !(message.kind === "start" && this.startFailure),
        value: data,
        ...(this.failureDiagnostic === undefined
          ? {}
          : { diagnostic: this.failureDiagnostic }),
      });
    });
    callback(null);
    return true;
  }
  disconnect() {
    this.connected = false;
  }
}

function parentFixture(t: test.TestContext, child = new FakeChild()) {
  const source = configuration(t);
  let directory = "",
    stopped = 0;
  return {
    child,
    source,
    directory: () => directory,
    stopped: () => stopped,
    open: () =>
      openRemoteMaintenanceTransport(
        "PROFILE_DB",
        { configPath: source.path, apiToken: "private-test-token" },
        {
          spawn(path) {
            directory = path;
            return child as unknown as ChildProcess;
          },
          stopGroup(value) {
            assert.equal(value, child);
            stopped++;
            child.signalCode = "SIGKILL";
            child.emit("exit", null, "SIGKILL");
          },
        },
      ),
  };
}

test("parent creates only private exact-binding config, passes credentials over IPC and disposes its child", async (t) => {
  const f = parentFixture(t),
    session = await f.open(),
    path = resolve(f.directory(), "wrangler.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(f.directory(), realpathSync(f.directory()));
  assert.equal(statSync(f.directory()).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(config).sort(), [
    "account_id",
    "compatibility_date",
    "d1_databases",
    "name",
  ]);
  assert.deepEqual(
    config.d1_databases.map((row: { database_id: string }) => row.database_id),
    [IDS.PROFILE_GAMES_DB, IDS.PROFILE_DB],
  );
  assert.ok(
    config.d1_databases.every(
      (row: { remote: boolean }) => row.remote === true,
    ),
  );
  assert.equal(
    readFileSync(path, "utf8").includes("private-test-token"),
    false,
  );
  assert.equal(
    (f.child.messages[0]!.payload as { apiToken: string }).apiToken,
    "private-test-token",
  );
  assert.deepEqual(await session.transport.readControl(), [CONTROL]);
  await session.transport.atomicBatch("PROFILE_DB", [
    { sql: "SELECT ?", bindings: [1] },
  ]);
  await session.dispose();
  assert.equal(f.stopped(), 1);
  assert.equal(existsSync(f.directory()), false);
  await assert.rejects(session.transport.readControl(), /session-closed/);
});

test("parent startup error and malformed IPC close the entire child group and remove its directory", async (t) => {
  for (const mode of ["startFailure", "invalidResponse"] as const) {
    const child = new FakeChild();
    child[mode] = true;
    const f = parentFixture(t, child);
    await assert.rejects(f.open(), /startup-unconfirmed/);
    assert.equal(f.stopped(), 1);
    assert.equal(existsSync(f.directory()), false);
  }
});

test("pinned Miniflare accepts the remote native binding options without persistent local storage", (t) => {
  const source = configuration(t),
    connection = new URL(
      "http://127.0.0.1:12345",
    ) as RemoteProxyConnectionString;
  const options = remoteMaintenanceRuntimeOptions(
    { configuration: source.value, directory: source.directory },
    connection,
  );
  assert.equal(options.resourcePersistencePath, undefined);
  assert.equal(options.cacheAPI, false);
  assert.equal(options.unsafeRegisterWorker, false);
  assert.deepEqual(Object.keys(options.d1Databases ?? {}).sort(), [
    "PROFILE_DB",
    "PROFILE_GAMES_DB",
  ]);
  assert.doesNotThrow(() =>
    MiniflareOptionsSchema.parse(convertV4MiniflareOptions(options)),
  );
});

test("existing-subdomain preflight is GET-only and rejects absent or malformed account state", async () => {
  for (const [status, value, accepted] of [
    [200, { success: true, result: { subdomain: "existing-subdomain" } }, true],
    [404, { success: false, errors: [{ code: 10007 }] }, false],
    [200, { success: true, result: {} }, false],
    [200, { success: false, result: { subdomain: "existing" } }, false],
  ] as const) {
    let requests = 0;
    const request = requireExistingWorkersSubdomain(
      ACCOUNT,
      "private-token",
      async (url, options) => {
        requests++;
        assert.equal(
          String(url),
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/subdomain`,
        );
        assert.equal(options?.method, "GET");
        assert.equal(options?.redirect, "error");
        assert.equal(
          new Headers(options?.headers).get("Authorization"),
          "Bearer private-token",
        );
        return Response.json(value, { status });
      },
    );
    if (accepted) await request;
    else await assert.rejects(request, /existing-subdomain-required/);
    assert.equal(requests, 1);
  }
});

test("an idle real child tears down its own process group when the parent disconnects", async (t) => {
  const source = configuration(t);
  const child = fork(
    resolve(import.meta.dirname, "operator/remoteMaintenanceBinding.ts"),
    ["--remote-maintenance-child"],
    {
      cwd: source.directory,
      detached: true,
      env: remoteMaintenanceChildEnvironment(source.directory),
      execArgv: [
        "--experimental-strip-types",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      ],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      reject(new Error("child-disconnect-cleanup-timeout"));
    }, 5_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (_code, signal) => {
      clearTimeout(timer);
      assert.equal(signal, "SIGKILL");
      resolveExit();
    });
    child.disconnect();
  });
});

test("asynchronous fork failure without a PID cleans its private directory without awaiting a nonexistent process", async (t) => {
  const source = configuration(t),
    child = new FakeChild() as unknown as ChildProcess;
  Object.defineProperty(child, "pid", { value: undefined });
  let directory = "";
  await assert.rejects(
    openRemoteMaintenanceTransport(
      "PROFILE_DB",
      { configPath: source.path, apiToken: "private-test-token" },
      {
        spawn(path) {
          directory = path;
          queueMicrotask(() => child.emit("error", new Error("spawn-failed")));
          return child;
        },
        stopGroup(value) {
          assert.equal(value.pid, undefined);
        },
      },
    ),
    /startup-unconfirmed/,
  );
  assert.equal(existsSync(directory), false);
});

test(
  "real local Miniflare exposes native D1 batches with the production module shape",
  { timeout: 15_000 },
  async (t) => {
    const source = configuration(t);
    const options = remoteMaintenanceRuntimeOptions(
      {
        configuration: source.value,
        directory: realpathSync(source.directory),
      },
      new URL("http://127.0.0.1:1") as RemoteProxyConnectionString,
    );
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        ...options,
        log: new Log(LogLevel.NONE),
        d1Databases: Object.fromEntries(
          source.value.databases.map((row) => [
            row.binding,
            { id: row.databaseId },
          ]),
        ),
      }),
    );
    t.after(() => runtime.dispose());
    const bindings = await runtime.getBindings<Record<string, LocalDatabase>>();
    assert.deepEqual(Object.keys(bindings).sort(), [
      "PROFILE_DB",
      "PROFILE_GAMES_DB",
    ]);
    const db = bindings.PROFILE_DB!;
    const output = await db.batch([
      db.prepare("SELECT ? AS marker").bind("local-native-proof"),
      db.prepare("SELECT 1 AS ready"),
    ]);
    assert.deepEqual(
      output.map((row) => row.results),
      [[{ marker: "local-native-proof" }], [{ ready: 1 }]],
    );
  },
);

test("startup diagnostics distinguish native stages while retaining cleanup uncertainty", async (t) => {
  for (const [flag, stage] of [
    ["failPreflight", "preflight"],
    ["failStart", "remote-session"],
    ["failCreate", "local-runtime"],
    ["failBindings", "binding-read"],
    ["extraBinding", "binding-validation"],
  ] as const) {
    const f = nativeFixture(t);
    f.f[flag] = true;
    if (flag === "failBindings") f.f.failLocalDispose = true;
    await assert.rejects(f.open(), (error: unknown) => {
      assert.ok(error instanceof RemoteMaintenanceFailure);
      assert.equal(error.diagnostic?.stage, stage);
      assert.equal(
        error.diagnostic?.cleanupUnconfirmed,
        flag === "failBindings",
      );
      if (flag === "failStart") {
        assert.equal(error.diagnostic?.providerCode, 10000);
        assert.equal(error.diagnostic?.httpStatus, 403);
      }
      assert.doesNotMatch(
        JSON.stringify(error),
        /private-token|provider-message/,
      );
      return true;
    });
  }
});

test("diagnostics expose only allowlisted names/codes and numeric provider status", () => {
  const error = Object.assign(new Error("private-message-token"), {
    name: "private-name-token",
    code: "private-code-token",
    status: 403,
    cause: Object.assign(new Error("private-nested-token"), { code: 10000 }),
  });
  assert.deepEqual(remoteMaintenanceDiagnostic("remote-session", error), {
    stage: "remote-session",
    causeName: "Error",
    causeCode: null,
    providerCode: 10000,
    httpStatus: 403,
    cleanupUnconfirmed: false,
  });
  const network = Object.assign(new Error("private-network-host"), {
    code: "ENOTFOUND",
  });
  assert.equal(
    remoteMaintenanceDiagnostic("preflight", network).causeCode,
    "ENOTFOUND",
  );
});

test("parent preserves sanitized child startup diagnostics and rejects unsafe diagnostic text", async (t) => {
  for (const unsafe of [false, true]) {
    const child = new FakeChild();
    child.startFailure = true;
    child.failureDiagnostic = {
      stage: "remote-session",
      causeName: "APIError",
      causeCode: unsafe ? "private-credential-token" : null,
      providerCode: 10000,
      httpStatus: 403,
      cleanupUnconfirmed: false,
    };
    const f = parentFixture(t, child);
    await assert.rejects(f.open(), (error: unknown) => {
      assert.ok(error instanceof RemoteMaintenanceFailure);
      assert.equal(
        error.diagnostic?.stage,
        unsafe ? "child-response" : "remote-session",
      );
      assert.equal(error.diagnostic?.providerCode, unsafe ? null : 10000);
      assert.doesNotMatch(JSON.stringify(error), /private-credential-token/);
      return true;
    });
    assert.equal(f.stopped(), 1);
  }
});

test(
  "real child accepts a canonical private temp path and reaches credential preflight without providers",
  { timeout: 10_000 },
  async (t) => {
    const source = configuration(t),
      directory = realpathSync(source.directory);
    const child = fork(
      resolve(import.meta.dirname, "operator/remoteMaintenanceBinding.ts"),
      ["--remote-maintenance-child"],
      {
        cwd: directory,
        detached: true,
        env: remoteMaintenanceChildEnvironment(directory),
        execArgv: [
          "--experimental-strip-types",
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        ],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const exit = new Promise<void>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolveExit());
    });
    try {
      const response = await new Promise<unknown>((resolveResponse, reject) => {
        child.once("error", reject);
        child.once("message", resolveResponse);
        child.send({
          id: 1,
          kind: "start",
          payload: { configuration: source.value, directory, apiToken: "" },
        });
      });
      assert.deepEqual(response, {
        id: 1,
        ok: false,
        diagnostic: {
          stage: "preflight",
          causeName: "RemoteMaintenanceFailure",
          causeCode: "invalid-preflight-credentials",
          providerCode: null,
          httpStatus: null,
          cleanupUnconfirmed: false,
        },
      });
    } finally {
      if (child.connected) child.disconnect();
      await exit;
    }
  },
);

test("six-binding transport is explicit while legacy maintenance remains restricted", async (t) => {
  const source = configuration(t);
  for (const binding of ["AUTH_STATE_DB", "TELEGRAM_DB"] as const) {
    assert.deepEqual(
      remoteD1Configuration(binding, source.path).databases.map(
        (row) => row.binding,
      ),
      ["PROFILE_GAMES_DB", binding],
    );
    assert.throws(
      () => remoteMaintenanceConfiguration(binding as never, source.path),
      /invalid-binding/,
    );
    await assert.rejects(
      openRemoteMaintenanceTransport(binding as never, {
        configPath: source.path,
        apiToken: "not-a-real-token",
      }),
      /invalid-binding/,
    );
  }
  await assert.rejects(
    openRemoteD1Transport("UNKNOWN" as never, {
      configPath: source.path,
      apiToken: "not-a-real-token",
    }),
    /invalid-binding/,
  );
});

test("six-binding native reads use primary sessions and never create admission bookkeeping", async (t) => {
  const fixture = nativeFixture(t, "AUTH_STATE_DB"),
    session = await fixture.open();
  await session.transport.readRows("AUTH_STATE_DB", {
    sql: "SELECT 1 AS marker",
    bindings: [],
  });
  assert.ok(fixture.calls.includes("session:AUTH_STATE_DB:first-primary"));
  assert.equal(fixture.batches.length, 0);
  await assert.rejects(
    session.transport.readRows("AUTH_STATE_DB", {
      sql: "DELETE FROM application_data_admissions",
      bindings: [],
    }),
    /invalid-statements/,
  );
  await assert.rejects(
    session.transport.readRows("TELEGRAM_DB", {
      sql: "SELECT 1",
      bindings: [],
    }),
    /binding-outside-session/,
  );
  await session.dispose();
});
