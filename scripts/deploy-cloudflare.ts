const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

type DeployMode = "dry-run" | "preview" | "production";

type CliOptions = {
  mode: DeployMode;
  tokenFile?: string;
  versionId?: string;
};

const repoRoot = resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const npmBinary = isWindows ? "npm.cmd" : "npm";
const wranglerBinary = resolve(
  repoRoot,
  "node_modules",
  ".bin",
  isWindows ? "wrangler.cmd" : "wrangler",
);
function usage(): string {
  return [
    "Build and deploy the mons.link frontend with the pinned local Wrangler.",
    "",
    "Usage:",
    "  npm run deploy -- dry-run",
    "  npm run deploy -- preview --token-file /path/to/cloudflare-token",
    "  npm run deploy -- production --version-id <candidate-version-id> --token-file /path/to/cloudflare-token",
    "",
    "Authentication:",
    "  Pass --token-file, or set CLOUDFLARE_API_TOKEN in the shell.",
    "  The token is only provided to the Wrangler subprocess and is never printed.",
  ].join("\n");
}

function fail(message: string, exitCode = 1): never {
  console.error(`\n[deploy] ${message}\n`);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(usage());
    process.exit(0);
  }

  const mode = argv[0];
  if (mode !== "dry-run" && mode !== "preview" && mode !== "production") {
    fail(
      `Expected one deployment mode: dry-run, preview, or production.\n\n${usage()}`,
      2,
    );
  }

  let tokenFile: string | undefined;
  let versionId: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--token-file") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        fail("Missing value for --token-file.", 2);
      }
      tokenFile = value;
      continue;
    }
    if (arg === "--version-id") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        fail("Missing value for --version-id.", 2);
      }
      versionId = value;
      continue;
    }
    fail(`Unknown argument: ${arg}\n\n${usage()}`, 2);
  }

  if (mode === "production" && !versionId) {
    fail("Production requires --version-id for the tested candidate.", 2);
  }
  if (mode !== "production" && versionId) {
    fail("--version-id is only valid in production mode.", 2);
  }

  return { mode, tokenFile, versionId };
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    fail(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${label} failed with exit code ${result.status ?? 1}.`,
      result.status ?? 1,
    );
  }
}

function readApiToken(tokenFile?: string): string {
  if (tokenFile) {
    let value: string;
    try {
      value = readFileSync(resolve(tokenFile), "utf8").trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`Unable to read --token-file: ${detail}`);
    }
    if (!value) {
      fail("The Cloudflare token file is empty.");
    }
    return value;
  }

  const value = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  if (!value) {
    fail(
      "Missing Cloudflare authentication. Pass --token-file or set CLOUDFLARE_API_TOKEN.",
    );
  }
  return value;
}

function createBuildEnvironment(): NodeJS.ProcessEnv {
  const buildEnv = { ...process.env };

  for (const name of Object.keys(buildEnv)) {
    const normalizedName = name.toUpperCase();
    if (
      normalizedName.startsWith("VITE_") ||
      normalizedName.startsWith("CLOUDFLARE_") ||
      normalizedName.startsWith("WRANGLER_") ||
      normalizedName === "NODE_ENV"
    ) {
      delete buildEnv[name];
    }
  }

  for (const filename of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ]) {
    const envFile = resolve(repoRoot, filename);
    if (!existsSync(envFile)) {
      continue;
    }
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const name = line.match(
        /^\s*(?:export\s+)?(VITE_[A-Za-z0-9_.-]+)\s*=/i,
      )?.[1];
      if (name) {
        buildEnv[name] = "";
      }
    }
  }

  buildEnv.NODE_ENV = "production";
  buildEnv.VITE_MONS_FIREBASE_API_KEY = "";
  buildEnv.VITE_APPLE_CLIENT_ID = "";
  buildEnv.VITE_APP_TITLE = "";
  buildEnv.VITE_BUILD_DATETIME = String(Math.floor(Date.now() / 1000));
  return buildEnv;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
    fail(
      `Node 24 or newer is required; current version is ${process.versions.node}.`,
    );
  }
  if (!existsSync(wranglerBinary)) {
    fail("Pinned Wrangler binary not found. Run npm install first.");
  }

  const apiToken =
    opts.mode === "dry-run" ? undefined : readApiToken(opts.tokenFile);
  const buildEnv = createBuildEnvironment();

  console.log(`[deploy] Mode:  ${opts.mode}`);
  if (opts.mode === "production") {
    console.log(`[deploy] Version: ${opts.versionId}`);
  } else {
    console.log(
      "[deploy] Build: npm run build (isolated Vite production environment)",
    );
    run(npmBinary, ["run", "build"], buildEnv, "Frontend build");
  }

  const wranglerLogDirectory = resolve(repoRoot, ".cache", "wrangler-logs");
  mkdirSync(wranglerLogDirectory, { recursive: true });

  const wranglerEnv: NodeJS.ProcessEnv = {
    ...buildEnv,
    WRANGLER_LOG_PATH: wranglerLogDirectory,
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_SEND_METRICS: "false",
  };
  if (apiToken) {
    wranglerEnv.CLOUDFLARE_API_TOKEN = apiToken;
  }

  let wranglerArgs: string[];
  if (opts.mode === "dry-run") {
    wranglerArgs = ["deploy", "--dry-run", "--config", "wrangler.jsonc"];
  } else if (opts.mode === "preview") {
    wranglerArgs = ["versions", "upload", "--config", "wrangler.jsonc"];
  } else {
    const versionId = opts.versionId;
    if (!versionId) {
      fail("Production requires --version-id for the tested candidate.", 2);
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

  console.log(`[deploy] Wrangler: ${wranglerArgs.slice(0, 2).join(" ")}`);
  run(wranglerBinary, wranglerArgs, wranglerEnv, "Wrangler");
}

main();
