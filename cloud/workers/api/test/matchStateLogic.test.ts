import assert from "node:assert/strict";
import test from "node:test";
import { Game } from "mons-rules";
import type { SubmitMoveRequest } from "@mons/shared/game-sessions";
import {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
} from "@mons/shared/match-protocol";
import {
  canonicalMatchStateJson,
  decideMatchStateMove,
  isCommittedMatchStateClaim,
  normalizeCreatedMatchState,
} from "../src/matchStateLogic.ts";
import { formatMatchTimer } from "@mons/shared/timers";
import { submitMove } from "../src/matchMove.ts";
import { surrenderMatch } from "../src/matchSurrender.ts";
import {
  claimMatchVictoryByTimer,
  startMatchTimer,
} from "../src/matchTimer.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";

const request = {
  inviteId: "invite-one",
  matchId: "invite-one",
  playerId: "host-login",
  previousFlatMovesString: "",
  flatMovesString: "a",
  fen: "first",
};

test("move decision preserves every non-move field and fills only missing variants", () => {
  const source = {
    fen: "initial",
    flatMovesString: "",
    gameVariant: "Classic",
    timer: "7;123",
    status: "",
    sessionCreation: "creation",
    custom: { nested: ["legacy", 2] },
  };
  const next = decideMatchStateMove(source, {
    ...request,
    gameVariant: "Other",
  });
  assert.equal(next.outcome, "applied");
  assert.deepEqual(next.value, {
    ...source,
    fen: request.fen,
    flatMovesString: request.flatMovesString,
  });
  assert.equal(
    decideMatchStateMove(
      { ...source, gameVariant: "" },
      { ...request, gameVariant: "Other" },
    ).value.gameVariant,
    "Other",
  );
  assert.deepEqual(source.custom, { nested: ["legacy", 2] });
});

test("cumulative decisions reject an intermediate FEN mismatch", () => {
  assert.throws(
    () =>
      decideMatchStateMove(
        { fen: "different", flatMovesString: "a" },
        {
          ...request,
          fen: "second",
          flatMovesString: "a-b",
          previousStates: [
            { moveCount: 0, fen: "initial" },
            { moveCount: 1, fen: "first" },
          ],
        },
      ),
    /move-chain-conflict/,
  );
});

test("canonical JSON rejects values that cannot be retained exactly", () => {
  assert.equal(
    canonicalMatchStateJson({ b: [2, null], a: true }),
    '{"a":true,"b":[2,null]}',
  );
  assert.throws(
    () => canonicalMatchStateJson({ missing: undefined }),
    /match-state-invalid-json/,
  );
  assert.throws(
    () => canonicalMatchStateJson({ invalid: Infinity }),
    /match-state-invalid-json/,
  );
});

test("new creation normalization matches null deletion and array readback", () => {
  const input = {
    sessionCreation: "creation",
    aura: null,
    empty: { gone: null },
    nested: { remove: null, keep: "value" },
    array: [null, { remove: null, keep: "value" }, null],
    sparse: [null, null, "value"],
    numeric: { "0": "zero", "1": "one" },
    emptyArray: [],
  };
  assert.deepEqual(normalizeCreatedMatchState(input), {
    sessionCreation: "creation",
    nested: { keep: "value" },
    array: [null, { keep: "value" }],
    sparse: { "2": "value" },
    numeric: ["zero", "one"],
  });
  assert.equal(input.aura, null);
  assert.deepEqual(input.array, [null, { remove: null, keep: "value" }, null]);
});

test("committed fences require complete terminal claim evidence", () => {
  const claim = {
    inviteId: "invite-one",
    playerId: "host-login",
    opponentId: "guest-login",
    status: "claimed",
    timer: formatMatchTimer(7, 123_000),
    turnNumber: 7,
    claimedAtMs: 123_001,
    expiresAtMs: null,
  };
  assert.equal(isCommittedMatchStateClaim(claim, "invite-one"), true);
  assert.equal(
    isCommittedMatchStateClaim(
      { ...claim, expiresAtMs: 123_010 },
      "invite-one",
    ),
    false,
  );
  assert.equal(
    isCommittedMatchStateClaim({ ...claim, turnNumber: 8 }, "invite-one"),
    false,
  );
  assert.equal(isCommittedMatchStateClaim(claim, "other-invite"), false);
});

function canonicalRepository(guestId = "guest-login") {
  const paths: string[] = [];
  const repository = {
    async readInviteMetadata(inviteId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      paths.push(`invites/${inviteId}`);
      assert.equal(inviteId, "invite-one");
      return {
        hostId: "host-login",
        guestId,
        hostRematches: "",
        guestRematches: "",
        eventOwned: true,
        eventId: "event-one",
      };
    },
    async readProfileOwnershipSnapshot() {
      throw new Error("unexpected-ownership-read");
    },
  } satisfies Pick<
    GameplayRepository,
    "readInviteMetadata" | "readProfileOwnershipSnapshot"
  >;
  return { repository, paths };
}

test("move and surrender authorize once before their canonical operations", async () => {
  const { repository, paths } = canonicalRepository();
  let checks = 0;
  const identity = { uid: request.playerId };
  const base = {
    ok: true as const,
    inviteId: request.inviteId,
    matchId: request.matchId,
    actorUid: request.playerId,
  };
  const deps = {
    assertMutationAllowed: async () => {
      checks++;
    },
  };
  assert.deepEqual(
    await submitMove(identity, request, repository, {
      ...deps,
      submitCanonical: async (input) => {
        assert.deepEqual(input, request);
        return { ...base, outcome: "applied" };
      },
    }),
    { ...base, outcome: "applied" },
  );
  const surrender = {
    inviteId: request.inviteId,
    matchId: request.matchId,
    playerId: request.playerId,
  };
  assert.deepEqual(
    await surrenderMatch(identity, surrender, repository, {
      ...deps,
      surrenderCanonical: async () => base,
    }),
    base,
  );
  assert.equal(checks, 2);
  assert.deepEqual(paths, ["invites/invite-one", "invites/invite-one"]);
});

test("timer operations read the invite and forward its event identity", async () => {
  const { repository, paths } = canonicalRepository();
  const input = {
    inviteId: request.inviteId,
    matchId: request.matchId,
    playerId: request.playerId,
    opponentId: "guest-login",
  };
  const identity = { uid: request.playerId };
  const timer = formatMatchTimer(7, 123_000);
  assert.deepEqual(
    await startMatchTimer(identity, input, repository, {
      startCanonical: async (value) => {
        assert.deepEqual(value, input);
        return { ok: true, timer, duration: 90_000 };
      },
    }),
    { ok: true, timer, duration: 90_000 },
  );
  assert.deepEqual(
    await claimMatchVictoryByTimer(identity, input, repository, {
      claimCanonical: async (value, invite) => {
        assert.deepEqual(value, input);
        assert.equal((invite as Record<string, unknown>).eventId, "event-one");
        return { ok: true };
      },
    }),
    { ok: true },
  );
  assert.deepEqual(paths, ["invites/invite-one", "invites/invite-one"]);
});

test("unauthorized timer participants never reach the canonical operation", async () => {
  const { repository } = canonicalRepository("different-guest");
  await assert.rejects(
    startMatchTimer(
      { uid: request.playerId },
      {
        inviteId: request.inviteId,
        matchId: request.matchId,
        playerId: request.playerId,
        opponentId: "guest-login",
      },
      repository,
      {
        startCanonical: async () => {
          throw new Error("unexpected-canonical-call");
        },
      },
    ),
    /permission-denied/,
  );
});

function cumulativeMove(): SubmitMoveRequest {
  return {
    ...request,
    gameVariant: "Classic",
    previousFlatMovesString: "moves",
    flatMovesString: "moves-a-z-next",
    fen: "after-next",
    previousStates: [
      { moveCount: 1, fen: "fen" },
      { moveCount: 2, fen: "after-a" },
      { moveCount: 3, fen: "fen" },
    ],
  };
}

test("move decisions preserve existing variants and optional legacy fields", () => {
  for (const gameVariant of [undefined, "", "Custom"]) {
    for (const requestedVariant of [undefined, "Classic"]) {
      const source = {
        fen: "initial",
        ...(gameVariant === undefined ? {} : { gameVariant }),
        extra: { retained: true },
      };
      const next = decideMatchStateMove(source, {
        ...request,
        ...(requestedVariant === undefined
          ? {}
          : { gameVariant: requestedVariant }),
      });
      const expectedVariant = gameVariant || requestedVariant;
      assert.equal(next.outcome, "applied");
      assert.deepEqual(next.value, {
        ...source,
        ...(expectedVariant ? { gameVariant: expectedVariant } : {}),
        fen: request.fen,
        flatMovesString: request.flatMovesString,
      });
      assert.deepEqual(source.extra, { retained: true });
    }
  }
});

test("cumulative moves apply from the base or any matching checkpoint", () => {
  const input = cumulativeMove();
  for (const [flatMovesString, fen] of [
    ["moves", "fen"],
    ["moves-a", "after-a"],
    ["moves-a-z", "fen"],
  ]) {
    const source = {
      flatMovesString,
      fen,
      timer: "current-timer",
      status: "surrendered",
      extra: { preserved: true },
    };
    const next = decideMatchStateMove(source, input);
    assert.equal(next.outcome, "applied");
    assert.deepEqual(next.value, {
      ...source,
      gameVariant: "Classic",
      fen: input.fen,
      flatMovesString: input.flatMovesString,
    });
    assert.equal(source.flatMovesString, flatMovesString);
  }
});

test("newer cumulative state supersedes late prefixes and preserves legacy semantics", () => {
  const latest = cumulativeMove();
  const source = {
    fen: latest.fen,
    flatMovesString: latest.flatMovesString,
    timer: "retained",
  };
  const older = {
    ...latest,
    fen: "after-a",
    flatMovesString: "moves-a",
    previousStates: latest.previousStates!.slice(0, 1),
  };
  const late = decideMatchStateMove(source, older);
  assert.equal(late.outcome, "superseded");
  assert.equal(late.value, source);
  const replay = decideMatchStateMove(source, latest);
  assert.equal(replay.outcome, "already-applied");
  assert.equal(replay.value, source);
  const legacyOlder: SubmitMoveRequest = { ...older };
  delete legacyOlder.previousStates;
  assert.throws(
    () => decideMatchStateMove(source, legacyOlder),
    /move-chain-conflict/,
  );
  const legacyNext = {
    ...latest,
    previousFlatMovesString: latest.flatMovesString,
    flatMovesString: `${latest.flatMovesString}-last`,
    fen: "last-fen",
  };
  delete legacyNext.previousStates;
  const next = decideMatchStateMove(source, legacyNext);
  assert.equal(next.outcome, "applied");
  assert.equal(next.value.flatMovesString, legacyNext.flatMovesString);
  assert.equal(next.value.timer, "retained");
});

test("cumulative moves reject divergent histories, partial-entry prefixes and mismatching FEN", () => {
  const input = cumulativeMove();
  for (const [flatMovesString, fen] of [
    ["moves-other", "after-a"],
    ["moves-aa", "after-a"],
    ["move", "fen"],
    ["", "fen"],
    ["moves", "other-base"],
    ["moves-a", "other-prefix"],
    ["moves-a-z-next", "other-target"],
  ]) {
    const source = { fen, flatMovesString, timer: "retained" };
    assert.throws(
      () => decideMatchStateMove(source, input),
      /move-chain-conflict/,
    );
    assert.deepEqual(source, { fen, flatMovesString, timer: "retained" });
  }
  const legacy = { ...input };
  delete legacy.previousStates;
  assert.throws(
    () =>
      decideMatchStateMove(
        { fen: "after-a", flatMovesString: "moves-a" },
        legacy,
      ),
    /move-chain-conflict/,
  );
});

test("real moves and takebacks retain distinct history when the board repeats", () => {
  const game = new Game();
  const baseFen = game.toFen();
  const first = game.play([
    { kind: "position", position: { row: 10, column: 3 } },
    { kind: "position", position: { row: 9, column: 2 } },
  ]);
  assert.equal(first.kind, "complete");
  const firstFen = game.toFen();
  const undone = game.takeback();
  assert.equal(undone.kind, "complete");
  assert.equal(undone.inputFen, "z");
  assert.equal(game.toFen(), baseFen);
  const next = game.playFen(first.inputFen);
  assert.equal(next.kind, "complete");
  assert.equal(game.toFen(), firstFen);
  const final: SubmitMoveRequest = {
    ...request,
    previousFlatMovesString: "",
    flatMovesString: `${first.inputFen}-z-${next.inputFen}`,
    fen: firstFen,
    previousStates: [
      { moveCount: 0, fen: baseFen },
      { moveCount: 1, fen: firstFen },
      { moveCount: 2, fen: baseFen },
    ],
  };
  const undoOnly = {
    ...final,
    flatMovesString: `${first.inputFen}-z`,
    fen: baseFen,
    previousStates: final.previousStates!.slice(0, 2),
  };
  const undoneState = decideMatchStateMove(
    { fen: baseFen, flatMovesString: "", extra: true },
    undoOnly,
  );
  assert.equal(undoneState.outcome, "applied");
  assert.equal(undoneState.value.fen, baseFen);
  assert.equal(undoneState.value.flatMovesString, undoOnly.flatMovesString);
  const finalState = decideMatchStateMove(undoneState.value, final);
  assert.equal(finalState.outcome, "applied");
  assert.equal(finalState.value.flatMovesString, final.flatMovesString);
  assert.equal(finalState.value.extra, true);
  const late = decideMatchStateMove(finalState.value, undoOnly);
  assert.equal(late.outcome, "superseded");
  assert.equal(late.value, finalState.value);
});

test("cumulative moves reject oversized stored fields before returning superseded", () => {
  for (const source of [
    {
      fen: "f".repeat(MAX_MATCH_FEN_BYTES + 1),
      flatMovesString: "moves-a-z-next-extra",
    },
    {
      fen: "fen",
      flatMovesString: `moves-a-z-next-${"a".repeat(MAX_MATCH_HISTORY_BYTES)}`,
    },
  ])
    assert.throws(
      () => decideMatchStateMove(source, cumulativeMove()),
      /match-invalid/,
    );
});

test("move decisions reject missing and malformed stored records", () => {
  for (const value of [null, undefined])
    assert.throws(
      () => decideMatchStateMove(value, request),
      /match-not-found/,
    );
  for (const value of [
    [],
    false,
    {},
    { fen: "" },
    { fen: "fen", flatMovesString: 1 },
  ])
    assert.throws(() => decideMatchStateMove(value, request), /match-invalid/);
});
