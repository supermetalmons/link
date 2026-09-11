import assert from "node:assert/strict";
import test from "node:test";
import { Game } from "mons-rules";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { RequestIdentity } from "../src/requestIdentity.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";
import {
  buildOrderedMoveHistory,
  claimMatchVictoryByTimer,
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
  parseMatchTimerRecord,
  rawMatchTimerIsTerminal,
  resolveMatchTimerGame,
  startMatchTimer,
  type MatchTimerRecord,
} from "../src/matchTimer.ts";
import { buildEventProgressPlan } from "../src/eventProgress.ts";

type TimerRepository = Pick<
  GameplayRepository,
  "readInviteMetadata" | "readProfileOwnershipSnapshot"
>;

const identity: RequestIdentity = { uid: "player-1" };
const request = {
  playerId: "player-1",
  opponentId: "player-2",
  matchId: "match-1",
  inviteId: "match-1",
};
const eventInvite = {
  hostId: "player-1",
  guestId: "player-2",
  eventOwned: true,
  eventId: "event-1",
};
const startResponse = {
  ok: true as const,
  timer: "7;100500",
  duration: 90_000 as const,
};
const claimResponse = { ok: true as const };

function timerHarness(
  operation: "start" | "claim",
  {
    invite = eventInvite as unknown,
    ownerByUid = { "player-1": "profile-1", "login-2": "profile-1" },
    onRead = () => {},
    readFailure,
    canonicalFailure,
  }: {
    invite?: unknown;
    ownerByUid?: Readonly<Record<string, string | null>>;
    onRead?: () => void;
    readFailure?: Error;
    canonicalFailure?: Error;
  } = {},
) {
  const steps: string[] = [];
  const ownershipQueries: ProfileOwnershipQuery[] = [];
  const calls: Array<{ request: typeof request; invite?: unknown }> = [];
  const repository: TimerRepository = {
    async readInviteMetadata(inviteId, signal) {
      assert.equal(inviteId, request.inviteId);
      assert.ok(signal);
      signal.throwIfAborted();
      steps.push("invite");
      onRead();
      if (readFailure) throw readFailure;
      return invite as Record<string, unknown> | null;
    },
    async readProfileOwnershipSnapshot(query) {
      steps.push("ownership");
      ownershipQueries.push(query);
      return ownershipSnapshot(query, ownerByUid);
    },
  };
  return {
    steps,
    calls,
    ownershipQueries,
    async run({
      actor = identity,
      input = request,
      signal,
      assertMutationAllowed = async () => {
        steps.push("admission");
      },
    }: {
      actor?: RequestIdentity;
      input?: typeof request;
      signal?: AbortSignal;
      assertMutationAllowed?: () => Promise<void>;
    } = {}) {
      return operation === "start"
        ? startMatchTimer(actor, input, repository, {
            signal,
            assertMutationAllowed,
            async startCanonical(value) {
              steps.push("canonical");
              calls.push({ request: value });
              if (canonicalFailure) throw canonicalFailure;
              return startResponse;
            },
          })
        : claimMatchVictoryByTimer(actor, input, repository, {
            signal,
            assertMutationAllowed,
            async claimCanonical(value, inviteValue) {
              steps.push("canonical");
              calls.push({ request: value, invite: inviteValue });
              if (canonicalFailure) throw canonicalFailure;
              return claimResponse;
            },
          });
    },
  };
}

function denied(error: unknown): boolean {
  assert.ok(error instanceof AuthApiFailure);
  assert.equal(error.status, 403);
  assert.equal(error.code, "permission-denied");
  return true;
}

for (const operation of ["start", "claim"] as const) {
  test(`${operation} timer forwards the authorized request after admission`, async () => {
    const h = timerHarness(operation);
    const response = await h.run();
    assert.equal(
      response,
      operation === "start" ? startResponse : claimResponse,
    );
    assert.deepEqual(h.steps, ["invite", "admission", "canonical"]);
    assert.deepEqual(h.ownershipQueries, []);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].request, request);
    if (operation === "claim") assert.equal(h.calls[0].invite, eventInvite);
  });

  test(`${operation} timer authorizes a linked login using canonical ownership`, async () => {
    const h = timerHarness(operation);
    await h.run({ actor: { uid: "login-2" } });
    assert.deepEqual(h.steps, [
      "ownership",
      "invite",
      "admission",
      "canonical",
    ]);
    assert.deepEqual(h.ownershipQueries, [
      { loginUids: ["login-2", "player-1"], profileIds: [] },
    ]);
    assert.equal(h.calls[0].request.playerId, "player-1");
  });

  test(`${operation} timer rejects missing or unrelated ownership before invite reads`, async () => {
    for (const ownerByUid of [
      { "player-1": "profile-1", "login-2": "profile-2" },
      { "player-1": "profile-1", "login-2": null },
      { "player-1": null, "login-2": "profile-1" },
    ]) {
      const h = timerHarness(operation, { ownerByUid });
      await assert.rejects(h.run({ actor: { uid: "login-2" } }), denied);
      assert.deepEqual(h.steps, ["ownership"]);
      assert.deepEqual(h.calls, []);
    }
  });

  test(`${operation} timer rejects unrelated participants and match series`, async () => {
    for (const invite of [
      null,
      [],
      { hostId: "player-1", guestId: "someone-else" },
      { hostId: "player-2", guestId: "someone-else" },
      { hostId: "player-1", guestId: "player-1" },
    ]) {
      const h = timerHarness(operation, { invite });
      await assert.rejects(h.run(), denied);
      assert.deepEqual(h.steps, ["invite"]);
      assert.deepEqual(h.calls, []);
    }
    const h = timerHarness(operation);
    await assert.rejects(
      h.run({ input: { ...request, matchId: "unrelated-match" } }),
      denied,
    );
    assert.deepEqual(h.steps, ["invite"]);
    assert.deepEqual(h.calls, []);
  });

  test(`${operation} timer observes cancellation before mutation admission`, async () => {
    const reason = new Error("request-cancelled");
    const before = new AbortController();
    before.abort(reason);
    const early = timerHarness(operation);
    await assert.rejects(
      early.run({ signal: before.signal }),
      (error) => error === reason,
    );
    assert.deepEqual(early.steps, []);
    const during = new AbortController();
    const afterRead = timerHarness(operation, {
      onRead: () => during.abort(reason),
    });
    await assert.rejects(
      afterRead.run({ signal: during.signal }),
      (error) => error === reason,
    );
    assert.deepEqual(afterRead.steps, ["invite"]);
    assert.deepEqual(afterRead.calls, []);
  });

  test(`${operation} timer does not dispatch after a rejected admission`, async () => {
    const h = timerHarness(operation);
    const failure = new Error("writes-frozen");
    await assert.rejects(
      h.run({
        assertMutationAllowed: async () => {
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(h.steps, ["invite"]);
    assert.deepEqual(h.calls, []);
  });

  test(`${operation} timer preserves repository and canonical failures`, async () => {
    const readFailure = new Error("invite-unavailable");
    const unreadable = timerHarness(operation, { readFailure });
    await assert.rejects(unreadable.run(), (error) => error === readFailure);
    assert.deepEqual(unreadable.steps, ["invite"]);
    assert.deepEqual(unreadable.calls, []);
    for (const canonicalFailure of [
      new AuthApiFailure(409, "failed-precondition", "game is already over."),
      new Error("match-state-unavailable"),
    ]) {
      const h = timerHarness(operation, { canonicalFailure });
      await assert.rejects(h.run(), (error) => error === canonicalFailure);
      assert.deepEqual(h.steps, ["invite", "admission", "canonical"]);
      assert.equal(h.calls.length, 1);
    }
  });
}

test("timer record parsing rejects malformed and oversized game state", () => {
  for (const value of [
    null,
    [],
    match("black", { fen: " " }),
    match("black", { fen: "x".repeat(MAX_MATCH_FEN_BYTES + 1) }),
    match("black", {
      flatMovesString: "x".repeat(MAX_MATCH_HISTORY_BYTES + 1),
    }),
    { ...match("black"), color: "other" },
  ])
    assert.equal(parseMatchTimerRecord(value), null);
  assert.deepEqual(parseMatchTimerRecord(match("black")), match("black"));
  assert.deepEqual(
    parseMatchTimerRecord({ color: "white", fen: new Game().toFen() }),
    match("white"),
  );
});

test("raw terminal detection does not depend on valid peer game state", () => {
  assert.equal(
    rawMatchTimerIsTerminal({ status: "surrendered", fen: "invalid" }),
    true,
  );
  assert.equal(rawMatchTimerIsTerminal({ timer: "gg" }), true);
  assert.equal(rawMatchTimerIsTerminal(match("black")), false);
  assert.equal(rawMatchTimerIsTerminal(null), false);
});

test("event progress plans retain deterministic timer identities", async () => {
  assert.equal(
    (
      await buildEventProgressPlan({
        eventId: "event-1",
        sourceKey: "timer:match-1:match-1",
        reason: "timer-claimed",
      })
    ).outboxId,
    "ep_63b21a5345d223c4862730817dae4ae1899564b989fb8f057490ae277c5d5a16",
  );
  assert.equal(
    (
      await buildEventProgressPlan({
        eventId: "event-1",
        sourceKey: "timer:match-1:match-2",
        reason: "timer-claimed",
      })
    ).workflowId,
    "event-progress-36ff8d469c3914ad9bab1a9ce4111ce21f4c9e48b578dd149de0dc4f32bbb763",
  );
});

function ownershipSnapshot(
  query: ProfileOwnershipQuery,
  ownerByUid: Readonly<Record<string, string | null>>,
): ProfileOwnershipSnapshot {
  const loginOwnerByUid = new Map(
    query.loginUids.map((uid) => {
      const profileId = ownerByUid[uid] || null;
      return [uid, profileId ? { profileId, revision: 1 } : null] as const;
    }),
  );
  const profileIds = new Set(
    [...loginOwnerByUid.values()].flatMap((owner) =>
      owner ? [owner.profileId] : [],
    ),
  );
  return {
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid,
    loginUidsByProfileId: new Map(
      [...profileIds].map((profileId) => [
        profileId,
        Object.entries(ownerByUid)
          .filter(([, value]) => value === profileId)
          .map(([uid]) => uid)
          .sort(),
      ]),
    ),
    profileById: new Map(
      [...profileIds].map((profileId) => [
        profileId,
        {
          profile: {
            aura: "",
            emoji: "",
            eth: "",
            profileId,
            rating: 1500,
            sol: "",
            username: "",
          },
          revision: 1,
        },
      ]),
    ),
  };
}

function match(
  color: "white" | "black",
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

test("orders move histories for both player colors", () => {
  assert.deepEqual(
    buildOrderedMoveHistory(
      match("white", { flatMovesString: "w1-w2" }),
      match("black", { flatMovesString: "b1-b2" }),
    ),
    { white: ["w1", "w2"], black: ["b1", "b2"] },
  );
  assert.deepEqual(
    buildOrderedMoveHistory(
      match("black", { flatMovesString: "b1-b2" }),
      match("white", { flatMovesString: "w1-w2" }),
    ),
    { white: ["w1", "w2"], black: ["b1", "b2"] },
  );
});

test("selects and verifies the later mons-rules state", () => {
  const initial = new Game();
  const later = new Game();
  const suggestion = later.suggestMove("fast");
  assert.ok(suggestion);
  assert.equal(later.play(suggestion.inputs).kind, "complete");
  const state = resolveMatchTimerGame(
    match("black", { fen: initial.toFen() }),
    match("white", {
      fen: later.toFen(),
      flatMovesString: suggestion.inputFen,
    }),
  );
  assert.equal(state.activeColor, "white");
  assert.equal(state.historyValid, true);
  assert.equal(state.winner, undefined);

  assert.throws(
    () =>
      resolveMatchTimerGame(match("black", { fen: "invalid" }), match("white")),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.code === "failed-precondition",
  );
});

test("rejects excessive move-history entries before splitting", () => {
  assert.throws(
    () =>
      buildOrderedMoveHistory(
        match("white", {
          flatMovesString: `${"x-".repeat(MAX_MATCH_HISTORY_ENTRIES)}x`,
        }),
        match("black"),
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.code === "failed-precondition",
  );
});
