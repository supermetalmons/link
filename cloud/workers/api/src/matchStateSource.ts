import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";
import { registerMatchStateRoutes } from "./matchStateD1.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import {
  readCurrentMatchState,
  readMatchStateRecord,
} from "./matchStateRouting.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";

export function createMatchStateSource(env: Env): FirebaseRtdbClient {
  return {
    async getPath(path, query, signal) {
      signal?.throwIfAborted();
      const parts = path.split("/");
      if (
        parts[0] !== "players" ||
        parts[2] !== "matches" ||
        parts.length < 4 ||
        !isCanonicalFirebaseUid(parts[1]) ||
        parts.slice(3).some((part) => !isSafeFirebaseKey(part)) ||
        query
      )
        throw new Error("match-state-unsupported-read-path");
      let value = await readMatchStateRecord(
        env,
        { playerId: parts[1], matchId: parts[3] },
        { signal },
      );
      for (const field of parts.slice(4)) {
        value =
          value && typeof value === "object" && !Array.isArray(value)
            ? ((value as Record<string, unknown>)[field] ?? null)
            : null;
      }
      return value;
    },
    async readMatchPair(input, signal) {
      signal?.throwIfAborted();
      return readCurrentMatchState(env, async (control) =>
        unwrapMatchStateRpc(
          await getMatchStateRpc(env, input.inviteId).readCanonicalMatchPair({
            ...input,
            epoch: control.epoch,
          }),
        ),
      );
    },
    async createMatchRecords(input, signal) {
      signal?.throwIfAborted();
      const control = await requireActiveDurableMatchState(
        env.PROFILE_GAMES_DB,
      );
      unwrapMatchStateRpc(
        await getMatchStateRpc(env, input.inviteId).createCanonicalMatch({
          inviteId: input.inviteId,
          epoch: control.epoch,
          records: input.records,
        }),
      );
      await registerMatchStateRoutes(
        env.PROFILE_GAMES_DB,
        input.records.map((row) => ({
          actorUid: row.playerId,
          matchId: row.matchId,
          inviteId: input.inviteId,
          kind: "durable" as const,
          epoch: control.epoch,
        })),
        control.epoch,
      );
    },
    async applyMatchEventEffects(input, signal) {
      signal?.throwIfAborted();
      const control = await requireActiveDurableMatchState(
        env.PROFILE_GAMES_DB,
      );
      unwrapMatchStateRpc(
        await getMatchStateRpc(
          env,
          input.inviteId,
        ).applyCanonicalMatchEventEffects({ ...input, epoch: control.epoch }),
      );
      if (input.creations?.length) {
        await registerMatchStateRoutes(
          env.PROFILE_GAMES_DB,
          input.creations.map((row) => ({
            actorUid: row.playerId,
            matchId: row.matchId,
            inviteId: input.inviteId,
            kind: "durable" as const,
            epoch: control.epoch,
          })),
          control.epoch,
        );
      }
    },
    async patchRoot() {
      throw new Error("match-state-untyped-write-retired");
    },
    async transactPath() {
      throw new Error("match-state-untyped-write-retired");
    },
  };
}
