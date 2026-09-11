import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalMatchStateJson,
  decideMatchStateMove,
  digestMatchStateImport,
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
import { createMemoryGameplayCoordinationStores } from "./gameplayCoordinationTestUtils.ts";

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

test("import fingerprints are stable across record and object-key ordering", async () => {
  const record = {
    matchId: "invite-one",
    playerId: "host-login",
    value: { fen: "initial", color: "white" },
  };
  const other = {
    matchId: "invite-one",
    playerId: "guest-login",
    value: { color: "black", fen: "initial" },
  };
  const bundle = {
    inviteId: "invite-one",
    epoch: 1,
    importId: "import-one",
    records: [record, other],
    claims: [],
  };
  assert.equal(
    await digestMatchStateImport(bundle),
    await digestMatchStateImport({ ...bundle, records: [other, record] }),
  );
  assert.notEqual(
    await digestMatchStateImport(bundle),
    await digestMatchStateImport({ ...bundle, epoch: 2 }),
  );
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
    async getRtdbPath(path: string) {
      paths.push(path);
      assert.equal(path, "invites/invite-one");
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
    async transactRtdbPath() {
      throw new Error("unexpected-firebase-transaction");
    },
    async patchRtdbRoot() {
      throw new Error("unexpected-firebase-patch");
    },
  } as unknown as GameplayRepository;
  return { repository, paths };
}

test("canonical move and surrender branches keep authorization and bypass Firebase transactions", async () => {
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
    createMatchClient: () => {
      throw new Error("unexpected-firebase-client");
    },
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

test("canonical timer branches only read the D1 invite and forward its event identity", async () => {
  const { repository, paths } = canonicalRepository();
  const input = {
    inviteId: request.inviteId,
    matchId: request.matchId,
    playerId: request.playerId,
    opponentId: "guest-login",
  };
  const identity = { uid: request.playerId };
  const timerStarts = createMemoryGameplayCoordinationStores().timerStarts;
  const timer = formatMatchTimer(7, 123_000);
  assert.deepEqual(
    await startMatchTimer(identity, input, repository, {
      timerStarts,
      startCanonical: async (value) => {
        assert.deepEqual(value, input);
        return { ok: true, timer, duration: 90_000 };
      },
    }),
    { ok: true, timer, duration: 90_000 },
  );
  assert.deepEqual(
    await claimMatchVictoryByTimer(identity, input, repository, {
      timerStarts,
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
        timerStarts: createMemoryGameplayCoordinationStores().timerStarts,
        startCanonical: async () => {
          throw new Error("unexpected-canonical-call");
        },
      },
    ),
    /permission-denied/,
  );
});
