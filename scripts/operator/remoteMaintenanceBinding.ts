import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  RemoteProxyConnectionString,
  V4MiniflareOptions,
} from "miniflare";
import {
  DEFAULT_API_CONFIG,
  readOperatorConfiguration,
  resolveD1Coordinates,
} from "./configuration.ts";
import type {
  MaintenanceBinding,
  MaintenanceResult,
  MaintenanceStatement,
  MaintenanceTransport,
} from "./guardedMaintenance.ts";
import { readResponseJson, resolveCloudflareToken } from "./runtime.ts";

const CONTROL_SQL =
  "SELECT singleton, generation, data_epoch, phase, migration_id FROM application_data_control WHERE singleton = 1";
const BINDINGS: readonly MaintenanceBinding[] = [
  "PROFILE_GAMES_DB",
  "PROFILE_DB",
  "EVENT_DB",
  "EVENT_PRIZE_WITHDRAWALS_DB",
];
const DEADLINE_MS = 60_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const PINNED_VERSIONS = {
  wrangler: "4.130.0",
  miniflare: "5.20260908.0-alpha",
} as const;

type Coordinates = ReturnType<typeof resolveD1Coordinates>;
export type RemoteMaintenanceConfiguration = {
  schemaVersion: 1;
  name: string;
  accountId: string;
  compatibilityDate: string;
  targetBinding: MaintenanceBinding;
  databases: Coordinates[];
  sourceConfigSha256: string;
  versions: typeof PINNED_VERSIONS;
};
type StartInput = {
  configuration: RemoteMaintenanceConfiguration;
  directory: string;
  apiToken: string;
};
type Prepared = {
  bind(...values: (string | number | null)[]): Prepared;
  all(): Promise<unknown>;
};
type NativeDatabase = {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<unknown>;
  withSession(constraint: "first-primary"): { prepare(sql: string): Prepared };
};
type RemoteSession = {
  remoteProxyConnectionString: RemoteProxyConnectionString;
  dispose(): Promise<void>;
};
type LocalRuntime = {
  getBindings(): Promise<Record<string, NativeDatabase>>;
  dispose(): Promise<void>;
};
export type NativeMaintenanceDependencies = {
  preflight(input: StartInput): Promise<void>;
  startSession(input: StartInput): Promise<RemoteSession>;
  createRuntime(
    input: StartInput,
    session: RemoteSession,
  ): Promise<LocalRuntime>;
};
type ParentDependencies = {
  spawn(directory: string): ChildProcess;
  stopGroup(child: ChildProcess): void;
};
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

const DIAGNOSTIC_STAGES = [
  "child-message",
  "child-start",
  "child-response",
  "preflight",
  "remote-session",
  "local-runtime",
  "binding-read",
  "binding-validation",
  "read-control",
  "atomic-batch",
  "dispose",
] as const;
type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number];
export type RemoteMaintenanceDiagnostic = {
  stage: DiagnosticStage;
  causeName: string | null;
  causeCode: string | null;
  providerCode: number | null;
  httpStatus: number | null;
  cleanupUnconfirmed: boolean;
};
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "MiniflareCoreError",
  "MiniflareError",
  "UserError",
  "APIError",
  "RemoteSessionAuthenticationError",
  "RemoteMaintenanceFailure",
]);
const SAFE_CAUSE_CODES = new Set([
  "ENOENT",
  "EACCES",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_INPUT_TYPE_NOT_ALLOWED",
  "ERR_RUNTIME_FAILURE",
  "ERR_VALIDATION",
  "ERR_DISPOSED",
  "ERR_WORKER_NAME",
  "ERR_PLUGIN",
  "ambiguous-coordinates",
  "binding-coverage-mismatch",
  "binding-outside-session",
  "child-cleanup-unconfirmed",
  "child-start-failed",
  "credential-unavailable",
  "disposal-unconfirmed",
  "existing-subdomain-required",
  "invalid-binding",
  "invalid-child-mode",
  "invalid-command",
  "invalid-compatibility-date",
  "invalid-message",
  "invalid-preflight-credentials",
  "invalid-start",
  "invalid-statements",
  "native-binding-unavailable",
  "operation-unconfirmed",
  "package-version-mismatch",
  "session-closed",
  "session-not-started",
  "startup-unconfirmed",
  "unconfirmed-result",
  "invalid-child-response",
  "child-failed",
  "child-exited",
  "child-send-failed",
]);

export class RemoteMaintenanceFailure extends Error {
  readonly code: string;
  readonly diagnostic: RemoteMaintenanceDiagnostic | null;
  constructor(
    code: string,
    diagnostic: RemoteMaintenanceDiagnostic | null = null,
  ) {
    super(`operator-remote-${code}`);
    this.name = "RemoteMaintenanceFailure";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}
function failure(
  code: string,
  diagnostic: RemoteMaintenanceDiagnostic | null = null,
): RemoteMaintenanceFailure {
  return new RemoteMaintenanceFailure(code, diagnostic);
}

export function remoteMaintenanceDiagnostic(
  stage: DiagnosticStage,
  error: unknown,
  cleanupUnconfirmed = false,
): RemoteMaintenanceDiagnostic {
  if (error instanceof RemoteMaintenanceFailure && error.diagnostic)
    return {
      ...error.diagnostic,
      cleanupUnconfirmed:
        cleanupUnconfirmed || error.diagnostic.cleanupUnconfirmed,
    };
  const result: RemoteMaintenanceDiagnostic = {
    stage,
    causeName: null,
    causeCode: null,
    providerCode: null,
    httpStatus: null,
    cleanupUnconfirmed,
  };
  let current = error;
  for (
    let depth = 0;
    depth < 6 && current !== null && typeof current === "object";
    depth++
  ) {
    const row = current as Record<string, unknown>;
    if (
      result.causeName === null &&
      typeof row.name === "string" &&
      SAFE_ERROR_NAMES.has(row.name)
    )
      result.causeName = row.name;
    if (
      result.causeCode === null &&
      typeof row.code === "string" &&
      SAFE_CAUSE_CODES.has(row.code)
    )
      result.causeCode = row.code;
    if (
      result.providerCode === null &&
      Number.isSafeInteger(row.code) &&
      Number(row.code) > 0 &&
      Number(row.code) < 1_000_000_000
    )
      result.providerCode = Number(row.code);
    const status = row.status ?? row.statusCode;
    if (
      result.httpStatus === null &&
      Number.isInteger(status) &&
      Number(status) >= 400 &&
      Number(status) <= 599
    )
      result.httpStatus = Number(status);
    current = row.cause;
  }
  return result;
}

function parseDiagnostic(value: unknown): RemoteMaintenanceDiagnostic | null {
  if (value === undefined) return null;
  const row = requireRecord(value);
  if (
    Object.keys(row).length !== 6 ||
    !DIAGNOSTIC_STAGES.includes(row.stage as DiagnosticStage) ||
    !(
      row.causeName === null ||
      (typeof row.causeName === "string" && SAFE_ERROR_NAMES.has(row.causeName))
    ) ||
    !(
      row.causeCode === null ||
      (typeof row.causeCode === "string" && SAFE_CAUSE_CODES.has(row.causeCode))
    ) ||
    !(
      row.providerCode === null ||
      (Number.isSafeInteger(row.providerCode) &&
        Number(row.providerCode) > 0 &&
        Number(row.providerCode) < 1_000_000_000)
    ) ||
    !(
      row.httpStatus === null ||
      (Number.isInteger(row.httpStatus) &&
        Number(row.httpStatus) >= 400 &&
        Number(row.httpStatus) <= 599)
    ) ||
    typeof row.cleanupUnconfirmed !== "boolean"
  )
    throw failure("invalid-child-response");
  return row as RemoteMaintenanceDiagnostic;
}
function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw failure("invalid-message");
  return value as Record<string, unknown>;
}
function requireBinding(value: unknown): asserts value is MaintenanceBinding {
  if (!BINDINGS.includes(value as MaintenanceBinding))
    throw failure("invalid-binding");
}
function requireStatements(
  value: unknown,
): asserts value is MaintenanceStatement[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_MESSAGE_BYTES
  )
    throw failure("invalid-statements");
  for (const entry of value) {
    const row = requireRecord(entry);
    if (
      typeof row.sql !== "string" ||
      row.sql.length === 0 ||
      Buffer.byteLength(row.sql) > 90 * 1024 ||
      !Array.isArray(row.bindings) ||
      row.bindings.length > 100 ||
      row.bindings.some(
        (item) =>
          item !== null &&
          typeof item !== "string" &&
          !(typeof item === "number" && Number.isFinite(item)),
      )
    )
      throw failure("invalid-statements");
  }
}
function results(value: unknown, expected: number): MaintenanceResult[] {
  if (!Array.isArray(value) || value.length !== expected)
    throw failure("unconfirmed-result");
  return value.map((entry) => {
    const row = requireRecord(entry),
      meta = requireRecord(row.meta);
    if (
      row.success !== true ||
      !Array.isArray(row.results) ||
      !Number.isSafeInteger(meta.changes) ||
      Number(meta.changes) < 0
    )
      throw failure("unconfirmed-result");
    return {
      success: true,
      results: row.results.map(requireRecord),
      meta: { ...meta, changes: Number(meta.changes) },
    };
  });
}

export function remoteMaintenanceConfiguration(
  targetBinding: MaintenanceBinding,
  configPath = DEFAULT_API_CONFIG,
): RemoteMaintenanceConfiguration {
  requireBinding(targetBinding);
  const before = readFileSync(configPath),
    source = readOperatorConfiguration(configPath);
  const databases = [
    ...new Set<MaintenanceBinding>(["PROFILE_GAMES_DB", targetBinding]),
  ].map((binding) => resolveD1Coordinates(binding, configPath));
  if (
    !before.equals(readFileSync(configPath)) ||
    databases.some((row) => row.accountId !== databases[0]!.accountId) ||
    new Set(databases.map((row) => row.databaseId)).size !== databases.length
  )
    throw failure("ambiguous-coordinates");
  const compatibilityDate = source.compatibility_date;
  if (
    typeof compatibilityDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)
  )
    throw failure("invalid-compatibility-date");
  return {
    schemaVersion: 1,
    name: `mons-maint-${randomUUID()}`,
    accountId: databases[0]!.accountId,
    compatibilityDate,
    targetBinding,
    databases,
    sourceConfigSha256: createHash("sha256").update(before).digest("hex"),
    versions: PINNED_VERSIONS,
  };
}

export function remoteMaintenanceChildEnvironment(
  directory: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
  ])
    if (source[key] !== undefined) env[key] = source[key];
  return {
    ...env,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    CI: "1",
    WRANGLER_LOG: "none",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"),
    WRANGLER_REGISTRY_PATH: resolve(directory, "registry"),
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  };
}

export async function requireExistingWorkersSubdomain(
  accountId: string,
  apiToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    !apiToken ||
    /[\r\n]/.test(apiToken)
  )
    throw failure("invalid-preflight-credentials");
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(DEADLINE_MS),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Cache-Control": "no-cache",
      },
    },
  );
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw failure(
      "existing-subdomain-required",
      remoteMaintenanceDiagnostic("preflight", {
        name: "RemoteMaintenanceFailure",
        code: "existing-subdomain-required",
        status: response.status,
      }),
    );
  }
  const envelope = requireRecord(await readResponseJson(response)),
    result = requireRecord(envelope.result);
  if (
    envelope.success !== true ||
    typeof result.subdomain !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(result.subdomain)
  )
    throw failure("existing-subdomain-required");
}

function requirePinnedPackages(): void {
  const require = createRequire(import.meta.url);
  for (const [name, version] of Object.entries(PINNED_VERSIONS))
    if (require(`${name}/package.json`).version !== version)
      throw failure("package-version-mismatch");
}
export function remoteMaintenanceRuntimeOptions(
  input: Pick<StartInput, "configuration" | "directory">,
  connection: RemoteProxyConnectionString,
): V4MiniflareOptions {
  return {
    name: input.configuration.name,
    script: "",
    modules: true,
    compatibilityDate: input.configuration.compatibilityDate,
    host: "127.0.0.1",
    port: 0,
    cf: false,
    cacheAPI: false,
    resourceTmpPath: resolve(input.directory, "runtime-tmp"),
    unsafeRegisterWorker: false,
    unsafeDevRegistryPath: resolve(input.directory, "registry"),
    d1Databases: Object.fromEntries(
      input.configuration.databases.map((row) => [
        row.binding,
        { id: row.databaseId, remoteProxyConnectionString: connection },
      ]),
    ),
  };
}

const nativeDependencies: NativeMaintenanceDependencies = {
  async preflight(input) {
    requirePinnedPackages();
    await requireExistingWorkersSubdomain(
      input.configuration.accountId,
      input.apiToken,
    );
  },
  async startSession(input) {
    const { startRemoteProxySession } = await import("wrangler");
    const bindings = Object.fromEntries(
      input.configuration.databases.map((row) => [
        row.binding,
        { type: "d1" as const, database_id: row.databaseId, remote: true },
      ]),
    );
    return (await startRemoteProxySession(bindings, {
      workerName: input.configuration.name,
      auth: {
        accountId: input.configuration.accountId,
        apiToken: { apiToken: input.apiToken },
      },
    })) as RemoteSession;
  },
  async createRuntime(input, session) {
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
      await import("miniflare");
    return new Miniflare(
      convertV4MiniflareOptions({
        ...remoteMaintenanceRuntimeOptions(
          input,
          session.remoteProxyConnectionString,
        ),
        log: new Log(LogLevel.NONE),
      }),
    ) as LocalRuntime;
  },
};

export async function openNativeMaintenanceBindings(
  input: StartInput,
  dependencies: NativeMaintenanceDependencies = nativeDependencies,
): Promise<{ transport: MaintenanceTransport; dispose(): Promise<void> }> {
  let remote: RemoteSession | undefined,
    local: LocalRuntime | undefined,
    closed = false,
    disposal: Promise<void> | undefined;
  let stage: DiagnosticStage = "preflight";
  const dispose = () =>
    (disposal ??= (async () => {
      closed = true;
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => local?.dispose()),
        Promise.resolve().then(() => remote?.dispose()),
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected"))
        throw failure("disposal-unconfirmed");
    })());
  try {
    await dependencies.preflight(input);
    stage = "remote-session";
    remote = await dependencies.startSession(input);
    stage = "local-runtime";
    local = await dependencies.createRuntime(input, remote);
    stage = "binding-read";
    const env = await local.getBindings();
    stage = "binding-validation";
    const expected = input.configuration.databases
      .map((row) => row.binding)
      .sort();
    if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify(expected))
      throw failure("binding-coverage-mismatch");
    const database = (binding: MaintenanceBinding) => {
      if (closed) throw failure("session-closed");
      if (!expected.includes(binding)) throw failure("binding-outside-session");
      const value = env[binding];
      if (
        !value ||
        typeof value.prepare !== "function" ||
        typeof value.batch !== "function" ||
        typeof value.withSession !== "function"
      )
        throw failure("native-binding-unavailable");
      return value;
    };
    for (const binding of expected) database(binding as MaintenanceBinding);
    return {
      dispose,
      transport: {
        async readControl() {
          const result = await database("PROFILE_GAMES_DB")
            .withSession("first-primary")
            .prepare(CONTROL_SQL)
            .all();
          return results([result], 1)[0]!.results;
        },
        async atomicBatch(binding, statements) {
          requireBinding(binding);
          requireStatements(statements);
          const db = database(binding);
          return results(
            await db.batch(
              statements.map((statement) =>
                db.prepare(statement.sql).bind(...statement.bindings),
              ),
            ),
            statements.length,
          );
        },
      },
    };
  } catch (error) {
    let cleanupUnconfirmed = false;
    try {
      await dispose();
    } catch {
      cleanupUnconfirmed = true;
    }
    throw failure(
      "startup-unconfirmed",
      remoteMaintenanceDiagnostic(stage, error, cleanupUnconfirmed),
    );
  }
}

const parentDependencies: ParentDependencies = {
  spawn(directory) {
    return fork(
      fileURLToPath(import.meta.url),
      ["--remote-maintenance-child"],
      {
        cwd: directory,
        env: remoteMaintenanceChildEnvironment(directory) as NodeJS.ProcessEnv,
        detached: true,
        execArgv: [
          "--experimental-strip-types",
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        ],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
  },
  stopGroup(child) {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        throw failure("child-cleanup-unconfirmed");
    }
  },
};

export async function openRemoteMaintenanceTransport(
  targetBinding: MaintenanceBinding,
  options: { configPath?: string; apiToken?: string } = {},
  dependencies: ParentDependencies = parentDependencies,
): Promise<{
  transport: MaintenanceTransport;
  dispose(): Promise<void>;
  configuration: RemoteMaintenanceConfiguration;
}> {
  const configuration = remoteMaintenanceConfiguration(
    targetBinding,
    options.configPath,
  );
  const apiToken = options.apiToken ?? resolveCloudflareToken();
  if (
    typeof apiToken !== "string" ||
    apiToken.length === 0 ||
    /[\r\n]/.test(apiToken)
  )
    throw failure("credential-unavailable");
  const directory = realpathSync(
    mkdtempSync(resolve(tmpdir(), "mons-maintenance-")),
  );
  mkdirSync(resolve(directory, "registry"), { mode: 0o700 });
  writeFileSync(
    resolve(directory, "wrangler.json"),
    JSON.stringify({
      name: configuration.name,
      account_id: configuration.accountId,
      compatibility_date: configuration.compatibilityDate,
      d1_databases: configuration.databases.map((row) => ({
        binding: row.binding,
        database_id: row.databaseId,
        database_name: row.databaseName,
        remote: true,
      })),
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  let child: ChildProcess;
  try {
    child = dependencies.spawn(directory);
  } catch {
    rmSync(directory, { recursive: true, force: true });
    throw failure("child-start-failed");
  }
  const pending = new Map<number, Pending>();
  let sequence = 0,
    closed = false,
    disposal: Promise<void> | undefined,
    queue: Promise<unknown> = Promise.resolve();
  let termination: Promise<void> | undefined;
  const stop = (code: string): Promise<void> => {
    if (termination) return termination;
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure(code));
    }
    pending.clear();
    termination = (async () => {
      const exited =
        !child.pid || child.exitCode !== null || child.signalCode !== null;
      const exit = exited
        ? Promise.resolve()
        : new Promise<void>((resolveExit, rejectExit) => {
            const timer = setTimeout(
              () => rejectExit(failure("child-cleanup-unconfirmed")),
              5_000,
            );
            child.once("exit", () => {
              clearTimeout(timer);
              resolveExit();
            });
          });
      try {
        dependencies.stopGroup(child);
        if (child.connected) child.disconnect();
        await exit;
        rmSync(directory, { recursive: true, force: true });
      } catch {
        await exit.catch(() => undefined);
        throw failure("child-cleanup-unconfirmed");
      }
    })();
    void termination.catch(() => undefined);
    return termination;
  };
  child.on("message", (value: unknown) => {
    let message: Record<string, unknown>;
    try {
      message = requireRecord(value);
    } catch {
      void stop("invalid-child-response");
      return;
    }
    const request = pending.get(Number(message.id));
    if (
      !request ||
      !Number.isSafeInteger(message.id) ||
      typeof message.ok !== "boolean"
    ) {
      void stop("invalid-child-response");
      return;
    }
    pending.delete(Number(message.id));
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.value);
    else {
      try {
        request.reject(
          failure("operation-unconfirmed", parseDiagnostic(message.diagnostic)),
        );
      } catch {
        request.reject(failure("invalid-child-response"));
        void stop("invalid-child-response");
      }
    }
  });
  child.on("error", () => {
    if (!closed) void stop("child-failed");
  });
  child.on("exit", () => {
    if (!closed) void stop("child-exited");
  });
  const request = (kind: string, payload: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(failure("session-closed"));
    const id = ++sequence;
    return new Promise((resolveValue, reject) => {
      const timer = setTimeout(() => {
        void stop("operation-unconfirmed");
      }, DEADLINE_MS);
      pending.set(id, { resolve: resolveValue, reject, timer });
      try {
        child.send({ id, kind, payload }, (error) => {
          if (error && pending.has(id)) void stop("child-send-failed");
        });
      } catch {
        void stop("child-send-failed");
      }
    });
  };
  const enqueue = (kind: string, payload: unknown) => {
    const operation = queue.then(() => request(kind, payload));
    queue = operation.catch(() => undefined);
    return operation;
  };
  const dispose = () =>
    (disposal ??= (async () => {
      try {
        if (!closed) await enqueue("dispose", null);
      } finally {
        await stop("session-closed");
      }
    })());
  try {
    await enqueue("start", { configuration, directory, apiToken });
    return {
      configuration,
      dispose,
      transport: {
        async readControl() {
          const value = await enqueue("readControl", null);
          if (!Array.isArray(value)) throw failure("unconfirmed-result");
          return value.map(requireRecord);
        },
        async atomicBatch(binding, statements) {
          requireBinding(binding);
          requireStatements(statements);
          if (!configuration.databases.some((row) => row.binding === binding))
            throw failure("binding-outside-session");
          return results(
            await enqueue("atomicBatch", { binding, statements }),
            statements.length,
          );
        },
      },
    };
  } catch (error) {
    let cleanupUnconfirmed = false;
    try {
      await stop("startup-unconfirmed");
    } catch {
      cleanupUnconfirmed = true;
    }
    throw failure(
      "startup-unconfirmed",
      remoteMaintenanceDiagnostic("child-response", error, cleanupUnconfirmed),
    );
  }
}

async function childMain(): Promise<void> {
  process.umask(0o077);
  let session:
    Awaited<ReturnType<typeof openNativeMaintenanceBindings>> | undefined;
  let queue: Promise<void> = Promise.resolve();
  process.on("disconnect", () => {
    const terminate = () => {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        process.exit(1);
      }
    };
    const deadline = setTimeout(terminate, 5_000);
    void queue.finally(async () => {
      try {
        await session?.dispose();
      } finally {
        clearTimeout(deadline);
        terminate();
      }
    });
  });
  process.on("message", (message: unknown) => {
    queue = queue.then(async () => {
      let id: unknown;
      let stage: DiagnosticStage = "child-message";
      try {
        const row = requireRecord(message);
        id = row.id;
        if (!Number.isSafeInteger(id) || typeof row.kind !== "string")
          throw failure("invalid-message");
        let value: unknown = null;
        if (row.kind === "start" && !session) {
          stage = "child-start";
          const input = row.payload as StartInput;
          if (
            input.directory !== process.cwd() ||
            input.configuration?.schemaVersion !== 1 ||
            typeof input.apiToken !== "string"
          )
            throw failure("invalid-start");
          session = await openNativeMaintenanceBindings(input);
        } else if (!session) throw failure("session-not-started");
        else if (row.kind === "readControl") {
          stage = "read-control";
          value = await session.transport.readControl();
        } else if (row.kind === "atomicBatch") {
          stage = "atomic-batch";
          const payload = requireRecord(row.payload);
          requireBinding(payload.binding);
          requireStatements(payload.statements);
          value = await session.transport.atomicBatch(
            payload.binding,
            payload.statements,
          );
        } else if (row.kind === "dispose") {
          stage = "dispose";
          await session.dispose();
        } else throw failure("invalid-command");
        if (process.connected) process.send?.({ id, ok: true, value });
      } catch (error) {
        if (process.connected)
          process.send?.({
            id,
            ok: false,
            diagnostic: remoteMaintenanceDiagnostic(stage, error),
          });
      }
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== "--remote-maintenance-child" ||
    !process.send
  )
    throw failure("invalid-child-mode");
  await childMain();
}
