import type { TelegramRepository } from "../../../functions/telegram/deliveryEngine.js";
import { createTelegramRepository } from "../../../functions/telegram/repositoryCore.js";
import { validateTelegramMessageKey } from "../../../functions/telegram/desiredStateCore.js";
import { validateTelegramTransactionDecision } from "./telegramTransaction.ts";

const TELEGRAM_MESSAGE_PREFIX = "telegramMessages/";
const TELEGRAM_DELIVERY_CONTROL_ROOT = "telegramDeliveryControl";
const TELEGRAM_RETRY_NOT_BEFORE_PATH = `${TELEGRAM_DELIVERY_CONTROL_ROOT}/retryNotBeforeMs`;
const MAX_D1_TRANSACTION_ATTEMPTS = 25;

type JsonRow = {
  record_json: string;
  version: number;
};

export type TelegramStorageMode = "d1" | "frozen";

export type TelegramAnnouncementRecord = {
  createdAtMs: number;
  messageIds: number[] | null;
  payloadDigest: string;
  status: string;
  updatedAtMs: number;
};

export type TelegramAnnouncementRepository = {
  get(requestId: string): Promise<TelegramAnnouncementRecord | null>;
  reserve(input: {
    createdAtMs: number;
    payloadDigest: string;
    requestId: string;
  }): Promise<"reserved" | TelegramAnnouncementRecord>;
  storeOutcome(input: {
    messageIds?: number[];
    payloadDigest: string;
    requestId: string;
    status: string;
    updatedAtMs: number;
  }): Promise<boolean>;
};

export class TelegramD1Failure extends Error {
  constructor() {
    super("telegram-d1-unavailable");
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
  } catch {
    throw new TelegramD1Failure();
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
  } catch {
    throw new TelegramD1Failure();
  }
}

async function readRow(
  db: D1Database,
  table: "telegram_delivery_control" | "telegram_messages",
  keyColumn: "message_key" | "singleton",
  key: string | number,
): Promise<{ record: Record<string, unknown>; version: number } | null> {
  const row = await db
    .prepare(`SELECT record_json, version FROM ${table} WHERE ${keyColumn} = ?`)
    .bind(key)
    .first<JsonRow>();
  if (!row) return null;
  return {
    record: parseJsonRecord(row.record_json),
    version: safeInteger(row.version),
  };
}

async function transactRow(
  db: D1Database,
  input: {
    key: string | number;
    keyColumn: "message_key" | "singleton";
    now: () => number;
    table: "telegram_delivery_control" | "telegram_messages";
    updater: (current: unknown) => unknown;
  },
): Promise<{ committed: boolean; decision?: string; value: unknown }> {
  for (let attempt = 0; attempt < MAX_D1_TRANSACTION_ATTEMPTS; attempt += 1) {
    const current = await readRow(db, input.table, input.keyColumn, input.key);
    const decision = validateTelegramTransactionDecision(
      input.updater(current?.record ?? null),
    );
    if (!decision.commit) {
      return {
        committed: false,
        decision: decision.decision,
        value: current?.record ?? null,
      };
    }
    const updatedAtMs = Math.max(1, Math.floor(input.now()));
    if (decision.value === null) {
      if (!current) {
        return {
          committed: true,
          decision: decision.decision,
          value: null,
        };
      }
      const deleted = await db
        .prepare(
          `DELETE FROM ${input.table}
           WHERE ${input.keyColumn} = ? AND version = ?`,
        )
        .bind(input.key, current.version)
        .run();
      if (deleted.meta.changes === 1) {
        return {
          committed: true,
          decision: decision.decision,
          value: null,
        };
      }
      continue;
    }
    const encoded = encodeJsonRecord(decision.value);
    if (!current) {
      const inserted = await db
        .prepare(
          `INSERT INTO ${input.table} (
             ${input.keyColumn}, record_json, version, updated_at_ms
           ) VALUES (?, ?, 1, ?)
           ON CONFLICT (${input.keyColumn}) DO NOTHING`,
        )
        .bind(input.key, encoded, updatedAtMs)
        .run();
      if (inserted.meta.changes === 1) {
        return {
          committed: true,
          decision: decision.decision,
          value: decision.value,
        };
      }
      continue;
    }
    const updated = await db
      .prepare(
        `UPDATE ${input.table}
         SET record_json = ?, version = version + 1, updated_at_ms = ?
         WHERE ${input.keyColumn} = ? AND version = ?`,
      )
      .bind(encoded, updatedAtMs, input.key, current.version)
      .run();
    if (updated.meta.changes === 1) {
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    }
  }
  throw new TelegramD1Failure();
}

export function createD1TelegramRepository(
  db: D1Database,
  { now = Date.now }: { now?: () => number } = {},
): TelegramRepository {
  const readControl = async () =>
    (await readRow(db, "telegram_delivery_control", "singleton", 1))?.record ??
    {};
  return createTelegramRepository({
    async getPath(path) {
      if (path.startsWith(TELEGRAM_MESSAGE_PREFIX)) {
        const messageKey = validateTelegramMessageKey(
          path.slice(TELEGRAM_MESSAGE_PREFIX.length),
        );
        return (
          (await readRow(db, "telegram_messages", "message_key", messageKey))
            ?.record ?? null
        );
      }
      const control = await readControl();
      if (path === TELEGRAM_DELIVERY_CONTROL_ROOT) return control;
      if (path === TELEGRAM_RETRY_NOT_BEFORE_PATH) {
        return control.retryNotBeforeMs ?? null;
      }
      throw new TelegramD1Failure();
    },
    async transactPath(path, updater) {
      if (path.startsWith(TELEGRAM_MESSAGE_PREFIX)) {
        const messageKey = validateTelegramMessageKey(
          path.slice(TELEGRAM_MESSAGE_PREFIX.length),
        );
        return transactRow(db, {
          table: "telegram_messages",
          keyColumn: "message_key",
          key: messageKey,
          updater,
          now,
        });
      }
      if (path === TELEGRAM_DELIVERY_CONTROL_ROOT) {
        return transactRow(db, {
          table: "telegram_delivery_control",
          keyColumn: "singleton",
          key: 1,
          updater,
          now,
        });
      }
      if (path === TELEGRAM_RETRY_NOT_BEFORE_PATH) {
        const result = await transactRow(db, {
          table: "telegram_delivery_control",
          keyColumn: "singleton",
          key: 1,
          now,
          updater(current) {
            const control = asRecord(current) || {};
            const decision = validateTelegramTransactionDecision(
              updater(control.retryNotBeforeMs ?? null),
            );
            if (!decision.commit) return decision;
            return {
              value: {
                ...control,
                retryNotBeforeMs: decision.value,
              },
              decision: decision.decision,
            };
          },
        });
        return {
          ...result,
          value: asRecord(result.value)?.retryNotBeforeMs ?? null,
        };
      }
      throw new TelegramD1Failure();
    },
  });
}

type AnnouncementRow = {
  created_at_ms: number;
  message_ids_json: string | null;
  payload_digest: string;
  status: string;
  updated_at_ms: number;
};

function parseMessageIds(value: string | null): number[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TelegramD1Failure();
  }
  return Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (messageId) => Number.isSafeInteger(messageId) && messageId > 0,
    )
    ? parsed
    : null;
}

function decodeAnnouncement(row: AnnouncementRow): TelegramAnnouncementRecord {
  if (!row.payload_digest || !row.status) throw new TelegramD1Failure();
  return {
    createdAtMs: safeInteger(row.created_at_ms),
    messageIds: parseMessageIds(row.message_ids_json),
    payloadDigest: row.payload_digest,
    status: row.status,
    updatedAtMs: safeInteger(row.updated_at_ms),
  };
}

export function createD1TelegramAnnouncementRepository(
  db: D1Database,
): TelegramAnnouncementRepository {
  const get = async (requestId: string) => {
    try {
      const row = await db
        .prepare(
          `SELECT payload_digest, status, message_ids_json,
                  created_at_ms, updated_at_ms
           FROM telegram_event_prize_announcements
           WHERE request_id = ?`,
        )
        .bind(requestId)
        .first<AnnouncementRow>();
      return row ? decodeAnnouncement(row) : null;
    } catch (error) {
      if (error instanceof TelegramD1Failure) throw error;
      throw new TelegramD1Failure();
    }
  };
  return {
    get,
    async reserve(input) {
      try {
        const result = await db
          .prepare(
            `INSERT INTO telegram_event_prize_announcements (
               request_id, payload_digest, status, message_ids_json,
               created_at_ms, updated_at_ms
             ) VALUES (?, ?, 'sending', NULL, ?, ?)
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
        throw new TelegramD1Failure();
      }
    },
    async storeOutcome(input) {
      try {
        const result = await db
          .prepare(
            `UPDATE telegram_event_prize_announcements
             SET status = ?, message_ids_json = ?, updated_at_ms = ?
             WHERE request_id = ? AND payload_digest = ? AND status = 'sending'`,
          )
          .bind(
            input.status,
            input.messageIds ? JSON.stringify(input.messageIds) : null,
            input.updatedAtMs,
            input.requestId,
            input.payloadDigest,
          )
          .run();
        return result.meta.changes === 1;
      } catch {
        throw new TelegramD1Failure();
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
