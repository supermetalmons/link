import {
  parseTelegramAnnouncementPayload,
  type TelegramAnnouncementOutcomeStatus,
  type RetainedTelegramAnnouncementAttempt,
  type TelegramAnnouncementAttempt,
} from "./telegramAnnouncementRecords.ts";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import {
  createTelegramRepository,
  type TelegramStoredRecord,
} from "../../../runtime/telegram/repositoryCore.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";
import { validateTelegramMessageKey } from "../../../runtime/telegram/desiredStateCore.js";
import { validateTelegramTransactionDecision } from "./telegramTransaction.ts";
import { runOptimisticTransaction } from "./optimisticTransaction.ts";
import { createVersionedJsonRowStore } from "./versionedJsonD1.ts";
import {
  controlDocument,
  readTelegramControlDocument,
  readTelegramMessageDocument,
  type TelegramControlDocument,
} from "../../../runtime/telegram/records.js";
import {
  decodeAnnouncement,
  type TelegramAnnouncementRecord,
  type AnnouncementRow,
} from "./telegramAnnouncementRows.ts";

const MAX_D1_TRANSACTION_ATTEMPTS = 25;

export type TelegramStorageMode = "d1" | "frozen";

export type { TelegramAnnouncementAttempt } from "./telegramAnnouncementRecords.ts";

export type { TelegramAnnouncementRecord } from "./telegramAnnouncementRows.ts";

export type TelegramAnnouncementRepository = {
  get(requestId: string): Promise<TelegramAnnouncementRecord | null>;
  reserve(input: {
    createdAtMs: number;
    payloadDigest: string;
    requestId: string;
    attempt?: TelegramAnnouncementAttempt | RetainedTelegramAnnouncementAttempt;
  }): Promise<"reserved" | TelegramAnnouncementRecord>;
  storeOutcome(input: {
    messageIds?: number[];
    payloadDigest: string;
    requestId: string;
    status: TelegramAnnouncementOutcomeStatus;
    updatedAtMs: number;
    attemptId?: string;
    retryAtMs?: number;
    errorCode?: string;
  }): Promise<boolean>;
};

export class TelegramD1Failure extends Error {
  constructor(options?: ErrorOptions) {
    super("telegram-d1-unavailable", options);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TelegramD1Failure();
  }
  return value;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new TelegramD1Failure();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TelegramD1Failure({ cause: error });
  }
  const record = asRecord(parsed);
  if (!record) throw new TelegramD1Failure();
  return record;
}

function encodeJsonRecord(value: unknown): string {
  const record = asRecord(value);
  if (!record) throw new TelegramD1Failure();
  try {
    return JSON.stringify(record);
  } catch (error) {
    throw new TelegramD1Failure({ cause: error });
  }
}

async function readRow<Value extends object>(
  db: D1Database,
  table: "telegram_delivery_control_canonical" | "telegram_messages_canonical",
  key: string | number,
  decode: (value: unknown) => Value | null,
): Promise<{ record: Value; version: number } | null> {
  const row = await createVersionedJsonRowStore(db, {
    table,
    key: [key],
  }).read();
  if (!row) return null;
  const record = decode(parseJsonRecord(row.record_json));
  if (!record) throw new TelegramD1Failure();
  return {
    record,
    version: safeInteger(row.version),
  };
}

async function transactRow<Value extends object>(
  db: D1Database,
  input: {
    key: string | number;
    now: () => number;
    decode: (value: unknown) => Value | null;
    table:
      "telegram_delivery_control_canonical" | "telegram_messages_canonical";
    updater: (current: Value | null) => TransactionDecision<Value>;
  },
): Promise<TransactionResult<Value>> {
  const rows = createVersionedJsonRowStore(db, {
    table: input.table,
    key: [input.key],
  });
  return runOptimisticTransaction({
    maxAttempts: MAX_D1_TRANSACTION_ATTEMPTS,
    read: () => readRow<Value>(db, input.table, input.key, input.decode),
    getValue: (current) => current?.record ?? null,
    decide(current) {
      const decision = validateTelegramTransactionDecision(
        input.updater(current),
      );
      const metadata =
        decision.decision === undefined ? {} : { decision: decision.decision };
      return decision.commit
        ? { value: decision.value, ...metadata }
        : { commit: false, ...metadata };
    },
    async write(current, next) {
      const updatedAtMs = Math.max(1, Math.floor(input.now()));
      if (next === null) {
        if (!current) {
          return { applied: true, value: null };
        }
        const changes = await rows.deleteIfVersion(current.version);
        return { applied: changes === 1, value: null };
      }
      const validated = input.decode(next);
      if (!validated) throw new TelegramD1Failure();
      const encoded = encodeJsonRecord(validated);
      if (!current) {
        const changes = await rows.insertIfAbsent(encoded, updatedAtMs);
        return { applied: changes === 1, value: validated };
      }
      const changes = await rows.updateIfVersion(
        current.version,
        encoded,
        updatedAtMs,
      );
      return { applied: changes === 1, value: validated };
    },
    conflictError: () => new TelegramD1Failure(),
  });
}

export function createD1TelegramRepository(
  db: D1Database,
  { now = Date.now }: { now?: () => number } = {},
): TelegramRepository {
  return createTelegramRepository({
    async readMessage(messageKey) {
      const key = validateTelegramMessageKey(messageKey);
      return (
        (
          await readRow<TelegramStoredRecord>(
            db,
            "telegram_messages_canonical",
            key,
            readTelegramMessageDocument,
          )
        )?.record ?? null
      );
    },
    transactMessage(messageKey, updater) {
      return transactRow(db, {
        table: "telegram_messages_canonical",
        decode: readTelegramMessageDocument,
        key: validateTelegramMessageKey(messageKey),
        updater,
        now,
      });
    },
    async readControl() {
      return (
        (
          await readRow<TelegramControlDocument>(
            db,
            "telegram_delivery_control_canonical",
            1,
            readTelegramControlDocument,
          )
        )?.record ?? controlDocument()
      );
    },
    transactControl(updater) {
      return transactRow(db, {
        table: "telegram_delivery_control_canonical",
        decode: readTelegramControlDocument,
        key: 1,
        updater,
        now,
      });
    },
  });
}

export function createD1TelegramAnnouncementRepository(
  db: D1Database,
): TelegramAnnouncementRepository {
  const get = async (requestId: string) => {
    try {
      const row = await db
        .prepare(
          `SELECT schema_version, payload_digest, status, message_ids_json,
                  created_at_ms, updated_at_ms, event_id, start_at_ms,
                  run_at_ms, first_queued_at_ms, payload_json, attempt_id,
                  attempt_count, retry_at_ms, error_code, announcement_kind
           FROM telegram_event_prize_announcements_canonical
           WHERE request_id = ?`,
        )
        .bind(requestId)
        .first<AnnouncementRow>();
      return row ? decodeAnnouncement(row) : null;
    } catch (error) {
      if (error instanceof TelegramD1Failure) throw error;
      throw new TelegramD1Failure({ cause: error });
    }
  };
  return {
    get,
    async reserve(input) {
      try {
        if (input.attempt) {
          const attempt = input.attempt;
          if (!parseTelegramAnnouncementPayload(attempt.payload, attempt.kind))
            throw new TelegramD1Failure();
          const result = await db
            .prepare(
              `INSERT INTO telegram_event_prize_announcements_canonical (
                 request_id, payload_digest, status, message_ids_json,
                 created_at_ms, updated_at_ms, event_id, start_at_ms,
                 run_at_ms, first_queued_at_ms, payload_json,
                 attempt_id, attempt_count, retry_at_ms, error_code, announcement_kind
               ) VALUES (?, ?, 'sending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?)
               ON CONFLICT (request_id) DO UPDATE SET
                 payload_digest = excluded.payload_digest, status = 'sending',
                 message_ids_json = NULL, updated_at_ms = excluded.updated_at_ms,
                 start_at_ms = excluded.start_at_ms, run_at_ms = excluded.run_at_ms,
                 first_queued_at_ms = excluded.first_queued_at_ms,
                 payload_json = excluded.payload_json, attempt_id = excluded.attempt_id,
                 attempt_count = telegram_event_prize_announcements_canonical.attempt_count + 1,
                 retry_at_ms = NULL, error_code = NULL
               WHERE telegram_event_prize_announcements_canonical.status = 'retryable'
                 AND telegram_event_prize_announcements_canonical.event_id = excluded.event_id
                 AND telegram_event_prize_announcements_canonical.announcement_kind = excluded.announcement_kind
                 AND telegram_event_prize_announcements_canonical.attempt_id IS ?
                 AND telegram_event_prize_announcements_canonical.retry_at_ms <= excluded.updated_at_ms`,
            )
            .bind(
              input.requestId,
              input.payloadDigest,
              input.createdAtMs,
              input.createdAtMs,
              attempt.eventId,
              attempt.startAtMs,
              attempt.runAtMs,
              attempt.firstQueuedAtMs,
              encodeJsonRecord(attempt.payload),
              attempt.attemptId,
              attempt.kind ?? "prizes",
              attempt.expectedAttemptId,
            )
            .run();
          if (result.meta.changes === 1) return "reserved";
          const existing = await get(input.requestId);
          if (!existing) throw new TelegramD1Failure();
          return existing;
        }
        const result = await db
          .prepare(
            `INSERT INTO telegram_event_prize_announcements_canonical (
               request_id, payload_digest, status, message_ids_json,
               created_at_ms, updated_at_ms, announcement_kind
             ) VALUES (?, ?, 'sending', NULL, ?, ?, 'prizes')
             ON CONFLICT (request_id) DO NOTHING`,
          )
          .bind(
            input.requestId,
            input.payloadDigest,
            input.createdAtMs,
            input.createdAtMs,
          )
          .run();
        if (result.meta.changes === 1) return "reserved";
        const existing = await get(input.requestId);
        if (!existing) throw new TelegramD1Failure();
        return existing;
      } catch (error) {
        if (error instanceof TelegramD1Failure) throw error;
        throw new TelegramD1Failure({ cause: error });
      }
    },
    async storeOutcome(input) {
      try {
        const result = await db
          .prepare(
            `UPDATE telegram_event_prize_announcements_canonical
             SET status = ?, message_ids_json = ?, updated_at_ms = ?,
                 retry_at_ms = ?, error_code = ?
             WHERE request_id = ? AND payload_digest = ? AND status = 'sending'
               AND attempt_id IS ?`,
          )
          .bind(
            input.status,
            input.messageIds ? JSON.stringify(input.messageIds) : null,
            input.updatedAtMs,
            input.retryAtMs ?? null,
            input.errorCode ?? null,
            input.requestId,
            input.payloadDigest,
            input.attemptId ?? null,
          )
          .run();
        return result.meta.changes === 1;
      } catch (error) {
        throw new TelegramD1Failure({ cause: error });
      }
    },
  };
}

export async function readTelegramStorageMode(
  db: D1Database,
): Promise<TelegramStorageMode> {
  try {
    const row = await db
      .prepare(
        `SELECT storage_mode FROM telegram_runtime_control WHERE singleton = 1`,
      )
      .first<{ storage_mode: string }>();
    if (row?.storage_mode === "frozen" || row?.storage_mode === "d1") {
      return row.storage_mode;
    }
  } catch {}
  console.error(JSON.stringify({ event: "telegram_storage_mode_unavailable" }));
  return "frozen";
}

export { MAX_D1_TRANSACTION_ATTEMPTS };
