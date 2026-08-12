import type { FrontendRuntimeDependencies } from "./deploy-cloudflare.ts";

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  spawnSync,
}: typeof import("node:child_process") = require("node:child_process");
const { resolve }: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");

const {
  createBuildEnvironment,
  execute,
  parseArgs,
  readUploadedVersionId,
} = require("./deploy-cloudflare.ts");

type Command = {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
};

const REPOSITORY_ROOT = "/workspace";
const NPM_EXECUTABLE = "/runtime/npm";
const WRANGLER_EXECUTABLE = "/workspace/node_modules/.bin/wrangler";

function createDependencies(
  overrides: Partial<FrontendRuntimeDependencies> = {},
): FrontendRuntimeDependencies & {
  commands: Command[];
  logs: string[];
  directories: string[];
} {
  const commands: Command[] = [];
  const logs: string[] = [];
  const directories: string[] = [];
  return {
    repoRoot: REPOSITORY_ROOT,
    nodeVersion: "24.5.0",
    processEnv: { PATH: "/bin", CLOUDFLARE_API_TOKEN: "cloudflare-token" },
    pid: 42,
    now: () => 1_750_000_123_456,
    npmExecutable: NPM_EXECUTABLE,
    wranglerExecutable: WRANGLER_EXECUTABLE,
    spawn(command, args, options) {
      commands.push({ command, args: [...args], env: { ...options.env } });
      return { status: 0 };
    },
    exists: (path) => path === WRANGLER_EXECUTABLE,
    mkdir: (path) => {
      directories.push(path);
    },
    readFile: () => {
      throw new Error("Unexpected file read.");
    },
    log: (message) => {
      logs.push(message);
    },
    commands,
    logs,
    directories,
    ...overrides,
  };
}

function errorExitCode(error: unknown): number | undefined {
  return (error as { exitCode?: number }).exitCode;
}

test("parses every frontend deployment mode and rejects invalid combinations", () => {
  assert.deepEqual(parseArgs(["dry-run"]), {
    mode: "dry-run",
    tokenFile: undefined,
    versionId: undefined,
  });
  assert.deepEqual(parseArgs(["preview", "--token-file", "/tmp/token"]), {
    mode: "preview",
    tokenFile: "/tmp/token",
    versionId: undefined,
  });
  assert.deepEqual(parseArgs(["production", "--version-id", "version-1"]), {
    mode: "production",
    tokenFile: undefined,
    versionId: "version-1",
  });

  assert.throws(
    () => parseArgs([]),
    (error: unknown) =>
      errorExitCode(error) === 2 &&
      /Expected one deployment mode/.test(String(error)),
  );
  assert.throws(
    () => parseArgs(["preview", "--version-id", "version-1"]),
    /only valid in production mode/,
  );
  assert.throws(
    () => parseArgs(["production", "--token-file"]),
    (error: unknown) =>
      errorExitCode(error) === 2 && /Missing value/.test(String(error)),
  );
  assert.throws(
    () => parseArgs(["--help"]),
    (error: unknown) =>
      errorExitCode(error) === 0 &&
      /npm run deploy -- dry-run/.test(String(error)),
  );
});

test("direct help exits successfully and writes usage only to stdout", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      resolve(__dirname, "deploy-cloudflare.ts"),
      "--help",
    ],
    { encoding: "utf8", shell: false },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /npm run deploy -- dry-run/);
  assert.match(result.stdout, /npm run deploy -- production/);
});

test("direct invalid arguments retain exit code 2 and the deploy log prefix", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      resolve(__dirname, "deploy-cloudflare.ts"),
      "invalid-mode",
    ],
    { encoding: "utf8", shell: false },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\n\[deploy\] Expected one deployment mode:/);
});

test("isolates frontend builds from ambient and dotenv deployment values", () => {
  const envFiles = new Map([
    [resolve(REPOSITORY_ROOT, ".env"), "VITE_FROM_ENV=secret\nOTHER=kept"],
    [
      resolve(REPOSITORY_ROOT, ".env.production.local"),
      " export VITE_FROM_PRODUCTION = secret\nVITE_MIXED.Name=value",
    ],
  ]);
  const dependencies = createDependencies({
    processEnv: {
      PATH: "/bin",
      VITE_AMBIENT: "secret",
      vite_lowercase: "secret",
      CLOUDFLARE_API_TOKEN: "token",
      CF_API_TOKEN: "legacy-token",
      CF_API_KEY: "legacy-key",
      CF_EMAIL: "legacy-email",
      DOTENV_KEY: "dotenv-key",
      WRANGLER_LOG_PATH: "/tmp/logs",
      NODE_ENV: "development",
    },
    exists: (path) => path === WRANGLER_EXECUTABLE || envFiles.has(path),
    readFile: (path) => {
      const contents = envFiles.get(path);
      if (contents === undefined) {
        throw new Error(`Unexpected file read: ${path}`);
      }
      return contents;
    },
  });

  assert.deepEqual(createBuildEnvironment(dependencies), {
    PATH: "/bin",
    VITE_FROM_ENV: "",
    VITE_FROM_PRODUCTION: "",
    "VITE_MIXED.Name": "",
    NODE_ENV: "production",
    VITE_MONS_FIREBASE_API_KEY: "",
    VITE_APPLE_CLIENT_ID: "",
    VITE_APP_TITLE: "",
    VITE_BUILD_DATETIME: "1750000123",
  });
});

test("dry-run builds first and invokes the pinned Wrangler without authentication", () => {
  const dependencies = createDependencies({
    processEnv: {
      PATH: "/bin",
      CLOUDFLARE_API_TOKEN: "must-not-leak",
      WRANGLER_LOG_PATH: "/ambient/logs",
    },
  });

  execute(["dry-run"], dependencies);

  assert.deepEqual(
    dependencies.commands.map(({ command, args }) => ({ command, args })),
    [
      { command: NPM_EXECUTABLE, args: ["run", "build"] },
      {
        command: WRANGLER_EXECUTABLE,
        args: ["deploy", "--dry-run", "--config", "wrangler.jsonc"],
      },
    ],
  );
  assert.equal(dependencies.commands[0].env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(dependencies.commands[1].env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(
    dependencies.commands[1].env.WRANGLER_LOG_PATH,
    resolve(REPOSITORY_ROOT, ".cache/wrangler-logs"),
  );
  assert.equal(dependencies.commands[1].env.WRANGLER_LOG_SANITIZE, "true");
  assert.equal(dependencies.commands[1].env.WRANGLER_SEND_METRICS, "false");
  assert.deepEqual(dependencies.directories, [
    resolve(REPOSITORY_ROOT, ".cache/wrangler-logs"),
  ]);
  assert.equal(dependencies.logs.join("\n").includes("must-not-leak"), false);
});

test("preview reads a token file only for the Wrangler upload", () => {
  const tokenFile = "/secure/cloudflare-token";
  const dependencies = createDependencies({
    processEnv: { PATH: "/bin", CLOUDFLARE_API_TOKEN: "ambient-token" },
    readFile: (path) => {
      assert.equal(path, tokenFile);
      return " file-token \n";
    },
  });

  execute(["preview", "--token-file", tokenFile], dependencies);

  assert.equal(dependencies.commands.length, 2);
  assert.equal(dependencies.commands[0].env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(dependencies.commands[1].env.CLOUDFLARE_API_TOKEN, "file-token");
  assert.deepEqual(dependencies.commands[1].args, [
    "versions",
    "upload",
    "--config",
    "wrangler.jsonc",
  ]);
});

test("frontend token-file failures retain their local read detail", () => {
  const dependencies = createDependencies({
    readFile: () => {
      throw new Error("permission denied");
    },
  });

  assert.throws(
    () => execute(["preview", "--token-file", "/secure/token"], dependencies),
    /Unable to read --token-file: permission denied/,
  );
});

test("production can deploy an exact existing version without rebuilding", () => {
  const dependencies = createDependencies();

  execute(["production", "--version-id", "candidate-version"], dependencies);

  assert.equal(dependencies.commands.length, 1);
  assert.deepEqual(dependencies.commands[0].args, [
    "versions",
    "deploy",
    "--version-id",
    "candidate-version",
    "--percentage",
    "100",
    "--yes",
    "--config",
    "wrangler.jsonc",
  ]);
  assert.equal(
    dependencies.commands[0].env.CLOUDFLARE_API_TOKEN,
    "cloudflare-token",
  );
  assert.equal(
    dependencies.logs.includes("[deploy] Version: candidate-version"),
    true,
  );
});

test("production uploads, reads the latest metadata record, then deploys it", () => {
  const outputFile = resolve(
    REPOSITORY_ROOT,
    ".cache/wrangler-logs/production-42-1750000123456.json",
  );
  const metadataFiles = new Map([
    [
      outputFile,
      [
        "not json",
        JSON.stringify({ type: "version-upload", version_id: "older" }),
        JSON.stringify({ type: "message", version_id: "ignored" }),
        JSON.stringify({ type: "version-upload", version_id: "new-version" }),
      ].join("\n"),
    ],
  ]);
  const dependencies = createDependencies({
    readFile: (path) => {
      assert.equal(path, outputFile);
      return metadataFiles.get(path)!;
    },
  });

  execute(["production"], dependencies);

  assert.deepEqual(
    dependencies.commands.map(({ command, args }) => ({ command, args })),
    [
      { command: NPM_EXECUTABLE, args: ["run", "build"] },
      {
        command: WRANGLER_EXECUTABLE,
        args: ["versions", "upload", "--config", "wrangler.jsonc"],
      },
      {
        command: WRANGLER_EXECUTABLE,
        args: [
          "versions",
          "deploy",
          "--version-id",
          "new-version",
          "--percentage",
          "100",
          "--yes",
          "--config",
          "wrangler.jsonc",
        ],
      },
    ],
  );
  assert.equal(
    dependencies.commands[1].env.WRANGLER_OUTPUT_FILE_PATH,
    outputFile,
  );
  assert.equal(
    dependencies.commands[2].env.WRANGLER_OUTPUT_FILE_PATH,
    outputFile,
  );
  assert.equal(
    dependencies.logs.includes("[deploy] Version: new-version (new)"),
    true,
  );
  assert.equal(metadataFiles.has(outputFile), true);
});

test("preserves deployment validation and subprocess exit codes", () => {
  assert.throws(
    () => execute(["dry-run"], createDependencies({ nodeVersion: "23.9.0" })),
    /Node 24 or newer is required/,
  );
  assert.throws(
    () => execute(["dry-run"], createDependencies({ exists: () => false })),
    /Pinned Wrangler binary not found/,
  );
  assert.throws(
    () =>
      execute(
        ["preview"],
        createDependencies({ processEnv: { PATH: "/bin" } }),
      ),
    /Missing Cloudflare authentication/,
  );
  assert.throws(
    () =>
      execute(
        ["dry-run"],
        createDependencies({ spawn: () => ({ status: 17 }) }),
      ),
    (error: unknown) =>
      errorExitCode(error) === 17 &&
      /Frontend build failed/.test(String(error)),
  );
  assert.throws(
    () =>
      execute(
        ["dry-run"],
        createDependencies({
          spawn: () => ({ status: null, error: new Error("spawn detail") }),
        }),
      ),
    /Frontend build could not start: spawn detail/,
  );
});

test("rejects unreadable or incomplete upload metadata", () => {
  assert.throws(
    () =>
      readUploadedVersionId(
        "/tmp/output.json",
        createDependencies({
          readFile: () => {
            throw new Error("permission denied");
          },
        }),
      ),
    /Unable to read the uploaded version metadata: permission denied/,
  );
  assert.throws(
    () =>
      readUploadedVersionId(
        "/tmp/output.json",
        createDependencies({
          readFile: () => JSON.stringify({ type: "version-upload" }),
        }),
      ),
    /did not report the ID/,
  );
});
