import assert from "node:assert/strict";
import test from "node:test";
import { Game, GameVariant } from "mons-rules";
import { classifyTransitionHistoricalMatchPair } from "../src/historicalMatches.ts";
import {
  parseAutomatchProfileGameProjectionOutbox,
  salvageHistoricalMatchDescriptors,
} from "../src/profileGameProjectionOutbox.ts";
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
  };
}

function match(color: "white" | "black", terminal = false) {
  return {
    version: 2,
    color,
    emojiId: 1,
    aura: "",
    gameVariant: GameVariant.ForwardBridgeManaRows,
    fen: new Game({ variant: GameVariant.ForwardBridgeManaRows }).toFen(),
    status: terminal ? "surrendered" : "",
    flatMovesString: "",
    timer: "",
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
        schemaVersion: 1,
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
          decision: result.decision,
          value: values.get(path),
        };
      values.set(path, result.value);
      return {
        committed: true,
        decision: result.decision,
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
  assert.equal(f.outbox()?.historicalMatches?.[0].retryNotBeforeMs, 601_000);
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
  assert.equal(f.outbox()?.archiveRetry, undefined);
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
    sourceUpdatedAtMs: 2_000,
  });
  const firstCounts = f.counts();
  assert.equal(await f.process("request-2"), "deferred");
  assert.equal(f.counts().projections, firstCounts.projections + 1);
  assert.equal(f.counts().sourceReads, firstCounts.sourceReads);
  assert.equal(f.outbox()?.archiveRetry?.requestId, "request-2");
  assert.equal(f.outbox()?.historicalMatches?.[0].retryNotBeforeMs, 301_000);
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
  assert.equal(f.outbox()?.archiveRetry, undefined);
  assert.equal(f.outbox()?.historicalMatches?.[0].retryNotBeforeMs, undefined);
});

test("archive infrastructure failures propagate without gating or dropping history", async () => {
  const f = fixture();
  f.values.set(`players/host/matches/${inviteId}`, match("black", true));
  const failure = new Error("archive-storage-unavailable");
  f.runtime.archiveHistoricalMatch = async () => {
    throw failure;
  };
  await assert.rejects(f.process(), (error) => error === failure);
  assert.equal(f.outbox()?.archiveRetry, undefined);
  assert.equal(f.outbox()?.historicalMatches?.[0].retryNotBeforeMs, undefined);
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
  assert.equal(unavailable.outbox()?.archiveRetry, undefined);
  assert.equal(
    unavailable.outbox()?.historicalMatches?.[0].retryNotBeforeMs,
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

test("malformed retry metadata never discards a valid historical descriptor", () => {
  const f = fixture();
  const current = f.values.get(outboxPath) as Record<string, unknown>;
  for (const retryNotBeforeMs of [-1, "later", Infinity, null]) {
    const raw = {
      ...current,
      archiveRetry: { requestId: "request-1", notBeforeMs: "later" },
      historicalMatches: { [inviteId]: { ...descriptor(), retryNotBeforeMs } },
    };
    assert.equal(
      parseAutomatchProfileGameProjectionOutbox(raw)?.historicalMatches?.length,
      1,
    );
    assert.equal(
      parseAutomatchProfileGameProjectionOutbox(raw)?.archiveRetry,
      undefined,
    );
    assert.deepEqual(salvageHistoricalMatchDescriptors(raw), [
      { ...descriptor(), matchId: inviteId },
    ]);
  }
});
