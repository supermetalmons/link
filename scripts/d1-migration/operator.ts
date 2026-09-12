import { randomUUID, createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  existsSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  D1_BINDINGS,
  DEFAULT_API_CONFIG,
  readOperatorConfiguration,
  resolveD1Coordinates,
  type D1Binding,
} from "../operator/configuration.ts";
import {
  canonicalJson,
  readPrivateJson,
  writePrivateImmutable,
  privateDirectory,
} from "../operator/runtime.ts";
import {
  createCloudflareProvider,
  apiRecord,
  type CloudflareProvider,
  type ApiRecord,
  type QueryParameter,
} from "./provider.ts";
import {
  captureSchema,
  cloneDatabase,
  verifyDatabase,
  resetCloneTarget,
} from "./clone.ts";
import { runCloneRehearsal } from "./rehearsal.ts";
import { retryRead, concurrentSettled } from "./retry.ts";
import { runWorkerRehearsal } from "./worker-rehearsal.ts";
import { freezeDomainControls, resumeDomainControls } from "./controls.ts";
import {
  runMigrationReadSmokes,
  captureEventBookmarkProbe,
  type EventBookmarkProbe,
} from "./smokes.ts";
import {
  publishCloudflareWorkflows,
  parseWorkflowPublicationConfiguration,
} from "../publish-cloudflare-workflows.ts";
import {
  captureWorkflowHandoff,
  pauseWorkflowHandoff,
  executeWorkflowHandoff,
  verifyWorkflowHandoff,
  getPublishedWorkflowVersion,
  assertRecreatedEventSleep,
  type CloudflareRequest,
} from "./workflows.ts";
import {
  artifact,
  saveManifest,
  loadManifest,
  openMigrationDirectory,
  PHASES,
  type MigrationManifest,
  type MigrationPhase,
  type DatabaseMigration,
} from "./state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASE_ENV = resolve(ROOT, "cloud/workers/api/release.env");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export type MigrationArguments = {
  phase: MigrationPhase;
  directory: string;
  config: string;
  bridgeSecretFile?: string;
};

export function parseMigrationArguments(argv: string[]): MigrationArguments {
  const phase = argv[0] as MigrationPhase;
  if (!PHASES.includes(phase))
    throw new Error(`choose a migration phase: ${PHASES.join(", ")}`);
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i],
      value = argv[i + 1];
    if (
      !["--directory", "--config", "--bridge-secret-file"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    )
      throw new Error("invalid or duplicate migration argument");
    values.set(key, value);
  }
  const directory = values.get("--directory");
  if (!directory || !isAbsolute(directory))
    throw new Error(
      "--directory requires a protected absolute path outside the repository",
    );
  return {
    phase,
    directory,
    config: resolve(values.get("--config") || DEFAULT_API_CONFIG),
    bridgeSecretFile: values.get("--bridge-secret-file"),
  };
}

export function assertMigrationDirection(
  manifest: MigrationManifest,
  phase: MigrationPhase,
): void {
  const cutoverStarted =
    !!manifest.records.cutoverStartedAt ||
    !!manifest.phases.cutover ||
    !!manifest.records.resumeStartedAt ||
    !!manifest.phases.resume;
  const quiesceStarted =
    !!manifest.records.quiesceStartedAt ||
    !!manifest.phases.quiesce ||
    cutoverStarted;
  if (phase === "prepare" && quiesceStarted)
    throw new Error(
      "preparation cannot reset candidates after maintenance has started",
    );
  if (["quiesce", "copy", "verify"].includes(phase) && cutoverStarted)
    throw new Error(
      "migration has entered cutover; source phases cannot run again",
    );
  if (
    phase === "cutover" &&
    (manifest.records.resumeStartedAt || manifest.phases.resume)
  )
    throw new Error("resume has started; do not replay cutover");
}

function field(record: ApiRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value)
    throw new Error(`missing ${key} in provider metadata`);
  return value;
}

function array(value: unknown): ApiRecord[] {
  if (!Array.isArray(value)) throw new Error("invalid provider array");
  return value.map(apiRecord);
}

function queryParameters(params: unknown[] = []): QueryParameter[] {
  return params.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isSafeInteger(value))
    )
      return value;
    throw new Error("invalid typed query parameter");
  });
}

function workflowRequest(provider: CloudflareProvider): CloudflareRequest {
  return (path, method, body) =>
    provider.request(path.replace(/^\//, ""), method, body);
}

function database(
  manifest: MigrationManifest,
  binding: D1Binding,
): DatabaseMigration {
  const result = manifest.databases.find((db) => db.binding === binding);
  if (!result) throw new Error("binding is absent from migration manifest");
  return result;
}

async function deployedVersion(
  provider: CloudflareProvider,
  worker: string,
): Promise<string> {
  const response = apiRecord(
    await provider.request(`workers/scripts/${worker}/deployments`),
  );
  const deployment = array(response.deployments)[0];
  const versions = array(deployment.versions);
  if (versions.length !== 1 || versions[0].percentage !== 100)
    throw new Error("migration requires a single API version at 100 percent");
  return field(versions[0], "version_id");
}

async function captureControls(
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  const controls: MigrationManifest["controls"] = {};
  for (const [binding, tables] of [
    [
      "PROFILE_DB",
      ["profile_canonical_control", "wager_reservation_runtime_control"],
    ],
    [
      "PROFILE_GAMES_DB",
      [
        "automatch_runtime_control",
        "invite_source_control",
        "match_state_control",
      ],
    ],
    ["EVENT_DB", ["event_runtime_control"]],
    ["TELEGRAM_DB", ["telegram_runtime_control"]],
    ["EVENT_PRIZE_WITHDRAWALS_DB", ["event_prize_withdrawal_runtime_control"]],
  ] as const) {
    for (const table of tables)
      controls[`${binding}.${table}`] = await provider.query(
        database(manifest, binding).sourceId,
        `SELECT * FROM "${table}"`,
      );
  }
  return controls;
}

export async function preflightMigration(
  args: MigrationArguments,
  provider: CloudflareProvider,
): Promise<MigrationManifest> {
  if (loadManifest(args.directory))
    throw new Error("migration already initialized; use its saved manifest");
  const configuration = readOperatorConfiguration(args.config);
  const workerName = field(configuration, "name");
  if (workerName !== "mons-link-api")
    throw new Error("only the canonical API Worker can be migrated");
  const originalVersionId = await deployedVersion(provider, workerName);
  const namespaces = array(
    await provider.request("workers/durable_objects/namespaces"),
  );
  const owned = namespaces.filter(
    (item) => item.script === workerName && item.class === "InviteReactions",
  );
  if (owned.length !== 1)
    throw new Error("canonical Durable Object namespace is ambiguous");
  const queues = await provider.list("queues");
  const names = array(apiRecord(configuration.queues).producers).map(
    (item) => item.queue,
  );
  const manifest: MigrationManifest = {
    schemaVersion: 1,
    revision: 0,
    previousDigest: null,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    accountId: field(configuration, "account_id"),
    workerName,
    originalVersionId,
    namespaceId: field(owned[0], "id"),
    configuration,
    databases: [],
    queues: queues.filter((item) => names.includes(item.queue_name)),
    controls: {},
    phases: {},
    versions: {},
    records: {},
  };
  if (manifest.queues.length !== 5)
    throw new Error("expected all five owned Queue consumers");
  const allDatabases = await provider.list("d1/database");
  for (const name of Object.keys(D1_BINDINGS)) {
    const coordinates = resolveD1Coordinates(name, args.config);
    const info = apiRecord(
      await provider.request(`d1/database/${coordinates.databaseId}`),
    );
    if (
      info.uuid !== coordinates.databaseId ||
      info.name !== coordinates.databaseName
    )
      throw new Error("tracked source identity differs from provider metadata");
    const destinationName = `${coordinates.databaseName}-enam`;
    if (allDatabases.some((item) => item.name === destinationName))
      throw new Error(`destination name already exists: ${destinationName}`);
    const schema = await captureSchema((sql, params) =>
      provider.query(coordinates.databaseId, sql, params),
    );
    manifest.databases.push({
      binding: coordinates.binding,
      sourceId: coordinates.databaseId,
      sourceName: coordinates.databaseName,
      sourceRegion: String(info.running_in_region || "unknown"),
      destinationName,
      schema,
    });
  }
  manifest.controls = await captureControls(provider, manifest);
  manifest.workflows = await captureWorkflowHandoff({
    request: workflowRequest(provider),
    query: (id, sql, params) =>
      provider.query(id, sql, queryParameters(params)),
    eventDatabaseId: database(manifest, "EVENT_DB").sourceId,
    withdrawalDatabaseId: database(manifest, "EVENT_PRIZE_WITHDRAWALS_DB")
      .sourceId,
  });
  manifest.phases.preflight = new Date().toISOString();
  saveManifest(args.directory, manifest);
  return manifest;
}

function candidateConfiguration(
  manifest: MigrationManifest,
  variant: keyof MigrationManifest["versions"],
) {
  const config = structuredClone(manifest.configuration);
  const directory = dirname(DEFAULT_API_CONFIG);
  config.main = resolve(directory, String(config.main));
  config.$schema = resolve(ROOT, "node_modules/wrangler/config-schema.json");
  config.vars = {
    ...apiRecord(config.vars),
    API_MAINTENANCE: variant === "destination-live" ? "false" : "true",
    D1_MIGRATION_RUN_ID: variant === "destination-live" ? "" : manifest.runId,
    EVENT_DB_BOOKMARK_EPOCH:
      variant === "source-maintenance"
        ? database(manifest, "EVENT_DB").sourceId
        : database(manifest, "EVENT_DB").destinationId,
  };
  config.d1_databases = array(config.d1_databases).map((entry) => {
    const db = database(manifest, entry.binding as D1Binding);
    if (variant !== "source-maintenance" && !db.destinationId)
      throw new Error("destination database has not been created");
    return {
      ...entry,
      database_id:
        variant === "source-maintenance" ? db.sourceId : db.destinationId,
      database_name:
        variant === "source-maintenance" ? db.sourceName : db.destinationName,
      migrations_dir: resolve(directory, String(entry.migrations_dir)),
    };
  });
  return config;
}

function candidatePath(
  args: MigrationArguments,
  variant: keyof MigrationManifest["versions"],
) {
  const manifest = loadManifest(args.directory);
  if (!manifest)
    throw new Error("candidate configuration requires a saved manifest");
  const digest = createHash("sha256")
    .update(canonicalJson(candidateConfiguration(manifest, variant)))
    .digest("hex")
    .slice(0, 16);
  return resolve(args.directory, `${variant}-${digest}.json`);
}

async function command(
  args: MigrationArguments,
  label: string,
  executable: string,
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const path = resolve(
    args.directory,
    `${label}-${Date.now()}-${randomUUID().slice(0, 8)}.log`,
  );
  const descriptor = openSync(path, "wx", 0o600);
  console.log(JSON.stringify({ event: "migration_command", label, log: path }));
  try {
    await new Promise<void>((resolveCommand, reject) => {
      const child = spawn(executable, argv, {
        cwd: ROOT,
        shell: false,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: resolve(args.directory, "wrangler.log"),
          ...env,
        },
        stdio: ["ignore", descriptor, descriptor],
      });
      child.on("error", reject);
      child.on("exit", (code, signal) =>
        code === 0
          ? resolveCommand()
          : reject(
              new Error(`${label} failed (${signal || code}); inspect ${path}`),
            ),
      );
    });
  } finally {
    closeSync(descriptor);
  }
  return readFileSync(path, "utf8");
}

async function createDestinations(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  for (const db of manifest.databases) {
    if (db.destinationId) {
      const info = apiRecord(
        await provider.request(`d1/database/${db.destinationId}`),
      );
      if (info.name !== db.destinationName || info.running_in_region !== "ENAM")
        throw new Error("saved destination identity or region changed");
      continue;
    }
    if (
      (await provider.list("d1/database")).some(
        (item) => item.name === db.destinationName,
      )
    )
      throw new Error(
        `unrecorded destination exists; inspect creation evidence for ${db.destinationName}`,
      );
    db.creationStartedAt = new Date().toISOString();
    saveManifest(args.directory, manifest);
    const created = apiRecord(
      await provider.request("d1/database", "POST", {
        name: db.destinationName,
        primary_location_hint: "enam",
      }),
    );
    const id = field(created, "uuid");
    if (!UUID.test(id)) throw new Error("invalid created destination UUID");
    db.destinationId = id;
    saveManifest(args.directory, manifest);
    const info = apiRecord(await provider.request(`d1/database/${id}`));
    if (info.name !== db.destinationName || info.running_in_region !== "ENAM")
      throw new Error(
        `destination did not land in ENAM: ${db.destinationName}`,
      );
    console.log(
      JSON.stringify({
        event: "migration_destination_ready",
        binding: db.binding,
        id,
        region: info.running_in_region,
      }),
    );
  }
  for (const variant of [
    "source-maintenance",
    "destination-maintenance",
    "destination-live",
  ] as const)
    writePrivateImmutable(
      candidatePath(args, variant),
      candidateConfiguration(manifest, variant),
    );
}

function requirePhase(manifest: MigrationManifest, phase: MigrationPhase) {
  if (!manifest.phases[phase])
    throw new Error(`complete ${phase} before continuing`);
}

function recordEvidence(
  args: MigrationArguments,
  manifest: MigrationManifest,
  name: string,
  value: unknown,
): string {
  const filename = `${name}-${randomUUID()}.json`;
  artifact(args.directory, filename, value);
  manifest.records[`${name}Artifact`] = filename;
  saveManifest(args.directory, manifest);
  return filename;
}

export function sourceFingerprint(): string {
  const files: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(resolve(ROOT, directory), {
      withFileTypes: true,
    })) {
      if (["node_modules", ".cache"].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else if (/\.(?:ts|js|json|mjs)$/.test(entry.name)) files.push(path);
    }
  };
  for (const directory of [
    "cloud/workers/api/src",
    "cloud/workers/api/runtime",
    "cloud/workers/api/test",
    "cloud/runtime",
    "cloud/admin",
    "scripts",
  ])
    collect(directory);
  files.push("package.json", "package-lock.json", "eslint.config.mjs");
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    let content = readFileSync(resolve(ROOT, path));
    if (path === "scripts/projectContracts.test.ts")
      content = Buffer.from(
        content
          .toString("utf8")
          .replace(
            /database_id:\s*"[a-f0-9-]{36}"/g,
            'database_id: "<database-id>"',
          )
          .replace(
            /database_name:\s*"mons-link-[a-z-]+"/g,
            'database_name: "<database-name>"',
          ),
      );
    hash.update(path).update("\0").update(content).update("\0");
  }
  const config = readOperatorConfiguration(DEFAULT_API_CONFIG);
  config.vars = {
    ...apiRecord(config.vars),
    API_MAINTENANCE: "",
    D1_MIGRATION_RUN_ID: "",
    EVENT_DB_BOOKMARK_EPOCH: "",
  };
  config.d1_databases = array(config.d1_databases).map(
    ({ database_id: _id, database_name: _name, ...entry }) => entry,
  );
  hash.update(canonicalJson(config));
  return hash.digest("hex");
}

function requireValidation(manifest: MigrationManifest): string {
  const fingerprint = sourceFingerprint();
  const validation = manifest.records.validation;
  if (!validation || apiRecord(validation).fingerprint !== fingerprint)
    throw new Error(
      "source changed or full validation is missing; complete prepare before maintenance",
    );
  return fingerprint;
}

function bridgeSecret(args: MigrationArguments): string {
  if (!args.bridgeSecretFile)
    throw new Error(
      "--bridge-secret-file is required for production maintenance",
    );
  const stat = lstatSync(args.bridgeSecretFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 4096
  )
    throw new Error(
      "migration bridge secret requires a private, owned regular file",
    );
  const secret = readFileSync(args.bridgeSecretFile, "utf8").trim();
  if (!secret) throw new Error("migration bridge secret is empty");
  return secret;
}

async function maintenanceRequest(
  args: MigrationArguments,
  manifest: MigrationManifest,
  versionId: string,
  input: ApiRecord,
): Promise<ApiRecord> {
  const body = JSON.stringify({
    schemaVersion: 1,
    kind: "d1-migration",
    runId: manifest.runId,
    expectedVersionId: versionId,
    ...input,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", bridgeSecret(args))
    .update(`${timestamp}.${body}`)
    .digest("base64url");
  const response = await fetch("https://api.mons.link/internal/d1-migration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mons-Telegram-Timestamp": timestamp,
      "X-Mons-Telegram-Signature": signature,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  let value: ApiRecord;
  try {
    value = apiRecord(await response.json());
  } catch {
    throw Object.assign(
      new Error(`maintenance response was not valid JSON (${response.status})`),
      { httpStatus: response.status },
    );
  }
  if (
    !response.ok ||
    value.ok !== true ||
    value.versionId !== versionId ||
    value.runId !== manifest.runId
  )
    throw Object.assign(
      new Error(
        `maintenance ${String(input.operation)} was not confirmed (${response.status}; ${String(value.message || value.error || "identity mismatch")})`,
      ),
      { httpStatus: response.status },
    );
  return value;
}

async function maintenanceCommand(
  args: MigrationArguments,
  manifest: MigrationManifest,
  versionId: string,
  input: ApiRecord,
): Promise<ApiRecord> {
  const read = () => maintenanceRequest(args, manifest, versionId, input);
  if (input.operation !== "barrier") return read();
  return retryRead(read, {
    shouldRetry: (error) => {
      if (!(error instanceof Error)) return false;
      const status = (error as Error & { httpStatus?: number }).httpStatus;
      return (
        (typeof status === "number" && status >= 500) ||
        ["TypeError", "TimeoutError", "AbortError"].includes(error.name)
      );
    },
    onRetry: ({ attempt, delayMs }) =>
      console.log(
        JSON.stringify({ event: "migration_barrier_retry", attempt, delayMs }),
      ),
  });
}

async function assertVersionBindings(
  provider: CloudflareProvider,
  manifest: MigrationManifest,
  variant: keyof MigrationManifest["versions"],
  id: string,
) {
  const version = apiRecord(
    await provider.request(
      `workers/scripts/${manifest.workerName}/versions/${id}`,
    ),
  );
  const bindings = array(apiRecord(version.resources).bindings);
  if (bindings.filter((item) => item.type === "d1").length !== 6)
    throw new Error("candidate must bind exactly six databases");
  for (const db of manifest.databases) {
    const bound = bindings.filter(
      (item) => item.name === db.binding && item.type === "d1",
    );
    if (
      bound.length !== 1 ||
      bound[0].id !==
        (variant === "source-maintenance" ? db.sourceId : db.destinationId)
    )
      throw new Error(`candidate binding differs from manifest: ${db.binding}`);
  }
  const durable = bindings.find(
    (item) =>
      item.name === "INVITE_REACTIONS" &&
      item.type === "durable_object_namespace",
  );
  if (!durable || durable.namespace_id !== manifest.namespaceId)
    throw new Error("candidate Durable Object namespace changed");
  for (const [name, value] of Object.entries({
    API_MAINTENANCE: variant === "destination-live" ? "false" : "true",
    D1_MIGRATION_RUN_ID: variant === "destination-live" ? "" : manifest.runId,
    EVENT_DB_BOOKMARK_EPOCH:
      variant === "source-maintenance"
        ? database(manifest, "EVENT_DB").sourceId
        : database(manifest, "EVENT_DB").destinationId,
  })) {
    const setting = bindings.find(
      (binding) => binding.type === "plain_text" && binding.name === name,
    );
    if (setting?.text !== value)
      throw new Error(`candidate migration setting differs: ${name}`);
  }
  const original = apiRecord(
    await provider.request(
      `workers/scripts/${manifest.workerName}/versions/${manifest.originalVersionId}`,
    ),
  );
  const originalBindings = array(apiRecord(original.resources).bindings);
  for (const binding of originalBindings.filter((item) =>
    ["secret_text", "workflow", "queue", "ratelimit"].includes(
      String(item.type),
    ),
  )) {
    const current = bindings.find(
      (item) => item.name === binding.name && item.type === binding.type,
    );
    if (!current || canonicalJson(current) !== canonicalJson(binding))
      throw new Error(
        `candidate changed an unrelated binding: ${String(binding.name)}`,
      );
  }
}

async function uploadVariant(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
  variant: keyof MigrationManifest["versions"],
): Promise<string> {
  const fingerprint = requireValidation(manifest);
  if (manifest.versions[variant]) {
    const upload = manifest.records[`upload-${variant}`];
    if (!upload || apiRecord(upload).fingerprint !== fingerprint)
      throw new Error(
        "cached candidate was built from different source; prepare a newly validated candidate",
      );
    await assertVersionBindings(
      provider,
      manifest,
      variant,
      manifest.versions[variant]!,
    );
    return manifest.versions[variant]!;
  }
  const short =
    variant === "source-maintenance"
      ? "src"
      : variant === "destination-maintenance"
        ? "dst"
        : "live";
  const tag = `enam-${manifest.runId.slice(0, 8)}-${short}-${fingerprint.slice(0, 8)}`;
  const versions = apiRecord(
    await provider.request(
      `workers/scripts/${manifest.workerName}/versions?page=1&per_page=100`,
    ),
  );
  const matching = array(versions.items).filter(
    (item) => apiRecord(item.annotations || {})["workers/tag"] === tag,
  );
  let id: string;
  if (matching.length === 1) id = field(matching[0], "id");
  else {
    if (matching.length > 1)
      throw new Error("multiple migration uploads have the same identity");
    manifest.records[`upload-${variant}`] = {
      tag,
      startedAt: new Date().toISOString(),
      fingerprint,
    };
    saveManifest(args.directory, manifest);
    const output = await command(
      args,
      `upload-${short}`,
      resolve(ROOT, "node_modules/.bin/wrangler"),
      [
        "versions",
        "upload",
        "--strict",
        "--tag",
        tag,
        "--config",
        candidatePath(args, variant),
        "--env-file",
        RELEASE_ENV,
      ],
    );
    const match =
      output.match(/Worker Version ID:\s*([a-f0-9-]{36})/i) ||
      output.match(/Version ID:\s*([a-f0-9-]{36})/i);
    if (!match || !UUID.test(match[1]))
      throw new Error(
        "upload returned no version ID; inspect tagged version before retrying",
      );
    id = match[1];
  }
  await assertVersionBindings(provider, manifest, variant, id);
  if (
    !manifest.records[`upload-${variant}`] ||
    apiRecord(manifest.records[`upload-${variant}`]).tag !== tag
  )
    throw new Error("tagged candidate has no matching saved upload intent");
  manifest.versions[variant] = id;
  saveManifest(args.directory, manifest);
  return id;
}

async function promoteVariant(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
  variant: keyof MigrationManifest["versions"],
) {
  if (variant === "source-maintenance")
    assertMigrationDirection(manifest, "quiesce");
  const version = await uploadVariant(args, provider, manifest, variant);
  const current = await deployedVersion(provider, manifest.workerName);
  const allowed = new Set([
    manifest.originalVersionId,
    ...Object.values(manifest.versions),
  ]);
  if (!allowed.has(current))
    throw new Error(
      "another deployment changed production; reconcile before promoting",
    );
  if (current !== version) {
    manifest.records[`promote-${variant}`] = {
      startedAt: new Date().toISOString(),
      previous: current,
      version,
    };
    saveManifest(args.directory, manifest);
    await command(
      args,
      `promote-${variant}`,
      resolve(ROOT, "node_modules/.bin/wrangler"),
      [
        "versions",
        "deploy",
        "--version-id",
        version,
        "--percentage",
        "100",
        "--yes",
        "--config",
        candidatePath(args, variant),
        "--env-file",
        RELEASE_ENV,
      ],
    );
  }
  if ((await deployedVersion(provider, manifest.workerName)) !== version)
    throw new Error("promotion has not reached the expected deployment");
  await assertVersionBindings(provider, manifest, variant, version);
  return version;
}

async function prepareMigration(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  assertMigrationDirection(manifest, "prepare");
  if (
    manifest.phases.quiesce ||
    manifest.databases.some((db) => db.copyStarted)
  )
    throw new Error(
      "preparation cannot reset candidates after production maintenance begins",
    );
  await createDestinations(args, provider, manifest);
  if (
    (await deployedVersion(provider, manifest.workerName)) !==
    manifest.originalVersionId
  )
    throw new Error("production changed during preparation");
  if (!manifest.records.eventAdmissionCandidates) {
    manifest.records.eventAdmissionCandidates = await provider.query(
      database(manifest, "EVENT_DB").sourceId,
      "SELECT admission_id,freeze_generation,created_at_ms,expires_at_ms FROM event_write_admissions ORDER BY admission_id",
    );
    saveManifest(args.directory, manifest);
  }
  const fingerprint = sourceFingerprint();
  for (const variant of Object.keys(manifest.versions) as Array<
    keyof MigrationManifest["versions"]
  >) {
    const upload = manifest.records[`upload-${variant}`];
    if (!upload || apiRecord(upload).fingerprint !== fingerprint) {
      manifest.records[`superseded-${variant}-${manifest.versions[variant]}`] =
        manifest.records[`upload-${variant}`] || {};
      delete manifest.versions[variant];
    }
  }
  saveManifest(args.directory, manifest);
  if (manifest.records.rehearsalFingerprint !== fingerprint) {
    const savedRehearsal = manifest.records.workerRehearsal
      ? apiRecord(manifest.records.workerRehearsal)
      : null;
    const resumeInitialSleep = [
      "workflow:create-requested",
      "workflow:cleanup-delete-requested",
      "workflow:cleanup-deleted",
      "workflow:definition-delete-requested",
      "workflow:complete",
    ].includes(String(savedRehearsal?.phase));
    if (!resumeInitialSleep)
      await cleanupRecordedRehearsal(args, provider, manifest);
    const savedAttempt = resumeInitialSleep
      ? apiRecord(manifest.records.rehearsalAttempt)
      : null;
    const attemptId = savedAttempt
      ? field(savedAttempt, "attemptId")
      : randomUUID();
    if (!UUID.test(attemptId))
      throw new Error("invalid recorded rehearsal attempt UUID");
    const rehearsalDirectory = privateDirectory(
      resolve(args.directory, `rehearsal-${attemptId}`),
    );
    if (savedAttempt && savedAttempt.directory !== rehearsalDirectory)
      throw new Error("rehearsal directory differs from its saved identity");
    manifest.records.rehearsalAttempt = {
      attemptId,
      directory: rehearsalDirectory,
      fingerprint,
    };
    saveManifest(args.directory, manifest);
    if (!resumeInitialSleep) {
      for (const db of manifest.databases) {
        const target = (sql: string, params?: QueryParameter[]) =>
          provider.query(db.destinationId!, sql, params);
        const schema = await captureSchema(target);
        if (schema.objects.length) {
          if (!manifest.records.rehearsalStarted)
            throw new Error("unrecorded data exists in a destination");
          await resetCloneTarget(target, schema);
        }
      }
      manifest.records.rehearsalStarted = new Date().toISOString();
      saveManifest(args.directory, manifest);
      const source = database(manifest, "AUTH_STATE_DB"),
        target = database(manifest, "EVENT_PRIZE_WITHDRAWALS_DB");
      const rehearsal = await runCloneRehearsal(
        (sql, params) => provider.query(source.destinationId!, sql, params),
        (sql, params) => provider.query(target.destinationId!, sql, params),
        {
          onProgress: (progress) => {
            console.log(
              JSON.stringify({ event: "clone_rehearsal", ...progress }),
            );
          },
        },
      );
      artifact(args.directory, `clone-rehearsal-${attemptId}.json`, rehearsal);
      await resetCloneTarget(
        (sql, params) => provider.query(source.destinationId!, sql, params),
        rehearsal.schema,
      );
      await resetCloneTarget(
        (sql, params) => provider.query(target.destinationId!, sql, params),
        rehearsal.schema,
      );
    } else {
      const previousClone = apiRecord(
        readPrivateJson(
          resolve(args.directory, `clone-rehearsal-${attemptId}.json`),
        ),
      );
      if (previousClone.passed !== true)
        throw new Error(
          "cannot resume Worker rehearsal without a passed clone rehearsal",
        );
    }
    const workerRehearsal = await runWorkerRehearsal({
      manifest,
      directory: rehearsalDirectory,
      attemptId,
      provider,
      runCommand: (label, executable, argv, env) =>
        command(args, label, executable, argv, env),
      persist: async () => saveManifest(args.directory, manifest),
    });
    artifact(
      args.directory,
      `worker-rehearsal-${attemptId}.json`,
      workerRehearsal,
    );
    const scratchName = String(workerRehearsal.workerName);
    if (
      scratchName !==
      `mons-link-d1-enam-rehearsal-${manifest.runId.slice(0, 8)}-${attemptId.slice(0, 8)}`
    )
      throw new Error("unexpected rehearsal Worker identity");
    await provider.request(`workers/scripts/${scratchName}`, "DELETE");
    manifest.records.workerRehearsalRetired = {
      name: scratchName,
      at: new Date().toISOString(),
    };
    saveManifest(args.directory, manifest);
    for (const db of manifest.databases) {
      const targetQuery = (sql: string, params?: QueryParameter[]) =>
        provider.query(db.destinationId!, sql, params);
      await resetCloneTarget(targetQuery, await captureSchema(targetQuery));
    }
    if (
      workerRehearsal.bookmarkCompatibility.accepted !== true &&
      workerRehearsal.bookmarkCompatibility.recoveryVerified !== true
    )
      throw new Error(
        "cross-database bookmark compatibility is unconfirmed; inspect rehearsal evidence before maintenance",
      );
    manifest.records.rehearsalFingerprint = fingerprint;
    manifest.records.rehearsalPassedAt = new Date().toISOString();
    saveManifest(args.directory, manifest);
  }
  if (
    !manifest.records.validation ||
    apiRecord(manifest.records.validation).fingerprint !== fingerprint
  ) {
    await command(args, "check-all", "npm", ["run", "check:all"]);
    if (sourceFingerprint() !== fingerprint)
      throw new Error("source changed during validation");
    manifest.records.validation = {
      fingerprint,
      passedAt: new Date().toISOString(),
    };
    saveManifest(args.directory, manifest);
  }
  const wagerFixture = resolve(args.directory, "wager-smoke.json");
  if (
    !existsSync(wagerFixture) ||
    apiRecord(readPrivateJson(wagerFixture)).stage === "preparing"
  )
    await command(args, "prepare-wager-fixtures", "npm", [
      "run",
      "smoke:wagers",
      "--",
      "--base-url",
      "https://api.mons.link",
      "--prepare-fixtures",
      "--fixture",
      wagerFixture,
    ]);
  if (apiRecord(readPrivateJson(wagerFixture)).stage !== "prepared")
    throw new Error("wager migration fixture is not prepared");
  manifest.records.wagerFixturePreparedAt ||= new Date().toISOString();
  saveManifest(args.directory, manifest);
  if (!manifest.records.oldEventBookmark) {
    manifest.records.oldEventBookmark = await captureEventBookmarkProbe({
      query: (id, sql, params) =>
        provider.query(id, sql, queryParameters(params)),
      eventDatabaseId: database(manifest, "EVENT_DB").sourceId,
    });
    saveManifest(args.directory, manifest);
  }
  await uploadVariant(args, provider, manifest, "source-maintenance");
  manifest.phases.prepare = new Date().toISOString();
  saveManifest(args.directory, manifest);
}

async function cleanupRecordedRehearsal(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  if (!manifest.records.workerRehearsal) return;
  if (
    manifest.records.quiesceStartedAt ||
    manifest.databases.some((db) => db.copyStarted)
  )
    throw new Error(
      "rehearsal cleanup cannot run after production maintenance starts",
    );
  const intent = apiRecord(manifest.records.workerRehearsal);
  const name = field(intent, "workerName");
  const prefix = `mons-link-d1-enam-rehearsal-${manifest.runId.slice(0, 8)}`;
  if (name !== prefix && !new RegExp(`^${prefix}-[a-f0-9]{8}$`).test(name))
    throw new Error("scratch Worker does not belong to this migration");
  const workflowName = `${name}-progress`;
  const optional = async (path: string) => {
    try {
      return apiRecord(await provider.request(path));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  };
  const workflow = await optional(`workflows/${workflowName}`);
  if (workflow && workflow.is_deleted !== 1) {
    if (
      workflow.script_name !== name ||
      workflow.class_name !== "EventProgressWorkflow"
    )
      throw new Error("scratch Workflow ownership changed");
    const journal = apiRecord(intent.workflow || {});
    for (const instance of await provider.list(
      `workflows/${workflowName}/instances`,
    )) {
      const id = field(instance, "id");
      const path = `workflows/${workflowName}/instances/${id}`;
      const detail = apiRecord(await provider.request(path));
      if (
        id !== journal.instanceId ||
        canonicalJson(detail.params) !== canonicalJson(journal.params)
      )
        throw new Error("scratch Workflow contains an unowned instance");
      if (
        !["complete", "errored", "terminated"].includes(String(detail.status))
      ) {
        await provider.request(`${path}/status`, "PATCH", {
          status: "terminate",
        });
        const after = apiRecord(await provider.request(path));
        if (after.status !== "terminated")
          throw new Error("scratch instance termination remains in progress");
      }
      await provider.request(
        `workflows/${workflowName}/instances/batch/delete`,
        "POST",
        { instances: [id] },
      );
      if (await optional(path))
        throw new Error("scratch instance deletion remains in progress");
    }
    await provider.request(`workflows/${workflowName}`, "DELETE");
  }
  const worker = await optional(`workers/scripts/${name}/settings`);
  if (worker) await provider.request(`workers/scripts/${name}`, "DELETE");
  manifest.records[`retired-rehearsal-${name}`] = {
    intent,
    retiredAt: new Date().toISOString(),
  };
  delete manifest.records.workerRehearsal;
  saveManifest(args.directory, manifest);
}

async function setQueueDelivery(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
  paused: boolean,
) {
  for (const original of manifest.queues) {
    const id = field(original, "queue_id"),
      name = field(original, "queue_name");
    const originalPaused = apiRecord(original.settings).delivery_paused;
    if (typeof originalPaused !== "boolean")
      throw new Error("missing original Queue pause state");
    const desired = paused || originalPaused;
    const current = apiRecord(await provider.request(`queues/${id}`));
    if (current.queue_name !== name) throw new Error("Queue identity changed");
    if (apiRecord(current.settings).delivery_paused !== desired) {
      manifest.records[`queue-${id}`] = {
        desired,
        startedAt: new Date().toISOString(),
      };
      saveManifest(args.directory, manifest);
      await provider.request(`queues/${id}`, "PATCH", {
        queue_name: name,
        settings: { delivery_paused: desired },
      });
    }
    const after = apiRecord(await provider.request(`queues/${id}`));
    if (apiRecord(after.settings).delivery_paused !== desired)
      throw new Error("Queue delivery state not confirmed");
    for (const [key, value] of Object.entries(apiRecord(original.settings)))
      if (key !== "delivery_paused" && apiRecord(after.settings)[key] !== value)
        throw new Error("unrelated Queue setting changed");
  }
  manifest.records.queuesPaused = paused;
  saveManifest(args.directory, manifest);
}

async function reconcileRecordedEventAdmissions(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
  versionId: string,
) {
  if (
    (await deployedVersion(provider, manifest.workerName)) !== versionId ||
    manifest.records.queuesPaused !== true ||
    !manifest.workflows ||
    manifest.workflows.entries.some(
      (entry) => !["paused", "completed"].includes(entry.stage),
    )
  )
    throw new Error(
      "event admission reconciliation requires confirmed maintenance and paused work",
    );
  const id = database(manifest, "EVENT_DB").sourceId;
  const profileGate = await provider.query(
    database(manifest, "PROFILE_DB").sourceId,
    "SELECT state FROM profile_canonical_control WHERE singleton=1",
  );
  if (profileGate.length !== 1 || profileGate[0].state !== "frozen")
    throw new Error(
      "profile writers must be frozen before event admission reconciliation",
    );
  const candidates = array(manifest.records.eventAdmissionCandidates || []);
  const admissions = await provider.query(
    id,
    "SELECT admission_id,freeze_generation,created_at_ms,expires_at_ms FROM event_write_admissions ORDER BY created_at_ms,admission_id",
  );
  if (!admissions.length) return;
  const blockers = await provider.query(
    id,
    "SELECT (SELECT COUNT(*) FROM event_transition_intents WHERE status='pending') AS intents,(SELECT COUNT(*) FROM event_leases WHERE expires_at_ms>unixepoch()*1000) AS leases",
  );
  if (
    blockers.length !== 1 ||
    blockers[0].intents !== 0 ||
    blockers[0].leases !== 0
  )
    throw new Error(
      "event admissions have unresolved transition or lease evidence",
    );
  for (const admission of admissions) {
    const admissionId = field(admission, "admission_id");
    const captured = candidates.find(
      (candidate) => candidate.admission_id === admissionId,
    );
    if (!captured || canonicalJson(captured) !== canonicalJson(admission))
      throw new Error(
        "event admission differs from the reviewed preparation inventory",
      );
    if (
      !/^ewa_[a-f0-9-]{36}$/.test(admissionId) ||
      typeof admission.expires_at_ms !== "number" ||
      admission.expires_at_ms >= Date.parse(manifest.createdAt)
    )
      throw new Error(
        "event admission is not an expired pre-migration request; inspect it individually",
      );
    const evidenceName = `event-admission-${admissionId}.json`;
    artifact(args.directory, evidenceName, {
      admission,
      requestFinished: true,
      sourceReconciled: true,
      rationale:
        "The unchanged admission predates migration preparation and its bounded request lifetime has elapsed. Full API maintenance, frozen profile writers, paused Queue consumers and paused initial-sleep Workflows prevent new work. No pending event transition or active event lease remains; durable receipts and outboxes are retained for exact migration.",
      blockers,
      profileGate,
      versionId,
      preflightAt: manifest.createdAt,
      waitingWorkflows: manifest.workflows.entries.map((entry) => ({
        id: entry.id,
        stage: entry.stage,
        originalStepCount: entry.original.detail.step_count,
      })),
    });
    await command(
      args,
      `recover-${admissionId}`,
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "scripts/manage-events.ts",
        "--recover-stale-admission",
        admissionId,
        "--evidence",
        resolve(args.directory, evidenceName),
      ],
      { MONS_D1_CONFIG: candidatePath(args, "source-maintenance") },
    );
    if (
      (
        await provider.query(
          id,
          "SELECT admission_id FROM event_write_admissions WHERE admission_id=?",
          [admissionId],
        )
      ).length
    )
      throw new Error("named admission recovery was not confirmed");
  }
}

async function namespaceObjectIds(
  provider: CloudflareProvider,
  namespaceId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const response = await provider.envelope(
      `workers/durable_objects/namespaces/${namespaceId}/objects?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const item of array(response.result)) {
      const id = field(item, "id");
      if (!/^[a-f0-9]{64}$/.test(id))
        throw new Error("invalid Durable Object ID");
      ids.add(id);
    }
    const info = apiRecord(response.result_info || {});
    cursor =
      typeof info.cursor === "string" && info.cursor ? info.cursor : undefined;
    if (cursor) {
      if (cursors.has(cursor))
        throw new Error("Durable Object pagination repeated a cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  return [...ids].sort();
}

async function concurrent<T>(
  items: T[],
  operation: (item: T) => Promise<void>,
  limit = 16,
) {
  await concurrentSettled(items, operation, limit);
}

function barrierIdentity(value: ApiRecord): unknown {
  return {
    objectId: value.objectId,
    source: value.source,
    canonicalDigest: value.canonicalDigest,
    effectDigest: value.effectDigest,
    pendingEffects: value.pendingEffects,
    nextEffectAt: value.nextEffectAt,
  };
}

async function collectBarriers(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
  versionId: string,
  phase: "source" | "destination",
) {
  const completed = new Map<string, ApiRecord>();
  const resumePartial = manifest.records[`${phase}Barriers`] === undefined;
  const verify = async (target: ApiRecord) => {
    const cachedPath =
      typeof target.objectId === "string"
        ? resolve(args.directory, `do-${phase}-${target.objectId}.json`)
        : null;
    const cached =
      resumePartial && cachedPath && existsSync(cachedPath)
        ? apiRecord(readPrivateJson(cachedPath))
        : null;
    const result =
      cached &&
      isReusableBarrier(cached, {
        runId: manifest.runId,
        versionId,
        objectId: String(target.objectId),
      })
        ? cached
        : await maintenanceCommand(args, manifest, versionId, {
            operation: "barrier",
            ...target,
          });
    const id = field(result, "objectId");
    if (
      target.inviteId &&
      apiRecord(result.source).inviteId !== target.inviteId
    )
      throw new Error(
        "canonical route points to a different or absent Durable Object source",
      );
    if (phase === "destination") {
      const before = apiRecord(
        readPrivateJson(resolve(args.directory, `do-source-${id}.json`)),
      );
      if (
        canonicalJson(barrierIdentity(before)) !==
        canonicalJson(barrierIdentity(result))
      )
        throw new Error(
          `Durable Object canonical state changed during migration: ${id}`,
        );
    }
    const path = resolve(args.directory, `do-${phase}-${id}.json`);
    if (existsSync(path)) {
      const before = apiRecord(readPrivateJson(path));
      if (
        canonicalJson(barrierIdentity(before)) !==
        canonicalJson(barrierIdentity(result))
      )
        throw new Error(
          `Durable Object state changed after its barrier: ${id}`,
        );
    } else writePrivateImmutable(path, result);
    completed.set(id, result);
    if (completed.size % 100 === 0)
      console.log(
        JSON.stringify({
          event: "migration_do_barriers",
          phase,
          completed: completed.size,
        }),
      );
  };
  const saved = manifest.records.sourceBarriers
    ? apiRecord(manifest.records.sourceBarriers).objectIds
    : [];
  if (
    !Array.isArray(saved) ||
    saved.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
  )
    throw new Error("invalid saved Durable Object inventory");
  const initial = [
    ...new Set([
      ...(saved as string[]),
      ...(await namespaceObjectIds(provider, manifest.namespaceId)),
    ]),
  ].sort();
  await concurrent(initial, (id) => verify({ objectId: id }));
  const routed = await provider.query(
    database(manifest, "PROFILE_GAMES_DB").sourceId,
    "SELECT DISTINCT invite_id FROM match_state_routes WHERE kind='durable' ORDER BY invite_id",
  );
  const knownNames = new Set(
    [...completed.values()].flatMap((value) =>
      value.source ? [apiRecord(value.source).inviteId] : [],
    ),
  );
  await concurrent(
    routed.filter((row) => !knownNames.has(row.invite_id)),
    (row) => verify({ inviteId: field(row, "invite_id") }),
  );
  const final = await namespaceObjectIds(provider, manifest.namespaceId);
  await concurrent(
    final.filter((id) => !completed.has(id)),
    (id) => verify({ objectId: id }),
  );
  const expectedEpoch =
    manifest.controls["PROFILE_GAMES_DB.match_state_control"]?.[0]?.epoch;
  const byName = new Map(
    [...completed.values()].flatMap((value) =>
      value.source
        ? [[apiRecord(value.source).inviteId, apiRecord(value.source)] as const]
        : [],
    ),
  );
  for (const route of routed) {
    const source = byName.get(route.invite_id);
    if (!source || source.epoch !== expectedEpoch || source.status !== "active")
      throw new Error(
        "routed Durable Object epoch does not match the frozen database",
      );
  }
  const result = {
    phase,
    versionId,
    objects: completed.size,
    routedInvites: routed.length,
    objectIds: [...completed.keys()].sort(),
  };
  manifest.records[`${phase}Barriers`] = result;
  recordEvidence(args, manifest, `${phase}-barriers`, result);
  return result;
}

export function isReusableBarrier(
  value: ApiRecord,
  expected: { runId: string; versionId: string; objectId: string },
): boolean {
  return (
    value.ok === true &&
    value.schemaVersion === 1 &&
    value.maintenance === true &&
    value.runId === expected.runId &&
    value.versionId === expected.versionId &&
    value.objectId === expected.objectId &&
    /^[a-f0-9]{64}$/.test(String(value.canonicalDigest)) &&
    /^[a-f0-9]{64}$/.test(String(value.effectDigest)) &&
    (value.source === null ||
      (typeof value.source === "object" && !Array.isArray(value.source))) &&
    (value.nextEffectAt === null || Number.isSafeInteger(value.nextEffectAt)) &&
    (value.alarmAt === null || Number.isSafeInteger(value.alarmAt)) &&
    Number.isSafeInteger(value.pendingEffects) &&
    Number(value.pendingEffects) >= 0
  );
}

async function quiesceMigration(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  assertMigrationDirection(manifest, "quiesce");
  requirePhase(manifest, "prepare");
  requireValidation(manifest);
  bridgeSecret(args);
  manifest.records.quiesceStartedAt ||= new Date().toISOString();
  saveManifest(args.directory, manifest);
  const versionId = await promoteVariant(
    args,
    provider,
    manifest,
    "source-maintenance",
  );
  await maintenanceCommand(args, manifest, versionId, {
    operation: "status",
    binding: "AUTH_STATE_DB",
  });
  await setQueueDelivery(args, provider, manifest, true);
  if (!manifest.records.workflowCaptureAtMaintenance) {
    manifest.workflows = await captureWorkflowHandoff({
      request: workflowRequest(provider),
      query: (id, sql, params) =>
        provider.query(id, sql, queryParameters(params)),
      eventDatabaseId: database(manifest, "EVENT_DB").sourceId,
      withdrawalDatabaseId: database(manifest, "EVENT_PRIZE_WITHDRAWALS_DB")
        .sourceId,
    });
    manifest.records.workflowCaptureAtMaintenance = new Date().toISOString();
    saveManifest(args.directory, manifest);
  }
  manifest.workflows = await pauseWorkflowHandoff({
    request: workflowRequest(provider),
    manifest: manifest.workflows!,
    persist: async (value) => {
      manifest.workflows = value;
      saveManifest(args.directory, manifest);
    },
  });
  await freezeDomainControls({
    manifest,
    query: (id, sql, params) =>
      provider.query(id, sql, queryParameters(params)),
    persist: async () => saveManifest(args.directory, manifest),
    beforeControl: async (control) => {
      if (control.table === "event_runtime_control")
        await reconcileRecordedEventAdmissions(
          args,
          provider,
          manifest,
          versionId,
        );
    },
  });
  const status = await maintenanceCommand(args, manifest, versionId, {
    operation: "status",
  });
  const stores = array(status.databases);
  if (stores.length !== 6 || stores.some((store) => store.drained !== true))
    throw new Error(
      `writers are not drained: ${JSON.stringify(stores.map((store) => ({ binding: store.binding, blockers: store.blockers })))}`,
    );
  for (const store of stores) {
    const db = database(manifest, store.binding as D1Binding);
    const triggerNames = apiRecord(store.fence).triggerNames;
    if (
      !Array.isArray(triggerNames) ||
      triggerNames.some((name) => typeof name !== "string")
    )
      throw new Error("missing exact source fence names");
    db.fenceTriggers = triggerNames as string[];
    const fresh = await captureSchema(
      (sql, params) => provider.query(db.sourceId, sql, params),
      { ignoreSchemaObjects: db.fenceTriggers },
    );
    if (canonicalJson(fresh) !== canonicalJson(db.schema))
      throw new Error(`source schema changed since rehearsal: ${db.binding}`);
    saveManifest(args.directory, manifest);
    await maintenanceCommand(args, manifest, versionId, {
      operation: "fence",
      binding: db.binding,
      schemaDigest: store.schemaDigest,
    });
    const names = new Set(db.fenceTriggers);
    const fenceSchema = (
      await provider.query(
        db.sourceId,
        "SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name",
      )
    ).filter((row) => names.has(String(row.name)));
    if (fenceSchema.length !== names.size)
      throw new Error("source fence inventory is incomplete");
    artifact(args.directory, `fence-${db.binding}.json`, fenceSchema);
  }
  manifest.records.sourceBarriers = await collectBarriers(
    args,
    provider,
    manifest,
    versionId,
    "source",
  );
  const verification = await maintenanceCommand(args, manifest, versionId, {
    operation: "verify",
  });
  if (
    array(verification.databases).some(
      (store) => store.valid !== true || !apiRecord(store.fence).complete,
    )
  )
    throw new Error("source integrity or fence verification failed");
  recordEvidence(args, manifest, "source-fenced-verification", verification);
  manifest.phases.quiesce = new Date().toISOString();
  saveManifest(args.directory, manifest);
}

async function copyMigration(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  assertMigrationDirection(manifest, "copy");
  requirePhase(manifest, "quiesce");
  requireValidation(manifest);
  if (
    (await deployedVersion(provider, manifest.workerName)) !==
      manifest.versions["source-maintenance"] ||
    manifest.phases.cutover
  )
    throw new Error("copy requires production to remain on the fenced sources");
  await concurrent(
    manifest.databases,
    async (db) => {
      if (db.copied) return;
      const source = (sql: string, params?: QueryParameter[]) =>
        provider.query(db.sourceId, sql, params);
      const target = (sql: string, params?: QueryParameter[]) =>
        provider.query(db.destinationId!, sql, params);
      if (db.copyStarted) await resetCloneTarget(target, db.schema!);
      db.copyStarted = true;
      saveManifest(args.directory, manifest);
      db.digest = await cloneDatabase(source, target, {
        schema: db.schema!,
        ignoreSchemaObjects: db.fenceTriggers,
        onProgress: (progress) => {
          console.log(
            JSON.stringify({
              event: "migration_copy",
              binding: db.binding,
              ...progress,
            }),
          );
        },
      });
      db.copied = true;
      artifact(args.directory, `copy-${db.binding}.json`, db.digest);
      saveManifest(args.directory, manifest);
    },
    3,
  );
  manifest.phases.copy = new Date().toISOString();
  saveManifest(args.directory, manifest);
}

async function verifyMigration(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  assertMigrationDirection(manifest, "verify");
  requirePhase(manifest, "copy");
  requireValidation(manifest);
  await concurrent(
    manifest.databases,
    async (db) => {
      if (!db.copied || !db.digest)
        throw new Error("database copy is incomplete");
      const digest = await verifyDatabase(
        (sql, params) => provider.query(db.sourceId, sql, params),
        (sql, params) => provider.query(db.destinationId!, sql, params),
        {
          expectedSourceDigest: db.digest,
          ignoreSchemaObjects: db.fenceTriggers,
          onProgress: (progress) => {
            console.log(
              JSON.stringify({
                event: "migration_verify",
                binding: db.binding,
                ...progress,
              }),
            );
          },
        },
      );
      artifact(args.directory, `verified-${db.binding}.json`, digest);
    },
    3,
  );
  await collectBarriers(
    args,
    provider,
    manifest,
    manifest.versions["source-maintenance"]!,
    "source",
  );
  manifest.phases.verify = new Date().toISOString();
  saveManifest(args.directory, manifest);
}

async function publishDefinitions(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
  variant: "destination-maintenance" | "destination-live",
) {
  const versionId = manifest.versions[variant]!;
  const key = `workflow-publications-${variant}`;
  const configuration = parseWorkflowPublicationConfiguration(
    readFileSync(candidatePath(args, variant), "utf8"),
  );
  const publications: ApiRecord[] = [];
  for (const definition of configuration.workflows) {
    const receiptKey = `publication-${variant}-${definition.name}`;
    const intentKey = `publication-intent-${variant}-${definition.name}`;
    const savedIntent = manifest.records[intentKey];
    if (savedIntent && !manifest.records[receiptKey]) {
      const intent = apiRecord(savedIntent);
      if (intent.workerVersionId !== versionId)
        throw new Error("publication intent targets another Worker version");
      const inspected = await publishCloudflareWorkflows(
        { versionId, workflows: [definition.name], dryRun: true },
        {
          configuration,
          request: (path, method, body) =>
            provider.request(path.replace(/^\//, ""), method, body),
          log: () => {},
        },
      );
      const current = apiRecord(inspected.workflows[0]);
      if (
        canonicalJson(current.publishBody) !== canonicalJson(intent.publishBody)
      )
        throw new Error(
          "Workflow settings changed during uncertain publication",
        );
      if (
        current.previousWorkflowVersionId !== intent.previousWorkflowVersionId
      ) {
        const known = new Set(
          Array.isArray(intent.knownVersionIds) ? intent.knownVersionIds : [],
        );
        const versions = await provider.list(
          `workflows/${definition.name}/versions`,
        );
        const owned = apiRecord(
          await provider.request(`workflows/${definition.name}`),
        );
        const history = array(
          manifest.records.workflowPublicationHistory || [],
        );
        for (const version of versions.filter((row) => !known.has(row.id))) {
          if (
            version.workflow_id !== owned.id ||
            version.class_name !== definition.className
          )
            throw new Error(
              "unconfirmed Workflow publication ownership changed",
            );
          if (!history.some((row) => row.workflowVersionId === version.id))
            history.push({
              name: definition.name,
              workerVersionId: versionId,
              workflowVersionId: field(version, "id"),
              variant,
              acknowledged: false,
              confirmed: true,
            });
        }
        manifest.records.workflowPublicationHistory = history;
        manifest.records[receiptKey] = {
          name: definition.name,
          workerVersionId: versionId,
          workflowVersionId: field(current, "previousWorkflowVersionId"),
          previousWorkflowVersionId: field(intent, "previousWorkflowVersionId"),
        };
        saveManifest(args.directory, manifest);
      }
    }
    const history = array(manifest.records.workflowPublicationHistory || []);
    const uncertain = history.filter(
      (item) =>
        item.name === definition.name &&
        item.workerVersionId === versionId &&
        item.confirmed !== true,
    );
    if (uncertain.length) {
      const latest = apiRecord(
        await provider.request(
          `workers/scripts/${manifest.workerName}/versions?page=1&per_page=1`,
        ),
      );
      if (
        (await deployedVersion(provider, manifest.workerName)) !== versionId ||
        array(latest.items)[0]?.id !== versionId
      )
        throw new Error(
          "cannot reconcile publication after another Worker upload or deployment",
        );
      const owned = apiRecord(
        await provider.request(`workflows/${definition.name}`),
      );
      for (const item of uncertain) {
        const published = apiRecord(
          await provider.request(
            `workflows/${definition.name}/versions/${field(item, "workflowVersionId")}`,
          ),
        );
        if (
          published.workflow_id !== owned.id ||
          published.class_name !== definition.className
        )
          throw new Error(
            "uncertain Workflow publication has different ownership",
          );
        item.confirmed = true;
      }
      manifest.records.workflowPublicationHistory = history;
      saveManifest(args.directory, manifest);
    }
    const previous = manifest.records[receiptKey];
    if (previous) {
      const receipt = publicationReceipt(previous);
      const published = await getPublishedWorkflowVersion(
        workflowRequest(provider),
        definition.name,
      );
      if (
        receipt.workerVersionId !== versionId ||
        published !== receipt.workflowVersionId
      )
        throw new Error("published Workflow definition changed unexpectedly");
      publications.push(receipt);
      continue;
    }
    const result = await publishCloudflareWorkflows(
      { versionId, workflows: [definition.name], dryRun: false },
      {
        configuration,
        request: async (path, method, body) => {
          if (method === "PUT") {
            const before = await getPublishedWorkflowVersion(
              workflowRequest(provider),
              definition.name,
            );
            const known = await provider.list(
              `workflows/${definition.name}/versions`,
            );
            manifest.records[intentKey] = {
              name: definition.name,
              workerVersionId: versionId,
              previousWorkflowVersionId: before,
              knownVersionIds: known.map((version) => field(version, "id")),
              publishBody: body,
              startedAt: new Date().toISOString(),
            };
            saveManifest(args.directory, manifest);
          }
          const value = await provider.request(
            path.replace(/^\//, ""),
            method,
            body,
          );
          if (method === "PUT") {
            const acknowledgment = apiRecord(value);
            const id = field(acknowledgment, "version_id");
            const history = array(
              manifest.records.workflowPublicationHistory || [],
            );
            history.push({
              name: definition.name,
              workerVersionId: versionId,
              workflowVersionId: id,
              variant,
              acknowledged: true,
            });
            manifest.records.workflowPublicationHistory = history;
            saveManifest(args.directory, manifest);
          }
          return value;
        },
        log: (value) => {
          const event = apiRecord(value);
          manifest.records[receiptKey] = publicationReceipt(event);
          const history = array(
            manifest.records.workflowPublicationHistory || [],
          );
          for (const publication of history)
            if (publication.workflowVersionId === event.workflowVersionId)
              publication.confirmed = true;
          manifest.records.workflowPublicationHistory = history;
          saveManifest(args.directory, manifest);
          console.log(
            JSON.stringify({
              event: "migration_workflow_published",
              name: event.name,
              workflowVersionId: event.workflowVersionId,
            }),
          );
        },
      },
    );
    publications.push(...result.workflows.map(publicationReceipt));
  }
  manifest.records[key] = publications;
  saveManifest(args.directory, manifest);
  artifact(args.directory, `${key}.json`, {
    workerVersionId: versionId,
    workflows: publications,
  });
  return publications;
}

export function publicationReceipt(value: unknown): ApiRecord {
  const publication = apiRecord(value);
  return {
    name: field(publication, "name"),
    workerVersionId: field(publication, "workerVersionId"),
    workflowVersionId: field(publication, "workflowVersionId"),
    previousWorkflowVersionId: field(publication, "previousWorkflowVersionId"),
  };
}

async function cutoverMigration(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  assertMigrationDirection(manifest, "cutover");
  requirePhase(manifest, "verify");
  requireValidation(manifest);
  manifest.records.cutoverStartedAt ||= new Date().toISOString();
  saveManifest(args.directory, manifest);
  const versionId = await promoteVariant(
    args,
    provider,
    manifest,
    "destination-maintenance",
  );
  const verification = await maintenanceCommand(args, manifest, versionId, {
    operation: "verify",
  });
  if (
    array(verification.databases).length !== 6 ||
    array(verification.databases).some(
      (store) =>
        store.valid !== true ||
        store.drained !== true ||
        apiRecord(store.fence).installedTriggers !== 0,
    )
  )
    throw new Error("destination maintenance verification failed");
  recordEvidence(
    args,
    manifest,
    "destination-maintenance-verification",
    verification,
  );
  manifest.records.destinationBarriers = await collectBarriers(
    args,
    provider,
    manifest,
    versionId,
    "destination",
  );
  saveManifest(args.directory, manifest);
  const publications = await publishDefinitions(
    args,
    provider,
    manifest,
    "destination-maintenance",
  );
  const eventPublication = publications.find(
    (row) => row.name === "mons-link-event-progress",
  );
  if (!eventPublication) throw new Error("missing event Workflow publication");
  const targetWorkflowVersionId = field(eventPublication, "workflowVersionId");
  manifest.workflows = await executeWorkflowHandoff({
    request: workflowRequest(provider),
    query: (id, sql, params) =>
      provider.query(id, sql, queryParameters(params)),
    eventDatabaseId: database(manifest, "EVENT_DB").destinationId!,
    manifest: manifest.workflows!,
    targetWorkflowVersionId,
    persist: async (value) => {
      manifest.workflows = value;
      saveManifest(args.directory, manifest);
    },
  });
  const handoff = await verifyWorkflowHandoff({
    request: workflowRequest(provider),
    manifest: manifest.workflows,
    targetWorkflowVersionId,
  });
  recordEvidence(args, manifest, "workflow-handoff-verification", handoff);
  manifest.records.handoff = handoff;
  manifest.phases.cutover = new Date().toISOString();
  saveManifest(args.directory, manifest);
}

async function withdrawalPreflight(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  const key = "withdrawalPreflight";
  if (!manifest.records[key]) {
    manifest.records[key] = {
      id: `preflight-enam-${manifest.runId}`,
      created: false,
    };
    saveManifest(args.directory, manifest);
  }
  const record = apiRecord(manifest.records[key]);
  const id = field(record, "id");
  const path = `workflows/mons-link-event-prize-withdrawal/instances/${id}`;
  if (record.ready) return;
  let detail: ApiRecord | undefined;
  try {
    detail = apiRecord(await provider.request(path));
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  if (!detail) {
    await provider.request(
      "workflows/mons-link-event-prize-withdrawal/instances",
      "POST",
      { instance_id: id, params: { schemaVersion: 1, kind: "preflight" } },
    );
    record.created = true;
    saveManifest(args.directory, manifest);
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    detail = apiRecord(await provider.request(path));
    const publication = array(
      manifest.records["workflow-publications-destination-maintenance"],
    ).find((row) => row.name === "mons-link-event-prize-withdrawal");
    if (
      !publication ||
      detail.versionId !== publication.workflowVersionId ||
      canonicalJson(detail.params) !==
        canonicalJson({ schemaVersion: 1, kind: "preflight" })
    )
      throw new Error(
        "withdrawal preflight used unexpected bindings or parameters",
      );
    if (detail.status === "complete") {
      const output = apiRecord(detail.output);
      if (output.ok !== true || output.status !== "ready")
        throw new Error("withdrawal runtime preflight did not report ready");
      record.ready = true;
      record.versionId = detail.versionId;
      saveManifest(args.directory, manifest);
      artifact(args.directory, "withdrawal-preflight.json", detail);
      return;
    }
    if (["errored", "terminated", "paused"].includes(String(detail.status)))
      throw new Error("withdrawal runtime preflight failed");
  }
  throw new Error(
    "withdrawal preflight remains in progress; resume using the saved instance",
  );
}

async function verifySourceFences(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  for (const db of manifest.databases) {
    const expected = readPrivateJson(
      resolve(args.directory, `fence-${db.binding}.json`),
    );
    const names = new Set(db.fenceTriggers);
    const actual = (
      await provider.query(
        db.sourceId,
        "SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name",
      )
    ).filter((row) => names.has(String(row.name)));
    if (canonicalJson(actual) !== canonicalJson(expected))
      throw new Error(`source write fence changed: ${db.binding}`);
  }
}

function commitDestinationConfiguration(manifest: MigrationManifest) {
  const current = readOperatorConfiguration(DEFAULT_API_CONFIG);
  const bindings = array(current.d1_databases);
  for (const binding of bindings) {
    const db = database(manifest, binding.binding as D1Binding);
    if (![db.sourceId, db.destinationId].includes(String(binding.database_id)))
      throw new Error(
        "tracked database configuration changed outside migration",
      );
  }
  let text = readFileSync(DEFAULT_API_CONFIG, "utf8");
  let contracts = readFileSync(
    resolve(ROOT, "scripts/projectContracts.test.ts"),
    "utf8",
  );
  for (const db of manifest.databases) {
    text = text
      .replaceAll(`"${db.sourceId}"`, `"${db.destinationId}"`)
      .replaceAll(`"${db.sourceName}"`, `"${db.destinationName}"`);
    contracts = contracts
      .replaceAll(`"${db.sourceId}"`, `"${db.destinationId}"`)
      .replaceAll(`"${db.sourceName}"`, `"${db.destinationName}"`);
  }
  writeFileSync(DEFAULT_API_CONFIG, text);
  writeFileSync(resolve(ROOT, "scripts/projectContracts.test.ts"), contracts);
}

async function runRecordedProbe(
  args: MigrationArguments,
  manifest: MigrationManifest,
  name: string,
  run: (attempt: string) => Promise<unknown>,
) {
  const probes = apiRecord(manifest.records.liveProbes || {});
  manifest.records.liveProbes = probes;
  if (probes[name] && apiRecord(probes[name]).passed === true) return;
  const attempt = randomUUID();
  probes[name] = { attempt, startedAt: new Date().toISOString() };
  saveManifest(args.directory, manifest);
  const evidence = await run(attempt);
  const filename = `probe-${name}-${attempt}.json`;
  artifact(args.directory, filename, evidence);
  probes[name] = {
    attempt,
    passed: true,
    evidence: filename,
    finishedAt: new Date().toISOString(),
  };
  saveManifest(args.directory, manifest);
}

async function resumeMigration(
  args: MigrationArguments,
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  requirePhase(manifest, "cutover");
  requireValidation(manifest);
  manifest.records.resumeStartedAt ||= new Date().toISOString();
  saveManifest(args.directory, manifest);
  await withdrawalPreflight(args, provider, manifest);
  const maintenanceVersion = manifest.versions["destination-maintenance"]!;
  const current = await deployedVersion(provider, manifest.workerName);
  if (
    ![maintenanceVersion, manifest.versions["destination-live"]].includes(
      current,
    )
  )
    throw new Error("unexpected API version before resume");
  await resumeDomainControls({
    manifest,
    query: (id, sql, params) =>
      provider.query(id, sql, queryParameters(params)),
    activeVersionId: maintenanceVersion,
    persist: async () => saveManifest(args.directory, manifest),
  });
  const liveVersion = await promoteVariant(
    args,
    provider,
    manifest,
    "destination-live",
  );
  await publishDefinitions(args, provider, manifest, "destination-live");
  await setQueueDelivery(args, provider, manifest, false);
  if (!manifest.records.liveChecks) {
    await runRecordedProbe(args, manifest, "api", async () => {
      await command(args, "smoke-api", "npm", [
        "run",
        "smoke:api",
        "--",
        "--base-url",
        "https://api.mons.link",
      ]);
      return { passed: true };
    });
    await runRecordedProbe(args, manifest, "reads", async () =>
      runMigrationReadSmokes({
        oldEventBookmark: manifest.records.oldEventBookmark as
          EventBookmarkProbe | undefined,
        source: {
          gameplayDatabaseId: database(manifest, "PROFILE_GAMES_DB").sourceId,
          eventDatabaseId: database(manifest, "EVENT_DB").sourceId,
          profileDatabaseId: database(manifest, "PROFILE_DB").sourceId,
        },
        destination: {
          gameplayDatabaseId: database(manifest, "PROFILE_GAMES_DB")
            .destinationId!,
          eventDatabaseId: database(manifest, "EVENT_DB").destinationId!,
          profileDatabaseId: database(manifest, "PROFILE_DB").destinationId!,
        },
        query: (id, sql, params) =>
          provider.query(id, sql, queryParameters(params)),
        log: (message) => console.log(message),
      }),
    );
    await runRecordedProbe(
      args,
      manifest,
      "invite-lifecycle",
      async (attempt) => {
        const output = resolve(
          args.directory,
          `invite-lifecycle-${attempt}.json`,
        );
        await command(args, "smoke-invite-lifecycle", "npm", [
          "run",
          "smoke:invite-lifecycle",
          "--",
          "--base-url",
          "https://api.mons.link",
          "--output",
          output,
        ]);
        return { passed: true, report: output };
      },
    );
    await runRecordedProbe(args, manifest, "wagers", async () => {
      await command(args, "smoke-wagers", "npm", [
        "run",
        "smoke:wagers",
        "--",
        "--base-url",
        "https://api.mons.link",
        "--active-lifecycle",
        "--fixture",
        resolve(args.directory, "wager-smoke.json"),
      ]);
      return {
        passed: true,
        fixture: resolve(args.directory, "wager-smoke.json"),
      };
    });
    manifest.records.liveChecks = {
      at: new Date().toISOString(),
      probes: manifest.records.liveProbes,
    };
    saveManifest(args.directory, manifest);
  }
  await verifySourceFences(args, provider, manifest);
  for (const db of manifest.databases) {
    const info = apiRecord(
      await provider.request(`d1/database/${db.destinationId}`),
    );
    if (
      info.running_in_region !== "ENAM" ||
      info.name !== db.destinationName ||
      apiRecord(info.read_replication).mode !== "disabled"
    )
      throw new Error(
        "final destination metadata did not match ENAM requirements",
      );
  }
  const handoff = await verifyLiveWorkflowBindings(provider, manifest);
  manifest.records.finalHandoff = handoff;
  manifest.records.finalVersionId = liveVersion;
  commitDestinationConfiguration(manifest);
  await command(args, "regenerate-bindings", "npm", ["run", "types:api"]);
  await command(args, "final-config-checks", "npm", [
    "run",
    "check:tooling:core",
  ]);
  manifest.records.finalFingerprint = sourceFingerprint();
  manifest.phases.resume = new Date().toISOString();
  saveManifest(args.directory, manifest);
}

async function verifyLiveWorkflowBindings(
  provider: CloudflareProvider,
  manifest: MigrationManifest,
) {
  const allowed = new Map<string, Set<string>>();
  for (const variant of ["destination-maintenance", "destination-live"]) {
    for (const publication of array(
      manifest.records[`workflow-publications-${variant}`],
    )) {
      const name = field(publication, "name");
      const versions = allowed.get(name) || new Set<string>();
      versions.add(field(publication, "workflowVersionId"));
      allowed.set(name, versions);
    }
  }
  for (const publication of array(
    manifest.records.workflowPublicationHistory || [],
  )) {
    if (publication.confirmed !== true)
      throw new Error(
        "an acknowledged Workflow publication still requires reconciliation",
      );
    const workerId = field(publication, "workerVersionId");
    if (
      ![
        manifest.versions["destination-maintenance"],
        manifest.versions["destination-live"],
      ].includes(workerId)
    )
      throw new Error(
        "publication history contains an unverified Worker version",
      );
    const name = field(publication, "name");
    const versions = allowed.get(name) || new Set<string>();
    versions.add(field(publication, "workflowVersionId"));
    allowed.set(name, versions);
  }
  let current = 0;
  for (const [name, versions] of allowed) {
    for (const item of await provider.list(`workflows/${name}/instances`)) {
      if (["complete", "errored", "terminated"].includes(String(item.status)))
        continue;
      if (!versions.has(field(item, "version_id")))
        throw new Error(
          "an active Workflow still has unverified database bindings",
        );
      current++;
    }
  }
  for (const entry of manifest.workflows!.entries) {
    const detail = apiRecord(
      await provider.request(
        `workflows/mons-link-event-progress/instances/${entry.id}`,
      ),
    );
    if (
      entry.stage === "recreated" &&
      (detail.versionId !== manifest.workflows!.targetWorkflowVersionId ||
        canonicalJson(detail.params) !== canonicalJson(entry.params))
    )
      throw new Error("a handed-off Workflow changed identity or bindings");
    if (entry.stage === "recreated")
      assertRecreatedEventSleep(detail, entry.params);
    else if (
      entry.stage === "completed" &&
      canonicalJson(detail) !== canonicalJson(entry.completedDetail)
    )
      throw new Error("a completed Workflow history changed after handoff");
  }
  return { verifiedActiveInstances: current, oldDatabaseWriters: 0 };
}

export async function executeMigration(argv = process.argv.slice(2)) {
  const args = parseMigrationArguments(argv);
  const lock = openMigrationDirectory(args.directory);
  try {
    let manifest = loadManifest(args.directory);
    const accountId =
      manifest?.accountId ||
      field(readOperatorConfiguration(args.config), "account_id");
    const provider = createCloudflareProvider(accountId);
    if (args.phase === "preflight")
      manifest = await preflightMigration(args, provider);
    else {
      if (!manifest) throw new Error("run preflight first");
      if (
        args.phase !== "status" &&
        (args.phase === "prepare" || !manifest.phases[args.phase])
      ) {
        if (args.phase === "prepare")
          await prepareMigration(args, provider, manifest);
        else if (args.phase === "quiesce")
          await quiesceMigration(args, provider, manifest);
        else if (args.phase === "copy")
          await copyMigration(args, provider, manifest);
        else if (args.phase === "verify")
          await verifyMigration(args, provider, manifest);
        else if (args.phase === "cutover")
          await cutoverMigration(args, provider, manifest);
        else if (args.phase === "resume")
          await resumeMigration(args, provider, manifest);
      }
    }
    console.log(
      JSON.stringify({
        runId: manifest.runId,
        phase: args.phase,
        completed: manifest.phases,
        databases: manifest.databases.map((db) => ({
          binding: db.binding,
          sourceId: db.sourceId,
          destinationId: db.destinationId ?? null,
          destinationName: db.destinationName,
        })),
        waitingWorkflows: manifest.workflows?.entries.length,
      }),
    );
  } finally {
    lock.release();
  }
}
