import type {
  CloudflareRuntime,
  ProcessEnvironment,
  SpawnResult,
} from "./cloudflare/runtime.ts";

const { spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, unlinkSync } = require("node:fs");
const { resolve } = require("node:path");
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

const WORKER_NAME = "mons-link-api";
const API_CONFIG = "cloud/workers/api/wrangler.jsonc";
const WRANGLER_RELEASE_ENV_FILE = "cloud/workers/api/release.env";
const WRANGLER_CONFIG_ARGS = [
  "--config",
  API_CONFIG,
  "--env-file",
  WRANGLER_RELEASE_ENV_FILE,
];
const PRODUCTION_URL = "https://api.mons.link";
const SMOKE_ORIGIN = "https://mons.link";
const X_CALLBACK_PATH = "/auth/x/callback";
const AUTH_ROUTE_SMOKES = [
  { path: "/auth/intents", method: "POST" },
  { path: "/auth/methods", method: "GET" },
  { path: "/auth/x/flows", method: "POST" },
] as const;
const SMOKE_TIMEOUT_MS = 15_000;
const SMOKE_RETRY_DELAYS_MS = [500, 1_500];
const VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "Release the mons-link-api Worker or update its triggers.",
    "",
    "Usage:",
    "  npm run deploy:api -- preview --smoke-sol <wallet> [--secrets-file <path>] [--token-file <path>]",
    "  npm run deploy:api -- production --version-id <uuid> --smoke-sol <wallet> [--token-file <path>]",
    "  npm run deploy:api:triggers -- [--token-file <path>]",
    "",
    "Authentication:",
    "  Pass --token-file, or set CLOUDFLARE_API_TOKEN in the shell.",
    "  The token is provided only to Wrangler and is never printed.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("-h") || argv.includes("--help")) {
    throw new DeployError(usage(), 0);
  }

  const mode = argv[0];
  if (mode !== "preview" && mode !== "production" && mode !== "triggers") {
    throw new DeployError(
      `Expected one mode: preview, production, or triggers.\n\n${usage()}`,
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

  if (mode === "triggers") {
    if (smokeSol !== undefined) {
      throw new DeployError("--smoke-sol is not valid in triggers mode.", 2);
    }
    if (versionId !== undefined) {
      throw new DeployError("--version-id is not valid in triggers mode.", 2);
    }
    if (secretsFile !== undefined) {
      throw new DeployError("--secrets-file is not valid in triggers mode.", 2);
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
      normalized === "HELIUS_RPC_API_KEY" ||
      normalized === "X_CLIENT_ID" ||
      normalized === "X_CLIENT_SECRET" ||
      normalized === "FIRESTORE_SERVICE_ACCOUNT_EMAIL" ||
      normalized === "FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY" ||
      normalized === "DOTENV_KEY",
  );
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

  for (const authRoute of AUTH_ROUTE_SMOKES) {
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
    run(
      dependencies.nodeExecutable,
      [wranglerCliPath, "triggers", "deploy", ...WRANGLER_CONFIG_ARGS],
      wranglerEnvironment,
      "Wrangler trigger deployment",
      dependencies,
    );
    dependencies.log("[api-deploy] Worker triggers applied.");
    return;
  }

  if (options.mode === "preview") {
    const secretsFile = options.secretsFile
      ? resolve(options.secretsFile)
      : undefined;
    if (secretsFile && !dependencies.exists(secretsFile)) {
      throw new DeployError("Unable to read --secrets-file.");
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
      ...WRANGLER_CONFIG_ARGS,
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
      try {
        dependencies.unlink(outputFile);
      } catch {}
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
      ...WRANGLER_CONFIG_ARGS,
    ],
    wranglerEnvironment,
    "Wrangler version promotion",
    dependencies,
  );

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
