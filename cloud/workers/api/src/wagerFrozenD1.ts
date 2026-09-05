import {
  createEmptyMaterials,
  isMiningMaterials,
  MATERIAL_KEYS,
  type MiningMaterials,
} from "@mons/shared/mining";
import {
  frozenOperationState,
  parseFrozenOperation,
} from "./wagerFrozenRecords.ts";
import {
  assertWagerFrozenKey,
  storedWagerFrozenOperation,
  type WagerFrozenBalance,
  type WagerFrozenSnapshot,
  type WagerFrozenStore,
} from "./wagerFrozenStore.ts";

const MAX_TRANSACTION_ATTEMPTS = 25;
const EMPTY_FROZEN_JSON = JSON.stringify(createEmptyMaterials());

type BalanceRow = { frozen_json: string; revision: number };
type ReservationRow = {
  frozen_json: string | null;
  revision: number | null;
  record_json: string | null;
};

export type WagerFrozenD1Options = {
  writeGuards: () => readonly D1PreparedStatement[];
  now?: () => number;
};

function assertMaterials(value: unknown): asserts value is MiningMaterials {
  if (
    !isMiningMaterials(value) ||
    MATERIAL_KEYS.some((key) => !Number.isSafeInteger(value[key]))
  ) {
    throw new Error("wager-operation-unavailable");
  }
}

function decodeBalance(row: BalanceRow | null): WagerFrozenBalance {
  if (!row) return { frozen: createEmptyMaterials(), revision: 0 };
  const frozen: unknown = JSON.parse(row.frozen_json);
  assertMaterials(frozen);
  if (!Number.isSafeInteger(row.revision) || row.revision <= 0) {
    throw new Error("wager-operation-unavailable");
  }
  return { frozen, revision: row.revision };
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("wager_frozen_revision_guard") ||
      isRevisionConflict(error.cause))
  );
}

export function createWagerFrozenD1Store(
  db: D1Database,
  { writeGuards, now = Date.now }: WagerFrozenD1Options,
): WagerFrozenStore {
  if (typeof writeGuards !== "function") {
    throw new TypeError("wager-frozen-write-guards-required");
  }
  const read = async (playerUid: string, operationId: string) => {
    assertWagerFrozenKey(playerUid);
    assertWagerFrozenKey(operationId);
    const row = await db
      .withSession("first-primary")
      .prepare(
        `SELECT balance.frozen_json, balance.revision, operation.record_json
         FROM (SELECT ? AS player_uid) AS requested
         LEFT JOIN wager_frozen_balances AS balance
           ON balance.player_uid = requested.player_uid
         LEFT JOIN wager_frozen_operations AS operation
           ON operation.player_uid = requested.player_uid
          AND operation.operation_id = ?`,
      )
      .bind(playerUid, operationId)
      .first<ReservationRow>();
    if (!row || (row.revision === null && row.record_json !== null)) {
      throw new Error("wager-operation-unavailable");
    }
    const balance = decodeBalance(
      row.revision === null
        ? null
        : {
            frozen_json: row.frozen_json as string,
            revision: row.revision,
          },
    );
    let raw: unknown = null;
    if (row.record_json !== null) {
      try {
        raw = JSON.parse(row.record_json);
      } catch {
        throw new Error("wager-operation-unavailable");
      }
    }
    const value: WagerFrozenSnapshot = {
      frozen: balance.frozen,
      operation: frozenOperationState(
        row.record_json === null ? undefined : raw,
      ),
    };
    return { value, revision: balance.revision };
  };
  return {
    async readBalance(playerUid) {
      assertWagerFrozenKey(playerUid);
      return decodeBalance(
        await db
          .withSession("first-primary")
          .prepare(
            `SELECT frozen_json, revision FROM wager_frozen_balances
           WHERE player_uid = ?`,
          )
          .bind(playerUid)
          .first<BalanceRow>(),
      );
    },
    async read(playerUid, operationId) {
      return (await read(playerUid, operationId)).value;
    },
    async transact(playerUid, operationId, update, signal) {
      for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
        signal?.throwIfAborted();
        const current = await read(playerUid, operationId);
        signal?.throwIfAborted();
        const decision = update(current.value);
        if ("commit" in decision) {
          return {
            committed: false,
            decision: decision.decision,
            value: current.value,
          };
        }
        const next = decision.value;
        assertMaterials(next.frozen);
        const operation = storedWagerFrozenOperation(next.operation);
        if (
          next.operation.status === "active" &&
          !parseFrozenOperation(operation)
        ) {
          throw new Error("wager-operation-unavailable");
        }
        const revision = current.revision + 1;
        const updatedAtMs = now();
        if (
          !Number.isSafeInteger(revision) ||
          !Number.isSafeInteger(updatedAtMs) ||
          updatedAtMs < 0
        ) {
          throw new Error("wager-operation-unavailable");
        }
        const guard = db
          .prepare(
            `INSERT INTO wager_frozen_balances
             (player_uid, frozen_json, revision, updated_at_ms)
           SELECT ?, ?, 0, 0
           WHERE ${
             current.revision === 0
               ? "EXISTS (SELECT 1 FROM wager_frozen_balances WHERE player_uid = ?)"
               : "NOT EXISTS (SELECT 1 FROM wager_frozen_balances WHERE player_uid = ? AND revision = ?)"
           }`,
          )
          .bind(
            playerUid,
            EMPTY_FROZEN_JSON,
            playerUid,
            ...(current.revision === 0 ? [] : [current.revision]),
          );
        const balanceWrite =
          current.revision === 0
            ? db
                .prepare(
                  `INSERT INTO wager_frozen_balances
               (player_uid, frozen_json, revision, updated_at_ms)
             VALUES (?, ?, ?, ?)`,
                )
                .bind(
                  playerUid,
                  JSON.stringify(next.frozen),
                  revision,
                  updatedAtMs,
                )
            : db
                .prepare(
                  `UPDATE wager_frozen_balances
             SET frozen_json = ?, revision = ?, updated_at_ms = MAX(updated_at_ms, ?)
             WHERE player_uid = ?`,
                )
                .bind(
                  JSON.stringify(next.frozen),
                  revision,
                  updatedAtMs,
                  playerUid,
                );
        const operationWrite =
          operation === null
            ? db
                .prepare(
                  "DELETE FROM wager_frozen_operations WHERE player_uid = ? AND operation_id = ?",
                )
                .bind(playerUid, operationId)
            : db
                .prepare(
                  `INSERT INTO wager_frozen_operations (player_uid, operation_id, record_json)
             VALUES (?, ?, ?)
             ON CONFLICT (player_uid, operation_id) DO UPDATE SET record_json = excluded.record_json`,
                )
                .bind(playerUid, operationId, JSON.stringify(operation));
        signal?.throwIfAborted();
        try {
          await db.batch([
            ...writeGuards(),
            guard,
            balanceWrite,
            operationWrite,
          ]);
          return { committed: true, decision: decision.decision, value: next };
        } catch (error) {
          if (!isRevisionConflict(error)) throw error;
        }
      }
      throw new Error("wager-operation-unavailable");
    },
  };
}
