import {
  AUTOMATCH_RECORD_TABLES,
  type AutomatchRoot,
  type AutomatchRecordSnapshot,
  type RecordRow,
  type MutationRecordRow,
} from "./types.ts";
import { decodeSnapshot, requireKey, requireRoot } from "./codec.ts";

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

export function createAutomatchReads(db: D1Database) {
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

  return {
    read,
    readMutationRecords,
    listAutomatchEntriesByLogin,
    readFirstAutomatchEntry,
    listDueAutomatchTelegramOutboxes,
    listDueAutomatchProfileOutboxes,
    listMalformedAutomatchProfileOutboxes,
    listEntriesByLogins,
  };
}
