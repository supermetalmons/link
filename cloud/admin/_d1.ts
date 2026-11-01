import { isEmojiId } from "../runtime/shared/appearance.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

const CONFIG_PATH = resolve(
  import.meta.dirname,
  "../workers/api/wrangler.jsonc",
);
export const DATABASE_BINDING = "PROFILE_DB";
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const ADDRESS_PAGE_SIZE = 500;
const MAX_ADDRESS_PAGES = 10_000;

export type D1Coordinates = { accountId: string; databaseId: string };
export type D1Value = null | number | string;
export type D1Row = Record<string, D1Value>;
export type D1Query = (
  sql: string,
  params?: readonly D1Value[],
) => Promise<D1Row[]>;
export type ProfileAddress = { method: "eth" | "sol"; value: string };
export type LeaderboardMetric = "gp" | "mp";
type LeaderboardProfile = {
  id: string;
  emoji: number;
  username?: string | null;
  eth?: string | null;
  sol?: string | null;
};
export type GpLeaderboardProfile = LeaderboardProfile & {
  nonce: number | null;
};
export type MpLeaderboardProfile = LeaderboardProfile & {
  totalManaPoints?: number;
};
export type ProfileD1Reader = {
  listAddresses(): Promise<ProfileAddress[]>;
  readLeaderboard(metric: "gp", limit: number): Promise<GpLeaderboardProfile[]>;
  readLeaderboard(metric: "mp", limit: number): Promise<MpLeaderboardProfile[]>;
  readLeaderboard(
    metric: LeaderboardMetric,
    limit: number,
  ): Promise<Array<GpLeaderboardProfile | MpLeaderboardProfile>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseConfig(configPath = CONFIG_PATH): D1Coordinates {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(readFileSync(configPath, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw new Error("Invalid Cloudflare Worker configuration.");
  }
  const config = isRecord(parsed) ? parsed : null;
  const accountId = config?.account_id;
  const databases: unknown[] = Array.isArray(config?.d1_databases)
    ? config.d1_databases.filter(
        (entry: unknown) =>
          isRecord(entry) && entry.binding === DATABASE_BINDING,
      )
    : [];
  const database: unknown = databases[0];
  const databaseId = isRecord(database) ? database.database_id : undefined;
  if (
    databases.length !== 1 ||
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    typeof databaseId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(databaseId)
  ) {
    throw new Error("Missing canonical profile D1 coordinates.");
  }
  return { accountId, databaseId };
}

export function cloudflareToken(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = (environment.CLOUDFLARE_API_TOKEN || "").trim();
  if (!configured) {
    throw new Error(
      "Missing CLOUDFLARE_API_TOKEN scoped to D1 Read for canonical profile admin tools.",
    );
  }
  return configured;
}

export async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Oversized Cloudflare D1 response.");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Oversized Cloudflare D1 response.");
    }
    text += decoder.decode(value, { stream: true });
  }
}

export function parseD1Rows(value: unknown): D1Row[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid Cloudflare D1 response.");
  }
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error("Invalid Cloudflare D1 response.");
    const row: D1Row = {};
    for (const [key, column] of Object.entries(entry)) {
      if (
        column !== null &&
        typeof column !== "string" &&
        (typeof column !== "number" || !Number.isFinite(column))
      ) {
        throw new Error("Invalid Cloudflare D1 response.");
      }
      Object.defineProperty(row, key, {
        value: column,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return row;
  });
}

export function createD1Query({
  fetcher = fetch,
  token,
  coordinates,
  configPath,
}: {
  fetcher?: typeof fetch;
  token?: string;
  coordinates?: D1Coordinates;
  configPath?: string;
} = {}): D1Query {
  const { accountId, databaseId } = coordinates || parseConfig(configPath);
  const bearer = token || cloudflareToken();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return async (sql, params = []) => {
    if (!isReadOnlySql(sql)) {
      throw new Error("Admin D1 adapter permits read-only queries only.");
    }
    const response = await fetcher(url, {
      body: JSON.stringify({ sql, params }),
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    let payload: unknown;
    try {
      payload = JSON.parse(await boundedText(response));
    } catch (error) {
      if (error instanceof Error && error.message.includes("Cloudflare D1")) {
        throw error;
      }
      throw new Error("Invalid Cloudflare D1 response.");
    }
    const root = isRecord(payload) ? payload : null;
    const results: unknown[] | null = Array.isArray(root?.result)
      ? root.result
      : null;
    const result = results?.[0];
    if (
      !response.ok ||
      root?.success !== true ||
      results?.length !== 1 ||
      !isRecord(result) ||
      result.success !== true
    ) {
      throw new Error("Cloudflare D1 query failed.");
    }
    return parseD1Rows(result.results);
  };
}

export function isReadOnlySql(sql: unknown): sql is string {
  if (typeof sql !== "string") {
    return false;
  }
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!statement || statement.includes(";")) {
    return false;
  }
  return (
    /^SELECT\b/i.test(statement) ||
    /^EXPLAIN\s+QUERY\s+PLAN\s+SELECT\b/i.test(statement)
  );
}

export function parseGameplayEmoji(value: unknown): number {
  if (!isEmojiId(value)) throw new Error("Invalid canonical gameplay emoji.");
  return value;
}

type OptionalValue<Value> =
  { present: false } | { present: true; value: Value };

function parseOptionalJsonText(
  value: unknown,
  type: unknown,
): OptionalValue<string | null> {
  if (type === null || type === undefined) {
    return { present: false };
  }
  if (type === "null" && value === null) {
    return { present: true, value: null };
  }
  if (type === "text" && typeof value === "string") {
    return { present: true, value };
  }
  throw new Error("Invalid canonical leaderboard row.");
}

function parseOptionalJsonNumber(
  value: unknown,
  type: unknown,
): OptionalValue<number> {
  if (type === null || type === undefined) {
    return { present: false };
  }
  if (
    (type === "integer" || type === "real") &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return { present: true, value };
  }
  throw new Error("Invalid canonical leaderboard row.");
}

export function createProfileD1Reader({
  query = createD1Query(),
}: { query?: D1Query } = {}): ProfileD1Reader {
  let ready: Promise<void> | undefined;
  const requireReady = async () => {
    ready ||= query(
      `SELECT state
       FROM profile_canonical_control
       WHERE singleton = 1`,
    ).then((rows) => {
      const state = rows[0]?.state;
      if (rows.length !== 1 || (state !== "active" && state !== "frozen")) {
        throw new Error("Canonical profile D1 is unavailable.");
      }
    });
    return ready;
  };
  async function listAddresses(): Promise<ProfileAddress[]> {
    await requireReady();
    const addresses: ProfileAddress[] = [];
    let cursorMethod = "";
    let cursorValue = "";
    for (let page = 0; page < MAX_ADDRESS_PAGES; page += 1) {
      const rows = await query(
        `SELECT method, normalized_value, raw_value
           FROM profile_auth_methods_canonical
           WHERE method IN ('eth', 'sol')
             AND (
               method > ?
               OR (method = ? AND normalized_value > ?)
             )
           ORDER BY method, normalized_value
           LIMIT ?`,
        [cursorMethod, cursorMethod, cursorValue, ADDRESS_PAGE_SIZE],
      );
      if (rows.length > ADDRESS_PAGE_SIZE) {
        throw new Error("Invalid canonical address page.");
      }
      const pageRows = rows.map(
        (row): ProfileAddress & { normalizedValue: string } => {
          if (
            (row.method !== "eth" && row.method !== "sol") ||
            typeof row.normalized_value !== "string" ||
            !row.normalized_value ||
            typeof row.raw_value !== "string" ||
            !row.raw_value
          ) {
            throw new Error("Invalid canonical address row.");
          }
          return {
            method: row.method,
            normalizedValue: row.normalized_value,
            value: row.raw_value,
          };
        },
      );
      addresses.push(
        ...pageRows.map(({ method, value }) => ({ method, value })),
      );
      if (rows.length < ADDRESS_PAGE_SIZE) return addresses;
      const last = pageRows.at(-1);
      if (
        !last ||
        (last.method === cursorMethod && last.normalizedValue <= cursorValue)
      ) {
        throw new Error("Invalid canonical address cursor.");
      }
      cursorMethod = last.method;
      cursorValue = last.normalizedValue;
    }
    throw new Error("Canonical address page limit exceeded.");
  }

  async function readLeaderboard(
    metric: "gp",
    limit: number,
  ): Promise<GpLeaderboardProfile[]>;
  async function readLeaderboard(
    metric: "mp",
    limit: number,
  ): Promise<MpLeaderboardProfile[]>;
  async function readLeaderboard(
    metric: LeaderboardMetric,
    limit: number,
  ): Promise<Array<GpLeaderboardProfile | MpLeaderboardProfile>>;
  async function readLeaderboard(
    metric: LeaderboardMetric,
    limit: number,
  ): Promise<Array<GpLeaderboardProfile | MpLeaderboardProfile>> {
    await requireReady();
    const order = metric === "gp" ? "nonce_sort" : "mana_points_sort";
    const presence =
      metric === "gp" ? "nonce_sort_present" : "mana_points_sort_present";
    const totalManaPoints =
      metric === "gp"
        ? ""
        : `,
             json_extract(payload_json, '$.totalManaPoints') AS total_mana_points,
             json_type(payload_json, '$.totalManaPoints') AS total_mana_points_type`;
    const rows = await query(
      `SELECT profile_id,
                json_extract(payload_json, '$.username') AS username,
                json_type(payload_json, '$.username') AS username_type,
                json_extract(payload_json, '$.eth') AS eth,
                json_type(payload_json, '$.eth') AS eth_type,
                json_extract(payload_json, '$.sol') AS sol,
                json_type(payload_json, '$.sol') AS sol_type,
                gameplay_emoji,
                ${order} AS metric_sort${totalManaPoints}
         FROM profile_records_canonical
         WHERE state = 'active' AND ${presence} = 1
         ORDER BY ${order} DESC, profile_id DESC
         LIMIT ?`,
      [limit],
    );
    return rows.map((row) => {
      if (typeof row.profile_id !== "string" || !row.profile_id) {
        throw new Error("Invalid canonical leaderboard row.");
      }
      const username = parseOptionalJsonText(row.username, row.username_type);
      const eth = parseOptionalJsonText(row.eth, row.eth_type);
      const sol = parseOptionalJsonText(row.sol, row.sol_type);
      const profile = {
        id: row.profile_id,
        emoji: parseGameplayEmoji(row.gameplay_emoji),
        ...(username.present ? { username: username.value } : {}),
        ...(eth.present ? { eth: eth.value } : {}),
        ...(sol.present ? { sol: sol.value } : {}),
      };
      if (
        row.metric_sort !== null &&
        (typeof row.metric_sort !== "number" ||
          !Number.isFinite(row.metric_sort))
      ) {
        throw new Error("Invalid canonical leaderboard row.");
      }
      if (metric === "gp") {
        return { ...profile, nonce: row.metric_sort };
      }
      const total = parseOptionalJsonNumber(
        row.total_mana_points,
        row.total_mana_points_type,
      );
      return {
        ...profile,
        ...(total.present ? { totalManaPoints: total.value } : {}),
      };
    });
  }
  return { listAddresses, readLeaderboard };
}
