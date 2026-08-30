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
  MATCH_TIMER_START_ROOT,
  resolveMatchTimerGame,
  startMatchTimer,
  type MatchTimerGameState,
  type MatchTimerRecord,
} from "../src/matchTimer.ts";
import { buildEventProgressPlan } from "../src/eventProgress.ts";

type TimerRepository = Pick<
  GameplayRepository,
  "getRtdbPath" | "readProfileOwnershipSnapshot" | "transactRtdbPath"
>;

type ClaimTimerRepository = Pick<
  GameplayRepository,
  | "getRtdbPath"
  | "patchRtdbRoot"
  | "readProfileOwnershipSnapshot"
  | "transactRtdbPath"
>;

const identity: RequestIdentity = {
  uid: "player-1",
};

const request = {
  playerId: "player-1",
  opponentId: "player-2",
  matchId: "match-1",
  inviteId: "match-1",
};

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

function gameState(
  overrides: Partial<MatchTimerGameState> = {},
): MatchTimerGameState {
  return {
    activeColor: "white",
    historyValid: true,
    turnNumber: 7,
    winner: undefined,
    ...overrides,
  };
}

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

function repository({
  currentTimer = "",
  markerTimer = null,
  player = match("black"),
  opponent = match("white"),
  profile = "profile-1",
  invite = { hostId: "player-1", guestId: "player-2" },
  inviteId = "match-1",
}: {
  currentTimer?: unknown;
  markerTimer?: unknown;
  player?: unknown;
  opponent?: unknown;
  profile?: unknown;
  invite?: unknown;
  inviteId?: string;
} = {}): {
  paths: string[];
  writes: Array<{ path: string; value: unknown }>;
  value: TimerRepository;
} {
  const paths: string[] = [];
  const writes: Array<{ path: string; value: unknown }> = [];
  let storedMarker = markerTimer;
  let storedTimer = currentTimer;
  const value: TimerRepository = {
    getRtdbPath: async (path) => {
      paths.push(path);
      if (path === "players/player-1/matches/match-1") return player;
      if (path === "players/player-2/matches/match-1") return opponent;
      if (path === `invites/${inviteId}`) return invite;
      assert.fail(`unexpected RTDB path ${path}`);
    },
    readProfileOwnershipSnapshot: async (query) =>
      ownershipSnapshot(query, {
        "login-2": "profile-1",
        "player-1": typeof profile === "string" ? profile : null,
      }),
    transactRtdbPath: async (path, updater) => {
      paths.push(path);
      const markerPath = path.startsWith(`${MATCH_TIMER_START_ROOT}/`);
      const current = markerPath ? storedMarker : storedTimer;
      const decision = updater(current) as {
        commit?: boolean;
        decision?: string;
        value?: unknown;
      };
      if (decision.commit === false) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      if (markerPath) {
        storedMarker = decision.value;
      } else {
        storedTimer = decision.value;
      }
      writes.push({ path, value: decision.value });
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
  };
  return { paths, writes, value };
}

function claimRepository({
  failPatchAttempts = 0,
  initialClaim = null,
  invite = { hostId: "player-1", guestId: "player-2" },
  liveOpponent,
  livePlayer,
  opponent = match("white"),
  player = match("black", { timer: "7;1000" }),
  profile = "profile-1",
}: {
  failPatchAttempts?: number;
  initialClaim?: unknown;
  invite?: unknown;
  liveOpponent?: unknown;
  livePlayer?: unknown;
  opponent?: unknown;
  player?: unknown;
  profile?: unknown;
} = {}): {
  patchAttempts: () => number;
  patches: Array<Record<string, unknown>>;
  paths: string[];
  transactions: Array<{ path: string; value: unknown }>;
  value: ClaimTimerRepository;
} {
  const patches: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  const transactions: Array<{ path: string; value: unknown }> = [];
  let patchAttempts = 0;
  let playerReads = 0;
  let opponentReads = 0;
  let storedClaim: unknown = initialClaim;
  return {
    patchAttempts: () => patchAttempts,
    patches,
    paths,
    transactions,
    value: {
      getRtdbPath: async (path) => {
        paths.push(path);
        if (path.startsWith("players/player-1/matches/")) {
          playerReads++;
          return playerReads === 1 || livePlayer === undefined
            ? player
            : livePlayer;
        }
        if (path.startsWith("players/player-2/matches/")) {
          opponentReads++;
          return opponentReads === 1 || liveOpponent === undefined
            ? opponent
            : liveOpponent;
        }
        if (path.startsWith("invites/")) return invite;
        assert.fail(`unexpected RTDB path ${path}`);
      },
      patchRtdbRoot: async (updates) => {
        patchAttempts++;
        if (patchAttempts <= failPatchAttempts) {
          throw new Error("patch-failed");
        }
        patches.push(updates);
      },
      readProfileOwnershipSnapshot: async (query) =>
        ownershipSnapshot(query, {
          "login-2": "profile-1",
          "player-1": typeof profile === "string" ? profile : null,
        }),
      transactRtdbPath: async (path, updater) => {
        paths.push(path);
        const decision = updater(storedClaim) as {
          commit?: boolean;
          decision?: string;
          value?: unknown;
        };
        if (decision.commit === false) {
          return {
            committed: false,
            decision: decision.decision,
            value: storedClaim,
          };
        }
        storedClaim = decision.value;
        transactions.push({ path, value: decision.value });
        return {
          committed: true,
          decision: decision.decision,
          value: decision.value,
        };
      },
    },
  };
}

async function expectFailure(
  run: () => Promise<unknown>,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AuthApiFailure);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
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

test("starts the timer for a directly authenticated player", async () => {
  const repo = repository();
  const response = await startMatchTimer(identity, request, repo.value, {
    now: () => 10_000,
    resolveGame: () => gameState(),
  });
  assert.deepEqual(response, {
    ok: true,
    timer: "7;100500",
    duration: 90_000,
  });
  assert.deepEqual(repo.writes, [
    {
      path: "matchTimerStarts/player-1/match-1",
      value: { timer: "7;100500", turnNumber: 7 },
    },
    {
      path: "players/player-1/matches/match-1/timer",
      value: "7;100500",
    },
  ]);
  assert.deepEqual(repo.paths, [
    "players/player-1/matches/match-1",
    "players/player-2/matches/match-1",
    "invites/match-1",
    "matchTimerStarts/player-1/match-1",
    "players/player-1/matches/match-1/timer",
  ]);
});

test("retries only failed match reads once", async () => {
  let playerReads = 0;
  let opponentReads = 0;
  const value: TimerRepository = {
    getRtdbPath: async (path) => {
      if (path === "invites/match-1") {
        return { hostId: "player-1", guestId: "player-2" };
      }
      if (path.includes("player-1")) {
        playerReads++;
        if (playerReads === 1) {
          throw new Error("transient");
        }
        return match("black");
      }
      opponentReads++;
      return match("white");
    },
    transactRtdbPath: async (_path, updater) => {
      const decision = updater("") as { decision?: string; value?: unknown };
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
    readProfileOwnershipSnapshot: async () => {
      assert.fail("direct UID authorization should not read ownership");
    },
  };
  const response = await startMatchTimer(identity, request, value, {
    now: () => 1_000,
    resolveGame: () => gameState(),
  });
  assert.equal(response.timer, "7;91500");
  assert.equal(playerReads, 2);
  assert.equal(opponentReads, 1);
});

test("authorizes a same-profile login and rejects unrelated identities", async () => {
  const sameProfile = repository();
  let ownershipReads = 0;
  sameProfile.value.readProfileOwnershipSnapshot = async (query) => {
    ownershipReads++;
    assert.deepEqual(query.loginUids, ["login-2", "player-1"]);
    return ownershipSnapshot(query, {
      "login-2": "profile-1",
      "player-1": "profile-1",
    });
  };
  const response = await startMatchTimer(
    { ...identity, uid: "login-2" },
    request,
    sameProfile.value,
    { resolveGame: () => gameState(), now: () => 0 },
  );
  assert.equal(response.ok, true);
  assert.equal(ownershipReads, 1);
  assert.ok(sameProfile.paths.every((path) => !path.endsWith("/profile")));

  const unrelated = repository({ profile: "profile-2" });
  await expectFailure(
    () =>
      startMatchTimer(
        { ...identity, uid: "login-2" },
        request,
        unrelated.value,
        { resolveGame: () => gameState() },
      ),
    403,
    "permission-denied",
    "permission-denied",
  );
  assert.deepEqual(unrelated.writes, []);
});

test("rejects unrelated invite participants and match series", async () => {
  const unrelatedPlayers = repository({
    invite: { hostId: "other", guestId: "player-2" },
  });
  await expectFailure(
    () =>
      startMatchTimer(identity, request, unrelatedPlayers.value, {
        resolveGame: () => gameState(),
      }),
    403,
    "permission-denied",
    "permission-denied",
  );
  assert.deepEqual(unrelatedPlayers.writes, []);

  const unrelatedMatch = repository({ inviteId: "other" });
  await expectFailure(
    () =>
      startMatchTimer(
        identity,
        { ...request, inviteId: "other" },
        unrelatedMatch.value,
        { resolveGame: () => gameState() },
      ),
    403,
    "permission-denied",
    "permission-denied",
  );
  assert.deepEqual(unrelatedMatch.writes, []);
});

test("returns an existing same-turn timer without extending it", async () => {
  const repo = repository({
    currentTimer: "7;12345",
    markerTimer: { timer: "7;12345", turnNumber: 7 },
  });
  const response = await startMatchTimer(identity, request, repo.value, {
    now: () => 99_000,
    resolveGame: () => gameState(),
  });
  assert.deepEqual(response, {
    ok: true,
    timer: "7;12345",
    duration: 90_000,
  });
  assert.deepEqual(repo.writes, []);
});

test("concurrent starts converge on the first timer", async () => {
  const stored = new Map<string, unknown>();
  let writes = 0;
  const value: TimerRepository = {
    getRtdbPath: async (path) => {
      if (path === "invites/match-1") {
        return { hostId: "player-1", guestId: "player-2" };
      }
      return path.includes("player-1") ? match("black") : match("white");
    },
    transactRtdbPath: async (path, updater) => {
      const current = stored.get(path) ?? null;
      const decision = updater(current) as {
        commit?: boolean;
        decision?: string;
        value?: unknown;
      };
      if (decision.commit === false) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      writes++;
      stored.set(path, decision.value);
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
    readProfileOwnershipSnapshot: async () => {
      assert.fail("direct UID authorization should not read ownership");
    },
  };
  const [first, second] = await Promise.all([
    startMatchTimer(identity, request, value, {
      now: () => 1_000,
      resolveGame: () => gameState(),
    }),
    startMatchTimer(identity, request, value, {
      now: () => 2_000,
      resolveGame: () => gameState(),
    }),
  ]);
  assert.equal(first.timer, "7;91500");
  assert.equal(second.timer, first.timer);
  assert.equal(writes, 2);
});

test("advances one marker and rejects stale earlier turns", async () => {
  const markerPath = "matchTimerStarts/player-1/match-1";
  const timerPath = "players/player-1/matches/match-1/timer";
  const stored = new Map<string, unknown>();
  let turnNumber = 7;
  const value: TimerRepository = {
    getRtdbPath: async (path) => {
      if (path === "invites/match-1") {
        return { hostId: "player-1", guestId: "player-2" };
      }
      if (path === "players/player-1/matches/match-1") {
        const timer = stored.get(timerPath);
        return match("black", {
          timer: typeof timer === "string" ? timer : "",
        });
      }
      return match("white");
    },
    transactRtdbPath: async (path, updater) => {
      const current = stored.get(path) ?? null;
      const decision = updater(current) as {
        commit?: boolean;
        decision?: string;
        value?: unknown;
      };
      if (decision.commit === false) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      stored.set(path, decision.value);
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
    readProfileOwnershipSnapshot: async () => {
      assert.fail("direct UID authorization should not read ownership");
    },
  };
  const dependencies = {
    now: () => 1_000,
    resolveGame: () => gameState({ turnNumber }),
  };
  await startMatchTimer(identity, request, value, dependencies);
  turnNumber = 8;
  const latest = await startMatchTimer(identity, request, value, dependencies);
  turnNumber = 7;
  await expectFailure(
    () => startMatchTimer(identity, request, value, dependencies),
    409,
    "failed-precondition",
    "game state changed.",
  );
  assert.equal(latest.timer, "8;91500");
  assert.deepEqual(stored.get(markerPath), {
    timer: latest.timer,
    turnNumber: 8,
  });
  assert.equal(stored.get(timerPath), latest.timer);
  assert.equal(stored.size, 2);
});

test("replaces stale and malformed timers but never terminal state", async () => {
  for (const currentTimer of ["6;12345", "7;12345;extra", "malformed", ""]) {
    const repo = repository({ currentTimer });
    const response = await startMatchTimer(identity, request, repo.value, {
      now: () => 1_000,
      resolveGame: () => gameState(),
    });
    assert.equal(response.timer, "7;91500");
    assert.deepEqual(repo.writes, [
      {
        path: "matchTimerStarts/player-1/match-1",
        value: { timer: "7;91500", turnNumber: 7 },
      },
      {
        path: "players/player-1/matches/match-1/timer",
        value: "7;91500",
      },
    ]);
  }

  const terminal = repository({ currentTimer: "gg" });
  await expectFailure(
    () =>
      startMatchTimer(identity, request, terminal.value, {
        now: () => 1_000,
        resolveGame: () => gameState(),
      }),
    409,
    "failed-precondition",
    "game is already over.",
  );
  assert.deepEqual(terminal.writes, [
    {
      path: "matchTimerStarts/player-1/match-1",
      value: { timer: "7;91500", turnNumber: 7 },
    },
    {
      path: "matchTimerStarts/player-1/match-1",
      value: null,
    },
  ]);
});

test("restores the first timer after the match record is cleared", async () => {
  const markerPath = "matchTimerStarts/player-1/match-1";
  const timerPath = "players/player-1/matches/match-1/timer";
  const stored = new Map<string, unknown>();
  const value: TimerRepository = {
    getRtdbPath: async (path) => {
      if (path === "invites/match-1") {
        return { hostId: "player-1", guestId: "player-2" };
      }
      if (path === "players/player-1/matches/match-1") {
        const timer = stored.get(timerPath);
        return match("black", {
          timer: typeof timer === "string" ? timer : "",
        });
      }
      return match("white");
    },
    transactRtdbPath: async (path, updater) => {
      const current = stored.get(path) ?? null;
      const decision = updater(current) as {
        commit?: boolean;
        decision?: string;
        value?: unknown;
      };
      if (decision.commit === false) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      stored.set(path, decision.value);
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
    readProfileOwnershipSnapshot: async () => {
      assert.fail("direct UID authorization should not read ownership");
    },
  };
  const first = await startMatchTimer(identity, request, value, {
    now: () => 1_000,
    resolveGame: () => gameState(),
  });
  stored.set(timerPath, "");
  const restored = await startMatchTimer(identity, request, value, {
    now: () => 50_000,
    resolveGame: () => gameState(),
  });
  assert.equal(first.timer, "7;91500");
  assert.equal(restored.timer, first.timer);
  assert.deepEqual(stored.get(markerPath), {
    timer: first.timer,
    turnNumber: 7,
  });
  assert.equal(stored.get(timerPath), first.timer);
});

test("preserves timer game-state preconditions", async () => {
  const cases: Array<{
    name: string;
    player?: unknown;
    opponent?: unknown;
    state?: MatchTimerGameState;
    message: string;
  }> = [
    {
      name: "missing match",
      player: null,
      message: "something is wrong with the game state.",
    },
    {
      name: "same colors",
      opponent: match("black"),
      message: "something is wrong with the game state.",
    },
    {
      name: "oversized fen",
      player: match("black", { fen: "x".repeat(MAX_MATCH_FEN_BYTES + 1) }),
      message: "something is wrong with the game state.",
    },
    {
      name: "oversized history",
      player: match("black", {
        flatMovesString: "x".repeat(MAX_MATCH_HISTORY_BYTES + 1),
      }),
      message: "something is wrong with the game state.",
    },
    {
      name: "surrendered",
      player: match("black", { status: "surrendered" }),
      message: "game is already over.",
    },
    {
      name: "winner",
      state: gameState({ winner: "white" }),
      message: "game is already over.",
    },
    {
      name: "invalid history",
      state: gameState({ historyValid: false }),
      message: "something is wrong with the moves.",
    },
    {
      name: "own turn",
      state: gameState({ activeColor: "black" }),
      message: "can't start a timer on your own turn.",
    },
  ];
  for (const entry of cases) {
    const repo = repository({
      ...(entry.player === undefined ? {} : { player: entry.player }),
      ...(entry.opponent === undefined ? {} : { opponent: entry.opponent }),
    });
    await expectFailure(
      () =>
        startMatchTimer(identity, request, repo.value, {
          resolveGame: () => entry.state || gameState(),
        }),
      409,
      "failed-precondition",
      entry.message,
    );
    assert.deepEqual(repo.writes, [], entry.name);
  }
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

test("claims an expired timer and clears both protected markers", async () => {
  const repo = claimRepository();
  const response = await claimMatchVictoryByTimer(
    identity,
    request,
    repo.value,
    {
      now: () => 1_001,
      resolveGame: () => gameState(),
    },
  );
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(repo.patches, [
    {
      "players/player-1/matches/match-1/timer": "gg",
      "matchTimerClaims/match-1": {
        status: "claimed",
        playerId: "player-1",
        opponentId: "player-2",
        inviteId: "match-1",
        timer: "7;1000",
        turnNumber: 7,
        claimedAtMs: 1_001,
        expiresAtMs: null,
      },
      "matchTimerStarts/player-1/match-1": null,
      "matchTimerStarts/player-2/match-1": null,
    },
  ]);
  assert.deepEqual(repo.transactions, [
    {
      path: "matchTimerClaims/match-1",
      value: {
        status: "pending",
        playerId: "player-1",
        opponentId: "player-2",
        inviteId: "match-1",
        timer: "7;1000",
        turnNumber: 7,
        expiresAtMs: 31_001,
      },
    },
  ]);
});

test("authorizes same-profile timer claims and rejects unrelated identities", async () => {
  const sameProfile = claimRepository();
  const response = await claimMatchVictoryByTimer(
    { ...identity, uid: "login-2" },
    request,
    sameProfile.value,
    { now: () => 1_001, resolveGame: () => gameState() },
  );
  assert.equal(response.ok, true);
  assert.ok(sameProfile.paths.every((path) => !path.endsWith("/profile")));

  const unrelated = claimRepository({ profile: "profile-2" });
  await expectFailure(
    () =>
      claimMatchVictoryByTimer(
        { ...identity, uid: "login-2" },
        request,
        unrelated.value,
        { now: () => 1_001, resolveGame: () => gameState() },
      ),
    403,
    "permission-denied",
    "permission-denied",
  );
  assert.deepEqual(unrelated.patches, []);
});

test("preserves timer-claim game and deadline preconditions", async () => {
  const cases: Array<{
    name: string;
    now?: number;
    opponent?: unknown;
    player?: unknown;
    state?: MatchTimerGameState;
    message: string;
  }> = [
    {
      name: "missing match",
      player: null,
      message: "something is wrong with the game state.",
    },
    {
      name: "same colors",
      opponent: match("black"),
      message: "something is wrong with the game state.",
    },
    {
      name: "surrendered",
      player: match("black", { status: "surrendered", timer: "7;1000" }),
      message: "game is already over.",
    },
    {
      name: "winner",
      state: gameState({ winner: "white" }),
      message: "game is already over.",
    },
    {
      name: "invalid history",
      state: gameState({ historyValid: false }),
      message: "something is wrong with the moves.",
    },
    {
      name: "own turn",
      state: gameState({ activeColor: "black" }),
      message: "can't claim timer victory on your own turn.",
    },
    {
      name: "missing timer",
      player: match("black"),
      message: "could not find an existing timer.",
    },
    {
      name: "malformed timer",
      player: match("black", { timer: "invalid" }),
      message: "wrong timer format.",
    },
    {
      name: "stale timer",
      player: match("black", { timer: "6;1000" }),
      message: "can't claim this timer anymore, it's turn is over.",
    },
    {
      name: "unexpired timer",
      now: 900,
      message: "can't claim yet, 100 ms remaining",
    },
  ];
  for (const entry of cases) {
    const repo = claimRepository({
      ...(entry.player === undefined ? {} : { player: entry.player }),
      ...(entry.opponent === undefined ? {} : { opponent: entry.opponent }),
    });
    await expectFailure(
      () =>
        claimMatchVictoryByTimer(identity, request, repo.value, {
          now: () => entry.now ?? 1_001,
          resolveGame: () => entry.state || gameState(),
        }),
      409,
      "failed-precondition",
      entry.message,
    );
    assert.deepEqual(repo.patches, [], entry.name);
  }
});

test("rejects invalid timer-claim ownership and repository writes", async () => {
  const unrelatedInvite = claimRepository({
    invite: { hostId: "other", guestId: "player-2" },
  });
  await expectFailure(
    () =>
      claimMatchVictoryByTimer(identity, request, unrelatedInvite.value, {
        now: () => 1_001,
        resolveGame: () => gameState(),
      }),
    403,
    "permission-denied",
    "permission-denied",
  );

  const unrelatedSeries = claimRepository();
  await expectFailure(
    () =>
      claimMatchVictoryByTimer(
        identity,
        { ...request, matchId: "unrelated" },
        unrelatedSeries.value,
        { now: () => 1_001, resolveGame: () => gameState() },
      ),
    403,
    "permission-denied",
    "permission-denied",
  );

  const failingWrite = claimRepository({ failPatchAttempts: 3 });
  await assert.rejects(
    () =>
      claimMatchVictoryByTimer(identity, request, failingWrite.value, {
        now: () => 1_001,
        resolveGame: () => gameState(),
      }),
    /patch-failed/,
  );
  assert.equal(failingWrite.patchAttempts(), 3);
});

test("aborts when the live match advances after validation", async () => {
  const snapshot = match("white");
  const repo = claimRepository({
    opponent: snapshot,
    liveOpponent: {
      ...snapshot,
      fen: `${snapshot.fen} changed`,
      flatMovesString: "new-move",
    },
  });
  await expectFailure(
    () =>
      claimMatchVictoryByTimer(identity, request, repo.value, {
        now: () => 1_001,
        resolveGame: () => gameState(),
      }),
    409,
    "failed-precondition",
    "game state changed.",
  );
  assert.deepEqual(repo.transactions, [
    {
      path: "matchTimerClaims/match-1",
      value: {
        status: "pending",
        playerId: "player-1",
        opponentId: "player-2",
        inviteId: "match-1",
        timer: "7;1000",
        turnNumber: 7,
        expiresAtMs: 31_001,
      },
    },
    { path: "matchTimerClaims/match-1", value: null },
  ]);
  assert.deepEqual(repo.patches, []);
});

test("rejects a second request while a claim fence is active", async () => {
  const repo = claimRepository({
    initialClaim: {
      status: "pending",
      playerId: "player-1",
      opponentId: "player-2",
      inviteId: "match-1",
      timer: "7;1000",
      turnNumber: 7,
      expiresAtMs: 31_001,
    },
  });
  await expectFailure(
    () =>
      claimMatchVictoryByTimer(identity, request, repo.value, {
        now: () => 1_001,
        resolveGame: () => gameState(),
      }),
    409,
    "failed-precondition",
    "game state changed.",
  );
  assert.deepEqual(repo.transactions, []);
  assert.deepEqual(repo.patches, []);
});

test("creates the complete event progress outbox when none exists", async () => {
  const repo = claimRepository({
    invite: {
      hostId: "player-1",
      guestId: "player-2",
      eventOwned: true,
      eventId: "event-1",
    },
  });
  await claimMatchVictoryByTimer(identity, request, repo.value, {
    now: () => 2_000,
    resolveGame: () => gameState(),
  });
  assert.deepEqual(repo.patches, [
    {
      "players/player-1/matches/match-1/timer": "gg",
      "matchTimerClaims/match-1": {
        status: "claimed",
        playerId: "player-1",
        opponentId: "player-2",
        inviteId: "match-1",
        timer: "7;1000",
        turnNumber: 7,
        claimedAtMs: 2_000,
        expiresAtMs: null,
      },
      "matchTimerStarts/player-1/match-1": null,
      "matchTimerStarts/player-2/match-1": null,
      "eventProgressOutbox/ep_63b21a5345d223c4862730817dae4ae1899564b989fb8f057490ae277c5d5a16":
        {
          schemaVersion: 1,
          eventId: "event-1",
          sourceKey: "timer:match-1:match-1",
          reason: "timer-claimed",
          firstQueuedAtMs: 2_000,
          lastQueuedAtMs: 2_000,
          runAtMs: null,
        },
    },
  ]);
});

test("signals event progression with the deterministic Workflow identity", async () => {
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
  const repo = claimRepository({
    invite: {
      hostId: "player-1",
      guestId: "player-2",
      eventOwned: true,
      eventId: "event-1",
    },
  });
  const progressPlans: Array<{ params: { sourceKey: string } }> = [];
  const response = await claimMatchVictoryByTimer(
    identity,
    request,
    repo.value,
    {
      enqueueEventProgress: async (plan) => {
        progressPlans.push(plan);
      },
      now: () => 2_000,
      resolveGame: () => gameState(),
    },
  );
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(
    progressPlans.map((plan) => plan.params.sourceKey),
    ["timer:match-1:match-1"],
  );
  assert.deepEqual(repo.patches, [
    {
      "players/player-1/matches/match-1/timer": "gg",
      "matchTimerClaims/match-1": {
        status: "claimed",
        playerId: "player-1",
        opponentId: "player-2",
        inviteId: "match-1",
        timer: "7;1000",
        turnNumber: 7,
        claimedAtMs: 2_000,
        expiresAtMs: null,
      },
      "matchTimerStarts/player-1/match-1": null,
      "matchTimerStarts/player-2/match-1": null,
      "eventProgressOutbox/ep_63b21a5345d223c4862730817dae4ae1899564b989fb8f057490ae277c5d5a16":
        {
          schemaVersion: 1,
          eventId: "event-1",
          sourceKey: "timer:match-1:match-1",
          reason: "timer-claimed",
          firstQueuedAtMs: 2_000,
          lastQueuedAtMs: 2_000,
          runAtMs: null,
        },
    },
  ]);
});

test("retries claim side effects and repairs a terminal replay", async () => {
  const repo = claimRepository({
    failPatchAttempts: 2,
    player: match("black", { timer: "gg" }),
    invite: {
      hostId: "player-1",
      guestId: "player-2",
      eventOwned: true,
      eventId: "event-1",
    },
  });
  const response = await claimMatchVictoryByTimer(
    identity,
    request,
    repo.value,
    {
      now: () => 2_000,
      resolveGame: () => gameState(),
    },
  );
  assert.deepEqual(response, { ok: true });
  assert.equal(repo.patchAttempts(), 3);
  assert.equal(repo.patches.length, 1);
});
