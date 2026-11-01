import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import ts from "typescript";

registerTypeScriptTestHooks();

const { createGameControlsStore } =
  await import("../src/game/gameControlsStore.ts");
const { createSessionControlsPresenter } =
  await import("../src/game/sessionControls.ts");
const source = ts.createSourceFile(
  "gameController.ts",
  readFileSync(
    new URL("../src/game/gameController.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);

/** @param {string[]} names @param {Record<string, unknown>} initial @param {Record<string, unknown>} dependencies @returns {unknown} */
function instantiate(names, initial, dependencies) {
  const declarations = names.map((name) => {
    const node = source.statements.find(
      (item) => ts.isFunctionDeclaration(item) && item.name?.text === name,
    );
    assert.ok(node, name);
    return node.getText(source).replace(/^export /, "");
  });
  const keys = Object.keys(initial);
  const { outputText } = ts.transpileModule(
    `${keys.map((key) => `let ${key} = initial.${key};`).join("\n")}
    ${declarations.join("\n")}
    return { ${names.join(", ")}, state: () => ({ ${keys.join(", ")} }) };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  return new Function("initial", ...Object.keys(dependencies), outputText)(
    initial,
    ...Object.values(dependencies),
  );
}

function harness({ started = false, puzzle = false } = {}) {
  const store = createGameControlsStore({
    duration: 90,
    progress: 0,
    requestDate: 1,
  });
  store.updatePresentation({
    inviteLinkVisible: true,
    botGameVisible: true,
    navigationVisible: true,
  });
  /**
   * @type {import("../src/game/gameControlsModel.ts").GameControlsSnapshot[]}
   */
  const notifications = [];
  store.subscribe(() => notifications.push(store.getSnapshot()));
  /** @type {Array<{ name: string; value: unknown; snapshot: import("../src/game/gameControlsModel.ts").GameControlsSnapshot; notifications: number; }>} */
  const effects = [];
  const record = (
    /** @type {string} */ name,
    /** @type {unknown} */ value = undefined,
  ) =>
    effects.push({
      name,
      value,
      snapshot: store.getSnapshot(),
      notifications: notifications.length,
    });
  /** @type {Parameters<typeof createSessionControlsPresenter>[0]} */
  const commands = {
    setHomeVisible(value) {
      store.updatePresentation({ homeVisible: value });
      record("setHomeVisible", value);
    },
    setInviteLinkActionVisible(value) {
      store.updatePresentation({ inviteLinkVisible: value });
      record("setInviteLinkActionVisible", value);
    },
    setBotGameOptionVisible(value) {
      store.updatePresentation({ botGameVisible: value });
      record("setBotGameOptionVisible", value);
    },
    setNavigationListButtonVisible(value) {
      store.updatePresentation({ navigationVisible: value });
      record("setNavigationListButtonVisible", value);
    },
    showMoveHistoryButton(value) {
      store.updatePresentation({ moveHistoryVisible: value });
      record("showMoveHistoryButton", value);
    },
    setBrushAndNavigationButtonDimmed: (dimmed) => {
      store.updatePresentation({
        navigationDimmed: dimmed,
        appearanceDimmed: dimmed,
      });
    },
    setUndoVisible: (visible) =>
      store.dispatchGameControls({ type: "setUndoVisible", visible }),
    setAutomoveActionVisible: (visible) =>
      store.dispatchGameControls({ type: "setAutomoveVisible", visible }),
    showResignButton: () => store.dispatchGameControls({ type: "showResign" }),
    setIslandButtonDimmed: (value) => {
      record("island", value);
    },
    setAutomatchVisible: (value) => {
      record("automatch-visible", value);
    },
    setAutomatchEnabled: (value) => {
      record("automatch-enabled", value);
    },
    setAutomatchWaitingState: (value) => {
      record("automatch-waiting", value);
    },
    setPlaySamePuzzleAgainButtonVisible: () =>
      assert.fail("unexpected puzzle controls"),
    setAutomoveActionEnabled: () => assert.fail("unexpected automove controls"),
    setUndoEnabled: () => assert.fail("unexpected undo controls"),
    setWatchOnlyVisible: () => assert.fail("unexpected watch controls"),
    showVoiceReactionButton: () => assert.fail("unexpected reaction controls"),
    hideTimerButtons: () => assert.fail("unexpected timer controls"),
    disableAndHideUndoResignAndTimerControls: () =>
      assert.fail("unexpected hidden controls"),
    setEndMatchVisible: () => assert.fail("unexpected end controls"),
    setEndMatchConfirmed: () => assert.fail("unexpected end confirmation"),
    showWaitingStateText: () => assert.fail("unexpected waiting controls"),
    showPrimaryAction: () => assert.fail("unexpected primary action"),
  };
  /** @type {PromiseWithResolvers<{ok: true; inviteId: string}>} */
  const request = Promise.withResolvers();
  let epoch = 0;
  const game = { toFen: () => "game", activeColor: "white", turnNumber: 1 };
  const api =
    /** @type {Pick<typeof import("../src/game/gameController.ts"), "didClickAutomatchButton" | "dismissPendingAutomatchTransition"> & {applyOutput(previous: readonly string[], fen: string, output: MonsRulesInputResolution, remote: boolean, bot: boolean, assistance: "none"): boolean; state(): {didStartLocalGame: boolean; currentInputs: unknown[]; pendingAutomatchTransition: boolean; isWaitingForInviteToGetAccepted: boolean}}} */ (
      instantiate(
        [
          "applyOutput",
          "didClickAutomatchButton",
          "dismissPendingAutomatchTransition",
        ],
        {
          game,
          isOnlineGame: false,
          isGameWithBot: false,
          isGameOver: false,
          didStartLocalGame: started,
          puzzleMode: puzzle,
          flashbackMode: false,
          currentInputs: ["old-input"],
          didMakeFirstLocalPlayerMoveOnLocalBoard: false,
          isWaitingForInviteToGetAccepted: false,
          pendingAutomatchTransition: false,
        },
        {
          ...commands,
          ...createSessionControlsPresenter(commands),
          batchGameControlsUpdates: store.batchUpdates,
          ensureLocalRematchSeriesInitialized: () => record("local-history"),
          dismissNotificationBannerIfNeeded: () => record("dismiss-banner"),
          handleStaleOnlineLocalOutput: () => false,
          isCreateInviteRoute: () => true,
          isBotsRoute: () => false,
          MonsRules: { Color: { White: "white", Black: "black" } },
          Board: Object.fromEntries(
            [
              "removeHighlights",
              "hideBoardPlayersInfo",
              "hideAllMoveStatuses",
              "runMonsBoardAsDisplayWaitingAnimation",
            ].map((name) => [name, () => record(name)]),
          ),
          updateBoardMoveStatuses: () => record("move-statuses"),
          updateUndoButtonBasedOnGameState: () => record("undo-sync"),
          syncInviteBotIntoLocalGameButton: () => record("bot-sync"),
          triggerMoveHistoryPopupReload: () => record("history-reload"),
          playSounds: () => {},
          getSessionGuard: () => {
            const expected = epoch;
            return () => expected === epoch;
          },
          connection: {
            automatch: () => request.promise,
            connectToAutomatch: (/** @type {string} */ inviteId) => {
              record("connect", inviteId);
            },
          },
        },
      )
    );
  return {
    ...api,
    store,
    notifications,
    effects,
    request,
    invalidate: () => epoch++,
  };
}

/** @typedef {import("mons-rules").InputResolution} MonsRulesInputResolution */
const firstMove = (/** @type {ReturnType<typeof harness>} */ h) =>
  h.applyOutput(
    [],
    "",
    { kind: "complete", inputFen: "move", events: [] },
    false,
    false,
    "none",
  );
const settle = () => new Promise(setImmediate);

test("the first local move publishes initialized controls once before ordinary move effects", () => {
  const h = harness();
  assert.equal(firstMove(h), false);
  assert.equal(h.state().didStartLocalGame, true);
  assert.deepEqual(h.state().currentInputs, []);
  assert.deepEqual(h.notifications, [h.store.getSnapshot()]);
  const { presentation } = required(h.notifications[0]);
  assert.equal(presentation.homeVisible, true);
  assert.equal(presentation.inviteLinkVisible, false);
  assert.equal(presentation.botGameVisible, false);
  assert.equal(presentation.navigationVisible, false);
  assert.equal(presentation.moveHistoryVisible, true);
  assert.equal(presentation.gameControls.undo.visible, true);
  assert.equal(presentation.gameControls.automove.visible, true);
  assert.equal(presentation.gameControls.resignVisible, true);
  const initialization = h.effects.find(
    (/** @type {{ name: string; }} */ effect) =>
      effect.name === "showMoveHistoryButton",
  );
  assert.equal(
    required(initialization).snapshot.presentation.moveHistoryVisible,
    true,
  );
  assert.equal(required(initialization).notifications, 0);
  assert.equal(
    required(
      h.effects.find(
        (/** @type {{ name: string; }} */ effect) =>
          effect.name === "move-statuses",
      ),
    ).notifications,
    1,
  );

  const snapshot = h.store.getSnapshot();
  firstMove(h);
  assert.strictEqual(h.store.getSnapshot(), snapshot);
  assert.equal(h.notifications.length, 1);
  assert.equal(
    h.effects.filter(
      (/** @type {{ name: string; }} */ effect) =>
        effect.name === "local-history",
    ).length,
    1,
  );
});

test("first-move initialization preserves puzzle navigation and does not show resignation", () => {
  const h = harness({ puzzle: true });
  firstMove(h);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.store.getSnapshot().presentation.navigationVisible, true);
  assert.equal(
    h.store.getSnapshot().presentation.gameControls.resignVisible,
    false,
  );
});

test("automatch request and response publish separately without holding a batch over the request", async () => {
  const h = harness();
  h.didClickAutomatchButton(() => {
    h.store.updatePresentation({ waitingText: "matched" });
    h.store.updatePresentation({ homeVisible: false });
  });
  assert.equal(h.state().pendingAutomatchTransition, true);
  assert.equal(h.state().isWaitingForInviteToGetAccepted, true);
  assert.equal(h.notifications.length, 1);
  h.store.updatePresentation({ waitingText: "unrelated update" });
  assert.equal(h.notifications.length, 2);
  h.request.resolve({ ok: true, inviteId: "auto-game" });
  await settle();
  assert.equal(h.notifications.length, 3);
  assert.equal(
    required(h.notifications.at(-1)).presentation.homeVisible,
    false,
  );
  assert.equal(
    required(h.notifications.at(-1)).presentation.waitingText,
    "matched",
  );
  const connect = h.effects.find(
    (/** @type {{ name: string; }} */ effect) => effect.name === "connect",
  );
  assert.equal(required(connect).notifications, 2);
  assert.equal(required(connect).snapshot.presentation.waitingText, "matched");
});

for (const outcome of ["resolve", "reject"]) {
  for (const cancel of [false, true]) {
    test(`late automatch ${outcome} is ignored after ${cancel ? "cancellation" : "session invalidation"}`, async () => {
      const h = harness();
      let responses = 0;
      h.didClickAutomatchButton(() => responses++);
      if (cancel) {
        h.dismissPendingAutomatchTransition();
        assert.equal(h.state().pendingAutomatchTransition, false);
        assert.equal(h.state().isWaitingForInviteToGetAccepted, false);
        assert.equal(required(h.effects.at(-1)).name, "automatch-enabled");
        const effectCount = h.effects.length;
        h.dismissPendingAutomatchTransition();
        assert.equal(h.effects.length, effectCount);
      } else {
        h.invalidate();
      }
      const snapshot = h.store.getSnapshot();
      const effectCount = h.effects.length;
      if (outcome === "resolve")
        h.request.resolve({ ok: true, inviteId: "stale" });
      else h.request.reject(new Error("offline"));
      await settle();
      assert.equal(responses, 0);
      assert.equal(h.effects.length, effectCount);
      assert.equal(h.notifications.length, 1);
      assert.strictEqual(h.store.getSnapshot(), snapshot);
    });
  }
}

test("automatch request failure clears pending state and reenables its separate UI", async () => {
  const h = harness();
  h.didClickAutomatchButton();
  h.request.reject(new Error("offline"));
  await settle();
  assert.equal(h.state().pendingAutomatchTransition, false);
  assert.equal(required(h.effects.at(-1)).name, "automatch-enabled");
  assert.equal(required(h.effects.at(-1)).value, true);
  assert.equal(h.notifications.length, 1);
  h.store.updatePresentation({ waitingText: "retry" });
  assert.equal(h.notifications.length, 2);
});
