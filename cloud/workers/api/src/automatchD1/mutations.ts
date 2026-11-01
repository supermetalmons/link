import type { AutomatchD1StoreOptions } from "./options.ts";
import {
  parseAutomatchRecord,
  type AutomatchRecordMap,
} from "../../../../runtime/automatchRecords.js";
import type { GameSessionChange } from "../gameSessionContracts.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "../repositoryContracts.ts";
import { runOptimisticTransaction } from "../optimisticTransaction.ts";
import {
  AutomatchD1Failure,
  type AutomatchRecordMutation,
  type AutomatchRoot,
} from "./types.ts";
import {
  encodeValue,
  createAutomatchMutation,
  isAutomatchRevisionConflict,
  requireKey,
  requireRoot,
  timestamp,
} from "./codec.ts";
import {
  resolveSessionCounter,
  resolveSessionTimestamp,
} from "../sessionValueOperations.ts";
import type { createAutomatchReads } from "./reads.ts";

type MutationEvidence = AutomatchRecordMutation;

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

  function buildWriteGuardStatements(): D1PreparedStatement[] {
    if (!writeGuards) throw new AutomatchD1Failure("automatch-state-read-only");
    return [...writeGuards(), backendGuard()];
  }

  function revisionGuards(
    mutations: readonly MutationEvidence[],
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
      parseAutomatchRecord(current.root, value);
      encodeValue(value);
      return db
        .prepare(
          `INSERT INTO automatch_revision_guards (singleton)
         SELECT 0 WHERE COALESCE((SELECT ${revisionColumn} FROM ${table} WHERE record_key = ?), 0) != ?`,
        )
        .bind(current.key, current.revision);
    });
  }

  function commitStatements(
    mutations: readonly MutationEvidence[],
    nowMs = now(),
  ): D1PreparedStatement[] {
    timestamp(nowMs);
    return [
      ...(writeGuards?.() || []),
      backendGuard(),
      ...revisionGuards(mutations),
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

  function buildRevisionGuardStatements(
    mutations: readonly AutomatchRecordMutation[],
  ) {
    return revisionGuards(mutations);
  }

  function buildCommitStatements(
    mutations: readonly AutomatchRecordMutation[],
    nowMs = now(),
  ) {
    return commitStatements(mutations, nowMs);
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
      const current = snapshots[index]!;
      let value: unknown = current.value;
      for (const planned of changes) {
        const change = structuredClone(planned);
        if (change.kind === "mutation-receipt") {
          const receipt =
            root === "gameplayMutationReceipts"
              ? change.value
              : change.expiration;
          value = {
            ...receipt,
            completedAtMs: resolveSessionTimestamp(
              receipt.completedAtMs,
              nowMs,
            ),
          };
        } else if (change.kind === "profile-outbox-merge") {
          const previous = parseAutomatchRecord(
            "profileGameProjectionOutbox/automatch",
            value,
          );
          const metadata = parseAutomatchRecord(
            "profileGameProjectionOutbox/automatch",
            {
              ...change.value,
              sourceUpdatedAtMs: resolveSessionTimestamp(
                change.value.sourceUpdatedAtMs,
                nowMs,
              ),
              lastQueuedAtMs: resolveSessionTimestamp(
                change.value.lastQueuedAtMs,
                nowMs,
              ),
            },
          );
          if (metadata?.status !== "pending")
            throw new TypeError("invalid-profile-projection-request");
          const pending = previous?.status === "pending" ? previous : null;
          const historicalMatches = {
            ...pending?.historicalMatches,
            ...change.value.historicalMatches,
            ...change.historicalMatches,
          };
          for (const [matchId, descriptor] of Object.entries(
            historicalMatches,
          )) {
            const existing = pending?.historicalMatches[matchId];
            if (
              existing &&
              existing.hostPlayerId === descriptor.hostPlayerId &&
              existing.guestPlayerId === descriptor.guestPlayerId &&
              existing.finalizedAtMs === descriptor.finalizedAtMs &&
              existing.source === descriptor.source &&
              existing.retryNotBeforeMs !== null &&
              descriptor.retryNotBeforeMs === null
            )
              historicalMatches[matchId] = {
                ...descriptor,
                retryNotBeforeMs: existing.retryNotBeforeMs,
              };
          }
          value = {
            ...metadata,
            historicalMatches,
            archiveRetry:
              pending?.requestId === change.value.requestId
                ? pending.archiveRetry
                : null,
          };
        } else if (change.kind === "telegram-source-merge") {
          const previous = parseAutomatchRecord("telegramAutomatches", value);
          value = {
            ...previous,
            ...change.value,
            ...(change.value.updatedAtMs === undefined
              ? {}
              : {
                  updatedAtMs: resolveSessionTimestamp(
                    change.value.updatedAtMs,
                    nowMs,
                  ),
                }),
            ...(change.value.generation === undefined
              ? {}
              : {
                  generation: resolveSessionCounter(
                    change.value.generation,
                    parseAutomatchRecord("telegramAutomatches", current.value)
                      ?.generation,
                  ),
                }),
          };
        } else if (change.kind === "automatch-entry") {
          value =
            change.value === null
              ? null
              : {
                  ...change.value,
                  timestamp: resolveSessionTimestamp(
                    change.value.timestamp,
                    nowMs,
                  ),
                };
        } else if (change.kind === "telegram-source") {
          value = {
            ...change.value,
            createdAtMs: resolveSessionTimestamp(
              change.value.createdAtMs,
              nowMs,
            ),
            updatedAtMs: resolveSessionTimestamp(
              change.value.updatedAtMs,
              nowMs,
            ),
          };
        } else if (change.kind === "telegram-outbox") {
          value =
            change.value === null
              ? null
              : {
                  ...change.value,
                  updatedAtMs: resolveSessionTimestamp(
                    change.value.updatedAtMs,
                    nowMs,
                  ),
                };
        } else if (change.kind === "profile-outbox") {
          value =
            change.value === null
              ? null
              : {
                  ...change.value,
                  sourceUpdatedAtMs: resolveSessionTimestamp(
                    change.value.sourceUpdatedAtMs,
                    nowMs,
                  ),
                  lastQueuedAtMs: resolveSessionTimestamp(
                    change.value.lastQueuedAtMs,
                    nowMs,
                  ),
                };
        }
      }
      return createAutomatchMutation(current, value);
    });
  }

  async function transactRecord<Root extends AutomatchRoot>(
    root: Root,
    key: string,
    update: (
      current: AutomatchRecordMap[Root] | null,
    ) => TransactionDecision<AutomatchRecordMap[Root]>,
    signal?: AbortSignal,
  ): Promise<TransactionResult<AutomatchRecordMap[Root]>> {
    return runOptimisticTransaction({
      maxAttempts: 25,
      read: () => read(root, key, signal),
      getValue: (current) => current.value,
      decide(current) {
        const decision = update(structuredClone(current));
        return "commit" in decision
          ? decision
          : { ...decision, value: parseAutomatchRecord(root, decision.value) };
      },
      async write(current, next) {
        return {
          applied: await commit(
            [createAutomatchMutation(current, next)],
            signal,
          ),
          value: next,
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
          `UPDATE game_session_mutation_receipts_canonical
           SET payload_json = NULL, revision = revision + 1,
             expiration_json = NULL, expiration_revision = expiration_revision + 1,
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE record_key IN (
             SELECT receipt.record_key FROM game_session_mutation_receipts_canonical AS receipt
             WHERE expiration_json IS NOT NULL
               AND json_type(expiration_json, '$.completedAtMs') IN ('integer', 'real')
               AND json_extract(expiration_json, '$.completedAtMs') <= ?
               AND NOT EXISTS (
                 SELECT 1 FROM game_session_transition_resources_canonical AS resource
                 WHERE resource.resource_key = 'gameplay-operation:' || receipt.record_key
               )
             ORDER BY json_extract(expiration_json, '$.completedAtMs'), record_key
             LIMIT ?
           ) RETURNING record_key`,
        )
        .bind(timestamp(now()), cutoffMs, limit),
    ]);
    return results[results.length - 1]!.results.length;
  }

  return {
    buildWriteGuardStatements,
    buildRevisionGuardStatements,
    buildCommitStatements,
    commit,
    prepareChanges,
    transactRecord,
    expireReceipts,
  };
}
