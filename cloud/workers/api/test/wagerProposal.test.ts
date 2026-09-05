import { attachMemoryWagerFrozenStore } from "./wagerFrozenTestUtils.ts";
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
import type { RequestIdentity } from "../src/requestIdentity.ts";
import type { TestGameplayRepository as GameplayRepository } from "./wagerFrozenTestUtils.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";
import {
  acceptWagerProposal as acceptWagerProposalImpl,
  consumeWagerReservationOperation,
  createWagerReservationOperationId,
  removeWagerProposal as removeWagerProposalImpl,
  sendWagerProposal as sendWagerProposalImpl,
  type WagerProposalAction,
  type WagerProposalDependencies,
} from "../src/wagerProposal.ts";
import {
  createOperationId,
  operationFingerprint,
} from "../src/wagerReservationOperations.ts";
import { createMemoryGameplayCoordinationStores } from "./gameplayCoordinationTestUtils.ts";

const identity: RequestIdentity = {
  uid: "host",
};

const coordinationByRepository = new WeakMap<
  import("../src/gameplayRepository.ts").GameplayRepository,
  ReturnType<typeof createMemoryGameplayCoordinationStores>
>();

function coordinationFor(
  repository: import("../src/gameplayRepository.ts").GameplayRepository,
) {
  let coordination = coordinationByRepository.get(repository);
  if (!coordination) {
    coordination = createMemoryGameplayCoordinationStores();
    coordinationByRepository.set(repository, coordination);
  }
  return coordination;
}

function wagerDependencies(
  repository: GameplayRepository,
  dependencies: Partial<WagerProposalDependencies> = {},
): WagerProposalDependencies {
  return {
    mutationLocks: coordinationFor(repository).mutationLocks,
    ...dependencies,
  };
}

function sendWagerProposal(
  identity: Parameters<typeof sendWagerProposalImpl>[0],
  request: Parameters<typeof sendWagerProposalImpl>[1],
  repository: GameplayRepository,
  dependencies: Partial<WagerProposalDependencies> = {},
) {
  return sendWagerProposalImpl(
    identity,
    request,
    repository,
    wagerDependencies(repository, dependencies),
  );
}

function acceptWagerProposal(
  identity: Parameters<typeof acceptWagerProposalImpl>[0],
  request: Parameters<typeof acceptWagerProposalImpl>[1],
  repository: GameplayRepository,
  dependencies: Partial<WagerProposalDependencies> = {},
) {
  return acceptWagerProposalImpl(
    identity,
    request,
    repository,
    wagerDependencies(repository, dependencies),
  );
}

function removeWagerProposal(
  identity: Parameters<typeof removeWagerProposalImpl>[0],
  request: Parameters<typeof removeWagerProposalImpl>[1],
  action: WagerProposalAction,
  repository: GameplayRepository,
  dependencies: Partial<WagerProposalDependencies> = {},
) {
  return removeWagerProposalImpl(
    identity,
    request,
    action,
    repository,
    wagerDependencies(repository, dependencies),
  );
}

function ownershipSnapshot(
  query: ProfileOwnershipQuery,
  ownerForUid: (uid: string) => string | null = (uid) => `profile-${uid}`,
): ProfileOwnershipSnapshot {
  const loginOwnerByUid = new Map(
    query.loginUids.map((uid) => {
      const profileId = ownerForUid(uid);
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
        query.loginUids
          .filter((uid) => ownerForUid(uid) === profileId)
          .slice()
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

function repository(
  overrides: Partial<GameplayRepository> = {},
): GameplayRepository {
  const transactState =
    overrides.transactState ||
    (async () => ({ committed: false, value: null }));
  const value: Omit<GameplayRepository, "getRtdbPath" | "transactRtdbPath"> = {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    getNavigationGame: async () => null,
    getMiningMaterials: async () => ({
      dust: 10,
      slime: 10,
      gum: 10,
      metal: 10,
      ice: 10,
    }),
    getMiningSnapshot: async () => null,
    readState: async () => ({ hostId: "host", guestId: "guest" }),
    patchRtdbRoot: async () => undefined,
    readProfileOwnershipSnapshot: async (query) => ownershipSnapshot(query),
    ...overrides,
    transactState: async (path, updater, signal) => {
      assert.doesNotMatch(
        path,
        /^(?:gameplayMutationLocks|matchTimerStarts)\//,
      );
      return transactState(path, updater, signal);
    },
  };
  return attachMemoryWagerFrozenStore(value);
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

function createEmptyMaterials() {
  return { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };
}

async function modernProposal(
  uid: string,
  material: "dust" | "slime" | "gum" | "metal" | "ice",
  count: number,
  createdAt = 1,
  inviteId = "invite",
  matchId = "match",
) {
  return {
    material,
    count,
    createdAt,
    operationId: await createOperationId(
      "send",
      inviteId,
      matchId,
      uid,
      material,
      String(count),
    ),
    reservationOperationId: await createWagerReservationOperationId(
      "send",
      inviteId,
      matchId,
      uid,
    ),
  };
}

function installSendReservation(
  miningValue: unknown,
  proposal: Awaited<ReturnType<typeof modernProposal>>,
  appliedAtMs = 1,
): Record<string, unknown> {
  const mining = miningValue as Record<string, unknown>;
  const root = "frozen" in mining ? mining : { frozen: mining };
  const operations = ((root as Record<string, unknown>).operations ||=
    {}) as Record<string, unknown>;
  operations[proposal.reservationOperationId] = {
    appliedAtMs,
    count: proposal.count,
    deltas: { [proposal.material]: proposal.count },
    fingerprint: operationFingerprint(
      "send-reserve",
      proposal.material,
      proposal.count,
    ),
  };
  return root as Record<string, unknown>;
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
  assert.equal(
    isWagerProposalSendRequest({
      inviteId: "invite",
      matchId: "match",
      material: "dust",
      count: Number.MAX_SAFE_INTEGER + 1,
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
      transactState: async (path, updater) => {
        const transaction = path.startsWith("reservations/")
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
    ["reservations/host", "invites/invite/wagers/match"],
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

test("send fences its initial reservation with a fresh critical-phase signal", async () => {
  const controller = new AbortController();
  const miningSignals: Array<AbortSignal | undefined> = [];
  await sendWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match", material: "dust", count: 1 },
    repository({
      transactState: async (path, updater, signal) => {
        if (path.startsWith("reservations/")) {
          miningSignals.push(signal);
          return applyMiningTransaction(updater, {
            dust: 0,
            slime: 0,
            gum: 0,
            metal: 0,
            ice: 0,
          });
        }
        return applyTransaction(updater, null);
      },
    }),
    { createCriticalPhaseSignal: () => controller.signal },
  );
  assert.deepEqual(miningSignals, [controller.signal]);
});

test("send creates an automatic agreement and normalizes both reservations", async () => {
  const transactions: Array<{ path: string; value: unknown }> = [];
  const guestProposal = await modernProposal("guest", "dust", 6, 50);
  const mining: Record<string, unknown> = {
    host: { frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 } },
    guest: { frozen: { dust: 6, slime: 0, gum: 0, metal: 0, ice: 0 } },
  };
  mining.guest = installSendReservation(mining.guest, guestProposal);
  let wager: unknown = {
    proposals: {
      guest: guestProposal,
    },
    proposedBy: { guest: true },
  };
  const result = await sendWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match", material: "dust", count: 4 },
    repository({
      readState: async (path) => {
        if (path === "invites/invite") {
          return { hostId: "host", guestId: "guest" };
        }
        const uid =
          path.split("/")[1] === "host"
            ? "host"
            : path.split("/")[1] === "guest"
              ? "guest"
              : null;
        return uid ? mining[uid] : wager;
      },
      transactState: async (path, updater) => {
        const uid =
          path.split("/")[1] === "host"
            ? "host"
            : path.split("/")[1] === "guest"
              ? "guest"
              : null;
        const current = uid ? mining[uid] : wager;
        const transaction = path.startsWith("reservations/")
          ? applyMiningTransaction(updater, current)
          : applyTransaction(updater, current);
        if (transaction.committed) {
          if (uid) mining[uid] = transaction.value;
          else wager = transaction.value;
        }
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
      "reservations/host",
      "invites/invite/wagers/match",
      "reservations/guest",
      "invites/invite/wagers/match",
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
    transactState: async (path, updater) => {
      if (path.startsWith("reservations/")) {
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

test("send rejects a canonical reservation ID with the wrong operation kind", async () => {
  const reservationOperationId = await createWagerReservationOperationId(
    "send",
    "invite",
    "match",
    "host",
  );
  const mining = {
    frozen: { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
    operations: {
      [reservationOperationId]: {
        appliedAtMs: 1,
        count: 1,
        deltas: { dust: 1 },
        fingerprint: JSON.stringify([
          "accept-reserve",
          "dust:",
          1,
          0,
          0,
          0,
          0,
          0,
        ]),
      },
    },
  };
  let miningWrites = 0;
  await assert.rejects(
    sendWagerProposal(
      identity,
      { inviteId: "invite", matchId: "match", material: "dust", count: 1 },
      repository({
        readState: async (path) =>
          path === "invites/invite"
            ? { hostId: "host", guestId: "guest" }
            : path.startsWith("reservations/")
              ? mining
              : null,
        transactState: async (path, updater) => {
          if (path.startsWith("reservations/")) miningWrites += 1;
          return applyTransaction(updater, mining);
        },
      }),
    ),
    /wager-operation-unavailable/,
  );
  assert.equal(miningWrites, 0);
});

test("automatic agreement rejects a proposal without its active reservation", async () => {
  const guestProposal = await modernProposal("guest", "dust", 2);
  let transactions = 0;
  const result = await sendWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match", material: "dust", count: 2 },
    repository({
      readState: async (path) => {
        if (path === "invites/invite") {
          return { hostId: "host", guestId: "guest" };
        }
        if (path === "reservations/host") {
          return { frozen: createEmptyMaterials() };
        }
        if (path === "reservations/guest") {
          return {
            frozen: { ...createEmptyMaterials(), dust: 2 },
          };
        }
        return { proposals: { guest: guestProposal } };
      },
      transactState: async () => {
        transactions += 1;
        return { committed: false, value: null };
      },
    }),
  );
  assert.deepEqual(result, { ok: false, reason: "proposal-unavailable" });
  assert.equal(transactions, 0);
});

test("accept reserves the available count and clears both proposals", async () => {
  const transactions: Array<{ path: string; value: unknown }> = [];
  const patches: Array<Record<string, unknown>> = [];
  const guestProposal = await modernProposal("guest", "dust", 4);
  const hostProposal = await modernProposal("host", "ice", 2, 2);
  const mining: Record<string, unknown> = {
    host: { frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 2 } },
    guest: { frozen: { dust: 4, slime: 0, gum: 0, metal: 0, ice: 0 } },
  };
  mining.host = installSendReservation(mining.host, hostProposal);
  mining.guest = installSendReservation(mining.guest, guestProposal);
  let wager: unknown = {
    proposals: {
      guest: guestProposal,
      host: hostProposal,
    },
  };
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
      readState: async (path) => {
        if (path === "invites/invite") {
          return { hostId: "host", guestId: "guest" };
        }
        if (path === "reservations/host") return mining.host;
        if (path === "reservations/guest") return mining.guest;
        return wager;
      },
      patchRtdbRoot: async (updates) => {
        patches.push(updates);
      },
      transactState: async (path, updater) => {
        const uid =
          path.split("/")[1] === "host"
            ? "host"
            : path.split("/")[1] === "guest"
              ? "guest"
              : null;
        const current = uid ? mining[uid] : wager;
        const transaction = path.startsWith("reservations/")
          ? applyMiningTransaction(updater, current)
          : applyTransaction(updater, current);
        if (transaction.committed) {
          if (uid) mining[uid] = transaction.value;
          else wager = transaction.value;
        }
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
      "reservations/host",
      "invites/invite/wagers/match",
      "reservations/guest",
      "invites/invite/wagers/match",
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
  const frozenValues: unknown[] = [];
  let frozen = { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };
  const guestProposal = await modernProposal("guest", "dust", 3);
  const guestMining = installSendReservation(
    { frozen: { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 } },
    guestProposal,
  );
  const result = await acceptWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    repository({
      readState: async (path) => {
        if (path === "invites/invite") {
          return { hostId: "host", guestId: "guest" };
        }
        if (path === "reservations/host") return frozen;
        if (path === "reservations/guest") return guestMining;
        return { proposals: { guest: guestProposal } };
      },
      transactState: async (path, updater) => {
        if (!path.startsWith("reservations/")) {
          return applyTransaction(updater, {
            agreed: { material: "dust", count: 3 },
            proposals: { guest: guestProposal },
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

test("accept rejects a proposal without its active reservation", async () => {
  const guestProposal = await modernProposal("guest", "dust", 2);
  let transactions = 0;
  const result = await acceptWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    repository({
      readState: async (path) => {
        if (path === "invites/invite") {
          return { hostId: "host", guestId: "guest" };
        }
        if (path === "reservations/host") {
          return { frozen: createEmptyMaterials() };
        }
        if (path === "reservations/guest") {
          return {
            frozen: { ...createEmptyMaterials(), dust: 2 },
          };
        }
        return { proposals: { guest: guestProposal } };
      },
      transactState: async () => {
        transactions += 1;
        return { committed: false, value: null };
      },
    }),
  );
  assert.deepEqual(result, { ok: false, reason: "proposal-unavailable" });
  assert.equal(transactions, 0);
});

test("send and accept preserve exact domain failure reasons", async () => {
  const sendCases: Array<{
    repo: Partial<GameplayRepository>;
    expected: unknown;
  }> = [
    {
      repo: { readState: async () => null },
      expected: { ok: false, reason: "invite-not-found" },
    },
    {
      repo: { readState: async () => ({ hostId: "host" }) },
      expected: { ok: false, reason: "missing-opponent" },
    },
    {
      repo: {
        readProfileOwnershipSnapshot: async (query) =>
          ownershipSnapshot(query, (uid) => (uid === "host" ? null : "p")),
      },
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
        transactState: async (_path, updater) =>
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
          readState: async () => {
            reads++;
            return reads <= 2 ? { hostId: "host", guestId: "guest" } : wager;
          },
        }),
      ),
      { ok: false, reason: "proposal-missing" },
    );
  }

  const unavailableProposal = await modernProposal("guest", "dust", 2);
  const unavailableMining = installSendReservation(
    { frozen: { dust: 2, slime: 0, gum: 0, metal: 0, ice: 0 } },
    unavailableProposal,
  );
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
        readState: async (path) => {
          if (path === "invites/invite") {
            return { hostId: "host", guestId: "guest" };
          }
          if (path === "reservations/guest") return unavailableMining;
          return { proposals: { guest: unavailableProposal } };
        },
        transactState: async (_path, updater) =>
          applyTransaction(updater, null),
      }),
    ),
    { ok: false, reason: "insufficient-materials" },
  );
});

test("same-canonical participants cannot create or accept a wager", async () => {
  let miningReads = 0;
  let transactions = 0;
  const value = repository({
    getMiningMaterials: async () => {
      miningReads++;
      return { dust: 10, slime: 10, gum: 10, metal: 10, ice: 10 };
    },
    readState: async (path) =>
      path === "invites/invite"
        ? { hostId: "host", guestId: "guest" }
        : { proposals: { guest: { material: "dust", count: 1 } } },
    readProfileOwnershipSnapshot: async (query) =>
      ownershipSnapshot(query, () => "shared-profile"),
    transactState: async () => {
      transactions++;
      return { committed: false, value: null };
    },
  });
  assert.deepEqual(
    await sendWagerProposal(
      identity,
      {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 1,
      },
      value,
    ),
    { ok: false, reason: "proposal-unavailable" },
  );
  assert.deepEqual(
    await acceptWagerProposal(
      identity,
      { inviteId: "invite", matchId: "match" },
      value,
    ),
    { ok: false, reason: "proposal-unavailable" },
  );
  assert.equal(miningReads, 0);
  assert.equal(transactions, 0);
});

test("releases a stranded send reservation after participants merge", async () => {
  let merged = false;
  let failWagerRead = true;
  let ownershipReads = 0;
  let wagerReads = 0;
  let wagerTransactions = 0;
  let miningState: unknown = {
    frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  const value = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return miningState;
      if (path === "invites/invite/wagers/match") {
        wagerReads += 1;
        if (failWagerRead && wagerReads > 1) {
          throw new Error("wager-read-unavailable");
        }
        return null;
      }
      return null;
    },
    readProfileOwnershipSnapshot: async (query) => {
      ownershipReads++;
      return ownershipSnapshot(query, (uid) =>
        merged ? "shared-profile" : `profile-${uid}`,
      );
    },
    transactState: async (path, updater) => {
      if (path === "reservations/host") {
        const transaction = applyMiningTransaction(updater, miningState);
        if (transaction.committed) miningState = transaction.value;
        return transaction;
      }
      wagerTransactions++;
      throw new Error("wager-write-unavailable");
    },
  });
  const input = {
    inviteId: "invite",
    matchId: "match",
    material: "dust" as const,
    count: 3,
  };

  await assert.rejects(() => sendWagerProposal(identity, input, value));
  assert.equal(materialsOnly(miningState).dust, 3);

  merged = true;
  failWagerRead = false;
  assert.deepEqual(await sendWagerProposal(identity, input, value), {
    ok: false,
    reason: "proposal-unavailable",
  });
  assert.equal(materialsOnly(miningState).dust, 0);
  assert.deepEqual(await sendWagerProposal(identity, input, value), {
    ok: false,
    reason: "proposal-unavailable",
  });
  assert.equal(materialsOnly(miningState).dust, 0);
  assert.equal(ownershipReads, 3);
  assert.equal(wagerTransactions, 1);
});

test("changed send input replaces an unreferenced stranded reservation", async () => {
  let miningState: unknown = {
    frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  let wager: unknown = null;
  let failWagerWrite = true;
  let failWagerRead = true;
  let wagerReads = 0;
  const value = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return miningState;
      if (path === "invites/invite/wagers/match") {
        wagerReads += 1;
        if (failWagerRead && wagerReads > 1) {
          throw new Error("wager-read-unavailable");
        }
        return wager;
      }
      return null;
    },
    transactState: async (path, updater) => {
      if (path === "reservations/host") {
        const transaction = applyMiningTransaction(updater, miningState);
        if (transaction.committed) miningState = transaction.value;
        return transaction;
      }
      if (failWagerWrite) throw new Error("wager-write-unavailable");
      const transaction = applyTransaction(updater, wager);
      if (transaction.committed) wager = transaction.value;
      return transaction;
    },
  });

  await assert.rejects(() =>
    sendWagerProposal(
      identity,
      {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 3,
      },
      value,
    ),
  );
  assert.equal(materialsOnly(miningState).dust, 3);

  failWagerWrite = false;
  failWagerRead = false;
  assert.deepEqual(
    await sendWagerProposal(
      identity,
      {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 1,
      },
      value,
    ),
    { ok: true, count: 1 },
  );
  assert.equal(materialsOnly(miningState).dust, 1);
  assert.deepEqual(
    await removeWagerProposal(
      identity,
      { inviteId: "invite", matchId: "match" },
      "cancel",
      value,
    ),
    { ok: true },
  );
  assert.equal(materialsOnly(miningState).dust, 0);
});

test("changed send cleanup cannot release a competing proposal", async () => {
  const reservationOperationId = await createWagerReservationOperationId(
    "send",
    "invite",
    "match",
    "host",
  );
  let wager: unknown = null;
  let miningState: unknown = {
    frozen: { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 },
    operations: {
      [reservationOperationId]: {
        appliedAtMs: 1,
        count: 3,
        deltas: { dust: 3 },
        fingerprint: JSON.stringify(["send-reserve", "dust", 3, 0, 0, 0, 0, 0]),
      },
    },
  };
  let resumeCleanup: (() => void) | undefined;
  const cleanupGate = new Promise<void>((resolve) => {
    resumeCleanup = resolve;
  });
  let cleanupStarted: (() => void) | undefined;
  const sawCleanup = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  let pauseCleanup = true;
  const repo = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return miningState;
      return wager;
    },
    transactState: async (path, updater) => {
      if (path === "reservations/host") {
        if (pauseCleanup) {
          cleanupStarted?.();
          await cleanupGate;
          pauseCleanup = false;
        }
        const result = applyMiningTransaction(updater, miningState);
        if (result.committed) miningState = result.value;
        return result;
      }
      const result = applyTransaction(updater, wager);
      if (result.committed) wager = result.value;
      return result;
    },
  });
  const changed = sendWagerProposal(
    identity,
    {
      inviteId: "invite",
      matchId: "match",
      material: "dust",
      count: 1,
    },
    repo,
  );
  await sawCleanup;
  let resumeRetry: (() => void) | undefined;
  const retryGate = new Promise<void>((resolve) => {
    resumeRetry = resolve;
  });
  let retryStarted: (() => void) | undefined;
  const sawRetry = new Promise<void>((resolve) => {
    retryStarted = resolve;
  });
  const competing = sendWagerProposal(
    identity,
    {
      inviteId: "invite",
      matchId: "match",
      material: "dust",
      count: 3,
    },
    repo,
    {
      wait: async () => {
        retryStarted?.();
        await retryGate;
      },
    },
  );
  await sawRetry;
  resumeCleanup?.();
  assert.deepEqual(await changed, { ok: true, count: 1 });
  resumeRetry?.();
  assert.deepEqual(await competing, {
    ok: false,
    reason: "proposal-unavailable",
  });
  assert.equal(materialsOnly(miningState).dust, 1);
});

test("replay fences a reservation against a delayed cleanup commit", async () => {
  const reservationOperationId = await createWagerReservationOperationId(
    "send",
    "invite",
    "match",
    "host",
  );
  let wager: unknown = null;
  let miningState: unknown = {
    frozen: { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 },
    operations: {
      [reservationOperationId]: {
        appliedAtMs: 1,
        count: 3,
        deltas: { dust: 3 },
        fingerprint: JSON.stringify(["send-reserve", "dust", 3, 0, 0, 0, 0, 0]),
      },
    },
  };
  let miningRevision = 0;
  let delayedCleanup: { expectedRevision: number; value: unknown } | undefined;
  let delayNextMiningCommit = true;
  const repo = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return miningState;
      return wager;
    },
    transactState: async (path, updater) => {
      if (path === "reservations/host") {
        const result = applyMiningTransaction(updater, miningState);
        if (delayNextMiningCommit) {
          delayNextMiningCommit = false;
          delayedCleanup = {
            expectedRevision: miningRevision,
            value: result.value,
          };
          throw new Error("ambiguous-cleanup");
        }
        if (result.committed) {
          miningState = result.value;
          miningRevision += 1;
        }
        return result;
      }
      const result = applyTransaction(updater, wager);
      if (result.committed) wager = result.value;
      return result;
    },
  });

  await assert.rejects(
    sendWagerProposal(
      identity,
      {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 1,
      },
      repo,
      { now: () => 100 },
    ),
    /ambiguous-cleanup/,
  );

  assert.deepEqual(
    await sendWagerProposal(
      identity,
      {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 3,
      },
      repo,
      { now: () => 100 },
    ),
    { ok: true, count: 3 },
  );

  assert.ok(delayedCleanup);
  const delayedCleanupCommitted =
    miningRevision === delayedCleanup.expectedRevision;
  if (delayedCleanupCommitted) {
    miningState = delayedCleanup.value;
    miningRevision += 1;
  }
  assert.equal(delayedCleanupCommitted, false);
  assert.equal(materialsOnly(miningState).dust, 3);
  assert.ok(
    (
      (miningState as Record<string, unknown>).operations as Record<
        string,
        unknown
      >
    )[reservationOperationId],
  );
  assert.equal(
    (wager as { proposals: Record<string, Record<string, unknown>> }).proposals
      .host.reservationOperationId,
    reservationOperationId,
  );
});

test("ambiguous replay accepts a newer exact reservation fence", async () => {
  const reservationOperationId = await createWagerReservationOperationId(
    "send",
    "invite",
    "match",
    "host",
  );
  let wager: unknown = null;
  let miningState: unknown = {
    frozen: { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
    operations: {
      [reservationOperationId]: {
        appliedAtMs: 1,
        count: 1,
        deltas: { dust: 1 },
        fingerprint: JSON.stringify(["send-reserve", "dust", 1, 0, 0, 0, 0, 0]),
      },
    },
  };
  let loseReplayResponse = true;
  const repo = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return miningState;
      return wager;
    },
    transactState: async (path, updater) => {
      if (path === "reservations/host") {
        const result = applyMiningTransaction(updater, miningState);
        if (result.committed) miningState = result.value;
        if (loseReplayResponse) {
          loseReplayResponse = false;
          const operations = (miningState as Record<string, unknown>)
            .operations as Record<string, Record<string, unknown>> | undefined;
          assert.ok(operations?.[reservationOperationId]);
          operations[reservationOperationId].appliedAtMs =
            Number(operations[reservationOperationId].appliedAtMs) + 1;
          throw new Error("ambiguous-replay");
        }
        return result;
      }
      const result = applyTransaction(updater, wager);
      if (result.committed) wager = result.value;
      return result;
    },
  });

  assert.deepEqual(
    await sendWagerProposal(
      identity,
      {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 1,
      },
      repo,
      { now: () => 100 },
    ),
    { ok: true, count: 1 },
  );
  assert.equal(materialsOnly(miningState).dust, 1);
  assert.equal(
    (wager as { proposals: Record<string, Record<string, unknown>> }).proposals
      .host.reservationOperationId,
    reservationOperationId,
  );
});

test("expired wager holder cannot clean up after a lease takeover", async () => {
  const reservationOperationId = await createWagerReservationOperationId(
    "send",
    "invite",
    "match",
    "host",
  );
  let nowMs = 0;
  let wager: unknown = null;
  const mining: Record<string, unknown> = {
    host: {
      frozen: { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 },
      operations: {
        [reservationOperationId]: {
          appliedAtMs: 1,
          count: 3,
          deltas: { dust: 3 },
          fingerprint: JSON.stringify([
            "send-reserve",
            "dust",
            3,
            0,
            0,
            0,
            0,
            0,
          ]),
        },
      },
    },
    guest: {
      frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
    },
  };
  let resumeStaleRead: (() => void) | undefined;
  const staleReadGate = new Promise<void>((resolve) => {
    resumeStaleRead = resolve;
  });
  let staleReadStarted: (() => void) | undefined;
  const sawStaleRead = new Promise<void>((resolve) => {
    staleReadStarted = resolve;
  });
  let pauseStaleRead = true;
  const repo = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "invites/invite/wagers/match") {
        if (pauseStaleRead) {
          pauseStaleRead = false;
          const snapshot = structuredClone(wager);
          staleReadStarted?.();
          await staleReadGate;
          return snapshot;
        }
        return wager;
      }
      const uid = path.split("/")[1] === "host" ? "host" : "guest";
      return mining[uid];
    },
    transactState: async (path, updater) => {
      if (path === "invites/invite/wagers/match") {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value;
        return result;
      }
      const uid = path.split("/")[1] === "host" ? "host" : "guest";
      const result = applyMiningTransaction(updater, mining[uid]);
      if (result.committed) mining[uid] = result.value;
      return result;
    },
  });
  const stale = sendWagerProposal(
    identity,
    {
      inviteId: "invite",
      matchId: "match",
      material: "dust",
      count: 1,
    },
    repo,
    { now: () => nowMs },
  );
  await sawStaleRead;
  nowMs = 60_001;
  assert.deepEqual(
    await sendWagerProposal(
      { uid: "guest" },
      {
        inviteId: "invite",
        matchId: "match",
        material: "slime",
        count: 1,
      },
      repo,
      { now: () => nowMs },
    ),
    { ok: true, count: 1 },
  );
  resumeStaleRead?.();
  await assert.rejects(stale, /invite-lease-lost/);
  assert.equal(materialsOnly(mining.host).dust, 3);
  assert.equal(
    (
      (mining.host as Record<string, unknown>).operations as Record<
        string,
        unknown
      >
    )[reservationOperationId] !== undefined,
    true,
  );
  const guestProposal = (wager as { proposals: Record<string, unknown> })
    .proposals.guest as Record<string, unknown>;
  assert.equal(guestProposal.material, "slime");
  assert.equal(guestProposal.count, 1);
  assert.equal(typeof guestProposal.reservationOperationId, "string");
});

test("timed out wager phase cannot commit after a lease takeover", async () => {
  let nowMs = 0;
  let wager: unknown = null;
  const mining: Record<string, unknown> = {
    host: { frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 } },
    guest: { frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 } },
  };
  const phaseController = new AbortController();
  let phaseStarted: (() => void) | undefined;
  const sawPhase = new Promise<void>((resolve) => {
    phaseStarted = resolve;
  });
  let recoveryStarted: (() => void) | undefined;
  const sawRecovery = new Promise<void>((resolve) => {
    recoveryStarted = resolve;
  });
  let resumeRecovery: (() => void) | undefined;
  const recoveryGate = new Promise<void>((resolve) => {
    resumeRecovery = resolve;
  });
  let pauseRecovery = false;
  let stallPhase = true;
  const repo = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "invites/invite/wagers/match") {
        if (pauseRecovery) {
          pauseRecovery = false;
          const snapshot = structuredClone(wager);
          recoveryStarted?.();
          await recoveryGate;
          return snapshot;
        }
        return wager;
      }
      const uid = path.split("/")[1] === "host" ? "host" : "guest";
      return mining[uid];
    },
    transactState: async (path, updater, signal) => {
      if (path === "invites/invite/wagers/match") {
        if (stallPhase) {
          stallPhase = false;
          assert.equal(signal, phaseController.signal);
          pauseRecovery = true;
          phaseStarted?.();
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value;
        return result;
      }
      const uid = path.split("/")[1] === "host" ? "host" : "guest";
      const result = applyMiningTransaction(updater, mining[uid]);
      if (result.committed) mining[uid] = result.value;
      return result;
    },
  });
  const stale = sendWagerProposal(
    identity,
    {
      inviteId: "invite",
      matchId: "match",
      material: "dust",
      count: 1,
    },
    repo,
    {
      createCriticalPhaseSignal: () => phaseController.signal,
      now: () => nowMs,
    },
  );
  await sawPhase;
  nowMs = 30_000;
  phaseController.abort(new DOMException("phase-timeout", "TimeoutError"));
  await sawRecovery;
  nowMs = 60_001;
  assert.deepEqual(
    await sendWagerProposal(
      { uid: "guest" },
      {
        inviteId: "invite",
        matchId: "match",
        material: "slime",
        count: 1,
      },
      repo,
      { now: () => nowMs },
    ),
    { ok: true, count: 1 },
  );
  resumeRecovery?.();
  await assert.rejects(stale, /invite-lease-lost/);
  assert.equal(materialsOnly(mining.host).dust, 1);
  const proposals = (wager as { proposals: Record<string, unknown> }).proposals;
  assert.equal(proposals.host, undefined);
  assert.equal((proposals.guest as Record<string, unknown>).material, "slime");
});

test("releases a stranded accept reservation after participants merge", async () => {
  let merged = false;
  let failReplayRead = true;
  let ownershipReads = 0;
  let wagerReads = 0;
  let wagerTransactions = 0;
  let miningState: unknown = {
    frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  };
  const guestProposal = await modernProposal("guest", "dust", 2);
  const guestMining = installSendReservation(
    { frozen: { dust: 2, slime: 0, gum: 0, metal: 0, ice: 0 } },
    guestProposal,
  );
  const wager = {
    proposals: {
      guest: guestProposal,
    },
  };
  const value = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return miningState;
      if (path === "reservations/guest") return guestMining;
      if (path === "invites/invite/wagers/match") {
        wagerReads++;
        if (failReplayRead && wagerReads > 1) {
          throw new Error("wager-read-unavailable");
        }
        return wager;
      }
      return null;
    },
    readProfileOwnershipSnapshot: async (query) => {
      ownershipReads++;
      return ownershipSnapshot(query, (uid) =>
        merged ? "shared-profile" : `profile-${uid}`,
      );
    },
    transactState: async (path, updater) => {
      if (path === "reservations/host") {
        const transaction = applyMiningTransaction(updater, miningState);
        if (transaction.committed) miningState = transaction.value;
        return transaction;
      }
      wagerTransactions++;
      throw new Error("wager-write-unavailable");
    },
  });
  const input = { inviteId: "invite", matchId: "match" };

  await assert.rejects(() => acceptWagerProposal(identity, input, value));
  assert.equal(materialsOnly(miningState).dust, 2);

  merged = true;
  failReplayRead = false;
  assert.deepEqual(await acceptWagerProposal(identity, input, value), {
    ok: false,
    reason: "proposal-unavailable",
  });
  assert.equal(materialsOnly(miningState).dust, 0);
  assert.deepEqual(await acceptWagerProposal(identity, input, value), {
    ok: false,
    reason: "proposal-unavailable",
  });
  assert.equal(materialsOnly(miningState).dust, 0);
  assert.equal(ownershipReads, 3);
  assert.equal(wagerTransactions, 1);
});

test("ownership failure stops a wager before reservations", async () => {
  let transactions = 0;
  const value = repository({
    readProfileOwnershipSnapshot: async () => {
      throw new Error("d1-unavailable");
    },
    transactState: async () => {
      transactions++;
      return { committed: false, value: null };
    },
  });
  await assert.rejects(
    () =>
      sendWagerProposal(
        identity,
        {
          inviteId: "invite",
          matchId: "match",
          material: "dust",
          count: 1,
        },
        value,
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "profile-ownership-unavailable",
  );
  assert.equal(transactions, 0);
});

test("cancel removes the caller proposal and releases only its materials", async () => {
  const transactions: Array<{ path: string; value: unknown }> = [];
  const hostProposal = await modernProposal("host", "dust", 3);
  const guestProposal = await modernProposal("guest", "ice", 2, 2);
  const mining = installSendReservation(
    { dust: 5, slime: 1, gum: 0, metal: 0, ice: 4 },
    hostProposal,
  );
  const result = await removeWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    "cancel",
    repository({
      readProfileOwnershipSnapshot: async () => {
        throw new Error("D1 should not be read for a direct participant");
      },
      transactState: async (path, updater) => {
        const current = path.startsWith("invites/")
          ? {
              proposals: {
                host: hostProposal,
                guest: guestProposal,
              },
              proposedBy: { host: true, guest: true },
            }
          : mining;
        const transaction = path.startsWith("reservations/")
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
    ["invites/invite/wagers/match", "reservations/host", "reservations/host"],
  );
  const wager = transactions[0].value as {
    proposals: Record<string, unknown>;
    proposedBy: Record<string, boolean>;
    proposalRemovalOperations: Record<string, unknown>;
  };
  assert.deepEqual(wager.proposals, {
    guest: guestProposal,
  });
  assert.deepEqual(wager.proposedBy, { host: true, guest: true });
  assert.equal(Object.keys(wager.proposalRemovalOperations).length, 1);
  assert.deepEqual(materialsOnly(transactions[2].value), {
    dust: 2,
    slime: 1,
    gum: 0,
    metal: 0,
    ice: 4,
  });
});

test("decline removes the opponent proposal and clamps frozen counts", async () => {
  const paths: string[] = [];
  const hostProposal = await modernProposal("host", "metal", 9);
  const mining = installSendReservation(
    { dust: 0, slime: 0, gum: 0, metal: 2, ice: 0 },
    hostProposal,
  );
  const result = await removeWagerProposal(
    { ...identity, uid: "guest" },
    { inviteId: "invite", matchId: "match" },
    "decline",
    repository({
      transactState: async (path, updater) => {
        paths.push(path);
        return applyTransaction(
          updater,
          path.startsWith("invites/")
            ? { proposals: { host: hostProposal } }
            : mining,
        );
      },
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(paths, [
    "invites/invite/wagers/match",
    "reservations/host",
    "reservations/host",
  ]);
});

test("canonical D1 ownership authorizes linked logins with host precedence", async () => {
  const paths: string[] = [];
  let ownershipReads = 0;
  const hostProposal = await modernProposal("host", "dust", 1);
  const mining = installSendReservation(
    { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
    hostProposal,
  );
  const result = await removeWagerProposal(
    { uid: "linked-login" },
    { inviteId: "invite", matchId: "match" },
    "cancel",
    repository({
      readProfileOwnershipSnapshot: async (query) => {
        ownershipReads++;
        assert.deepEqual(query.loginUids, ["linked-login", "host", "guest"]);
        return ownershipSnapshot(query, (uid) =>
          uid === "linked-login" || uid === "host"
            ? "shared-profile"
            : "guest-profile",
        );
      },
      transactState: async (path, updater) => {
        paths.push(path);
        return applyTransaction(
          updater,
          path.startsWith("invites/")
            ? { proposals: { host: hostProposal } }
            : mining,
        );
      },
    }),
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(ownershipReads, 2);
  assert.deepEqual(paths.slice(1), ["reservations/host", "reservations/host"]);
});

test("cancellation rejects cross-match reservation IDs", async () => {
  const otherProposal = await modernProposal(
    "host",
    "dust",
    1,
    1,
    "invite",
    "other",
  );
  const currentReservationOperationId = await createWagerReservationOperationId(
    "send",
    "invite",
    "match",
    "host",
  );
  let domainTransactions = 0;
  await assert.rejects(
    removeWagerProposal(
      identity,
      { inviteId: "invite", matchId: "match" },
      "cancel",
      repository({
        readState: async (path) => {
          if (path === "invites/invite") {
            return { hostId: "host", guestId: "guest" };
          }
          if (path === "reservations/host") {
            return installSendReservation(
              { frozen: { ...createEmptyMaterials(), dust: 1 } },
              otherProposal,
            );
          }
          return { proposals: { host: otherProposal } };
        },
        transactState: async () => {
          domainTransactions += 1;
          return { committed: false, value: null };
        },
      }),
    ),
    /wager-removal-operation-invalid/,
  );
  assert.notEqual(
    otherProposal.reservationOperationId,
    currentReservationOperationId,
  );
  assert.equal(domainTransactions, 0);
});

test("cancellation rejects a cross-match replay receipt", async () => {
  const removalOperationId = await createOperationId(
    "cancel",
    "invite",
    "match",
    "host",
  );
  const otherReservationOperationId = await createWagerReservationOperationId(
    "send",
    "invite",
    "other",
    "host",
  );
  const wager = {
    proposalRemovalOperations: {
      [removalOperationId]: {
        proposalOperationId: "a".repeat(64),
        reservationOperationId: otherReservationOperationId,
      },
    },
  };
  let playerTransactions = 0;
  await assert.rejects(
    removeWagerProposal(
      identity,
      { inviteId: "invite", matchId: "match" },
      "cancel",
      repository({
        readState: async (path) =>
          path === "invites/invite"
            ? { hostId: "host", guestId: "guest" }
            : wager,
        transactState: async (path, updater) => {
          if (path.startsWith("reservations/")) playerTransactions += 1;
          return applyTransaction(updater, wager);
        },
      }),
    ),
    /wager-removal-operation-invalid/,
  );
  assert.equal(playerTransactions, 0);
});

test("returns exact domain outcomes without debug data", async () => {
  const cases: Array<{
    repo: Partial<GameplayRepository>;
    expected: unknown;
  }> = [
    {
      repo: { readState: async () => null },
      expected: { ok: false, reason: "invite-not-found" },
    },
    {
      repo: { readState: async () => ({ hostId: "host" }) },
      expected: { ok: false, reason: "missing-opponent" },
    },
    {
      repo: {},
      expected: { ok: false, reason: "proposal-missing" },
    },
    {
      repo: {
        transactState: async (_path, updater) =>
          applyTransaction(updater, { agreed: { count: 1 }, proposals: {} }),
      },
      expected: { ok: false, reason: "proposal-missing" },
    },
    {
      repo: {
        transactState: async (_path, updater) =>
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
      readState: async () => ({ hostId: "host", guestId: "guest" }),
      transactState: async (_path, updater) => {
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

test("cancellation returns missing while settlement consumes a proposal", async () => {
  const hostProposal = await modernProposal("host", "dust", 1);
  const wager = {
    proposals: { host: hostProposal },
    settlement: { version: 2, state: "pending" },
  };
  let playerTransactions = 0;
  const result = await removeWagerProposal(
    identity,
    { inviteId: "invite", matchId: "match" },
    "cancel",
    repository({
      readState: async (path) => {
        if (path === "invites/invite") {
          return { hostId: "host", guestId: "guest" };
        }
        if (path === "reservations/host") {
          return {
            frozen: createEmptyMaterials(),
            operations: {
              [hostProposal.reservationOperationId]: { consumed: true },
            },
          };
        }
        return wager;
      },
      transactState: async (path, updater) => {
        if (path.startsWith("reservations/")) playerTransactions += 1;
        return applyTransaction(updater, wager);
      },
    }),
  );
  assert.deepEqual(result, { ok: false, reason: "proposal-missing" });
  assert.equal(playerTransactions, 0);
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
    readState: async (path) => {
      if (path === "invites/invite")
        return { hostId: "host", guestId: "guest" };
      if (path.startsWith("reservations/")) return frozen;
      return wager;
    },
    transactState: async (path, updater) => {
      if (path.startsWith("reservations/")) {
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
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") {
        return mining;
      }
      return wagers.get(path.split("/").at(-1) || "") || null;
    },
    transactState: async (path, updater) => {
      if (path === "reservations/host") {
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
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return frozen.host;
      if (path === "reservations/guest") return frozen.guest;
      return wager;
    },
    transactState: async (path, updater) => {
      if (path.startsWith("invites/")) {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value;
        return result;
      }
      const uid = path.split("/")[1] === "host" ? "host" : "guest";
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

test("cancel retry preserves a later accepted reservation", async () => {
  const sendReservationOperationId = await createWagerReservationOperationId(
    "send",
    "invite",
    "match",
    "host",
  );
  const acceptReservationOperationId = await createWagerReservationOperationId(
    "accept",
    "invite",
    "match",
    "host",
  );
  const hostProposal = await modernProposal("host", "ice", 2);
  const guestProposal = await modernProposal("guest", "dust", 2);
  assert.equal(hostProposal.reservationOperationId, sendReservationOperationId);
  let wager: Record<string, unknown> = {
    proposals: {
      host: hostProposal,
      guest: guestProposal,
    },
  };
  const frozen: Record<string, unknown> = {
    host: {
      frozen: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 2 },
      operations: {
        [sendReservationOperationId]: {
          appliedAtMs: 1,
          count: 2,
          deltas: { ice: 2 },
          fingerprint: JSON.stringify([
            "send-reserve",
            "ice",
            2,
            0,
            0,
            0,
            0,
            0,
          ]),
        },
      },
    },
    guest: installSendReservation(
      { frozen: { dust: 2, slime: 0, gum: 0, metal: 0, ice: 0 } },
      guestProposal,
    ),
  };
  let failRelease = true;
  const repo = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return frozen.host;
      if (path === "reservations/guest") return frozen.guest;
      return structuredClone(wager);
    },
    transactState: async (path, updater) => {
      if (path === "invites/invite/wagers/match") {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value as Record<string, unknown>;
        return result;
      }
      const uid = path.split("/")[1] === "host" ? "host" : "guest";
      if (path === "reservations/host" && failRelease) {
        const preview = applyMiningTransaction(updater, frozen[uid]);
        if (preview.committed) {
          failRelease = false;
          throw new Error("release-unavailable");
        }
        return preview;
      }
      const result = applyMiningTransaction(updater, frozen[uid]);
      if (result.committed) frozen[uid] = result.value;
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
    await acceptWagerProposal(identity, request, repo, { now: () => 2 }),
    { ok: true, count: 2 },
  );
  assert.deepEqual(
    await removeWagerProposal(identity, request, "cancel", repo),
    { ok: true },
  );

  const agreementOperation = wager.agreementOperation as Record<
    string,
    unknown
  >;
  assert.equal(agreementOperation.reservationLineageReady, true);
  assert.deepEqual(agreementOperation.accepterReservationOperationIds, [
    acceptReservationOperationId,
  ]);
  const operations = (frozen.host as Record<string, unknown>)
    .operations as Record<string, unknown>;
  assert.ok(operations[acceptReservationOperationId]);
  assert.equal(operations[sendReservationOperationId], undefined);
  assert.deepEqual(materialsOnly(frozen.host), {
    dust: 2,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  });
  assert.equal(
    await consumeWagerReservationOperation(
      repo,
      "host",
      acceptReservationOperationId,
      true,
    ),
    "released",
  );
  assert.deepEqual(materialsOnly(frozen.host), {
    dust: 0,
    slime: 0,
    gum: 0,
    metal: 0,
    ice: 0,
  });
});

test("cancellation retries a failed material release from its durable record", async () => {
  const hostProposal = await modernProposal("host", "dust", 2);
  let wager: unknown = {
    proposals: { host: hostProposal },
  };
  let frozen: unknown = installSendReservation(
    { dust: 2, slime: 0, gum: 0, metal: 0, ice: 0 },
    hostProposal,
  );
  let failRelease = true;
  const repo = repository({
    readState: async (path) => {
      if (path === "invites/invite") {
        return { hostId: "host", guestId: "guest" };
      }
      if (path === "reservations/host") return frozen;
      return wager;
    },
    transactState: async (path, updater) => {
      if (path.startsWith("invites/")) {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value;
        return result;
      }
      const result = applyMiningTransaction(updater, frozen);
      if (failRelease && result.committed) {
        failRelease = false;
        throw new Error("release-unavailable");
      }
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
  const guestProposal = await modernProposal("guest", "dust", 4);
  let wager: unknown = {
    proposals: { guest: guestProposal },
  };
  const frozen: Record<string, unknown> = {
    host: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
    guest: installSendReservation(
      { dust: 4, slime: 0, gum: 0, metal: 0, ice: 0 },
      guestProposal,
    ),
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
    readState: async (path) => {
      if (path === "invites/invite")
        return { hostId: "host", guestId: "guest" };
      if (path.startsWith("reservations/")) {
        return frozen[path.split("/")[1] === "host" ? "host" : "guest"];
      }
      return wager;
    },
    transactState: async (path, updater) => {
      if (path.startsWith("invites/")) {
        const result = applyTransaction(updater, wager);
        if (result.committed) wager = result.value;
        return result;
      }
      const uid = path.split("/")[1] === "host" ? "host" : "guest";
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
  const outsiderPaths: string[] = [];
  await assert.rejects(
    () =>
      removeWagerProposal(
        { uid: "other" },
        { inviteId: "invite", matchId: "match" },
        "cancel",
        repository({
          transactState: async (path) => {
            outsiderPaths.push(path);
            return { committed: false, value: null };
          },
        }),
      ),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 403,
  );
  assert.deepEqual(outsiderPaths, []);

  const logs: Array<Record<string, unknown>> = [];
  let transactions = 0;
  const hostProposal = await modernProposal("host", "dust", 1);
  const mining = installSendReservation(
    { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
    hostProposal,
  );
  let wager: unknown = { proposals: { host: hostProposal } };
  await assert.rejects(
    () =>
      removeWagerProposal(
        identity,
        { inviteId: "invite", matchId: "match" },
        "cancel",
        repository({
          readState: async (path) => {
            if (path === "invites/invite") {
              return { hostId: "host", guestId: "guest" };
            }
            if (path === "reservations/host") return mining;
            return wager;
          },
          transactState: async (path, updater) => {
            transactions++;
            if (transactions === 3) {
              throw new Error("private-upstream-detail");
            }
            if (path.startsWith("invites/")) {
              const result = applyTransaction(updater, wager);
              if (result.committed) wager = result.value;
              return result;
            }
            return applyMiningTransaction(updater, mining);
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
