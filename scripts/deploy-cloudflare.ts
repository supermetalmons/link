import type {
  CloudflareRuntime,
  ProcessEnvironment,
  SpawnResult,
} from "./cloudflare/runtime.ts";

const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const {
  DeployError,
  createWranglerEnvironment,
  findLatestJsonRecord,
  readCloudflareApiToken,
  runCommand,
  stripEnvironment,
}: CloudflareRuntime = require("./cloudflare/runtime.ts");

type DeployMode = "dry-run" | "preview" | "production";

type CliOptions = {
  mode: DeployMode;
  tokenFile?: string;
  versionId?: string;
};

export type FrontendRuntimeDependencies = {
  repoRoot: string;
  nodeVersion: string;
  processEnv: ProcessEnvironment;
  pid: number;
  now: () => number;
  npmExecutable: string;
  wranglerExecutable: string;
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
  log: (message: string) => void;
};

function usage(): string {
  return [
    "Build and deploy the mons.link frontend with the pinned local Wrangler.",
    "",
    "Usage:",
    "  npm run deploy -- dry-run",
    "  npm run deploy -- preview --token-file /path/to/cloudflare-token",
    "  npm run deploy -- production",
    "  npm run deploy -- production --version-id <candidate-version-id> --token-file /path/to/cloudflare-token",
    "",
    "Authentication:",
    "  Pass --token-file, or set CLOUDFLARE_API_TOKEN in the shell.",
    "  The token is only provided to the Wrangler subprocess and is never printed.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("-h") || argv.includes("--help")) {
    throw new DeployError(usage(), 0);
  }

  const mode = argv[0];
  if (mode !== "dry-run" && mode !== "preview" && mode !== "production") {
    throw new DeployError(
      `Expected one deployment mode: dry-run, preview, or production.\n\n${usage()}`,
      2,
    );
  }

  let tokenFile: string | undefined;
  let versionId: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--token-file" || arg === "--version-id") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new DeployError(`Missing value for ${arg}.`, 2);
      }
      if (arg === "--token-file") {
        tokenFile = value;
      } else {
        versionId = value;
      }
      continue;
    }
    throw new DeployError(`Unknown argument: ${arg}\n\n${usage()}`, 2);
  }

  if (mode !== "production" && versionId) {
    throw new DeployError("--version-id is only valid in production mode.", 2);
  }

  return { mode, tokenFile, versionId };
}

function createBuildEnvironment(
  dependencies: FrontendRuntimeDependencies,
): ProcessEnvironment {
  const buildEnvironment = stripEnvironment(
    dependencies.processEnv,
    (normalizedName) =>
      normalizedName.startsWith("VITE_") ||
      normalizedName.startsWith("CLOUDFLARE_") ||
      normalizedName.startsWith("CF_") ||
      normalizedName.startsWith("WRANGLER_") ||
      normalizedName === "DOTENV_KEY" ||
      normalizedName === "NODE_ENV",
  );

  for (const filename of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    const envFile = resolve(dependencies.repoRoot, filename);
    if (!dependencies.exists(envFile)) {
      continue;
    }
    for (const line of dependencies.readFile(envFile, "utf8").split(/\r?\n/)) {
      const name = line.match(
        /^\s*(?:export\s+)?(VITE_[A-Za-z0-9_.-]+)\s*=/i,
      )?.[1];
      if (name) {
        buildEnvironment[name] = "";
      }
    }
  }

  buildEnvironment.NODE_ENV = "production";
  buildEnvironment.VITE_MONS_FIREBASE_API_KEY = "";
  buildEnvironment.VITE_APPLE_CLIENT_ID = "";
  buildEnvironment.VITE_APP_TITLE = "";
  buildEnvironment.VITE_BUILD_DATETIME = String(
    Math.floor(dependencies.now() / 1000),
  );
  return buildEnvironment;
}

function readUploadedVersionId(
  outputFile: string,
  dependencies: FrontendRuntimeDependencies,
): string {
  let contents: string;
  try {
    contents = dependencies.readFile(outputFile, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DeployError(
      `Unable to read the uploaded version metadata: ${detail}`,
    );
  }

  const upload = findLatestJsonRecord(
    contents,
    (entry) => entry.type === "version-upload",
  );
  if (typeof upload?.version_id === "string" && upload.version_id) {
    return upload.version_id;
  }
  throw new DeployError(
    "Wrangler did not report the ID of the newly uploaded version.",
  );
}

function createDefaultDependencies(): FrontendRuntimeDependencies {
  const repoRoot = resolve(__dirname, "..");
  const isWindows = process.platform === "win32";
  return {
    repoRoot,
    nodeVersion: process.versions.node,
    processEnv: process.env,
    pid: process.pid,
    now: Date.now,
    npmExecutable: isWindows ? "npm.cmd" : "npm",
    wranglerExecutable: resolve(
      repoRoot,
      "node_modules",
      ".bin",
      isWindows ? "wrangler.cmd" : "wrangler",
    ),
    spawn: spawnSync,
    exists: existsSync,
    mkdir: mkdirSync,
    readFile: readFileSync,
    log: console.log,
  };
}

function execute(
  argv: string[],
  dependencies: FrontendRuntimeDependencies = createDefaultDependencies(),
): void {
  const options = parseArgs(argv);
  const nodeMajor = Number.parseInt(dependencies.nodeVersion.split(".")[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
    throw new DeployError(
      `Node 24 or newer is required; current version is ${dependencies.nodeVersion}.`,
    );
  }
  if (!dependencies.exists(dependencies.wranglerExecutable)) {
    throw new DeployError(
      "Pinned Wrangler binary not found. Run npm install first.",
    );
  }

  const apiToken =
    options.mode === "dry-run"
      ? undefined
      : readCloudflareApiToken({
          tokenFile: options.tokenFile,
          environment: dependencies.processEnv,
          readFile: dependencies.readFile,
          includeReadError: true,
        });
  const buildEnvironment = createBuildEnvironment(dependencies);

  dependencies.log(`[deploy] Mode:  ${options.mode}`);
  if (options.mode === "production" && options.versionId) {
    dependencies.log(`[deploy] Version: ${options.versionId}`);
  } else {
    dependencies.log(
      "[deploy] Build: npm run build (isolated Vite production environment)",
    );
    runCommand(
      dependencies.npmExecutable,
      ["run", "build"],
      buildEnvironment,
      "Frontend build",
      dependencies,
      { includeSpawnError: true },
    );
  }

  const wranglerLogDirectory = resolve(
    dependencies.repoRoot,
    ".cache",
    "wrangler-logs",
  );
  dependencies.mkdir(wranglerLogDirectory, { recursive: true });

  const wranglerEnvironment = createWranglerEnvironment(
    buildEnvironment,
    wranglerLogDirectory,
  );
  if (apiToken) {
    wranglerEnvironment.CLOUDFLARE_API_TOKEN = apiToken;
  }

  let wranglerArgs: string[];
  if (options.mode === "dry-run") {
    wranglerArgs = ["deploy", "--dry-run", "--config", "wrangler.jsonc"];
  } else if (options.mode === "preview") {
    wranglerArgs = ["versions", "upload", "--config", "wrangler.jsonc"];
  } else {
    let versionId = options.versionId;
    if (!versionId) {
      const outputFile = resolve(
        wranglerLogDirectory,
        `production-${dependencies.pid}-${dependencies.now()}.json`,
      );
      wranglerEnvironment.WRANGLER_OUTPUT_FILE_PATH = outputFile;
      const uploadArgs = ["versions", "upload", "--config", "wrangler.jsonc"];
      dependencies.log(
        `[deploy] Wrangler: ${uploadArgs.slice(0, 2).join(" ")}`,
      );
      runCommand(
        dependencies.wranglerExecutable,
        uploadArgs,
        wranglerEnvironment,
        "Wrangler version upload",
        dependencies,
        { includeSpawnError: true },
      );
      versionId = readUploadedVersionId(outputFile, dependencies);
      dependencies.log(`[deploy] Version: ${versionId} (new)`);
    }
    wranglerArgs = [
      "versions",
      "deploy",
      "--version-id",
      versionId,
      "--percentage",
      "100",
      "--yes",
      "--config",
      "wrangler.jsonc",
    ];
  }

  dependencies.log(`[deploy] Wrangler: ${wranglerArgs.slice(0, 2).join(" ")}`);
  runCommand(
    dependencies.wranglerExecutable,
    wranglerArgs,
    wranglerEnvironment,
    "Wrangler",
    dependencies,
    { includeSpawnError: true },
  );
}

if (require.main === module) {
  try {
    execute(process.argv.slice(2));
  } catch (error) {
    const exitCode = error instanceof DeployError ? error.exitCode : 1;
    const message =
      error instanceof Error ? error.message : "Unexpected failure.";
    if (exitCode === 0) {
      console.log(message);
    } else {
      console.error(`\n[deploy] ${message}\n`);
    }
    process.exitCode = exitCode;
  }
}

module.exports = {
  createBuildEnvironment,
  execute,
  parseArgs,
  readUploadedVersionId,
};
