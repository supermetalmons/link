import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeHistoricalMatchRecord,
  type GameSessionMatch,
} from "@mons/shared/game-sessions";
import type { InviteDocument } from "@mons/shared/invite-records";
import { CONTROLLER_VERSION } from "@mons/shared/match-protocol";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  finalizeRematchProposal,
  inspectRematchProposal,
  nextRematchIndex,
  planRematchEnd,
} from "../src/gameSessionRematchPolicy.ts";
import {
  inviteDocumentFixture,
  inviteRecordFixture,
} from "./inviteDocumentFixture.ts";

const inviteId = "abcdefghijk";
const seed = Object.freeze({
  gameVariant: "Deterministic",
  fen: "deterministic-fen",
});

function inviteFixture(fields: Record<string, unknown> = {}) {
  return inviteDocumentFixture({
    hostId: "host-player",
    guestId: "guest-player",
    hostColor: "white",
    ...Object.fromEntries(
      Object.entries(fields).filter(([key]) =>
        [
          "hostId",
          "guestId",
          "hostColor",
          "hostRematches",
          "guestRematches",
        ].includes(key),
      ),
    ),
  });
}

function matchFixture(
  color: "white" | "black",
  fields: Partial<GameSessionMatch> = {},
): GameSessionMatch {
  return {
    schemaVersion: 1,
    version: CONTROLLER_VERSION,
    color,
    emojiId: 9,
    aura: "rainbow",
    gameVariant: "StoredVariant",
    fen: "stored-fen",
    status: "surrendered",
    flatMovesString: "move-one",
    timer: { state: "finished" },
    ...fields,
  };
}

function normalizeMatch(value: unknown): GameSessionMatch | null {
  const match = normalizeHistoricalMatchRecord(value);
  return match?.fen ? match : null;
}

function proposalInput(
  invite: InviteDocument = inviteFixture(),
  role: "host" | "guest" = "host",
): Parameters<typeof finalizeRematchProposal>[0] {
  return {
    invite,
    request: { inviteId, emojiId: 3, aura: "none" as const },
    actor: { actorUid: `${role}-player`, role },
    inspection: inspectRematchProposal({ invite, inviteId, role }),
    storedMatch: null,
    storedOpponent: null,
  };
}

function precondition(message: string) {
  return (error: unknown) =>
    error instanceof AuthApiFailure &&
    error.status === 409 &&
    error.message === message;
}

const indexCases = [
  {
    name: "empty",
    hostRematches: { state: "open", indices: [] },
    guestRematches: { state: "open", indices: [] },
    host: 1,
    guest: 1,
  },
  {
    name: "host proposed",
    hostRematches: { state: "open", indices: [1] },
    guestRematches: { state: "open", indices: [] },
    host: null,
    guest: 1,
  },
  {
    name: "guest proposed",
    hostRematches: { state: "open", indices: [] },
    guestRematches: { state: "open", indices: [1] },
    host: 1,
    guest: null,
  },
  {
    name: "approved",
    hostRematches: { state: "open", indices: [1] },
    guestRematches: { state: "open", indices: [1] },
    host: 2,
    guest: 2,
  },
  {
    name: "host ahead",
    hostRematches: { state: "open", indices: [1, 2] },
    guestRematches: { state: "open", indices: [1] },
    host: null,
    guest: 2,
  },
  {
    name: "nonprefix intersection",
    hostRematches: { state: "open", indices: [1, 3] },
    guestRematches: { state: "open", indices: [2, 3] },
    host: 4,
    guest: 4,
  },
  {
    name: "ended",
    hostRematches: { state: "open", indices: [1] },
    guestRematches: { state: "ended", indices: [1] },
    host: null,
    guest: null,
  },
  {
    name: "maximum safe predecessor",
    hostRematches: String(Number.MAX_SAFE_INTEGER - 1),
    guestRematches: String(Number.MAX_SAFE_INTEGER - 1),
    host: Number.MAX_SAFE_INTEGER,
    guest: Number.MAX_SAFE_INTEGER,
  },
  {
    name: "maximum safe index",
    hostRematches: String(Number.MAX_SAFE_INTEGER),
    guestRematches: String(Number.MAX_SAFE_INTEGER),
    host: null,
    guest: null,
  },
];

for (const entry of indexCases) {
  test(`proposal inspection preserves ${entry.name} index semantics`, () => {
    const invite = inviteFixture({
      hostRematches: entry.hostRematches,
      guestRematches: entry.guestRematches,
    });
    for (const role of ["host", "guest"] as const) {
      const expected = entry[role];
      assert.equal(nextRematchIndex(invite, role), expected);
      if (expected === null) {
        assert.throws(
          () => inspectRematchProposal({ invite, inviteId, role }),
          precondition("rematch-unavailable"),
        );
      } else {
        assert.deepEqual(inspectRematchProposal({ invite, inviteId, role }), {
          index: expected,
          matchId: `${inviteId}${expected}`,
        });
      }
    }
  });
}

for (const [hostColor, role, index, expectedColor] of [
  ["white", "host", 1, "black"],
  ["white", "guest", 1, "white"],
  ["white", "host", 2, "white"],
  ["white", "guest", 2, "black"],
  ["black", "host", 1, "white"],
  ["black", "guest", 1, "black"],
  ["black", "host", 2, "black"],
  ["black", "guest", 2, "white"],
] as const) {
  test(`${role} with ${hostColor} base host color gets ${expectedColor} at index ${index}`, () => {
    const input = proposalInput(
      inviteFixture({
        hostColor,
        hostRematches: index === 2 ? "1" : "",
        guestRematches: index === 2 ? "1" : "",
      }),
      role,
    );
    input.storedOpponent = matchFixture("white");
    const plan = finalizeRematchProposal(input, {
      normalizeMatch,
      buildDeterministicGameSeed: () => assert.fail("unexpected-seed"),
    });
    assert.equal(plan.response.actorUid, `${role}-player`);
    assert.deepEqual(plan.response.match, {
      schemaVersion: 1,
      version: CONTROLLER_VERSION,
      color: expectedColor,
      emojiId: 3,
      aura: "none" as const,
      gameVariant: "StoredVariant",
      fen: "stored-fen",
      status: "active",
      flatMovesString: "",
      timer: { state: "idle" },
    });
  });
}

for (const storedMatch of [null, undefined]) {
  test(`${String(storedMatch)} actor state permits creation after ordered normalization and seeding`, () => {
    const input = proposalInput();
    input.storedMatch = storedMatch;
    const calls: unknown[] = [];
    const plan = finalizeRematchProposal(input, {
      normalizeMatch(value) {
        calls.push(value);
        return normalizeMatch(value);
      },
      buildDeterministicGameSeed(key) {
        calls.push(key);
        return seed;
      },
    });
    assert.deepEqual(calls, [storedMatch, null, `rematch:${inviteId}1`]);
    assert.equal(plan.response.match.fen, seed.fen);
    assert.equal(plan.response.match.gameVariant, seed.gameVariant);
    assert.equal(plan.changes?.[1]?.kind, "match-create");
  });
}

for (const [label, storedMatch] of [
  ["malformed object", {}],
  ["scalar", "invalid"],
  ["array", []],
  ["missing FEN", { color: "black" }],
  ["empty FEN", matchFixture("black", { fen: "" })],
  ["wrong color", matchFixture("white")],
] as const) {
  test(`invalid actor (${label}) rejects before opponent normalization or seed construction`, () => {
    const input = proposalInput();
    input.storedMatch = storedMatch;
    input.storedOpponent = { opponent: true };
    const normalized: unknown[] = [];
    assert.throws(
      () =>
        finalizeRematchProposal(input, {
          normalizeMatch(value) {
            normalized.push(value);
            return normalizeMatch(value);
          },
          buildDeterministicGameSeed: () => assert.fail("unexpected-seed"),
        }),
      precondition("rematch-match-invalid"),
    );
    assert.deepEqual(normalized, [storedMatch]);
  });
}

for (const [label, storedOpponent] of [
  ["null", null],
  ["undefined", undefined],
  ["malformed object", {}],
  ["empty FEN", matchFixture("white", { fen: "" })],
] as const) {
  test(`unusable opponent (${label}) uses the deterministic match key`, () => {
    const input = proposalInput();
    input.storedOpponent = storedOpponent;
    const seeds: string[] = [];
    const plan = finalizeRematchProposal(input, {
      normalizeMatch,
      buildDeterministicGameSeed(key) {
        seeds.push(key);
        return seed;
      },
    });
    assert.deepEqual(seeds, [`rematch:${inviteId}1`]);
    assert.equal(plan.response.match.fen, seed.fen);
    assert.equal(plan.response.match.gameVariant, seed.gameVariant);
  });
}

test("an existing actor is preserved and omits creation while the missing-opponent seed still runs", () => {
  const input = proposalInput();
  input.storedMatch = matchFixture("black");
  const existing = normalizeMatch(input.storedMatch);
  assert.ok(existing);
  const calls: unknown[] = [];
  const plan = finalizeRematchProposal(input, {
    normalizeMatch(value) {
      calls.push(value);
      return value === input.storedMatch ? existing : normalizeMatch(value);
    },
    buildDeterministicGameSeed(key) {
      calls.push(key);
      return seed;
    },
  });
  assert.equal(plan.response.match, existing);
  assert.deepEqual(calls, [input.storedMatch, null, `rematch:${inviteId}1`]);
  assert.deepEqual(plan.changes, [
    {
      kind: "invite-rematches",
      inviteId,
      role: "host",
      value: { state: "open", indices: [1] },
    },
  ]);
});

for (const storedMatch of [null, matchFixture("black")]) {
  test(`a seed failure propagates with ${storedMatch ? "an existing" : "a missing"} actor`, () => {
    const input = proposalInput();
    input.storedMatch = storedMatch;
    const failure = new Error("seed-failed");
    assert.throws(
      () =>
        finalizeRematchProposal(input, {
          normalizeMatch,
          buildDeterministicGameSeed() {
            throw failure;
          },
        }),
      (error) => error === failure,
    );
  });
}

for (const entry of [
  {
    role: "host",
    hostRematches: { state: "open", indices: [] },
    guestRematches: { state: "open", indices: [] },
    rematches: { state: "open", indices: [1] },
    historyMatchId: inviteId,
  },
  {
    role: "host",
    hostRematches: { state: "open", indices: [1] },
    guestRematches: { state: "open", indices: [1] },
    rematches: { state: "open", indices: [1, 2] },
    historyMatchId: `${inviteId}1`,
  },
  {
    role: "guest",
    hostRematches: { state: "open", indices: [1] },
    guestRematches: { state: "open", indices: [] },
    rematches: { state: "open", indices: [1] },
    historyMatchId: null,
  },
] as const) {
  test(`${entry.role} proposal ${entry.rematches} keeps exact changes, reason and ${entry.historyMatchId ? "first" : "second"} proposal history`, () => {
    const input = proposalInput(inviteFixture(entry), entry.role);
    const plan = finalizeRematchProposal(input, {
      normalizeMatch,
      buildDeterministicGameSeed: () => seed,
    });
    assert.deepEqual(plan.response, {
      ok: true,
      inviteId,
      actorUid: `${entry.role}-player`,
      matchId: input.inspection.matchId,
      rematches: entry.rematches,
      match: plan.response.match,
    });
    assert.equal(plan.projectReason, `manual-${entry.role}Rematches-updated`);
    assert.deepEqual(plan.changes, [
      {
        kind: "invite-rematches",
        inviteId,
        role: entry.role,
        value: entry.rematches,
      },
      {
        kind: "match-create",
        playerId: `${entry.role}-player`,
        matchId: input.inspection.matchId,
        value: plan.response.match,
      },
    ]);
    if (entry.historyMatchId) {
      assert.deepEqual(plan.history, {
        guestPlayerId: "guest-player",
        hostPlayerId: "host-player",
        matchId: entry.historyMatchId,
        source: "transition",
      });
    } else {
      assert.equal(Object.hasOwn(plan, "history"), false);
    }
  });
}

for (const entry of [
  {
    role: "host",
    hostRematches: { state: "ended", indices: [1] },
    guestRematches: { state: "open", indices: [1] },
    rematches: { state: "ended", indices: [1] },
  },
  {
    role: "host",
    hostRematches: { state: "open", indices: [1] },
    guestRematches: { state: "ended", indices: [1] },
    rematches: { state: "ended", indices: [1] },
  },
  {
    role: "guest",
    hostRematches: { state: "ended", indices: [1] },
    guestRematches: { state: "open", indices: [] },
    rematches: { state: "ended", indices: [] },
  },
] as const) {
  test(`already-ended ${entry.role} ${entry.hostRematches}/${entry.guestRematches} schedules no write or history`, () => {
    assert.deepEqual(
      planRematchEnd({
        invite: inviteFixture(entry),
        inviteId,
        actor: { actorUid: `${entry.role}-player`, role: entry.role },
      }),
      {
        response: {
          ok: true,
          inviteId,
          actorUid: `${entry.role}-player`,
          rematches: entry.rematches,
        },
      },
    );
  });
}

for (const entry of [
  {
    role: "host",
    hostRematches: { state: "open", indices: [] },
    guestRematches: { state: "open", indices: [] },
    rematches: { state: "ended", indices: [] },
    historyMatchId: inviteId,
  },
  {
    role: "guest",
    hostRematches: { state: "open", indices: [1, 2] },
    guestRematches: { state: "open", indices: [1, 2] },
    rematches: { state: "ended", indices: [1, 2] },
    historyMatchId: `${inviteId}2`,
  },
  {
    role: "host",
    hostRematches: { state: "open", indices: [1, 2] },
    guestRematches: { state: "open", indices: [1] },
    rematches: { state: "ended", indices: [1, 2] },
    historyMatchId: null,
  },
  {
    role: "guest",
    hostRematches: { state: "open", indices: [1, 2] },
    guestRematches: { state: "open", indices: [1] },
    rematches: { state: "ended", indices: [1] },
    historyMatchId: null,
  },
  {
    role: "host",
    hostRematches: { state: "open", indices: [1, 3] },
    guestRematches: { state: "open", indices: [2, 3] },
    rematches: { state: "ended", indices: [1, 3] },
    historyMatchId: null,
  },
] as const) {
  test(`ending ${entry.role} ${entry.hostRematches}/${entry.guestRematches} keeps ${entry.historyMatchId ? "approved" : "pending-suppressed"} history`, () => {
    const plan = planRematchEnd({
      invite: inviteFixture(entry),
      inviteId,
      actor: { actorUid: `${entry.role}-player`, role: entry.role },
    });
    assert.deepEqual(plan.response, {
      ok: true,
      inviteId,
      actorUid: `${entry.role}-player`,
      rematches: entry.rematches,
    });
    assert.equal(plan.projectReason, `manual-${entry.role}Rematches-ended`);
    assert.deepEqual(plan.changes, [
      {
        kind: "invite-rematches",
        inviteId,
        role: entry.role,
        value: entry.rematches,
      },
    ]);
    if (entry.historyMatchId) {
      assert.deepEqual(plan.history, {
        guestPlayerId: "guest-player",
        hostPlayerId: "host-player",
        matchId: entry.historyMatchId,
        source: "transition",
      });
    } else {
      assert.equal(Object.hasOwn(plan, "history"), false);
    }
  });
}

test("proposal and end plans leave frozen inputs unchanged", () => {
  const invite = Object.freeze(
    inviteFixture({
      hostRematches: { state: "open", indices: [1] },
      guestRematches: { state: "open", indices: [1] },
    }),
  );
  const input = proposalInput(invite);
  input.storedMatch = Object.freeze(matchFixture("white"));
  input.storedOpponent = Object.freeze(matchFixture("black"));
  Object.freeze(input.request);
  Object.freeze(input.actor);
  Object.freeze(input.inspection);
  Object.freeze(input);
  const before = structuredClone({
    ...input,
    invite: inviteRecordFixture(invite),
  });
  finalizeRematchProposal(input, {
    normalizeMatch,
    buildDeterministicGameSeed: () => assert.fail("unexpected-seed"),
  });
  planRematchEnd({ invite, inviteId, actor: input.actor });
  assert.deepEqual({ ...input, invite: inviteRecordFixture(invite) }, before);
});
