import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  MoveDelivery,
  moveDeliveryStorageKey,
} from "../src/connection/moveDelivery.ts";
import { createUserBoundAuthTokenProvider } from "../src/services/authApi.ts";

const source = ts.createSourceFile(
  "connection.ts",
  readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
const names = [
  "moveDeliveryScope",
  "isCurrentMoveBoard",
  "recoverMoveBoard",
  "getMoveDelivery",
  "flushPendingMoves",
  "refreshMoveDeliveries",
  "sendMove",
  "createSessionGuard",
  "createMatchContextGuard",
  "isSessionEpochActive",
  "isContextActive",
  "isCurrentAuthUser",
  "requireWritableContext",
  "surrender",
  "startTimer",
  "claimVictoryByTimer",
  "updateRatings",
  "resolveWagerOutcome",
  "sendEndMatchIndicator",
  "sendRematchProposal",
];
const methods = names.map((name) => {
  const method = declaration.members.find(
    (node) => node.name?.getText(source) === name,
  );
  assert.ok(method, `missing Connection.${name}`);
  return method.getText(source);
});
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`.replaceAll(
    "import.meta.env.DEV",
    "false",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
class GameplayApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = () => new Promise(setImmediate);
const scope = {
  loginUid: "login",
  inviteId: "abcdefghijk",
  matchId: "abcdefghijk1",
  playerId: "actor",
};
const initialMatch = {
  status: "",
  timer: "timer",
  emojiId: 3,
  fen: "base-fen",
  flatMovesString: "first",
  gameVariant: "Classic",
};
function harness({ token, records = new Map(), onTerminal, onReconnect } = {}) {
  let instance;
  const calls = [];
  const terminal = [];
  const reconnects = [];
  const errors = [];
  const bindings = [];
  const localStorage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  const terminalCall = (kind) => async (request, provider) => {
    await provider(false);
    provider.assertCurrentUser();
    terminal.push({ kind, request });
    if (onTerminal) {
      const response = await onTerminal(kind, request);
      provider.assertCurrentUser();
      if (response !== undefined) return response;
    }
    if (kind === "rematch") return new Promise(() => {});
    return { ok: true, actorUid: scope.playerId, rematches: "x" };
  };
  const dependencies = {
    MoveDelivery,
    moveDeliveryStorageKey,
    GameplayApiError,
    window: { sessionStorage: localStorage },
    navigator: { onLine: true },
    storage: {
      getProfileId: () => "profile",
      getPlayerEmojiAura: () => "",
      getPlayerEmojiId: () => "3",
    },
    getPlayersEmojiId: () => 3,
    getWagerState: () => null,
    console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
    submitMoveViaApi: async (request, provider, options) => {
      const bearer = await provider(false);
      provider.assertCurrentUser();
      if (options.signal.aborted)
        throw new GameplayApiError("aborted", "request-aborted");
      const pending = deferred();
      calls.push({ request, bearer, options, pending });
      const value = await pending.promise;
      provider.assertCurrentUser();
      return value;
    },
    readMatchSnapshotViaApi: async () => ({ match: { ...initialMatch } }),
    surrenderMatchViaApi: terminalCall("surrender"),
    startMatchTimerViaApi: terminalCall("timer"),
    claimMatchVictoryByTimerViaApi: terminalCall("claim"),
    updateRatingsViaApi: terminalCall("rating"),
    resolveWagerOutcomeViaApi: terminalCall("wager"),
    endRematchViaApi: terminalCall("end"),
    proposeRematchViaApi: terminalCall("rematch"),
    isWagerClientUpdateRequired: () => false,
  };
  const Constructor = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn Connection;`,
  )(...Object.values(dependencies));
  instance = Object.assign(new Constructor(), {
    auth: {
      currentUser: {
        uid: "login",
        getIdToken: token || (async () => "login-token"),
      },
    },
    sessionEpoch: 2,
    activeContext: {
      contextId: 4,
      sessionEpoch: 2,
      ...scope,
      actorUid: scope.playerId,
      canWrite: true,
      role: "host",
    },
    myMatch: { ...initialMatch },
    latestInvite: { hostId: scope.playerId, guestId: "opponent" },
    moveDeliveries: new Map(),
    confirmedSurrenders: new Set(),
    reconcilingMoveKeys: new Set(),
    moveRecoveryTimers: new Map(),
    moveReconnectCooldownMs: 3000,
    moveReconnectLastAttemptAt: 0,
    moveReconnectInFlight: false,
    getUserBoundAuthTokenProvider: (uid) => {
      bindings.push(uid);
      assert.equal(instance.auth.currentUser?.uid, uid);
      return createUserBoundAuthTokenProvider(
        instance.auth.currentUser,
        () => instance.auth.currentUser,
      );
    },
    ensureAuthenticated: async () => {},
    getOpponentId: () => "opponent",
    notifyNavigationGamesChanged() {},
    logContextEvent() {},
    reconnectAfterMatchUpdateFailure: (inviteId, guard) => {
      reconnects.push({ inviteId, guard });
      onReconnect?.(inviteId, guard);
    },
    createWagerContextGuard: () => () => true,
    beginWagerSnapshotMutation: () => () => {},
    cloneWagerState: (value) => value,
    applyOptimisticWagerResolution: () => false,
    callWagerApiWithRetry: (_label, work) => work(),
    rematchSeriesEndIsIndicated: () => false,
    getRematchIndexAvailableForNewProposal: () => 1,
    getCachedHistoricalMatchPair: () => null,
  });
  return {
    instance,
    calls,
    terminal,
    reconnects,
    errors,
    bindings,
    records,
    send: (move = "second", fen = "second-fen") =>
      instance.sendMove(move, fen, scope.matchId),
    acknowledge: (index, response = { outcome: "applied" }) =>
      calls[index].pending.resolve(response),
  };
}

test("rapid actions keep one journal and retain both predecessors while authentication is pending", async () => {
  const token = deferred();
  const h = harness({ token: () => token.promise });
  h.send();
  h.send("z", "base-fen");
  h.send("third", "third-fen");
  assert.equal(h.calls.length, 0);
  assert.equal(h.instance.myMatch.flatMovesString, "first-second-z-third");
  const stored = JSON.parse(h.records.get(moveDeliveryStorageKey(scope)));
  assert.deepEqual(
    stored.pending.map(({ moveFen }) => moveFen),
    ["second", "z", "third"],
  );
  token.resolve("login-token");
  await settle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(
    h.calls.map(({ request }) => request.flatMovesString),
    ["first-second", "first-second-z"],
  );
  h.acknowledge(1);
  await settle();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].request.flatMovesString, "first-second-z-third");
  h.acknowledge(2);
  h.acknowledge(0);
  await settle();
  assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
  assert.equal(h.instance.myMatch.fen, "third-fen");
  assert.deepEqual(h.bindings, ["login", "login", "login"]);
  assert.equal(h.reconnects.length, 0);
});

test("navigation keeps accepted delivery alive without changing the newly displayed match", async () => {
  const h = harness();
  h.send();
  await settle();
  h.instance.sessionEpoch++;
  h.instance.activeContext = null;
  const otherMatch = { fen: "other", flatMovesString: "other" };
  h.instance.myMatch = otherMatch;
  h.acknowledge(0);
  await settle();
  assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
  assert.equal(h.instance.myMatch, otherMatch);
  assert.equal(h.reconnects.length, 0);
});

test("auth change cancels dispatch and retains the original UID journal for safe resume", async () => {
  const token = deferred();
  const h = harness({ token: () => token.promise });
  h.send();
  h.instance.auth.currentUser = {
    uid: "other",
    getIdToken: async () => "other-token",
  };
  h.instance.refreshMoveDeliveries();
  token.resolve("old-token");
  await settle();
  assert.equal(h.calls.length, 0);
  assert.ok(h.records.has(moveDeliveryStorageKey(scope)));
  h.instance.auth.currentUser = {
    uid: "login",
    getIdToken: async () => "replacement-token",
  };
  h.instance.refreshMoveDeliveries();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].bearer, "replacement-token");
  h.acknowledge(0);
  await settle();
  assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
});

test("the wrong authenticated account cannot enqueue into the prior board", async () => {
  const h = harness();
  h.instance.auth.currentUser = { uid: "other" };
  h.send();
  await settle();
  assert.equal(h.instance.myMatch.fen, initialMatch.fen);
  assert.equal(h.records.size, 0);
  assert.equal(h.calls.length, 0);
});

for (const [method, kind] of [
  ["surrender", "surrender"],
  ["startTimer", "timer"],
  ["claimVictoryByTimer", "claim"],
  ["updateRatings", "rating"],
  ["resolveWagerOutcome", "wager"],
  ["sendEndMatchIndicator", "end"],
  ["sendRematchProposal", "rematch"],
]) {
  test(`${kind} waits until accepted moves are confirmed`, async () => {
    const h = harness();
    h.send();
    const result = h.instance[method]();
    if (kind === "surrender")
      assert.equal(h.instance.myMatch.status, "surrendered");
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.terminal.length, 0);
    h.acknowledge(0);
    await settle();
    assert.equal(h.terminal.length, 1);
    assert.equal(h.terminal[0].kind, kind);
    if (result instanceof Promise) await result;
    if (kind === "surrender")
      assert.equal(h.instance.myMatch.status, "surrendered");
  });
}

const endingActions = [
  [
    "surrender",
    "surrender",
    {
      inviteId: scope.inviteId,
      matchId: scope.matchId,
      playerId: scope.playerId,
    },
  ],
  ["sendEndMatchIndicator", "end", { inviteId: scope.inviteId }],
  [
    "updateRatings",
    "rating",
    {
      inviteId: scope.inviteId,
      matchId: scope.matchId,
      playerId: scope.playerId,
      opponentId: "opponent",
    },
  ],
  [
    "resolveWagerOutcome",
    "wager",
    { inviteId: scope.inviteId, matchId: scope.matchId },
  ],
];

for (const [method, kind, expectedRequest] of endingActions) {
  for (const change of ["navigation", "reconnect"]) {
    test(`accepted ${kind} stays with its original match after ${change}`, async () => {
      const h = harness();
      h.send();
      const result = h.instance[method]();
      const completed =
        result instanceof Promise ? result.catch((error) => error) : result;
      await settle();
      assert.equal(h.terminal.length, 0);
      h.instance.sessionEpoch++;
      h.instance.activeContext =
        change === "navigation"
          ? null
          : {
              ...h.instance.activeContext,
              contextId: 5,
              sessionEpoch: h.instance.sessionEpoch,
            };
      const replacement = { fen: "replacement", status: "" };
      h.instance.myMatch = replacement;
      h.acknowledge(0);
      await settle();
      assert.ok(!((await completed) instanceof Error));
      assert.equal(h.terminal.length, 1);
      assert.equal(h.terminal[0].kind, kind);
      const { operationId, ...request } = h.terminal[0].request;
      if (kind === "end") assert.equal(typeof operationId, "string");
      else assert.equal(operationId, undefined);
      assert.deepEqual(request, expectedRequest);
      assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
      assert.equal(h.instance.myMatch, replacement);
      assert.equal(
        replacement.status,
        kind === "surrender" && change === "reconnect" ? "surrendered" : "",
      );
      assert.equal(
        h.reconnects.length,
        kind === "surrender" && change === "reconnect" ? 1 : 0,
      );
    });
  }

  for (const uid of ["other", "login"]) {
    test(`accepted ${kind} rejects a replacement auth object with UID ${uid}`, async () => {
      const h = harness();
      h.send();
      const result = h.instance[method]();
      const completed =
        result instanceof Promise ? result.catch(() => undefined) : result;
      await settle();
      h.instance.auth.currentUser = {
        uid,
        getIdToken: async () => "replacement-token",
      };
      h.acknowledge(0);
      await settle();
      for (let index = 1; index < h.calls.length; index++) {
        h.acknowledge(index);
        await settle();
      }
      await completed;
      assert.equal(h.terminal.length, 0);
      assert.equal(h.reconnects.length, 0);
      h.instance.refreshMoveDeliveries();
      for (const delivery of h.instance.moveDeliveries.values())
        delivery.pause();
    });
  }
}

test("rating settlement captures its match before authentication waits", async () => {
  const authenticationReady = deferred();
  const h = harness();
  h.instance.ensureAuthenticated = () => authenticationReady.promise;
  h.send();
  const completed = h.instance.updateRatings();
  h.instance.sessionEpoch++;
  h.instance.activeContext = {
    ...h.instance.activeContext,
    contextId: 5,
    sessionEpoch: h.instance.sessionEpoch,
    inviteId: "zyxwvutsrqp",
    matchId: "zyxwvutsrqp1",
  };
  h.instance.getOpponentId = () => "new-opponent";
  authenticationReady.resolve();
  await settle();
  assert.equal(h.terminal.length, 0);
  h.acknowledge(0);
  await completed;
  assert.deepEqual(h.terminal, [
    {
      kind: "rating",
      request: {
        inviteId: scope.inviteId,
        matchId: scope.matchId,
        playerId: scope.playerId,
        opponentId: "opponent",
      },
    },
  ]);
});

for (const [method, kind] of [
  ["startTimer", "timer"],
  ["claimVictoryByTimer", "timer claim"],
  ["sendRematchProposal", "rematch proposal"],
]) {
  test(`a move barrier cannot dispatch a dependent ${kind} after its board context changes`, async () => {
    const h = harness();
    h.send();
    const result = h.instance[method]();
    const rejected =
      result instanceof Promise
        ? assert.rejects(result, /request-aborted/)
        : undefined;
    await settle();
    h.instance.sessionEpoch++;
    h.acknowledge(0);
    await rejected;
    await settle();
    assert.equal(h.terminal.length, 0);
    assert.equal(h.records.has(moveDeliveryStorageKey(scope)), false);
  });
}

test("returning to the same game reconciles a surrender only after the server commits it", async () => {
  const pendingSurrender = deferred();
  let serverMatch = { ...initialMatch };
  const recovered = [];
  const h = harness({
    onTerminal: async (kind) => {
      assert.equal(kind, "surrender");
      await pendingSurrender.promise;
      serverMatch = { ...serverMatch, status: "surrendered" };
      return { ok: true };
    },
    onReconnect: (inviteId, guard) => {
      assert.equal(inviteId, scope.inviteId);
      assert.equal(guard(), true);
      assert.equal(serverMatch.status, "surrendered");
      recovered.push({ ...serverMatch });
      h.instance.myMatch = { ...serverMatch };
    },
  });
  h.send();
  assert.equal(h.instance.surrender(), true);
  await settle();
  h.instance.sessionEpoch++;
  h.instance.activeContext = {
    ...h.instance.activeContext,
    contextId: 5,
    sessionEpoch: h.instance.sessionEpoch,
  };
  const delivery = h.instance.moveDeliveries.get(moveDeliveryStorageKey(scope));
  h.instance.myMatch = { ...initialMatch, ...delivery.latest };
  serverMatch = { ...initialMatch, ...delivery.latest };
  h.acknowledge(0);
  await settle();
  assert.equal(h.terminal.length, 1);
  assert.equal(serverMatch.status, "");
  assert.equal(h.instance.myMatch.status, "");
  assert.equal(recovered.length, 0);
  assert.equal(h.instance.confirmedSurrenders.size, 0);

  pendingSurrender.resolve();
  await settle();
  assert.equal(h.instance.myMatch.status, "surrendered");
  assert.equal(recovered.length, 1);
  assert.ok(h.instance.confirmedSurrenders.has(moveDeliveryStorageKey(scope)));
  h.send("third", "third-fen");
  await settle();
  assert.equal(h.calls.length, 1);
});

for (const change of ["another match", "another account"]) {
  test(`a surrender response cannot reconcile ${change}`, async () => {
    const pendingSurrender = deferred();
    const h = harness({ onTerminal: () => pendingSurrender.promise });
    h.send();
    h.instance.surrender();
    await settle();
    h.acknowledge(0);
    await settle();
    assert.equal(h.terminal.length, 1);
    h.instance.sessionEpoch++;
    h.instance.activeContext = {
      ...h.instance.activeContext,
      contextId: 5,
      sessionEpoch: h.instance.sessionEpoch,
      ...(change === "another match" ? { matchId: "abcdefghijk2" } : {}),
    };
    if (change === "another account") {
      h.instance.auth.currentUser = {
        uid: "other",
        getIdToken: async () => "other-token",
      };
    }
    const replacement = { fen: "replacement", status: "" };
    h.instance.myMatch = replacement;
    pendingSurrender.resolve({ ok: true });
    await settle();
    assert.equal(h.instance.myMatch, replacement);
    assert.equal(replacement.status, "");
    assert.equal(h.reconnects.length, 0);
  });
}

test("surrender recovery rechecks the displayed match and account after its cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const change of ["none", "match", "account"]) {
    const h = harness();
    h.instance.moveReconnectLastAttemptAt = Date.now();
    h.send();
    h.instance.surrender();
    await settle();
    h.instance.sessionEpoch++;
    h.instance.activeContext = {
      ...h.instance.activeContext,
      contextId: 5,
      sessionEpoch: h.instance.sessionEpoch,
    };
    h.instance.myMatch = { ...initialMatch };
    h.acknowledge(0);
    await settle();
    assert.equal(h.instance.myMatch.status, "surrendered");
    assert.equal(h.reconnects.length, 0);
    assert.equal(h.instance.moveRecoveryTimers.size, 1);
    if (change === "match") {
      h.instance.activeContext = {
        ...h.instance.activeContext,
        matchId: "abcdefghijk2",
      };
    } else if (change === "account") {
      h.instance.auth.currentUser = {
        uid: "other",
        getIdToken: async () => "other-token",
      };
    }
    t.mock.timers.tick(3000);
    assert.equal(h.reconnects.length, change === "none" ? 1 : 0);
    assert.equal(h.instance.moveRecoveryTimers.size, 0);
  }
});

test("confirmed terminal cancellation releases ending actions without calling the move delivered", async () => {
  const h = harness();
  h.send();
  const rating = h.instance.updateRatings();
  await settle();
  const delivery = h.instance.moveDeliveries.get(moveDeliveryStorageKey(scope));
  const revision = delivery.confirmationVersion;
  h.calls[0].pending.reject(
    new GameplayApiError("failed-precondition", "match-move-finished"),
  );
  await rating;
  assert.equal(h.terminal.at(-1).kind, "rating");
  assert.equal(delivery.confirmationVersion, revision);
  assert.ok(h.records.has(`${moveDeliveryStorageKey(scope)}:finished`));
  h.send("another", "another-fen");
  await settle();
  assert.equal(h.calls.length, 1);
});

test("own-state recovery waits out reconnect cooldown and still respects navigation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const navigate of [false, true]) {
    const h = harness();
    h.instance.moveReconnectLastAttemptAt = Date.now();
    h.send();
    await settle();
    const delivery = h.instance.moveDeliveries.get(
      moveDeliveryStorageKey(scope),
    );
    delivery.reconcile({
      fen: "remote-next",
      flatMovesString: "first-second-third",
    });
    assert.equal(h.reconnects.length, 0);
    assert.equal(h.instance.moveRecoveryTimers.size, 1);
    if (navigate) h.instance.activeContext = null;
    t.mock.timers.tick(3000);
    assert.equal(h.reconnects.length, navigate ? 0 : 1);
    assert.equal(h.instance.moveRecoveryTimers.size, 0);
    h.acknowledge(0);
    await settle();
  }
});
