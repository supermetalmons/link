import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { MATCH_TIMER_TERMINAL, formatMatchTimer } from "@mons/shared/timers";
import { normalizeMatchSnapshot } from "@mons/shared/game-sessions";
import type { InviteReactions } from "../src/inviteReactions.ts";
import {
  MatchStateStore,
  type MatchStateStoreOptions,
} from "../src/matchStateStore.ts";
import { seedRetainedMatchState } from "./retainedMatchStateFixture.ts";
import type {
  MatchStateMoveRequest,
  MatchStateRecord,
} from "../src/matchStateTypes.ts";
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
  fields: MatchStateRecord = {},
): MatchStateRecord => ({
  version: 2,
  color,
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen: "initial",
  flatMovesString: "",
  status: "",
  timer: "",
  extra: { preserved: true },
  ...fields,
});

function timers(): MatchStateStoreOptions["timerStarts"] {
  const markers = new Map<
    string,
    { timer: string; turnNumber: number; updatedAtMs: number }
  >();
  return {
    async getOrAdvance(playerId, _opponentId, matchId, candidate, updatedAtMs) {
      const key = `${playerId}/${matchId}`;
      const current = markers.get(key);
      if (!current || current.turnNumber < candidate.turnNumber) {
        markers.set(key, { ...candidate, updatedAtMs });
      }
      return markers.get(key)!;
    },
    async deletePair(playerId, opponentId, matchId) {
      markers.delete(`${playerId}/${matchId}`);
      markers.delete(`${opponentId}/${matchId}`);
    },
  };
}

function options(
  extra: Partial<MatchStateStoreOptions> = {},
): MatchStateStoreOptions {
  return {
    timerStarts: timers(),
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
  it("omits null creation fields without changing exact import data", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      records[0].value.aura = null;
      records[0].value.nested = { absent: null, retained: true };
      store.createRecords({ ...input, records });
      const current = store.readRecord(input);
      expect(current).not.toHaveProperty("aura");
      expect(current?.nested).toEqual({ retained: true });
      expect(normalizeMatchSnapshot(current)?.aura).toBe("");
    });
    const importedFixture = fixture();
    await runInDurableObject(importedFixture.room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      seedRetainedMatchState(ctx.storage, {
        ...importedFixture.input,
        importId: "null-import",
        records: [
          {
            matchId: importedFixture.input.matchId,
            playerId: importedFixture.input.playerId,
            value: { ...match("white"), aura: null, nested: { absent: null } },
          },
        ],
        claims: [],
      });
      expect(store.readRecord(importedFixture.input)).toMatchObject({
        aura: null,
        nested: { absent: null },
      });
    });
  });
  it("creates both records atomically and preserves creation replays after moves", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      expect(
        store.createRecords({ ...input, records }).changedMatchIds,
      ).toEqual([input.matchId]);
      expect(store.readSource()).toMatchObject({ status: "active", epoch: 1 });
      expect(store.move(move(input)).outcome).toBe("applied");
      const replay = store.createRecords({ ...input, records });
      expect(replay.changedMatchIds).toEqual([]);
      expect(replay.records[0].value).toMatchObject({
        fen: "first",
        extra: { preserved: true },
      });
      const revision = store.readPair(input).revision;
      expect(store.move(move(input)).outcome).toBe("already-applied");
      expect(store.readPair(input).revision).toBe(revision);
      expect(() =>
        store.createRecords({
          ...input,
          records: [
            {
              ...records[0],
              matchId: `${input.matchId}1`,
              marker: "new-rematch",
            },
            { ...records[0], marker: "different-owner" },
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
        extra: { preserved: true },
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

  it("keeps first timer deadlines and rejects marker completions after a move", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      let now = future;
      const markerStore = timers();
      const store = new MatchStateStore(
        ctx.storage,
        options({ timerStarts: markerStore, now: () => now }),
      );
      store.createRecords({ ...input, records });
      const first = await store.startTimer(input);
      now += 5000;
      expect(await store.startTimer(input)).toEqual(first);
      expect(first.timer).toBe(
        formatMatchTimer(game.turnNumber, future + 90_500),
      );
      const racing = new MatchStateStore(
        ctx.storage,
        options({
          timerStarts: {
            ...markerStore,
            async getOrAdvance(...args) {
              const marker = await markerStore.getOrAdvance(...args);
              store.move(move(input));
              return marker;
            },
          },
        }),
      );
      await expect(racing.startTimer(input)).rejects.toThrow(
        "game state changed.",
      );
      expect(store.readPair(input).playerMatch).toMatchObject({
        fen: "first",
        timer: first.timer,
      });
    });
  });

  it("does not overwrite terminal state when D1 marker I/O finishes late", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      let store: MatchStateStore;
      const markerStore = timers();
      store = new MatchStateStore(
        ctx.storage,
        options({
          timerStarts: {
            ...markerStore,
            async getOrAdvance(...args) {
              const marker = await markerStore.getOrAdvance(...args);
              store.surrender({
                inviteId: input.inviteId,
                matchId: input.matchId,
                epoch: input.epoch,
                playerId: input.opponentId,
              });
              return marker;
            },
          },
        }),
      );
      store.createRecords({ ...input, records });
      await expect(store.startTimer(input)).rejects.toThrow(
        "game is already over.",
      );
      expect(store.readPair(input).playerMatch?.timer).toBe("");
      expect(store.readPair(input).opponentMatch?.status).toBe("surrendered");
    });
  });

  it("cleans terminal markers before trying to parse a malformed peer", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      let deleted = 0;
      const markerStore = timers();
      const store = new MatchStateStore(
        ctx.storage,
        options({
          timerStarts: {
            ...markerStore,
            async deletePair() {
              deleted++;
            },
          },
        }),
      );
      records[0].value.timer = MATCH_TIMER_TERMINAL;
      records[1].value.fen = "";
      store.createRecords({ ...input, records });
      await expect(store.startTimer(input)).rejects.toThrow(
        "game is already over.",
      );
      expect(deleted).toBe(1);
      await expect(store.claimTimer(input)).rejects.toThrow(
        "something is wrong with the game state.",
      );
      expect(deleted).toBe(2);
      expect(store.nextEffectAt()).toBeNull();
    });
  });

  it("commits timeout, fence, and an alarm-backed effect once", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      records[0].value.timer = formatMatchTimer(game.turnNumber, future - 1);
      store.createRecords({ ...input, records });
      expect(
        await store.claimTimer({ ...input, eventId: "event-one" }),
      ).toEqual({ ok: true });
      const pair = store.readPair(input);
      expect(pair.playerMatch?.timer).toBe(MATCH_TIMER_TERMINAL);
      expect(pair.claim).toMatchObject({
        status: "claimed",
        claimedAtMs: future,
        expiresAtMs: null,
        playerId: input.playerId,
      });
      expect(await ctx.storage.getAlarm()).toBe(future);
      expect(store.listDueEffects()).toMatchObject([
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
      const effect = store.listDueEffects()[0];
      await store.retryEffect(effect.effectId, future + 60_000);
      expect(store.listDueEffects()).toEqual([]);
      expect(store.listDueEffects(future + 60_000)[0].attempts).toBe(1);
      store.completeEffect(effect.effectId);
      expect(store.nextEffectAt()).toBeNull();
      expect(
        await store.claimTimer({ ...input, eventId: "event-one" }),
      ).toEqual({ ok: true });
      expect(store.listDueEffects(future + 60_000)).toEqual([]);
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
      records[0].value.timer = formatMatchTimer(game.turnNumber, future - 1);
      store.createRecords({ ...input, records });
      const before = store.readPair(input);
      await expect(store.claimTimer(input)).rejects.toThrow(
        "injected-alarm-failure",
      );
      expect(store.readPair(input)).toEqual(before);
      expect(store.nextEffectAt()).toBeNull();
      expect(await ctx.storage.getAlarm()).toBe(originalAlarm);
    });
  });

  it("preserves earlier alarms and rejects early, stale-turn, and invalid-history claims", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      await ctx.storage.setAlarm(future - 1000);
      records[0].value.timer = formatMatchTimer(game.turnNumber, future + 10);
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
      records[0].value.timer = formatMatchTimer(game.turnNumber, future - 1);
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
      expect(store.nextEffectAt()).toBeNull();
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
        value: { ...record.value, sessionCreation: marker } as MatchStateRecord,
      })),
    };
    retained.records[0].value.timer = formatMatchTimer(
      game.turnNumber,
      future - 60_000,
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
        retained.records[0].value,
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
        retained.records[0].value,
      );
      const evidence = ctx.storage.sql
        .exec<{ value_json: string }>(
          "SELECT value_json FROM match_state_staged_records WHERE player_id = ?",
          input.playerId,
        )
        .one();
      expect(JSON.parse(evidence.value_json)).toEqual(
        retained.records[0].value,
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
      expect(store.readPair(input).claim?.claimedAtMs).toBe(future - 50);
    });
  });

  it("applies event effects atomically and fences replay payloads", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      store.createRecords({ ...input, records });
      const effect = {
        ...input,
        operationId: "event-transition",
        terminalTimers: [{ matchId: input.matchId, playerId: input.playerId }],
      };
      expect(store.applyEventEffects(effect).changedMatchIds).toEqual([
        input.matchId,
      ]);
      const revision = store.readPair(input).revision;
      expect(store.applyEventEffects(effect).changedMatchIds).toEqual([]);
      expect(store.readPair(input).revision).toBe(revision);
      expect(() =>
        store.applyEventEffects({
          ...effect,
          terminalTimers: [
            { matchId: input.matchId, playerId: input.opponentId },
          ],
        }),
      ).toThrow("match-state-event-effect-conflict");
      expect(() =>
        store.applyEventEffects({
          ...effect,
          operationId: "failed-event-transition",
          terminalTimers: [
            { matchId: input.matchId, playerId: input.opponentId },
            { matchId: `${input.matchId}1`, playerId: input.playerId },
          ],
        }),
      ).toThrow("match-state-event-match-missing");
      expect(store.readPair(input).opponentMatch?.timer).toBe("");
    });
  });
});
