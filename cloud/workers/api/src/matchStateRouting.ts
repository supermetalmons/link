import { requireDurableMatchState } from "./matchStateAuthority.ts";
import {
  readLegacyMatchState,
  readMatchStateControl,
  readMatchStateRoute,
  type MatchStateControl,
} from "./matchStateD1.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import type { ReadMatchSnapshotRequest } from "@mons/shared/game-sessions";

export async function readCurrentMatchState<T>(
  env: Env,
  read: (control: MatchStateControl) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const control = await requireDurableMatchState(env.PROFILE_GAMES_DB);
    let result: T;
    try {
      result = await read(control);
    } catch (error) {
      const latest = await readMatchStateControl(env.PROFILE_GAMES_DB);
      if (latest.backend !== control.backend || latest.epoch !== control.epoch)
        continue;
      throw error;
    }
    const latest = await readMatchStateControl(env.PROFILE_GAMES_DB);
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
