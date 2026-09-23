import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";
import { runOptimisticTransaction } from "./optimisticTransaction.ts";
const MAX_TRANSACTION_ATTEMPTS = 12;

type JsonRow = {
  record_json: string;
  version: number;
};

export type EventPrizeWithdrawalStorageMode = "d1" | "frozen";

export type EventPrizeWithdrawalRecord = {
  read(): Promise<Record<string, unknown> | null>;
  transaction(
    updater: (
      current: Record<string, unknown> | null,
    ) => TransactionDecision<Record<string, unknown>>,
  ): Promise<TransactionResult<Record<string, unknown>>>;
};
export type EventPrizeWithdrawalReplacement = {
  eventId: string;
  prizeId: string;
  value: Record<string, unknown> | null;
};
export type EventPrizeWithdrawalStore = {
  get(
    eventId: string,
    prizeId: string,
  ): Promise<Record<string, unknown> | null>;
  record(eventId: string, prizeId: string): EventPrizeWithdrawalRecord;
  replaceRecords(
    records: readonly EventPrizeWithdrawalReplacement[],
  ): Promise<void>;
};

export type EventPrizeWithdrawalStorageControl = {
  previousStorageMode: "d1" | null;
  storageMode: EventPrizeWithdrawalStorageMode;
};

export type EventPrizeWithdrawalEventReader = (
  eventId: string,
) => Promise<Record<string, Record<string, unknown>>>;

export class EventPrizeWithdrawalD1Failure extends Error {
  constructor(
    message = "event-prize-withdrawal-d1-unavailable",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanKey(value: string): string {
  return value.trim() === value && value.length > 0 && !value.includes("/")
    ? value
    : "";
}

function safeVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EventPrizeWithdrawalD1Failure();
  }
  return value;
}

function normalizeRecord(
  eventId: string,
  prizeId: string,
  value: unknown,
): Record<string, unknown> {
  const withdrawal = record(value);
  if (
    !withdrawal ||
    withdrawal.eventId !== eventId ||
    withdrawal.prizeId !== prizeId ||
    !["blocked", "completed", "processing", "submitted"].includes(
      String(withdrawal.status),
    )
  ) {
    throw new EventPrizeWithdrawalD1Failure(
      "invalid-event-prize-withdrawal-record",
    );
  }
  return withdrawal;
}

function encodeRecord(
  eventId: string,
  prizeId: string,
  value: unknown,
): string {
  try {
    return JSON.stringify(normalizeRecord(eventId, prizeId, value));
  } catch (error) {
    if (error instanceof EventPrizeWithdrawalD1Failure) throw error;
    throw new EventPrizeWithdrawalD1Failure(
      "invalid-event-prize-withdrawal-record",
      { cause: error },
    );
  }
}

function decodeRecord(
  eventId: string,
  prizeId: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new EventPrizeWithdrawalD1Failure();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new EventPrizeWithdrawalD1Failure(undefined, { cause: error });
  }
  return normalizeRecord(eventId, prizeId, parsed);
}

function updatedAtMs(
  value: Record<string, unknown>,
  now: () => number,
): number {
  const stored = Number(value.updatedAtMs);
  const candidate = Number.isSafeInteger(stored) && stored > 0 ? stored : now();
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new EventPrizeWithdrawalD1Failure();
  }
  return candidate;
}

async function readRow(
  db: D1Database,
  eventId: string,
  prizeId: string,
): Promise<{ record: Record<string, unknown>; version: number } | null> {
  try {
    const row = await db
      .prepare(
        `SELECT record_json, version
         FROM event_prize_withdrawals
         WHERE event_id = ? AND prize_id = ?`,
      )
      .bind(eventId, prizeId)
      .first<JsonRow>();
    return row
      ? {
          record: decodeRecord(eventId, prizeId, row.record_json),
          version: safeVersion(row.version),
        }
      : null;
  } catch (error) {
    if (error instanceof EventPrizeWithdrawalD1Failure) throw error;
    throw new EventPrizeWithdrawalD1Failure(undefined, { cause: error });
  }
}

async function transactRow(
  db: D1Database,
  eventId: string,
  prizeId: string,
  updater: (
    current: Record<string, unknown> | null,
  ) => TransactionDecision<Record<string, unknown>>,
  now: () => number,
): Promise<TransactionResult<Record<string, unknown>>> {
  return runOptimisticTransaction({
    maxAttempts: MAX_TRANSACTION_ATTEMPTS,
    read: () => readRow(db, eventId, prizeId),
    getValue: (current) => current?.record ?? null,
    decide: updater,
    async write(current, next) {
      if (next === null) {
        if (!current) return { applied: true, value: null };
        const deleted = await db
          .prepare(
            `DELETE FROM event_prize_withdrawals
           WHERE event_id = ? AND prize_id = ? AND version = ?`,
          )
          .bind(eventId, prizeId, current.version)
          .run();
        return { applied: deleted.meta.changes > 0, value: null };
      }
      const normalized = normalizeRecord(eventId, prizeId, next);
      const encoded = encodeRecord(eventId, prizeId, normalized);
      const timestamp = updatedAtMs(normalized, now);
      if (!current) {
        const inserted = await db
          .prepare(
            `INSERT INTO event_prize_withdrawals (
             event_id, prize_id, record_json, version, updated_at_ms
           ) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (event_id, prize_id) DO NOTHING`,
          )
          .bind(eventId, prizeId, encoded, timestamp)
          .run();
        return { applied: inserted.meta.changes > 0, value: normalized };
      }
      const updated = await db
        .prepare(
          `UPDATE event_prize_withdrawals
         SET record_json = ?, version = version + 1, updated_at_ms = ?
         WHERE event_id = ? AND prize_id = ? AND version = ?`,
        )
        .bind(encoded, timestamp, eventId, prizeId, current.version)
        .run();
      return { applied: updated.meta.changes > 0, value: normalized };
    },
    conflictError: () =>
      new EventPrizeWithdrawalD1Failure("event-prize-withdrawal-d1-conflict"),
  });
}

export async function readEventPrizeWithdrawalStorageMode(
  db: D1Database,
): Promise<EventPrizeWithdrawalStorageMode> {
  return (await readEventPrizeWithdrawalStorageControl(db)).storageMode;
}

export async function readEventPrizeWithdrawalStorageControl(
  db: D1Database,
): Promise<EventPrizeWithdrawalStorageControl> {
  try {
    const row = await db
      .prepare(
        `SELECT storage_mode, previous_storage_mode
         FROM event_prize_withdrawal_runtime_control
         WHERE singleton = 1`,
      )
      .first<{ previous_storage_mode: string | null; storage_mode: string }>();
    if (row?.storage_mode === "d1" || row?.storage_mode === "frozen") {
      if (
        row.previous_storage_mode !== null &&
        row.previous_storage_mode !== "d1"
      ) {
        throw new EventPrizeWithdrawalD1Failure(
          "invalid-event-prize-withdrawal-storage-mode",
        );
      }
      const previousStorageMode =
        row.previous_storage_mode === "d1" ? "d1" : null;
      if (
        (row.storage_mode === "d1" && previousStorageMode !== null) ||
        (row.storage_mode === "frozen" && previousStorageMode !== "d1")
      ) {
        throw new EventPrizeWithdrawalD1Failure(
          "invalid-event-prize-withdrawal-storage-mode",
        );
      }
      return { storageMode: row.storage_mode, previousStorageMode };
    }
    throw new EventPrizeWithdrawalD1Failure(
      "invalid-event-prize-withdrawal-storage-mode",
    );
  } catch (error) {
    if (error instanceof EventPrizeWithdrawalD1Failure) throw error;
    throw new EventPrizeWithdrawalD1Failure(undefined, { cause: error });
  }
}

export function createD1EventPrizeWithdrawalReader(
  db: D1Database,
): EventPrizeWithdrawalEventReader {
  return async (eventId) => {
    const normalizedEventId = cleanKey(eventId);
    if (!normalizedEventId) {
      throw new EventPrizeWithdrawalD1Failure(
        "invalid-event-prize-withdrawal-identity",
      );
    }
    try {
      const result = await db
        .prepare(
          `SELECT prize_id, record_json
           FROM event_prize_withdrawals
           WHERE event_id = ?
           ORDER BY prize_id`,
        )
        .bind(normalizedEventId)
        .all<{ prize_id: string; record_json: string }>();
      return Object.fromEntries(
        result.results.map((row) => [
          row.prize_id,
          decodeRecord(normalizedEventId, row.prize_id, row.record_json),
        ]),
      );
    } catch (error) {
      if (error instanceof EventPrizeWithdrawalD1Failure) throw error;
      throw new EventPrizeWithdrawalD1Failure(undefined, { cause: error });
    }
  };
}

export function createD1EventPrizeWithdrawalStore(
  db: D1Database,
  { now = Date.now }: { now?: () => number } = {},
): EventPrizeWithdrawalStore {
  const replaceRecords = async (
    records: readonly EventPrizeWithdrawalReplacement[],
  ) => {
    const statements = records.map(({ eventId, prizeId, value }) => {
      const identity = {
        eventId: cleanKey(eventId),
        prizeId: cleanKey(prizeId),
      };
      if (!identity.eventId || !identity.prizeId) {
        throw new EventPrizeWithdrawalD1Failure(
          "invalid-event-prize-withdrawal-identity",
        );
      }
      if (value === null) {
        return db
          .prepare(
            `DELETE FROM event_prize_withdrawals
             WHERE event_id = ? AND prize_id = ?`,
          )
          .bind(identity.eventId, identity.prizeId);
      }
      const normalized = normalizeRecord(
        identity.eventId,
        identity.prizeId,
        value,
      );
      return db
        .prepare(
          `INSERT INTO event_prize_withdrawals (
             event_id, prize_id, record_json, version, updated_at_ms
           ) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (event_id, prize_id) DO UPDATE SET
             record_json = excluded.record_json,
             version = event_prize_withdrawals.version + 1,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(
          identity.eventId,
          identity.prizeId,
          encodeRecord(identity.eventId, identity.prizeId, normalized),
          updatedAtMs(normalized, now),
        );
    });
    if (statements.length > 0) await db.batch(statements);
  };
  return {
    async get(eventId, prizeId) {
      const normalizedEventId = cleanKey(eventId);
      const normalizedPrizeId = cleanKey(prizeId);
      if (!normalizedEventId || !normalizedPrizeId) {
        throw new EventPrizeWithdrawalD1Failure(
          "invalid-event-prize-withdrawal-identity",
        );
      }
      return (
        (await readRow(db, normalizedEventId, normalizedPrizeId))?.record ??
        null
      );
    },
    record(eventId, prizeId) {
      const normalizedEventId = cleanKey(eventId);
      const normalizedPrizeId = cleanKey(prizeId);
      if (!normalizedEventId || !normalizedPrizeId) {
        throw new EventPrizeWithdrawalD1Failure(
          "invalid-event-prize-withdrawal-identity",
        );
      }
      return {
        read() {
          return createD1EventPrizeWithdrawalStore(db, { now }).get(
            normalizedEventId,
            normalizedPrizeId,
          );
        },
        transaction(updater) {
          return transactRow(
            db,
            normalizedEventId,
            normalizedPrizeId,
            updater,
            now,
          );
        },
      };
    },
    replaceRecords,
  };
}

export { MAX_TRANSACTION_ATTEMPTS };
