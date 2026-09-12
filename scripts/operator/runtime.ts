import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_API_CONFIG, resolveD1Coordinates } from "./configuration.ts";

type JsonRecord = Record<string, unknown>;

const PROFILE_DATABASE = "mons-link-profiles";

const ROOT = resolve(import.meta.dirname, "../..");

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const VERSION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function canonicalJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    )
      return entry;
    if (typeof entry === "number") {
      if (
        !Number.isFinite(entry) ||
        (Number.isInteger(entry) && !Number.isSafeInteger(entry))
      ) {
        throw new Error("unsafe-json-number");
      }
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(visit);
    const object = record(entry);
    if (!object) throw new Error("invalid-json-value");
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, visit(object[key])]),
    );
  };
  return JSON.stringify(visit(value));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("invalid JSON input; private contents were not logged");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function privateDirectory(directory: string): string {
  const path = resolve(directory);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700, recursive: true });
  const stat = lstatSync(path);
  const real = realpathSync(path);
  const fromRoot = relative(realpathSync(ROOT), real);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.uid !== process.getuid?.() ||
    (fromRoot !== ".." && !fromRoot.startsWith("../"))
  ) {
    throw new Error(
      "artifact directory must be owned by this user, mode 0700, outside the repository, and not a symlink",
    );
  }
  return real;
}

function readPrivateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size > MAX_FILE_BYTES
    ) {
      throw new Error(
        "artifact must be a private regular file no larger than 64 MiB",
      );
    }
    if (stat.nlink === 2) {
      const directory = privateDirectory(dirname(path));
      for (const name of readdirSync(directory)) {
        if (
          !name.startsWith(".partial-") ||
          !VERSION_PATTERN.test(name.slice(9))
        )
          continue;
        const partial = resolve(directory, name);
        if (name === basename(path)) continue;
        const linked = lstatSync(partial, { throwIfNoEntry: false });
        if (
          linked?.isFile() &&
          linked.dev === stat.dev &&
          linked.ino === stat.ino
        ) {
          rmSync(partial, { force: true });
          break;
        }
      }
    }
    if (fstatSync(fd).nlink !== 1)
      throw new Error("artifact must not have unrelated hard links");
    const value = parseJson(readFileSync(fd, "utf8"));
    canonicalJson(value);
    return value;
  } finally {
    closeSync(fd);
  }
}

function writePrivateImmutable(path: string, value: unknown): void {
  const data = canonicalJson(value) + "\n";
  if (Buffer.byteLength(data) > MAX_FILE_BYTES)
    throw new Error("artifact exceeds the 64 MiB limit");
  if (existsSync(path)) {
    if (canonicalJson(readPrivateJson(path)) !== canonicalJson(value))
      throw new Error("immutable artifact conflict");
    return;
  }
  const temporary = resolve(dirname(path), `.partial-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (
        !existsSync(path) ||
        canonicalJson(readPrivateJson(path)) !== canonicalJson(value)
      )
        throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

type SqlBinding = string | number | null;

type SqlRunner = (
  sql: string,
  database?: string,
  bindings?: SqlBinding[],
) => Promise<JsonRecord[]>;

function parseD1Results(response: unknown): JsonRecord[] {
  if (!Array.isArray(response) || response.length === 0)
    throw new Error("invalid D1 query response");
  return response.flatMap((entry) => {
    const result = record(entry);
    if (!result || result.success === false || !Array.isArray(result.results))
      throw new Error("D1 query was not confirmed");
    return result.results.map((value: unknown) => {
      const row = record(value);
      if (!row) throw new Error("invalid D1 query result row");
      if (Object.hasOwn(row, "Total queries executed"))
        throw new Error("D1 bulk import summary cannot verify query results");
      return row;
    });
  });
}

function createWranglerRunner({
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  fetcher = fetch,
  configPath = DEFAULT_API_CONFIG,
}: {
  apiToken?: string;
  fetcher?: typeof fetch;
  configPath?: string;
} = {}): SqlRunner {
  return async (sql, database = PROFILE_DATABASE, bindings = []) => {
    if (bindings.length > 100 || Buffer.byteLength(sql) > 90 * 1024)
      throw new Error("D1 query exceeds the bounded SQL or parameter limit");
    const { accountId, databaseId, binding } = resolveD1Coordinates(
      database,
      configPath,
    );
    if (apiToken) {
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sql, params: bindings }),
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        },
      );
      const payload = record(await readResponseJson(response));
      if (!payload || payload.success !== true)
        throw new Error("D1 query failed; inspect operator status");
      return parseD1Results(payload.result);
    }
    if (bindings.length > 0 || !sql.trimStart().startsWith("SELECT "))
      throw new Error(
        "set CLOUDFLARE_API_TOKEN for parameterized operations; private values must not enter command arguments",
      );
    const directory = mkdtempSync(resolve(tmpdir(), "mons-operator-sql-"));
    try {
      const result = spawnSync(
        resolve(ROOT, "node_modules/.bin/wrangler"),
        [
          "d1",
          "execute",
          binding,
          "--remote",
          "--command",
          sql,
          "--json",
          "--config",
          configPath,
          "--env-file",
          "cloud/workers/api/release.env",
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          maxBuffer: MAX_FILE_BYTES,
          shell: false,
          env: {
            ...process.env,
            WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"),
            WRANGLER_SEND_METRICS: "false",
          },
        },
      );
      if (result.status !== 0)
        throw new Error(
          "D1 operation failed; keep maintenance controls frozen and retry after inspecting state",
        );
      return parseD1Results(parseJson(result.stdout));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

async function readResponseJson(
  response: Response,
  maximumBytes = MAX_FILE_BYTES,
): Promise<unknown> {
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("Content-Length")) > maximumBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      "remote query or authentication failed; no credential or response body was logged",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes)
        throw new Error("remote response exceeds the permitted byte limit");
      chunks.push(value);
    }
    const parsed = parseJson(Buffer.concat(chunks).toString("utf8"));
    canonicalJson(parsed);
    return parsed;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function resolveCloudflareToken(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const directory = privateDirectory(
    mkdtempSync(resolve(tmpdir(), "mons-operator-auth-")),
  );
  try {
    const result = spawnSync(
      resolve(ROOT, "node_modules/.bin/wrangler"),
      ["auth", "token", "--json"],
      {
        cwd: ROOT,
        encoding: "utf8",
        shell: false,
        timeout: 60_000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: resolve(directory, "wrangler.log"),
        },
      },
    );
    if (result.status !== 0)
      throw new Error(
        "Cloudflare authentication unavailable; use the existing Wrangler login or CLOUDFLARE_API_TOKEN",
      );
    let credentials: JsonRecord | null;
    try {
      credentials = record(JSON.parse(result.stdout));
    } catch {
      throw new Error(
        "Cloudflare credential response was invalid; contents were not logged",
      );
    }
    if (
      !["oauth", "api_token"].includes(String(credentials?.type)) ||
      typeof credentials?.token !== "string" ||
      !credentials.token
    )
      throw new Error("operator requires an OAuth or API bearer token");
    return credentials.token;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export {
  canonicalJson,
  digest,
  privateDirectory,
  readPrivateJson,
  writePrivateImmutable,
  createWranglerRunner,
  readResponseJson,
  resolveCloudflareToken,
  type SqlRunner,
};
