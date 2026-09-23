import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MONS_PLAYWRIGHT_PATH || "playwright");
const repository = fileURLToPath(new URL("../", import.meta.url));
const sharedManifest = JSON.parse(
  readFileSync(
    new URL("../cloud/runtime/shared/package.json", import.meta.url),
    "utf8",
  ),
);
const sharedImports = Object.keys(sharedManifest.exports).map(
  (subpath) => sharedManifest.name + subpath.slice(1),
);
const environmentSource = `
export const environment = {
  route: { mode: 'home', path: '' },
  epoch: 0,
  calls: [],
  callbacks: {},
  automatchRequests: [],
  cancelRequests: [],
  subscriptions: [],
  eventSubscriptions: [],
  activeContext: null,
  inviteEventId: null,
  inviteEventOwned: false,
  eventModalState: { isOpen: false, eventId: null, lastCloseReason: null },
  eventModalListeners: new Set(),
  navigationListeners: new Set(),
  transientHandlers: new Set(),
  wagerEligible: false,
  homeTransitionGate: null,
};
export const pendingGame = (inviteId) => ({
  id: inviteId, inviteId, entityType: 'game', kind: 'auto',
  status: 'pending', sortBucket: 20, listSortAtMs: 1,
});
`;
const controllerSource = `
import { environment } from 'bottom-environment';
const invoke = (name, ...args) => {
  environment.calls.push([name, ...args]);
  environment.callbacks[name]?.(...args);
};
export const didClickStartTimerButton = () => invoke('timer');
export const didClickClaimVictoryByTimerButton = () => invoke('claim');
export const didClickPrimaryActionButton = action => invoke('primary', action);
export const didClickAutomatchButton = callback => environment.automatchRequests.push(callback);
export const dismissPendingAutomatchTransition = () => invoke('dismiss');
export const canHandleUndo = () => true;
export const isGameWithBot = false;
export const puzzleMode = false;
export let isOnlineGame = false;
export const setOnlineGame = value => { isOnlineGame = value; };
export const isWatchOnly = false;
export const isMatchOver = () => false;
export const getBoardViewMode = () => 'activeLive';
export const getRematchSeriesNavigatorItems = () => [];
export const preloadRematchSeriesScores = async () => false;
export const getSelectedPuzzleId = () => null;
export const didClickUndoButton = () => invoke('undo');
export const didClickAutomoveButton = () => invoke('automove');
export const didClickHomeButton = () => invoke('home');
export const didClickInviteActionButtonBeforeThereIsInviteReady = () => {};
export const didClickStartBotGameButton = () => {};
export const didClickEndMatchButton = () => invoke('end');
export const didClickConfirmResignButton = () => invoke('resign');
export const playSameCompletedPuzzleAgain = () => {};
export const didSelectRematchSeriesMatch = () => {};
export const didSelectPuzzle = problem => invoke('puzzle', problem.id);
`;
const connectionSource = `
import { environment, pendingGame } from 'bottom-environment';
export const connection = {
  createSessionGuard() { const epoch = environment.epoch; return () => epoch === environment.epoch; },
  subscribeProfileGames(limit, update, error, meta) {
    const subscription = { update, meta, active: true };
    environment.subscriptions.push(subscription);
    return () => { subscription.active = false; };
  },
  getProfileGamesPage: async () => ({ items: [], nextCursor: null, hasMore: false }),
  removeWaitingNavigationGame: async () => ({ ok: true }),
  createOptimisticPendingAutomatchItem: pendingGame,
  cancelAutomatch: () => new Promise((resolve, reject) => environment.cancelRequests.push({ resolve, reject })),
  connectToInvite(inviteId) {
    environment.calls.push(['connect', inviteId]);
    environment.route = { mode: 'invite', inviteId, path: inviteId };
  },
  getActiveContextSnapshot: () => environment.activeContext,
  getCurrentInviteEventId: () => environment.inviteEventId,
  isCurrentInviteEventOwned: () => environment.inviteEventOwned,
  subscribeToEvent(eventId, update) {
    const subscription = { eventId, update, active: true };
    environment.eventSubscriptions.push(subscription);
    return () => { subscription.active = false; };
  },
  rematchSeriesEndIsIndicated: () => false,
  sendVoiceReaction: reaction => environment.calls.push(['reaction', reaction]),
  sendWagerProposal: async (material, count) => { environment.calls.push(['wager', material, count]); },
};
`;
const appNavigationSource = `
import { environment } from 'bottom-environment';
export const setRoute = route => {
  environment.route = route;
  environment.navigationListeners.forEach(listener => listener(route, 'push'));
};
export const subscribeToNavigationState = listener => {
  environment.navigationListeners.add(listener);
  listener(environment.route, 'init');
  return () => environment.navigationListeners.delete(listener);
};
`;
const eventModalSource = `
import { environment } from 'bottom-environment';
import { setRoute } from 'bottom-app-navigation';
const emit = () => environment.eventModalListeners.forEach(listener => listener(environment.eventModalState));
export const getEventModalState = () => environment.eventModalState;
export const subscribeToEventModalState = listener => {
  environment.eventModalListeners.add(listener);
  listener(environment.eventModalState);
  return () => environment.eventModalListeners.delete(listener);
};
export const openEventModal = eventId => {
  environment.calls.push(['openEvent', eventId]);
  environment.eventModalState = { isOpen: true, eventId, lastCloseReason: null };
  setRoute({ ...environment.route, eventId });
  emit();
};
export const closeEventModal = (reason = 'dismiss') => {
  environment.eventModalState = { isOpen: false, eventId: null, lastCloseReason: reason };
  setRoute({ ...environment.route, eventId: null });
  emit();
};
`;
const sessionSource = `
import { environment } from 'bottom-environment';
export const getCurrentTarget = () => environment.route;
export const isTransitionInProgress = () => false;
export const transitionToHome = async options => {
  environment.calls.push(['transitionHome', options]);
  if (environment.homeTransitionGate) await environment.homeTransitionGate.promise;
  environment.route = { mode: 'home', path: '' };
};
`;
const transientSource = `
import { environment } from 'bottom-environment';
export const registerBottomControlsTransientUiHandler = (close, clear) => {
  const handlers = { close, clear };
  environment.transientHandlers.add(handlers);
  return () => environment.transientHandlers.delete(handlers);
};
`;
const navigationSource = `
import React from 'react';
export default function NavigationPicker({ topGames, onSelectGame, onSelectProblem }) {
  return React.createElement('div', {
    'data-testid': 'navigation-picker', style: { position: 'fixed', top: 150, right: 10 },
  },
    React.createElement('button', null, 'Navigation contents'),
    React.createElement('button', { onClick: () => onSelectProblem('test-puzzle') }, 'Open test puzzle'),
    topGames.map(item => React.createElement('button', {
      key: item.id, onClick: () => onSelectGame(item, { status: item.status }),
    }, 'Open ' + item.id)));
}
`;
const harnessSource = `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import BottomControls from '/src/ui/BottomControls.tsx';
import * as port from '/src/ui/controls/bottomControlsPort.ts';
import { getLifecycleCounters } from '/src/lifecycle/lifecycleDiagnostics.ts';
import { environment, pendingGame } from 'bottom-environment';
import { setOnlineGame } from 'bottom-controller';
import { setRoute } from 'bottom-app-navigation';
import { openEventModal, closeEventModal } from 'bottom-event-modal';
let root = createRoot(document.getElementById('root'));
const run = callback => flushSync(callback);
const settle = async callback => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try { await act(callback); }
  finally { globalThis.IS_REACT_ACT_ENVIRONMENT = false; }
};
window.harness = {
  environment, port, run,
  render(profileId = 'a') {
    run(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(BottomControls, {
        authState: { profileId, authStatus: 'authenticated', solAddress: '', ethAddress: '' },
      }))));
  },
  async respondAutomatch(index, response, enterWaiting = true) {
    await settle(async () => {
      environment.automatchRequests[index](response);
      if (enterWaiting) {
        environment.route = { mode: 'invite', inviteId: response.inviteId, path: response.inviteId };
        port.setAutomatchWaitingState(true);
      }
    });
  },
  async respondCancel(index, result, reject = false) {
    await settle(async () => {
      const request = environment.cancelRequests[index];
      if (reject) request.reject(new Error('temporary cancellation failure'));
      else request.resolve(result);
    });
  },
  publishPending(inviteId) {
    run(() => environment.subscriptions.findLast(subscription => subscription.active).update([pendingGame(inviteId)]));
  },
  publishNavigation(items) {
    run(() => environment.subscriptions.findLast(subscription => subscription.active).update(items));
  },
  holdHomeTransition() { environment.homeTransitionGate = Promise.withResolvers(); },
  async releaseHomeTransition() {
    await settle(async () => {
      environment.homeTransitionGate.resolve();
      environment.homeTransitionGate = null;
    });
  },
  resetMatch() {
    run(() => environment.transientHandlers.forEach(({ close, clear }) => { close(); clear(); }));
  },
  updateConnection({ inviteId = null, eventId = null, eventOwned = false, online = false } = {}) {
    environment.activeContext = inviteId ? { inviteId, matchId: inviteId, canWrite: false, contextId: 1 } : null;
    environment.inviteEventId = eventId;
    environment.inviteEventOwned = eventOwned;
    setOnlineGame(online);
    window.harness.render();
  },
  navigate(route) { run(() => setRoute(route)); },
  openEvent(eventId) { run(() => openEventModal(eventId)); },
  dismissEvent() { run(() => closeEventModal()); },
  launchEventGame(inviteId) {
    run(() => {
      setRoute({ mode: 'invite', inviteId, path: inviteId });
      closeEventModal('launch_game');
    });
  },
  publishEvent(eventId, emojiIds) {
    run(() => environment.eventSubscriptions.findLast(subscription => subscription.active && subscription.eventId === eventId).update({
      participants: Object.fromEntries(emojiIds.map((emojiId, index) => [index, {
        profileId: 'participant-' + index, displayName: 'Player ' + index, emojiId, joinedAtMs: index,
      }])),
    }));
  },
  counters: getLifecycleCounters,
  dispose() { run(() => root.unmount()); },
};
`;

const realNavigationHarnessSource = `
import * as session from '/src/session/AppSessionManager.ts';
import * as modal from '/src/ui/event/modalState.ts';
import * as navigation from '/src/navigation/appNavigation.ts';
import { getCurrentRouteState, getRoutePathForTarget } from '/src/navigation/routeState.ts';
import { connection } from 'bottom-connection';
Object.assign(window.harness, {
  navigate: route => navigation.pushRoutePath(getRoutePathForTarget(route)),
  openEvent: modal.openEventModal,
  dismissEvent: modal.closeEventModal,
  launchEventGame(inviteId) {
    const route = getCurrentRouteState();
    if (route.mode === 'invite' && route.inviteId === inviteId) {
      return modal.closeEventModal({ reason: 'launch_game' });
    }
    modal.prepareEventModalGameLaunch(inviteId);
    connection.connectToInvite(inviteId);
  },
  holdBootstrap(inviteId) {
    environment.bootstrapGate = { inviteId, ...Promise.withResolvers() };
  },
  releaseBootstrap() {
    environment.bootstrapGate.resolve();
    environment.bootstrapGate = null;
  },
  navigationState: () => ({
    route: getCurrentRouteState(),
    modal: modal.getEventModalState(),
    transitioning: session.isTransitionInProgress(),
    bootstraps: environment.bootstraps,
  }),
});
navigation.replaceRoutePath('/event-game-1');
session.initializeAppSessionManager();
`;

async function fixture(run, { realNavigation = false, mobile = false } = {}) {
  const modules = new Map([
    ["bottom-environment", environmentSource],
    ["bottom-controller", controllerSource],
    ["bottom-connection", connectionSource],
    ["bottom-session", sessionSource],
    ["bottom-transient", transientSource],
    ["bottom-navigation", navigationSource],
    ["bottom-app-navigation", appNavigationSource],
    ["bottom-event-modal", eventModalSource],
    ["bottom-harness", harnessSource + "\nwindow.harness.render();"],
  ]);
  const replacements = new Map([
    ["../game/gameController", "bottom-controller"],
    ["../connection/connection", "bottom-connection"],
    ["../session/AppSessionManager", "bottom-session"],
    ["./uiSession", "bottom-transient"],
    ["./NavigationPicker", "bottom-navigation"],
    ["../navigation/appNavigation", "bottom-app-navigation"],
    ["./eventModalController", "bottom-event-modal"],
  ]);
  const stubs = new Map([
    [
      "../hooks/useAvailableMaterials",
      "export const useAvailableMaterials = () => ({ availableMaterials: { dust: 3, slime: 2 }, frozenMaterialsStatus: 'ready', hasConfirmedSnapshot: true });",
    ],
    [
      "../hooks/useMaterialImages",
      "export const useMaterialImages = () => ({});",
    ],
    [
      "../utils/misc",
      `export const isMobile = ${mobile}; export const defaultEarlyInputEventName = '${mobile ? "touchstart" : "mousedown"}';`,
    ],
    [
      "../utils/SoundPlayer",
      "export const soundPlayer = { initializeOnUserInteraction() {} };",
    ],
    [
      "../content/sounds",
      "export const playReaction = () => {}; export const playSounds = () => {}; export const newReactionOfKind = kind => ({ kind }); export const newStickerReaction = () => ({});",
    ],
    [
      "./controls/boardReactionPort",
      "import { environment } from 'bottom-environment'; export const showVoiceReactionText = () => {}; export const showVideoReaction = () => {}; export const isMetadataSideDisplayedAtOpponentSlot = () => false; export const getPlayerReactionUid = () => environment.wagerEligible ? 'player' : null; export const getOpponentReactionUid = () => environment.wagerEligible ? 'opponent' : null;",
    ],
    [
      "./controls/useReactionPicker",
      "export const STICKER_IMAGE_BASE_URL = ''; export const useReactionPicker = () => ({ visibleStickerIds: [], hasFreshStickerEntitlement: false, stickerUrls: {}, canSendSticker: () => false });",
    ],
    ["./controls/menuPort", "export const closeMenuAndInfoIfAny = () => {};"],
    [
      "./BoardStylePicker",
      "import React from 'react'; export default () => React.createElement('div', { 'data-testid': 'appearance-picker', style: { position: 'fixed', top: 150, left: 10 } }, React.createElement('button', null, 'Appearance contents')); export const preloadPangchiuBoardPreview = () => {};",
    ],
    ["../utils/gameModels", "export const Sound = {};"],
    [
      "./MoveHistoryPopup",
      "import React from 'react'; export default ({ ref }) => React.createElement('div', { ref, 'data-testid': 'history-popup', style: { position: 'fixed', top: 200, left: 10 } }, React.createElement('button', null, 'History contents'));",
    ],
    [
      "./controls/moveHistoryPopupStore",
      "export const subscribeMoveHistoryPopupReload = () => () => {}; export const triggerMoveHistoryPopupSelectionReset = () => {};",
    ],
    [
      "../services/rocksMiningService",
      "export const MATERIALS = ['dust', 'slime'];",
    ],
    [
      "../game/wagerState",
      "export const subscribeToWagerState = () => () => {}; export const hasConfirmedWagerSnapshot = () => true;",
    ],
    [
      "../utils/playerMetadata",
      "import { environment } from 'bottom-environment'; export const getStashedPlayerProfile = () => environment.wagerEligible ? { id: 'opponent-profile' } : undefined;",
    ],
    [
      "../navigation/routeState",
      "import { environment } from 'bottom-environment'; export const getCurrentRouteState = () => environment.route;",
    ],
    ["../content/problems", "export const problems = [{ id: 'test-puzzle' }];"],
    [
      "../content/emojis",
      "export const emojis = { getEmojiUrl: emojiId => '/__emoji/' + emojiId + '.svg' };",
    ],
  ]);
  for (const [id, source] of stubs) {
    const name = "bottom-stub-" + id;
    replacements.set(id, name);
    modules.set(name, source);
  }
  if (realNavigation) {
    for (const id of [
      "../session/AppSessionManager",
      "../navigation/appNavigation",
      "../navigation/routeState",
      "./eventModalController",
    ]) {
      replacements.delete(id);
    }
    modules.set(
      "bottom-harness",
      harnessSource +
        realNavigationHarnessSource +
        "\nwindow.harness.render();",
    );
    modules.set(
      "bottom-connection",
      connectionSource +
        `
import { transition } from '/src/session/AppSessionManager.ts';
connection.connectToInvite = inviteId => {
  environment.calls.push(['connect', inviteId]);
  void transition({ mode: 'invite', path: inviteId, inviteId,
    eventId: null, snapshotId: null, autojoin: false });
};
`,
    );
    modules.set(
      "bottom-controller",
      controllerSource +
        `
import { setHomeVisible } from '/src/ui/controls/bottomControlsPort.ts';
environment.bootstraps = [];
export const go = async target => {
  environment.bootstraps.push(target.inviteId);
  isOnlineGame = target.mode === 'invite';
  setHomeVisible(isOnlineGame);
  const gate = environment.bootstrapGate;
  if (gate?.inviteId === target.inviteId) await gate.promise;
};
`,
    );
    modules.set(
      "bottom-main-load",
      "export const markMainGameRoutePrepared = () => {};",
    );
    modules.set(
      "bottom-lifecycle",
      `
import { environment } from 'bottom-environment';
import { setOnlineGame } from 'bottom-controller';
export const teardownMatchScope = () => {
  environment.activeContext = null;
  environment.inviteEventId = null;
  environment.inviteEventOwned = false;
  setOnlineGame(false);
  environment.transientHandlers.forEach(({ close, clear }) => { close(); clear(); });
};
export const teardownProfileScope = () => {};
`,
    );
  }
  const server = await createServer({
    root: repository,
    cacheDir: `node_modules/.vite-bottom-controls-${process.pid}`,
    configFile: false,
    logLevel: "error",
    optimizeDeps: { include: sharedImports },
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
      watch: null,
    },
    plugins: [
      {
        name: "bottom-controls-browser-fixture",
        enforce: "pre",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__bottom") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<div id="monsboard" style="position:absolute;top:0;left:0;width:100px;height:100px"></div><div id="root"></div><script type="module" src="/__bottom-harness.js"></script>',
            );
          });
        },
        resolveId(id, importer) {
          if (id === "/__bottom-harness.js") return "\0bottom-harness";
          if (modules.has(id)) return "\0" + id;
          if (realNavigation && importer?.endsWith("/AppSessionManager.ts")) {
            if (id === "../game/gameController") return "\0bottom-controller";
            if (id === "../lifecycle/lifecycleManager")
              return "\0bottom-lifecycle";
            if (id === "../game/mainGameLoadState") return "\0bottom-main-load";
          }
          if (
            importer?.endsWith("/BottomControls.tsx") &&
            replacements.has(id)
          ) {
            return "\0" + replacements.get(id);
          }
          if (
            importer?.endsWith("/outsideTapState.ts") &&
            id === "../../utils/misc"
          ) {
            return "\0" + replacements.get("../utils/misc");
          }
        },
        load(id) {
          return modules.get(id.slice(1));
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONS_BROWSER_EXECUTABLE
        ? { executablePath: process.env.MONS_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      hasTouch: mobile,
    });
    context.setDefaultTimeout(15000);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const start = new Date("2026-01-01T00:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start);
    await page.goto(`${origin}/__bottom`);
    await page.waitForFunction(() => !!window.harness, null, { polling: 50 });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
const click = async (page, name) =>
  button(page, name).evaluate((element) =>
    window.harness.run(() => element.click()),
  );
const count = (page, name) => button(page, name).count();
const popupState = (page) =>
  page.evaluate(() => ({
    appearance: !!document.querySelector('[data-testid="appearance-picker"]'),
    history: !!document.querySelector('[data-testid="history-popup"]'),
    navigation: window.harness.port.hasNavigationPopupVisible(),
    reaction: [...document.querySelectorAll("button")].some(
      (element) => element.textContent === "yo",
    ),
    bottom: window.harness.port.hasBottomPopupsVisible(),
  }));
const showPopupControls = (page) =>
  page.evaluate(() =>
    window.harness.run(() => {
      window.harness.port.showMoveHistoryButton(true);
      window.harness.port.showVoiceReactionButton(true);
      window.harness.port.showResignButton();
    }),
  );
const startAutomatch = async (page) => {
  await page.evaluate(() =>
    window.harness.run(() => {
      window.harness.port.setAutomatchVisible(true);
      window.harness.port.setAutomatchEnabled(true);
    }),
  );
  await click(page, "Automatch");
};
const enterEventGame = async (
  page,
  inviteId = "event-game-1",
  eventId = "event-1",
) => {
  await page.evaluate(
    ({ inviteId, eventId }) => {
      window.harness.navigate({ mode: "invite", inviteId, path: inviteId });
      window.harness.updateConnection({
        inviteId,
        eventId,
        eventOwned: true,
        online: true,
      });
      window.harness.publishEvent(eventId, [1, 2, 3]);
    },
    { inviteId, eventId },
  );
};
const activeEventSubscriptions = (page) =>
  page.evaluate(() =>
    window.harness.environment.eventSubscriptions
      .filter((subscription) => subscription.active)
      .map((subscription) => subscription.eventId),
  );
const rememberEventButton = (page) =>
  button(page, "Event").evaluate((element) => {
    window.savedEventButton = element;
    window.savedEventAvatars = [...element.querySelectorAll("img")];
    window.savedEventSubscription =
      window.harness.environment.eventSubscriptions.findLast(
        (subscription) => subscription.active,
      );
    window.savedEventSubscriptionCount =
      window.harness.environment.eventSubscriptions.length;
  });
const assertEventButtonRetained = async (page) => {
  assert.deepEqual(
    await button(page, "Event").evaluate((element) => {
      const avatars = [...element.querySelectorAll("img")];
      return {
        sameButton: element === window.savedEventButton,
        sameAvatars:
          avatars.length === 3 &&
          avatars.every(
            (avatar, index) => avatar === window.savedEventAvatars[index],
          ),
        avatarUrls: avatars.map((avatar) => avatar.getAttribute("src")),
        subscriptionActive: window.savedEventSubscription.active,
        subscriptionUnchanged:
          window.harness.environment.eventSubscriptions.length ===
          window.savedEventSubscriptionCount,
      };
    }),
    {
      sameButton: true,
      sameAvatars: true,
      avatarUrls: ["/__emoji/1.svg", "/__emoji/2.svg", "/__emoji/3.svg"],
      subscriptionActive: true,
      subscriptionUnchanged: true,
    },
  );
};

test(
  "popup transitions preserve coexistence and keep navigation separate from bottom visibility",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await showPopupControls(page);
      await click(page, "Navigation");
      assert.deepEqual(await popupState(page), {
        appearance: false,
        history: false,
        navigation: true,
        reaction: false,
        bottom: false,
      });
      await page.evaluate(() =>
        window.harness.port.setWagerPanelVisibilityChecker(() => true),
      );
      assert.equal((await popupState(page)).bottom, true);
      await page.evaluate(() => window.harness.port.resetWagerPanelApi());
      assert.equal((await popupState(page)).bottom, false);
      await click(page, "Appearance");
      await click(page, "Move History");
      await click(page, "Navigation");
      assert.deepEqual(await popupState(page), {
        appearance: true,
        history: true,
        navigation: true,
        reaction: false,
        bottom: true,
      });
      await page.evaluate(() =>
        window.harness.run(() => window.harness.port.toggleReactionPicker()),
      );
      await click(page, "Resign");
      assert.deepEqual(await popupState(page), {
        appearance: true,
        history: false,
        navigation: true,
        reaction: true,
        bottom: true,
      });
      assert.equal(await count(page, "Resign"), 2);
      await page.evaluate(() =>
        window.harness.run(() => window.harness.port.toggleReactionPicker()),
      );
      assert.equal(await count(page, "Resign"), 2);
      await click(page, "Move History");
      assert.equal(await count(page, "Resign"), 1);
      assert.deepEqual(await popupState(page), {
        appearance: true,
        history: true,
        navigation: false,
        reaction: false,
        bottom: true,
      });
      await click(page, "Navigation");
      await click(page, "Appearance");
      assert.deepEqual(await popupState(page), {
        appearance: false,
        history: true,
        navigation: true,
        reaction: false,
        bottom: true,
      });
      await page.evaluate(() => window.harness.resetMatch());
      assert.deepEqual(await popupState(page), {
        appearance: false,
        history: false,
        navigation: false,
        reaction: false,
        bottom: false,
      });
    });
  },
);

for (const mobile of [false, true]) {
  test(
    `${mobile ? "touch" : "mouse"} input excludes each popup's trigger and content while dismissing outside`,
    { timeout: 60000 },
    async () => {
      await fixture(
        async (page) => {
          await showPopupControls(page);
          const activate = (target) =>
            mobile
              ? target.tap({ force: true })
              : target.click({ force: true });
          for (const [trigger, content, testId] of [
            ["Appearance", "Appearance contents", "appearance-picker"],
            ["Move History", "History contents", "history-popup"],
            ["Navigation", "Navigation contents", "navigation-picker"],
          ]) {
            await activate(button(page, trigger));
            assert.equal(await page.getByTestId(testId).count(), 1);
            await activate(button(page, content));
            assert.equal(await page.getByTestId(testId).count(), 1);
            await activate(button(page, trigger));
            assert.equal(await page.getByTestId(testId).count(), 0);
            await activate(button(page, trigger));
            await activate(page.locator("#monsboard"));
            assert.equal(await page.getByTestId(testId).count(), 0);
          }
          await activate(button(page, "Voice Reaction"));
          assert.equal(await count(page, "yo"), 1);
          await activate(button(page, "Voice Reaction"));
          assert.equal(await count(page, "yo"), 0);
          await activate(button(page, "Voice Reaction"));
          await activate(page.locator("#monsboard"));
          assert.equal(await count(page, "yo"), 0);
          await activate(button(page, "Voice Reaction"));
          await page.clock.runFor(500);
          await activate(button(page, "yo"));
          assert.equal(await count(page, "yo"), 0);
          await page.evaluate(() =>
            window.harness.run(() =>
              window.harness.port.showTimerButtonProgressing(1, 1, true),
            ),
          );
          await activate(button(page, "Timer"));
          assert.equal(await count(page, "Start a Timer"), 1);
          await activate(button(page, "Timer"));
          assert.equal(await count(page, "Start a Timer"), 0);
          await activate(button(page, "Timer"));
          await activate(page.locator("#monsboard"));
          assert.equal(await count(page, "Start a Timer"), 0);
          await activate(button(page, "Timer"));
          await activate(button(page, "Start a Timer"));
          assert.equal(await count(page, "Start a Timer"), 0);
          assert.deepEqual(
            await page.evaluate(() => window.harness.environment.calls),
            [["reaction", { kind: "yo" }], ["timer"]],
          );
        },
        { mobile },
      );
    },
  );
}

test(
  "event navigation survives outside and preserved closes, with ordinary close and expiry still dismissing",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await showPopupControls(page);
      await click(page, "Appearance");
      await click(page, "Navigation");
      await page.evaluate(() =>
        window.harness.publishNavigation([
          {
            id: "event-1",
            entityType: "event",
            eventId: "event-1",
            status: "active",
            sortBucket: 10,
            listSortAtMs: 1,
            participantPreview: [],
          },
        ]),
      );
      await click(page, "Open event-1");
      assert.equal(await page.getByTestId("appearance-picker").count(), 0);
      assert.equal((await popupState(page)).navigation, true);
      await click(page, "Voice Reaction");
      await page.evaluate(() =>
        window.harness.run(() => {
          window.harness.port.closeNavigationAndAppearancePopupIfAny({
            preserveNavigationSelection: true,
          });
          window.harness.port.setNavigationListButtonVisible(false);
        }),
      );
      await page.locator("#monsboard").click({ force: true });
      assert.deepEqual(await popupState(page), {
        appearance: false,
        history: false,
        navigation: true,
        reaction: false,
        bottom: false,
      });
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.closeNavigationAndAppearancePopupIfAny(),
        ),
      );
      assert.equal((await popupState(page)).navigation, false);
      await click(page, "Navigation");
      await page.evaluate(() => {
        window.harness.navigate({
          mode: "event",
          eventId: "event-1",
          path: "event/event-1",
        });
        window.harness.dismissEvent();
        window.harness.run(() =>
          window.harness.port.closeNavigationAndAppearancePopupIfAny({
            preserveNavigationSelection: true,
          }),
        );
      });
      assert.equal((await popupState(page)).navigation, true);
      await page.clock.runFor(10001);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setNavigationListButtonVisible(false),
        ),
      );
      assert.equal((await popupState(page)).navigation, false);
    });
  },
);

test(
  "ordinary transient closes cancel pending puzzle selection while preserved closes allow it",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (const preserveNavigationSelection of [false, true]) {
        await click(page, "Navigation");
        await page.evaluate(() => window.harness.holdHomeTransition());
        await click(page, "Open test puzzle");
        assert.equal((await popupState(page)).navigation, false);
        await page.evaluate(
          (preserveNavigationSelection) =>
            window.harness.run(() => {
              window.harness.port.closeNavigationAndAppearancePopupIfAny({
                preserveNavigationSelection,
              });
            }),
          preserveNavigationSelection,
        );
        await page.evaluate(() => window.harness.releaseHomeTransition());
        assert.equal(
          await page.evaluate(
            () =>
              window.harness.environment.calls.filter(
                ([name]) => name === "puzzle",
              ).length,
          ),
          preserveNavigationSelection ? 1 : 0,
        );
      }
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls.at(-1)),
        ["puzzle", "test-puzzle"],
      );
    });
  },
);

test(
  "reaction hiding resets wager selection and submitting captures the selected material and count",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        window.harness.environment.wagerEligible = true;
        window.harness.updateConnection({ online: true });
      });
      await showPopupControls(page);
      await click(page, "Voice Reaction");
      await click(page, "Propose a Wager");
      await click(page, "3");
      await click(page, "3");
      assert.equal(await count(page, "Propose 2"), 1);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showVoiceReactionButton(false),
        ),
      );
      assert.equal(await count(page, "Propose 2"), 0);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showVoiceReactionButton(true),
        ),
      );
      await click(page, "Voice Reaction");
      assert.equal(await count(page, "yo"), 1);
      await click(page, "Propose a Wager");
      assert.equal(await button(page, "Select a Material").isDisabled(), true);
      await click(page, "2");
      await click(page, "2");
      await click(page, "Propose 2");
      assert.equal(await count(page, "Propose 2"), 0);
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["wager", "slime", 2]],
      );
      await click(page, "Voice Reaction");
      await click(page, "yo");
      assert.equal(await button(page, "Voice Reaction").isDisabled(), true);
      await click(page, "Move History");
      await click(page, "Resign");
      await page.evaluate(() =>
        window.harness.run(() => window.harness.port.toggleReactionPicker()),
      );
      assert.equal(await count(page, "yo"), 0);
      assert.equal(await count(page, "Resign"), 2);
      assert.equal(await page.getByTestId("history-popup").count(), 1);
    });
  },
);

test(
  "event button survives real session navigation, queued overlays, and browser history while a game loads",
  { timeout: 60000 },
  async () => {
    await fixture(
      async (page) => {
        await page.waitForFunction(
          () => !window.harness.navigationState().transitioning,
        );
        await page.evaluate(() => {
          window.harness.updateConnection({
            inviteId: "event-game-1",
            eventId: "event-1",
            eventOwned: true,
            online: true,
          });
          window.harness.publishEvent("event-1", [1, 2, 3]);
        });
        await rememberEventButton(page);
        await click(page, "Event");
        await page.evaluate(() => {
          window.harness.holdBootstrap("event-game-2");
          window.harness.launchEventGame("event-game-2");
        });
        await page.waitForFunction(
          () =>
            window.harness.navigationState().bootstraps.at(-1) ===
            "event-game-2",
        );
        assert.deepEqual(
          await page.evaluate(() => {
            const { route, modal, transitioning } =
              window.harness.navigationState();
            return {
              inviteId: route.inviteId,
              closeReason: modal.lastCloseReason,
              transitioning,
            };
          }),
          {
            inviteId: "event-game-2",
            closeReason: "launch_game",
            transitioning: true,
          },
        );
        await assertEventButtonRetained(page);

        await click(page, "Event");
        assert.equal(
          await page.evaluate(
            () => window.harness.navigationState().modal.eventId,
          ),
          "event-1",
        );
        await assertEventButtonRetained(page);
        await page.evaluate(() =>
          window.harness.launchEventGame("event-game-2"),
        );
        await assertEventButtonRetained(page);

        await page.evaluate(() => window.history.back());
        await page.waitForFunction(
          () => window.harness.navigationState().modal.eventId === "event-1",
        );
        await assertEventButtonRetained(page);
        await page.evaluate(() => window.history.forward());
        await page.waitForFunction(
          () => !window.harness.navigationState().modal.isOpen,
        );
        await assertEventButtonRetained(page);

        await page.evaluate(() => window.harness.releaseBootstrap());
        await page.waitForFunction(
          () => !window.harness.navigationState().transitioning,
        );
        assert.deepEqual(
          await page.evaluate(
            () => window.harness.navigationState().bootstraps,
          ),
          ["event-game-1", "event-game-2"],
        );
        await page.evaluate(() =>
          window.harness.updateConnection({
            inviteId: "event-game-2",
            eventId: "event-1",
            eventOwned: true,
            online: true,
          }),
        );
        await assertEventButtonRetained(page);
      },
      { realNavigation: true },
    );
  },
);

test(
  "event game navigation retains the button, avatars, and subscription through slow loading and modal dismissal",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await enterEventGame(page);
      await rememberEventButton(page);
      await click(page, "Event");
      await page.evaluate(() => {
        window.harness.launchEventGame("event-game-2");
        window.harness.updateConnection();
        window.harness.resetMatch();
      });
      await assertEventButtonRetained(page);
      await page.clock.runFor(3001);
      await assertEventButtonRetained(page);
      await click(page, "Event");
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.eventModalState.eventId,
        ),
        "event-1",
      );
      await assertEventButtonRetained(page);
      await page.evaluate(() => window.harness.dismissEvent());
      await assertEventButtonRetained(page);
      await page.clock.runFor(10000);
      await assertEventButtonRetained(page);
      await page.evaluate(() =>
        window.harness.updateConnection({
          inviteId: "event-game-2",
          eventId: "event-1",
          eventOwned: true,
          online: true,
        }),
      );
      await assertEventButtonRetained(page);
      await page.evaluate(() => window.harness.dispose());
      assert.deepEqual(await activeEventSubscriptions(page), []);
      assert.deepEqual(
        await page.evaluate(() => ({
          modalListeners: window.harness.environment.eventModalListeners.size,
          navigationListeners:
            window.harness.environment.navigationListeners.size,
        })),
        { modalListeners: 0, navigationListeners: 0 },
      );
    });
  },
);

test(
  "rapid bracket selections retain the latest destination and ignore outgoing game metadata",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await enterEventGame(page);
      await page.evaluate(() => {
        window.harness.openEvent("event-2");
        window.harness.launchEventGame("event-2-game-1");
      });
      assert.deepEqual(await activeEventSubscriptions(page), ["event-2"]);
      await click(page, "Event");
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.eventModalState.eventId,
        ),
        "event-2",
      );
      await page.evaluate(() =>
        window.harness.launchEventGame("event-2-game-2"),
      );
      assert.deepEqual(await activeEventSubscriptions(page), ["event-2"]);
      await page.evaluate(() => {
        window.harness.openEvent("event-3");
        window.harness.launchEventGame("event-3-game-1");
        window.harness.updateConnection({
          inviteId: "event-2-game-2",
          eventId: "event-2",
          eventOwned: true,
          online: true,
        });
      });
      assert.deepEqual(await activeEventSubscriptions(page), ["event-3"]);
      await page.clock.runFor(3001);
      await click(page, "Event");
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.eventModalState.eventId,
        ),
        "event-3",
      );
      await page.evaluate(() => {
        window.harness.dismissEvent();
        window.harness.updateConnection({
          inviteId: "event-3-game-1",
          eventId: "event-3",
          eventOwned: true,
          online: true,
        });
      });
      assert.deepEqual(await activeEventSubscriptions(page), ["event-3"]);
    });
  },
);

test(
  "leaving a retained event game clears its button immediately and does not revive retention on return",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (const route of [
        { mode: "home", path: "" },
        { mode: "invite", inviteId: "unrelated-game", path: "unrelated-game" },
      ]) {
        await enterEventGame(page);
        await click(page, "Event");
        await page.evaluate(() =>
          window.harness.launchEventGame("event-game-2"),
        );
        assert.equal(await count(page, "Event"), 1);
        await page.evaluate((route) => window.harness.navigate(route), route);
        assert.equal(await count(page, "Event"), 0);
        assert.deepEqual(await activeEventSubscriptions(page), []);
        await page.evaluate(() => {
          window.harness.navigate({
            mode: "invite",
            inviteId: "event-game-2",
            path: "event-game-2",
          });
          window.harness.render();
        });
        assert.equal(await count(page, "Event"), 0);
      }
    });
  },
);

test(
  "destination metadata replaces retention when it reports no event, nonownership, or a different event",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (const destination of [
        { eventId: null, eventOwned: true, expectedEventId: null },
        { eventId: "event-1", eventOwned: false, expectedEventId: null },
        { eventId: "event-2", eventOwned: true, expectedEventId: "event-2" },
      ]) {
        await enterEventGame(page);
        await click(page, "Event");
        await page.evaluate(() => {
          window.harness.launchEventGame("event-game-2");
          window.harness.updateConnection();
        });
        assert.equal(await count(page, "Event"), 1);
        await page.evaluate(
          (destination) =>
            window.harness.updateConnection({
              inviteId: "event-game-2",
              online: true,
              ...destination,
            }),
          destination,
        );
        assert.deepEqual(
          await activeEventSubscriptions(page),
          destination.expectedEventId ? [destination.expectedEventId] : [],
        );
        assert.equal(
          await count(page, "Event"),
          destination.expectedEventId ? 1 : 0,
        );
        if (destination.expectedEventId) {
          await click(page, "Event");
          assert.equal(
            await page.evaluate(
              () => window.harness.environment.eventModalState.eventId,
            ),
            destination.expectedEventId,
          );
          await page.evaluate(() => window.harness.dismissEvent());
        }
        await page.evaluate(() => window.harness.updateConnection());
        assert.equal(await count(page, "Event"), 0);
      }
    });
  },
);

test(
  "BottomControls preserves synchronous controller callback ordering and exclusive confirmations",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const { port, environment, run } = window.harness;
        environment.callbacks.timer = () =>
          port.showTimerButtonProgressing(20, 20, true);
        environment.callbacks.claim = () => port.enableTimerVictoryClaim();
        environment.callbacks.primary = () =>
          port.showPrimaryAction(port.PrimaryActionType.Rematch);
        run(() => {
          port.setUndoVisible(true);
          port.setUndoEnabled(true);
          port.setAutomoveActionVisible(true);
          port.showResignButton();
          port.showTimerButtonProgressing(10, 10, true);
        });
      });
      assert.equal(await count(page, "Undo"), 0);
      assert.equal(await count(page, "Bot"), 0);
      await click(page, "Timer");
      assert.equal(await count(page, "Start a Timer"), 1);
      await click(page, "Start a Timer");
      assert.equal(await count(page, "Start a Timer"), 0);
      assert.equal(await button(page, "Timer").isDisabled(), true);
      await page.evaluate(() =>
        window.harness.run(() => window.harness.port.enableTimerVictoryClaim()),
      );
      await click(page, "Claim Victory");
      assert.equal(await count(page, "Claim Victory"), 2);
      await button(page, "Claim Victory")
        .last()
        .evaluate((element) => window.harness.run(() => element.click()));
      assert.equal(await count(page, "Claim Victory"), 1);
      assert.equal(await button(page, "Claim Victory").isDisabled(), true);
      await click(page, "Resign");
      assert.equal(await count(page, "Resign"), 2);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showTimerButtonProgressing(1, 1, true),
        ),
      );
      assert.equal(await count(page, "Resign"), 2);
      await click(page, "Timer");
      assert.equal(await count(page, "Resign"), 1);
      assert.equal(await count(page, "Start a Timer"), 1);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.disableAndHideUndoResignAndTimerControls(),
        ),
      );
      assert.equal(await count(page, "Resign"), 0);
      assert.equal(await count(page, "Start a Timer"), 0);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showPrimaryAction(
            window.harness.port.PrimaryActionType.JoinGame,
          ),
        ),
      );
      await click(page, "Join Game");
      assert.equal(await count(page, "Join Game"), 0);
      assert.equal(await count(page, "Play Again"), 0);
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["timer"], ["claim"], ["primary", "joinGame"]],
      );
    });
  },
);

test(
  "ending a match immediately shows Finished and removes Play Again",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const { port, environment, run } = window.harness;
        environment.callbacks.end = () => {
          port.showPrimaryAction(port.PrimaryActionType.None);
          port.setEndMatchConfirmed(true);
        };
        run(() => {
          port.setEndMatchVisible(true);
          port.showPrimaryAction(port.PrimaryActionType.Rematch);
        });
      });
      assert.equal(await button(page, "End Match").isDisabled(), false);
      assert.equal(await count(page, "Play Again"), 1);
      await click(page, "End Match");
      assert.equal(await button(page, "Finished").isDisabled(), true);
      assert.equal(await count(page, "End Match"), 0);
      assert.equal(await count(page, "Play Again"), 0);
      await click(page, "Finished");
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["end"]],
      );
    });
  },
);

test(
  "fresh automatch retains its 10-second Cancel deadline across waiting updates and pending navigation reveals immediately",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await startAutomatch(page);
      assert.equal(await count(page, "Cancel"), 0);
      await page.clock.runFor(3000);
      await page.evaluate(() =>
        window.harness.respondAutomatch(0, {
          ok: true,
          mode: "pending",
          inviteId: "fresh",
        }),
      );
      await page.clock.runFor(3000);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setAutomatchWaitingState(true),
        ),
      );
      await page.clock.runFor(3999);
      assert.equal(await count(page, "Cancel"), 0);
      await page.clock.runFor(1);
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setAutomatchWaitingState(false),
        ),
      );
      assert.equal(await count(page, "Cancel"), 0);
      assert.equal(await button(page, "Automatch").isDisabled(), true);
      await click(page, "Navigation");
      await page.evaluate(() => window.harness.publishPending("existing"));
      await click(page, "Open existing");
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setAutomatchWaitingState(true),
        ),
      );
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["connect", "existing"]],
      );
    });
  },
);

test(
  "automatch cancellation restores retry and ignores results from stale profiles",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.setAutomatchWaitingState(true),
        ),
      );
      await click(page, "Cancel");
      assert.equal(await button(page, "Canceling").isDisabled(), true);
      assert.equal(await count(page, "Automatching"), 0);
      await page.evaluate(() => window.harness.respondCancel(0, { ok: false }));
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() => window.harness.respondCancel(1, null, true));
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() => window.harness.render("b"));
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() => window.harness.respondCancel(2, { ok: true }));
      assert.equal(await button(page, "Canceling").isDisabled(), true);
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [],
      );
      await page.evaluate(() => window.harness.respondCancel(3, { ok: false }));
      await click(page, "Cancel");
      await page.evaluate(() => window.harness.respondCancel(4, { ok: true }));
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [["dismiss"], ["transitionHome", { forceMatchScopeReset: true }]],
      );
    });
  },
);

test(
  "foreground events recover timer and Cancel deadlines without waiting for throttled callbacks",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await startAutomatch(page);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showTimerButtonProgressing(0, 10, true),
        ),
      );
      assert.equal(await button(page, "Timer").isDisabled(), true);
      await page.clock.setSystemTime(new Date("2026-01-01T00:00:11Z"));
      assert.equal(await button(page, "Timer").isDisabled(), true);
      assert.equal(await count(page, "Cancel"), 0);
      await page.evaluate(() =>
        window.harness.run(() => {
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("focus"));
          window.dispatchEvent(new Event("pageshow"));
        }),
      );
      assert.equal(await button(page, "Timer").isDisabled(), false);
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        0,
      );
    });
  },
);

test(
  "match reset and StrictMode unmount clear deadlines, transient bindings, and late automatch responses",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.transientHandlers.size,
        ),
        1,
      );
      await startAutomatch(page);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showTimerButtonProgressing(0, 10, true),
        ),
      );
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        2,
      );
      await page.evaluate(() => window.harness.resetMatch());
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        0,
      );
      await page.clock.runFor(10001);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      assert.equal(await button(page, "Timer").isDisabled(), true);
      assert.equal(await count(page, "Cancel"), 0);
      await page.evaluate(() =>
        window.harness.run(() => {
          window.harness.port.setAutomatchWaitingState(false);
          window.harness.port.hideTimerButtons();
        }),
      );
      await startAutomatch(page);
      await page.evaluate(() =>
        window.harness.run(() =>
          window.harness.port.showTimerButtonProgressing(0, 10, true),
        ),
      );
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        2,
      );
      await page.evaluate(() => window.harness.dispose());
      assert.equal(
        await page.evaluate(() => window.harness.counters().uiTimeouts),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => window.harness.environment.transientHandlers.size,
        ),
        0,
      );
      await page.evaluate(() =>
        window.harness.respondAutomatch(1, { ok: false }, false),
      );
      await page.clock.runFor(10001);
      await page.evaluate(() =>
        window.harness.run(() => {
          window.harness.port.showResignButton();
          window.dispatchEvent(new Event("focus"));
        }),
      );
      assert.equal(await page.locator("#root").textContent(), "");
      assert.deepEqual(
        await page.evaluate(() => window.harness.environment.calls),
        [],
      );
    });
  },
);
