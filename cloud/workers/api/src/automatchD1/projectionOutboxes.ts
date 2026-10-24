import type { AutomatchProjectionPort } from "../gameSessionContracts.ts";
import { runOptimisticTransaction } from "../optimisticTransaction.ts";
import {
  decideAutomatchProfileOutboxCompletion,
  parseAutomatchProfileGameProjectionOutbox,
} from "../profileGameProjectionOutbox.ts";
import { STATE_VALUE_FIELD } from "../stateCompatibility.ts";
import { parseAutomatchTelegramProjectionOutbox } from "../telegramProjectionOutbox.ts";
import {
  encodeValue,
  isAutomatchRevisionConflict,
  requireKey,
  requireRoot,
  resolveAutomatchServerValues,
  timestamp,
  validateAutomatchJson,
} from "./codec.ts";
import type { createAutomatchReads } from "./reads.ts";
import {
  AutomatchD1Failure,
  type AutomatchRoot,
  type AutomatchOutboxClaimSnapshot,
} from "./types.ts";

type ProjectionMethods = Pick<
  AutomatchProjectionPort,
  | "claimAutomatchProfileOutbox"
  | "acknowledgeAutomatchProfileOutbox"
  | "finishAutomatchProfileOutbox"
  | "claimAutomatchTelegramOutbox"
  | "acknowledgeAutomatchTelegramOutbox"
>;

type OutboxPatch = {
  lastQueuedAtMs?: number;
  updatedAtMs?: number;
  archiveRetry?: { requestId: string; notBeforeMs: number };
};

type OutboxDecision<Result> = {
  result: Result;
  write?: OutboxPatch | null;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasServerValues(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasServerValues);
  if (Object.hasOwn(value, STATE_VALUE_FIELD)) return true;
  let found = false;
  for (const [key, child] of Object.entries(value)) {
    requireKey(key);
    if (hasServerValues(child)) found = true;
  }
  return found;
}

function prepareOutboxPatch(
  valueColumn: string,
  current: unknown,
  patch: OutboxPatch | null,
  resolvedAtMs: number,
): { expression: string; values: Array<string | number | null> } {
  timestamp(resolvedAtMs);
  if (patch === null) return { expression: "NULL", values: [] };
  const next = { ...toRecord(current), ...patch };
  validateAutomatchJson(next);
  if (hasServerValues(next)) {
    return {
      expression: "?",
      values: [
        encodeValue(resolveAutomatchServerValues(next, current, resolvedAtMs)),
      ],
    };
  }
  const fields = Object.entries(patch);
  return {
    expression: `json_set(${valueColumn}, ${fields
      .map(
        ([key, value]) =>
          `'$.${key}', ${typeof value === "number" ? "?" : "json(?)"}`,
      )
      .join(", ")})`,
    values: fields.map(([, value]) =>
      typeof value === "number" ? value : JSON.stringify(value),
    ),
  };
}

export function createAutomatchProjectionOutboxes(
  db: D1Database,
  {
    read,
    now,
    buildWriteGuardStatements,
  }: Pick<ReturnType<typeof createAutomatchReads>, "read"> & {
    now: () => number;
    buildWriteGuardStatements: () => D1PreparedStatement[];
  },
): ProjectionMethods {
  async function mutate<Result>(
    root: AutomatchRoot,
    inviteId: string,
    requestId: string,
    decide: (current: unknown) => OutboxDecision<Result>,
    signal?: AbortSignal,
    initialSnapshot?: AutomatchOutboxClaimSnapshot,
  ): Promise<Result> {
    const resolvedAtMs = now();
    const { table, valueColumn, revisionColumn } = requireRoot(root);
    let availableSnapshot = initialSnapshot;
    let seededSnapshot: AutomatchOutboxClaimSnapshot | undefined;
    const transaction = await runOptimisticTransaction({
      maxAttempts: 25,
      async read() {
        const snapshot = availableSnapshot;
        availableSnapshot = undefined;
        seededSnapshot = undefined;
        if (snapshot) {
          requireKey(inviteId);
          signal?.throwIfAborted();
          try {
            if (
              snapshot.root === root &&
              snapshot.key === inviteId &&
              Number.isSafeInteger(snapshot.revision) &&
              snapshot.revision > 0 &&
              Number.isSafeInteger(snapshot.revision + 1)
            ) {
              const decision = decide(snapshot.value);
              if (decision.write !== undefined) {
                prepareOutboxPatch(
                  valueColumn,
                  snapshot.value,
                  decision.write,
                  resolvedAtMs,
                );
                seededSnapshot = snapshot;
              }
            }
          } catch {}
          signal?.throwIfAborted();
          if (seededSnapshot) return seededSnapshot;
        }
        return read(root, inviteId, signal);
      },
      getValue: (current) => decide(current.value),
      decide: (
        decision,
      ):
        | { commit: false }
        | { value: { result: Result; write: OutboxPatch | null } } =>
        decision.write === undefined
          ? { commit: false }
          : { value: { result: decision.result, write: decision.write } },
      async write(current, decision) {
        const { expression, values } = prepareOutboxPatch(
          valueColumn,
          current.value,
          decision.write,
          resolvedAtMs,
        );
        const seeded = current === seededSnapshot;
        let guards: D1PreparedStatement[];
        try {
          guards = buildWriteGuardStatements();
        } catch (error) {
          if (seeded) return { applied: false, value: decision };
          throw error;
        }
        if (!Number.isSafeInteger(current.revision + 1))
          throw new TypeError("invalid-automatch-revision");
        const updatedAtMs = timestamp(now());
        signal?.throwIfAborted();
        const revisionGuards = seeded
          ? [
              db
                .prepare(
                  `INSERT INTO automatch_revision_guards (singleton)
           SELECT 0 WHERE COALESCE((SELECT ${revisionColumn} FROM ${table} WHERE record_key = ?), 0) != ?`,
                )
                .bind(inviteId, current.revision),
            ]
          : [];
        let results: D1Result<{ record_key: string }>[];
        try {
          results = await db.batch<{ record_key: string }>([
            ...revisionGuards,
            ...guards,
            db
              .prepare(
                `UPDATE ${table}
             SET ${valueColumn} = ${expression},
               ${revisionColumn} = ${revisionColumn} + 1,
               updated_at_ms = MAX(updated_at_ms, ?)
             WHERE record_key = ? AND ${revisionColumn} = ?
               AND json_extract(${valueColumn}, '$.requestId') = ?
             RETURNING record_key`,
              )
              .bind(
                ...values,
                updatedAtMs,
                inviteId,
                current.revision,
                requestId,
              ),
          ]);
        } catch (error) {
          if (seeded && isAutomatchRevisionConflict(error))
            return { applied: false, value: decision };
          throw error;
        }
        return {
          applied: results[results.length - 1].results.length > 0,
          value: decision,
        };
      },
      conflictError: () =>
        new AutomatchD1Failure("automatch-transaction-contention"),
    });
    return transaction.value.result;
  }

  return {
    claimAutomatchProfileOutbox: (
      inviteId,
      requestId,
      expectedLastQueuedAtMs,
      nowMs,
      signal,
      snapshot,
    ) =>
      mutate(
        "profileGameProjectionOutbox/automatch",
        inviteId,
        requestId,
        (current) => {
          const outbox = parseAutomatchProfileGameProjectionOutbox(current);
          return !outbox ||
            outbox.requestId !== requestId ||
            outbox.lastQueuedAtMs !== expectedLastQueuedAtMs ||
            outbox.lastQueuedAtMs > nowMs
            ? { result: false }
            : { result: true, write: { lastQueuedAtMs: nowMs } };
        },
        signal,
        snapshot,
      ),
    acknowledgeAutomatchProfileOutbox: (inviteId, requestId, signal) =>
      mutate(
        "profileGameProjectionOutbox/automatch",
        inviteId,
        requestId,
        (current) => {
          const outbox = parseAutomatchProfileGameProjectionOutbox(current);
          return outbox?.requestId === requestId
            ? { result: true, write: null }
            : { result: false };
        },
        signal,
      ),
    finishAutomatchProfileOutbox: (inviteId, requestId, nowMs, signal) =>
      mutate(
        "profileGameProjectionOutbox/automatch",
        inviteId,
        requestId,
        (current) => {
          const decision = decideAutomatchProfileOutboxCompletion(
            current,
            requestId,
            nowMs,
          );
          return {
            result: decision.status,
            ...(decision.status === "projected"
              ? { write: null }
              : decision.status === "deferred"
                ? {
                    write: {
                      lastQueuedAtMs: nowMs,
                      archiveRetry: decision.archiveRetry,
                    },
                  }
                : {}),
          };
        },
        signal,
      ),
    claimAutomatchTelegramOutbox: (
      inviteId,
      requestId,
      expectedUpdatedAtMs,
      nowMs,
      signal,
      snapshot,
    ) =>
      mutate(
        "telegramProjectionOutbox/automatch",
        inviteId,
        requestId,
        (current) => {
          const outbox = parseAutomatchTelegramProjectionOutbox(current);
          return !outbox ||
            outbox.requestId !== requestId ||
            outbox.updatedAtMs !== expectedUpdatedAtMs ||
            outbox.updatedAtMs > nowMs
            ? { result: false }
            : { result: true, write: { updatedAtMs: nowMs } };
        },
        signal,
        snapshot,
      ),
    acknowledgeAutomatchTelegramOutbox: (inviteId, requestId, signal) =>
      mutate(
        "telegramProjectionOutbox/automatch",
        inviteId,
        requestId,
        (current) =>
          toRecord(current)?.requestId === requestId
            ? { result: true, write: null }
            : { result: false },
        signal,
      ),
  };
}
