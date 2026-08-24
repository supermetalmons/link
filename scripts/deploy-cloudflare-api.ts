import type {
  CloudflareRuntime,
  ProcessEnvironment,
  SpawnResult,
} from "./cloudflare/runtime.ts";

const { spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { resolve } = require("node:path");
const typescript: typeof import("typescript") = require("typescript");
const {
  isExactNftApiResponse,
  NFT_RESPONSE_ARRAY_KEYS,
}: typeof import("@mons/shared/nfts") = require("@mons/shared/nfts");
const {
  isValidSolanaAddress,
}: typeof import("@mons/shared/solana") = require("@mons/shared/solana");
const {
  DeployError,
  createWranglerEnvironment,
  findLatestJsonRecord,
  readCloudflareApiToken,
  runCommand,
  stripEnvironment,
}: CloudflareRuntime = require("./cloudflare/runtime.ts");

type CliOptions =
  | {
      mode: "preview";
      smokeSol: string;
      secretsFile?: string;
      tokenFile?: string;
      versionId?: undefined;
    }
  | {
      mode: "production";
      smokeSol: string;
      tokenFile?: string;
      versionId: string;
      secretsFile?: undefined;
    }
  | {
      mode: "triggers";
      secretsFile?: undefined;
      tokenFile?: string;
    }
  | {
      mode: "consumer";
      secretsFile?: undefined;
      tokenFile?: string;
    };

export type RuntimeDependencies = {
  repoRoot: string;
  nodeExecutable: string;
  nodeVersion: string;
  processEnv: ProcessEnvironment;
  pid: number;
  now: () => number;
  spawn: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: ProcessEnvironment;
      stdio: "inherit";
      shell: false;
    },
  ) => SpawnResult;
  exists: (path: string) => boolean;
  mkdir: (path: string, options: { recursive: true }) => void;
  readFile: (path: string, encoding: "utf8") => string;
  unlink: (path: string) => void;
  writeFile: (
    path: string,
    contents: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number },
  ) => void;
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  createSmokeState?: () => string;
  log: (message: string) => void;
};

type UploadMetadata = {
  versionId: string;
  previewUrl: string;
};

type SmokeFetchResult = {
  response: Response;
  bodyText?: string;
};

type AuthKillSwitchValue = "false" | "true";
type AuthKillSwitchName = (typeof AUTH_KILL_SWITCH_NAMES)[number];
type AuthKillSwitches = Record<AuthKillSwitchName, AuthKillSwitchValue>;
type WranglerConfig = Record<string, unknown>;
type AuthRecoveryConsumerBody = {
  dead_letter_queue: string;
  script_name: string;
  settings: {
    batch_size: number;
    max_concurrency: number;
    max_retries: number;
    max_wait_time_ms: number;
    retry_delay: number;
  };
  type: "worker";
};

const WORKER_NAME = "mons-link-api";
const AUTH_RECOVERY_QUEUE = "mons-link-auth-recovery";
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_API_RESPONSE_MAX_BYTES = 256 * 1024;
const CLOUDFLARE_API_TIMEOUT_MS = 15_000;
const AUTH_KILL_SWITCH_NAMES = [
  "AUTH_DISABLE_APPLE_VERIFY",
  "AUTH_DISABLE_X_VERIFY",
  "AUTH_DISABLE_UNLINK",
  "AUTH_DISABLE_MERGE",
] as const;
const DOTENV_LINE_PATTERN =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
const API_CONFIG = "cloud/workers/api/wrangler.jsonc";
const WRANGLER_RELEASE_ENV_FILE = "cloud/workers/api/release.env";
const PRODUCTION_URL = "https://api.mons.link";
const SMOKE_ORIGIN = "https://mons.link";
const X_CALLBACK_PATH = "/auth/x/callback";
const TELEGRAM_BRIDGE_PATH = "/internal/telegram/delivery";
const EVENT_PRIZE_ANNOUNCEMENT_PATH =
  "/internal/telegram/event-prize-announcement";
const AUTHENTICATED_ROUTE_SMOKES = [
  { path: "/auth/intents", method: "POST" },
  { path: "/auth/methods", method: "GET" },
  { path: "/auth/methods/apple/verify", method: "POST" },
  { path: "/auth/methods/eth/verify", method: "POST" },
  { path: "/auth/methods/sol/verify", method: "POST" },
  { path: "/auth/methods/unlink", method: "POST" },
  { path: "/auth/profile-claim/sync", method: "POST" },
  { path: "/auth/x/flows", method: "POST" },
  { path: "/auth/x/flows/complete", method: "POST" },
  { path: "/automatch/cancel", method: "POST" },
  { path: "/automatch/start", method: "POST" },
  { path: "/events/participants/join", method: "POST" },
  { path: "/events/participants/remove", method: "POST" },
  { path: "/leaderboards/read", method: "POST" },
  { path: "/matches/timer/claim", method: "POST" },
  { path: "/matches/timer/start", method: "POST" },
  { path: "/mining/rock", method: "POST" },
  { path: "/navigation/games/remove", method: "POST" },
  { path: "/profiles/lookup", method: "POST" },
  { path: "/profiles/username", method: "POST" },
  { path: "/ratings/update", method: "POST" },
  { path: "/wagers/proposals/accept", method: "POST" },
  { path: "/wagers/proposals/cancel", method: "POST" },
  { path: "/wagers/proposals/decline", method: "POST" },
  { path: "/wagers/proposals/send", method: "POST" },
  { path: "/wagers/outcomes/resolve", method: "POST" },
] as const;
const SMOKE_TIMEOUT_MS = 15_000;
const SMOKE_RETRY_DELAYS_MS = [500, 1_500, 5_000, 10_000, 15_000];
const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "Release the mons-link-api Worker, update its triggers, or reconcile its recovery consumer.",
    "",
    "Usage:",
    "  npm run deploy:api -- preview --smoke-sol <wallet> [--secrets-file <path>] [--token-file <path>]",
    "  npm run deploy:api -- production --version-id <uuid> --smoke-sol <wallet> [--token-file <path>]",
    "  npm run deploy:api:triggers -- [--token-file <path>]",
    "  npm run deploy:api -- consumer [--token-file <path>]",
    "",
    "Authentication:",
    "  Pass --token-file, or set CLOUDFLARE_API_TOKEN in the shell.",
    "  The token is provided only to Wrangler and is never printed.",
    "",
    "Preview inputs:",
    "  Explicitly set all four AUTH_DISABLE_* variables to true or false.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("-h") || argv.includes("--help")) {
    throw new DeployError(usage(), 0);
  }

  const mode = argv[0];
  if (
    mode !== "preview" &&
    mode !== "production" &&
    mode !== "triggers" &&
    mode !== "consumer"
  ) {
    throw new DeployError(
      `Expected one mode: preview, production, triggers, or consumer.\n\n${usage()}`,
      2,
    );
  }

  let smokeSol: string | undefined;
  let secretsFile: string | undefined;
  let tokenFile: string | undefined;
  let versionId: string | undefined;

  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (
      arg === "--smoke-sol" ||
      arg === "--secrets-file" ||
      arg === "--token-file" ||
      arg === "--version-id"
    ) {
      if (!value || value.startsWith("--")) {
        throw new DeployError(`Missing value for ${arg}.`, 2);
      }
      index++;
      if (arg === "--smoke-sol") {
        smokeSol = value.trim();
      } else if (arg === "--secrets-file") {
        secretsFile = value;
      } else if (arg === "--token-file") {
        tokenFile = value;
      } else {
        versionId = value.trim();
      }
      continue;
    }

    throw new DeployError(`Unknown argument: ${arg}\n\n${usage()}`, 2);
  }

  if (mode === "triggers" || mode === "consumer") {
    if (smokeSol !== undefined) {
      throw new DeployError(`--smoke-sol is not valid in ${mode} mode.`, 2);
    }
    if (versionId !== undefined) {
      throw new DeployError(`--version-id is not valid in ${mode} mode.`, 2);
    }
    if (secretsFile !== undefined) {
      throw new DeployError(`--secrets-file is not valid in ${mode} mode.`, 2);
    }
    return { mode, tokenFile };
  }

  if (!smokeSol) {
    throw new DeployError("--smoke-sol is required.", 2);
  }
  if (!isValidSolanaAddress(smokeSol)) {
    throw new DeployError(
      "--smoke-sol must be a valid 32-byte Solana address.",
      2,
    );
  }
  if (mode === "preview" && versionId) {
    throw new DeployError("--version-id is only valid in production mode.", 2);
  }
  if (mode === "production" && !versionId) {
    throw new DeployError(
      "Production mode requires the exact smoke-tested --version-id.",
      2,
    );
  }
  if (mode === "production" && secretsFile) {
    throw new DeployError("--secrets-file is only valid in preview mode.", 2);
  }
  if (versionId && !VERSION_ID_PATTERN.test(versionId)) {
    throw new DeployError("--version-id must be a UUID.", 2);
  }

  if (mode === "preview") {
    return {
      mode,
      smokeSol,
      secretsFile,
      tokenFile,
      versionId: undefined,
    };
  }
  return { mode, smokeSol, tokenFile, versionId: versionId as string };
}

function createChildEnvironment(
  source: ProcessEnvironment,
): ProcessEnvironment {
  return stripEnvironment(
    source,
    (normalized) =>
      normalized.startsWith("CLOUDFLARE_") ||
      normalized.startsWith("CF_") ||
      normalized.startsWith("WRANGLER_") ||
      normalized.startsWith("TELEGRAM_") ||
      normalized.startsWith("AUTH_DISABLE_") ||
      normalized === "HELIUS_RPC_API_KEY" ||
      normalized === "X_CLIENT_ID" ||
      normalized === "X_CLIENT_SECRET" ||
      normalized === "FIRESTORE_SERVICE_ACCOUNT_EMAIL" ||
      normalized === "FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY" ||
      normalized === "GAMEPLAY_SERVICE_ACCOUNT_EMAIL" ||
      normalized === "GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY" ||
      normalized === "RATING_SERVICE_ACCOUNT_EMAIL" ||
      normalized === "RATING_SERVICE_ACCOUNT_PRIVATE_KEY" ||
      normalized === "FIREBASE_RTDB_URL" ||
      normalized === "DOTENV_KEY",
  );
}

function readAuthKillSwitches(source: ProcessEnvironment): AuthKillSwitches {
  const entries = AUTH_KILL_SWITCH_NAMES.map((name) => {
    const value = source[name]?.trim();
    if (value !== "true" && value !== "false") {
      throw new DeployError(
        `${name} must be explicitly set to true or false for preview uploads.`,
        2,
      );
    }
    return [name, value] as const;
  });
  return Object.fromEntries(entries) as AuthKillSwitches;
}

function wranglerConfigArgs(configPath: string): string[] {
  return ["--config", configPath, "--env-file", WRANGLER_RELEASE_ENV_FILE];
}

function readTrackedWranglerConfig(
  dependencies: RuntimeDependencies,
): WranglerConfig {
  const sourcePath = resolve(dependencies.repoRoot, API_CONFIG);
  const parsed = typescript.parseConfigFileTextToJson(
    sourcePath,
    dependencies.readFile(sourcePath, "utf8"),
  );
  if (parsed.error || !parsed.config || typeof parsed.config !== "object") {
    throw new DeployError("Unable to parse the API Wrangler configuration.");
  }
  return parsed.config as WranglerConfig;
}

function getAuthRecoveryConsumer(config: WranglerConfig): WranglerConfig {
  const queues = config.queues;
  if (!queues || typeof queues !== "object" || Array.isArray(queues)) {
    throw new DeployError("API Wrangler Queue configuration is invalid.");
  }
  const consumers = (queues as WranglerConfig).consumers;
  if (!Array.isArray(consumers)) {
    throw new DeployError("API Wrangler Queue consumers are invalid.");
  }
  const authConsumers = consumers.filter(
    (consumer): consumer is WranglerConfig =>
      !!consumer &&
      typeof consumer === "object" &&
      !Array.isArray(consumer) &&
      (consumer as WranglerConfig).queue === AUTH_RECOVERY_QUEUE,
  );
  if (authConsumers.length !== 1) {
    throw new DeployError(
      "API Wrangler configuration must contain one auth recovery consumer.",
    );
  }
  return authConsumers[0];
}

function writeTemporaryWranglerConfig(
  config: WranglerConfig,
  dependencies: RuntimeDependencies,
): string {
  const temporaryPath = resolve(
    dependencies.repoRoot,
    "cloud",
    "workers",
    "api",
    `.wrangler-release-${dependencies.pid}-${dependencies.now()}.json`,
  );
  dependencies.writeFile(
    temporaryPath,
    `${JSON.stringify(config, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
  return temporaryPath;
}

function createTemporaryReleaseConfig(
  authKillSwitches: AuthKillSwitches | undefined,
  dependencies: RuntimeDependencies,
): string {
  const config = readTrackedWranglerConfig(dependencies);
  const authConsumer = getAuthRecoveryConsumer(config);

  const vars = config.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    throw new DeployError("API Wrangler variables are invalid.");
  }
  for (const name of AUTH_KILL_SWITCH_NAMES) {
    const current = (vars as Record<string, unknown>)[name];
    if (current !== "true" && current !== "false") {
      throw new DeployError(`Tracked ${name} must be true or false.`);
    }
    if (authKillSwitches) {
      (vars as Record<string, unknown>)[name] = authKillSwitches[name];
    }
  }

  const queues = config.queues as WranglerConfig;
  queues.consumers = (queues.consumers as unknown[]).filter(
    (consumer) => consumer !== authConsumer,
  );
  return writeTemporaryWranglerConfig(config, dependencies);
}

function readSecretsFileKeys(contents: string): string[] {
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (parsed && typeof parsed === "object") {
      return Object.keys(parsed);
    }
    return [];
  } catch {}

  const keys: string[] = [];
  DOTENV_LINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DOTENV_LINE_PATTERN.exec(contents))) {
    keys.push(match[1]);
  }
  return keys;
}

function validateSecretsFile(
  secretsFile: string,
  dependencies: RuntimeDependencies,
): void {
  let contents: string;
  try {
    contents = dependencies.readFile(secretsFile, "utf8");
  } catch {
    throw new DeployError("Unable to read --secrets-file.");
  }
  if (
    readSecretsFileKeys(contents).some((name) =>
      name.startsWith("AUTH_DISABLE_"),
    )
  ) {
    throw new DeployError(
      "--secrets-file must not define AUTH_DISABLE_* variables; set reviewed kill switches in the shell.",
      2,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readTrackedConsumerInteger(
  consumer: WranglerConfig,
  name: string,
  minimum: number,
): number {
  const value = consumer[name];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new DeployError("Auth recovery consumer configuration is invalid.");
  }
  return value;
}

function readAuthRecoveryConsumerRequest(dependencies: RuntimeDependencies): {
  accountId: string;
  body: AuthRecoveryConsumerBody;
} {
  const config = readTrackedWranglerConfig(dependencies);
  if (
    config.name !== WORKER_NAME ||
    typeof config.account_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(config.account_id)
  ) {
    throw new DeployError("API Wrangler identity configuration is invalid.");
  }
  const consumer = getAuthRecoveryConsumer(config);
  const batchTimeout = readTrackedConsumerInteger(
    consumer,
    "max_batch_timeout",
    0,
  );
  const maxWaitTime = batchTimeout * 1_000;
  const deadLetterQueue = consumer.dead_letter_queue;
  if (
    !Number.isSafeInteger(maxWaitTime) ||
    typeof deadLetterQueue !== "string" ||
    !deadLetterQueue.trim()
  ) {
    throw new DeployError("Auth recovery consumer configuration is invalid.");
  }
  return {
    accountId: config.account_id,
    body: {
      type: "worker",
      script_name: WORKER_NAME,
      dead_letter_queue: deadLetterQueue,
      settings: {
        batch_size: readTrackedConsumerInteger(consumer, "max_batch_size", 1),
        max_retries: readTrackedConsumerInteger(consumer, "max_retries", 0),
        max_wait_time_ms: maxWaitTime,
        max_concurrency: readTrackedConsumerInteger(
          consumer,
          "max_concurrency",
          1,
        ),
        retry_delay: readTrackedConsumerInteger(consumer, "retry_delay", 0),
      },
    },
  };
}

async function readBoundedCloudflareResponse(
  response: Response,
  label: string,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > CLOUDFLARE_API_RESPONSE_MAX_BYTES
  ) {
    await discardResponseBody(response);
    throw new DeployError(`${label} returned an oversized response.`);
  }
  if (!response.body) {
    throw new DeployError(`${label} returned an invalid response.`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > CLOUDFLARE_API_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DeployError(`${label} returned an oversized response.`);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof DeployError) {
      throw error;
    }
    throw new DeployError(`${label} returned an unreadable response.`);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new DeployError(`${label} returned an invalid response.`);
  }
}

async function requestCloudflareApi(
  url: URL,
  init: { body?: string; method: "GET" | "POST" | "PUT" },
  apiToken: string,
  label: string,
  dependencies: RuntimeDependencies,
): Promise<unknown> {
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      method: init.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
    });
  } catch {
    throw new DeployError(`${label} request failed.`);
  }
  if (!response.ok) {
    await discardResponseBody(response);
    throw new DeployError(`${label} returned HTTP ${response.status}.`);
  }
  const envelope = await readBoundedCloudflareResponse(response, label);
  if (
    !isRecord(envelope) ||
    envelope.success !== true ||
    !("result" in envelope)
  ) {
    throw new DeployError(`${label} returned an invalid response.`);
  }
  return envelope.result;
}

function readCloudflareIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new DeployError(`${label} returned an invalid response.`);
  }
  return value;
}

async function reconcileAuthRecoveryConsumer(
  apiToken: string,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const { accountId, body } = readAuthRecoveryConsumerRequest(dependencies);
  const queuesUrl = new URL(
    `${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}/queues`,
  );
  queuesUrl.searchParams.set("name", AUTH_RECOVERY_QUEUE);
  queuesUrl.searchParams.set("page", "1");
  const queueResult = await requestCloudflareApi(
    queuesUrl,
    { method: "GET" },
    apiToken,
    "Cloudflare Queue lookup",
    dependencies,
  );
  if (!Array.isArray(queueResult) || queueResult.length > 100) {
    throw new DeployError(
      "Cloudflare Queue lookup returned an invalid response.",
    );
  }
  const matchingQueues = queueResult.filter(
    (queue): queue is WranglerConfig =>
      isRecord(queue) && queue.queue_name === AUTH_RECOVERY_QUEUE,
  );
  if (matchingQueues.length !== 1) {
    throw new DeployError(
      "Cloudflare Queue lookup returned an invalid response.",
    );
  }

  const queue = matchingQueues[0];
  const queueId = readCloudflareIdentifier(
    queue.queue_id,
    "Cloudflare Queue lookup",
  );
  if (!Array.isArray(queue.consumers) || queue.consumers.length > 100) {
    throw new DeployError(
      "Cloudflare Queue lookup returned an invalid response.",
    );
  }
  const matchingConsumers = queue.consumers.filter(
    (consumer): consumer is WranglerConfig =>
      isRecord(consumer) &&
      consumer.type === "worker" &&
      (consumer.script === WORKER_NAME || consumer.service === WORKER_NAME),
  );
  if (matchingConsumers.length > 1) {
    throw new DeployError(
      "Cloudflare Queue lookup returned an invalid response.",
    );
  }

  const consumerId = matchingConsumers[0]
    ? readCloudflareIdentifier(
        matchingConsumers[0].consumer_id,
        "Cloudflare Queue lookup",
      )
    : undefined;
  const consumerUrl = new URL(
    `${CLOUDFLARE_API_BASE_URL}/accounts/${accountId}/queues/${queueId}/consumers${consumerId ? `/${consumerId}` : ""}`,
  );
  const result = await requestCloudflareApi(
    consumerUrl,
    { method: consumerId ? "PUT" : "POST", body: JSON.stringify(body) },
    apiToken,
    "Cloudflare Queue consumer update",
    dependencies,
  );
  if (!isRecord(result)) {
    throw new DeployError(
      "Cloudflare Queue consumer update returned an invalid response.",
    );
  }
  const returnedConsumerId = readCloudflareIdentifier(
    result.consumer_id,
    "Cloudflare Queue consumer update",
  );
  if (consumerId && returnedConsumerId !== consumerId) {
    throw new DeployError(
      "Cloudflare Queue consumer update returned an invalid response.",
    );
  }
}

function removeTemporaryFile(
  path: string,
  dependencies: RuntimeDependencies,
): void {
  try {
    dependencies.unlink(path);
  } catch {}
}

function readApiToken(
  tokenFile: string | undefined,
  dependencies: RuntimeDependencies,
): string {
  return readCloudflareApiToken({
    tokenFile,
    environment: dependencies.processEnv,
    readFile: dependencies.readFile,
  });
}

function run(
  command: string,
  args: string[],
  environment: ProcessEnvironment,
  label: string,
  dependencies: RuntimeDependencies,
): void {
  runCommand(command, args, environment, label, dependencies);
}

function parseUploadMetadata(contents: string): UploadMetadata {
  const upload = findLatestJsonRecord(
    contents,
    (entry) => entry.type === "version-upload",
  );

  if (!upload) {
    throw new DeployError(
      "Wrangler did not report an uploaded Worker version.",
    );
  }
  if (upload.worker_name !== WORKER_NAME) {
    throw new DeployError("Wrangler reported an unexpected Worker name.");
  }
  if (
    typeof upload.version_id !== "string" ||
    !VERSION_ID_PATTERN.test(upload.version_id)
  ) {
    throw new DeployError("Wrangler reported an invalid Worker version ID.");
  }
  if (typeof upload.preview_url !== "string") {
    throw new DeployError("Wrangler did not report a version preview URL.");
  }

  let previewUrl: URL;
  try {
    previewUrl = new URL(upload.preview_url);
  } catch {
    throw new DeployError("Wrangler reported an invalid version preview URL.");
  }
  if (
    previewUrl.protocol !== "https:" ||
    previewUrl.username ||
    previewUrl.password ||
    previewUrl.port ||
    !previewUrl.hostname.endsWith(".workers.dev") ||
    !previewUrl.hostname.includes(`-${WORKER_NAME}.`)
  ) {
    throw new DeployError(
      "Wrangler reported an unexpected version preview URL.",
    );
  }

  return {
    versionId: upload.version_id,
    previewUrl: previewUrl.origin,
  };
}

function readUploadMetadata(
  outputFile: string,
  dependencies: RuntimeDependencies,
): UploadMetadata {
  let contents: string;
  try {
    contents = dependencies.readFile(outputFile, "utf8");
  } catch {
    throw new DeployError("Unable to read Wrangler upload metadata.");
  }
  return parseUploadMetadata(contents);
}

function parseNftResponse(text: string, requireEmpty: boolean): void {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DeployError("NFT API smoke response was not valid JSON.");
  }

  if (!isExactNftApiResponse(value)) {
    throw new DeployError("NFT API smoke response had an unexpected shape.");
  }

  for (const key of NFT_RESPONSE_ARRAY_KEYS) {
    if (requireEmpty && value[key].length !== 0) {
      throw new DeployError("NFT API smoke response had invalid NFT arrays.");
    }
  }
}

function parseUnauthenticatedResponse(text: string): void {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new DeployError("Auth route smoke response was not valid JSON.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { ok?: unknown }).ok !== false ||
    (value as { error?: unknown }).error !== "unauthenticated" ||
    typeof (value as { message?: unknown }).message !== "string"
  ) {
    throw new DeployError("Auth route smoke response had an unexpected shape.");
  }
}

function parseTelegramBridgeUnauthorizedResponse(text: string): void {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new DeployError("Telegram bridge smoke response was not valid JSON.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { ok?: unknown }).ok !== false ||
    (value as { error?: unknown }).error !== "unauthenticated"
  ) {
    throw new DeployError(
      "Telegram bridge smoke response had an unexpected shape.",
    );
  }
}

function assertNoStore(response: Response): void {
  const cacheControl = response.headers.get("cache-control") || "";
  if (
    !cacheControl
      .toLowerCase()
      .split(",")
      .some((part) => part.trim() === "no-store")
  ) {
    throw new DeployError(
      "Smoke response was missing Cache-Control: no-store.",
    );
  }
}

function assertXCallbackHeaders(response: Response): void {
  assertNoStore(response);
  if (response.headers.get("pragma") !== "no-cache") {
    throw new DeployError("X callback smoke response was missing Pragma.");
  }
  if (response.headers.get("expires") !== "0") {
    throw new DeployError(
      "X callback smoke response had an unexpected expiry.",
    );
  }
  if (response.headers.get("referrer-policy") !== "no-referrer") {
    throw new DeployError(
      "X callback smoke response had an unexpected referrer policy.",
    );
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    throw new DeployError(
      "X callback smoke response was missing nosniff protection.",
    );
  }
  if (response.headers.has("location")) {
    throw new DeployError("X callback smoke response redirected unexpectedly.");
  }
}

function assertJsonResponse(response: Response): void {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new DeployError("NFT API smoke response was not JSON.");
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 404 || status === 502 || status === 504;
}

async function discardResponseBody(response: Response | undefined) {
  if (response?.body) {
    await response.body.cancel().catch(() => undefined);
  }
}

async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, "redirect" | "signal">,
  label: string,
  dependencies: RuntimeDependencies,
  bodyStatus?: number,
): Promise<SmokeFetchResult> {
  for (let attempt = 0; attempt <= SMOKE_RETRY_DELAYS_MS.length; attempt++) {
    let response: Response | undefined;
    try {
      response = await dependencies.fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
      });

      if (shouldRetryStatus(response.status)) {
        if (attempt === SMOKE_RETRY_DELAYS_MS.length) {
          await discardResponseBody(response);
          return { response };
        }
      } else if (bodyStatus !== undefined && response.status === bodyStatus) {
        return { response, bodyText: await response.text() };
      } else {
        await discardResponseBody(response);
        return { response };
      }
    } catch {
      await discardResponseBody(response);
      if (attempt === SMOKE_RETRY_DELAYS_MS.length) {
        throw new DeployError(`${label} failed after bounded retries.`);
      }
      await dependencies.sleep(SMOKE_RETRY_DELAYS_MS[attempt]);
      continue;
    }

    await discardResponseBody(response);
    await dependencies.sleep(SMOKE_RETRY_DELAYS_MS[attempt]);
  }

  throw new DeployError(`${label} failed after bounded retries.`);
}

async function smokeApi(
  baseUrl: string,
  smokeSol: string,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const endpoint = new URL("/nfts", baseUrl).toString();
  const { response: preflight } = await fetchWithRetry(
    endpoint,
    {
      method: "OPTIONS",
      headers: {
        Origin: SMOKE_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    },
    "CORS preflight smoke request",
    dependencies,
  );
  if (preflight.status !== 204) {
    throw new DeployError(
      `CORS preflight smoke request returned ${preflight.status}.`,
    );
  }
  assertNoStore(preflight);
  if (preflight.headers.get("access-control-allow-origin") !== "*") {
    throw new DeployError(
      "CORS preflight smoke response had an unexpected origin policy.",
    );
  }
  const methods = (preflight.headers.get("access-control-allow-methods") || "")
    .split(",")
    .map((method) => method.trim().toUpperCase());
  if (!methods.includes("POST") || !methods.includes("OPTIONS")) {
    throw new DeployError(
      "CORS preflight smoke response had unexpected methods.",
    );
  }
  const allowedHeaders = (
    preflight.headers.get("access-control-allow-headers") || ""
  )
    .split(",")
    .map((header) => header.trim().toLowerCase());
  if (!allowedHeaders.includes("content-type")) {
    throw new DeployError(
      "CORS preflight smoke response did not allow Content-Type.",
    );
  }

  const smokePost = async (
    sol: string,
    label: string,
    requireEmpty: boolean,
  ): Promise<void> => {
    const { response, bodyText } = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: SMOKE_ORIGIN,
        },
        body: JSON.stringify({ sol, eth: "" }),
      },
      label,
      dependencies,
      200,
    );
    if (response.status !== 200) {
      throw new DeployError(`${label} returned ${response.status}.`);
    }
    assertNoStore(response);
    assertJsonResponse(response);
    if (response.headers.get("access-control-allow-origin") !== "*") {
      throw new DeployError(`${label} had an unexpected CORS origin policy.`);
    }
    if (bodyText === undefined) {
      throw new DeployError(`${label} response body was unavailable.`);
    }
    parseNftResponse(bodyText, requireEmpty);
  };

  await smokePost("", "Empty-wallet smoke request", true);
  await smokePost(smokeSol, "Provider-backed smoke request", false);

  for (const authRoute of AUTHENTICATED_ROUTE_SMOKES) {
    const authEndpoint = new URL(authRoute.path, baseUrl).toString();
    const label = `${authRoute.method} ${authRoute.path}`;
    const { response: authPreflight } = await fetchWithRetry(
      authEndpoint,
      {
        method: "OPTIONS",
        headers: {
          Origin: SMOKE_ORIGIN,
          "Access-Control-Request-Method": authRoute.method,
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      },
      `${label} preflight smoke request`,
      dependencies,
    );
    if (authPreflight.status !== 204) {
      throw new DeployError(
        `${label} preflight smoke request returned ${authPreflight.status}.`,
      );
    }
    assertNoStore(authPreflight);
    if (
      authPreflight.headers.get("access-control-allow-origin") !== SMOKE_ORIGIN
    ) {
      throw new DeployError(`${label} had an unexpected CORS origin policy.`);
    }
    const authAllowedHeaders = (
      authPreflight.headers.get("access-control-allow-headers") || ""
    )
      .split(",")
      .map((header) => header.trim().toLowerCase());
    if (
      !authAllowedHeaders.includes("authorization") ||
      !authAllowedHeaders.includes("content-type")
    ) {
      throw new DeployError(`${label} preflight omitted required headers.`);
    }

    const { response: unauthenticated, bodyText } = await fetchWithRetry(
      authEndpoint,
      {
        method: authRoute.method,
        headers: {
          Origin: SMOKE_ORIGIN,
          ...(authRoute.method === "POST"
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(authRoute.method === "POST" ? { body: JSON.stringify({}) } : {}),
      },
      `${label} unauthenticated smoke request`,
      dependencies,
      401,
    );
    if (unauthenticated.status !== 401) {
      throw new DeployError(
        `${label} unauthenticated smoke request returned ${unauthenticated.status}.`,
      );
    }
    assertNoStore(unauthenticated);
    assertJsonResponse(unauthenticated);
    if (
      unauthenticated.headers.get("access-control-allow-origin") !==
      SMOKE_ORIGIN
    ) {
      throw new DeployError(`${label} had an unexpected CORS origin policy.`);
    }
    if (bodyText === undefined) {
      throw new DeployError(`${label} response body was unavailable.`);
    }
    parseUnauthenticatedResponse(bodyText);
  }

  for (const internalRoute of [
    {
      path: TELEGRAM_BRIDGE_PATH,
      label: "Telegram delivery bridge",
    },
    {
      path: EVENT_PRIZE_ANNOUNCEMENT_PATH,
      label: "Event prize announcement bridge",
    },
  ]) {
    const endpoint = new URL(internalRoute.path, baseUrl).toString();
    const { response, bodyText } = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      `Unsigned ${internalRoute.label} smoke request`,
      dependencies,
      401,
    );
    if (response.status !== 401) {
      throw new DeployError(
        `Unsigned ${internalRoute.label} smoke request returned ${response.status}.`,
      );
    }
    assertNoStore(response);
    assertJsonResponse(response);
    if (bodyText === undefined) {
      throw new DeployError(
        `Unsigned ${internalRoute.label} smoke response body was unavailable.`,
      );
    }
    parseTelegramBridgeUnauthorizedResponse(bodyText);
  }

  const callbackEndpoint = new URL(X_CALLBACK_PATH, baseUrl);
  const { response: missingState } = await fetchWithRetry(
    callbackEndpoint.toString(),
    { method: "GET" },
    "Missing-state X callback smoke request",
    dependencies,
  );
  if (missingState.status !== 400) {
    throw new DeployError(
      `Missing-state X callback smoke request returned ${missingState.status}.`,
    );
  }
  assertXCallbackHeaders(missingState);

  const smokeState =
    dependencies.createSmokeState?.() || randomBytes(18).toString("base64url");
  if (!/^[A-Za-z0-9_-]{24}$/.test(smokeState)) {
    throw new DeployError("Generated X callback smoke state was invalid.");
  }
  callbackEndpoint.searchParams.set("state", smokeState);
  const { response: unknownState } = await fetchWithRetry(
    callbackEndpoint.toString(),
    { method: "GET" },
    "Unknown-state X callback smoke request",
    dependencies,
  );
  if (unknownState.status !== 400) {
    throw new DeployError(
      `Unknown-state X callback smoke request returned ${unknownState.status}.`,
    );
  }
  assertXCallbackHeaders(unknownState);
}

function createDefaultDependencies(): RuntimeDependencies {
  return {
    repoRoot: resolve(__dirname, ".."),
    nodeExecutable: process.execPath,
    nodeVersion: process.versions.node,
    processEnv: process.env,
    pid: process.pid,
    now: Date.now,
    spawn: spawnSync,
    exists: existsSync,
    mkdir: mkdirSync,
    readFile: readFileSync,
    unlink: unlinkSync,
    writeFile: writeFileSync,
    fetch,
    sleep: (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    createSmokeState: () => randomBytes(18).toString("base64url"),
    log: console.log,
  };
}

async function execute(
  argv: string[],
  dependencies: RuntimeDependencies = createDefaultDependencies(),
): Promise<void> {
  const options = parseArgs(argv);
  const nodeMajor = Number.parseInt(dependencies.nodeVersion.split(".")[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
    throw new DeployError(
      `Node 24 or newer is required; current version is ${dependencies.nodeVersion}.`,
    );
  }

  const npmExecPath = dependencies.processEnv.npm_execpath?.trim();
  if (!npmExecPath) {
    throw new DeployError(
      "npm execution path was unavailable. Run this command through npm run deploy:api.",
    );
  }
  const npmCliPath = resolve(dependencies.repoRoot, npmExecPath);
  if (!dependencies.exists(npmCliPath)) {
    throw new DeployError(
      "npm execution path was not found. Run this command through npm run deploy:api.",
    );
  }

  const wranglerCliPath = resolve(
    dependencies.repoRoot,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  if (!dependencies.exists(wranglerCliPath)) {
    throw new DeployError(
      "Pinned Wrangler CLI not found. Run npm install first.",
    );
  }

  const apiToken = readApiToken(options.tokenFile, dependencies);
  const childEnvironment = createChildEnvironment(dependencies.processEnv);
  const logDirectory = resolve(
    dependencies.repoRoot,
    ".cache",
    "wrangler-logs",
  );
  dependencies.mkdir(logDirectory, { recursive: true });

  const wranglerEnvironment = createWranglerEnvironment(
    childEnvironment,
    logDirectory,
    { ci: true },
  );

  dependencies.log(`[api-deploy] Mode: ${options.mode}`);

  if (options.mode === "triggers") {
    wranglerEnvironment.CLOUDFLARE_API_TOKEN = apiToken;
    dependencies.log("[api-deploy] Applying reviewed Worker triggers.");
    const releaseConfig = createTemporaryReleaseConfig(undefined, dependencies);
    try {
      run(
        dependencies.nodeExecutable,
        [
          wranglerCliPath,
          "triggers",
          "deploy",
          ...wranglerConfigArgs(releaseConfig),
        ],
        wranglerEnvironment,
        "Wrangler trigger deployment",
        dependencies,
      );
    } finally {
      removeTemporaryFile(releaseConfig, dependencies);
    }
    dependencies.log("[api-deploy] Worker triggers applied.");
    return;
  }

  if (options.mode === "consumer") {
    dependencies.log("[api-deploy] Reconciling auth recovery consumer.");
    await reconcileAuthRecoveryConsumer(apiToken, dependencies);
    dependencies.log("[api-deploy] Auth recovery consumer reconciled.");
    return;
  }

  if (options.mode === "preview") {
    const authKillSwitches = readAuthKillSwitches(dependencies.processEnv);
    dependencies.log(
      `[api-deploy] Auth kill switches: ${AUTH_KILL_SWITCH_NAMES.map(
        (name) => `${name}=${authKillSwitches[name]}`,
      ).join(" ")}`,
    );
    const secretsFile = options.secretsFile
      ? resolve(options.secretsFile)
      : undefined;
    if (secretsFile) {
      validateSecretsFile(secretsFile, dependencies);
    }
    dependencies.log("[api-deploy] Running complete API validation.");
    run(
      dependencies.nodeExecutable,
      [npmCliPath, "run", "check:api"],
      wranglerEnvironment,
      "API validation",
      dependencies,
    );
    run(
      dependencies.nodeExecutable,
      [npmCliPath, "run", "check:tooling"],
      wranglerEnvironment,
      "Deployment tooling validation",
      dependencies,
    );

    const releaseConfig = createTemporaryReleaseConfig(
      authKillSwitches,
      dependencies,
    );
    const outputFile = resolve(
      logDirectory,
      `api-upload-${dependencies.pid}-${dependencies.now()}.json`,
    );
    wranglerEnvironment.WRANGLER_OUTPUT_FILE_PATH = outputFile;
    wranglerEnvironment.CLOUDFLARE_API_TOKEN = apiToken;
    const uploadArgs = [
      "versions",
      "upload",
      "--strict",
      ...wranglerConfigArgs(releaseConfig),
      ...(secretsFile ? ["--secrets-file", secretsFile] : []),
    ];
    dependencies.log("[api-deploy] Uploading an undeployed candidate version.");
    let metadata: UploadMetadata;
    try {
      run(
        dependencies.nodeExecutable,
        [wranglerCliPath, ...uploadArgs],
        wranglerEnvironment,
        "Wrangler version upload",
        dependencies,
      );
      metadata = readUploadMetadata(outputFile, dependencies);
    } finally {
      removeTemporaryFile(outputFile, dependencies);
      removeTemporaryFile(releaseConfig, dependencies);
    }

    dependencies.log(`[api-deploy] Version: ${metadata.versionId}`);
    dependencies.log(`[api-deploy] Preview: ${metadata.previewUrl}`);
    await smokeApi(metadata.previewUrl, options.smokeSol, dependencies);
    dependencies.log("[api-deploy] Preview smoke checks passed.");
    return;
  }

  const versionId = options.versionId;
  wranglerEnvironment.CLOUDFLARE_API_TOKEN = apiToken;
  dependencies.log(`[api-deploy] Version: ${versionId}`);
  const releaseConfig = createTemporaryReleaseConfig(undefined, dependencies);
  try {
    run(
      dependencies.nodeExecutable,
      [
        wranglerCliPath,
        "versions",
        "deploy",
        "--version-id",
        versionId,
        "--percentage",
        "100",
        "--yes",
        ...wranglerConfigArgs(releaseConfig),
      ],
      wranglerEnvironment,
      "Wrangler version promotion",
      dependencies,
    );
  } finally {
    removeTemporaryFile(releaseConfig, dependencies);
  }

  try {
    await smokeApi(PRODUCTION_URL, options.smokeSol, dependencies);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Unknown smoke-test failure.";
    throw new DeployError(
      `Production deployment completed, but production smoke checks failed: ${detail}`,
    );
  }
  dependencies.log("[api-deploy] Production smoke checks passed.");
}

if (require.main === module) {
  execute(process.argv.slice(2)).catch((error: unknown) => {
    const exitCode = error instanceof DeployError ? error.exitCode : 1;
    const message =
      error instanceof Error ? error.message : "Unexpected failure.";
    if (exitCode === 0) {
      console.log(message);
    } else {
      console.error(`\n[api-deploy] ${message}\n`);
    }
    process.exitCode = exitCode;
  });
}

module.exports = {
  createChildEnvironment,
  execute,
  parseArgs,
  parseNftResponse,
  parseUploadMetadata,
  smokeApi,
};
