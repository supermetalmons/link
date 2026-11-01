import { required, canonicalMatch } from "./fixtures/canonicalData.mjs";
import { createConnectionWagerClientHarness } from "./wagerClientHarness.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { moveDeliveryStorageKey } from "../src/connection/moveDelivery.ts";
import { isAutoInviteId } from "../cloud/runtime/shared/ids.js";
import { rematchSeriesEnded } from "../cloud/runtime/shared/rematches.js";
import { withAutomatchOperationLock } from "../src/connection/automatchOperationLock.ts";
import {
  InviteMetadataState,
  rematchSeriesEqual,
} from "../src/connection/inviteMetadataState.ts";

const readClass = (
  /** @type {string | URL} */ path,
  /** @type {string | undefined} */ name,
) => {
  const source = ts.createSourceFile(
    path.toString(),
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration && ts.isClassDeclaration(declaration));
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
  "isCurrentAuthUser",
  "registerObserverCleanup",
  "unregisterObserverCleanup",
  "observeInviteMetadata",
  "cleanupInviteMetadataObserver",
  "applyInviteMetadata",
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

/** @template T @param {string} source @param {string} className @param {Record<string, unknown>} dependencies @returns {T} */
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

const UID = "login-uid";
const INVITE_ID = "auto_canceled";
const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
/** @typedef {{hostId: string, guestId: string | null, automatchStateHint: "pending" | "canceled", automatchOperationIds: Record<string, string>}} InviteFixture */
/** @param {string} operationId @returns {import("../src/utils/storage.ts").PendingAutomatchOperation} */
const pendingOperation = (operationId) => ({
  createdAtMs: 1,
  operationId,
  request: { emojiId: 1, aura: "none" },
  resolvedInviteId: null,
  uid: UID,
});
/** @type {InviteFixture} */
const pendingInvite = {
  hostId: UID,
  guestId: null,
  automatchStateHint: "pending",
  automatchOperationIds: { [UID]: OPERATION_ID },
};
/** @type {InviteFixture} */
const canceledInvite = { ...pendingInvite, automatchStateHint: "canceled" };

/**
 * @typedef {typeof import("../src/connection/connection.ts").connection} Connection
 * @typedef {Parameters<typeof createConnectionWagerClientHarness>[0] & {connectToGame: Connection["connectToGame"], observerRegistry?: import("../src/connection/observerRegistry.ts").ObserverRegistry, wagerClient?: import("../src/connection/wagerClient.ts").WagerClient}} FixtureConnection
 * @param {InviteFixture} invite
 * @param {() => void} [onMatchRead]
 */
function harness(invite, onMatchRead = () => {}) {
  /** @type {{home: Parameters<typeof import("../src/session/sessionTransitionPort.ts").transitionToHome>[0][], waiting: boolean[], matches: string[], errors: unknown[][]}} */
  const events = { home: [], waiting: [], matches: [], errors: [] };
  /** @type {Map<string, ConstructorParameters<typeof import("../src/connection/inviteMetadataChannel.ts").InviteMetadataChannel>[0]["onSnapshot"]>} */
  const callbacks = new Map();
  /** @type {Map<string, NonNullable<ReturnType<typeof import("../src/utils/storage.ts").storage.getPendingAutomatchOperation>>>} */
  const operations = new Map([[UID, pendingOperation(OPERATION_ID)]]);
  const storage = {
    getPendingAutomatchOperation: (/** @type {string} */ uid) =>
      operations.get(uid) ?? null,
    /** @type {typeof import("../src/utils/storage.ts").storage.setPendingAutomatchOperation} */
    setPendingAutomatchOperation: (uid, operation) => {
      if (operation) operations.set(uid, operation);
      else operations.delete(uid);
    },
    getPlayerEmojiAura: () => "",
  };
  const noop = () => {};
  let currentInvite = invite;
  let revision = 1;
  /** @param {InviteFixture} value @returns {import("@mons/shared/invite-metadata").ReadInviteMetadataResponse} */
  const metadata = (value) => ({
    ok: true,
    snapshot: {
      inviteId: INVITE_ID,
      revision,
      hostId: value.hostId,
      hostColor: "white",
      guestId: value.guestId,
      hostRematches: { state: "open", indices: [] },
      guestRematches: { state: "open", indices: [] },
      automatchStateHint: value.automatchStateHint,
      eventId: null,
      eventOwned: false,
    },
    viewer: {
      actorUid: UID,
      role: "host",
      automatchOperationId: value.automatchOperationIds?.[UID] ?? null,
    },
  });
  /** @type {typeof import("../src/connection/observerRegistry.ts").ObserverRegistry} */
  const Registry = instantiate(registrySource, "ObserverRegistry", {});
  /** @type {FixtureConnection} */
  let instance;
  const dependenciesReadMatch = async () => {
    onMatchRead();
    return {
      match: canonicalMatch(),
    };
  };
  /** @type {new () => Pick<Connection, "connectToGame">} */
  const Connection = instantiate(
    `class Connection { ${methods.join("\n")} }`,
    "Connection",
    {
      moveDeliveryStorageKey,
      storage,
      InviteMetadataState,
      rematchSeriesEqual,
      InviteMetadataChannel: class {
        /** @param {ConstructorParameters<typeof import("../src/connection/inviteMetadataChannel.ts").InviteMetadataChannel>[0]} dependencies */
        constructor(dependencies) {
          callbacks.set(dependencies.inviteId, dependencies.onSnapshot);
          queueMicrotask(() => {
            const response = metadata(currentInvite);
            dependencies.onSnapshot(response.snapshot, response.viewer);
          });
        }
        stop() {}
      },
      withAutomatchOperationLock,
      isAutoInviteId,
      rematchSeriesEnded,
      ref: (/** @type {unknown} */ _db, /** @type {string} */ path) => path,
      /** @param {{playerId: string, matchId: string}} request @param {{signal: AbortSignal}} options */
      readMatchSnapshotViaApi: async ({ playerId, matchId }, options) => {
        assert.equal(playerId, UID);
        assert.equal(matchId, INVITE_ID);
        assert.ok(options.signal instanceof AbortSignal);
        onMatchRead();
        return {
          ok: true,
          playerId,
          matchId,
          match: canonicalMatch(),
        };
      },
      readInviteWagersViaApi: async (/** @type {string} */ inviteId) => ({
        ok: true,
        snapshot: { inviteId, revision: 1, wagers: {} },
      }),
      getPlayersEmojiId: () => 1,
      transitionToHome: async (
        /** @type {Parameters<typeof import("../src/session/sessionTransitionPort.ts").transitionToHome>[0]} */ options,
      ) => {
        events.home.push(options);
        instance.sessionEpoch += 1;
        instance.activeContext = null;
      },
      didFindYourOwnInviteThatNobodyJoined: (
        /** @type {boolean} */ isAutomatch,
      ) => events.waiting.push(isAutomatch),
      didRecoverInviteReactions: noop,
      didRecoverMyMatch: noop,
      didDiscoverExistingRematchProposalWaitingForResponse: noop,
      didFailToLoadPendingInvite: noop,
      didFailToLoadGame: noop,
      incrementLifecycleCounter: noop,
      decrementLifecycleCounter: noop,
      console: {
        log: noop,
        error: (/** @type {unknown[]} */ ...args) => events.errors.push(args),
      },
    },
  );
  instance = Object.assign(new Connection(), {
    sessionEpoch: 1,
    connectAttemptId: 0,
    nextContextId: 1,
    activeContext: null,
    moveDeliveries: new Map(),
    confirmedSurrenders: new Set(),
    reconcilingMoveKeys: new Set(),
    getMoveDelivery: (
      /** @type {unknown} */ _scope,
      /** @type {import("@mons/shared/game-sessions").GameSessionMatch} */ match,
    ) => ({
      reconcile: () => match,
      resume: noop,
      suspend: noop,
    }),
    auth: {
      currentUser: {
        uid: UID,
        sessionId: "session",
        generation: "generation",
        getIdToken: async () => "token",
      },
      getTokenRemainingMs: () => 60_000,
    },
    flushPendingMoves: async () => assert.fail("unexpected pending moves"),
    db: {},
    getUserBoundAuthTokenProvider: () =>
      Object.assign(async () => "token", { assertCurrentUser: noop }),
    fetchInviteWithPendingCreation: async () => {
      const value = metadata(invite);
      const actor = await dependenciesReadMatch();
      return {
        ok: true,
        schemaVersion: 1,
        metadata: value.snapshot,
        viewer: value.viewer,
        hasPendingProposal: false,
        match: {
          inviteId: INVITE_ID,
          matchId: INVITE_ID,
          revision: 1,
          hostPlayerId: UID,
          guestPlayerId: value.snapshot.guestId,
          hostMatch: actor.match,
          guestMatch: value.snapshot.guestId
            ? { ...actor.match, color: "black" }
            : null,
        },
      };
    },
    getLatestMatchIdForActor: () => ({
      matchId: INVITE_ID,
      hasPendingProposal: false,
    }),
    detachFromMatchSession: () => required(instance.wagerClient).resetMatch(),
    detachMatchSession: (
      /** @type {import("../src/connection/wagerClient.ts").WagerOwner | undefined} */ preserveInvite,
    ) =>
      required(instance.wagerClient).resetMatch(
        preserveInvite ? { preserveInvite } : {},
      ),
    activateContext: (
      /** @type {import("../src/connection/matchRuntimeContext.ts").MatchRuntimeContext} */ context,
    ) => {
      instance.activeContext = context;
      required(instance.wagerClient).bindContext(context);
    },
    observeInviteReactions: noop,
    rematchSeriesEndIsIndicatedForInvite: () => false,
    isRematchEndPending: () => false,
    getRematchEndDelivery: () => ({ confirm: noop, refresh: noop }),
    refreshRematchEndDeliveries: noop,
    maybeRefreshContextAfterRematchMetadata: noop,
    ensureMatchSyncSubscription: noop,
    observeMatch: (/** @type {string} */ uid) => events.matches.push(uid),
  });
  instance.observerRegistry = new Registry(noop);
  instance.wagerClient = createConnectionWagerClientHarness(instance).client;
  const settle = async () => {
    await new Promise(setImmediate);
    assert.deepEqual(events.errors, []);
  };
  return {
    events,
    operations,
    instance,
    settle,
    setInvite: (/** @type {InviteFixture} */ value) => {
      currentInvite = value;
      revision++;
    },
    connect: async () => {
      instance.connectToGame(UID, INVITE_ID, true);
      await settle();
    },
    emit: async (/** @type {InviteFixture} */ value) => {
      const callback = callbacks.get(INVITE_ID);
      assert.ok(callback, "pending invite observer is registered");
      revision++;
      callback(metadata(value).snapshot);
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
  const unrelated = pendingOperation("another-operation");
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
    ...required(state.instance.activeContext),
    contextId: 99,
    inviteId: "another-invite",
  };
  state.instance.activeContext = currentContext;

  await state.emit(canceledInvite);

  assert.deepEqual(state.events.home, []);
  assert.strictEqual(state.instance.activeContext, currentContext);
});
