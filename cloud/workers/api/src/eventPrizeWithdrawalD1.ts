import type {
  TransactionDecision,
  TransactionResult,
} from "./repositoryContracts.ts";
import { runOptimisticTransaction } from "./optimisticTransaction.ts";
import { createVersionedJsonRowStore } from "./versionedJsonD1.ts";
import {
  readStoredWithdrawalDocument,
  storedWithdrawalMatchesIdentity,
  withdrawalStorageUpdatedAtMs,
  type WithdrawalDocument,
} from "../../../runtime/eventPrizes/records.js";
import type {
  WithdrawalRecord,
  WithdrawalStore,
} from "../../../runtime/eventPrizes/types.js";
import type { WithdrawalStorage } from "../../../runtime/eventPrizes/storage.js";
import { createWithdrawalRecordCommands } from "../../../runtime/eventPrizes/withdrawalRepository.js";
const MAX_TRANSACTION_ATTEMPTS = 12;

export type EventPrizeWithdrawalStorageMode = "d1" | "frozen";

export type EventPrizeWithdrawalRecord = WithdrawalRecord;
export type EventPrizeWithdrawalReplacement = {
  eventId: string;
  prizeId: string;
  value: WithdrawalDocument | null;
};
export type EventPrizeWithdrawalStore = WithdrawalStore;

export type EventPrizeWithdrawalStorageControl = {
  previousStorageMode: "d1" | null;
  storageMode: EventPrizeWithdrawalStorageMode;
};

export type EventPrizeWithdrawalEventReader = (
  eventId: string,
) => Promise<Record<string, WithdrawalDocument>>;

export class EventPrizeWithdrawalD1Failure extends Error {
  constructor(
    message = "event-prize-withdrawal-d1-unavailable",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
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
): WithdrawalDocument {
  const withdrawal = readStoredWithdrawalDocument(value);
  if (
    !withdrawal ||
    !storedWithdrawalMatchesIdentity(withdrawal, eventId, prizeId)
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
): WithdrawalDocument {
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

function updatedAtMs(value: WithdrawalDocument, now: () => number): number {
  const stored = withdrawalStorageUpdatedAtMs(value);
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
): Promise<{ record: WithdrawalDocument; version: number } | null> {
  try {
    const row = await createVersionedJsonRowStore(db, {
      table: "event_prize_withdrawals",
      key: [eventId, prizeId],
    }).read();
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
    current: WithdrawalDocument | null,
  ) => TransactionDecision<WithdrawalDocument>,
  now: () => number,
): Promise<TransactionResult<WithdrawalDocument>> {
  const rows = createVersionedJsonRowStore(db, {
    table: "event_prize_withdrawals",
    key: [eventId, prizeId],
  });
  return runOptimisticTransaction({
    maxAttempts: MAX_TRANSACTION_ATTEMPTS,
    read: () => readRow(db, eventId, prizeId),
    getValue: (current) => current?.record ?? null,
    decide: updater,
    async write(current, next) {
      if (next === null) {
        if (!current) return { applied: true, value: null };
        const changes = await rows.deleteIfVersion(current.version);
        return { applied: changes > 0, value: null };
      }
      const normalized = normalizeRecord(eventId, prizeId, next);
      const encoded = encodeRecord(eventId, prizeId, normalized);
      const timestamp = updatedAtMs(normalized, now);
      if (!current) {
        const changes = await rows.insertIfAbsent(encoded, timestamp);
        return { applied: changes > 0, value: normalized };
      }
      const changes = await rows.updateIfVersion(
        current.version,
        encoded,
        timestamp,
      );
      return { applied: changes > 0, value: normalized };
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

export function createD1EventPrizeWithdrawalStorage(
  db: D1Database,
  { now = Date.now }: { now?: () => number } = {},
): WithdrawalStorage {
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
          return createD1EventPrizeWithdrawalStorage(db, { now }).get(
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

export function createD1EventPrizeWithdrawalStore(
  db: D1Database,
  options: { now?: () => number } = {},
): EventPrizeWithdrawalStore {
  const storage = createD1EventPrizeWithdrawalStorage(db, options);
  return {
    get: storage.get,
    record: (eventId, prizeId) =>
      createWithdrawalRecordCommands(storage.record(eventId, prizeId)),
    replaceCompleted: (records) => storage.replaceRecords(records),
  };
}

export { MAX_TRANSACTION_ATTEMPTS };
