import {
  AUTOMATCH_RECORD_TABLES,
  type AutomatchRoot,
  type AutomatchRecordSnapshot,
  type RecordRow,
  type MutationRecordRow,
  type AutomatchOutboxClaimSnapshot,
  type AutomatchOutboxRecoveryPage,
  type AutomatchRecordValue,
  type AutomatchOutboxRoot,
} from "./types.ts";
import { decodeSnapshot, requireKey, requireRoot } from "./codec.ts";
import { readD1FirstRow } from "../d1Reads.ts";
import {
  readRecoveryScanIdentities,
  recoveryScanExclusionSql,
  recoveryScanIdentitySql,
} from "../recoveryScanPage.ts";

const RECOVERY_ORDER_SQL = `recovery_sort_rank, recovery_sort_value,
  recovery_key_rank, recovery_key_integer, recovery_key_length,
  record_key COLLATE BINARY`;

function decodeValues<Root extends AutomatchRoot>(
  root: Root,
  rows: readonly RecordRow[],
): Record<string, AutomatchRecordValue<Root>> | null {
  if (!rows.length) return null;
  return Object.fromEntries(
    rows.map((row) => {
      const snapshot = decodeSnapshot(root, row);
      return [snapshot.key, snapshot.value];
    }),
  );
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

export function createAutomatchReads(db: D1Database) {
  async function read<Root extends AutomatchRoot>(
    root: Root,
    key: string,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordSnapshot<Root>> {
    const { table, valueColumn, revisionColumn } = requireRoot(root);
    requireKey(key);
    signal?.throwIfAborted();
    const row = await readD1FirstRow<RecordRow>(
      db
        .withSession("first-primary")
        .prepare(
          `SELECT record_key, ${valueColumn} AS payload_json, ${revisionColumn} AS revision FROM ${table} WHERE record_key = ?`,
        )
        .bind(key),
    );
    signal?.throwIfAborted();
    return row
      ? decodeSnapshot(root, row)
      : decodeSnapshot(root, {
          record_key: key,
          payload_json: null,
          revision: 0,
        });
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
      if (!row)
        return decodeSnapshot(root, {
          record_key: key,
          payload_json: null,
          revision: 0,
        });
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

  async function readValues<Root extends AutomatchRoot>(
    root: Root,
    sql: string,
    values: readonly (string | number)[],
    signal?: AbortSignal,
  ): Promise<Record<string, AutomatchRecordValue<Root>> | null> {
    signal?.throwIfAborted();
    const rows = await db
      .withSession("first-primary")
      .prepare(sql)
      .bind(...values)
      .all<RecordRow>();
    signal?.throwIfAborted();
    return decodeValues(root, rows.results);
  }

  async function readRecoveryPage<Root extends AutomatchOutboxRoot>(
    root: Root,
    sql: string,
    values: readonly (string | number)[],
    signal?: AbortSignal,
    retainSnapshots = false,
  ): Promise<AutomatchOutboxRecoveryPage<Root>> {
    signal?.throwIfAborted();
    const rows = await db
      .withSession("first-primary")
      .prepare(sql)
      .bind(...values)
      .all<RecordRow & { recovery_scan_identity?: unknown }>();
    signal?.throwIfAborted();
    const scannedIdentities = readRecoveryScanIdentities(rows.results);
    if (!retainSnapshots || rows.results.length === 0) {
      return {
        entries: decodeValues(root, rows.results),
        scannedIdentities,
      } as AutomatchOutboxRecoveryPage<Root>;
    }
    const snapshots = new Map<string, AutomatchOutboxClaimSnapshot<Root>>();
    const encoder = new TextEncoder();
    const entries = Object.fromEntries(
      rows.results.map((row, index) => {
        const snapshot = decodeSnapshot(root, row);
        const keyIdentity = `text:${Array.from(
          encoder.encode(snapshot.key),
          (byte) => byte.toString(16).padStart(2, "0"),
        )
          .join("")
          .toUpperCase()}`;
        snapshots.delete(snapshot.key);
        if (scannedIdentities[index] === keyIdentity) {
          snapshots.set(snapshot.key, snapshot);
        }
        return [snapshot.key, snapshot.value];
      }),
    );
    return {
      entries,
      scannedIdentities,
      snapshots,
    } as AutomatchOutboxRecoveryPage<Root>;
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
    return (
      await listDueAutomatchTelegramOutboxesPage(nowMs, limit, [], signal)
    ).entries;
  }

  async function listDueAutomatchTelegramOutboxesPage(
    nowMs: number,
    limit: number,
    excludedIdentities: readonly string[] = [],
    signal?: AbortSignal,
  ) {
    validateQueryLimit(limit);
    validateQueryCutoff(nowMs);
    return readRecoveryPage(
      "telegramProjectionOutbox/automatch",
      `SELECT record_key, payload_json, revision,
         ${recoveryScanIdentitySql("record_key")} AS recovery_scan_identity
       FROM automatch_telegram_projection_outbox
       WHERE payload_json IS NOT NULL
         AND recovery_sort_rank = 3
         AND recovery_sort_value >= 0
         AND recovery_sort_value <= ?1
         ${recoveryScanExclusionSql("record_key", excludedIdentities, 3)}
       ORDER BY ${RECOVERY_ORDER_SQL} LIMIT ?2`,
      [nowMs, limit, ...excludedIdentities],
      signal,
      true,
    );
  }

  async function listDueAutomatchProfileOutboxes(
    beforeMs: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    return (
      await listDueAutomatchProfileOutboxesPage(beforeMs, limit, [], signal)
    ).entries;
  }

  async function listDueAutomatchProfileOutboxesPage(
    beforeMs: number,
    limit: number,
    excludedIdentities: readonly string[] = [],
    signal?: AbortSignal,
  ) {
    validateQueryLimit(limit);
    validateQueryCutoff(beforeMs);
    return readRecoveryPage(
      "profileGameProjectionOutbox/automatch",
      `SELECT record_key, payload_json, revision,
         ${recoveryScanIdentitySql("record_key")} AS recovery_scan_identity
       FROM game_session_projection_outbox
       WHERE payload_json IS NOT NULL
         AND (recovery_sort_rank, recovery_sort_value) <= (3, ?1)
         ${recoveryScanExclusionSql("record_key", excludedIdentities, 3)}
       ORDER BY ${RECOVERY_ORDER_SQL} LIMIT ?2`,
      [beforeMs, limit, ...excludedIdentities],
      signal,
      true,
    );
  }

  async function listMalformedAutomatchProfileOutboxes(
    limit: number,
    signal?: AbortSignal,
  ) {
    return (await listMalformedAutomatchProfileOutboxesPage(limit, [], signal))
      .entries;
  }

  async function listMalformedAutomatchProfileOutboxesPage(
    limit: number,
    excludedIdentities: readonly string[] = [],
    signal?: AbortSignal,
  ) {
    validateQueryLimit(limit);
    return readRecoveryPage(
      "profileGameProjectionOutbox/automatch",
      `SELECT record_key, payload_json, revision,
         ${recoveryScanIdentitySql("record_key")} AS recovery_scan_identity
       FROM game_session_projection_outbox
       WHERE payload_json IS NOT NULL
         AND recovery_sort_rank >= 4
         ${recoveryScanExclusionSql("record_key", excludedIdentities, 2)}
       ORDER BY ${RECOVERY_ORDER_SQL} LIMIT ?1`,
      [limit, ...excludedIdentities],
      signal,
    );
  }

  async function listEntriesByLogins(
    loginUids: readonly string[],
    limitPerUid = 2,
    signal?: AbortSignal,
  ): Promise<AutomatchRecordSnapshot<"automatch">[]> {
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
    listDueAutomatchTelegramOutboxesPage,
    listDueAutomatchProfileOutboxes,
    listDueAutomatchProfileOutboxesPage,
    listMalformedAutomatchProfileOutboxes,
    listMalformedAutomatchProfileOutboxesPage,
    listEntriesByLogins,
  };
}
