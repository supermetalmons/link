import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { MatchPresentationState } from "../src/connection/matchPresentationState.ts";

const sourceFile = (path) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
const connectionSource = sourceFile("../src/connection/connection.ts");
const connectionClass = connectionSource.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
const methods = (names) =>
  names
    .map((name) => {
      const node = connectionClass.members.find(
        (member) => member.name?.getText(connectionSource) === name,
      );
      assert.ok(node, name);
      return node.getText(connectionSource);
    })
    .join("\n");
const functions = (source, names) =>
  names
    .map((name) => {
      const node = source.statements.find(
        (statement) =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      assert.ok(node, name);
      return node.getText(source).replace(/^export /, "");
    })
    .join("\n");
const compile = (source, dependencies, result) => {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn ${result};`,
  )(...Object.values(dependencies));
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const appearance = (revision = 1, emojiId = 1, actorUid = "actor") => ({
  matchId: "invite",
  actorUid,
  emojiId,
  aura: "",
  revision,
});
const snapshot = (...values) => ({
  matchId: "invite",
  players: Object.fromEntries(values.map((value) => [value.actorUid, value])),
});

function connectionHarness({ paired = true } = {}) {
  const pendingRead = deferred();
  const pendingSave = deferred();
  const changes = [];
  const saves = [];
  const writes = [];
  const profileUpdates = [];
  const reads = [];
  const cleanups = new Map();
  const storedMatch = {
    emojiId: 1,
    aura: "",
    status: "active",
    fen: "unchanged",
    flatMovesString: "moves",
  };
  let room;
  class Channel {
    controller = new AbortController();
    constructor(dependencies) {
      room = dependencies;
    }
    get signal() {
      return this.controller.signal;
    }
    stop() {
      this.controller.abort();
    }
  }
  const Constructor = compile(
    `class Connection { ${methods([
      "observeInviteReactions",
      "cleanupInviteReactionObserver",
      "rememberMatchPresentation",
      "getMatchPresentation",
      "updateEmoji",
      "sendMatchUpdate",
    ])} }`,
    {
      MatchPresentationState,
      InviteReactionChannel: Channel,
      readMatchPresentationViaApi: (...args) => {
        reads.push(args);
        return pendingRead.promise;
      },
      updateMatchPresentationViaApi: (...args) => {
        saves.push(args);
        return pendingSave.promise;
      },
      didReceiveMatchPresentationUpdate: (...args) => changes.push(args),
      didRecoverInviteReactions: () => {},
      didReceiveInviteReactionUpdate: () => {},
      incrementLifecycleCounter: () => {},
      decrementLifecycleCounter: () => {},
      ref: (_db, path) => path,
      runTransaction: async (path, update, options) => {
        const value = update({ ...storedMatch });
        writes.push({ path, value, options });
        return { committed: true, snapshot: { exists: () => value !== null } };
      },
      storage: { getPlayerEmojiAura: () => "" },
    },
    "Connection",
  );
  const connection = Object.assign(new Constructor(), {
    db: {},
    matchPresentations: new Map(),
    observedMatchSnapshots: new Map(),
    myMatch: { ...storedMatch },
    activeContext: {
      contextId: 1,
      sessionEpoch: 1,
      inviteId: "invite",
      matchId: "invite",
      loginUid: "login-alias",
      actorUid: "actor",
      canWrite: true,
    },
    latestInvite: { hostId: "actor", guestId: paired ? "guest" : null },
    inviteReactionSubscription: null,
    isContextActive(contextId) {
      return this.activeContext?.contextId === contextId;
    },
    isCurrentAuthUser: (uid) => uid === "login-alias",
    registerObserverCleanup: (_id, key, cleanup) => {
      cleanups.set(key, cleanup);
      return true;
    },
    unregisterObserverCleanup: (_id, key) => cleanups.delete(key),
    getUserBoundAuthTokenProvider: (uid) => {
      assert.equal(uid, "login-alias");
      return async () => "token";
    },
    requireWritableContext() {
      return this.activeContext;
    },
    createMatchContextGuard: () => () => true,
    logContextEvent: () => {},
    updateStoredEmoji: (...args) => profileUpdates.push(args),
  });
  connection.observeInviteReactions();
  return {
    connection,
    room: () => room,
    pendingRead,
    pendingSave,
    changes,
    saves,
    writes,
    reads,
    profileUpdates,
  };
}

test("actual connection hydrates before pairing and isolates optimistic appearance from Firebase gameplay records", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = connectionHarness({ paired: false });
  assert.equal(h.room().canConnect(), false);
  assert.equal(h.reads.length, 1);
  h.pendingRead.resolve({ ok: true, presentation: snapshot(appearance()) });
  await flush();
  const seed = { ...h.connection.myMatch };
  h.connection.updateEmoji(1002, false, "rainbow");
  assert.deepEqual(h.profileUpdates, [[1002, "rainbow"]]);
  assert.deepEqual(h.connection.myMatch, seed);
  assert.equal(h.writes.length, 0);
  assert.equal(
    h.connection.getMatchPresentation("invite", "actor").emojiId,
    1002,
  );
  assert.equal(h.saves[0][2].expectedRevision, 1);
  h.room().onPresentationSnapshot(snapshot(appearance(1, 1)));
  h.connection.myMatch = { ...seed, emojiId: 9 };
  assert.equal(
    h.connection.getMatchPresentation("invite", "actor").emojiId,
    1002,
  );
  h.pendingSave.resolve({
    ok: true,
    presentation: { ...appearance(2, 1002), aura: "rainbow" },
  });
  await flush();
  assert.equal(
    h.connection.getMatchPresentation("invite", "actor").revision,
    2,
  );
  h.room().onError(new Error("reaction-channel-unavailable"));
  await flush();
  assert.equal(h.reads.length, 2);
  assert.equal(
    h.connection.getMatchPresentation("invite", "actor").revision,
    2,
  );
  assert.equal(h.writes.length, 0);
  h.connection.myMatch.status = "surrendered";
  assert.equal(h.connection.sendMatchUpdate("invite"), true);
  await flush();
  assert.deepEqual(h.writes, [
    {
      path: "players/actor/matches/invite",
      value: { ...seed, status: "surrendered" },
      options: { applyLocally: false },
    },
  ]);
  h.connection.cleanupInviteReactionObserver();
});

test("surrender captures status while preserving the current record on every transaction retry", async () => {
  const pending = deferred();
  let transaction;
  const events = [];
  const Constructor = compile(
    `class Connection { ${methods(["sendMatchUpdate"])} }`,
    {
      ref: (_db, path) => path,
      runTransaction: (path, update, options) => {
        transaction = { path, update, options };
        return pending.promise;
      },
    },
    "Connection",
  );
  const connection = Object.assign(new Constructor(), {
    db: {},
    myMatch: { status: "surrendered", emojiId: 1001, aura: "rainbow" },
    requireWritableContext: () => ({
      inviteId: "invite",
      matchId: "invite",
      actorUid: "actor",
    }),
    createMatchContextGuard: () => () => true,
    logContextEvent: (event) => events.push(event),
  });
  assert.equal(connection.sendMatchUpdate("invite"), true);
  connection.myMatch.status = "changed-after-queueing";
  assert.equal(transaction.path, "players/actor/matches/invite");
  assert.deepEqual(transaction.options, { applyLocally: false });
  assert.equal(transaction.update(null), null);
  const current = {
    fen: "server-fen",
    flatMovesString: "server-moves",
    status: "",
    timer: "server-timer",
    emojiId: 7,
    aura: "",
  };
  assert.deepEqual(transaction.update(current), {
    ...current,
    status: "surrendered",
  });
  assert.deepEqual(transaction.update({ fen: "legacy", status: "" }), {
    fen: "legacy",
    status: "surrendered",
  });
  pending.resolve({ committed: true, snapshot: { exists: () => true } });
  await flush();
  assert.deepEqual(events, ["ctx.write.success"]);
});

test("surrender reconnects after missing or aborted transactions", async () => {
  for (const [committed, exists] of [
    [false, true],
    [true, false],
  ]) {
    const events = [];
    const reconnects = [];
    const Constructor = compile(
      `class Connection { ${methods(["sendMatchUpdate"])} }`,
      {
        ref: (_db, path) => path,
        runTransaction: async () => ({
          committed,
          snapshot: { exists: () => exists },
        }),
      },
      "Connection",
    );
    const connection = Object.assign(new Constructor(), {
      db: {},
      myMatch: { status: "surrendered" },
      requireWritableContext: () => ({
        inviteId: "invite",
        matchId: "invite",
        actorUid: "actor",
      }),
      createMatchContextGuard: () => () => true,
      createSessionGuard: () => () => true,
      logContextEvent: (event) => events.push(event),
      reconnectAfterMatchUpdateFailure: (inviteId) => reconnects.push(inviteId),
    });
    assert.equal(connection.sendMatchUpdate("invite"), true);
    await flush();
    assert.deepEqual(events, ["ctx.write.fail"]);
    assert.deepEqual(reconnects, ["invite"]);
  }
});

test("actual context teardown aborts appearance hydration and rejects its late result", async () => {
  const h = connectionHarness();
  const signal = h.connection.inviteReactionSubscription.presentation.signal;
  h.connection.cleanupInviteReactionObserver();
  h.connection.activeContext = { contextId: 2, matchId: "invite1" };
  h.pendingRead.resolve({ ok: true, presentation: snapshot(appearance(3, 3)) });
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(h.changes.length, 0);
  assert.equal(h.connection.matchPresentations.size, 0);
  assert.equal(h.connection.getMatchPresentation("invite1", "actor"), null);
});

test("actual board hydration and late profile responses retain canonical and optimistic match appearance", () => {
  let value = appearance(2, 7);
  const player = { uid: "actor", emojiId: "1", aura: "" };
  const opponent = { uid: "guest", emojiId: "3", aura: "" };
  const rendered = [];
  const boardSource = sourceFile("../src/game/board.ts");
  const board = compile(
    functions(boardSource, [
      "updateEmojiAndAuraIfNeeded",
      "didGetPlayerProfile",
    ]),
    {
      playerSideMetadata: player,
      opponentSideMetadata: opponent,
      gameInputRuntime: {
        isWatchOnly: false,
        getDisplayedMatchPresentation: (uid) =>
          uid === "actor" ? value : null,
      },
      storage: { getPlayerEmojiAura: () => "" },
      syncAvatarForCurrentMetadata: (side) => rendered.push(side),
      updatePlayerMetadataWithProfile: () => {},
      recalculateDisplayNames: () => {},
    },
    "({ updateEmojiAndAuraIfNeeded, didGetPlayerProfile })",
  );
  board.updateEmojiAndAuraIfNeeded("1", "", false);
  assert.equal(player.emojiId, "7");
  value = { ...appearance(2, 8), aura: "rainbow" };
  board.didGetPlayerProfile({ emoji: 1, aura: "" }, "actor", false);
  assert.equal(player.emojiId, "8");
  assert.equal(player.aura, "rainbow");
  board.updateEmojiAndAuraIfNeeded("1", "", false);
  assert.equal(player.emojiId, "8");
  assert.deepEqual(rendered, [false, false, false]);
});

test("actual presentation callback is appearance-only and respects hydration, actor aliases and historical views", () => {
  const values = new Map([
    ["invite/actor", appearance(2, 7)],
    ["invite1/actor", { ...appearance(4, 8), matchId: "invite1" }],
  ]);
  const rendered = [];
  const board = {
    playerSideMetadata: { uid: "" },
    opponentSideMetadata: { uid: "guest" },
    updateEmojiAndAuraIfNeeded: (...args) => rendered.push(args),
  };
  const controllerSource = sourceFile("../src/game/gameController.ts");
  const controller = compile(
    `
    let isOnlineGame = true;
    let boardViewMode = "activeLive";
    let viewedRematchMatchId = null;
    let viewedRematchPair = null;
    ${functions(controllerSource, ["getDisplayedMatchPresentation", "refreshDisplayedMatchPresentation", "didReceiveMatchPresentationUpdate"])}
  `,
    {
      Board: board,
      connection: {
        getActiveMatchId: () => "invite1",
        getMatchPresentation: (matchId, uid) =>
          values.get(`${matchId}/${uid}`) ?? null,
      },
      didReceiveMatchUpdate: () => assert.fail("appearance replayed gameplay"),
    },
    "({ notify: didReceiveMatchPresentationUpdate, refresh: refreshDisplayedMatchPresentation, history: (matchId) => { boardViewMode = 'historicalView'; viewedRematchMatchId = matchId; viewedRematchPair = { hostPlayerId: 'actor', hostMatch: { emojiId: 5, aura: '' } }; }, live: () => { boardViewMode = 'activeLive'; viewedRematchMatchId = null; } })",
  );
  controller.notify("invite1", "actor");
  assert.deepEqual(rendered, []);
  board.playerSideMetadata.uid = "actor";
  controller.refresh();
  assert.deepEqual(rendered.pop(), ["8", "", false]);
  controller.notify("invite1", "login-alias");
  assert.deepEqual(rendered, []);
  controller.history("invite");
  controller.notify("invite1", "actor");
  assert.deepEqual(rendered, []);
  controller.refresh();
  assert.deepEqual(rendered.pop(), ["5", "", false]);
  controller.notify("invite", "actor");
  assert.deepEqual(rendered, []);
  controller.live();
  controller.refresh();
  assert.deepEqual(rendered.pop(), ["8", "", false]);
});

function historyAppearanceHarness({
  online = true,
  active = true,
  bot = false,
} = {}) {
  const player = { uid: "signed-in-login", emojiId: "1001", aura: "rainbow" };
  const opponent = { uid: "opponent", emojiId: "4", aura: "" };
  const requests = [];
  const order = [];
  const noop = () => {};
  const board = {
    playerSideMetadata: player,
    opponentSideMetadata: opponent,
    removeHighlights: noop,
    hideItemSelectionOrConfirmationOverlay: noop,
    setBoardFlipped: noop,
    markWagerInitialStateReceived: noop,
    hideBoardPlayersInfo: noop,
    runMonsBoardAsDisplayWaitingAnimation: () =>
      order.push("waiting-animation"),
  };
  const controllerSource = sourceFile("../src/game/gameController.ts");
  const controller = compile(
    `
    let isOnlineGame = ${online};
    let isGameWithBot = ${bot};
    let isWatchOnly = false;
    let isWaitingForRematchResponse = false;
    let isReconnect = false;
    let didConnect = true;
    let puzzleMode = false;
    let isGameOver = true;
    let boardViewMode = "historicalView";
    let viewedRematchMatchId = "old-match";
    let viewedRematchPair = { hostPlayerId: "signed-in-login", hostMatch: { emojiId: ${online ? 1 : 0}, aura: "" } };
    let boardViewDebugLogsEnabled = false;
    let flashbackMode = true;
    let currentInputs = [];
    let pendingTimerResolutionOnRestore = null;
    ${functions(controllerSource, ["getDisplayedMatchPresentation", "refreshDisplayedMatchPresentation", "enterWaitingLiveView", "restoreLiveBoardView", "didConfirmRematchProposal"])}
    function clearViewedRematchState() { viewedRematchMatchId = null; viewedRematchPair = null; }
  `,
    {
      Board: board,
      connection: {
        getActiveMatchId: () => (active ? "current-match" : null),
        getMatchPresentation: (_matchId, uid) =>
          uid === player.uid ? { emojiId: 1001, aura: "rainbow" } : null,
        setWagerViewMatchId: noop,
        sendRematchProposal: () => {
          order.push("send-rematch");
          requests.push({
            emojiId: board.getPlayersEmojiId(),
            aura: "rainbow",
          });
        },
      },
      nextBoardRenderSession: noop,
      activeBoardShouldBeFlipped: () => false,
      applyBoardUiForCurrentView: () =>
        board.runMonsBoardAsDisplayWaitingAnimation(),
      triggerMoveHistoryPopupReload: noop,
      setEndMatchVisible: noop,
      setNewBoard: noop,
      applyTimerStateFromStashes: () => false,
      getTimerMatchIdCandidate: () => null,
      applyWagerState: noop,
      updateUndoButtonBasedOnGameState: noop,
    },
    "({ get: getDisplayedMatchPresentation, refresh: refreshDisplayedMatchPresentation, restore: restoreLiveBoardView, rematch: didConfirmRematchProposal })",
  );
  const boardSource = sourceFile("../src/game/board.ts");
  Object.assign(
    board,
    compile(
      functions(boardSource, [
        "syncAvatarForCurrentMetadata",
        "updateEmojiAndAuraIfNeeded",
        "getPlayersEmojiId",
      ]),
      {
        playerSideMetadata: player,
        opponentSideMetadata: opponent,
        gameInputRuntime: {
          isWatchOnly: false,
          getDisplayedMatchPresentation: controller.get,
        },
        storage: { getPlayerEmojiAura: () => "rainbow" },
        slotIsOpponentForMetadataSide: (side) => side,
        playerAvatar: null,
        opponentAvatar: null,
        playerAvatarPlaceholder: null,
        opponentAvatarPlaceholder: null,
      },
      "({ updateEmojiAndAuraIfNeeded, getPlayersEmojiId })",
    ),
  );
  return { controller, player, requests, order };
}

test("local and bot synthetic history preserve the signed-in avatar through history and live restoration", () => {
  for (const bot of [false, true]) {
    const h = historyAppearanceHarness({ online: false, active: false, bot });
    h.controller.refresh();
    assert.equal(h.controller.get(h.player.uid), null);
    assert.deepEqual(h.player, {
      uid: "signed-in-login",
      emojiId: "1001",
      aura: "rainbow",
    });
    h.controller.restore();
    assert.deepEqual(h.player, {
      uid: "signed-in-login",
      emojiId: "1001",
      aura: "rainbow",
    });
    assert.deepEqual(h.requests, []);
  }
});

test("proposing a rematch from online history restores current appearance before reading request seeds", () => {
  const h = historyAppearanceHarness();
  h.controller.refresh();
  assert.deepEqual(h.player, {
    uid: "signed-in-login",
    emojiId: "1",
    aura: "",
  });
  h.controller.rematch();
  assert.deepEqual(h.requests, [{ emojiId: 1001, aura: "rainbow" }]);
  assert.deepEqual(h.player, {
    uid: "signed-in-login",
    emojiId: "1001",
    aura: "rainbow",
  });
  assert.ok(
    h.order.indexOf("waiting-animation") < h.order.indexOf("send-rematch"),
  );
});

test("pending online hosts still resolve live appearance before the gameplay online flag is set", () => {
  const h = historyAppearanceHarness({ online: false, active: true });
  h.controller.restore();
  assert.deepEqual(h.controller.get(h.player.uid), {
    emojiId: 1001,
    aura: "rainbow",
  });
});
