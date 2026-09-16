import type { GameSessionChange } from "./gameSessionContracts.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";
import { RETIRED_STATE_BACKEND } from "./stateCompatibility.ts";
import { STATE_VALUE_FIELD } from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
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
  backend: typeof RETIRED_STATE_BACKEND | "d1";
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
  backend: typeof RETIRED_STATE_BACKEND | "d1";
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
  backend: typeof RETIRED_STATE_BACKEND | "d1";
  epoch: number;
  freeze_generation: number;
  kind: string;
  created_at_ms: number;
};

export type RecordRow = {
  record_key: string;
  payload_json: string | null;
  revision: number;
};

type MutationRecordRow = RecordRow & {
  expiration_json: string | null;
  expiration_revision: number;
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
  if (!isSafeRecordKey(key)) {
    throw new TypeError("invalid-automatch-key");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableTimestamp(value: number | null): number | null {
  return value === null ? null : timestamp(value);
}

export function prepareAutomatchRuntimeControlRead(
  db: Pick<D1Database, "prepare">,
): D1PreparedStatement {
  return db.prepare(
    "SELECT * FROM automatch_runtime_control WHERE singleton = 1",
  );
}

export function parseAutomatchRuntimeControlRow(
  value: unknown,
): AutomatchRuntimeControl {
  const row = value as ControlRow | null | undefined;
  if (
    !row ||
    (row.backend !== RETIRED_STATE_BACKEND && row.backend !== "d1") ||
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

export async function readAutomatchRuntimeControl(
  db: D1Database,
): Promise<AutomatchRuntimeControl> {
  const row = await prepareAutomatchRuntimeControlRead(
    db.withSession("first-primary"),
  ).first<ControlRow>();
  return parseAutomatchRuntimeControlRow(row);
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
       FROM automatch_runtime_control WHERE singleton = 1 AND state = 'active' AND backend = 'd1'
       RETURNING *`,
    )
    .bind(admissionId, kind, timestamp(now()))
    .first<AdmissionRow>();
  if (!row) {
    if ((await readAutomatchRuntimeControl(db)).backend !== "d1") {
      throw new AutomatchD1Failure("automatch-backend-retired");
    }
    throw new AutomatchD1Failure("automatch-writes-frozen");
  }
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

export function decodeSnapshot(
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
  if (record(value) && Object.hasOwn(value, STATE_VALUE_FIELD)) {
    if (Object.keys(value).length !== 1)
      throw new TypeError("invalid-automatch-server-value");
    if (value[STATE_VALUE_FIELD] === "timestamp") return nowMs;
    const operation = value[STATE_VALUE_FIELD];
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

function validateQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("invalid-automatch-query-limit");
  }
}

function validateQueryCutoff(value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError("invalid-automatch-query-bound");
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

  async function readMutationRecords(
    records: readonly { root: AutomatchRoot; key: string }[],
    signal?: AbortSignal,
  ): Promise<AutomatchRecordSnapshot[]> {
    if (!records.length) return [];
    signal?.throwIfAborted();
    const session = db.withSession("first-primary");
    const indices = new Map<string, number>();
    const statements: D1PreparedStatement[] = [];
    const locations = records.map(({ root, key }) => {
      const { table } = requireRoot(root);
      requireKey(key);
      const identity = `${table}/${key}`;
      let index = indices.get(identity);
      if (index === undefined) {
        index = statements.length;
        indices.set(identity, index);
        const expirationColumns =
          table === AUTOMATCH_RECORD_TABLES.gameplayMutationReceipts.table
            ? "expiration_json, expiration_revision"
            : "NULL AS expiration_json, 0 AS expiration_revision";
        statements.push(
          session
            .prepare(
              `SELECT record_key, payload_json, revision, ${expirationColumns} FROM ${table} WHERE record_key = ?`,
            )
            .bind(key),
        );
      }
      return { root, key, index };
    });
    const results = await session.batch<MutationRecordRow>(statements);
    signal?.throwIfAborted();
    return locations.map(({ root, key, index }) => {
      const row = results[index].results[0];
      if (!row) return { root, key, value: null, revision: 0 };
      return decodeSnapshot(
        root,
        root === "gameplayMutationReceiptExpirations"
          ? {
              record_key: row.record_key,
              payload_json: row.expiration_json,
              revision: row.expiration_revision,
            }
          : row,
      );
    });
  }

  async function readValues(
    root: AutomatchRoot,
    sql: string,
    values: readonly (string | number)[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    signal?.throwIfAborted();
    const rows = await db
      .withSession("first-primary")
      .prepare(sql)
      .bind(...values)
      .all<RecordRow>();
    signal?.throwIfAborted();
    if (!rows.results.length) return null;
    return Object.fromEntries(
      rows.results.map((row) => {
        const snapshot = decodeSnapshot(root, row);
        return [snapshot.key, snapshot.value];
      }),
    );
  }

  async function listAutomatchEntriesByLogin(
    uid: string,
    limit: number,
    signal?: AbortSignal,
  ) {
    validateQueryLimit(limit);
    if (typeof uid !== "string") {
      throw new TypeError("invalid-automatch-query-bound");
    }
    return readValues(
      "automatch",
      `SELECT record_key, payload_json, revision FROM automatch_entries
       WHERE payload_json IS NOT NULL
         AND json_extract(payload_json, '$.uid') = ?
         AND json_type(payload_json, '$.uid') = 'text'
       ORDER BY ${keyOrderSql("record_key")} LIMIT ?`,
      [uid, limit],
      signal,
    );
  }

  async function readFirstAutomatchEntry(signal?: AbortSignal) {
    return readValues(
      "automatch",
      `SELECT record_key, payload_json, revision FROM automatch_entries
       WHERE payload_json IS NOT NULL
       ORDER BY ${keyOrderSql("record_key")} LIMIT 1`,
      [],
      signal,
    );
  }

  async function listDueAutomatchTelegramOutboxes(
    nowMs: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    validateQueryLimit(limit);
    validateQueryCutoff(nowMs);
    return readValues(
      "telegramProjectionOutbox/automatch",
      `SELECT record_key, payload_json, revision
       FROM automatch_telegram_projection_outbox
       WHERE payload_json IS NOT NULL
         AND json_type(payload_json, '$.updatedAtMs') IN ('integer', 'real')
         AND json_extract(payload_json, '$.updatedAtMs') >= 0
         AND json_extract(payload_json, '$.updatedAtMs') <= ?
       ORDER BY json_extract(payload_json, '$.updatedAtMs'), ${keyOrderSql("record_key")}
       LIMIT ?`,
      [nowMs, limit],
      signal,
    );
  }

  async function listDueAutomatchProfileOutboxes(
    beforeMs: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    validateQueryLimit(limit);
    validateQueryCutoff(beforeMs);
    return readValues(
      "profileGameProjectionOutbox/automatch",
      `WITH null_due AS (
         SELECT record_key, payload_json, revision, 0 AS sort_rank, NULL AS sort_value
         FROM game_session_projection_outbox
         WHERE payload_json IS NOT NULL
           AND json_extract(payload_json, '$.lastQueuedAtMs') IS NULL
         ORDER BY ${keyOrderSql("record_key")} LIMIT ?2
       ), false_due AS (
         SELECT record_key, payload_json, revision, 1 AS sort_rank, NULL AS sort_value
         FROM game_session_projection_outbox
         WHERE payload_json IS NOT NULL
           AND json_extract(payload_json, '$.lastQueuedAtMs') = 0
           AND json_type(payload_json, '$.lastQueuedAtMs') = 'false'
         ORDER BY ${keyOrderSql("record_key")} LIMIT ?2
       ), true_due AS (
         SELECT record_key, payload_json, revision, 2 AS sort_rank, NULL AS sort_value
         FROM game_session_projection_outbox
         WHERE payload_json IS NOT NULL
           AND json_extract(payload_json, '$.lastQueuedAtMs') = 1
           AND json_type(payload_json, '$.lastQueuedAtMs') = 'true'
         ORDER BY ${keyOrderSql("record_key")} LIMIT ?2
       ), numeric_due AS (
         SELECT record_key, payload_json, revision, 3 AS sort_rank,
           json_extract(payload_json, '$.lastQueuedAtMs') AS sort_value
         FROM game_session_projection_outbox
         WHERE payload_json IS NOT NULL
           AND json_extract(payload_json, '$.lastQueuedAtMs') <= ?1
           AND json_type(payload_json, '$.lastQueuedAtMs') IN ('integer', 'real')
         ORDER BY json_extract(payload_json, '$.lastQueuedAtMs'), ${keyOrderSql("record_key")}
         LIMIT ?2
       )
       SELECT record_key, payload_json, revision FROM (
         SELECT * FROM null_due
         UNION ALL SELECT * FROM false_due
         UNION ALL SELECT * FROM true_due
         UNION ALL SELECT * FROM numeric_due
       ) ORDER BY sort_rank, sort_value, ${keyOrderSql("record_key")} LIMIT ?2`,
      [beforeMs, limit],
      signal,
    );
  }

  async function listMalformedAutomatchProfileOutboxes(
    limit: number,
    signal?: AbortSignal,
  ) {
    validateQueryLimit(limit);
    return readValues(
      "profileGameProjectionOutbox/automatch",
      `SELECT record_key, payload_json, revision
       FROM game_session_projection_outbox
       WHERE payload_json IS NOT NULL
         AND json_extract(payload_json, '$.lastQueuedAtMs') >= ''
       ORDER BY CASE json_type(payload_json, '$.lastQueuedAtMs') WHEN 'text' THEN 0 ELSE 1 END,
         CASE WHEN json_type(payload_json, '$.lastQueuedAtMs') = 'text'
           THEN json_extract(payload_json, '$.lastQueuedAtMs') END,
         ${keyOrderSql("record_key")} LIMIT ?`,
      [limit],
      signal,
    );
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

  async function prepareChanges(
    changes: readonly GameSessionChange[],
    nowMs = now(),
    signal?: AbortSignal,
  ): Promise<AutomatchRecordMutation[]> {
    timestamp(nowMs);
    const groups = new Map<
      string,
      { root: AutomatchRoot; key: string; changes: GameSessionChange[] }
    >();
    const add = (
      root: AutomatchRoot,
      key: string,
      change: GameSessionChange,
    ) => {
      requireKey(key);
      const identity = `${root}/${key}`;
      const group = groups.get(identity) || { root, key, changes: [] };
      group.changes.push(change);
      groups.set(identity, group);
    };
    for (const change of changes) {
      switch (change.kind) {
        case "automatch-entry":
          add("automatch", change.inviteId, change);
          break;
        case "telegram-source":
        case "telegram-source-merge":
          add("telegramAutomatches", change.inviteId, change);
          break;
        case "telegram-outbox":
          add("telegramProjectionOutbox/automatch", change.inviteId, change);
          break;
        case "profile-outbox":
        case "profile-outbox-merge":
          add("profileGameProjectionOutbox/automatch", change.inviteId, change);
          break;
        case "mutation-receipt":
          add("gameplayMutationReceipts", change.operationId, change);
          add("gameplayMutationReceiptExpirations", change.operationId, change);
      }
    }
    const entries = [...groups.values()];
    const snapshots = await readMutationRecords(entries, signal);
    return entries.map(({ root, changes }, index) => {
      const current = snapshots[index];
      let value = current.value;
      for (const change of changes) {
        if (change.kind === "mutation-receipt") {
          value = resolveAutomatchServerValues(
            root === "gameplayMutationReceipts"
              ? change.value
              : change.expiration,
            current.value,
            nowMs,
          );
        } else if (
          change.kind === "telegram-source-merge" ||
          change.kind === "profile-outbox-merge"
        ) {
          for (const [field, next] of Object.entries(change.value)) {
            requireKey(field);
            value = setNested(
              value,
              [field],
              resolveAutomatchServerValues(
                next,
                nestedValue(current.value, [field]),
                nowMs,
              ),
            );
          }
          if (change.kind === "profile-outbox-merge")
            for (const [matchId, next] of Object.entries(
              change.historicalMatches || {},
            )) {
              requireKey(matchId);
              value = setNested(
                value,
                ["historicalMatches", matchId],
                resolveAutomatchServerValues(
                  next,
                  nestedValue(current.value, ["historicalMatches", matchId]),
                  nowMs,
                ),
              );
            }
        } else if (
          change.kind === "automatch-entry" ||
          change.kind === "telegram-source" ||
          change.kind === "telegram-outbox" ||
          change.kind === "profile-outbox"
        ) {
          value = resolveAutomatchServerValues(
            change.value,
            current.value,
            nowMs,
          );
        }
      }
      return { current, value };
    });
  }

  async function transactRecord(
    root: AutomatchRoot,
    key: string,
    update: (current: unknown) => TransactionDecision<unknown>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<unknown>> {
    const nowMs = now();
    for (let attempt = 0; attempt < 25; attempt++) {
      const current = await read(root, key, signal);
      const decision = validateTelegramTransactionDecision(
        update(structuredClone(current.value)),
      );
      if (!decision.commit)
        return {
          committed: false,
          decision: decision.decision,
          value: current.value,
        };
      const value = resolveAutomatchServerValues(
        decision.value,
        current.value,
        nowMs,
      );
      if (await commit([{ current, value }], signal))
        return { committed: true, decision: decision.decision, value };
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
    prepareChanges,
    readAutomatchEntry: async (inviteId: string, signal?: AbortSignal) =>
      (await read("automatch", inviteId, signal)).value,
    listAutomatchEntriesByLogin,
    readFirstAutomatchEntry,
    readMutationReceipt: async (operationId: string, signal?: AbortSignal) =>
      (await read("gameplayMutationReceipts", operationId, signal)).value,
    readAutomatchTelegramSource: async (
      inviteId: string,
      signal?: AbortSignal,
    ) => (await read("telegramAutomatches", inviteId, signal)).value,
    transactAutomatchTelegramSource: (
      inviteId: string,
      update: (value: unknown) => TransactionDecision<unknown>,
      signal?: AbortSignal,
    ) => transactRecord("telegramAutomatches", inviteId, update, signal),
    readAutomatchTelegramOutbox: async (
      inviteId: string,
      signal?: AbortSignal,
    ) =>
      (await read("telegramProjectionOutbox/automatch", inviteId, signal))
        .value,
    transactAutomatchTelegramOutbox: (
      inviteId: string,
      update: (value: unknown) => TransactionDecision<unknown>,
      signal?: AbortSignal,
    ) =>
      transactRecord(
        "telegramProjectionOutbox/automatch",
        inviteId,
        update,
        signal,
      ),
    listDueAutomatchTelegramOutboxes,
    readAutomatchProfileOutbox: async (
      inviteId: string,
      signal?: AbortSignal,
    ) =>
      (await read("profileGameProjectionOutbox/automatch", inviteId, signal))
        .value,
    transactAutomatchProfileOutbox: (
      inviteId: string,
      update: (value: unknown) => TransactionDecision<unknown>,
      signal?: AbortSignal,
    ) =>
      transactRecord(
        "profileGameProjectionOutbox/automatch",
        inviteId,
        update,
        signal,
      ),
    listDueAutomatchProfileOutboxes,
    listMalformedAutomatchProfileOutboxes,
    listEntriesByLogins,
    buildRevisionGuardStatements,
    buildCommitStatements,
    commit,
    expireReceipts,
  };
}

export type AutomatchD1Store = ReturnType<typeof createAutomatchD1Store>;
