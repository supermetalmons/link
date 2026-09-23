import type { GameSessionChange } from "../gameSessionContracts.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "../repositoryContracts.ts";
import { validateTelegramTransactionDecision } from "../telegramTransaction.ts";
import { runOptimisticTransaction } from "../optimisticTransaction.ts";
import {
  AutomatchD1Failure,
  type AutomatchRecordMutation,
  type AutomatchRoot,
  type AutomatchD1StoreOptions,
} from "./types.ts";
import {
  encodeValue,
  isAutomatchRevisionConflict,
  nestedValue,
  requireKey,
  requireRoot,
  resolveAutomatchServerValues,
  setNested,
  timestamp,
} from "./codec.ts";
import type { createAutomatchReads } from "./reads.ts";

export function createAutomatchMutations(
  db: D1Database,
  { now = Date.now, writeGuards }: AutomatchD1StoreOptions,
  {
    read,
    readMutationRecords,
  }: Pick<
    ReturnType<typeof createAutomatchReads>,
    "read" | "readMutationRecords"
  >,
) {
  const backendGuard = () =>
    db.prepare(
      `INSERT INTO automatch_write_guards (singleton)
       SELECT 0 WHERE NOT EXISTS (
         SELECT 1 FROM automatch_runtime_control
         WHERE singleton = 1 AND backend = 'd1'
       )`,
    );

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
    return runOptimisticTransaction({
      maxAttempts: 25,
      async read() {
        const current = await read(root, key, signal);
        return { record: current.value, version: current.revision };
      },
      getValue: (current) => current.record,
      decide(current) {
        const decision = validateTelegramTransactionDecision(
          update(structuredClone(current)),
        );
        return decision.commit
          ? { value: decision.value, decision: decision.decision }
          : { commit: false, decision: decision.decision };
      },
      async write(current, next) {
        const snapshot = {
          root,
          key,
          value: current.record,
          revision: current.version,
        };
        const value = resolveAutomatchServerValues(next, snapshot.value, nowMs);
        return {
          applied: await commit([{ current: snapshot, value }], signal),
          value,
        };
      },
      conflictError: () =>
        new AutomatchD1Failure("automatch-transaction-contention"),
    });
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
    buildRevisionGuardStatements,
    buildCommitStatements,
    commit,
    prepareChanges,
    transactRecord,
    expireReceipts,
  };
}
