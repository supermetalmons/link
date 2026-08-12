import type { SpawnSyncReturns } from "node:child_process";

const { resolve } = require("node:path");

export type SpawnResult = Pick<SpawnSyncReturns<Buffer>, "error" | "status">;
export type ProcessEnvironment = Record<string, string | undefined>;
export type CommandRuntime = {
  repoRoot: string;
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
};

class DeployError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "DeployError";
    this.exitCode = exitCode;
  }
}

function stripEnvironment(
  source: ProcessEnvironment,
  shouldStrip: (normalizedName: string) => boolean,
): ProcessEnvironment {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (shouldStrip(name.toUpperCase())) {
      delete environment[name];
    }
  }
  return environment;
}

function createWranglerEnvironment(
  source: ProcessEnvironment,
  logDirectory: string,
  options: { ci?: boolean } = {},
): ProcessEnvironment {
  return {
    ...source,
    ...(options.ci ? { CI: "true" } : {}),
    WRANGLER_LOG_PATH: logDirectory,
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_SEND_METRICS: "false",
  };
}

function readCloudflareApiToken({
  tokenFile,
  environment,
  readFile,
  includeReadError = false,
}: {
  tokenFile?: string;
  environment: ProcessEnvironment;
  readFile: (path: string, encoding: "utf8") => string;
  includeReadError?: boolean;
}): string {
  if (tokenFile) {
    let token: string;
    try {
      token = readFile(resolve(tokenFile), "utf8").trim();
    } catch (error) {
      if (includeReadError) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new DeployError(`Unable to read --token-file: ${detail}`);
      }
      throw new DeployError("Unable to read --token-file.");
    }
    if (!token) {
      throw new DeployError("The Cloudflare token file is empty.");
    }
    return token;
  }

  const token = (environment.CLOUDFLARE_API_TOKEN || "").trim();
  if (!token) {
    throw new DeployError(
      "Missing Cloudflare authentication. Pass --token-file or set CLOUDFLARE_API_TOKEN.",
    );
  }
  return token;
}

function runCommand(
  command: string,
  args: string[],
  environment: ProcessEnvironment,
  label: string,
  runtime: CommandRuntime,
  options: { includeSpawnError?: boolean } = {},
): void {
  const result = runtime.spawn(command, args, {
    cwd: runtime.repoRoot,
    env: environment,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    if (options.includeSpawnError) {
      throw new DeployError(
        `${label} could not start: ${result.error.message}`,
      );
    }
    throw new DeployError(`${label} could not start.`);
  }
  if (result.status !== 0) {
    const exitCode = result.status ?? 1;
    throw new DeployError(
      `${label} failed with exit code ${exitCode}.`,
      exitCode,
    );
  }
}

function findLatestJsonRecord(
  contents: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const line of contents.trim().split(/\r?\n/).reverse()) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (predicate(record)) {
        return record;
      }
    } catch {}
  }
  return undefined;
}

export type CloudflareRuntime = {
  DeployError: typeof DeployError;
  createWranglerEnvironment: typeof createWranglerEnvironment;
  findLatestJsonRecord: typeof findLatestJsonRecord;
  readCloudflareApiToken: typeof readCloudflareApiToken;
  runCommand: typeof runCommand;
  stripEnvironment: typeof stripEnvironment;
};

module.exports = {
  DeployError,
  createWranglerEnvironment,
  findLatestJsonRecord,
  readCloudflareApiToken,
  runCommand,
  stripEnvironment,
};
