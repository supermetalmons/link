import { evictCanonicalMatchRoom as evictDurableObject } from "./canonicalMatchTestFixture.ts";
import { matchEventEffectsFixture } from "./canonicalMatchTestFixture.ts";
import { runInCanonicalMatchWriterFixture as runInDurableObject } from "./canonicalMatchTestFixture.ts";
import { captureMatchEffectTarget } from "../src/matchEffectCodec.ts";
import {
  timerClaimRecordFixture,
  timerClaimFixture,
} from "../test/matchClaimFixture.ts";
import {
  matchDocumentFixture,
  matchRecordFixture,
} from "../test/matchRecordFixture.ts";

import { env } from "cloudflare:workers";

import { afterEach, describe, expect, it } from "vitest";
import { MATCH_TIMER_TERMINAL, formatMatchTimer } from "@mons/shared/timers";
import type { InviteReactions } from "../src/inviteReactions.ts";
import {
  MatchStateStore,
  type MatchStateStoreOptions,
} from "../src/matchStateStore.ts";
import { seedRetainedMatchState } from "./retainedMatchStateFixture.ts";
import type { MatchStateMoveRequest } from "../src/matchStateTypes.ts";
import type { MatchTimerGameState } from "../src/matchTimer.ts";

type Room = DurableObjectStub<InviteReactions>;
const rooms: Room[] = [];
const future = Date.now() + 1_000_000_000;
const game: MatchTimerGameState = {
  activeColor: "black",
  historyValid: true,
  turnNumber: 7,
  winner: undefined,
};

const match = (
  color: "white" | "black",
  fields: Record<string, unknown> = {},
) =>
  matchDocumentFixture({
    version: 2,
    color,
    emojiId: 1,
    aura: "none" as const,
    gameVariant: "Classic",
    fen: "initial",
    flatMovesString: "",
    status: "",
    timer: "",
    ...fields,
  });

function options(
  extra: Partial<MatchStateStoreOptions> = {},
): MatchStateStoreOptions {
  return {
    now: () => future,
    resolveGame: () => game,
    ...extra,
  };
}

function fixture() {
  const inviteId = `state-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  rooms.push(room);
  const input = {
    inviteId,
    matchId: inviteId,
    epoch: 1,
    playerId: "host-login",
    opponentId: "guest-login",
  };
  const records = [
    {
      matchId: inviteId,
      playerId: input.playerId,
      marker: "host-created",
      value: match("white"),
    },
    {
      matchId: inviteId,
      playerId: input.opponentId,
      marker: "guest-created",
      value: match("black"),
    },
  ];
  return { room, input, records };
}

function move(
  input: ReturnType<typeof fixture>["input"],
  values: Partial<MatchStateMoveRequest> = {},
): MatchStateMoveRequest {
  return {
    inviteId: input.inviteId,
    matchId: input.matchId,
    epoch: input.epoch,
    playerId: input.playerId,
    previousFlatMovesString: "",
    flatMovesString: "a",
    fen: "first",
    ...values,
  };
}

afterEach(async () => {
  await Promise.all(
    rooms.splice(0).map((room) =>
      runInDurableObject(room, async (_instance, ctx) => {
        await ctx.storage.deleteAlarm();
      }),
    ),
  );
});

describe("canonical match state storage", () => {
  it("rejects incomplete or extended creation records before mutation", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      for (const value of [
        { ...records[0]!.value, aura: null },
        { ...records[0]!.value, extra: true },
      ]) {
        expect(() =>
          store.createRecords({
            ...input,
            records: [{ ...records[0]!, value }],
          } as never),
        ).toThrow("match-state-invalid-creation");
      }
      expect(store.readSource().status).toBe("empty");
    });
  });
  it("creates both records atomically and preserves creation replays after moves", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      expect(
        ctx.storage.sql
          .exec(
            "SELECT name FROM sqlite_schema WHERE name IN ('match_state_staged_records', 'match_state_staged_claims')",
          )
          .toArray(),
      ).toEqual([]);
      expect(
        store.createRecords({ ...input, records }).changedMatchIds,
      ).toEqual([input.matchId]);
      expect(store.readSource()).toMatchObject({ status: "active", epoch: 1 });
      expect(store.move(move(input)).outcome).toBe("applied");
      const replay = store.createRecords({ ...input, records });
      expect(replay.changedMatchIds).toEqual([]);
      expect(replay.records[0]!.value).toMatchObject({
        fen: "first",
      });
      const revision = store.readPair(input).revision;
      expect(store.move(move(input)).outcome).toBe("already-applied");
      expect(store.readPair(input).revision).toBe(revision);
      expect(() =>
        store.createRecords({
          ...input,
          records: [
            {
              ...records[0]!,
              matchId: `${input.matchId}1`,
              marker: "new-rematch",
            },
            { ...records[0]!, marker: "different-owner" },
          ],
        }),
      ).toThrow("match-creation-conflict");
      expect(
        store.readRecord({ ...input, matchId: `${input.matchId}1` }),
      ).toBeNull();
      expect(
        store.readRecord({ ...input, playerId: input.opponentId }),
      ).toMatchObject({ fen: "initial" });
    });
  });

  it("keeps retained staged sources unavailable across eviction", async () => {
    const { room, input, records } = fixture();
    const expectedSource = {
      inviteId: input.inviteId,
      epoch: 0,
      status: "staged",
      importId: "unfinished-import",
      stagedEpoch: input.epoch,
      digest: "a".repeat(64),
    };
    await runInDurableObject(room, (_instance, ctx) => {
      seedRetainedMatchState(ctx.storage, {
        ...input,
        importId: expectedSource.importId,
        records,
      });
      ctx.storage.sql.exec(
        "UPDATE match_state_source_canonical SET active_epoch = NULL WHERE singleton = 1",
      );
    });
    await evictDurableObject(room);
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      expect(store.readSource()).toEqual(expectedSource);
      expect(() => store.createRecords({ ...input, records })).toThrow(
        "match-state-authority-unavailable",
      );
      expect(() => store.readRecord(input)).toThrow(
        "match-state-authority-unavailable",
      );
      expect(store.readSource()).toEqual(expectedSource);
    });
  });

  it("handles cumulative moves, superseded retries, and conflicting chains", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      store.createRecords({ ...input, records });
      store.move(move(input));
      const cumulative = move(input, {
        fen: "second",
        flatMovesString: "a-b",
        previousStates: [
          { moveCount: 0, fen: "initial" },
          { moveCount: 1, fen: "first" },
        ],
      });
      expect(store.move(cumulative).outcome).toBe("applied");
      expect(
        store.move(
          move(input, { previousStates: [{ moveCount: 0, fen: "initial" }] }),
        ),
      ).toMatchObject({
        outcome: "superseded",
        fen: "second",
        flatMovesString: "a-b",
      });
      expect(() =>
        store.move(move(input, { flatMovesString: "other" })),
      ).toThrow("move-chain-conflict");
      expect(store.readPair(input).playerMatch).toMatchObject({
        sessionCreation: "host-created",
        color: "white",
        fen: "second",
        flatMovesString: "a-b",
      });
    });
  });

  it("refuses stale epochs and conflicting invite identities", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      store.createRecords({ ...input, records });
      expect(() => store.move(move(input, { epoch: 2 }))).toThrow(
        "match-state-authority-unavailable",
      );
      expect(() => store.readPair({ ...input, inviteId: "other" })).toThrow(
        "match-state-invite-conflict",
      );
      expect(() =>
        store.readPair({ ...input, opponentId: input.playerId }),
      ).toThrow("match-state-invalid-opponent");
    });
  });

  it("commits timeout, fence, and an alarm-backed effect once", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      records[0]!.value.timer = formatMatchTimer(game.turnNumber, future - 1);
      store.createRecords({ ...input, records });
      expect(
        await store.claimTimer({ ...input, eventId: "event-one" }),
      ).toEqual({ ok: true });
      const pair = store.readPair(input);
      expect(matchRecordFixture(pair.playerMatch)?.timer).toEqual(
        MATCH_TIMER_TERMINAL,
      );
      expect(pair.claim).toMatchObject({
        status: "claimed",
        claimedAtMs: future,
        expiresAtMs: null,
        playerId: input.playerId,
      });
      expect(await ctx.storage.getAlarm()).toBe(future);
      expect(store.effects.listDueEffects()).toMatchObject([
        {
          eventId: "event-one",
          sourceKey: `timer:${input.inviteId}:${input.matchId}`,
        },
      ]);
      expect(() => store.move(move(input))).toThrow("match-move-finished");
      expect(() =>
        store.surrender({
          inviteId: input.inviteId,
          matchId: input.matchId,
          epoch: input.epoch,
          playerId: input.opponentId,
        }),
      ).toThrow("match-surrender-blocked");
      expect(
        await store.claimTimer({ ...input, eventId: "event-one" }),
      ).toEqual({ ok: true });
      expect(store.readPair(input).revision).toBe(pair.revision);
      const effect = store.effects.listDueEffects()[0]!;
      await store.effects.retryEffect(
        captureMatchEffectTarget(effect),
        future + 60_000,
      );
      expect(store.effects.listDueEffects()).toEqual([]);
      expect(store.effects.listDueEffects(future + 60_000)[0]!.attempts).toBe(
        1,
      );
      store.effects.completeEffect(captureMatchEffectTarget(effect));
      expect(store.effects.nextEffectAt()).toBeNull();
      expect(
        await store.claimTimer({ ...input, eventId: "event-one" }),
      ).toEqual({ ok: true });
      expect(store.effects.listDueEffects(future + 60_000)).toEqual([]);
    });
  });

  it("rolls back canonical timeout and outbox if alarm persistence fails", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const originalAlarm = future + 10_000;
      await ctx.storage.setAlarm(originalAlarm);
      const store = new MatchStateStore(
        ctx.storage,
        options({
          async scheduleAlarm(atMs, transaction) {
            await transaction.setAlarm(atMs);
            throw new Error("injected-alarm-failure");
          },
        }),
      );
      records[0]!.value.timer = formatMatchTimer(game.turnNumber, future - 1);
      store.createRecords({ ...input, records });
      const before = store.readPair(input);
      await expect(store.claimTimer(input)).rejects.toThrow(
        "injected-alarm-failure",
      );
      expect(store.readPair(input)).toEqual(before);
      expect(store.effects.nextEffectAt()).toBeNull();
      expect(await ctx.storage.getAlarm()).toBe(originalAlarm);
    });
  });

  it("rolls back an effect retry and alarm together if alarm persistence fails", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      let failAlarm = false;
      const store = new MatchStateStore(
        ctx.storage,
        options({
          async scheduleAlarm(atMs, transaction) {
            await transaction.setAlarm(atMs);
            if (failAlarm) throw new Error("injected-alarm-failure");
          },
        }),
      );
      records[0]!.value.timer = formatMatchTimer(game.turnNumber, future - 1);
      store.createRecords({ ...input, records });
      await store.claimTimer(input);
      const before = store.effects.listDueEffects();
      const originalAlarm = await ctx.storage.getAlarm();
      failAlarm = true;
      await expect(
        store.effects.retryEffect(
          captureMatchEffectTarget(before[0]!),
          future + 60_000,
        ),
      ).rejects.toThrow("injected-alarm-failure");
      expect(store.effects.listDueEffects()).toEqual(before);
      expect(store.effects.nextEffectAt()).toBe(future);
      expect(await ctx.storage.getAlarm()).toBe(originalAlarm);
    });
  });

  it("rejects a conflicting effect replay without changing the claim, outbox or alarm", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      records[0]!.value.timer = formatMatchTimer(game.turnNumber, future - 1);
      store.createRecords({ ...input, records });
      await store.claimTimer({ ...input, eventId: "event-one" });
      const pair = store.readPair(input);
      const effects = store.effects.listDueEffects();
      const alarm = await ctx.storage.getAlarm();
      await expect(
        store.claimTimer({ ...input, eventId: "event-two" }),
      ).rejects.toMatchObject({
        status: 409,
        code: "failed-precondition",
        message: "match-state-effect-conflict",
      });
      expect(store.readPair(input)).toEqual(pair);
      expect(store.effects.listDueEffects()).toEqual(effects);
      expect(await ctx.storage.getAlarm()).toBe(alarm);
    });
  });

  for (const [condition, resolvedGame] of [
    ["the caller's own turn", { ...game, activeColor: "white" }],
    ["an engine-declared winner", { ...game, winner: "white" }],
  ] as const) {
    for (const operation of ["startTimer", "claimTimer"] as const) {
      it(`rejects ${operation} with ${condition} without changing canonical state`, async () => {
        const { room, input, records } = fixture();
        await runInDurableObject(room, async (_instance, ctx) => {
          const store = new MatchStateStore(
            ctx.storage,
            options({
              resolveGame: () => resolvedGame,
            }),
          );
          records[0]!.value.timer = formatMatchTimer(
            game.turnNumber,
            future - 1,
          );
          store.createRecords({ ...input, records });
          const before = store.readPair(input);
          const alarm = future + 60_000;
          await ctx.storage.setAlarm(alarm);

          await expect(store[operation](input)).rejects.toMatchObject({
            status: 409,
            code: "failed-precondition",
            message: resolvedGame.winner
              ? "game is already over."
              : operation === "startTimer"
                ? "can't start a timer on your own turn."
                : "can't claim timer victory on your own turn.",
          });
          expect(store.readPair(input)).toEqual(before);
          expect(store.effects.nextEffectAt()).toBeNull();
          expect(store.effects.listDueEffects()).toEqual([]);
          expect(await ctx.storage.getAlarm()).toBe(alarm);
        });
      });
    }
  }

  it("preserves earlier alarms and rejects early, stale-turn, and invalid-history claims", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      await ctx.storage.setAlarm(future - 1000);
      records[0]!.value.timer = formatMatchTimer(game.turnNumber, future + 10);
      const store = new MatchStateStore(ctx.storage, options());
      store.createRecords({ ...input, records });
      await expect(store.claimTimer(input)).rejects.toThrow(
        "can't claim yet, 10 ms remaining",
      );
      const later = new MatchStateStore(
        ctx.storage,
        options({ now: () => future + 11 }),
      );
      const wrongTurn = new MatchStateStore(
        ctx.storage,
        options({
          resolveGame: () => ({ ...game, turnNumber: game.turnNumber + 1 }),
        }),
      );
      await expect(wrongTurn.claimTimer(input)).rejects.toThrow(
        "can't claim this timer anymore",
      );
      const invalid = new MatchStateStore(
        ctx.storage,
        options({ resolveGame: () => ({ ...game, historyValid: false }) }),
      );
      await expect(invalid.claimTimer(input)).rejects.toThrow(
        "something is wrong with the moves.",
      );
      await later.claimTimer(input);
      expect(await ctx.storage.getAlarm()).toBe(future - 1000);
    });
  });

  it("does not claim after a move advanced the turn or after surrender", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      records[0]!.value.timer = formatMatchTimer(game.turnNumber, future - 1);
      const store = new MatchStateStore(
        ctx.storage,
        options({
          resolveGame: (player) => ({
            ...game,
            turnNumber: player.flatMovesString
              ? game.turnNumber + 1
              : game.turnNumber,
          }),
        }),
      );
      store.createRecords({ ...input, records });
      store.move(move(input));
      await expect(store.claimTimer(input)).rejects.toThrow(
        "can't claim this timer anymore",
      );
      store.surrender({
        inviteId: input.inviteId,
        matchId: input.matchId,
        epoch: input.epoch,
        playerId: input.opponentId,
      });
      await expect(store.claimTimer(input)).rejects.toThrow(
        "game is already over.",
      );
      expect(store.effects.nextEffectAt()).toBeNull();
    });
  });

  it("retains exact imported records, deadlines, and source evidence after eviction", async () => {
    const { room, input, records } = fixture();
    const retained = {
      inviteId: input.inviteId,
      epoch: 4,
      importId: "cutover-one",
      records: records.map(({ marker, ...record }) => ({
        ...record,
        value: matchDocumentFixture({
          ...record.value,
          sessionCreation: marker,
        }),
      })),
      claims: [
        {
          matchId: input.matchId,
          value: timerClaimFixture({
            inviteId: input.inviteId,
            playerId: input.playerId,
            opponentId: input.opponentId,
            status: "pending",
            expiresAtMs: future - 1,
          }),
        },
      ],
    };
    Reflect.set(
      retained.records[0]!.value,
      "timer",
      formatMatchTimer(game.turnNumber, future - 60_000),
    );
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      seedRetainedMatchState(ctx.storage, retained);
      expect(store.readSource()).toMatchObject({
        status: "active",
        epoch: 4,
        importId: retained.importId,
        digest: "a".repeat(64),
      });
      expect(store.readPair({ ...input, epoch: 4 }).playerMatch).toEqual(
        retained.records[0]!.value,
      );
      expect(() => store.createRecords({ ...input, records })).toThrow(
        "match-state-authority-unavailable",
      );
    });
    await evictDurableObject(room);
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      expect(store.readSource()).toMatchObject({
        status: "active",
        epoch: 4,
        digest: "a".repeat(64),
      });
      expect(store.readPair({ ...input, epoch: 4 }).playerMatch).toEqual(
        retained.records[0]!.value,
      );
      expect(store.readPair({ ...input, epoch: 4 }).claim).toEqual(
        retained.claims[0]!.value,
      );
      const evidence = ctx.storage.sql
        .exec<{ value_json: string }>(
          "SELECT value_json FROM match_state_staged_records WHERE player_id = ?",
          input.playerId,
        )
        .one();
      expect(JSON.parse(evidence.value_json)).toEqual(
        retained.records[0]!.value,
      );
      const claimEvidence = ctx.storage.sql
        .exec<{ value_json: string }>(
          "SELECT value_json FROM match_state_staged_claims WHERE match_id = ?",
          input.matchId,
        )
        .one();
      expect(JSON.parse(claimEvidence.value_json)).toEqual(
        retained.claims[0]!.value,
      );
    });
  });

  it("preserves imported pending fences until their exact expiry", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      let now = future;
      const store = new MatchStateStore(
        ctx.storage,
        options({ now: () => now }),
      );
      seedRetainedMatchState(ctx.storage, {
        ...input,
        importId: "pending-claim",
        records: records.map(({ matchId, playerId, value }) => ({
          matchId,
          playerId,
          value,
        })),
        claims: [
          {
            matchId: input.matchId,
            value: { status: "pending", expiresAtMs: future + 10 },
          },
        ],
      });
      expect(() => store.move(move(input))).toThrow("match-move-blocked");
      now += 10;
      expect(store.move(move(input)).outcome).toBe("applied");
    });
  });

  it("preserves committed import claims and read-only idempotent move recognition", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      seedRetainedMatchState(ctx.storage, {
        ...input,
        importId: "committed-claim",
        records: records.map(({ matchId, playerId, value }) => ({
          matchId,
          playerId,
          value:
            playerId === input.playerId
              ? {
                  ...value,
                  fen: "first",
                  flatMovesString: "a",
                  timer: MATCH_TIMER_TERMINAL,
                }
              : value,
        })),
        claims: [
          {
            matchId: input.matchId,
            value: {
              inviteId: input.inviteId,
              playerId: input.playerId,
              opponentId: input.opponentId,
              status: "claimed",
              timer: formatMatchTimer(game.turnNumber, future - 100),
              turnNumber: game.turnNumber,
              claimedAtMs: future - 50,
              expiresAtMs: null,
            },
          },
        ],
      });
      expect(store.move(move(input)).outcome).toBe("already-applied");
      expect(() =>
        store.move(
          move(input, {
            previousFlatMovesString: "a",
            flatMovesString: "a-b",
            fen: "second",
          }),
        ),
      ).toThrow("match-move-finished");
      await store.claimTimer(input);
      expect(
        timerClaimRecordFixture(store.readPair(input).claim)?.claimedAtMs,
      ).toBe(future - 50);
    });
  });

  it("applies event effects atomically and fences replay payloads", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      store.createRecords({ ...input, records });
      const effect = matchEventEffectsFixture({
        ...input,
        operationId: "event-transition",
        terminalTimers: [{ matchId: input.matchId, playerId: input.playerId }],
      });
      expect((await store.applyEventEffects(effect)).changedMatchIds).toEqual([
        input.matchId,
      ]);
      const revision = store.readPair(input).revision;
      expect((await store.applyEventEffects(effect)).changedMatchIds).toEqual(
        [],
      );
      expect(store.readPair(input).revision).toBe(revision);
      await expect(
        store.applyEventEffects({
          ...effect,
          terminalTimers: [
            { matchId: input.matchId, playerId: input.opponentId },
          ],
        }),
      ).rejects.toThrow("match-state-event-effect-conflict");
      await expect(
        store.applyEventEffects({
          ...effect,
          operationId: "failed-event-transition",
          terminalTimers: [
            { matchId: input.matchId, playerId: input.opponentId },
            { matchId: `${input.matchId}1`, playerId: input.playerId },
          ],
        }),
      ).rejects.toThrow("match-state-event-match-missing");
      expect(
        matchRecordFixture(store.readPair(input).opponentMatch)?.timer,
      ).toEqual({ state: "idle" });
    });
  });
});
