import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isAutoInviteId } from "../cloud/functions/shared/ids.js";
import { withAutomatchOperationLock } from "../src/connection/automatchOperationLock.ts";

const readClass = (path, name) => {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, `missing class ${name}`);
  return declaration;
};

const connection = readClass("../src/connection/connection.ts", "Connection");
const methods = [
  "clearPendingAutomatchRequest",
  "reconcilePendingAutomatchRequest",
  "beginConnectAttempt",
  "isConnectAttemptActive",
  "isContextActive",
  "isSessionEpochActive",
  "observeContextValue",
  "buildRuntimeContext",
  "connectToGame",
].map((name) => {
  const method = connection.members.find(
    (node) => node.name?.getText() === name,
  );
  assert.ok(method, `missing method ${name}`);
  return method.getText();
});
const registrySource = readClass(
  "../src/connection/observerRegistry.ts",
  "ObserverRegistry",
)
  .getText()
  .replace("export class", "class");

function instantiate(source, className, dependencies) {
  const { outputText } = ts.transpileModule(
    source.replaceAll("import.meta.env.DEV", "false"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  const Constructor = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn ${className};`,
  )(...Object.values(dependencies));
  return Constructor;
}

const UID = "firebase-uid";
const INVITE_ID = "auto_canceled";
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const pendingInvite = {
  hostId: UID,
  guestId: null,
  automatchStateHint: "pending",
  automatchOperationIds: { [UID]: OPERATION_ID },
};
const canceledInvite = { ...pendingInvite, automatchStateHint: "canceled" };

function harness(invite, onMatchRead = () => {}) {
  const events = { home: [], waiting: [], matches: [], errors: [] };
  const callbacks = new Map();
  const operations = new Map([
    [UID, { operationId: OPERATION_ID, resolvedInviteId: null }],
  ]);
  const storage = {
    getPendingAutomatchOperation: (uid) => operations.get(uid) ?? null,
    setPendingAutomatchOperation: (uid, operation) => {
      if (operation) operations.set(uid, operation);
      else operations.delete(uid);
    },
    getPlayerEmojiAura: () => "",
  };
  const noop = () => {};
  let currentInvite = invite;
  const Registry = instantiate(registrySource, "ObserverRegistry", {
    onValue: (path, callback) => {
      callbacks.set(path, callback);
      queueMicrotask(() => callback({ val: () => currentInvite }));
    },
    off: noop,
    incrementLifecycleCounter: noop,
    decrementLifecycleCounter: noop,
  });
  let instance;
  const Connection = instantiate(
    `class Connection { ${methods.join("\n")} }`,
    "Connection",
    {
      storage,
      withAutomatchOperationLock,
      isAutoInviteId,
      ref: (_db, path) => path,
      get: async () => {
        onMatchRead();
        return { val: () => ({ color: "white" }) };
      },
      getPlayersEmojiId: () => 1,
      transitionToHome: async (options) => {
        events.home.push(options);
        instance.sessionEpoch += 1;
        instance.activeContext = null;
      },
      didFindYourOwnInviteThatNobodyJoined: (isAutomatch) =>
        events.waiting.push(isAutomatch),
      didRecoverInviteReactions: noop,
      didRecoverMyMatch: noop,
      didDiscoverExistingRematchProposalWaitingForResponse: noop,
      didFailToLoadPendingInvite: noop,
      console: { log: noop, error: (...args) => events.errors.push(args) },
    },
  );
  instance = Object.assign(new Connection(), {
    sessionEpoch: 1,
    connectAttemptId: 0,
    nextContextId: 1,
    activeContext: null,
    db: {},
    getUserBoundAuthTokenProvider: () => ({ assertCurrentUser: noop }),
    fetchInviteWithPendingCreation: async () => ({ ...invite }),
    resolveActorUidForInvite: async () => ({ actorUid: UID, role: "host" }),
    getLatestMatchIdForActor: () => ({
      matchId: INVITE_ID,
      hasPendingProposal: false,
    }),
    detachFromMatchSession: noop,
    activateContext: (context) => {
      instance.activeContext = context;
    },
    updateWagerStateForCurrentMatch: noop,
    observeInviteReactions: noop,
    observeRematchOrEndMatchIndicators: noop,
    observeWagers: noop,
    observeMatch: (uid) => events.matches.push(uid),
  });
  instance.observerRegistry = new Registry(
    (contextId, epoch) => instance.isContextActive(contextId, epoch),
    noop,
  );
  const settle = async () => {
    await new Promise(setImmediate);
    assert.deepEqual(events.errors, []);
  };
  return {
    events,
    operations,
    instance,
    settle,
    setInvite: (value) => {
      currentInvite = value;
    },
    connect: async () => {
      instance.connectToGame(UID, INVITE_ID, true);
      await settle();
    },
    emit: async (value) => {
      const callback = callbacks.get(`invites/${INVITE_ID}`);
      assert.ok(callback, "pending invite observer is registered");
      callback({ val: () => value });
      await settle();
    },
  };
}

test("a recovered canceled invite returns home and retires its operation", async () => {
  const state = harness(canceledInvite);
  await state.connect();

  assert.deepEqual(state.events.home, [
    { forceMatchScopeReset: true, replace: true },
  ]);
  assert.deepEqual(state.events.waiting, []);
  assert.equal(state.operations.has(UID), false);
  assert.equal(state.instance.activeContext, null);
});

test("a live canceled invite exits waiting", async () => {
  const state = harness(pendingInvite);
  await state.connect();
  assert.deepEqual(state.events.waiting, [true]);

  await state.emit(canceledInvite);

  assert.deepEqual(state.events.home, [
    { forceMatchScopeReset: true, replace: true },
  ]);
  assert.equal(state.instance.activeContext, null);
  assert.equal(state.operations.has(UID), false);
});

test("cancellation between the initial read and subscription exits waiting", async () => {
  const state = harness(pendingInvite, () => state.setInvite(canceledInvite));
  await state.connect();

  assert.equal(state.events.home.length, 1);
  assert.equal(state.instance.activeContext, null);
});

test("a canceled invite preserves an unrelated pending operation", async () => {
  const state = harness(canceledInvite);
  const unrelated = {
    operationId: "another-operation",
    resolvedInviteId: null,
  };
  state.operations.set(UID, unrelated);
  await state.connect();

  assert.equal(state.events.home.length, 1);
  assert.strictEqual(state.operations.get(UID), unrelated);
});

test("an ordinary pending automatch keeps waiting", async () => {
  const state = harness(pendingInvite);
  await state.connect();
  await state.emit(pendingInvite);

  assert.deepEqual(state.events.home, []);
  assert.deepEqual(state.events.waiting, [true]);
  assert.ok(state.instance.activeContext);
});

test("a joined invite wins over a stale canceled hint", async () => {
  const joined = { ...canceledInvite, guestId: "guest-uid" };
  const initial = harness(joined);
  await initial.connect();
  assert.deepEqual(initial.events.home, []);
  assert.deepEqual(initial.events.matches, ["guest-uid"]);

  const observed = harness(pendingInvite);
  await observed.connect();
  await observed.emit(joined);
  assert.deepEqual(observed.events.home, []);
  assert.deepEqual(observed.events.matches, ["guest-uid"]);
});

test("a stale invite cancellation cannot leave the current game", async () => {
  const state = harness(pendingInvite);
  await state.connect();
  const currentContext = {
    ...state.instance.activeContext,
    contextId: 99,
    inviteId: "another-invite",
  };
  state.instance.activeContext = currentContext;

  await state.emit(canceledInvite);

  assert.deepEqual(state.events.home, []);
  assert.strictEqual(state.instance.activeContext, currentContext);
});
