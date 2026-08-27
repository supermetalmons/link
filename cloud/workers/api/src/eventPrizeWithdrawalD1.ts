const EVENT_PRIZE_WITHDRAWAL_ROOT = "eventPrizeWithdrawals";
const MAX_TRANSACTION_ATTEMPTS = 12;

type JsonRow = {
  record_json: string;
  version: number;
};

export type EventPrizeWithdrawalStorageMode = "d1" | "frozen";

export type EventPrizeWithdrawalReference = {
  once(event: "value"): Promise<{ exists(): boolean; val(): unknown }>;
  transaction(
    updater: (current: unknown) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<{
    committed: boolean;
    snapshot: { exists(): boolean; val(): unknown };
  }>;
  update(updates: Record<string, unknown>): Promise<void>;
};

export type EventPrizeWithdrawalStore = {
  get(
    eventId: string,
    prizeId: string,
  ): Promise<Record<string, unknown> | null>;
  reference(eventId: string, prizeId: string): EventPrizeWithdrawalReference;
  replacePaths(updates: Record<string, unknown>): Promise<void>;
};

export type EventPrizeWithdrawalStorageControl = {
  previousStorageMode: "d1" | null;
  storageMode: EventPrizeWithdrawalStorageMode;
};

export type EventPrizeWithdrawalEventReader = (
  eventId: string,
) => Promise<Record<string, Record<string, unknown>>>;

export class EventPrizeWithdrawalD1Failure extends Error {
  constructor(message = "event-prize-withdrawal-d1-unavailable") {
    super(message);
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

function snapshot(value: unknown): { exists(): boolean; val(): unknown } {
  return {
    exists: () => value !== null && value !== undefined,
    val: () => value,
  };
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
  } catch {
    throw new EventPrizeWithdrawalD1Failure();
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

export function parseEventPrizeWithdrawalPath(
  path: string,
): { eventId: string; prizeId: string } | null {
  const parts = path.split("/");
  if (parts.length !== 3 || parts[0] !== EVENT_PRIZE_WITHDRAWAL_ROOT) {
    return null;
  }
  const eventId = cleanKey(parts[1]);
  const prizeId = cleanKey(parts[2]);
  return eventId && prizeId ? { eventId, prizeId } : null;
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
    throw new EventPrizeWithdrawalD1Failure();
  }
}

async function transactRow(
  db: D1Database,
  eventId: string,
  prizeId: string,
  updater: (current: unknown) => unknown,
  now: () => number,
): Promise<{ committed: boolean; value: unknown }> {
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const current = await readRow(db, eventId, prizeId);
    const next = updater(current?.record ?? null);
    if (next === undefined) {
      return { committed: false, value: current?.record ?? null };
    }
    if (next === null) {
      if (!current) return { committed: true, value: null };
      const deleted = await db
        .prepare(
          `DELETE FROM event_prize_withdrawals
           WHERE event_id = ? AND prize_id = ? AND version = ?`,
        )
        .bind(eventId, prizeId, current.version)
        .run();
      if (deleted.meta.changes > 0) {
        return { committed: true, value: null };
      }
      continue;
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
      if (inserted.meta.changes > 0) {
        return { committed: true, value: normalized };
      }
      continue;
    }
    const updated = await db
      .prepare(
        `UPDATE event_prize_withdrawals
         SET record_json = ?, version = version + 1, updated_at_ms = ?
         WHERE event_id = ? AND prize_id = ? AND version = ?`,
      )
      .bind(encoded, timestamp, eventId, prizeId, current.version)
      .run();
    if (updated.meta.changes > 0) {
      return { committed: true, value: normalized };
    }
  }
  throw new EventPrizeWithdrawalD1Failure("event-prize-withdrawal-d1-conflict");
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
    throw new EventPrizeWithdrawalD1Failure();
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
      throw new EventPrizeWithdrawalD1Failure();
    }
  };
}

export function createD1EventPrizeWithdrawalStore(
  db: D1Database,
  { now = Date.now }: { now?: () => number } = {},
): EventPrizeWithdrawalStore {
  const replacePaths = async (updates: Record<string, unknown>) => {
    const statements = Object.entries(updates).map(([path, value]) => {
      const identity = parseEventPrizeWithdrawalPath(path);
      if (!identity) {
        throw new EventPrizeWithdrawalD1Failure(
          "invalid-event-prize-withdrawal-path",
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
    reference(eventId, prizeId) {
      const normalizedEventId = cleanKey(eventId);
      const normalizedPrizeId = cleanKey(prizeId);
      if (!normalizedEventId || !normalizedPrizeId) {
        throw new EventPrizeWithdrawalD1Failure(
          "invalid-event-prize-withdrawal-identity",
        );
      }
      return {
        async once(event) {
          if (event !== "value") throw new TypeError("unsupported-d1-event");
          return snapshot(
            await createD1EventPrizeWithdrawalStore(db, { now }).get(
              normalizedEventId,
              normalizedPrizeId,
            ),
          );
        },
        async transaction(updater) {
          const result = await transactRow(
            db,
            normalizedEventId,
            normalizedPrizeId,
            updater,
            now,
          );
          return {
            committed: result.committed,
            snapshot: snapshot(result.value),
          };
        },
        async update(updates) {
          await transactRow(
            db,
            normalizedEventId,
            normalizedPrizeId,
            (current) => ({ ...(record(current) || {}), ...updates }),
            now,
          );
        },
      };
    },
    replacePaths,
  };
}

export { EVENT_PRIZE_WITHDRAWAL_ROOT, MAX_TRANSACTION_ATTEMPTS };
