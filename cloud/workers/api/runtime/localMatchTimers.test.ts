import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { formatMatchTimer, MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import {
  MatchStateStore,
  type MatchStateStoreOptions,
} from "../src/matchStateStore.ts";
import { parseNewMatchTimerStorage } from "../src/localMatchTimerStore.ts";
import type { MatchStateRecord } from "../src/matchStateTypes.ts";
import { seedRetainedMatchState } from "./retainedMatchStateFixture.ts";

const now = 2_000_000_000_000;
const game = {
  activeColor: "black" as const,
  historyValid: true,
  turnNumber: 7,
  winner: undefined,
};

function fixture() {
  const inviteId = `local-timer-${crypto.randomUUID()}`;
  const input = {
    inviteId,
    matchId: inviteId,
    playerId: "host-login",
    opponentId: "guest-login",
    epoch: 1,
  };
  const records = [input.playerId, input.opponentId].map((playerId, index) => ({
    matchId: inviteId,
    playerId,
    marker: `${playerId}-created`,
    value: {
      color: index === 0 ? "white" : "black",
      fen: "initial",
      flatMovesString: "",
      status: "",
      timer: "",
    } as MatchStateRecord,
  }));
  return { room: env.INVITE_REACTIONS.getByName(inviteId), input, records };
}

function options(extra: Partial<MatchStateStoreOptions> = {}) {
  const timerStarts = {
    getOrAdvance: vi.fn<MatchStateStoreOptions["timerStarts"]["getOrAdvance"]>(
      async () => {
        throw new Error("unexpected-d1-timer-write");
      },
    ),
    deletePair: vi.fn<MatchStateStoreOptions["timerStarts"]["deletePair"]>(
      async () => {
        throw new Error("unexpected-d1-timer-cleanup");
      },
    ),
  };
  return {
    timerStarts,
    newMatchTimerStorage: "local" as const,
    now: () => now,
    resolveGame: () => game,
    ...extra,
  };
}

function cohorts(storage: DurableObjectStorage) {
  return storage.sql
    .exec(
      "SELECT match_id, mode, schema_version FROM match_state_timer_cohorts ORDER BY match_id",
    )
    .toArray();
}

function markers(storage: DurableObjectStorage) {
  return storage.sql
    .exec("SELECT * FROM match_state_timer_starts ORDER BY match_id, player_id")
    .toArray();
}

function expectNoD1(settings: ReturnType<typeof options>) {
  expect(settings.timerStarts.getOrAdvance).not.toHaveBeenCalled();
  expect(settings.timerStarts.deletePair).not.toHaveBeenCalled();
}

describe("local timer cohorts", () => {
  it("defaults missing activation to D1 and rejects unknown settings", () => {
    expect(parseNewMatchTimerStorage(undefined)).toBe("d1");
    expect(parseNewMatchTimerStorage("d1")).toBe("d1");
    expect(parseNewMatchTimerStorage("local")).toBe("local");
    for (const value of [null, "", "LOCAL", " local", false])
      expect(() => parseNewMatchTimerStorage(value)).toThrow(
        "invalid-new-match-timer-storage",
      );
  });

  it("creates one cohort atomically with a pair and reuses concurrent deadlines", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      let clock = now;
      const settings = options({ now: () => clock });
      const store = new MatchStateStore(ctx.storage, settings);
      store.createRecords({ ...input, records });
      expect(cohorts(ctx.storage)).toEqual([
        { match_id: input.matchId, mode: "local", schema_version: 1 },
      ]);
      const before = store.readPair(input);
      const first = store.startTimer(input);
      clock += 5_000;
      const results = await Promise.all([
        first,
        ...Array.from({ length: 8 }, () => store.startTimer(input)),
      ]);
      expect(new Set(results.map((result) => result.timer))).toEqual(
        new Set([formatMatchTimer(7, now + 90_500)]),
      );
      expect(store.readPair(input).revision).toBe(before.revision + 1);
      expect(markers(ctx.storage)).toEqual([
        {
          match_id: input.matchId,
          player_id: input.playerId,
          opponent_id: input.opponentId,
          timer: results[0].timer,
          turn_number: 7,
          updated_at_ms: now,
        },
      ]);
      expectNoD1(settings);
    });
  });

  it("preserves a seeded deadline without incrementing the match revision", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      records[0].value.timer = formatMatchTimer(7, now + 100);
      const settings = options();
      const store = new MatchStateStore(ctx.storage, settings);
      store.createRecords({ ...input, records });
      const before = store.readPair(input);
      expect((await store.startTimer(input)).timer).toBe(
        records[0].value.timer,
      );
      expect(store.readPair(input)).toEqual(before);
      expectNoD1(settings);
    });
  });

  it("rolls back cohort creation when a later record conflicts", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      expect(() =>
        store.createRecords({
          ...input,
          records: [...records, { ...records[0], marker: "conflicting" }],
        }),
      ).toThrow("match-creation-conflict");
      expect(cohorts(ctx.storage)).toEqual([]);
      expect(markers(ctx.storage)).toEqual([]);
      expect(
        ctx.storage.sql.exec("SELECT * FROM match_state_records").toArray(),
      ).toEqual([]);
    });
  });

  it("rolls back a local marker and match when revision persistence fails", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const settings = options();
      const store = new MatchStateStore(ctx.storage, settings);
      store.createRecords({ ...input, records });
      ctx.storage.sql.exec(
        "UPDATE match_state_revisions SET revision = ? WHERE match_id = ?",
        Number.MAX_SAFE_INTEGER,
        input.matchId,
      );
      const before = store.readPair(input);
      await expect(store.startTimer(input)).rejects.toThrow(
        "match-state-revision-exhausted",
      );
      expect(store.readPair(input)).toEqual(before);
      expect(markers(ctx.storage)).toEqual([]);
      expectNoD1(settings);
    });
  });

  it.each(["records", "revisions", "claims"] as const)(
    "keeps preexisting %s on D1 even when the remaining pair is created locally",
    async (prior) => {
      const { room, input, records } = fixture();
      await runInDurableObject(room, async (_instance, ctx) => {
        const getOrAdvance = vi.fn<
          MatchStateStoreOptions["timerStarts"]["getOrAdvance"]
        >(async (_player, _opponent, _match, candidate, updatedAtMs) => ({
          ...candidate,
          updatedAtMs,
        }));
        const settings = options({
          timerStarts: { getOrAdvance, deletePair: vi.fn(async () => {}) },
        });
        const store = new MatchStateStore(ctx.storage, settings);
        seedRetainedMatchState(ctx.storage, {
          ...input,
          importId: "retained-import",
          records:
            prior === "records"
              ? [
                  {
                    ...records[0],
                    value: {
                      ...records[0].value,
                      sessionCreation: records[0].marker,
                    },
                  },
                ]
              : [],
          claims:
            prior === "claims" ? [{ matchId: input.matchId, value: {} }] : [],
        });
        if (prior === "revisions")
          ctx.storage.sql.exec(
            "INSERT INTO match_state_revisions(match_id, revision) VALUES (?, 4)",
            input.matchId,
          );
        store.createRecords({ ...input, records });
        store.createRecords({ ...input, records });
        expect(cohorts(ctx.storage)).toEqual([]);
        await store.startTimer(input);
        expect(getOrAdvance).toHaveBeenCalledOnce();
        expect(markers(ctx.storage)).toEqual([]);
      });
    },
  );

  it("keeps cohorts through partial pairs, config changes and mixed rematches", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const legacySettings = options({ newMatchTimerStorage: "d1" });
      const legacy = new MatchStateStore(ctx.storage, legacySettings);
      legacy.createRecords({ ...input, records: [records[0]] });
      const localSettings = options();
      const local = new MatchStateStore(ctx.storage, localSettings);
      local.createRecords({ ...input, records });
      const next = `${input.matchId}1`;
      local.createRecords({
        ...input,
        records: [{ ...records[0], matchId: next }],
      });
      const rollback = new MatchStateStore(ctx.storage, legacySettings);
      rollback.createRecords({
        ...input,
        records: records.map((record) => ({ ...record, matchId: next })),
      });
      expect(cohorts(ctx.storage)).toEqual([
        { match_id: input.matchId, mode: "d1", schema_version: 1 },
        { match_id: next, mode: "local", schema_version: 1 },
      ]);
      await rollback.startTimer({ ...input, matchId: next });
      expectNoD1(legacySettings);
      await expect(local.startTimer(input)).rejects.toThrow(
        "unexpected-d1-timer-write",
      );
      expect(localSettings.timerStarts.getOrAdvance).toHaveBeenCalledOnce();
      expect(markers(ctx.storage)).toHaveLength(1);
    });
  });

  it("uses the same creation rule for event effects and receipt replays", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const legacy = new MatchStateStore(
        ctx.storage,
        options({ newMatchTimerStorage: "d1" }),
      );
      const request = {
        ...input,
        operationId: "event-create",
        creations: records,
      };
      legacy.applyEventEffects(request);
      const local = new MatchStateStore(ctx.storage, options());
      expect(local.applyEventEffects(request).changedMatchIds).toEqual([]);
      const next = `${input.matchId}1`;
      local.applyEventEffects({
        ...input,
        operationId: "event-rematch",
        creations: records.map((record) => ({ ...record, matchId: next })),
      });
      expect(cohorts(ctx.storage)).toEqual([
        { match_id: input.matchId, mode: "d1", schema_version: 1 },
        { match_id: next, mode: "local", schema_version: 1 },
      ]);
    });
  });

  it("preserves the highest marker turn across moves and takebacks", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      let clock = now;
      const settings = options({
        now: () => clock,
        resolveGame: (player) => ({
          ...game,
          turnNumber: player.flatMovesString === "a" ? 9 : 7,
        }),
      });
      const store = new MatchStateStore(ctx.storage, settings);
      store.createRecords({ ...input, records });
      await store.startTimer(input);
      const moveInput = {
        inviteId: input.inviteId,
        matchId: input.matchId,
        playerId: input.playerId,
        epoch: input.epoch,
      };
      store.move({
        ...moveInput,
        previousFlatMovesString: "",
        flatMovesString: "a",
        fen: "later",
      });
      clock += 10_000;
      const advanced = await store.startTimer(input);
      expect(advanced.timer).toBe(formatMatchTimer(9, clock + 90_500));
      const saved = markers(ctx.storage);
      store.move({
        ...moveInput,
        previousFlatMovesString: "a",
        flatMovesString: "a-takeback",
        fen: "initial",
      });
      const before = store.readPair(input);
      await expect(store.startTimer(input)).rejects.toThrow(
        "game state changed.",
      );
      expect(store.readPair(input)).toEqual(before);
      expect(markers(ctx.storage)).toEqual(saved);
      ctx.storage.sql.exec(
        "UPDATE match_state_records SET value_json = json_set(value_json, '$.timer', '') WHERE match_id = ? AND player_id = ?",
        input.matchId,
        input.playerId,
      );
      await expect(store.startTimer(input)).rejects.toThrow(
        "game state changed.",
      );
      expect(markers(ctx.storage)).toEqual(saved);
      expectNoD1(settings);
    });
  });

  it("claims and replays local timers without D1 access or changing retained markers", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      let clock = now;
      const settings = options({ now: () => clock });
      const store = new MatchStateStore(ctx.storage, settings);
      store.createRecords({ ...input, records });
      const started = await store.startTimer(input);
      const saved = markers(ctx.storage);
      clock += 100_000;
      const request = { ...input, eventId: "local-timer-event" };
      expect(await store.claimTimer(request)).toEqual({ ok: true });
      const committed = store.readPair(input);
      const effects = store.listDueEffects();
      const alarm = await ctx.storage.getAlarm();
      expect(committed.playerMatch?.timer).toBe(MATCH_TIMER_TERMINAL);
      expect(committed.claim).toMatchObject({
        status: "claimed",
        timer: started.timer,
        claimedAtMs: clock,
      });
      expect(effects).toHaveLength(1);
      expect(alarm).toBe(clock);
      clock += 1_000;
      expect(await store.claimTimer(request)).toEqual({ ok: true });
      expect(store.readPair(input)).toEqual(committed);
      expect(store.listDueEffects()).toEqual(effects);
      expect(await ctx.storage.getAlarm()).toBe(alarm);
      expect(markers(ctx.storage)).toEqual(saved);
      expectNoD1(settings);
    });
  });

  it.each(["own-turn", "winner", "history", "terminal", "surrendered"])(
    "rejects local %s starts without D1 access or marker changes",
    async (condition) => {
      const { room, input, records } = fixture();
      await runInDurableObject(room, async (_instance, ctx) => {
        const settings = options({
          resolveGame: () => ({
            ...game,
            ...(condition === "own-turn"
              ? { activeColor: "white" as const }
              : {}),
            ...(condition === "winner" ? { winner: "white" as const } : {}),
            historyValid: condition !== "history",
          }),
        });
        const store = new MatchStateStore(ctx.storage, settings);
        if (condition === "terminal") {
          records[0].value.timer = MATCH_TIMER_TERMINAL;
          records[1].value.fen = "";
        }
        if (condition === "surrendered")
          records[1].value.status = "surrendered";
        store.createRecords({ ...input, records });
        const before = store.readPair(input);
        await expect(store.startTimer(input)).rejects.toMatchObject({
          status: 409,
        });
        expect(store.readPair(input)).toEqual(before);
        expect(markers(ctx.storage)).toEqual([]);
        expectNoD1(settings);
      });
    },
  );

  it.each([
    "missing-cohort",
    "d1-cohort",
    "timer",
    "opponent",
    "timestamp",
    "conflicting-deadline",
  ])(
    "fails closed on corrupt %s without falling back to D1",
    async (corruption) => {
      const { room, input, records } = fixture();
      await runInDurableObject(room, async (_instance, ctx) => {
        const settings = options();
        const store = new MatchStateStore(ctx.storage, settings);
        store.createRecords({ ...input, records });
        await store.startTimer(input);
        if (corruption === "missing-cohort")
          ctx.storage.sql.exec("DELETE FROM match_state_timer_cohorts");
        else if (corruption === "d1-cohort")
          ctx.storage.sql.exec(
            "UPDATE match_state_timer_cohorts SET mode = 'd1'",
          );
        else if (corruption === "timer")
          ctx.storage.sql.exec(
            "UPDATE match_state_timer_starts SET timer = 'invalid'",
          );
        else if (corruption === "opponent")
          ctx.storage.sql.exec(
            "UPDATE match_state_timer_starts SET opponent_id = 'other-login'",
          );
        else if (corruption === "timestamp")
          ctx.storage.sql.exec(
            "UPDATE match_state_timer_starts SET updated_at_ms = -1",
          );
        else
          ctx.storage.sql.exec(
            "UPDATE match_state_timer_starts SET timer = ?",
            formatMatchTimer(7, now + 100),
          );
        const before = store.readPair(input);
        const saved = markers(ctx.storage);
        await expect(store.startTimer(input)).rejects.toMatchObject({
          status: 503,
        });
        if (corruption === "missing-cohort" || corruption === "d1-cohort")
          await expect(
            store.cleanupLegacyTimerStarts(input),
          ).rejects.toMatchObject({
            status: 503,
          });
        expect(store.readPair(input)).toEqual(before);
        expect(markers(ctx.storage)).toEqual(saved);
        expectNoD1(settings);
      });
    },
  );

  it("rejects an unsupported persisted cohort version", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const settings = options();
      const store = new MatchStateStore(ctx.storage, settings);
      store.createRecords({ ...input, records });
      ctx.storage.sql.exec("DROP TABLE match_state_timer_cohorts");
      ctx.storage.sql.exec(
        "CREATE TABLE match_state_timer_cohorts(match_id TEXT PRIMARY KEY, mode TEXT, schema_version INTEGER)",
      );
      ctx.storage.sql.exec(
        "INSERT INTO match_state_timer_cohorts VALUES (?, 'local', 2)",
        input.matchId,
      );
      await expect(store.startTimer(input)).rejects.toMatchObject({
        status: 503,
      });
      await expect(store.cleanupLegacyTimerStarts(input)).rejects.toMatchObject(
        {
          status: 503,
        },
      );
      expectNoD1(settings);
    });
  });

  it("keeps local deadlines and skips legacy cleanup after eviction with D1 creation configured", async () => {
    const { room, input, records } = fixture();
    const first = await runInDurableObject(room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      store.createRecords({ ...input, records });
      return store.startTimer(input);
    });
    await evictDurableObject(room);
    await runInDurableObject(room, async (_instance, ctx) => {
      const settings = options({
        newMatchTimerStorage: "d1",
        now: () => now + 60_000,
      });
      const store = new MatchStateStore(ctx.storage, settings);
      const saved = markers(ctx.storage);
      const before = store.readPair(input);
      await store.cleanupLegacyTimerStarts(input);
      expect(markers(ctx.storage)).toEqual(saved);
      expect(store.readPair(input)).toEqual(before);
      expect(await store.startTimer(input)).toEqual(first);
      expectNoD1(settings);
    });
  });
});
