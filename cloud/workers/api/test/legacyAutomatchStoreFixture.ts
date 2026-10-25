import { retainedAutomatchMutationFixture } from "./automatchRecordFixture.ts";
import {
  createAutomatchD1Store,
  AUTOMATCH_RECORD_TABLES,
  type AutomatchRoot,
  resolveAutomatchServerValues,
  AutomatchD1Failure,
  type AutomatchRecordMutation,
  type AutomatchRecordSnapshot,
  type AutomatchD1StoreOptions,
} from "../src/automatchD1.ts";
import { isSafeRecordKey } from "../src/recordKeys.ts";
import { validateTelegramTransactionDecision } from "../src/telegramTransaction.ts";
import type {
  StateQuery,
  StateTransactionResult,
} from "../test/stateRepositoryTestTypes.ts";
export const AUTOMATCH_ROOTS = Object.freeze(
  Object.keys(AUTOMATCH_RECORD_TABLES) as AutomatchRoot[],
);

export type AutomatchOwnedPath = {
  root: AutomatchRoot;
  key: string | null;
  nested: string[];
};

export function parseAutomatchPath(path: string): AutomatchOwnedPath | null {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  const root = AUTOMATCH_ROOTS.find(
    (candidate) =>
      normalized === candidate || normalized.startsWith(`${candidate}/`),
  );
  if (!root) return null;
  const parts = normalized.slice(root.length).replace(/^\//, "").split("/");
  if (parts.length === 1 && parts[0] === "") {
    return { root, key: null, nested: [] };
  }
  parts.forEach(requireKey);
  return { root, key: parts[0], nested: parts.slice(1) };
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("invalid-automatch-timestamp");
  }
  return value;
}

function requireKey(key: string): void {
  if (!isSafeRecordKey(key)) {
    throw new TypeError("invalid-automatch-key");
  }
}

function nestedValue(value: unknown, parts: readonly string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    ) {
      return null;
    }
    current = Reflect.get(current, part);
  }
  return structuredClone(current);
}

function setNested(
  value: unknown,
  parts: readonly string[],
  next: unknown,
): unknown {
  if (!parts.length) return next;
  const entries =
    value !== null && typeof value === "object" ? Object.entries(value) : [];
  const result = Object.fromEntries(entries);
  const [key, ...rest] = parts;
  const child = setNested(
    Object.hasOwn(result, key) ? result[key] : null,
    rest,
    next,
  );
  if (child === null) delete result[key];
  else
    Object.defineProperty(result, key, {
      value: child,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  if (!Object.keys(result).length) return null;
  return result;
}

const QUERY_FIELDS = new Set([
  "endAt",
  "equalTo",
  "limitToFirst",
  "orderBy",
  "shallow",
  "startAt",
]);
const ORDER_FIELDS = new Set([
  "$key",
  "uid",
  "profileId",
  "updatedAtMs",
  "lastQueuedAtMs",
  "completedAtMs",
]);

function validateQuery(query: StateQuery): void {
  if (Object.keys(query).some((field) => !QUERY_FIELDS.has(field))) {
    throw new TypeError("unsupported-automatch-query");
  }
  if (query.orderBy !== undefined && !ORDER_FIELDS.has(query.orderBy)) {
    throw new TypeError("unsupported-automatch-query-order");
  }
  if (
    query.limitToFirst !== undefined &&
    (!Number.isSafeInteger(query.limitToFirst) || query.limitToFirst < 1)
  ) {
    throw new TypeError("invalid-automatch-query-limit");
  }
  if (query.shallow !== undefined && typeof query.shallow !== "boolean") {
    throw new TypeError("invalid-automatch-query-shallow");
  }
  if (
    query.shallow === true &&
    Object.keys(query).some((field) => field !== "shallow")
  ) {
    throw new TypeError("unsupported-automatch-shallow-query");
  }
  if (
    Object.hasOwn(query, "equalTo") &&
    (Object.hasOwn(query, "startAt") || Object.hasOwn(query, "endAt"))
  ) {
    throw new TypeError("unsupported-automatch-query-range");
  }
  for (const field of ["startAt", "endAt", "equalTo"] as const) {
    if (!Object.hasOwn(query, field)) continue;
    const value = query[field];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      throw new TypeError("invalid-automatch-query-bound");
    }
    if ((query.orderBy || "$key") === "$key" && typeof value !== "string") {
      throw new TypeError("invalid-automatch-key-query-bound");
    }
  }
}

function keyIntegerSql(expression: string): string {
  const digits = `(CASE WHEN substr(${expression}, 1, 1) = '-' THEN substr(${expression}, 2) ELSE ${expression} END)`;
  return `(CASE WHEN length(${digits}) BETWEEN 1 AND 10 AND ${digits} NOT GLOB '*[^0-9]*'
    AND CAST(${expression} AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(${expression} AS INTEGER) END)`;
}

function keyOrderSql(expression: string): string {
  const integer = keyIntegerSql(expression);
  return `CASE WHEN ${integer} IS NULL THEN 1 ELSE 0 END, ${integer},
    CASE WHEN ${integer} IS NOT NULL THEN length(${expression}) ELSE 0 END, ${expression} COLLATE BINARY`;
}

function jsonRankSql(column: string, field: string): string {
  return `(CASE json_type(${column}, '$.${field}') WHEN 'false' THEN 1 WHEN 'true' THEN 2
    WHEN 'integer' THEN 3 WHEN 'real' THEN 3 WHEN 'text' THEN 4
    WHEN 'array' THEN 5 WHEN 'object' THEN 5 ELSE 0 END)`;
}

function queryBound(value: string | number | boolean | null | undefined): {
  rank: number;
  value: string | number;
} {
  if (value === null) return { rank: 0, value: 0 };
  if (typeof value === "boolean") return { rank: value ? 2 : 1, value: 0 };
  if (typeof value === "number") return { rank: 3, value };
  if (typeof value === "string") return { rank: 4, value };
  throw new TypeError("invalid-automatch-query-bound");
}

function querySql(
  column: string,
  query: StateQuery,
): { where: string; order: string; values: Array<string | number> } {
  validateQuery(query);
  const field = query.orderBy || "$key";
  const clauses = [`${column} IS NOT NULL`];
  const values: Array<string | number> = [];
  const rank = field === "$key" ? "4" : jsonRankSql(column, field);
  const value =
    field === "$key"
      ? "record_key COLLATE BINARY"
      : `json_extract(${column}, '$.${field}')`;
  for (const [bound, operator] of [
    ["equalTo", "="],
    ["startAt", ">="],
    ["endAt", "<="],
  ] as const) {
    if (!Object.hasOwn(query, bound)) continue;
    const input = queryBound(query[bound]);
    if (field === "$key") {
      const key = String(input.value);
      const integer = /^-?\d{1,10}$/.test(key) ? Number(key) : NaN;
      const numeric =
        Number.isInteger(integer) &&
        integer >= -2147483648 &&
        integer <= 2147483647;
      if (operator === "=") {
        clauses.push("record_key = ?");
        values.push(key);
      } else {
        const expression = keyIntegerSql("record_key");
        const tuple = `(CASE WHEN ${expression} IS NULL THEN 1 ELSE 0 END, COALESCE(${expression}, 0), CASE WHEN ${expression} IS NOT NULL THEN length(record_key) ELSE 0 END, record_key COLLATE BINARY)`;
        clauses.push(`${tuple} ${operator} (?, ?, ?, ?)`);
        values.push(
          numeric ? 0 : 1,
          numeric ? integer : 0,
          numeric ? key.length : 0,
          key,
        );
      }
    } else if (operator === "=") {
      clauses.push(
        `${rank} = ?${input.rank === 3 || input.rank === 4 ? ` AND ${value} = ?` : ""}`,
      );
      values.push(input.rank);
      if (input.rank === 3 || input.rank === 4) values.push(input.value);
    } else {
      clauses.push(
        `(${rank} ${operator === ">=" ? ">" : "<"} ? OR (${rank} = ?${input.rank === 3 || input.rank === 4 ? ` AND ${value} ${operator} ?` : ""}))`,
      );
      values.push(input.rank, input.rank);
      if (input.rank === 3 || input.rank === 4) values.push(input.value);
    }
  }
  return {
    where: clauses.join(" AND "),
    order:
      field === "$key"
        ? keyOrderSql("record_key")
        : `${rank}, CASE WHEN ${rank} IN (3, 4) THEN ${value} END, ${keyOrderSql("record_key")}`,
    values,
  };
}

export function createLegacyAutomatchD1Store(
  db: D1Database,
  options: AutomatchD1StoreOptions = {},
) {
  const store = createAutomatchD1Store(db, options);
  const { read, commit } = store;
  async function list(
    root: AutomatchRoot,
    query: StateQuery = {},
    signal?: AbortSignal,
  ): Promise<AutomatchRecordSnapshot[]> {
    if (!Object.hasOwn(AUTOMATCH_RECORD_TABLES, root))
      throw new TypeError("invalid-automatch-root");
    const { table, valueColumn, revisionColumn } =
      AUTOMATCH_RECORD_TABLES[root];
    const sql = querySql(valueColumn, query);
    signal?.throwIfAborted();
    const rows = await db
      .withSession("first-primary")
      .prepare(
        `SELECT record_key, ${valueColumn} AS payload_json, ${revisionColumn} AS revision
         FROM ${table} WHERE ${sql.where} ORDER BY ${sql.order}${query.limitToFirst === undefined ? "" : " LIMIT ?"}`,
      )
      .bind(
        ...sql.values,
        ...(query.limitToFirst === undefined ? [] : [query.limitToFirst]),
      )
      .all<{
        record_key: string;
        payload_json: string | null;
        revision: number;
      }>();
    signal?.throwIfAborted();
    return rows.results.map((row) => {
      requireKey(row.record_key);
      if (!Number.isSafeInteger(row.revision) || row.revision < 0)
        throw new AutomatchD1Failure("automatch-record-corrupt");
      return {
        root,
        key: row.record_key,
        value: row.payload_json === null ? null : JSON.parse(row.payload_json),
        revision: row.revision,
      };
    });
  }
  const now = options.now || Date.now;
  async function getPath(
    path: string,
    query: StateQuery = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const owned = parseAutomatchPath(path);
    if (!owned) throw new TypeError("not-an-automatch-path");
    if (owned.key === null) {
      const rows = await list(owned.root, query, signal);
      return rows.length
        ? Object.fromEntries(
            rows.map((entry) => [
              entry.key,
              query.shallow === true ? true : entry.value,
            ]),
          )
        : null;
    }
    validateQuery(query);
    if (Object.keys(query).some((field) => field !== "shallow")) {
      throw new TypeError("unsupported-automatch-record-query");
    }
    const result = nestedValue(
      (await read(owned.root, owned.key, signal)).value,
      owned.nested,
    );
    return query.shallow === true &&
      result !== null &&
      typeof result === "object"
      ? Object.fromEntries(Object.keys(result).map((key) => [key, true]))
      : result;
  }

  async function preparePatch(
    updates: Record<string, unknown>,
    nowMs = now(),
    signal?: AbortSignal,
  ): Promise<AutomatchRecordMutation[]> {
    timestamp(nowMs);
    const entries = Object.entries(updates).map(([path, value]) => {
      const owned = parseAutomatchPath(path);
      if (!owned?.key)
        throw new TypeError("automatch-patch-must-target-record");
      return {
        path: [owned.root, owned.key, ...owned.nested].join("/"),
        owned,
        value,
      };
    });
    const paths = entries.map(({ path }) => path).sort();
    for (let index = 1; index < paths.length; index++) {
      if (
        paths[index] === paths[index - 1] ||
        paths[index].startsWith(`${paths[index - 1]}/`)
      ) {
        throw new TypeError("overlapping-automatch-patch");
      }
    }
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = `${entry.owned.root}/${entry.owned.key}`;
      const group = groups.get(key) || [];
      group.push(entry);
      groups.set(key, group);
    }
    return Promise.all(
      [...groups.values()].map(async (group) => {
        const first = group[0].owned;
        const current = await read(first.root, first.key!, signal);
        let value: unknown = current.value;
        for (const entry of group) {
          value = setNested(
            value,
            entry.owned.nested,
            resolveAutomatchServerValues(
              entry.value,
              nestedValue(current.value, entry.owned.nested),
              nowMs,
            ),
          );
        }
        return retainedAutomatchMutationFixture(current, value);
      }),
    );
  }

  async function patchRoot(
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const nowMs = now();
    for (let attempt = 0; attempt < 25; attempt++) {
      if (await commit(await preparePatch(updates, nowMs, signal), signal))
        return;
    }
    throw new AutomatchD1Failure("automatch-patch-contention");
  }

  async function transactPath(
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
  ): Promise<StateTransactionResult> {
    const owned = parseAutomatchPath(path);
    if (!owned?.key)
      throw new TypeError("automatch-transaction-must-target-record");
    const nowMs = now();
    for (let attempt = 0; attempt < 25; attempt++) {
      const current = await read(owned.root, owned.key, signal);
      const value = nestedValue(current.value, owned.nested);
      const decision = validateTelegramTransactionDecision(
        updater(structuredClone(value)),
      );
      if (!decision.commit)
        return { committed: false, decision: decision.decision, value };
      const next = resolveAutomatchServerValues(decision.value, value, nowMs);
      if (
        await commit(
          [
            retainedAutomatchMutationFixture(
              current,
              setNested(current.value, owned.nested, next),
            ),
          ],
          signal,
        )
      ) {
        return { committed: true, decision: decision.decision, value: next };
      }
    }
    throw new AutomatchD1Failure("automatch-transaction-contention");
  }

  return { ...store, list, getPath, preparePatch, patchRoot, transactPath };
}
