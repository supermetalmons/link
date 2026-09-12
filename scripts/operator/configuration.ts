import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export const D1_BINDINGS = {
  "mons-link-profile-games": "PROFILE_GAMES_DB",
  "mons-link-auth-state": "AUTH_STATE_DB",
  "mons-link-telegram": "TELEGRAM_DB",
  "mons-link-event-prize-withdrawals": "EVENT_PRIZE_WITHDRAWALS_DB",
  "mons-link-profiles": "PROFILE_DB",
  "mons-link-events": "EVENT_DB",
} as const;

export type D1Binding = (typeof D1_BINDINGS)[keyof typeof D1_BINDINGS];

export const DEFAULT_API_CONFIG = resolve(
  import.meta.dirname,
  "../../cloud/workers/api/wrangler.jsonc",
);

export function resolveD1Binding(target: string): D1Binding {
  if (Object.values(D1_BINDINGS).includes(target as D1Binding))
    return target as D1Binding;
  if (Object.hasOwn(D1_BINDINGS, target))
    return D1_BINDINGS[target as keyof typeof D1_BINDINGS];
  throw new Error("unknown canonical D1 binding");
}

export function readOperatorConfiguration(path = DEFAULT_API_CONFIG) {
  const require = createRequire(import.meta.url);
  const ts = require("typescript") as typeof import("typescript");
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error || !parsed.config || typeof parsed.config !== "object")
    throw new Error("invalid operator configuration");
  return parsed.config as Record<string, unknown>;
}

export function resolveD1Coordinates(
  target: string,
  path = DEFAULT_API_CONFIG,
) {
  const binding = resolveD1Binding(target);
  const configuration = readOperatorConfiguration(path);
  const databases = configuration.d1_databases;
  const entries = Array.isArray(databases)
    ? databases.filter((entry) => entry?.binding === binding)
    : [];
  const entry = entries[0];
  const accountId = configuration.account_id;
  if (
    entries.length !== 1 ||
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    typeof entry.database_id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.database_id) ||
    typeof entry.database_name !== "string" ||
    !entry.database_name
  )
    throw new Error("invalid or ambiguous canonical D1 coordinates");
  return {
    accountId,
    binding,
    databaseId: entry.database_id as string,
    databaseName: entry.database_name as string,
    configPath: path,
  };
}
