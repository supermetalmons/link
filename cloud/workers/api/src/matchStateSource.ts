import type {
  MatchStateJson,
  MatchStatePair,
  MatchStatePairRequest,
} from "./matchStateTypes.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import { registerMatchStateRoutes } from "./matchStateD1.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import {
  readCurrentMatchState,
  readMatchStateRecord,
  readMatchStateRecords,
  type MatchStateReadTiming,
} from "./matchStateRouting.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import { runMatchStateReads } from "./matchStateReadPool.ts";

type MatchPairReadTiming = MatchStateReadTiming & { roomReadsMs: number };

async function readMatchStatePairs(
  env: Env,
  inputs: readonly Omit<MatchStatePairRequest, "epoch">[],
  signal?: AbortSignal,
  timing?: MatchPairReadTiming,
): Promise<MatchStatePair[]> {
  signal?.throwIfAborted();
  if (inputs.length === 0) return [];
  let roomReadsStartedAt: number | null = null;
  const finishRoomReads = () => {
    if (timing && roomReadsStartedAt !== null) {
      timing.roomReadsMs += Date.now() - roomReadsStartedAt;
      roomReadsStartedAt = null;
    }
  };
  try {
    return await readCurrentMatchState(
      env,
      async (control) => {
        if (timing) roomReadsStartedAt = Date.now();
        try {
          return await runMatchStateReads(
            inputs.map(
              (input) => async () =>
                unwrapMatchStateRpc(
                  await getMatchStateRpc(
                    env,
                    input.inviteId,
                  ).readCanonicalMatchPair({ ...input, epoch: control.epoch }),
                ),
            ),
            signal,
          );
        } finally {
          finishRoomReads();
        }
      },
      { signal, timing },
    );
  } finally {
    finishRoomReads();
  }
}

export function createMatchStateSource(env: Env): MatchStatePort {
  return {
    async readMatchRecord(input, signal) {
      const value = await readMatchStateRecord(env, input, { signal });
      return value as MatchStateJson;
    },
    async readMatchRecords(inputs, signal) {
      return (await readMatchStateRecords(env, inputs, {
        signal,
      })) as MatchStateJson[];
    },
    async readMatchPair(input, signal) {
      return (await readMatchStatePairs(env, [input], signal))[0];
    },
    async readMatchPairs(inputs, signal) {
      signal?.throwIfAborted();
      if (inputs.length === 0) return [];
      const startedAt = Date.now();
      const timing: MatchPairReadTiming = {
        attempts: 0,
        authorityReads: 0,
        authorityMs: 0,
        roomReadsMs: 0,
      };
      let succeeded = false;
      try {
        const pairs = await readMatchStatePairs(env, inputs, signal, timing);
        succeeded = true;
        return pairs;
      } finally {
        console.info(
          JSON.stringify({
            event: "match_state_batch_read",
            count: inputs.length,
            ...timing,
            durationMs: Date.now() - startedAt,
            outcome: succeeded ? "ok" : signal?.aborted ? "aborted" : "error",
          }),
        );
      }
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
        ).applyCanonicalMatchEventEffects(
          { ...input, epoch: control.epoch },
          { deferNotifications: true },
        ),
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
  };
}
