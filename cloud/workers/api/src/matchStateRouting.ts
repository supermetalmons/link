import { requireDurableMatchState } from "./matchStateAuthority.ts";
import {
  readLegacyMatchState,
  readMatchStateControl,
  readMatchStateRoutes,
  type MatchStateControl,
} from "./matchStateD1.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import type { ReadMatchSnapshotRequest } from "@mons/shared/game-sessions";
import { MAX_MATCH_STATE_RECORD_READS } from "./matchStateTypes.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import { runMatchStateReads } from "./matchStateReadPool.ts";

export type MatchStateReadTiming = {
  attempts: number;
  authorityReads: number;
  authorityMs: number;
};

export async function readCurrentMatchState<T>(
  env: Env,
  read: (control: MatchStateControl) => Promise<T>,
  options: { signal?: AbortSignal; timing?: MatchStateReadTiming } = {},
): Promise<T> {
  let authorityStartedAt: number | null = null;
  const finishAuthorityRead = () => {
    if (options.timing && authorityStartedAt !== null) {
      options.timing.authorityMs += Date.now() - authorityStartedAt;
      authorityStartedAt = null;
    }
  };
  const readControl = async (requireDurable = false) => {
    if (options.timing) {
      authorityStartedAt = Date.now();
      options.timing.authorityReads++;
    }
    try {
      return await (requireDurable
        ? requireDurableMatchState(env.PROFILE_GAMES_DB)
        : readMatchStateControl(env.PROFILE_GAMES_DB));
    } finally {
      finishAuthorityRead();
    }
  };
  try {
    return await withReadCancellation(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        options.signal?.throwIfAborted();
        if (options.timing) options.timing.attempts++;
        const control = await readControl(true);
        options.signal?.throwIfAborted();
        let result: T;
        try {
          result = await read(control);
        } catch (error) {
          options.signal?.throwIfAborted();
          const latest = await readControl();
          options.signal?.throwIfAborted();
          if (
            latest.backend !== control.backend ||
            latest.epoch !== control.epoch
          )
            continue;
          throw error;
        }
        options.signal?.throwIfAborted();
        const latest = await readControl();
        options.signal?.throwIfAborted();
        if (
          latest.backend === control.backend &&
          latest.epoch === control.epoch
        )
          return result;
      }
      throw new Error("match-state-read-authority-changed");
    }, options.signal);
  } finally {
    finishAuthorityRead();
  }
}

export async function readMatchStateRecord(
  env: Env,
  request: ReadMatchSnapshotRequest,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<unknown> {
  return (await readMatchStateRecords(env, [request], options))[0];
}

async function withReadCancellation<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return read();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([read(), cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function readMatchStateRecords(
  env: Env,
  inputs: readonly ReadMatchSnapshotRequest[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<unknown[]> {
  signal?.throwIfAborted();
  if (!Array.isArray(inputs) || inputs.length > MAX_MATCH_STATE_RECORD_READS)
    throw new Error("match-state-invalid-read-batch");
  for (const input of inputs) {
    if (
      !input ||
      !isCanonicalLoginUid(input.playerId) ||
      !isSafeRecordKey(input.matchId)
    )
      throw new Error("match-state-invalid-read-target");
  }
  if (inputs.length === 0) return [];
  return readCurrentMatchState(
    env,
    async (control) => {
      const routes = await readMatchStateRoutes(env.PROFILE_GAMES_DB, inputs);
      signal?.throwIfAborted();
      const results: unknown[] = Array(inputs.length).fill(null);
      const rooms = new Map<
        string,
        Array<{ input: ReadMatchSnapshotRequest; index: number }>
      >();
      const reads: Array<() => Promise<void>> = [];
      for (const [index, route] of routes.entries()) {
        if (!route) continue;
        if (route.epoch !== control.epoch)
          throw new Error("match-state-route-epoch-conflict");
        const input = inputs[index];
        if (route.kind === "legacy") {
          reads.push(async () => {
            results[index] = await readLegacyMatchState(
              env.PROFILE_GAMES_DB,
              input.playerId,
              input.matchId,
              signal,
            );
          });
        } else {
          if (!route.inviteId) throw new Error("match-state-route-invalid");
          const entries = rooms.get(route.inviteId) || [];
          entries.push({ input, index });
          rooms.set(route.inviteId, entries);
        }
      }
      for (const [inviteId, entries] of rooms) {
        reads.push(async () => {
          const records = unwrapMatchStateRpc(
            await getMatchStateRpc(env, inviteId).readCanonicalMatchRecords({
              inviteId,
              epoch: control.epoch,
              requests: entries.map(({ input }) => input),
            }),
          );
          if (!Array.isArray(records) || records.length !== entries.length)
            throw new Error("match-state-record-unavailable");
          for (const [offset, entry] of entries.entries()) {
            const record = records[offset];
            if (record === null || record === undefined)
              throw new Error("match-state-record-unavailable");
            results[entry.index] = record;
          }
        });
      }
      await runMatchStateReads(reads, signal);
      return results;
    },
    { signal },
  );
}
