import assert from "node:assert/strict";
import test from "node:test";
import { Game } from "mons-rules";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { sweepMatchTimerStarts } from "../src/matchTimerStartSweep.ts";
import type { MatchTimerRecord } from "../src/matchTimer.ts";
import { createMemoryGameplayCoordinationStores } from "./gameplayCoordinationTestUtils.ts";

function match(
  color: "black" | "white",
  overrides: Partial<MatchTimerRecord> = {},
): MatchTimerRecord {
  return {
    color,
    fen: new Game().toFen(),
    flatMovesString: "",
    status: "",
    timer: "",
    ...overrides,
  };
}

function repository(
  records: Readonly<Record<string, unknown>>,
): Pick<GameplayRepository, "getRtdbPath"> {
  return {
    getRtdbPath: async (path) => records[path] ?? null,
  };
}

test("reconciles terminal and obsolete markers while retaining recoverable deadlines", async () => {
  const stores = createMemoryGameplayCoordinationStores();
  const markers = [
    ["terminal", "terminal-peer"],
    ["later", "later-peer"],
    ["winner", "winner-peer"],
    ["same", "same-peer"],
    ["malformed", "malformed-peer"],
  ] as const;
  for (const [playerId, opponentId] of markers) {
    await stores.timerStarts.getOrAdvance(
      playerId,
      opponentId,
      "match",
      { timer: "3;3000", turnNumber: 3 },
      100,
    );
  }
  stores.timerRows.set("legacy-terminal/legacy-terminal-match", {
    timer: "3;3000",
    turnNumber: 3,
    updatedAtMs: 100,
  });
  stores.timerRows.set("legacy-live/legacy-live-match", {
    timer: "3;3000",
    turnNumber: 3,
    updatedAtMs: 100,
  });
  const records = {
    "players/terminal/matches/match": match("black", {
      status: "surrendered",
    }),
    "players/terminal-peer/matches/match": match("white"),
    "players/later/matches/match": match("black", { timer: "4;4000" }),
    "players/later-peer/matches/match": match("white"),
    "players/winner/matches/match": match("black", {
      status: "winner-test",
    }),
    "players/winner-peer/matches/match": match("white"),
    "players/same/matches/match": match("black", { timer: "3;3000" }),
    "players/same-peer/matches/match": match("white"),
    "players/malformed/matches/match": { color: "black", fen: "" },
    "players/malformed-peer/matches/match": match("white"),
    "players/legacy-terminal/matches/legacy-terminal-match": { timer: "gg" },
    "invites/legacy-live-match": {
      hostId: "legacy-live",
      guestId: "legacy-live-peer",
    },
    "players/legacy-live/matches/legacy-live-match": match("black", {
      timer: "3;3000",
    }),
    "players/legacy-live-peer/matches/legacy-live-match": match("white"),
  };
  const result = await sweepMatchTimerStarts(
    stores.timerStarts,
    repository(records),
    {
      assertMutationAllowed: async () => undefined,
      logger: { error: () => undefined, info: () => undefined },
      now: () => 1_000,
      resolveGame: (player) => ({
        activeColor: "white",
        historyValid: true,
        turnNumber: 3,
        winner: player.status === "winner-test" ? "white" : undefined,
      }),
    },
  );
  assert.deepEqual(result, {
    deleted: 4,
    failed: 0,
    retained: 3,
    scanned: 7,
    stale: 0,
  });
  for (const key of [
    "terminal/match",
    "later/match",
    "winner/match",
    "legacy-terminal/legacy-terminal-match",
  ]) {
    assert.equal(stores.timerRows.has(key), false);
  }
  for (const key of [
    "same/match",
    "malformed/match",
    "legacy-live/legacy-live-match",
  ]) {
    assert.equal(stores.timerRows.get(key)?.updatedAtMs, 1_000);
  }
  assert.equal(stores.timerRows.get("same/match")?.timer, "3;3000");
});

test("cleans legacy markers from owner-only terminal and later-turn proof", async () => {
  const stores = createMemoryGameplayCoordinationStores();
  for (const playerId of ["terminal", "surrendered", "later"]) {
    stores.timerRows.set(`${playerId}/match-${playerId}`, {
      timer: "3;3000",
      turnNumber: 3,
      updatedAtMs: 100,
    });
  }
  const paths: string[] = [];
  const records: Record<string, unknown> = {
    "players/terminal/matches/match-terminal": { timer: "gg" },
    "players/surrendered/matches/match-surrendered": {
      status: "surrendered",
    },
    "players/later/matches/match-later": { timer: "4;4000" },
  };
  assert.deepEqual(
    await sweepMatchTimerStarts(
      stores.timerStarts,
      {
        getRtdbPath: async (path) => {
          paths.push(path);
          return records[path] ?? null;
        },
      },
      {
        assertMutationAllowed: async () => undefined,
        logger: { error: () => undefined, info: () => undefined },
      },
    ),
    { deleted: 3, failed: 0, retained: 0, scanned: 3, stale: 0 },
  );
  assert.equal(stores.timerRows.size, 0);
  assert.equal(
    paths.some((path) => path.startsWith("invites/")),
    false,
  );
  assert.equal(paths.length, 3);
});

test("keeps a concurrently advanced marker and reports a stale fence", async () => {
  const stores = createMemoryGameplayCoordinationStores();
  await stores.timerStarts.getOrAdvance(
    "player",
    "opponent",
    "match",
    { timer: "3;3000", turnNumber: 3 },
    100,
  );
  const deleteIfUnchanged = stores.timerStarts.deleteIfUnchanged;
  stores.timerStarts.deleteIfUnchanged = async (marker) => {
    await stores.timerStarts.getOrAdvance(
      "player",
      "opponent",
      "match",
      { timer: "4;4000", turnNumber: 4 },
      200,
    );
    return deleteIfUnchanged(marker);
  };
  assert.deepEqual(
    await sweepMatchTimerStarts(
      stores.timerStarts,
      repository({
        "players/player/matches/match": { status: "surrendered" },
        "players/opponent/matches/match": null,
      }),
      {
        assertMutationAllowed: async () => undefined,
        logger: { error: () => undefined, info: () => undefined },
      },
    ),
    { deleted: 0, failed: 0, retained: 0, scanned: 1, stale: 1 },
  );
  assert.deepEqual(stores.timerRows.get("player/match"), {
    timer: "4;4000",
    turnNumber: 4,
    updatedAtMs: 200,
  });
});

test("backfills one bounded legacy invite match without guessing ambiguous opponents", async () => {
  const stores = createMemoryGameplayCoordinationStores();
  const boundedMatchId = `x${"1".repeat(21)}`;
  for (const [playerId, matchId] of [
    ["resolved", "series12"],
    ["ambiguous", "amb12"],
    ["bounded", boundedMatchId],
  ]) {
    stores.timerRows.set(`${playerId}/${matchId}`, {
      timer: "3;3000",
      turnNumber: 3,
      updatedAtMs: 100,
    });
  }
  const records: Record<string, unknown> = {
    "invites/series": { hostId: "resolved", guestId: "resolved-peer" },
    "players/resolved/matches/series12": match("black", {
      timer: "3;3000",
    }),
    "players/resolved-peer/matches/series12": match("white"),
    "invites/amb1": { hostId: "ambiguous", guestId: "peer-1" },
    "invites/amb": { hostId: "ambiguous", guestId: "peer-2" },
  };
  const paths: string[] = [];
  const result = await sweepMatchTimerStarts(
    stores.timerStarts,
    {
      getRtdbPath: async (path) => {
        paths.push(path);
        return records[path] ?? null;
      },
    },
    {
      assertMutationAllowed: async () => undefined,
      logger: { error: () => undefined, info: () => undefined },
      now: () => 1_000,
      resolveGame: () => ({
        activeColor: "white",
        historyValid: true,
        turnNumber: 3,
        winner: undefined,
      }),
    },
  );
  assert.deepEqual(result, {
    deleted: 0,
    failed: 0,
    retained: 3,
    scanned: 3,
    stale: 0,
  });
  const markers = await stores.timerStarts.listOldest();
  assert.equal(
    markers.find(({ playerId }) => playerId === "resolved")?.opponentId,
    "resolved-peer",
  );
  assert.equal(
    markers.find(({ playerId }) => playerId === "ambiguous")?.opponentId,
    null,
  );
  assert.equal(
    markers.find(({ playerId }) => playerId === "bounded")?.opponentId,
    null,
  );
  assert.ok(paths.includes("invites/series"));
  assert.ok(paths.includes("players/resolved-peer/matches/series12"));
  assert.ok(paths.filter((path) => path.startsWith("invites/x")).length <= 17);
  assert.deepEqual(
    paths.filter((path) => path.startsWith("players/bounded/")),
    [`players/bounded/matches/${boundedMatchId}`],
  );
  assert.equal(
    paths.filter((path) => path.startsWith("players/ambiguous/")).length,
    1,
  );
});

test("rechecks profile control immediately before reconciliation writes", async () => {
  const stores = createMemoryGameplayCoordinationStores();
  await stores.timerStarts.getOrAdvance(
    "player",
    "opponent",
    "match",
    { timer: "3;3000", turnNumber: 3 },
    100,
  );
  await assert.rejects(
    () =>
      sweepMatchTimerStarts(
        stores.timerStarts,
        repository({
          "players/player/matches/match": { status: "surrendered" },
          "players/opponent/matches/match": null,
        }),
        {
          assertMutationAllowed: async () => {
            throw new Error("profile-writes-disabled");
          },
          logger: { error: () => undefined, info: () => undefined },
        },
      ),
    /profile-writes-disabled/,
  );
  assert.deepEqual(stores.timerRows.get("player/match"), {
    timer: "3;3000",
    turnNumber: 3,
    updatedAtMs: 100,
  });
});

test("blocks legacy backfill and touch writes when profile control freezes", async () => {
  for (const records of [
    {
      "invites/series": { hostId: "player", guestId: "opponent" },
    },
    {},
  ]) {
    const stores = createMemoryGameplayCoordinationStores();
    stores.timerRows.set("player/series1", {
      timer: "3;3000",
      turnNumber: 3,
      updatedAtMs: 100,
    });
    await assert.rejects(
      () =>
        sweepMatchTimerStarts(stores.timerStarts, repository(records), {
          assertMutationAllowed: async () => {
            throw new Error("profile-writes-disabled");
          },
          logger: { error: () => undefined, info: () => undefined },
          now: () => 1_000,
        }),
      /profile-writes-disabled/,
    );
    assert.deepEqual(await stores.timerStarts.listOldest(), [
      {
        matchId: "series1",
        opponentId: null,
        playerId: "player",
        timer: "3;3000",
        turnNumber: 3,
        updatedAtMs: 100,
      },
    ]);
  }
});

test("fails the sweep with a bounded sanitized summary", async () => {
  const stores = createMemoryGameplayCoordinationStores();
  await stores.timerStarts.getOrAdvance(
    "private-player",
    "private-opponent",
    "match",
    { timer: "3;3000", turnNumber: 3 },
    100,
  );
  const logs: string[] = [];
  await assert.rejects(
    () =>
      sweepMatchTimerStarts(
        stores.timerStarts,
        {
          getRtdbPath: async () => {
            throw new Error("private-rtdb-detail");
          },
        },
        {
          assertMutationAllowed: async () => undefined,
          logger: {
            error: (value) => logs.push(String(value)),
            info: () => {},
          },
        },
      ),
    /private-rtdb-detail/,
  );
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /private-player|private-rtdb-detail/);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: "match_timer_start_sweep_failed",
    deleted: 0,
    failed: 1,
    retained: 0,
    scanned: 1,
    stale: 0,
  });

  logs.length = 0;
  stores.timerStarts.listOldest = async () => {
    throw new Error("private-d1-detail");
  };
  await assert.rejects(
    () =>
      sweepMatchTimerStarts(stores.timerStarts, repository({}), {
        assertMutationAllowed: async () => undefined,
        logger: { error: (value) => logs.push(String(value)), info: () => {} },
      }),
    /private-d1-detail/,
  );
  assert.doesNotMatch(logs[0], /private-d1-detail/);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: "match_timer_start_sweep_failed",
    deleted: 0,
    failed: 1,
    retained: 0,
    scanned: 0,
    stale: 0,
  });
});
