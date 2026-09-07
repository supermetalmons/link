import type {
  FirebaseRtdbQuery,
  FirebaseRtdbTransactionResult,
} from "./firebaseRtdb.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import { validateTelegramTransactionDecision } from "./telegramTransaction.ts";

export const AUTOMATCH_RECORD_TABLES = {
  automatch: {
    table: "automatch_entries",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  telegramAutomatches: {
    table: "automatch_telegram_sources",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  "telegramProjectionOutbox/automatch": {
    table: "automatch_telegram_projection_outbox",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  "profileGameProjectionOutbox/automatch": {
    table: "game_session_projection_outbox",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  gameplayMutationReceipts: {
    table: "game_session_mutation_receipts",
    valueColumn: "payload_json",
    revisionColumn: "revision",
  },
  gameplayMutationReceiptExpirations: {
    table: "game_session_mutation_receipts",
    valueColumn: "expiration_json",
    revisionColumn: "expiration_revision",
  },
} as const;

export type AutomatchRoot = keyof typeof AUTOMATCH_RECORD_TABLES;
export const AUTOMATCH_ROOTS = Object.freeze(
  Object.keys(AUTOMATCH_RECORD_TABLES) as AutomatchRoot[],
);

export type AutomatchOwnedPath = {
  root: AutomatchRoot;
  key: string | null;
  nested: string[];
};

export type AutomatchRecordSnapshot = {
  root: AutomatchRoot;
  key: string;
  value: unknown;
  revision: number;
};

export type AutomatchRecordMutation = {
  current: AutomatchRecordSnapshot;
  value: unknown;
};

export type AutomatchRuntimeControl = {
  backend: "rtdb" | "d1";
  state: "active" | "frozen";
  epoch: number;
  freezeGeneration: number;
  stagedAtMs: number | null;
  candidateVersionId: string | null;
  importedAtMs: number | null;
  sourceDigest: string | null;
  importDigest: string | null;
  activatedAtMs: number | null;
  metadata: unknown;
};

export type AutomatchWriteAdmission = {
  admissionId: string;
  backend: "rtdb" | "d1";
  epoch: number;
  freezeGeneration: number;
  kind: string;
  createdAtMs: number;
};

type ControlRow = {
  backend: string;
  state: string;
  epoch: number;
  freeze_generation: number;
  staged_at_ms: number | null;
  candidate_version_id: string | null;
  imported_at_ms: number | null;
  source_digest: string | null;
  import_digest: string | null;
  activated_at_ms: number | null;
  metadata_json: string | null;
};

type AdmissionRow = {
  admission_id: string;
  backend: "rtdb" | "d1";
  epoch: number;
  freeze_generation: number;
  kind: string;
  created_at_ms: number;
};

type RecordRow = {
  record_key: string;
  payload_json: string | null;
  revision: number;
};

export class AutomatchD1Failure extends Error {
  constructor(message = "automatch-state-unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("invalid-automatch-timestamp");
  }
  return value;
}

function requireRoot(root: AutomatchRoot) {
  if (!Object.hasOwn(AUTOMATCH_RECORD_TABLES, root)) {
    throw new TypeError("invalid-automatch-root");
  }
  return AUTOMATCH_RECORD_TABLES[root];
}

function requireKey(key: string): void {
  if (!isSafeFirebaseKey(key)) {
    throw new TypeError("invalid-automatch-key");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

function nullableTimestamp(value: number | null): number | null {
  return value === null ? null : timestamp(value);
}

export async function readAutomatchRuntimeControl(
  db: D1Database,
): Promise<AutomatchRuntimeControl> {
  const row = await db
    .withSession("first-primary")
    .prepare("SELECT * FROM automatch_runtime_control WHERE singleton = 1")
    .first<ControlRow>();
  if (
    !row ||
    (row.backend !== "rtdb" && row.backend !== "d1") ||
    (row.state !== "active" && row.state !== "frozen") ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1 ||
    !Number.isSafeInteger(row.freeze_generation) ||
    row.freeze_generation < 0
  ) {
    throw new AutomatchD1Failure("automatch-control-unavailable");
  }
  try {
    return {
      backend: row.backend,
      state: row.state,
      epoch: row.epoch,
      freezeGeneration: row.freeze_generation,
      stagedAtMs: nullableTimestamp(row.staged_at_ms),
      candidateVersionId: row.candidate_version_id,
      importedAtMs: nullableTimestamp(row.imported_at_ms),
      sourceDigest: row.source_digest,
      importDigest: row.import_digest,
      activatedAtMs: nullableTimestamp(row.activated_at_ms),
      metadata:
        row.metadata_json === null ? null : JSON.parse(row.metadata_json),
    };
  } catch (error) {
    throw new AutomatchD1Failure("automatch-control-corrupt", { cause: error });
  }
}

function admissionFromRow(row: AdmissionRow): AutomatchWriteAdmission {
  return {
    admissionId: row.admission_id,
    backend: row.backend,
    epoch: row.epoch,
    freezeGeneration: row.freeze_generation,
    kind: row.kind,
    createdAtMs: row.created_at_ms,
  };
}

export async function acquireAutomatchWriteAdmission(
  db: D1Database,
  kind: string,
  {
    admissionId = crypto.randomUUID(),
    now = Date.now,
  }: { admissionId?: string; now?: () => number } = {},
): Promise<AutomatchWriteAdmission> {
  if (!kind.trim() || !admissionId.trim()) {
    throw new TypeError("invalid-automatch-admission");
  }
  const row = await db
    .withSession("first-primary")
    .prepare(
      `INSERT INTO automatch_write_admissions
         (admission_id, epoch, freeze_generation, backend, kind, created_at_ms, phase)
       SELECT ?, epoch, freeze_generation, backend, ?, ?, 'prepared'
       FROM automatch_runtime_control WHERE singleton = 1 AND state = 'active'
       RETURNING *`,
    )
    .bind(admissionId, kind, timestamp(now()))
    .first<AdmissionRow>();
  if (!row) throw new AutomatchD1Failure("automatch-writes-frozen");
  return admissionFromRow(row);
}

export function automatchAdmissionGuardStatements(
  db: D1Database,
  admission: AutomatchWriteAdmission,
  { allowFrozen = false }: { allowFrozen?: boolean } = {},
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO automatch_write_guards (singleton)
         SELECT 0 WHERE NOT EXISTS (
           SELECT 1 FROM automatch_runtime_control AS control
           JOIN automatch_write_admissions AS admission
             ON admission.epoch = control.epoch AND admission.backend = control.backend
           WHERE control.singleton = 1 ${allowFrozen ? "" : "AND control.state = 'active' AND control.freeze_generation = admission.freeze_generation"}
             AND admission.admission_id = ? AND admission.epoch = ?
             AND admission.backend = ? AND admission.freeze_generation = ?
             AND admission.kind = ? AND admission.created_at_ms = ?
         )`,
      )
      .bind(
        admission.admissionId,
        admission.epoch,
        admission.backend,
        admission.freezeGeneration,
        admission.kind,
        admission.createdAtMs,
      ),
  ];
}

export async function assertAutomatchWriteAdmission(
  db: D1Database,
  admission: AutomatchWriteAdmission,
  options?: { allowFrozen?: boolean },
): Promise<void> {
  await db.batch(automatchAdmissionGuardStatements(db, admission, options));
}

export async function releaseAutomatchWriteAdmission(
  db: D1Database,
  admission: AutomatchWriteAdmission,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db
        .prepare(
          `DELETE FROM automatch_write_admissions WHERE admission_id = ?
         AND epoch = ? AND backend = ? AND freeze_generation = ?
         AND kind = ? AND created_at_ms = ?`,
        )
        .bind(
          admission.admissionId,
          admission.epoch,
          admission.backend,
          admission.freezeGeneration,
          admission.kind,
          admission.createdAtMs,
        )
        .run();
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

function encodeValue(value: unknown): string | null {
  const active = new Set<object>();
  const validate = (nested: unknown, depth: number): void => {
    if (depth > 64) throw new TypeError("invalid-automatch-json");
    if (
      nested === null ||
      typeof nested === "string" ||
      typeof nested === "boolean" ||
      (typeof nested === "number" && Number.isFinite(nested))
    ) {
      return;
    }
    if (!nested || typeof nested !== "object" || active.has(nested)) {
      throw new TypeError("invalid-automatch-json");
    }
    const prototype = Object.getPrototypeOf(nested);
    if (
      !Array.isArray(nested) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new TypeError("invalid-automatch-json");
    }
    active.add(nested);
    for (const value of Object.values(nested)) validate(value, depth + 1);
    active.delete(nested);
  };
  validate(value, 0);
  return value === null ? null : JSON.stringify(value);
}

function decodeSnapshot(
  root: AutomatchRoot,
  row: RecordRow,
): AutomatchRecordSnapshot {
  requireKey(row.record_key);
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new AutomatchD1Failure("automatch-record-corrupt");
  }
  return {
    root,
    key: row.record_key,
    value: row.payload_json === null ? null : JSON.parse(row.payload_json),
    revision: row.revision,
  };
}

export function isAutomatchRevisionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("automatch_revision_guard") ||
      isAutomatchRevisionConflict(error.cause))
  );
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

export function resolveAutomatchServerValues(
  value: unknown,
  current: unknown,
  nowMs: number,
): unknown {
  timestamp(nowMs);
  if (record(value) && Object.hasOwn(value, ".sv")) {
    if (Object.keys(value).length !== 1)
      throw new TypeError("invalid-automatch-server-value");
    if (value[".sv"] === "timestamp") return nowMs;
    const operation = value[".sv"];
    if (
      record(operation) &&
      Object.keys(operation).length === 1 &&
      typeof operation.increment === "number" &&
      Number.isFinite(operation.increment)
    ) {
      const result =
        (typeof current === "number" && Number.isFinite(current)
          ? current
          : 0) + operation.increment;
      if (!Number.isFinite(result))
        throw new TypeError("invalid-automatch-increment");
      return result;
    }
    throw new TypeError("invalid-automatch-server-value");
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      resolveAutomatchServerValues(
        entry,
        nestedValue(current, [String(index)]),
        nowMs,
      ),
    );
  }
  if (record(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        requireKey(key);
        return [
          key,
          resolveAutomatchServerValues(
            entry,
            nestedValue(current, [key]),
            nowMs,
          ),
        ];
      }),
    );
  }
  encodeValue(value);
  return value;
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

function validateQuery(query: FirebaseRtdbQuery): void {
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
  query: FirebaseRtdbQuery,
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

export type AutomatchD1StoreOptions = {
  now?: () => number;
  writeGuards?: () => readonly D1PreparedStatement[];
};

export function createAutomatchD1Store(
  db: D1Database,
  { now = Date.now, writeGuards }: AutomatchD1StoreOptions = {},
) {
  const backendGuard = () =>
    db.prepare(
      `INSERT INTO automatch_write_guards (singleton)
       SELECT 0 WHERE NOT EXISTS (
         SELECT 1 FROM automatch_runtime_control
         WHERE singleton = 1 AND backend = 'd1'
       )`,
    );

  async function read(
    root: AutomatchRoot,
    key: string,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordSnapshot> {
    const { table, valueColumn, revisionColumn } = requireRoot(root);
    requireKey(key);
    signal?.throwIfAborted();
    const row = await db
      .withSession("first-primary")
      .prepare(
        `SELECT record_key, ${valueColumn} AS payload_json, ${revisionColumn} AS revision FROM ${table} WHERE record_key = ?`,
      )
      .bind(key)
      .first<RecordRow>();
    signal?.throwIfAborted();
    return row
      ? decodeSnapshot(root, row)
      : { root, key, value: null, revision: 0 };
  }

  async function list(
    root: AutomatchRoot,
    query: FirebaseRtdbQuery = {},
    signal?: AbortSignal,
  ): Promise<AutomatchRecordSnapshot[]> {
    const { table, valueColumn, revisionColumn } = requireRoot(root);
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
      .all<RecordRow>();
    signal?.throwIfAborted();
    return rows.results.map((row) => decodeSnapshot(root, row));
  }

  async function listEntriesByLogins(
    loginUids: readonly string[],
    limitPerUid = 2,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordSnapshot[]> {
    const uids = [...new Set(loginUids)];
    if (
      uids.length > 512 ||
      !Number.isSafeInteger(limitPerUid) ||
      limitPerUid < 1 ||
      limitPerUid > 2
    ) {
      throw new TypeError("invalid-automatch-login-query");
    }
    uids.forEach(requireKey);
    signal?.throwIfAborted();
    if (!uids.length) return [];
    const rows = await db
      .withSession("first-primary")
      .prepare(
        `WITH ranked AS (
          SELECT entry.record_key, entry.payload_json, entry.revision,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(entry.payload_json, '$.uid')
              ORDER BY ${keyOrderSql("entry.record_key")}
            ) AS login_rank
          FROM json_each(?) AS requested
          CROSS JOIN automatch_entries AS entry INDEXED BY idx_automatch_entries_uid
          WHERE entry.payload_json IS NOT NULL
            AND json_extract(entry.payload_json, '$.uid') = requested.value
            AND json_type(entry.payload_json, '$.uid') = 'text'
        )
        SELECT record_key, payload_json, revision FROM ranked
        WHERE login_rank <= ? ORDER BY ${keyOrderSql("record_key")}`,
      )
      .bind(JSON.stringify(uids), limitPerUid)
      .all<RecordRow>();
    signal?.throwIfAborted();
    return rows.results.map((row) => decodeSnapshot("automatch", row));
  }

  async function getPath(
    path: string,
    query: FirebaseRtdbQuery = {},
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

  function buildRevisionGuardStatements(
    mutations: readonly AutomatchRecordMutation[],
  ): D1PreparedStatement[] {
    const keys = new Set<string>();
    return mutations.map(({ current, value }) => {
      const { table, revisionColumn } = requireRoot(current.root);
      requireKey(current.key);
      const key = `${current.root}/${current.key}`;
      if (keys.has(key)) throw new TypeError("duplicate-automatch-mutation");
      keys.add(key);
      if (
        !Number.isSafeInteger(current.revision) ||
        current.revision < 0 ||
        !Number.isSafeInteger(current.revision + 1)
      ) {
        throw new TypeError("invalid-automatch-revision");
      }
      encodeValue(value);
      return db
        .prepare(
          `INSERT INTO automatch_revision_guards (singleton)
         SELECT 0 WHERE COALESCE((SELECT ${revisionColumn} FROM ${table} WHERE record_key = ?), 0) != ?`,
        )
        .bind(current.key, current.revision);
    });
  }

  function buildCommitStatements(
    mutations: readonly AutomatchRecordMutation[],
    nowMs = now(),
  ): D1PreparedStatement[] {
    timestamp(nowMs);
    return [
      ...(writeGuards?.() || []),
      backendGuard(),
      ...buildRevisionGuardStatements(mutations),
      ...mutations.map(({ current, value }) => {
        const { table, valueColumn, revisionColumn } = requireRoot(
          current.root,
        );
        return db
          .prepare(
            `INSERT INTO ${table} (record_key, ${valueColumn}, ${revisionColumn}, updated_at_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT (record_key) DO UPDATE SET ${valueColumn} = excluded.${valueColumn},
             ${revisionColumn} = excluded.${revisionColumn}, updated_at_ms = MAX(${table}.updated_at_ms, excluded.updated_at_ms)`,
          )
          .bind(current.key, encodeValue(value), current.revision + 1, nowMs);
      }),
    ];
  }

  async function commit(
    mutations: readonly AutomatchRecordMutation[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!writeGuards) throw new AutomatchD1Failure("automatch-state-read-only");
    signal?.throwIfAborted();
    try {
      const statements = buildCommitStatements(mutations);
      if (statements.length) await db.batch(statements);
      return true;
    } catch (error) {
      if (isAutomatchRevisionConflict(error)) return false;
      throw error;
    }
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
        let value = current.value;
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
        return { current, value };
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
  ): Promise<FirebaseRtdbTransactionResult> {
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
          [{ current, value: setNested(current.value, owned.nested, next) }],
          signal,
        )
      ) {
        return { committed: true, decision: decision.decision, value: next };
      }
    }
    throw new AutomatchD1Failure("automatch-transaction-contention");
  }

  async function expireReceipts(
    cutoffMs: number,
    limit = 1000,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!writeGuards) throw new AutomatchD1Failure("automatch-state-read-only");
    if (
      !Number.isSafeInteger(cutoffMs) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new TypeError("invalid-automatch-receipt-expiration");
    }
    signal?.throwIfAborted();
    const results = await db.batch<{ record_key: string }>([
      ...writeGuards(),
      backendGuard(),
      db
        .prepare(
          `UPDATE game_session_mutation_receipts
           SET payload_json = NULL, revision = revision + 1,
             expiration_json = NULL, expiration_revision = expiration_revision + 1,
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE record_key IN (
             SELECT receipt.record_key FROM game_session_mutation_receipts AS receipt
             WHERE expiration_json IS NOT NULL
               AND json_type(expiration_json, '$.completedAtMs') IN ('integer', 'real')
               AND json_extract(expiration_json, '$.completedAtMs') <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM game_session_transition_resources AS resource
                 WHERE resource.resource_key = 'gameplay-operation:' || receipt.record_key
               )
             ORDER BY json_extract(expiration_json, '$.completedAtMs'), record_key
             LIMIT ?
           ) RETURNING record_key`,
        )
        .bind(timestamp(now()), cutoffMs, limit),
    ]);
    return results[results.length - 1].results.length;
  }

  return {
    read,
    list,
    listEntriesByLogins,
    getPath,
    preparePatch,
    buildRevisionGuardStatements,
    buildCommitStatements,
    commit,
    patchRoot,
    transactPath,
    expireReceipts,
  };
}

export type AutomatchD1Store = ReturnType<typeof createAutomatchD1Store>;
