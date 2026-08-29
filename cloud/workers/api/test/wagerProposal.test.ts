import assert from "node:assert/strict";
import test from "node:test";
import {
  isWagerOutcomeResolveRequest,
  isWagerOutcomeResolveResponse,
  isWagerProposalAcceptResponse,
  isWagerProposalRemovalRequest,
  isWagerProposalRemovalResponse,
  isWagerProposalSendRequest,
  isWagerProposalSendResponse,
} from "@mons/shared/wagers";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { FirebaseIdentity } from "../src/firebaseAuth.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import {
  acceptWagerProposal,
  removeWagerProposal,
  sendWagerProposal,
} from "../src/wagerProposal.ts";

const identity: FirebaseIdentity = {
  idToken: "firebase-token",
  profileId: "profile-host",
  uid: "host",
};

function repository(
  overrides: Partial<GameplayRepository> = {},
): GameplayRepository {
  return {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async (uid) => `profile-${uid}`,
    getGameplayProfile: async () => null,
    getNavigationGame: async () => null,
    getMiningMaterials: async () => ({
      dust: 10,
      slime: 10,
      gum: 10,
      metal: 10,
      ice: 10,
    }),
    getMiningSnapshot: async () => null,
    getRtdbPath: async () => ({ hostId: "host", guestId: "guest" }),
    patchRtdbRoot: async () => undefined,
    transactRtdbPath: async () => ({ committed: false, value: null }),
    ...overrides,
  };
}

function applyTransaction(
  updater: (current: unknown) => unknown,
  current: unknown,
): { committed: boolean; decision?: string; value: unknown } {
  const decision = updater(current) as {
    commit?: boolean;
    decision?: string;
    value?: unknown;
  };
  return decision.commit === false
    ? { committed: false, decision: decision.decision, value: current }
    : { committed: true, decision: decision.decision, value: decision.value };
}

function applyMiningTransaction(
  updater: (current: unknown) => unknown,
  current: unknown,
) {
  const record = current as Record<string, unknown>;
  return applyTransaction(
    updater,
    record && typeof record === "object" && "frozen" in record
      ? record
      : { frozen: current },
  );
}

function materialsOnly(value: unknown) {
  const record = value as Record<string, unknown>;
  const source = (record.frozen as Record<string, unknown>) || record;
  return {
    dust: source.dust,
    slime: source.slime,
    gum: source.gum,
    metal: source.metal,
    ice: source.ice,
  };
}

test("wager contracts require exact request and response shapes", () => {
  assert.equal(
    isWagerOutcomeResolveRequest({ inviteId: "invite", matchId: "match" }),
    true,
  );
  assert.equal(
    isWagerOutcomeResolveRequest({
      inviteId: "invite",
      matchId: "match",
      playerId: "host",
    }),
    false,
  );
  assert.equal(
    isWagerOutcomeResolveResponse({
      ok: true,
      mining: {
        lastRockDate: null,
        materials: {
          dust: 1,
          slime: 0,
          gum: 0,
          metal: 0,
          ice: 0,
        },
      },
    }),
    true,
  );
  assert.equal(
    isWagerOutcomeResolveResponse({
      ok: true,
      reason: "already-resolved",
      mining: null,
    }),
    true,
  );
  assert.equal(
    isWagerOutcomeResolveResponse({
      ok: true,
      reason: "insufficient-materials",
      mining: null,
    }),
    false,
  );
  assert.equal(
    isWagerOutcomeResolveResponse({ ok: false, reason: "match-not-found" }),
    true,
  );
  assert.equal(
    isWagerOutcomeResolveResponse({
      ok: false,
      reason: "match-not-found",
      debug: {},
    }),
    false,
  );
  assert.equal(
    isWagerProposalRemovalRequest({ inviteId: "invite", matchId: "match" }),
    true,
  );
  assert.equal(
    isWagerProposalRemovalRequest({
      inviteId: "invite",
      matchId: "match",
      extra: true,
    }),
    false,
  );
  assert.equal(
    isWagerProposalRemovalRequest({ inviteId: " ", matchId: "match" }),
    false,
  );
  assert.equal(isWagerProposalRemovalResponse({ ok: true }), true);
  assert.equal(
    isWagerProposalRemovalResponse({ ok: false, reason: "proposal-missing" }),
    true,
  );
  assert.equal(
    isWagerProposalRemovalResponse({
      ok: false,
      reason: "proposal-missing",
      debug: {},
    }),
    false,
  );
  assert.equal(
    isWagerProposalRemovalResponse({ ok: false, reason: "private" }),
    false,
  );
  assert.equal(
    isWagerProposalSendRequest({
      inviteId: "invite",
      matchId: "match",
      material: "dust",
      count: 1.4,
    }),
    true,
  );
  assert.equal(
    isWagerProposalSendRequest({
      inviteId: "invite",
      matchId: "match",
      material: "dust",
      count: 0.4,
    }),
    false,
  );
  assert.equal(isWagerProposalSendResponse({ ok: true, count: 2 }), true);
  assert.equal(
    isWagerProposalSendResponse({
      ok: true,
      count: 2,
      agreed: {
        material: "dust",
        count: 2,
        total: 4,
        proposerId: "guest",
        accepterId: "host",
        acceptedAt: 100,
      },
    }),
    true,
  );
  assert.equal(
    isWagerProposalSendResponse({ ok: true, count: 2, debug: {} }),
    false,
  );
  assert.equal(isWagerProposalAcceptResponse({ ok: true, count: 2 }), true);
  assert.equal(
    isWagerProposalAcceptResponse({
      ok: false,
      reason: "proposal-unavailable",
    }),
    true,
  );
  assert.equal(
    isWagerProposalAcceptResponse({ ok: false, reason: "private" }),
    false,
  );
});

test("send reserves materials and persists an exact proposal", async () => {
  const transactions: Array<{ path: string; value: unknown }> = [];
  const result = await sendWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match", material: "dust", count: 4 },
    repository({
      transactRtdbPath: async (path, updater) => {
        const transaction = path.startsWith("players/")
          ? applyMiningTransaction(updater, {
              dust: 1,
              slime: 0,
              gum: 0,
              metal: 0,
              ice: 0,
            })
          : applyTransaction(updater, null);
        transactions.push({ path, value: transaction.value });
        return transaction;
      },
    }),
    { now: () => 100 },
  );
  assert.deepEqual(result, { ok: true, count: 4 });
  assert.deepEqual(
    transactions.map(({ path }) => path),
    ["players/host/mining", "invites/invite/wagers/match"],
  );
  assert.deepEqual(materialsOnly(transactions[0].value), {
    dust: 5,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  });
  const wager = transactions[1].value as {
    proposals: Record<string, Record<string, unknown>>;
    proposedBy: Record<string, boolean>;
  };
  assert.equal(wager.proposals.host.material, "dust");
  assert.equal(wager.proposals.host.count, 4);
  assert.equal(wager.proposals.host.createdAt, 100);
  assert.equal(typeof wager.proposals.host.operationId, "string");
  assert.deepEqual(wager.proposedBy, { host: true });
});

test("send creates an automatic agreement and normalizes both reservations", async () => {
  const transactions: Array<{ path: string; value: unknown }> = [];
  const result = await sendWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match", material: "dust", count: 4 },
    repository({
      transactRtdbPath: async (path, updater) => {
        const current =
          path === "players/host/mining"
            ? { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 }
            : path === "players/guest/mining"
              ? { dust: 6, slime: 0, gum: 0, metal: 0, ice: 0 }
              : {
                  proposals: {
                    guest: { material: "dust", count: "6", createdAt: 50 },
                  },
                  proposedBy: { guest: true },
                };
        const transaction = path.startsWith("players/")
          ? applyMiningTransaction(updater, current)
          : applyTransaction(updater, current);
        transactions.push({ path, value: transaction.value });
        return transaction;
      },
    }),
    { now: () => 200 },
  );
  assert.deepEqual(result, {
    ok: true,
    count: 4,
    agreed: {
      material: "dust",
      count: 4,
      total: 8,
      proposerId: "guest",
      accepterId: "host",
      acceptedAt: 200,
    },
  });
  assert.deepEqual(
    transactions.map(({ path }) => path),
    [
      "players/host/mining",
      "invites/invite/wagers/match",
      "players/guest/mining",
    ],
  );
  assert.deepEqual(materialsOnly(transactions[2].value), {
    dust: 4,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  });
});

test("send rolls back its reservation when the proposal is unavailable", async () => {
  const frozenValues: unknown[] = [];
  let frozen = { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };
  const repo = repository({
    transactRtdbPath: async (path, updater) => {
      if (path.startsWith("players/")) {
        const transaction = applyMiningTransaction(updater, frozen);
        frozen = transaction.value as typeof frozen;
        frozenValues.push(frozen);
        return transaction;
      }
      return applyTransaction(updater, { proposedBy: { host: true } });
    },
  });
  const result = await sendWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match", material: "dust", count: 3 },
    repo,
  );
  assert.deepEqual(result, { ok: false, reason: "proposal-unavailable" });
  assert.deepEqual(frozenValues.map(materialsOnly), [
    { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 },
    { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  ]);
  assert.deepEqual(
    await sendWagerProposal(
      identity,
      { inviteId: "invite", matchId: "match", material: "dust", count: 2 },
      repo,
    ),
    { ok: false, reason: "proposal-unavailable" },
  );
  assert.equal(materialsOnly(frozen).dust, 0);
});

test("accept reserves the available count and clears both proposals", async () => {
  const transactions: Array<{ path: string; value: unknown }> = [];
  const patches: Array<Record<string, unknown>> = [];
  let reads = 0;
  const result = await acceptWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    repository({
      getMiningMaterials: async () => ({
        dust: 3,
        slime: 0,
        gum: 0,
        metal: 0,
        ice: 2,
      }),
      getRtdbPath: async () => {
        reads++;
        return reads === 1
          ? { hostId: "host", guestId: "guest" }
          : {
              proposals: {
                guest: { material: "dust", count: 4, createdAt: 1 },
                host: { material: "ice", count: 2, createdAt: 2 },
              },
            };
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
      },
      transactRtdbPath: async (path, updater) => {
        const current =
          path === "players/host/mining"
            ? { dust: 0, slime: 0, gum: 0, metal: 0, ice: 2 }
            : path === "players/guest/mining"
              ? { dust: 4, slime: 0, gum: 0, metal: 0, ice: 0 }
              : {
                  proposals: {
                    guest: { material: "dust", count: 4, createdAt: 1 },
                    host: { material: "ice", count: 2, createdAt: 2 },
                  },
                };
        const transaction = path.startsWith("players/")
          ? applyMiningTransaction(updater, current)
          : applyTransaction(updater, current);
        transactions.push({ path, value: transaction.value });
        return transaction;
      },
    }),
    { now: () => 300 },
  );
  assert.deepEqual(result, { ok: true, count: 3 });
  assert.deepEqual(
    transactions.map(({ path }) => path),
    [
      "players/host/mining",
      "invites/invite/wagers/match",
      "players/guest/mining",
    ],
  );
  assert.deepEqual(materialsOnly(transactions[0].value), {
    dust: 3,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  });
  assert.deepEqual((transactions[1].value as Record<string, unknown>).agreed, {
    material: "dust",
    count: 3,
    total: 6,
    proposerId: "guest",
    accepterId: "host",
    acceptedAt: 300,
  });
  assert.equal(
    (transactions[1].value as Record<string, unknown>).proposals,
    null,
  );
  assert.deepEqual(materialsOnly(transactions[2].value), {
    dust: 3,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  });
  assert.deepEqual(patches, []);
});

test("accept rolls back its exact reservation after an agreement race", async () => {
  let reads = 0;
  const frozenValues: unknown[] = [];
  let frozen = { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };
  const result = await acceptWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    repository({
      getRtdbPath: async () => {
        reads++;
        return reads === 1
          ? { hostId: "host", guestId: "guest" }
          : { proposals: { guest: { material: "dust", count: 3 } } };
      },
      transactRtdbPath: async (path, updater) => {
        if (!path.startsWith("players/")) {
          return applyTransaction(updater, {
            agreed: { material: "dust", count: 3 },
            proposals: { guest: { material: "dust", count: 3 } },
          });
        }
        const transaction = applyMiningTransaction(updater, frozen);
        frozen = transaction.value as typeof frozen;
        frozenValues.push(frozen);
        return transaction;
      },
    }),
  );
  assert.deepEqual(result, { ok: false, reason: "proposal-unavailable" });
  assert.deepEqual(frozenValues.map(materialsOnly), [
    { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 },
    { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  ]);
});

test("send and accept preserve exact domain failure reasons", async () => {
  const sendCases: Array<{
    repo: Partial<GameplayRepository>;
    expected: unknown;
  }> = [
    {
      repo: { getRtdbPath: async () => null },
      expected: { ok: false, reason: "invite-not-found" },
    },
    {
      repo: { getRtdbPath: async () => ({ hostId: "host" }) },
      expected: { ok: false, reason: "missing-opponent" },
    },
    {
      repo: { findProfileId: async (uid) => (uid === "host" ? null : "p") },
      expected: { ok: false, reason: "profile-not-found" },
    },
    {
      repo: {
        getMiningMaterials: async () => ({
          dust: 0,
          slime: 0,
          gum: 0,
          metal: 0,
          ice: 0,
        }),
        transactRtdbPath: async (_path, updater) =>
          applyTransaction(updater, null),
      },
      expected: { ok: false, reason: "insufficient-materials" },
    },
  ];
  for (const entry of sendCases) {
    assert.deepEqual(
      await sendWagerProposal(
        identity,
        {
          inviteId: "invite",
          matchId: "match",
          material: "dust",
          count: 2,
        },
        repository(entry.repo),
      ),
      entry.expected,
    );
  }

  for (const wager of [
    null,
    { agreed: { count: 1 } },
    { resolved: true },
    { proposals: { host: { material: "dust", count: 1 } } },
  ]) {
    let reads = 0;
    assert.deepEqual(
      await acceptWagerProposal(
        identity,
        { inviteId: "invite", matchId: "match" },
        repository({
          getRtdbPath: async () => {
            reads++;
            return reads === 1 ? { hostId: "host", guestId: "guest" } : wager;
          },
        }),
      ),
      { ok: false, reason: "proposal-missing" },
    );
  }

  let reads = 0;
  assert.deepEqual(
    await acceptWagerProposal(
      identity,
      { inviteId: "invite", matchId: "match" },
      repository({
        getMiningMaterials: async () => ({
          dust: 0,
          slime: 0,
          gum: 0,
          metal: 0,
          ice: 0,
        }),
        getRtdbPath: async () => {
          reads++;
          return reads === 1
            ? { hostId: "host", guestId: "guest" }
            : { proposals: { guest: { material: "dust", count: 2 } } };
        },
        transactRtdbPath: async (_path, updater) =>
          applyTransaction(updater, null),
      }),
    ),
    { ok: false, reason: "insufficient-materials" },
  );
});

test("cancel removes the caller proposal and releases only its materials", async () => {
  const transactions: Array<{ path: string; value: unknown }> = [];
  const result = await removeWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    "cancel",
    repository({
      findProfileId: async (uid, token) => {
        assert.equal(token, identity.idToken);
        return `profile-${uid}`;
      },
      transactRtdbPath: async (path, updater) => {
        const current = path.startsWith("invites/")
          ? {
              proposals: {
                host: { material: "dust", count: 3, createdAt: 1 },
                guest: { material: "ice", count: 2, createdAt: 2 },
              },
              proposedBy: { host: true, guest: true },
            }
          : { dust: 5, slime: 1, gum: 0, metal: 0, ice: 4 };
        const transaction = path.startsWith("players/")
          ? applyMiningTransaction(updater, current)
          : applyTransaction(updater, current);
        transactions.push({ path, value: transaction.value });
        return transaction;
      },
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    transactions.map(({ path }) => path),
    ["invites/invite/wagers/match", "players/host/mining"],
  );
  const wager = transactions[0].value as {
    proposals: Record<string, unknown>;
    proposedBy: Record<string, boolean>;
    proposalRemovalOperations: Record<string, unknown>;
  };
  assert.deepEqual(wager.proposals, {
    guest: { material: "ice", count: 2, createdAt: 2 },
  });
  assert.deepEqual(wager.proposedBy, { host: true, guest: true });
  assert.equal(Object.keys(wager.proposalRemovalOperations).length, 1);
  assert.deepEqual(materialsOnly(transactions[1].value), {
    dust: 2,
    slime: 1,
    gum: 0,
    metal: 0,
    ice: 4,
  });
});

test("decline removes the opponent proposal and clamps frozen counts", async () => {
  const paths: string[] = [];
  const result = await removeWagerProposal(
    { ...identity, profileId: "profile-guest", uid: "guest" },
    { inviteId: "invite", matchId: "match" },
    "decline",
    repository({
      transactRtdbPath: async (path, updater) => {
        paths.push(path);
        return applyTransaction(
          updater,
          path.startsWith("invites/")
            ? { proposals: { host: { material: "metal", count: 9 } } }
            : { dust: 0, slime: 0, gum: 0, metal: 2, ice: 0 },
        );
      },
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(paths, [
    "invites/invite/wagers/match",
    "players/host/mining",
  ]);
});

test("profile claims authorize linked logins with host precedence", async () => {
  const paths: string[] = [];
  const result = await removeWagerProposal(
    { idToken: "token", profileId: "shared-profile", uid: "linked-login" },
    { inviteId: "invite", matchId: "match" },
    "cancel",
    repository({
      findProfileId: async () => "shared-profile",
      transactRtdbPath: async (path, updater) => {
        paths.push(path);
        return applyTransaction(
          updater,
          path.startsWith("invites/")
            ? { proposals: { host: { material: "dust", count: 1 } } }
            : { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
        );
      },
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(paths[1], "players/host/mining");
});

test("returns exact domain outcomes without debug data", async () => {
  const cases: Array<{
    repo: Partial<GameplayRepository>;
    expected: unknown;
  }> = [
    {
      repo: { getRtdbPath: async () => null },
      expected: { ok: false, reason: "invite-not-found" },
    },
    {
      repo: { getRtdbPath: async () => ({ hostId: "host" }) },
      expected: { ok: false, reason: "missing-opponent" },
    },
    {
      repo: { findProfileId: async (uid) => (uid === "host" ? null : "p") },
      expected: { ok: false, reason: "profile-not-found" },
    },
    {
      repo: {
        transactRtdbPath: async (_path, updater) =>
          applyTransaction(updater, { agreed: { count: 1 }, proposals: {} }),
      },
      expected: { ok: false, reason: "proposal-missing" },
    },
    {
      repo: {
        transactRtdbPath: async (_path, updater) =>
          applyTransaction(updater, { resolved: true, proposals: {} }),
      },
      expected: { ok: false, reason: "proposal-missing" },
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(
      await removeWagerProposal(
        identity,
        { inviteId: "invite", matchId: "match" },
        "cancel",
        repository(entry.repo),
      ),
      entry.expected,
    );
  }
});

test("does not remove or release a proposal after agreement", async () => {
  let transactions = 0;
  const result = await removeWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    "cancel",
    repository({
      getRtdbPath: async () => ({ hostId: "host", guestId: "guest" }),
      transactRtdbPath: async (_path, updater) => {
        transactions++;
        return applyTransaction(updater, {
          agreed: { material: "dust", count: 1 },
          proposals: { host: { material: "dust", count: 1 } },
        });
      },
    }),
  );
  assert.deepEqual(result, { ok: false, reason: "proposal-missing" });
  assert.equal(transactions, 1);
});

test("send reconciles an ambiguous wager write without reserving twice", async () => {
  let wager: unknown = null;
  let frozen: unknown = {
    dust: 0,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  };
  let throwAfterCommit = true;
  const repo = repository({
    getRtdbPath: async (path) =>
      path === "invites/invite" ? { hostId: "host", guestId: "guest" } : wager,
    transactRtdbPath: async (path, updater) => {
      if (path.startsWith("players/")) {
        const result = applyMiningTransaction(updater, frozen);
        if (result.committed) frozen = result.value;
        return result;
      }
      const result = applyTransaction(updater, wager);
      if (result.committed) wager = result.value;
      if (throwAfterCommit) {
        throwAfterCommit = false;
        throw new Error("ambiguous-write");
      }
      return result;
    },
  });
  const request = {
    inviteId: "invite",
    matchId: "match",
    material: "dust" as const,
    count: 3,
  };
  assert.deepEqual(await sendWagerProposal(identity, request, repo), {
    ok: true,
    count: 3,
  });
  assert.deepEqual(await sendWagerProposal(identity, request, repo), {
    ok: true,
    count: 3,
  });
  assert.equal(materialsOnly(frozen).dust, 3);
});

test("old operation markers remain idempotent after many later wagers", async () => {
  let mining: unknown = {
    frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  const wagers = new Map<string, unknown>();
  const repo = repository({
    getMiningMaterials: async () => ({
      dust: 1000,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    }),
    getRtdbPath: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "players/host/mining") {
        return mining;
      }
      return wagers.get(path.split("/").at(-1) || "") || null;
    },
    transactRtdbPath: async (path, updater) => {
      if (path === "players/host/mining") {
        const result = applyTransaction(updater, mining);
        if (result.committed) mining = result.value;
        return result;
      }
      const matchId = path.split("/").at(-1) || "";
      const result = applyTransaction(updater, wagers.get(matchId) || null);
      if (result.committed) wagers.set(matchId, result.value);
      return result;
    },
  });
  for (let index = 0; index < 129; index++) {
    await sendWagerProposal(
      identity,
      {
        inviteId: "invite",
        matchId: `match${index}`,
        material: "dust",
        count: 1,
      },
      repo,
      { now: () => index + 1 },
    );
  }
  const before = materialsOnly(mining).dust;
  await sendWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match0", material: "dust", count: 1 },
    repo,
  );
  assert.equal(materialsOnly(mining).dust, before);
});

test("send replay does not release a proposal already canceled", async () => {
  let wager: unknown = null;
  const frozen: Record<string, unknown> = {
    host: { dust: 5, slime: 0, gum: 0, metal: 0, ice: 0 },
    guest: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  const repo = repository({
    getRtdbPath: async (path) =>
      path === "invites/invite" ? { hostId: "host", guestId: "guest" } : wager,
    transactRtdbPath: async (path, updater) => {
      if (path.startsWith("invites/")) {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value;
        return result;
      }
      const uid = path.includes("/host/") ? "host" : "guest";
      const result = applyMiningTransaction(updater, frozen[uid]);
      if (result.committed) frozen[uid] = result.value;
      return result;
    },
  });
  const request = {
    inviteId: "invite",
    matchId: "match",
    material: "dust" as const,
    count: 3,
  };
  assert.deepEqual(await sendWagerProposal(identity, request, repo), {
    ok: true,
    count: 3,
  });
  assert.deepEqual(
    await removeWagerProposal(
      identity,
      { inviteId: "invite", matchId: "match" },
      "cancel",
      repo,
    ),
    { ok: true },
  );
  assert.deepEqual(await sendWagerProposal(identity, request, repo), {
    ok: false,
    reason: "proposal-unavailable",
  });
  assert.equal(materialsOnly(frozen.host).dust, 5);
});

test("accept and cancellation cannot both commit the same proposal", async () => {
  let wager: Record<string, unknown> = {
    proposals: { guest: { material: "dust", count: 3 } },
  };
  const frozen: Record<string, unknown> = {
    host: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
    guest: { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  let releaseReservation: (() => void) | undefined;
  const reservationGate = new Promise<void>((resolve) => {
    releaseReservation = resolve;
  });
  let sawAcceptSnapshot: (() => void) | undefined;
  const acceptSnapshot = new Promise<void>((resolve) => {
    sawAcceptSnapshot = resolve;
  });
  let pauseAccept = true;
  const repo = repository({
    getRtdbPath: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (pauseAccept) {
        sawAcceptSnapshot?.();
      }
      return structuredClone(wager);
    },
    transactRtdbPath: async (path, updater) => {
      if (path === "players/host/mining" && pauseAccept) {
        await reservationGate;
        pauseAccept = false;
      }
      if (path === "invites/invite/wagers/match") {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value as Record<string, unknown>;
        return result;
      }
      const uid = path.includes("/host/") ? "host" : "guest";
      const result = applyMiningTransaction(updater, frozen[uid]);
      if (result.committed) frozen[uid] = result.value;
      return result;
    },
  });
  const accepting = acceptWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    repo,
  );
  await acceptSnapshot;
  const canceled = await removeWagerProposal(
    { idToken: "token", profileId: "profile-guest", uid: "guest" },
    { inviteId: "invite", matchId: "match" },
    "cancel",
    repo,
  );
  releaseReservation?.();
  const accepted = await accepting;
  assert.deepEqual(canceled, { ok: true });
  assert.deepEqual(accepted, { ok: false, reason: "proposal-unavailable" });
  assert.equal(wager.agreed, undefined);
  assert.equal(materialsOnly(frozen.guest).dust, 0);
  assert.equal(materialsOnly(frozen.host).dust, 0);
});

test("cancellation retries a failed material release from its durable record", async () => {
  let wager: unknown = {
    proposals: { host: { material: "dust", count: 2 } },
  };
  let frozen: unknown = {
    dust: 2,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  };
  let failRelease = true;
  const repo = repository({
    transactRtdbPath: async (path, updater) => {
      if (path.startsWith("invites/")) {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value;
        return result;
      }
      if (failRelease) {
        failRelease = false;
        throw new Error("release-unavailable");
      }
      const result = applyMiningTransaction(updater, frozen);
      if (result.committed) frozen = result.value;
      return result;
    },
  });
  const request = { inviteId: "invite", matchId: "match" };
  await assert.rejects(
    removeWagerProposal(identity, request, "cancel", repo, {
      logMaterialReleaseFailure: () => undefined,
    }),
    /wager-material-release-failed/,
  );
  assert.deepEqual(
    await removeWagerProposal(identity, request, "cancel", repo),
    { ok: true },
  );
  assert.equal(materialsOnly(frozen).dust, 0);
});

test("accept replay completes a failed proposer adjustment once", async () => {
  let wager: unknown = {
    proposals: { guest: { material: "dust", count: 4 } },
  };
  const frozen: Record<string, unknown> = {
    host: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
    guest: { dust: 4, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  let failAdjustment = true;
  const repo = repository({
    getMiningMaterials: async () => ({
      dust: 3,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    }),
    getRtdbPath: async (path) =>
      path === "invites/invite" ? { hostId: "host", guestId: "guest" } : wager,
    transactRtdbPath: async (path, updater) => {
      if (path.startsWith("invites/")) {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value;
        return result;
      }
      const uid = path.includes("/host/") ? "host" : "guest";
      if (uid === "guest" && failAdjustment) {
        failAdjustment = false;
        throw new Error("adjustment-unavailable");
      }
      const result = applyMiningTransaction(updater, frozen[uid]);
      if (result.committed) frozen[uid] = result.value;
      return result;
    },
  });
  const request = { inviteId: "invite", matchId: "match" };
  await assert.rejects(
    acceptWagerProposal(identity, request, repo),
    /wager-operation-unavailable/,
  );
  assert.deepEqual(await acceptWagerProposal(identity, request, repo), {
    ok: true,
    count: 3,
  });
  assert.equal(materialsOnly(frozen.host).dust, 3);
  assert.equal(materialsOnly(frozen.guest).dust, 3);
});

test("rejects non-participants and sanitizes material release failures", async () => {
  await assert.rejects(
    () =>
      removeWagerProposal(
        { idToken: "token", profileId: "other", uid: "other" },
        { inviteId: "invite", matchId: "match" },
        "cancel",
        repository(),
      ),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 403,
  );

  const logs: Array<Record<string, unknown>> = [];
  let transactions = 0;
  await assert.rejects(
    () =>
      removeWagerProposal(
        identity,
        { inviteId: "invite", matchId: "match" },
        "cancel",
        repository({
          transactRtdbPath: async (_path, updater) => {
            transactions++;
            if (transactions === 2) {
              throw new Error("private-upstream-detail");
            }
            return applyTransaction(updater, {
              proposals: { host: { material: "dust", count: 1 } },
            });
          },
        }),
        { logMaterialReleaseFailure: (record) => logs.push(record) },
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "wager-material-release-failed" &&
      !error.message.includes("private"),
  );
  assert.deepEqual(logs, [
    {
      event: "wager_proposal_material_release_failed",
      action: "cancel",
      inviteId: "invite",
      matchId: "match",
      proposalUid: "host",
    },
  ]);
});
