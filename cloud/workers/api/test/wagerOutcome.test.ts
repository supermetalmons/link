import assert from "node:assert/strict";
import test from "node:test";
import type { MiningSnapshot } from "@mons/shared/mining";
import { Game } from "mons-rules";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { FirebaseIdentity } from "../src/firebaseAuth.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { handleGameplayRoute } from "../src/gameplayRoute.ts";
import {
  classifyWagerSettlementRetry,
  resumeWagerSettlement,
  resolveWagerMatchResult,
  resolveWagerOutcome,
  WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS,
  WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON,
  type WagerSettlementRetryTask,
} from "../src/wagerOutcome.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "worker@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

const identity: FirebaseIdentity = {
  idToken: "firebase-token",
  profileId: "profile-host",
  uid: "host",
};

const hostWinResolution = {
  winnerUid: "host",
  winnerProfileId: "profile-host",
  loserUid: "guest",
  loserProfileId: "profile-guest",
};

const emptyMaterials = () => ({
  dust: 0,
  slime: 0,
  gum: 0,
  metal: 0,
  ice: 0,
});

const snapshot = (dust: number, slime = 0): MiningSnapshot => ({
  lastRockDate: "2026-08-20",
  materials: { ...emptyMaterials(), dust, slime },
});

function applyTransaction(
  updater: (current: unknown) => unknown,
  current: unknown,
) {
  const decision = updater(current) as {
    commit?: boolean;
    decision?: string;
    value?: unknown;
  };
  return decision.commit === false
    ? { committed: false, decision: decision.decision, value: current }
    : { committed: true, decision: decision.decision, value: decision.value };
}

type RepositoryState = {
  appliedTransfers: number;
  frozen: Record<string, Record<string, unknown>>;
  marker: boolean;
  mining: Record<string, MiningSnapshot>;
  repository: GameplayRepository;
  transferCalls: number;
  transferOutcome: "applied" | "insufficient-materials" | null;
  wager: Record<string, unknown> | null;
};

function createRepository({
  failFrozenOnce = false,
  failPatchAfterCommitOnce = false,
  failPatchOnce = false,
  findProfileId,
  invite = { hostId: "host", guestId: "guest" },
  marker = false,
  mining = {
    "profile-host": snapshot(10),
    "profile-guest": snapshot(5),
  },
  opponentMatch = {},
  playerMatch = {},
  wager = null,
}: {
  failFrozenOnce?: boolean;
  failPatchAfterCommitOnce?: boolean;
  failPatchOnce?: boolean;
  findProfileId?: (uid: string) => Promise<string | null>;
  invite?: unknown;
  marker?: boolean;
  mining?: Record<string, MiningSnapshot>;
  opponentMatch?: unknown;
  playerMatch?: unknown;
  wager?: Record<string, unknown> | null;
} = {}): RepositoryState {
  let failFrozen = failFrozenOnce;
  let failPatchAfterCommit = failPatchAfterCommitOnce;
  let failPatch = failPatchOnce;
  let transferFingerprint = "";
  const state: Omit<RepositoryState, "repository"> = {
    appliedTransfers: 0,
    frozen: {
      host: { frozen: { ...emptyMaterials(), dust: 2, slime: 1 } },
      guest: { frozen: { ...emptyMaterials(), dust: 2, slime: 1 } },
    },
    marker,
    mining: structuredClone(mining),
    transferCalls: 0,
    transferOutcome: null,
    wager: structuredClone(wager),
  };
  const repository: GameplayRepository = {
    applyWagerTransferOnce: async (input) => {
      state.transferCalls += 1;
      if (transferFingerprint) {
        assert.equal(input.fingerprint, transferFingerprint);
        return state.transferOutcome === "insufficient-materials"
          ? "insufficient-materials"
          : "replayed";
      }
      if (
        input.winnerProfileId !== input.loserProfileId &&
        state.mining[input.loserProfileId].materials[input.material] <
          input.count
      ) {
        transferFingerprint = input.fingerprint;
        state.transferOutcome = "insufficient-materials";
        return "insufficient-materials";
      }
      transferFingerprint = input.fingerprint;
      state.transferOutcome = "applied";
      state.appliedTransfers += 1;
      if (input.winnerProfileId !== input.loserProfileId) {
        state.mining[input.winnerProfileId].materials[input.material] +=
          input.count;
        state.mining[input.loserProfileId].materials[input.material] -=
          input.count;
      }
      return "applied";
    },
    deleteNavigationGame: async () => "deleted",
    findProfileId: findProfileId || (async (uid) => `profile-${uid}`),
    getGameplayProfile: async () => null,
    getNavigationGame: async () => null,
    getMiningMaterials: async () => emptyMaterials(),
    getMiningSnapshot: async (profileId) =>
      structuredClone(state.mining[profileId] ?? null),
    getRtdbPath: async (path) => {
      if (path === "invites/invite") return invite;
      if (path === "players/host/matches/invite") return playerMatch;
      if (path === "players/guest/matches/invite") return opponentMatch;
      if (path === "invites/invite/wagers/invite") return state.wager;
      if (path === "invites/invite/matchesWagerResolutions/invite") {
        return state.marker;
      }
      const miningMatch = path.match(/^players\/([^/]+)\/mining$/);
      if (miningMatch) return state.frozen[miningMatch[1]];
      return null;
    },
    patchRtdbRoot: async (updates) => {
      if (failPatch) {
        failPatch = false;
        throw new Error("patch-failed");
      }
      state.marker =
        updates["invites/invite/matchesWagerResolutions/invite"] === true;
      if (state.wager) {
        state.wager.proposals = null;
        if (updates["invites/invite/wagers/invite/agreed"] === null) {
          state.wager.agreed = null;
        }
        const settlement = state.wager.settlement as Record<string, unknown>;
        settlement.state = "completed";
        settlement.completedAtMs =
          updates["invites/invite/wagers/invite/settlement/completedAtMs"];
        const failureReason =
          updates["invites/invite/wagers/invite/settlement/failureReason"];
        if (failureReason) settlement.failureReason = failureReason;
        if (updates["invites/invite/wagers/invite/resolved"]) {
          state.wager.resolved =
            updates["invites/invite/wagers/invite/resolved"];
        }
      }
      if (failPatchAfterCommit) {
        failPatchAfterCommit = false;
        throw new Error("ambiguous-patch-failure");
      }
    },
    transactRtdbPath: async (path, updater) => {
      if (path === "invites/invite/wagers/invite") {
        const result = applyTransaction(updater, state.wager);
        if (result.committed) {
          state.wager = result.value as Record<string, unknown>;
          const settlement = state.wager.settlement as Record<
            string,
            unknown
          > | null;
          if (settlement?.completedAtMs === null) {
            delete settlement.completedAtMs;
          }
          if (
            Array.isArray(settlement?.releases) &&
            settlement.releases.length === 0
          ) {
            delete settlement.releases;
          }
        }
        return result;
      }
      const uid = path.split("/")[1];
      if (failFrozen) {
        failFrozen = false;
        throw new Error("frozen-write-failed");
      }
      const result = applyTransaction(updater, state.frozen[uid]);
      if (result.committed) {
        state.frozen[uid] = result.value as Record<string, unknown>;
      }
      return result;
    },
  };
  return Object.assign(state, { repository });
}

test("uses the real rules engine for both player colors", () => {
  const validFen = new Game().toFen();
  const record = (color: "black" | "white", fen: string) => ({
    color,
    fen,
    flatMovesString: "",
    status: "",
    timer: "",
  });
  assert.equal(
    resolveWagerMatchResult(record("white", validFen), record("black", "x")),
    "win",
  );
  assert.equal(
    resolveWagerMatchResult(record("black", validFen), record("white", "x")),
    "win",
  );
  assert.equal(
    resolveWagerMatchResult(record("white", "x"), record("black", validFen)),
    "gg",
  );
});

test("rejects match IDs outside the invite series", async () => {
  let reads = 0;
  const state = createRepository();
  state.repository.getRtdbPath = async () => {
    reads += 1;
    return null;
  };
  await assert.rejects(
    () =>
      resolveWagerOutcome(
        identity,
        { inviteId: "invite", matchId: "other" },
        state.repository,
      ),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 403,
  );
  assert.equal(reads, 0);
});

test("preserves participant, match, no-wager, and legacy replay outcomes", async () => {
  const cases = [
    {
      state: createRepository({ invite: null }),
      expected: { ok: false, reason: "invite-not-found" },
    },
    {
      state: createRepository({ findProfileId: async () => null }),
      expected: { ok: false, reason: "profile-not-found" },
    },
    {
      state: createRepository({ playerMatch: null }),
      expected: { ok: false, reason: "match-not-found" },
    },
    {
      state: createRepository(),
      expected: { ok: true, reason: "no-wager", mining: snapshot(10) },
    },
    {
      state: createRepository({
        marker: true,
        wager: {
          resolved: {
            winnerId: "host",
            loserId: "guest",
            material: "dust",
            count: 2,
          },
        },
      }),
      expected: {
        ok: true,
        reason: "already-resolved",
        mining: snapshot(10),
      },
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(
      await resolveWagerOutcome(
        identity,
        { inviteId: "invite", matchId: "invite" },
        entry.state.repository,
        { resolveResult: () => "win" },
      ),
      entry.expected,
    );
  }
});

test("fails closed for an unresolved legacy marker", async () => {
  const state = createRepository({
    marker: true,
    wager: { agreed: { material: "dust", count: 2 } },
  });
  await assert.rejects(
    () =>
      resolveWagerOutcome(
        identity,
        { inviteId: "invite", matchId: "invite" },
        state.repository,
        { resolveResult: () => "win" },
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "wager-settlement-uncertain",
  );
  assert.equal(state.appliedTransfers, 0);
});

for (const result of ["win", "gg"] as const) {
  test(`settles an agreed wager exactly once for ${result}`, async () => {
    const state = createRepository({
      wager: { agreed: { material: "dust", count: 2 }, proposals: {} },
    });
    const response = await resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 500, resolveResult: () => result },
    );
    assert.equal(state.appliedTransfers, 1);
    assert.equal(state.marker, true);
    assert.equal(
      (state.wager?.settlement as Record<string, unknown>).state,
      "completed",
    );
    assert.deepEqual(response, {
      ok: true,
      mining: result === "win" ? snapshot(12) : snapshot(8),
    });
  });
}

test("retries a partial settlement without paying twice", async () => {
  const state = createRepository({
    failFrozenOnce: true,
    wager: { agreed: { material: "dust", count: 2 } },
  });
  await assert.rejects(() =>
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 500, resolveResult: () => "win" },
    ),
  );
  assert.equal(state.appliedTransfers, 1);
  assert.equal(state.marker, false);
  assert.equal(
    (state.wager?.settlement as Record<string, unknown>).state,
    "pending",
  );
  assert.deepEqual(
    await resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 600, resolveResult: () => "win" },
    ),
    { ok: true, mining: snapshot(12) },
  );
  assert.equal(state.transferCalls, 2);
  assert.equal(state.appliedTransfers, 1);
  assert.equal(state.marker, true);
});

test("resumes after finalization failure without paying twice", async () => {
  const state = createRepository({
    failPatchOnce: true,
    wager: { agreed: { material: "dust", count: 2 } },
  });
  await assert.rejects(() =>
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 500, resolveResult: () => "win" },
    ),
  );
  await resolveWagerOutcome(
    identity,
    { inviteId: "invite", matchId: "invite" },
    state.repository,
    { now: () => 600, resolveResult: () => "win" },
  );
  assert.equal(state.appliedTransfers, 1);
  assert.equal(state.marker, true);
});

test("cancels insufficient-material wagers without transferring balances", async () => {
  const state = createRepository({
    mining: {
      "profile-host": snapshot(10),
      "profile-guest": snapshot(1),
    },
    wager: { agreed: { material: "dust", count: 2 }, proposals: {} },
  });

  const response = await resolveWagerOutcome(
    identity,
    { inviteId: "invite", matchId: "invite" },
    state.repository,
    { now: () => 500, resolveResult: () => "win" },
  );

  const settlement = state.wager?.settlement as Record<string, unknown>;
  const task = {
    kind: "wager-settlement" as const,
    inviteId: "invite",
    matchId: "invite",
    operationId: String(settlement.operationId),
  };
  assert.equal(state.appliedTransfers, 0);
  assert.equal(state.transferCalls, 1);
  assert.equal(state.transferOutcome, "insufficient-materials");
  assert.deepEqual(state.mining, {
    "profile-host": snapshot(10),
    "profile-guest": snapshot(1),
  });
  assert.equal((state.frozen.host.frozen as Record<string, number>).dust, 0);
  assert.equal((state.frozen.guest.frozen as Record<string, number>).dust, 0);
  assert.equal(settlement.state, "completed");
  assert.equal(
    settlement.failureReason,
    WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON,
  );
  assert.equal(state.wager?.resolved, undefined);
  assert.equal(state.wager?.agreed, null);
  assert.equal(state.wager?.proposals, null);
  assert.equal(state.marker, true);
  assert.deepEqual(response, {
    ok: true,
    reason: "no-wager",
    mining: snapshot(10),
  });
  assert.deepEqual(
    await resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 600, resolveResult: () => "win" },
    ),
    response,
  );
  assert.equal(
    await classifyWagerSettlementRetry(task, state.repository),
    "completed",
  );
  assert.equal(
    await resumeWagerSettlement(task, state.repository, () => 600),
    "completed",
  );
  assert.equal(state.transferCalls, 1);
});

test("only new retry tasks can recover unclaimed wagers", async () => {
  const operationId = "a".repeat(64);
  const legacyTask = {
    kind: "wager-settlement" as const,
    inviteId: "invite",
    matchId: "invite",
    operationId,
  };
  const task = { ...legacyTask, resolution: hostWinResolution };
  for (const wager of [
    { agreed: { material: "dust", count: 2 } },
    {},
    { proposalRemovalOperations: { old: { count: 1 } } },
  ]) {
    const unclaimed = createRepository({ wager });
    assert.equal(
      await classifyWagerSettlementRetry(task, unclaimed.repository),
      "unclaimed",
    );
    assert.equal(
      await classifyWagerSettlementRetry(legacyTask, unclaimed.repository),
      "stale",
    );
    assert.equal(
      await resumeWagerSettlement(legacyTask, unclaimed.repository),
      "stale",
    );
  }

  const malformed = createRepository({
    wager: {
      settlement: {
        version: 1,
        state: "pending",
        operationId,
        fingerprint: "fingerprint",
        claimedAtMs: 1,
        failureReason: "insufficient-materials",
        kind: "agreed",
        winnerUid: "host",
        loserUid: "guest",
        winnerProfileId: "profile-host",
        loserProfileId: "profile-guest",
        material: "dust",
        count: 2,
      },
    },
  });
  await assert.rejects(
    classifyWagerSettlementRetry(task, malformed.repository),
    /wager-settlement-malformed/,
  );
  await assert.rejects(
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      malformed.repository,
      { resolveResult: () => "win" },
    ),
    /wager-settlement-malformed/,
  );
  assert.equal(
    (malformed.wager?.settlement as Record<string, unknown>).failureReason,
    "insufficient-materials",
  );
});

test("recovers when HTTP stops after queueing but before the claim", async () => {
  const state = createRepository({
    wager: { agreed: { material: "dust", count: 2 } },
  });
  const tasks: WagerSettlementRetryTask[] = [];
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (path, updater, signal) => {
    if (path === "invites/invite/wagers/invite") {
      throw new Error("claim-unavailable");
    }
    return transact(path, updater, signal);
  };

  await assert.rejects(() =>
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      {
        now: () => 500,
        resolveResult: () => "win",
        scheduleRetry: async (task) => {
          tasks.push(task);
        },
      },
    ),
  );
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].resolution, hostWinResolution);
  assert.equal(state.wager?.settlement, undefined);

  state.repository.transactRtdbPath = transact;
  assert.equal(
    await classifyWagerSettlementRetry(tasks[0], state.repository),
    "unclaimed",
  );
  assert.equal(
    await resumeWagerSettlement(tasks[0], state.repository, () => 600),
    "completed",
  );
  assert.equal(
    await resumeWagerSettlement(tasks[0], state.repository, () => 700),
    "completed",
  );
  assert.equal(state.appliedTransfers, 1);
  assert.equal(state.transferCalls, 1);
  assert.equal(state.marker, true);
});

test("autonomously cancels an unclaimed underfunded wager", async () => {
  const state = createRepository({
    mining: {
      "profile-host": snapshot(10),
      "profile-guest": snapshot(1),
    },
    wager: { agreed: { material: "dust", count: 2 } },
  });
  const task: WagerSettlementRetryTask = {
    kind: "wager-settlement",
    inviteId: "invite",
    matchId: "invite",
    operationId: "a".repeat(64),
    resolution: hostWinResolution,
  };

  assert.equal(
    await resumeWagerSettlement(task, state.repository, () => 500),
    "completed",
  );
  assert.equal(state.appliedTransfers, 0);
  assert.equal(state.transferOutcome, "insufficient-materials");
  assert.equal((state.frozen.host.frozen as Record<string, number>).dust, 0);
  assert.equal((state.frozen.guest.frozen as Record<string, number>).dust, 0);
  assert.equal(
    (state.wager?.settlement as Record<string, unknown>).failureReason,
    WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON,
  );
  assert.equal(state.marker, true);
});

test("resumes insufficient-material cleanup from the durable outcome", async () => {
  const state = createRepository({
    failFrozenOnce: true,
    mining: {
      "profile-host": snapshot(10),
      "profile-guest": snapshot(1),
    },
    wager: { agreed: { material: "dust", count: 2 } },
  });
  await assert.rejects(() =>
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 500, resolveResult: () => "win" },
    ),
  );
  const settlement = state.wager?.settlement as Record<string, unknown>;
  assert.equal(settlement.state, "pending");
  assert.equal(settlement.failureReason, null);
  const task = {
    kind: "wager-settlement" as const,
    inviteId: "invite",
    matchId: "invite",
    operationId: String(settlement.operationId),
  };

  assert.equal(
    await resumeWagerSettlement(task, state.repository, () => 600),
    "completed",
  );
  assert.equal(state.transferCalls, 2);
  assert.equal(state.appliedTransfers, 0);
  assert.equal(state.transferOutcome, "insufficient-materials");
  assert.equal((state.frozen.host.frozen as Record<string, number>).dust, 0);
  assert.equal((state.frozen.guest.frozen as Record<string, number>).dust, 0);
  assert.equal(state.marker, true);
});

test("treats ambiguous insufficient-material finalization as completed", async () => {
  const state = createRepository({
    failPatchAfterCommitOnce: true,
    mining: {
      "profile-host": snapshot(10),
      "profile-guest": snapshot(1),
    },
    wager: { agreed: { material: "dust", count: 2 } },
  });
  await assert.rejects(() =>
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 500, resolveResult: () => "win" },
    ),
  );
  const settlement = state.wager?.settlement as Record<string, unknown>;
  const task = {
    kind: "wager-settlement" as const,
    inviteId: "invite",
    matchId: "invite",
    operationId: String(settlement.operationId),
  };
  assert.equal(
    await classifyWagerSettlementRetry(task, state.repository),
    "completed",
  );
  assert.equal(
    await resumeWagerSettlement(task, state.repository, () => 600),
    "completed",
  );
  assert.equal(state.transferCalls, 1);
  assert.equal(state.appliedTransfers, 0);
});

test("resumes a pending settlement without a browser session", async () => {
  const state = createRepository({
    failFrozenOnce: true,
    wager: { agreed: { material: "dust", count: 2 } },
  });
  await assert.rejects(() =>
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 500, resolveResult: () => "win" },
    ),
  );
  const operationId = String(
    (state.wager?.settlement as Record<string, unknown>).operationId,
  );
  const task = {
    kind: "wager-settlement" as const,
    inviteId: "invite",
    matchId: "invite",
    operationId,
  };
  const transferCalls = state.transferCalls;
  assert.equal(
    await classifyWagerSettlementRetry(task, state.repository),
    "pending",
  );
  assert.equal(state.transferCalls, transferCalls);
  assert.equal(
    await resumeWagerSettlement(task, state.repository, () => 600),
    "completed",
  );
  assert.equal(
    await classifyWagerSettlementRetry(task, state.repository),
    "completed",
  );
  assert.equal(
    await classifyWagerSettlementRetry(
      { ...task, operationId: "b".repeat(64) },
      state.repository,
    ),
    "stale",
  );
  assert.equal(state.appliedTransfers, 1);
  assert.equal(state.marker, true);
});

test("releases proposal-only reservations", async () => {
  const state = createRepository({
    wager: {
      proposals: {
        host: { material: "dust", count: 2 },
        guest: { material: "slime", count: 1 },
      },
    },
  });
  await resolveWagerOutcome(
    identity,
    { inviteId: "invite", matchId: "invite" },
    state.repository,
    { now: () => 500, resolveResult: () => "win" },
  );
  assert.equal((state.frozen.host.frozen as Record<string, number>).dust, 0);
  assert.equal((state.frozen.guest.frozen as Record<string, number>).slime, 0);
  assert.equal(state.marker, true);
});

test("resumes an empty proposal settlement after RTDB drops empty values", async () => {
  const state = createRepository({
    failPatchOnce: true,
    wager: { proposalRemovalOperations: { previous: { count: 1 } } },
  });
  await assert.rejects(() =>
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      { now: () => 500, resolveResult: () => "win" },
    ),
  );
  const pending = state.wager?.settlement as Record<string, unknown>;
  assert.equal(Object.hasOwn(pending, "completedAtMs"), false);
  assert.equal(Object.hasOwn(pending, "releases"), false);
  await resolveWagerOutcome(
    identity,
    { inviteId: "invite", matchId: "invite" },
    state.repository,
    { now: () => 600, resolveResult: () => "win" },
  );
  assert.equal(state.marker, true);
});

test("claims the live agreement instead of a stale proposal snapshot", async () => {
  const state = createRepository({
    wager: { proposals: { host: { material: "dust", count: 2 } } },
  });
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (path, updater, signal) => {
    if (path === "invites/invite/wagers/invite") {
      state.wager = { agreed: { material: "dust", count: 2 } };
    }
    return transact(path, updater, signal);
  };
  await resolveWagerOutcome(
    identity,
    { inviteId: "invite", matchId: "invite" },
    state.repository,
    { now: () => 500, resolveResult: () => "win" },
  );
  assert.equal(state.appliedTransfers, 1);
  assert.equal(state.marker, true);
});

function context(): Pick<ExecutionContext, "waitUntil"> {
  return { waitUntil() {} };
}

function request(body: unknown): Request {
  return new Request("https://api.mons.link/wagers/outcomes/resolve", {
    method: "POST",
    headers: {
      Origin: "https://mons.link",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("rate limits outcome requests before repository work", async () => {
  let reads = 0;
  const response = await handleGameplayRoute(
    request({ inviteId: "invite", matchId: "invite" }),
    {
      ...env,
      AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as Env,
    context(),
    {
      repository: {
        ...createRepository().repository,
        getRtdbPath: async () => {
          reads += 1;
          return null;
        },
      },
      verifyIdentity: async () => identity,
    },
  );
  assert.equal(response.status, 429);
  assert.equal(reads, 0);
});

test("queues a durable retry before settling", async () => {
  const tasks: Array<{ options?: QueueSendOptions; task: unknown }> = [];
  const order: string[] = [];
  const state = createRepository({
    wager: { agreed: { material: "dust", count: 2 } },
  });
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (...args) => {
    if (args[0] === "invites/invite/wagers/invite") order.push("claim");
    return transact(...args);
  };
  const response = await handleGameplayRoute(
    request({ inviteId: "invite", matchId: "invite" }),
    {
      ...env,
      TELEGRAM_DELIVERY_QUEUE: {
        ...TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE,
        send: async (task, options) => {
          order.push("queue");
          tasks.push({ task, options });
          return {
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          };
        },
      },
    } as Env,
    context(),
    {
      repository: state.repository,
      verifyIdentity: async () => identity,
      wagerOutcome: { now: () => 500, resolveResult: () => "win" },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(tasks, [
    {
      task: {
        kind: "wager-settlement",
        inviteId: "invite",
        matchId: "invite",
        operationId: String(
          (state.wager?.settlement as Record<string, unknown>).operationId,
        ),
        resolution: hostWinResolution,
      },
      options: {
        delaySeconds: WAGER_SETTLEMENT_INITIAL_RETRY_DELAY_SECONDS,
      },
    },
  ]);
  assert.deepEqual(order.slice(0, 2), ["queue", "claim"]);
});

test("does not claim a settlement when retry scheduling fails", async () => {
  const originalWager = { agreed: { material: "dust", count: 2 } };
  const state = createRepository({ wager: originalWager });
  let claims = 0;
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (...args) => {
    if (args[0] === "invites/invite/wagers/invite") claims += 1;
    return transact(...args);
  };

  await assert.rejects(() =>
    resolveWagerOutcome(
      identity,
      { inviteId: "invite", matchId: "invite" },
      state.repository,
      {
        resolveResult: () => "win",
        scheduleRetry: async () => {
          throw new Error("queue-unavailable");
        },
      },
    ),
  );
  assert.equal(claims, 0);
  assert.deepEqual(state.wager, originalWager);
});
