const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const ts = require("typescript");

const CONFIG_PATH = resolve(__dirname, "../workers/api/wrangler.jsonc");
const DATABASE_NAME = "mons-link-profiles";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ADDRESS_PAGE_SIZE = 500;
const MAX_ADDRESS_PAGES = 10_000;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function parseConfig() {
  const parsed = ts.parseConfigFileTextToJson(
    CONFIG_PATH,
    readFileSync(CONFIG_PATH, "utf8"),
  );
  if (parsed.error) {
    throw new Error("Invalid Cloudflare Worker configuration.");
  }
  const config = record(parsed.config);
  const accountId = config?.account_id;
  const database = Array.isArray(config?.d1_databases)
    ? config.d1_databases.find(
        (entry) => record(entry)?.database_name === DATABASE_NAME,
      )
    : null;
  const databaseId = record(database)?.database_id;
  if (
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    typeof databaseId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(databaseId)
  ) {
    throw new Error("Missing canonical profile D1 coordinates.");
  }
  return { accountId, databaseId };
}

function cloudflareToken(environment = process.env) {
  const configured = (environment.CLOUDFLARE_API_TOKEN || "").trim();
  if (!configured) {
    throw new Error(
      "Missing CLOUDFLARE_API_TOKEN scoped to D1 Read for canonical profile admin tools.",
    );
  }
  return configured;
}

async function boundedText(response) {
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

function createD1Query({ fetcher = fetch, token, coordinates } = {}) {
  const { accountId, databaseId } = coordinates || parseConfig();
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
    let payload;
    try {
      payload = JSON.parse(await boundedText(response));
    } catch (error) {
      if (error instanceof Error && error.message.includes("Cloudflare D1")) {
        throw error;
      }
      throw new Error("Invalid Cloudflare D1 response.");
    }
    const root = record(payload);
    const result = Array.isArray(root?.result) ? record(root.result[0]) : null;
    if (!response.ok || root?.success !== true || result?.success !== true) {
      throw new Error("Cloudflare D1 query failed.");
    }
    return Array.isArray(result.results)
      ? result.results.filter((entry) => Boolean(record(entry)))
      : [];
  };
}

function isReadOnlySql(sql) {
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

function parseGameplayEmoji(value) {
  if (
    typeof value !== "string" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("Invalid canonical gameplay emoji.");
  }
  return value;
}

function parseOptionalJsonText(value, type) {
  if (type === null || type === undefined) {
    return { present: false, value: undefined };
  }
  if (type === "null" && value === null) {
    return { present: true, value: null };
  }
  if (type === "text" && typeof value === "string") {
    return { present: true, value };
  }
  throw new Error("Invalid canonical leaderboard row.");
}

function parseOptionalJsonNumber(value, type) {
  if (type === null || type === undefined) {
    return { present: false, value: undefined };
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

function createProfileD1Reader({ query = createD1Query() } = {}) {
  let activated;
  const requireActivated = async () => {
    activated ||= query(
      `SELECT state, activated_at_ms
       FROM profile_canonical_control
       WHERE singleton = 1`,
    ).then((rows) => {
      if (
        rows.length !== 1 ||
        !["verifying", "active", "frozen"].includes(rows[0].state) ||
        !Number.isSafeInteger(rows[0].activated_at_ms) ||
        rows[0].activated_at_ms < 0
      ) {
        throw new Error("Canonical profile D1 is not activated.");
      }
    });
    return activated;
  };
  return {
    async listAddresses() {
      await requireActivated();
      const addresses = [];
      let cursorMethod = "";
      let cursorValue = "";
      for (let page = 0; page < MAX_ADDRESS_PAGES; page += 1) {
        const rows = await query(
          `SELECT method, normalized_value, raw_value
           FROM profile_auth_methods
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
        for (const row of rows) {
          if (
            (row.method !== "eth" && row.method !== "sol") ||
            typeof row.normalized_value !== "string" ||
            !row.normalized_value ||
            typeof row.raw_value !== "string" ||
            !row.raw_value
          ) {
            throw new Error("Invalid canonical address row.");
          }
          addresses.push({ method: row.method, value: row.raw_value });
        }
        if (rows.length < ADDRESS_PAGE_SIZE) return addresses;
        const last = rows.at(-1);
        if (
          !last ||
          (last.method === cursorMethod && last.normalized_value <= cursorValue)
        ) {
          throw new Error("Invalid canonical address cursor.");
        }
        cursorMethod = last.method;
        cursorValue = last.normalized_value;
      }
      throw new Error("Canonical address page limit exceeded.");
    },
    async readLeaderboard(metric, limit) {
      await requireActivated();
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
                json_extract(gameplay_emoji_json, '$') AS gameplay_emoji,
                ${order} AS metric_sort${totalManaPoints}
         FROM profile_records
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
    },
  };
}

module.exports = {
  DATABASE_NAME,
  MAX_RESPONSE_BYTES,
  boundedText,
  cloudflareToken,
  createD1Query,
  createProfileD1Reader,
  isReadOnlySql,
  parseConfig,
  parseGameplayEmoji,
};
