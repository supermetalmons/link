import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMatchTimerStartStore,
  MATCH_TIMER_START_SWEEP_LIMIT,
} from "../src/gameplayCoordinationD1.ts";
import { requireActiveDurableMatchState } from "../src/matchStateAuthority.ts";
import { createMatchStateSource } from "../src/matchStateSource.ts";
import { getMatchStateRpc } from "../src/matchStateRpc.ts";
import type { MatchStateRecordsRequest } from "../src/matchStateTypes.ts";
import { sweepMatchTimerStarts } from "../src/matchTimerStartSweep.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";

const db = env.PROFILE_GAMES_DB;
const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const source = createMatchStateSource(env);
const store = createMatchTimerStartStore(db);

function archive(playerId: string, matchId: string, value: unknown) {
  return [
    db
      .prepare(
        "INSERT INTO match_state_routes(actor_uid, match_id, kind, invite_id, epoch) VALUES (?, ?, 'legacy', NULL, 2)",
      )
      .bind(playerId, matchId),
    db
      .prepare(
        "INSERT INTO match_state_legacy_records(actor_uid, match_id, record_json, source_digest, import_id, disposition) VALUES (?, ?, ?, ?, 'import', 'malformed')",
      )
      .bind(playerId, matchId, JSON.stringify(value), "a".repeat(64)),
  ];
}

function timer(
  playerId: string,
  opponentId: string,
  matchId: string,
  updatedAtMs = 100,
) {
  return db
    .prepare(
      "INSERT INTO match_timer_starts(player_id, match_id, opponent_id, timer, turn_number, updated_at_ms) VALUES (?, ?, ?, '3;3000', 3, ?)",
    )
    .bind(playerId, matchId, opponentId, updatedAtMs);
}

function sweep(nowMs: number, matchSource = source) {
  return sweepMatchTimerStarts(
    store,
    {
      readMatchRecord: matchSource.readMatchRecord,
      readMatchRecords: matchSource.readMatchRecords,
      async readInviteMetadata() {
        throw new Error("unexpected-invite-read-for-known-opponent");
      },
    },
    {
      async assertMutationAllowed() {
        await requireActiveDurableMatchState(db);
      },
      now: () => nowMs,
      logger: { error() {}, info() {} },
    },
  );
}

beforeAll(async () => {
  await applyStrictMatchStateTestMigrations(db, testEnv.TEST_D1_MIGRATIONS);
});

beforeEach(async () => {
  await db.prepare("DELETE FROM match_timer_starts").run();
});

describe("timer reconciliation through canonical match routing", () => {
  it("reads both durable players in one ordered RPC before deleting a terminal marker", async () => {
    const inviteId = `batched-recovery-${crypto.randomUUID()}`;
    await source.createMatchRecords({
      inviteId,
      transitionId: "create",
      records: [
        {
          playerId: "host",
          matchId: inviteId,
          marker: "host-created",
          value: { color: "white", fen: "initial" },
        },
        {
          playerId: "guest",
          matchId: inviteId,
          marker: "guest-created",
          value: { color: "black", fen: "initial", timer: "gg" },
        },
      ],
    });
    await timer("host", "guest", inviteId).run();
    const calls: MatchStateRecordsRequest[] = [];
    const observedEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "INVITE_REACTIONS")
          return {
            getByName: (roomId: string) => ({
              readCanonicalMatchRecords: (input: MatchStateRecordsRequest) => {
                expect(input.inviteId).toBe(roomId);
                calls.push(structuredClone(input));
                return getMatchStateRpc(env, roomId).readCanonicalMatchRecords(
                  input,
                );
              },
            }),
          };
        return Reflect.get(target, property, receiver);
      },
    });

    expect(await sweep(1_000, createMatchStateSource(observedEnv))).toEqual({
      deleted: 1,
      failed: 0,
      retained: 0,
      scanned: 1,
      stale: 0,
    });
    expect(calls).toEqual([
      {
        inviteId,
        epoch: 2,
        requests: [
          { playerId: "host", matchId: inviteId },
          { playerId: "guest", matchId: inviteId },
        ],
      },
    ]);
    expect(await store.listOldest()).toEqual([]);
  });

  it.each([
    { value: "retained-scalar" },
    { value: 7 },
    { value: ["retained"] },
  ])(
    "preserves archived JSON $value and deletes markers from terminal peer proof",
    async ({ value }) => {
      const matchId = `archived-${crypto.randomUUID()}`;
      await db.batch([
        ...archive("host", matchId, value),
        ...archive("guest", matchId, { timer: "gg" }),
        timer("host", "guest", matchId),
      ]);

      expect(
        await source.readMatchRecord({ playerId: "host", matchId }),
      ).toEqual(value);
      expect(await sweep(1_000)).toEqual({
        deleted: 1,
        failed: 0,
        retained: 0,
        scanned: 1,
        stale: 0,
      });
      expect(await store.listOldest()).toEqual([]);
    },
  );

  it("touches a full page of malformed archives so a later marker can recover", async () => {
    const prefix = crypto.randomUUID();
    const healthyMatchId = `${prefix}-healthy`;
    await db.batch([
      ...Array.from({ length: MATCH_TIMER_START_SWEEP_LIMIT }, (_, index) => {
        const matchId = `${prefix}-${index}`;
        return [
          ...archive("host", matchId, index % 2 ? "retained" : []),
          timer("host", "absent-peer", matchId),
        ];
      }).flat(),
      ...archive("healthy", healthyMatchId, { timer: "gg" }),
      timer("healthy", "absent-peer", healthyMatchId, 200),
    ]);

    expect(await sweep(1_000)).toEqual({
      deleted: 0,
      failed: 0,
      retained: MATCH_TIMER_START_SWEEP_LIMIT,
      scanned: MATCH_TIMER_START_SWEEP_LIMIT,
      stale: 0,
    });
    const nextPage = await store.listOldest();
    expect(nextPage[0]).toMatchObject({
      matchId: healthyMatchId,
      updatedAtMs: 200,
    });
    expect(nextPage.slice(1).every((row) => row.updatedAtMs === 1_000)).toBe(
      true,
    );
    expect(await sweep(2_000)).toMatchObject({
      deleted: 1,
      failed: 0,
      retained: MATCH_TIMER_START_SWEEP_LIMIT - 1,
      scanned: MATCH_TIMER_START_SWEEP_LIMIT,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM match_timer_starts WHERE match_id = ?",
        )
        .bind(healthyMatchId)
        .first<number>("count"),
    ).toBe(0);
  });

  it("retains a marker when its routed canonical record is unavailable", async () => {
    const inviteId = `unavailable-${crypto.randomUUID()}`;
    await source.createMatchRecords({
      inviteId,
      transitionId: "create",
      records: [
        {
          playerId: "present-player",
          matchId: inviteId,
          marker: "created",
          value: { color: "white", fen: "initial" },
        },
      ],
    });
    await db.batch([
      db
        .prepare(
          "INSERT INTO match_state_routes(actor_uid, match_id, kind, invite_id, epoch) VALUES ('missing-player', ?, 'durable', ?, 2)",
        )
        .bind(inviteId, inviteId),
      ...archive("terminal-peer", inviteId, { timer: "gg" }),
      timer("missing-player", "terminal-peer", inviteId),
    ]);

    await expect(sweep(1_000)).rejects.toThrow(
      "match-state-record-unavailable",
    );
    expect(await store.listOldest()).toMatchObject([
      { playerId: "missing-player", matchId: inviteId, updatedAtMs: 100 },
    ]);
  });
});
