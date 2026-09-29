import type { AutomatchProjectionPort } from "../gameSessionContracts.ts";
import {
  decideAutomatchProfileOutboxCompletion,
  parseAutomatchProfileGameProjectionOutbox,
} from "../profileGameProjectionOutbox.ts";
import { STATE_VALUE_FIELD } from "../stateCompatibility.ts";
import { parseAutomatchTelegramProjectionOutbox } from "../telegramProjectionOutbox.ts";
import {
  encodeValue,
  requireKey,
  requireRoot,
  resolveAutomatchServerValues,
  timestamp,
  validateAutomatchJson,
} from "./codec.ts";
import type { createAutomatchReads } from "./reads.ts";
import { AutomatchD1Failure, type AutomatchRoot } from "./types.ts";

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
  ): Promise<Result> {
    const resolvedAtMs = now();
    const { table, valueColumn, revisionColumn } = requireRoot(root);
    for (let attempt = 0; attempt < 25; attempt++) {
      const current = await read(root, inviteId, signal);
      const decision = decide(current.value);
      if (decision.write === undefined) return decision.result;
      timestamp(resolvedAtMs);
      let expression = "NULL";
      const values: Array<string | number | null> = [];
      if (decision.write !== null) {
        const next = { ...toRecord(current.value), ...decision.write };
        validateAutomatchJson(next);
        if (hasServerValues(next)) {
          expression = "?";
          values.push(
            encodeValue(
              resolveAutomatchServerValues(next, current.value, resolvedAtMs),
            ),
          );
        } else {
          const fields = Object.entries(decision.write);
          expression = `json_set(${valueColumn}, ${fields
            .map(
              ([key, value]) =>
                `'$.${key}', ${typeof value === "number" ? "?" : "json(?)"}`,
            )
            .join(", ")})`;
          values.push(
            ...fields.map(([, value]) =>
              typeof value === "number" ? value : JSON.stringify(value),
            ),
          );
        }
      }
      const guards = buildWriteGuardStatements();
      if (!Number.isSafeInteger(current.revision + 1))
        throw new TypeError("invalid-automatch-revision");
      const updatedAtMs = timestamp(now());
      signal?.throwIfAborted();
      const results = await db.batch<{ record_key: string }>([
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
          .bind(...values, updatedAtMs, inviteId, current.revision, requestId),
      ]);
      if (results[results.length - 1].results.length > 0)
        return decision.result;
    }
    throw new AutomatchD1Failure("automatch-transaction-contention");
  }

  return {
    claimAutomatchProfileOutbox: (
      inviteId,
      requestId,
      expectedLastQueuedAtMs,
      nowMs,
      signal,
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
