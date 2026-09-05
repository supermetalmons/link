import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createUserBoundAuthTokenProvider } from "../src/services/authApi.ts";
import { FrozenMaterialsPoller } from "../src/connection/frozenMaterialsPoller.ts";
import {
  isWagerClientUpdateRequired,
  retryWagerApi,
} from "../src/connection/wagerApiRetry.ts";

const source = ts.createSourceFile(
  "connection.ts",
  readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const connectionClass = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
const names = new Set([
  "resolveWagerOutcome",
  "performResolveWagerOutcome",
  "runWagerMutation",
  "createWagerContextGuard",
  "createMatchContextGuard",
  "createSessionGuard",
  "beginMatchSessionTeardown",
  "bumpSessionEpoch",
  "getUserBoundAuthTokenProvider",
  "callWagerApiWithRetry",
]);
const methods = connectionClass.members
  .filter((node) => node.name && names.has(node.name.getText(source)))
  .map((node) => node.getText(source));
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`.replaceAll(
    "import.meta.env.DEV",
    "false",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const materials = { dust: 8, slime: 0, gum: 0, metal: 0, ice: 0 };
const response = { ok: true, mining: { materials, lastRockDate: null } };

function harness() {
  let profileId = "profile";
  const pending = deferred();
  const requests = [];
  const inventory = [];
  const optimistic = [];
  const restored = [];
  const banners = [];
  let instance;
  const dependencies = {
    createUserBoundAuthTokenProvider,
    retryWagerApi,
    isWagerClientUpdateRequired,
    storage: { getProfileId: () => profileId, getPlayerEmojiId: () => "1" },
    getWagerState: () => ({ agreed: { material: "dust", count: 3 } }),
    rocksMiningService: { setFromServer: (mining) => inventory.push(mining) },
    showNotificationBanner: (...args) => banners.push(args),
    console: { log() {}, error() {} },
    resolveWagerOutcomeViaApi: async (request, provider) => {
      await provider(false);
      provider.assertCurrentUser?.();
      requests.push(request);
      const value = await pending.promise;
      provider.assertCurrentUser?.();
      return value;
    },
  };
  const Constructor = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn Connection;`,
  )(...Object.values(dependencies));
  instance = Object.assign(new Constructor(), {
    activeContext: {
      contextId: 1,
      inviteId: "invite",
      matchId: "finished",
      loginUid: "login",
      actorUid: "actor",
      canWrite: true,
    },
    auth: { currentUser: { uid: "login", getIdToken: async () => "token" } },
    sameProfilePlayerUid: "actor",
    sessionEpoch: 1,
    ensureAuthenticated: async () => {},
    requireWritableContext: () => instance.activeContext,
    isSessionEpochActive: (epoch) => epoch === instance.sessionEpoch,
    getOpponentId: () => "opponent",
    cloneWagerState: (value) => structuredClone(value),
    applyOptimisticWagerResolution: () => {
      optimistic.push(instance.activeContext.matchId);
      return true;
    },
    restoreOptimisticWagerResolution: (matchId, _value, guard) =>
      restored.push({ matchId, current: guard() }),
    delay: async () => {},
  });
  const poller = new FrozenMaterialsPoller({
    playerUid: "actor",
    addVisibilityListener: () => () => {},
    addOnlineListener: () => () => {},
    clearTimer() {},
    isActive: () => true,
    isVisible: () => true,
    load: async () => ({
      ok: true,
      playerUid: "actor",
      revision: 1,
      frozen: materials,
    }),
    onPending() {},
    onSnapshot() {},
    onError() {},
    setTimer: () => 1,
  });
  let refreshes = 0;
  const refresh = poller.refresh.bind(poller);
  poller.refresh = () => {
    refreshes++;
    refresh();
  };
  instance.miningFrozenPoller = poller;
  return {
    instance,
    poller,
    pending,
    requests,
    inventory,
    optimistic,
    restored,
    banners,
    refreshes: () => refreshes,
    setProfile: (value) => {
      profileId = value;
    },
    rematch: () => {
      instance.activeContext = {
        ...instance.activeContext,
        contextId: 2,
        matchId: "rematch",
      };
    },
  };
}

test("a rematch cannot discard the finished match's settlement or inventory", async (t) => {
  const h = harness();
  t.after(() => h.poller.stop());
  const result = h.instance.resolveWagerOutcome(true);
  await flush();
  h.rematch();
  h.pending.resolve(response);
  assert.deepEqual(await result, response);
  assert.deepEqual(h.requests, [{ inviteId: "invite", matchId: "finished" }]);
  assert.deepEqual(h.inventory, [response.mining]);
  assert.deepEqual(h.optimistic, ["finished"]);
  assert.equal(h.refreshes(), 1);
});

test("settlement starts even while another wager mutation is pending", async (t) => {
  const h = harness();
  t.after(() => h.poller.stop());
  const prior = deferred();
  const mutation = h.poller.runMutation(() => prior.promise, {
    isCurrent: () => true,
  });
  await flush();
  const result = h.instance.resolveWagerOutcome(true);
  await flush();
  assert.equal(h.requests.length, 1);
  h.rematch();
  h.pending.resolve(response);
  assert.deepEqual(await result, response);
  assert.deepEqual(h.inventory, [response.mining]);
  prior.resolve();
  await mutation;
});

test("captures the finished match before authentication yields", async (t) => {
  const h = harness();
  t.after(() => h.poller.stop());
  const authentication = deferred();
  h.instance.ensureAuthenticated = () => authentication.promise;
  const result = h.instance.resolveWagerOutcome(true);
  h.rematch();
  authentication.resolve();
  h.pending.resolve(response);
  await result;
  assert.deepEqual(h.requests, [{ inviteId: "invite", matchId: "finished" }]);
  assert.deepEqual(h.inventory, [response.mining]);
  assert.deepEqual(h.optimistic, []);
});

test("settlement completes after navigation without replacing newer inventory", async (t) => {
  const h = harness();
  t.after(() => h.poller.stop());
  const result = h.instance.resolveWagerOutcome(true);
  await flush();
  h.instance.beginMatchSessionTeardown();
  h.instance.activeContext = null;
  h.instance.sameProfilePlayerUid = null;
  const newerInventory = {
    materials: { ...materials, dust: 12 },
    lastRockDate: "2026-09-05",
  };
  h.inventory.push(newerInventory);
  h.pending.resolve(response);
  assert.deepEqual(await result, response);
  assert.deepEqual(h.requests, [{ inviteId: "invite", matchId: "finished" }]);
  assert.deepEqual(h.inventory, [newerInventory]);
});

test("account and profile changes cannot receive an old inventory response", async (t) => {
  for (const change of [
    (h) => {
      h.instance.auth.currentUser = {
        uid: "other",
        getIdToken: async () => "other-token",
      };
    },
    (h) => h.setProfile("other-profile"),
  ]) {
    const h = harness();
    t.after(() => h.poller.stop());
    const result = h.instance.resolveWagerOutcome(true);
    await flush();
    change(h);
    h.pending.resolve(response);
    await result;
    assert.deepEqual(h.inventory, []);
    assert.equal(h.refreshes(), 0);
  }
});

test("an account switch during authentication never sends the old settlement", async (t) => {
  const h = harness();
  t.after(() => h.poller.stop());
  const authentication = deferred();
  h.instance.ensureAuthenticated = () => authentication.promise;
  const result = h.instance.resolveWagerOutcome(true);
  h.instance.auth.currentUser = {
    uid: "other",
    getIdToken: async () => "other-token",
  };
  authentication.resolve();
  assert.deepEqual(await result, { ok: false });
  assert.deepEqual(h.requests, []);
});

test("failed settlement refreshes balances without restoring a new match's UI", async (t) => {
  const h = harness();
  t.after(() => h.poller.stop());
  const result = h.instance.resolveWagerOutcome(true);
  const rejected = assert.rejects(result, /reload-required/);
  await flush();
  h.rematch();
  h.pending.reject(
    Object.assign(new Error("reload-required"), {
      code: "client-update-required",
    }),
  );
  await rejected;
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.restored, [{ matchId: "finished", current: false }]);
  assert.equal(h.banners.length, 1);
  assert.equal(h.refreshes(), 1);
});
