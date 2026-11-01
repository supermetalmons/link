import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createWagerClientHarness,
  deferred,
  emptyMaterials,
  flush,
} from "./wagerClientHarness.mjs";

/** @typedef {import("@mons/shared/invite-wagers").PublicMatchWagerState} PublicState */
/** @param {number} [count] @param {import("@mons/shared/mining").MiningMaterialName} [material] @returns {import("@mons/shared/invite-wagers").PublicWagerProposal} */
const proposal = (count = 3, material = "dust") => ({
  material,
  count,
  createdAt: 10,
});
const ownProposal = {
  proposals: { actor: proposal() },
  proposedBy: { actor: true },
};
const opponentProposal = {
  proposals: { opponent: proposal() },
  proposedBy: { opponent: true },
};

/**
 * @param {test.TestContext} t
 * @param {Partial<PublicState> | null} [state]
 * @param {Partial<typeof emptyMaterials>} [frozen]
 */
function harness(t, state = null, frozen = {}) {
  const h = createWagerClientHarness();
  h.dependencies.api.readWagerFrozenViaApi = async ({ playerUid }) => ({
    ok: true,
    playerUid,
    revision: 1,
    frozen: { ...emptyMaterials, ...frozen },
  });
  h.observe(
    state
      ? {
          finished: {
            schemaVersion: 1,
            state: "proposed",
            proposals: {},
            proposedBy: Object.fromEntries(
              Object.keys(state.proposals ?? {}).map((actor) => [actor, true]),
            ),
            agreed: null,
            resolved: null,
            blocked: null,
            ...state,
          },
        }
      : {},
  );
  if (state) {
    /** @type {import("../src/connection/wagerClient.ts").WagerClient["setLocalWagerState"]} */
    const seedLocalState = Reflect.get(h.client, "setLocalWagerState").bind(
      h.client,
    );
    seedLocalState(state);
  }
  h.client.observeMiningFrozen("actor");
  t.after(h.stop);
  return h;
}

test("sending clamps the optimistic amount and applies the confirmed count", async (t) => {
  const h = harness(t);
  /** @type {PromiseWithResolvers<import("@mons/shared/wagers").WagerProposalSendResponse>} */
  const pending = deferred();
  /** @type {(import("@mons/shared/wagers").WagerProposalSendRequest)[]} */
  const requests = [];
  h.dependencies.api.sendWagerProposalViaApi = async (request) => {
    requests.push(request);
    return pending.promise;
  };
  const result = h.client.sendWagerProposal("dust", 20);
  await flush();
  assert.equal(
    required(
      required(required(h.dependencies.wagerStore.getWagerState()).proposals)
        .actor,
    ).count,
    8,
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 8);
  assert.equal(h.client.hasConfirmedSnapshot(), false);
  assert.deepEqual(requests, [
    { inviteId: "invite", matchId: "finished", material: "dust", count: 20 },
  ]);
  pending.resolve({ ok: true, count: 5 });
  assert.deepEqual(await result, { ok: true, count: 5 });
  assert.equal(
    required(
      required(required(h.dependencies.wagerStore.getWagerState()).proposals)
        .actor,
    ).count,
    5,
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 5);
  assert.equal(required(h.events.channels[0]).refreshes, 1);
});

test("a send that agrees with the opponent publishes the agreement and corrected reservation", async (t) => {
  const h = harness(t, opponentProposal);
  /** @type {import("@mons/shared/wagers").WagerAgreement} */
  const agreement = {
    material: "dust",
    count: 2,
    total: 4,
    proposerId: "opponent",
    accepterId: "actor",
    acceptedAt: 200,
  };
  h.dependencies.api.sendWagerProposalViaApi = async () => ({
    ok: true,
    count: 2,
    agreed: agreement,
  });
  await h.client.sendWagerProposal("dust", 4);
  assert.deepEqual(
    required(h.dependencies.wagerStore.getWagerState()).agreed,
    agreement,
  );
  assert.equal(
    required(h.dependencies.wagerStore.getWagerState()).proposals,
    undefined,
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 2);
});

for (const rejected of [false, true]) {
  test(`a ${rejected ? "rejected" : "refused"} proposal restores state and reservation`, async (t) => {
    const h = harness(t);
    /** @type {PromiseWithResolvers<import("@mons/shared/wagers").WagerProposalSendResponse>} */
    const pending = deferred();
    h.dependencies.api.sendWagerProposalViaApi = () => pending.promise;
    const result = h.client.sendWagerProposal("dust", 3);
    const failure = rejected ? assert.rejects(result, /reload-required/) : null;
    await flush();
    assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 3);
    if (rejected)
      pending.reject(
        Object.assign(new Error("reload-required"), {
          code: "client-update-required",
        }),
      );
    else pending.resolve({ ok: false, reason: "invite-not-found" });
    if (failure) await failure;
    else
      assert.deepEqual(await result, { ok: false, reason: "invite-not-found" });
    assert.equal(h.dependencies.wagerStore.getWagerState(), null);
    assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 0);
    assert.equal(h.events.banners.length, rejected ? 1 : 0);
    assert.equal(required(h.events.channels[0]).refreshes, 1);
  });
}

test("cancel releases the owner's reservation and restores it after refusal", async (t) => {
  const h = harness(t, ownProposal, { dust: 3 });
  h.dependencies.materialStore.setFrozenMaterials(
    { ...emptyMaterials, dust: 3 },
    "ready",
  );
  /** @type {PromiseWithResolvers<import("@mons/shared/wagers").WagerProposalRemovalResponse>} */
  const pending = deferred();
  h.dependencies.api.cancelWagerProposalViaApi = () => pending.promise;
  const result = h.client.cancelWagerProposal();
  await flush();
  assert.equal(
    required(h.dependencies.wagerStore.getWagerState()).proposals,
    undefined,
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 0);
  pending.resolve({ ok: false, reason: "invite-not-found" });
  await result;
  assert.deepEqual(
    required(h.dependencies.wagerStore.getWagerState()).proposals,
    ownProposal.proposals,
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 3);
});

test("declining only removes the opponent proposal and never changes the owner's reservations", async (t) => {
  const state = { proposals: { actor: proposal(2), opponent: proposal(3) } };
  const h = harness(t, state, { dust: 2 });
  h.dependencies.materialStore.setFrozenMaterials(
    { ...emptyMaterials, dust: 2 },
    "ready",
  );
  await h.client.declineWagerProposal();
  assert.deepEqual(
    required(h.dependencies.wagerStore.getWagerState()).proposals,
    {
      actor: proposal(2),
    },
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 2);
});

test("accepting replaces a prior reservation and applies a smaller confirmed amount", async (t) => {
  const state = {
    proposals: { actor: proposal(2, "slime"), opponent: proposal(5) },
  };
  const h = harness(t, state, { slime: 2 });
  /** @type {PromiseWithResolvers<import("@mons/shared/wagers").WagerProposalAcceptResponse>} */
  const pending = deferred();
  h.dependencies.api.acceptWagerProposalViaApi = () => pending.promise;
  const result = h.client.acceptWagerProposal();
  await flush();
  assert.equal(
    required(required(h.dependencies.wagerStore.getWagerState()).agreed).count,
    5,
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().slime, 0);
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 5);
  pending.resolve({ ok: true, count: 3 });
  await result;
  assert.equal(
    required(required(h.dependencies.wagerStore.getWagerState()).agreed).count,
    3,
  );
  assert.equal(
    required(required(h.dependencies.wagerStore.getWagerState()).agreed).total,
    6,
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 3);
});

test("refused acceptance restores both proposals and their prior frozen balance", async (t) => {
  const state = { proposals: { actor: proposal(2), opponent: proposal(5) } };
  const h = harness(t, state, { dust: 2 });
  h.dependencies.api.acceptWagerProposalViaApi = async () => ({
    ok: false,
    reason: "invite-not-found",
  });
  await h.client.acceptWagerProposal();
  assert.deepEqual(
    required(h.dependencies.wagerStore.getWagerState()).proposals,
    state.proposals,
  );
  assert.equal(
    required(h.dependencies.wagerStore.getWagerState()).agreed,
    undefined,
  );
  assert.equal(h.dependencies.materialStore.getFrozenMaterials().dust, 2);
});

test("failed commands cannot roll back a settlement published while they were pending", async (t) => {
  const h = harness(t, opponentProposal);
  /** @type {PromiseWithResolvers<import("@mons/shared/wagers").WagerProposalAcceptResponse>} */
  const pending = deferred();
  h.dependencies.api.acceptWagerProposalViaApi = () => pending.promise;
  const acceptance = h.client.acceptWagerProposal();
  await flush();
  h.dependencies.api.resolveWagerOutcomeViaApi = async () => ({
    ok: true,
    mining: null,
  });
  const settlement = await h.client.resolveWagerOutcome(true);
  assert.equal(settlement.ok, true);
  const settled = h.dependencies.wagerStore.getWagerState();
  pending.resolve({ ok: false, reason: "invite-not-found" });
  await acceptance;
  assert.equal(h.dependencies.wagerStore.getWagerState(), settled);
});

test("a queued proposal cannot execute after the match context changes", async (t) => {
  const h = harness(t, opponentProposal);
  /** @type {PromiseWithResolvers<import("@mons/shared/wagers").WagerProposalSendResponse>} */
  const pending = deferred();
  let accepts = 0;
  h.dependencies.api.sendWagerProposalViaApi = () => pending.promise;
  h.dependencies.api.acceptWagerProposalViaApi = async () => {
    accepts++;
    return { ok: true, count: 3 };
  };
  const first = h.client.sendWagerProposal("dust", 3);
  await flush();
  const second = h.client.acceptWagerProposal();
  h.session.activeContext = {
    ...required(h.session.activeContext),
    contextId: 2,
    matchId: "rematch",
  };
  h.client.bindContext(required(h.session.activeContext));
  h.client.updateWagerStateForCurrentMatch();
  pending.resolve({ ok: true, count: 3 });
  assert.deepEqual(await first, { ok: false });
  assert.deepEqual(await second, { ok: false });
  assert.equal(accepts, 0);
  assert.equal(h.dependencies.wagerStore.getWagerState(), null);
});

test("unknown wager snapshots prevent public commands even with an actor and balance poller", async (t) => {
  const h = createWagerClientHarness();
  t.after(h.stop);
  h.client.observeMiningFrozen("actor");
  h.dependencies.api.sendWagerProposalViaApi = () =>
    assert.fail("sent without a snapshot");
  assert.deepEqual(await h.client.sendWagerProposal("dust", 3), { ok: false });
});

test("actor cleanup aborts a pending balance read and releases poller listeners exactly once", async (t) => {
  let listeners = 0;
  const listen = () => {
    listeners++;
    return () => {
      listeners--;
    };
  };
  const h = createWagerClientHarness({
    addVisibilityListener: listen,
    addOnlineListener: listen,
  });
  t.after(h.stop);
  /** @type {PromiseWithResolvers<import("@mons/shared/wagers").WagerFrozenReadResponse>} */
  const pending = deferred();
  /** @type {{ value?: (AbortSignal | undefined) }} */
  const signal = {};
  h.dependencies.api.readWagerFrozenViaApi = (_request, _provider, options) => {
    signal.value = required(options).signal;
    return pending.promise;
  };
  h.dependencies.api.sendWagerProposalViaApi = () =>
    assert.fail("sent after actor cleanup");
  h.observe();
  h.client.observeMiningFrozen("actor");
  const result = h.client.sendWagerProposal("dust", 3);
  await flush();
  assert.equal(listeners, 2);
  h.session.actorUid = null;
  h.client.resetProfile();
  h.client.resetProfile();
  assert.equal(required(signal.value).aborted, true);
  assert.equal(listeners, 0);
  pending.resolve({
    ok: true,
    playerUid: "actor",
    revision: 1,
    frozen: emptyMaterials,
  });
  assert.deepEqual(await result, { ok: false });
  assert.equal(h.dependencies.materialStore.getFrozenMaterialsStatus(), "idle");
  assert.equal(h.events.observers, 1);
});

test("manual-review wagers keep their holds and never start optimistic mutations or settlement", async (t) => {
  /** @type {PublicState} */
  const blocked = {
    schemaVersion: 1,
    state: "blocked",
    proposals: {},
    proposedBy: {},
    agreed: null,
    resolved: null,
    blocked: {
      reason: "legacy-agreement-unsettled",
      requiresManualReview: true,
    },
  };
  const h = harness(t, blocked, { dust: 3 });
  await flush();
  const beforeState = structuredClone(
    h.dependencies.wagerStore.getWagerState(),
  );
  const beforeFrozen = h.dependencies.materialStore.getFrozenMaterials();
  for (const method of /** @type {const} */ ([
    "sendWagerProposalViaApi",
    "acceptWagerProposalViaApi",
    "cancelWagerProposalViaApi",
    "declineWagerProposalViaApi",
    "resolveWagerOutcomeViaApi",
  ])) {
    h.dependencies.api[method] = async () =>
      assert.fail(`unexpected ${method}`);
  }
  for (const action of [
    () => h.client.sendWagerProposal("dust", 1),
    () => h.client.acceptWagerProposal(),
    () => h.client.cancelWagerProposal(),
    () => h.client.declineWagerProposal(),
    () => h.client.resolveWagerOutcome(true),
  ]) {
    assert.equal((await action()).ok, false);
  }
  assert.deepEqual(h.dependencies.wagerStore.getWagerState(), beforeState);
  assert.deepEqual(
    h.dependencies.materialStore.getFrozenMaterials(),
    beforeFrozen,
  );
  assert.equal(h.events.inventory.length, 0);
});
