import { evictCanonicalMatchRoom as evictDurableObject } from "./canonicalMatchTestFixture.ts";
import { matchEventEffectsFixture } from "./canonicalMatchTestFixture.ts";
import { runInCanonicalMatchWriterFixture as runInDurableObject } from "./canonicalMatchTestFixture.ts";
import {
  matchDocumentFixture,
  matchRecordFixture,
} from "../test/matchRecordFixture.ts";
import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";
import { formatMatchTimer, MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import {
  MatchStateStore,
  type MatchStateStoreOptions,
} from "../src/matchStateStore.ts";

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
    value: matchDocumentFixture({
      color: index === 0 ? "white" : "black",
      fen: "initial",
      flatMovesString: "",
      status: "",
      timer: "",
    }),
  }));
  return { room: env.INVITE_REACTIONS.getByName(inviteId), input, records };
}

function options(
  extra: Partial<MatchStateStoreOptions> = {},
): MatchStateStoreOptions {
  return { now: () => now, resolveGame: () => game, ...extra };
}

function cohorts(storage: DurableObjectStorage) {
  return storage.sql
    .exec(
      "SELECT match_id, mode, schema_version FROM match_state_timer_cohorts_canonical ORDER BY match_id",
    )
    .toArray();
}

function markers(storage: DurableObjectStorage) {
  return storage.sql
    .exec(
      "SELECT * FROM match_state_timer_starts_canonical ORDER BY match_id, player_id",
    )
    .toArray();
}

describe("local timer cohorts", () => {
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
      expect(
        new Set(results.map((result) => JSON.stringify(result.timer))),
      ).toEqual(new Set([JSON.stringify(formatMatchTimer(7, now + 90_500))]));
      expect(store.readPair(input).revision).toBe(before.revision + 1);
      expect(markers(ctx.storage)).toEqual([
        {
          match_id: input.matchId,
          player_id: input.playerId,
          opponent_id: input.opponentId,
          deadline_at_ms: results[0]!.timer.deadlineAtMs,
          turn_number: 7,
          updated_at_ms: now,
        },
      ]);
    });
  });

  it("preserves a seeded deadline without incrementing the match revision", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      records[0]!.value.timer = formatMatchTimer(7, now + 100);
      const settings = options();
      const store = new MatchStateStore(ctx.storage, settings);
      store.createRecords({ ...input, records });
      const before = store.readPair(input);
      expect((await store.startTimer(input)).timer).toEqual(
        records[0]!.value.timer,
      );
      expect(store.readPair(input)).toEqual(before);
    });
  });

  it("rolls back cohort creation when a later record conflicts", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      expect(() =>
        store.createRecords({
          ...input,
          records: [...records, { ...records[0]!, marker: "conflicting" }],
        }),
      ).toThrow("match-creation-conflict");
      expect(cohorts(ctx.storage)).toEqual([]);
      expect(markers(ctx.storage)).toEqual([]);
      expect(
        ctx.storage.sql
          .exec("SELECT * FROM match_state_records_canonical")
          .toArray(),
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
        "UPDATE match_state_revisions_canonical SET revision = ? WHERE match_id = ?",
        Number.MAX_SAFE_INTEGER,
        input.matchId,
      );
      const before = store.readPair(input);
      await expect(store.startTimer(input)).rejects.toThrow(
        "match-state-revision-exhausted",
      );
      expect(store.readPair(input)).toEqual(before);
      expect(markers(ctx.storage)).toEqual([]);
    });
  });

  it("keeps local cohorts through partial pairs, retries and new rematches", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      store.createRecords({ ...input, records: [records[0]!] });
      store.createRecords({ ...input, records });
      store.createRecords({ ...input, records });
      const next = `${input.matchId}1`;
      store.createRecords({
        ...input,
        records: records.map((record) => ({ ...record, matchId: next })),
      });
      expect(cohorts(ctx.storage)).toEqual([
        { match_id: input.matchId, mode: "local", schema_version: 1 },
        { match_id: next, mode: "local", schema_version: 1 },
      ]);
      await store.startTimer({ ...input, matchId: next });
      expect(markers(ctx.storage)).toHaveLength(1);
    });
  });

  it("uses the same creation rule for event effects and receipt replays", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const previous = new MatchStateStore(ctx.storage, options());
      const request = matchEventEffectsFixture({
        ...input,
        operationId: "event-create",
        creations: records,
      });
      await previous.applyEventEffects(request);
      const local = new MatchStateStore(ctx.storage, options());
      expect((await local.applyEventEffects(request)).changedMatchIds).toEqual(
        [],
      );
      const next = `${input.matchId}1`;
      await local.applyEventEffects(
        matchEventEffectsFixture({
          ...input,
          operationId: "event-rematch",
          creations: records.map((record) => ({ ...record, matchId: next })),
        }),
      );
      expect(cohorts(ctx.storage)).toEqual([
        { match_id: input.matchId, mode: "local", schema_version: 1 },
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
      expect(advanced.timer).toEqual(formatMatchTimer(9, clock + 90_500));
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
        `UPDATE match_state_records_canonical SET value_json = json_set(value_json, '$.timer', json('{"state":"idle"}')) WHERE match_id = ? AND player_id = ?`,
        input.matchId,
        input.playerId,
      );
      await expect(store.startTimer(input)).rejects.toThrow(
        "game state changed.",
      );
      expect(markers(ctx.storage)).toEqual(saved);
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
      const effects = store.effects.listDueEffects();
      const alarm = await ctx.storage.getAlarm();
      expect(matchRecordFixture(committed.playerMatch)?.timer).toEqual(
        MATCH_TIMER_TERMINAL,
      );
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
      expect(store.effects.listDueEffects()).toEqual(effects);
      expect(await ctx.storage.getAlarm()).toBe(alarm);
      expect(markers(ctx.storage)).toEqual(saved);
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
          records[0]!.value.timer = MATCH_TIMER_TERMINAL;
          records[1]!.value.fen = "invalid-position";
        }
        if (condition === "surrendered")
          records[1]!.value.status = "surrendered";
        store.createRecords({ ...input, records });
        const before = store.readPair(input);
        await expect(store.startTimer(input)).rejects.toMatchObject({
          status: 409,
        });
        expect(store.readPair(input)).toEqual(before);
        expect(markers(ctx.storage)).toEqual([]);
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
          ctx.storage.sql.exec(
            "DELETE FROM match_state_timer_cohorts_canonical",
          );
        else if (corruption === "d1-cohort") {
          expect(() =>
            ctx.storage.sql.exec(
              "UPDATE match_state_timer_cohorts_canonical SET mode = 'd1'",
            ),
          ).toThrow("match-timer-storage-local-required");
          return;
        } else if (corruption === "timer") {
          expect(() =>
            ctx.storage.sql.exec(
              "UPDATE match_state_timer_starts_canonical SET deadline_at_ms = 'invalid'",
            ),
          ).toThrow();

          return;
        } else if (corruption === "opponent")
          ctx.storage.sql.exec(
            "UPDATE match_state_timer_starts_canonical SET opponent_id = 'other-login'",
          );
        else if (corruption === "timestamp") {
          expect(() =>
            ctx.storage.sql.exec(
              "UPDATE match_state_timer_starts_canonical SET updated_at_ms = -1",
            ),
          ).toThrow();

          return;
        } else
          ctx.storage.sql.exec(
            "UPDATE match_state_timer_starts_canonical SET deadline_at_ms = ?",
            now + 100,
          );
        const before = store.readPair(input);
        const saved = markers(ctx.storage);
        await expect(store.startTimer(input)).rejects.toMatchObject({
          status: 503,
        });
        expect(store.readPair(input)).toEqual(before);
        expect(markers(ctx.storage)).toEqual(saved);
      });
    },
  );

  it("rejects an unsupported persisted cohort version", async () => {
    const { room, input, records } = fixture();
    await runInDurableObject(room, async (_instance, ctx) => {
      const settings = options();
      const store = new MatchStateStore(ctx.storage, settings);
      store.createRecords({ ...input, records });
      ctx.storage.sql.exec("DROP TABLE match_state_timer_cohorts_canonical");
      ctx.storage.sql.exec(
        "CREATE TABLE match_state_timer_cohorts_canonical(match_id TEXT PRIMARY KEY, mode TEXT, schema_version INTEGER)",
      );
      ctx.storage.sql.exec(
        "INSERT INTO match_state_timer_cohorts_canonical VALUES (?, 'local', 2)",
        input.matchId,
      );
      await expect(store.startTimer(input)).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  it("keeps local deadlines and marker identity after eviction", async () => {
    const { room, input, records } = fixture();
    const first = await runInDurableObject(room, async (_instance, ctx) => {
      const store = new MatchStateStore(ctx.storage, options());
      store.createRecords({ ...input, records });
      return store.startTimer(input);
    });
    await evictDurableObject(room);
    await runInDurableObject(room, async (_instance, ctx) => {
      const settings = options({
        now: () => now + 60_000,
      });
      const store = new MatchStateStore(ctx.storage, settings);
      const saved = markers(ctx.storage);
      const before = store.readPair(input);
      expect(markers(ctx.storage)).toEqual(saved);
      expect(store.readPair(input)).toEqual(before);
      expect(await store.startTimer(input)).toEqual(first);
    });
  });
});
