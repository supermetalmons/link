import type { MatchStateJson, MatchStatePair } from "./matchStateTypes.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import { registerMatchStateRoutes } from "./matchStateD1.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import {
  readCurrentMatchState,
  readMatchStateRecord,
  type MatchStateReadTiming,
} from "./matchStateRouting.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "./matchStateRpc.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";

export function createMatchStateSource(env: Env): MatchStatePort {
  return {
    async readMatchRecord(input, signal) {
      signal?.throwIfAborted();
      if (
        !isCanonicalLoginUid(input.playerId) ||
        !isSafeRecordKey(input.matchId)
      )
        throw new Error("match-state-invalid-read-target");
      const value = await readMatchStateRecord(env, input, { signal });
      return value as MatchStateJson;
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
    async readMatchPairs(inputs, signal) {
      signal?.throwIfAborted();
      if (inputs.length === 0) return [];
      const startedAt = Date.now();
      const timing: MatchStateReadTiming = {
        attempts: 0,
        authorityReads: 0,
        authorityMs: 0,
      };
      let roomReadsMs = 0;
      let succeeded = false;
      try {
        const pairs = await readCurrentMatchState(
          env,
          async (control) => {
            const roomReadsStartedAt = Date.now();
            const results = new Array<MatchStatePair>(inputs.length);
            let nextIndex = 0;
            let failed = false;
            let failure: unknown;
            const worker = async () => {
              try {
                while (!failed && nextIndex < inputs.length) {
                  signal?.throwIfAborted();
                  const index = nextIndex++;
                  const input = inputs[index];
                  results[index] = unwrapMatchStateRpc(
                    await getMatchStateRpc(
                      env,
                      input.inviteId,
                    ).readCanonicalMatchPair({
                      ...input,
                      epoch: control.epoch,
                    }),
                  );
                }
              } catch (error) {
                if (!failed) failure = error;
                failed = true;
              }
            };
            let cancel: (() => void) | undefined;
            try {
              const drained = Promise.all(
                Array.from({ length: Math.min(4, inputs.length) }, worker),
              );
              const cancelled = signal
                ? new Promise<never>((_, reject) => {
                    cancel = () => reject(signal.reason);
                    signal.addEventListener("abort", cancel, { once: true });
                    if (signal.aborted) cancel();
                  })
                : undefined;
              await (cancelled ? Promise.race([drained, cancelled]) : drained);
              signal?.throwIfAborted();
              if (failed) throw failure;
              return results;
            } finally {
              if (cancel) signal?.removeEventListener("abort", cancel);
              roomReadsMs += Date.now() - roomReadsStartedAt;
            }
          },
          { signal, timing },
        );
        succeeded = true;
        return pairs;
      } finally {
        console.info(
          JSON.stringify({
            event: "match_state_batch_read",
            count: inputs.length,
            ...timing,
            roomReadsMs,
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
