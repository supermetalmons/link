import { publicMatchFixture } from "./matchRecordFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Game, GameVariant } from "mons-rules";
import type { MatchTimer } from "@mons/shared/timers";
import { classifyTransitionHistoricalMatchPair } from "../src/historicalMatches.ts";
import { parseAutomatchProfileGameProjectionOutbox } from "../src/profileGameProjectionOutbox.ts";
import { processAutomatchProfileGameProjection } from "../src/profileGameProjection.ts";
import type { ProfileGameProjectionRuntime } from "../src/profileGameProjectionRepository.ts";
import { attachProjectionTestPorts } from "./projectionTestPorts.ts";

const inviteId = "archive-fixture";
const outboxPath = `profileGameProjectionOutbox/automatch/${inviteId}`;
const task = {
  kind: "automatch-profile-game-projection" as const,
  inviteId,
  requestId: "request-1",
};
const logger = { error() {}, info() {} };

function descriptor() {
  return {
    finalizedAtMs: 100,
    hostPlayerId: "host",
    guestPlayerId: "guest",
    source: "transition",
    retryNotBeforeMs: null,
  };
}

function match(color: "white" | "black", terminal = false) {
  return publicMatchFixture({
    version: 2,
    color,
    emojiId: 1,
    aura: "none" as const,
    gameVariant: GameVariant.ForwardBridgeManaRows,
    fen: new Game({ variant: GameVariant.ForwardBridgeManaRows }).toFen(),
    status: terminal ? "surrendered" : "",
    flatMovesString: "",
    timer: "",
  });
}

function serializedTimerPair(actor: "host" | "guest", timer: MatchTimer) {
  const game = new Game();
  const initialFen = game.toFen();
  const moves = ["l10,5;l9,4", "l9,4;l8,5"];
  for (const move of moves) {
    assert.equal(game.playFen(move).kind, "complete");
  }
  const claimant = {
    ...match("black"),
    gameVariant: game.variant,
    fen: initialFen,
    timer,
  };
  const opponent = {
    ...match("white"),
    gameVariant: game.variant,
    fen: game.toFen(),
    flatMovesString: moves.join("-"),
  };
  const hostMatch: unknown = JSON.parse(
    JSON.stringify(actor === "host" ? claimant : opponent),
  );
  const guestMatch: unknown = JSON.parse(
    JSON.stringify(actor === "guest" ? claimant : opponent),
  );
  return {
    ...descriptor(),
    matchId: inviteId,
    hostMatch,
    guestMatch,
  };
}

function fixture(matchIds = [inviteId]) {
  let clock = 1_000;
  let acquisitions = 0;
  let sourceReads = 0;
  let projections = 0;
  const archived: string[] = [];
  const values = new Map<string, unknown>([
    [
      outboxPath,
      {
        schemaVersion: 2,
        archiveRetry: null,
        status: "pending",
        requestId: task.requestId,
        reason: "manual-hostRematches-ended",
        sourceUpdatedAtMs: 100,
        lastQueuedAtMs: 100,
        historicalMatches: Object.fromEntries(
          matchIds.map((id) => [id, descriptor()]),
        ),
      },
    ],
  ]);
  for (const id of matchIds) {
    values.set(`players/host/matches/${id}`, match("black"));
    values.set(`players/guest/matches/${id}`, match("white"));
  }
  const state = attachProjectionTestPorts({
    getStatePath: async (path: string) => {
      if (path.startsWith("players/")) sourceReads++;
      return structuredClone(values.get(path));
    },
    transactStatePath: async (
      path: string,
      updater: (value: unknown) => unknown,
    ) => {
      const result = updater(structuredClone(values.get(path))) as {
        commit?: false;
        decision?: string;
        value?: unknown;
      };
      if (result.commit === false)
        return {
          committed: false,
          ...(result.decision === undefined
            ? {}
            : { decision: result.decision }),
          value: values.get(path),
        };
      values.set(path, result.value);
      return {
        committed: true,
        ...(result.decision === undefined ? {} : { decision: result.decision }),
        value: result.value,
      };
    },
  });
  const locks = {
    async acquire() {
      acquisitions++;
    },
    async release() {},
    async deleteExpired() {
      return 0;
    },
  };
  const runtime: ProfileGameProjectionRuntime = {
    async recomputeInviteProjection() {
      projections++;
      return {
        inviteId,
        ok: true,
        reason: "archive-test",
        skipped: 0,
        sourceCleanupSafe: true,
      };
    },
    async archiveHistoricalMatch({ pair }) {
      archived.push(pair.matchId);
    },
  };
  return {
    archived,
    locks,
    runtime,
    state,
    values,
    clock: (value: number) => {
      clock = value;
    },
    counts: () => ({ acquisitions, projections, sourceReads }),
    outbox: () =>
      parseAutomatchProfileGameProjectionOutbox(values.get(outboxPath)),
    process: (requestId = task.requestId) =>
      processAutomatchProfileGameProjection(
        { ...task, requestId },
        state,
        runtime,
        locks,
        "owner",
        () => clock,
        logger,
      ),
  };
}

test("transition classification distinguishes initial, missing and terminal sources", () => {
  const input = {
    ...descriptor(),
    matchId: inviteId,
    hostMatch: match("black"),
    guestMatch: match("white"),
  };
  assert.deepEqual(classifyTransitionHistoricalMatchPair(input), {
    status: "unready",
  });
  assert.deepEqual(
    classifyTransitionHistoricalMatchPair({ ...input, guestMatch: null }),
    { status: "unavailable" },
  );
  const ready = classifyTransitionHistoricalMatchPair({
    ...input,
    hostMatch: match("black", true),
  });
  assert.equal(ready.status, "ready");
});

for (const actor of ["host", "guest"] as const) {
  test(`serialized finished ${actor} timer makes valid history ready`, () => {
    const input = serializedTimerPair(actor, { state: "finished" });
    const result = classifyTransitionHistoricalMatchPair(input);
    assert.equal(result.status, "ready");
    if (result.status !== "ready") assert.fail("expected ready history");
    assert.deepEqual(result.pair.hostMatch, input.hostMatch);
    assert.deepEqual(result.pair.guestMatch, input.guestMatch);
  });

  test(`serialized idle and running ${actor} timers leave history unready`, () => {
    const timers: MatchTimer[] = [
      { state: "idle" },
      { state: "running", turnNumber: 0, deadlineAtMs: 1 },
    ];
    for (const timer of timers) {
      assert.deepEqual(
        classifyTransitionHistoricalMatchPair(
          serializedTimerPair(actor, timer),
        ),
        { status: "unready" },
      );
    }
  });

  test(`transition projection archives a serialized finished ${actor} timer without deferral`, async () => {
    const f = fixture();
    const input = serializedTimerPair(actor, { state: "finished" });
    f.values.set(`players/host/matches/${inviteId}`, input.hostMatch);
    f.values.set(`players/guest/matches/${inviteId}`, input.guestMatch);
    assert.equal(await f.process(), "projected");
    assert.deepEqual(f.archived, [inviteId]);
    assert.equal(f.outbox(), null);
    const completedCounts = f.counts();
    assert.equal(await f.process(), "stale");
    assert.deepEqual(f.counts(), completedCounts);
    assert.deepEqual(f.archived, [inviteId]);
  });
}

test("unready history retains its descriptor and duplicate deliveries do no work until recovery", async () => {
  const f = fixture();
  assert.equal(await f.process(), "deferred");
  assert.deepEqual(f.outbox()?.archiveRetry, {
    requestId: task.requestId,
    notBeforeMs: 301_000,
  });
  assert.equal(f.outbox()?.lastQueuedAtMs, 1_000);
  assert.deepEqual(f.outbox()?.historicalMatches, [
    { ...descriptor(), matchId: inviteId, retryNotBeforeMs: 301_000 },
  ]);
  const firstCounts = f.counts();
  for (let index = 0; index < 20; index++)
    assert.equal(await f.process(), "deferred");
  assert.deepEqual(f.counts(), firstCounts);
  f.clock(301_000);
  assert.equal(await f.process(), "deferred");
  assert.equal(f.outbox()?.historicalMatches?.[0]?.retryNotBeforeMs, 601_000);
  f.values.set(`players/host/matches/${inviteId}`, match("black", true));
  f.clock(601_000);
  assert.equal(await f.process(), "projected");
  assert.deepEqual(f.archived, [inviteId]);
  assert.equal(f.outbox(), null);
});

test("five deferred histories cannot prevent a later valid history from archiving", async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `${inviteId}${index}`);
  const f = fixture(ids);
  f.values.set(`players/host/matches/${ids[5]}`, match("black", true));
  assert.equal(await f.process(), "continued");
  assert.equal(f.outbox()?.archiveRetry, null);
  assert.equal(await f.process(), "deferred");
  assert.deepEqual(f.archived, [ids[5]]);
  assert.equal(f.outbox()?.historicalMatches?.length, 5);
});

test("a newer projection bypasses an earlier request gate without losing descriptor cooldowns", async () => {
  const f = fixture();
  assert.equal(await f.process(), "deferred");
  const old = f.values.get(outboxPath) as Record<string, unknown>;
  f.values.set(outboxPath, {
    ...old,
    requestId: "request-2",
    archiveRetry: null,
    sourceUpdatedAtMs: 2_000,
  });
  const firstCounts = f.counts();
  assert.equal(await f.process("request-2"), "deferred");
  assert.equal(f.counts().projections, firstCounts.projections + 1);
  assert.equal(f.counts().sourceReads, firstCounts.sourceReads);
  assert.equal(f.outbox()?.archiveRetry?.requestId, "request-2");
  assert.equal(f.outbox()?.historicalMatches?.[0]?.retryNotBeforeMs, 301_000);
});

test("a superseding request cannot receive an old descriptor deferral or settlement", async () => {
  const f = fixture();
  f.runtime.recomputeInviteProjection = async () => {
    const current = f.values.get(outboxPath) as Record<string, unknown>;
    f.values.set(outboxPath, { ...current, requestId: "request-2" });
    return {
      inviteId,
      ok: true,
      reason: "newer",
      skipped: 0,
      sourceCleanupSafe: true,
    };
  };
  assert.equal(await f.process(), "superseded");
  assert.equal(f.outbox()?.requestId, "request-2");
  assert.equal(f.outbox()?.archiveRetry, null);
  assert.equal(f.outbox()?.historicalMatches?.[0]?.retryNotBeforeMs, undefined);
});

test("archive infrastructure failures propagate without gating or dropping history", async () => {
  const f = fixture();
  f.values.set(`players/host/matches/${inviteId}`, match("black", true));
  const failure = new Error("archive-storage-unavailable");
  f.runtime.archiveHistoricalMatch = async () => {
    throw failure;
  };
  await assert.rejects(f.process(), (error) => error === failure);
  assert.equal(f.outbox()?.archiveRetry, null);
  assert.equal(f.outbox()?.historicalMatches?.[0]?.retryNotBeforeMs, undefined);
  assert.equal(f.outbox()?.historicalMatches?.length, 1);
});

test("missing source defers but a failed source read remains retryable", async () => {
  const missing = fixture();
  missing.values.delete(`players/host/matches/${inviteId}`);
  missing.values.delete(`players/guest/matches/${inviteId}`);
  assert.equal(await missing.process(), "deferred");
  assert.equal(missing.outbox()?.historicalMatches?.length, 1);
  assert.deepEqual(missing.archived, []);

  const unavailable = fixture();
  const failure = new Error("match-store-unavailable");
  unavailable.state.readMatchPair = async () => {
    throw failure;
  };
  await assert.rejects(unavailable.process(), (error) => error === failure);
  assert.equal(unavailable.outbox()?.archiveRetry, null);
  assert.equal(
    unavailable.outbox()?.historicalMatches?.[0]?.retryNotBeforeMs,
    undefined,
  );
});

test("a concurrent deferral is checked again after acquiring the lock", async () => {
  const f = fixture();
  f.locks.acquire = async () => {
    const current = f.values.get(outboxPath) as Record<string, unknown>;
    f.values.set(outboxPath, {
      ...current,
      archiveRetry: { requestId: task.requestId, notBeforeMs: 301_000 },
      historicalMatches: {
        [inviteId]: { ...descriptor(), retryNotBeforeMs: 301_000 },
      },
    });
  };
  assert.equal(await f.process(), "deferred");
  assert.equal(f.counts().projections, 0);
  assert.equal(f.counts().sourceReads, 0);
});

test("a projection read failure cannot suppress delivery or change archive recovery", async () => {
  const f = fixture();
  const before = structuredClone(f.values.get(outboxPath));
  const failure = new Error("projection-store-unavailable");
  f.runtime.recomputeInviteProjection = async () => {
    throw failure;
  };
  await assert.rejects(f.process(), (error) => error === failure);
  assert.deepEqual(f.values.get(outboxPath), before);
  assert.equal(f.counts().sourceReads, 0);
});

test("malformed retry metadata is rejected without salvaging executable history", () => {
  const f = fixture();
  const current = f.values.get(outboxPath) as Record<string, unknown>;
  for (const retryNotBeforeMs of [-1, "later", Infinity]) {
    assert.equal(
      parseAutomatchProfileGameProjectionOutbox({
        ...current,
        historicalMatches: {
          [inviteId]: { ...descriptor(), retryNotBeforeMs },
        },
      }),
      null,
    );
  }
});
