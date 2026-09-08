import assert from "node:assert/strict";
import test from "node:test";
import type { SubmitMoveRequest } from "@mons/shared/game-sessions";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  FirebaseRtdbFailure,
  FirebaseRtdbPermissionDenied,
} from "../src/firebaseRtdb.ts";
import { submitMove } from "../src/matchMove.ts";

const request: SubmitMoveRequest = {
  inviteId: "invite",
  matchId: "invite1",
  playerId: "actor",
  previousFlatMovesString: "first",
  flatMovesString: "first-second",
  fen: "second-fen",
  previousStates: [{ moveCount: 1, fen: "first-fen" }],
};

const claimed = {
  status: "claimed",
  inviteId: "invite",
  playerId: "opponent",
  opponentId: "actor",
  timer: "3;1000",
  turnNumber: 3,
  claimedAtMs: 1200,
  expiresAtMs: null,
};

function harness({
  claim = claimed as unknown,
  claimReadFailure = false,
  current = {
    fen: "first-fen",
    flatMovesString: "first",
    timer: "retained",
    status: "",
    custom: { retained: true },
  } as Record<string, unknown>,
  writeFailure = new FirebaseRtdbPermissionDenied() as Error,
  onWrite = () => {},
  signal,
}: {
  claim?: unknown;
  claimReadFailure?: boolean;
  current?: Record<string, unknown>;
  writeFailure?: Error;
  onWrite?: () => void;
  signal?: AbortSignal;
} = {}) {
  const reads: string[] = [];
  const writes: Array<{ path: string; value: unknown }> = [];
  const scopes: unknown[] = [];
  const repository: Parameters<typeof submitMove>[2] = {
    async getRtdbPath(path, query, requestSignal) {
      reads.push(path);
      assert.equal(query, undefined);
      assert.ok(requestSignal);
      requestSignal.throwIfAborted();
      if (path === "invites/invite") {
        return {
          hostId: "actor",
          guestId: "opponent",
          hostRematches: "1",
          guestRematches: "1",
        };
      }
      assert.equal(path, "matchTimerClaims/invite1");
      if (claimReadFailure) throw new FirebaseRtdbFailure();
      return structuredClone(claim);
    },
    async readProfileOwnershipSnapshot() {
      throw new Error("unexpected-ownership-read");
    },
  };
  return {
    reads,
    writes,
    scopes,
    run: (body = request) =>
      submitMove({ uid: "actor" }, body, repository, {
        signal,
        createMatchClient(scope) {
          scopes.push(scope);
          return {
            async transactPath(path, updater, requestSignal, beforeWrite) {
              assert.equal(path, "players/actor/matches/invite1");
              requestSignal?.throwIfAborted();
              const snapshot = structuredClone(current);
              const decision = updater(snapshot) as {
                commit?: false;
                value?: unknown;
                decision?: string;
              };
              if (decision.commit === false)
                return {
                  committed: false,
                  value: snapshot,
                  decision: decision.decision,
                };
              await beforeWrite?.({
                current: snapshot,
                proposed: decision.value,
                etag: '"source"',
              });
              writes.push({ path, value: decision.value });
              onWrite();
              throw writeFailure;
            },
          };
        },
      }),
  };
}

const failsWith = (message: string) => (error: unknown) => {
  assert.ok(error instanceof AuthApiFailure);
  assert.equal(error.status, 409);
  assert.equal(error.code, "failed-precondition");
  assert.equal(error.message, message);
  return true;
};

test("a rejected move identifies committed timer claims for either participant", async () => {
  for (const claim of [
    claimed,
    { ...claimed, playerId: "actor", opponentId: "opponent" },
    { ...claimed, timer: "gg", expiresAtMs: undefined },
  ]) {
    const h = harness({ claim });
    await assert.rejects(h.run(), failsWith("match-move-finished"));
    assert.deepEqual(h.reads, ["invites/invite", "matchTimerClaims/invite1"]);
    assert.deepEqual(h.scopes, [{ playerId: "actor", matchId: "invite1" }]);
    assert.deepEqual(h.writes, [
      {
        path: "players/actor/matches/invite1",
        value: {
          fen: "second-fen",
          flatMovesString: "first-second",
          timer: "retained",
          status: "",
          custom: { retained: true },
        },
      },
    ]);
  }
});

test("pending, expired, missing and malformed claim evidence remains retryable", async () => {
  for (const claim of [
    null,
    { ...claimed, status: "pending", expiresAtMs: Date.now() + 30_000 },
    { ...claimed, status: "pending", expiresAtMs: Date.now() - 30_000 },
    { status: "claimed" },
    { ...claimed, inviteId: "another-invite" },
    { ...claimed, playerId: "unrelated" },
    { ...claimed, claimedAtMs: undefined },
    { ...claimed, claimedAtMs: "1200" },
    { ...claimed, expiresAtMs: 1500 },
    { ...claimed, timer: "malformed" },
    { ...claimed, turnNumber: 4 },
    { ...claimed, turnNumber: 3.5 },
    [],
  ]) {
    const h = harness({ claim });
    await assert.rejects(h.run(), failsWith("match-move-blocked"));
    assert.deepEqual(h.reads, ["invites/invite", "matchTimerClaims/invite1"]);
    assert.equal(h.writes.length, 1);
  }
});

test("failed or aborted claim reads never classify an uncertain rejection as terminal", async () => {
  const unavailable = harness({ claimReadFailure: true });
  await assert.rejects(unavailable.run(), failsWith("match-move-blocked"));
  const controller = new AbortController();
  const aborted = harness({
    signal: controller.signal,
    onWrite: () => controller.abort(),
  });
  await assert.rejects(aborted.run(), failsWith("match-move-blocked"));
  assert.deepEqual(aborted.reads, [
    "invites/invite",
    "matchTimerClaims/invite1",
  ]);
});

test("already-applied and superseded requests stay successful without consulting a committed timer claim", async () => {
  for (const [current, outcome] of [
    [{ fen: "second-fen", flatMovesString: "first-second" }, "already-applied"],
    [{ fen: "third-fen", flatMovesString: "first-second-third" }, "superseded"],
  ] as const) {
    const h = harness({ current });
    assert.equal((await h.run()).outcome, outcome);
    assert.deepEqual(h.reads, ["invites/invite"]);
    assert.deepEqual(h.writes, []);
  }
});

test("upstream uncertainty and history conflicts do not read timer claims or change error semantics", async () => {
  const failure = new FirebaseRtdbFailure();
  const unavailable = harness({ writeFailure: failure });
  await assert.rejects(unavailable.run(), (error) => error === failure);
  assert.deepEqual(unavailable.reads, ["invites/invite"]);
  const conflict = harness({
    current: { fen: "different", flatMovesString: "first-other" },
  });
  await assert.rejects(
    conflict.run(),
    (error) =>
      error instanceof AuthApiFailure &&
      error.message === "move-chain-conflict",
  );
  assert.deepEqual(conflict.reads, ["invites/invite"]);
  assert.deepEqual(conflict.writes, []);
});
