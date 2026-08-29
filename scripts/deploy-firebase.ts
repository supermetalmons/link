const {
  spawnSync,
}: typeof import("node:child_process") = require("node:child_process");
const { resolve }: typeof import("node:path") = require("node:path");

type Options = {
  dryRun: boolean;
  project: string;
};

type Dependencies = {
  cloudDirectory: string;
  log(message: string): void;
  spawn(
    command: string,
    args: readonly string[],
    options: import("node:child_process").SpawnSyncOptions,
  ): { status: number | null } | undefined;
};

function usage(): string {
  return "Usage: npm run deploy:firebase -- --project <project-id> [--dry-run]";
}

function parseArgs(argv: string[]): Options {
  let dryRun = false;
  let project = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      if (dryRun) throw new TypeError(usage());
      dryRun = true;
      continue;
    }
    if (arg === "--project") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--") || project) {
        throw new TypeError(usage());
      }
      project = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      if (project) throw new TypeError(usage());
      project = arg.slice("--project=".length);
      if (!project) throw new TypeError(usage());
      continue;
    }
    throw new TypeError(usage());
  }
  if (!project) throw new TypeError(usage());
  return { dryRun, project };
}

function deployFirebase(
  options: Options,
  dependencies: Dependencies = {
    cloudDirectory: resolve(__dirname, "..", "cloud"),
    log: console.log,
    spawn: spawnSync,
  },
): void {
  const args = ["deploy", "--only", "database", "--project", options.project];
  dependencies.log(`[firebase] firebase ${args.join(" ")}`);
  if (options.dryRun) return;
  const result = dependencies.spawn("firebase", args, {
    cwd: dependencies.cloudDirectory,
    stdio: "inherit",
  });
  if (!result || result.status !== 0) {
    throw new Error("Firebase database deployment failed.");
  }
}

function main(argv = process.argv.slice(2)): void {
  deployFirebase(parseArgs(argv));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : usage());
    process.exitCode = 1;
  }
}

module.exports = { deployFirebase, main, parseArgs };
