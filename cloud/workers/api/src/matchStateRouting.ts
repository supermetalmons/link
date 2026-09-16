import { requireDurableMatchState } from "./matchStateAuthority.ts";
import {
  readLegacyMatchState,
  readMatchStateControl,
  readMatchStateRoute,
  type MatchStateControl,
} from "./matchStateD1.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import type { ReadMatchSnapshotRequest } from "@mons/shared/game-sessions";

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
  const readControl = async (requireDurable = false) => {
    const startedAt = Date.now();
    if (options.timing) options.timing.authorityReads++;
    try {
      return await (requireDurable
        ? requireDurableMatchState(env.PROFILE_GAMES_DB)
        : readMatchStateControl(env.PROFILE_GAMES_DB));
    } finally {
      if (options.timing) options.timing.authorityMs += Date.now() - startedAt;
    }
  };
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
      if (latest.backend !== control.backend || latest.epoch !== control.epoch)
        continue;
      throw error;
    }
    options.signal?.throwIfAborted();
    const latest = await readControl();
    options.signal?.throwIfAborted();
    if (latest.backend === control.backend && latest.epoch === control.epoch)
      return result;
  }
  throw new Error("match-state-read-authority-changed");
}

export async function readMatchStateRecord(
  env: Env,
  request: ReadMatchSnapshotRequest,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<unknown> {
  options.signal?.throwIfAborted();
  return readCurrentMatchState(env, async (control) => {
    const route = await readMatchStateRoute(
      env.PROFILE_GAMES_DB,
      request.playerId,
      request.matchId,
    );
    options.signal?.throwIfAborted();
    if (!route) return null;
    if (route.epoch !== control.epoch)
      throw new Error("match-state-route-epoch-conflict");
    if (route.kind === "legacy") {
      return readLegacyMatchState(
        env.PROFILE_GAMES_DB,
        request.playerId,
        request.matchId,
      );
    }
    if (!route.inviteId) throw new Error("match-state-route-invalid");
    const value = unwrapMatchStateRpc(
      await getMatchStateRpc(env, route.inviteId).readCanonicalMatchRecord({
        ...request,
        inviteId: route.inviteId,
        epoch: control.epoch,
      }),
    );
    if (value === null) throw new Error("match-state-record-unavailable");
    return value;
  });
}
