import { createHash, createSign, randomUUID } from "node:crypto";
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type JsonRecord = Record<string, unknown>;

const PROJECT_ID = "mons-link";

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

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
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

function readPrivateJson(path: string, allowReadOnly = false): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      ((stat.mode & 0o777) !== 0o600 &&
        !(allowReadOnly && (stat.mode & 0o777) === 0o400)) ||
      stat.uid !== process.getuid?.() ||
      stat.size > MAX_FILE_BYTES
    ) {
      throw new Error(
        "artifact must be a private regular file no larger than 64 MiB",
      );
    }
    if (!allowReadOnly && stat.nlink === 2) {
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
}: { apiToken?: string; fetcher?: typeof fetch } = {}): SqlRunner {
  return async (sql, database = PROFILE_DATABASE, bindings = []) => {
    if (bindings.length > 100 || Buffer.byteLength(sql) > 90 * 1024)
      throw new Error("D1 query exceeds the bounded SQL or parameter limit");
    if (apiToken) {
      const require = createRequire(import.meta.url);
      const typescript = require("typescript") as typeof import("typescript");
      const configPath = resolve(ROOT, "cloud/workers/api/wrangler.jsonc");
      const parsed = typescript.parseConfigFileTextToJson(
        configPath,
        readFileSync(configPath, "utf8"),
      );
      const config = record(parsed.config);
      const accountId = config?.account_id;
      const databases = config?.d1_databases;
      const entry = Array.isArray(databases)
        ? databases.map(record).find((item) => item?.database_name === database)
        : null;
      const databaseId = entry?.database_id;
      if (
        parsed.error ||
        typeof accountId !== "string" ||
        !/^[a-f0-9]{32}$/.test(accountId) ||
        typeof databaseId !== "string" ||
        !VERSION_PATTERN.test(databaseId)
      )
        throw new Error("invalid tracked D1 account or database configuration");
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
          database,
          "--remote",
          "--command",
          sql,
          "--json",
          "--config",
          "cloud/workers/api/wrangler.jsonc",
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

function createFirebaseTokenProvider(
  credentialsPath?: string,
): () => Promise<string> {
  let cached: { value: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const body = new URLSearchParams();
    if (credentialsPath) {
      const credentials = record(readPrivateJson(credentialsPath, true));
      if (
        !credentials ||
        credentials.type !== "service_account" ||
        typeof credentials.client_email !== "string" ||
        typeof credentials.private_key !== "string" ||
        credentials.project_id !== PROJECT_ID
      )
        throw new Error(
          "expected a private mons-link service-account credential file",
        );
      const issuedAt = Math.floor(Date.now() / 1000);
      const encoded = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const message = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({ iss: credentials.client_email, scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email", aud: "https://oauth2.googleapis.com/token", iat: issuedAt, exp: issuedAt + 3600 })}`;
      const signature = createSign("RSA-SHA256")
        .update(message)
        .sign(credentials.private_key, "base64url");
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
      body.set("assertion", `${message}.${signature}`);
    } else {
      const require = createRequire(import.meta.url);
      const auth = require("firebase-tools/lib/auth.js") as {
        getProjectDefaultAccount(path: string):
          | {
              tokens?: {
                refresh_token?: string;
                access_token?: string;
                expires_at?: number;
              };
            }
          | undefined;
      };
      const api = require("firebase-tools/lib/api.js") as {
        clientId(): string;
        clientSecret(): string;
      };
      const account = auth.getProjectDefaultAccount(resolve(ROOT, "cloud"));
      const tokens = account?.tokens;
      if (
        tokens?.access_token &&
        typeof tokens.expires_at === "number" &&
        tokens.expires_at > Date.now() + 60_000
      ) {
        cached = { value: tokens.access_token, expiresAt: tokens.expires_at };
        return cached.value;
      }
      if (!tokens?.refresh_token)
        throw new Error(
          "Firebase authentication unavailable; run firebase login locally or provide --firebase-credentials",
        );
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", tokens.refresh_token);
      body.set("client_id", api.clientId());
      body.set("client_secret", api.clientSecret());
    }
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const token = record(await readResponseJson(response, 64 * 1024));
    if (
      !token ||
      typeof token.access_token !== "string" ||
      !integer(token.expires_in) ||
      token.expires_in < 1
    )
      throw new Error("invalid Firebase access-token response");
    cached = {
      value: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    return cached.value;
  };
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
  createFirebaseTokenProvider,
  resolveCloudflareToken,
  type SqlRunner,
};
