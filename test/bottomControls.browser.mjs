import { required } from "./fixtures/canonicalData.mjs";
import { browserServerOrigin } from "./browserViteServer.mjs";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
/** @type {typeof import("playwright")} */
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
  inviteRequests: [],
  subscriptions: [],
  eventSubscriptions: [],
  eventSnapshots: new Map(),
  activeContext: null,
  inviteEventId: null,
  inviteEventOwned: false,
  eventModalState: { isOpen: false, eventId: null, lastCloseReason: null },
  eventModalListeners: new Set(),
  navigationListeners: new Set(),
  transientHandlers: new Set(),
  wagerEligible: false,
  wagerPlayers: { playerUid: 'player', opponentUid: 'opponent', opponentProfileId: 'opponent-profile' },
  wagerState: null,
  wagerConfirmed: true,
  wagerListeners: new Set(),
  materialSnapshot: { availableMaterials: { dust: 3, slime: 2 }, frozenMaterialsStatus: 'ready', hasConfirmedSnapshot: true },
  materialListeners: new Set(),
  wagerSendGate: null,
  homeTransitionGate: null,
  rematchItems: [],
  rematchPreloads: [],
  rematchSelections: [],
  historySelectionResets: 0,
};
export const pendingGame = (inviteId) => ({
  id: inviteId, inviteId, entityType: 'game', kind: 'auto',
  status: 'pending', sortBucket: 20, listSortAtMs: 1,
});
`;
const controllerSource = `
import { updateGameControlsContext } from '/src/game/gameControlsStore.ts';
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
export const setOnlineGame = value => { isOnlineGame = value; updateGameControlsContext({ isOnlineGame: value }); };
export const isWatchOnly = false;
export const getRematchSeriesNavigatorItems = () => environment.rematchItems;
export const preloadRematchSeriesScores = () => new Promise((resolve, reject) => environment.rematchPreloads.push({ resolve, reject }));
export const didClickUndoButton = () => invoke('undo');
export const didClickAutomoveButton = () => invoke('automove');
export const didClickHomeButton = () => invoke('home');
export const didClickInviteActionButtonBeforeThereIsInviteReady = () => {};
export const didClickStartBotGameButton = () => {};
export const didClickEndMatchButton = () => invoke('end');
export const didClickConfirmResignButton = () => invoke('resign');
export const playSameCompletedPuzzleAgain = () => {};
export const didSelectRematchSeriesMatch = matchId => new Promise(resolve => environment.rematchSelections.push({ matchId, resolve }));
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
  didClickInviteButton: callback => environment.inviteRequests.push(callback),
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
    if (environment.eventSnapshots.has(eventId)) update(environment.eventSnapshots.get(eventId));
    return () => { subscription.active = false; };
  },
  rematchSeriesEndIsIndicated: () => false,
  sendVoiceReaction: reaction => environment.calls.push(['reaction', reaction]),
  sendWagerProposal: async (material, count) => {
    environment.calls.push(['wager', material, count]);
    if (environment.wagerSendGate) await environment.wagerSendGate.promise;
  },
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
export const openEventModalPendingCreate = () => {
  closeEventModal();
  environment.eventModalState = { isOpen: true, eventId: null, lastCloseReason: null, isPendingCreate: true, pendingCreateError: null };
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
const wagerSource = `
import { environment } from 'bottom-environment';
export const hasConfirmedWagerSnapshot = () => environment.wagerConfirmed;
export const subscribeToWagerState = listener => {
  environment.wagerListeners.add(listener);
  listener(environment.wagerState);
  return () => environment.wagerListeners.delete(listener);
};
`;
const materialSource = `
import { useEffect, useState } from 'react';
import { environment } from 'bottom-environment';
export const useAvailableMaterials = () => {
  const [snapshot, setSnapshot] = useState(() => environment.materialSnapshot);
  useEffect(() => {
    environment.materialListeners.add(setSnapshot);
    setSnapshot(environment.materialSnapshot);
    return () => environment.materialListeners.delete(setSnapshot);
  }, []);
  return snapshot;
};
`;
const navigationSource = `
import React from 'react';
export default function NavigationPicker({ topGames, selectedNavigationItemId, onSelectGame, onSelectProblem }) {
  return React.createElement('div', {
    'data-testid': 'navigation-picker', style: { position: 'fixed', top: 150, right: 10 },
    'data-selected-navigation-item-id': selectedNavigationItemId,
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
import * as controlsStore from '/src/game/gameControlsStore.ts';
import { applyRouteControlsPreset, applyDisposedControlsPreset, applyGameplayControlsPreset } from '/src/game/sessionControls.ts';
import { triggerMoveHistoryPopupReload, subscribeMoveHistoryPopupSelectionReset } from '/src/ui/controls/moveHistoryPopupStore.ts';
import { getLifecycleCounters } from '/src/lifecycle/lifecycleDiagnostics.ts';
import { resolveNavigationGamesCacheScope, writeNavigationGamesRuntimeCache } from '/src/services/navigationGamesCache.ts';
import { environment, pendingGame } from 'bottom-environment';
import { setOnlineGame } from 'bottom-controller';
import { setRoute } from 'bottom-app-navigation';
import { openEventModal, closeEventModal, openEventModalPendingCreate } from 'bottom-event-modal';
let root = createRoot(document.getElementById('root'));
subscribeMoveHistoryPopupSelectionReset(() => environment.historySelectionResets++);
const run = callback => flushSync(callback);
const settle = async callback => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try { await act(callback); }
  finally { globalThis.IS_REACT_ACT_ENVIRONMENT = false; }
};
window.bottomControlsHarness = {
  required(value) { if (value === null || value === undefined) throw new Error("bottom-fixture-value-missing"); return value; },
  environment, port, run, controlsStore, applyRouteControlsPreset, applyDisposedControlsPreset, applyGameplayControlsPreset,
  render(profileId = 'a', authStatus = 'authenticated') {
    run(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(BottomControls, {
        authState: { profileId, authStatus, solAddress: '', ethAddress: '' },
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
  seedEventPreview(profileId, eventId, emojiIds) {
    writeNavigationGamesRuntimeCache(resolveNavigationGamesCacheScope(profileId), [{
      id: 'event_' + eventId, entityType: 'event', eventId, status: 'active',
      sortBucket: 40, listSortAtMs: 1, participantCount: emojiIds.length,
      startAtMs: null, updatedAtMs: null, endedAtMs: null, winnerDisplayName: null,
      participantPreview: emojiIds.map((emojiId, index) => ({
        profileId: profileId + '-' + index, displayName: 'Player ' + index, emojiId, aura: null,
      })),
    }], []);
  },
  publishRematches(items) {
    run(() => {
      environment.rematchItems = items;
      triggerMoveHistoryPopupReload();
    });
  },
  async respondRematchPreload(index, updates = [], reject = false) {
    await settle(async () => {
      environment.rematchItems = environment.rematchItems.map(item => ({
        ...item, ...updates.find(update => update.matchId === item.matchId),
      }));
      const request = environment.rematchPreloads[index];
      if (reject) request.reject(new Error('temporary score load failure'));
      else request.resolve(updates.length > 0);
    });
  },
  async respondRematchSelection(index, didSwitch) {
    await settle(async () => {
      const request = environment.rematchSelections[index];
      if (didSwitch) {
        environment.rematchItems = environment.rematchItems.map(item => ({
          ...item, isSelected: item.matchId === request.matchId,
        }));
        triggerMoveHistoryPopupReload();
      }
      request.resolve(didSwitch);
    });
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
  publishWager(state, confirmed = environment.wagerConfirmed) {
    run(() => {
      environment.wagerState = state;
      environment.wagerConfirmed = confirmed;
      environment.wagerListeners.forEach(listener => listener(state));
    });
  },
  holdWagerSend() { environment.wagerSendGate = Promise.withResolvers(); },
  async respondWagerSend(reject = false) {
    await settle(async () => {
      const pending = environment.wagerSendGate;
      environment.wagerSendGate = null;
      if (reject) pending.reject(new Error('temporary wager failure'));
      else pending.resolve();
    });
  },
  publishMaterials(updates) {
    run(() => {
      environment.materialSnapshot = { ...environment.materialSnapshot, ...updates };
      environment.materialListeners.forEach(listener => listener(environment.materialSnapshot));
    });
  },
  setWagerEligibility({ context = {}, playerUid = 'player', opponentUid = 'opponent', opponentProfileId = 'opponent-profile', profileId = 'a', authStatus = 'authenticated' } = {}) {
    run(() => {
      environment.wagerEligible = true;
      environment.wagerPlayers = { playerUid, opponentUid, opponentProfileId };
      controlsStore.updateGameControlsContext({ isOnlineGame: true, isWatchOnly: false, isGameWithBot: false, isGameOver: false, boardViewMode: 'activeLive', ...context });
    });
    window.bottomControlsHarness.render(profileId, authStatus);
  },
  wagerSubscriptions: () => ({ wager: environment.wagerListeners.size, materials: environment.materialListeners.size }),
  updateConnection({ inviteId = null, eventId = null, eventOwned = false, online = false } = {}) {
    environment.activeContext = inviteId ? { inviteId, matchId: inviteId, canWrite: false, contextId: 1 } : null;
    environment.inviteEventId = eventId;
    environment.inviteEventOwned = eventOwned;
    setOnlineGame(online);
    window.bottomControlsHarness.render();
  },
  navigate(route) { run(() => setRoute(route)); },
  openEvent(eventId) { run(() => openEventModal(eventId)); },
  openPendingEvent() { run(() => openEventModalPendingCreate()); },
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
  publishEventParticipants(eventId, participants) {
    run(() => environment.eventSubscriptions.findLast(subscription => subscription.active && subscription.eventId === eventId).update({
      participants: Object.fromEntries(participants.map((participant, index) => [index, {
        profileId: 'participant-' + index, displayName: 'Player ' + index, ...participant,
      }])),
    }));
  },
  counters: getLifecycleCounters,
  remount() {
    run(() => root.unmount());
    root = createRoot(document.getElementById('root'));
    window.bottomControlsHarness.render();
  },
  dispose() { run(() => root.unmount()); },
};
`;

const realNavigationHarnessSource = `
import * as session from '/src/session/AppSessionManager.ts';
import * as modal from '/src/ui/event/modalState.ts';
import * as navigation from '/src/navigation/appNavigation.ts';
import { getCurrentRouteState, getRoutePathForTarget } from '/src/navigation/routeState.ts';
import { connection } from 'bottom-connection';
Object.assign(window.bottomControlsHarness, {
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

/** @param {(page: import("playwright").Page) => Promise<void>} run @param {{realNavigation?: boolean, mobile?: boolean, mount?: boolean, productionStyles?: boolean}} [options] */
async function fixture(
  run,
  {
    realNavigation = false,
    mobile = false,
    mount = true,
    productionStyles = false,
  } = {},
) {
  const modules = new Map([
    ["bottom-environment", environmentSource],
    ["bottom-controller", controllerSource],
    ["bottom-connection", connectionSource],
    ["bottom-session", sessionSource],
    ["bottom-transient", transientSource],
    ["bottom-navigation", navigationSource],
    ["bottom-app-navigation", appNavigationSource],
    ["bottom-event-modal", eventModalSource],
    [
      "bottom-harness",
      harnessSource + (mount ? "\nwindow.bottomControlsHarness.render();" : ""),
    ],
  ]);
  const replacements = new Map([
    ["../game/gameController", "bottom-controller"],
    ["../connection/connection", "bottom-connection"],
    ["../session/AppSessionManager", "bottom-session"],
    ["./uiSession", "bottom-transient"],
    ["./NavigationPicker", "bottom-navigation"],
    ["../navigation/appNavigation", "bottom-app-navigation"],
    ["./event/modalState", "bottom-event-modal"],
  ]);
  const stubs = new Map([
    ["../hooks/useAvailableMaterials", materialSource],
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
      "import { environment } from 'bottom-environment'; export const showVoiceReactionText = () => {}; export const showVideoReaction = () => {}; export const isMetadataSideDisplayedAtOpponentSlot = () => false; export const getPlayerReactionUid = () => environment.wagerEligible ? environment.wagerPlayers.playerUid : null; export const getOpponentReactionUid = () => environment.wagerEligible ? environment.wagerPlayers.opponentUid : null;",
    ],
    [
      "./controls/useReactionPicker",
      "export const STICKER_IMAGE_BASE_URL = ''; export const useReactionPicker = () => ({ visibleStickerIds: [], hasFreshStickerEntitlement: false, stickerUrls: {}, canSendSticker: () => false });",
    ],
    ["./controls/menuPort", "export const closeMenuAndInfoIfAny = () => {};"],
    [
      "./BoardStylePicker",
      "import React from 'react'; export default () => React.createElement('div', { 'data-testid': 'appearance-picker', style: { position: 'fixed', top: 150, left: 10 } }, React.createElement('button', null, 'Appearance contents'));",
    ],
    ["../utils/gameModels", "export const Sound = {};"],
    [
      "./MoveHistoryPopup",
      "import React from 'react'; export default ({ ref }) => React.createElement('div', { ref, 'data-testid': 'history-popup', style: { position: 'fixed', top: 200, left: 10 } }, React.createElement('button', null, 'History contents'));",
    ],
    [
      "../services/rocksMiningService",
      "export const MATERIALS = ['dust', 'slime'];",
    ],
    ["../game/wagerState", wagerSource],
    [
      "../utils/playerMetadata",
      "import { environment } from 'bottom-environment'; export const getStashedPlayerProfile = () => environment.wagerEligible ? { id: environment.wagerPlayers.opponentProfileId } : undefined;",
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
    for (const id of /** @type {const} */ ([
      "../session/AppSessionManager",
      "../navigation/appNavigation",
      "../navigation/routeState",
      "./event/modalState",
    ])) {
      replacements.delete(id);
    }
    modules.set(
      "bottom-harness",
      harnessSource +
        realNavigationHarnessSource +
        (mount ? "\nwindow.bottomControlsHarness.render();" : ""),
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
  setOnlineGame(target.mode === 'invite');
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
  if (productionStyles) {
    modules.set(
      "bottom-harness",
      'import "/src/index.css";\n' + modules.get("bottom-harness"),
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
          const isControlsModule =
            importer?.endsWith("/useAutomatchControls.ts") ||
            importer?.endsWith("/useEventNavigationControls.ts") ||
            importer?.endsWith("/useRematchSeries.ts") ||
            importer?.endsWith("/useReactionActions.ts") ||
            importer?.endsWith("/useWagerProposal.ts") ||
            importer?.endsWith("/WagerPicker.tsx");
          const replacementId =
            isControlsModule && id.startsWith("../../")
              ? id.slice(3)
              : isControlsModule && id === "./boardReactionPort"
                ? "./controls/boardReactionPort"
                : isControlsModule && id === "../event/modalState"
                  ? "./event/modalState"
                  : id;
          if (
            (importer?.endsWith("/BottomControls.tsx") || isControlsModule) &&
            replacements.has(replacementId)
          ) {
            return "\0" + replacements.get(replacementId);
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
  /** @type {import("playwright").Browser | undefined} */
  let browser;
  try {
    await server.listen();
    const origin = browserServerOrigin(server);
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
    /** @type {string[]} */
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const start = new Date("2026-01-01T00:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start);
    await page.goto(`${origin}/__bottom`);
    await page.waitForFunction(() => !!window.bottomControlsHarness, null, {
      polling: 50,
    });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

/** @param {import("playwright").Page} page @param {string} name */
const button = (page, name) => page.getByRole("button", { name, exact: true });
/** @param {import("playwright").Page} page @param {string} name */
const click = async (page, name) =>
  button(page, name).evaluate(
    /** @param {HTMLButtonElement} element */ (element) =>
      window.bottomControlsHarness.run(() => element.click()),
  );
/** @param {import("playwright").Page} page @param {string} name */
const count = (page, name) => button(page, name).count();
/** @param {import("playwright").Page} page @param {string} label */
const confirmationGeometry = (page, label) =>
  button(page, label)
    .last()
    .evaluate((action, label) => {
      const popup = window.bottomControlsHarness.required(action.parentElement);
      const container = window.bottomControlsHarness.required(
        popup.parentElement,
      );
      const trigger = container.querySelector(
        label === "Start a Timer"
          ? '[aria-label="Timer"]'
          : '[aria-label="Claim Victory"]',
      );
      /** @param {Element} element */
      const measure = (element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          rect: /** @type {[number, number, number, number]} */ ([
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
          ]),
          style: Object.fromEntries(
            /** @type {const} */ ([
              "display",
              "position",
              "bottom",
              "right",
              "left",
              "transform",
              "padding",
              "gap",
              "borderRadius",
              "backgroundColor",
              "color",
              "fontFamily",
              "fontSize",
            ]).map((key) => [key, style[key]]),
          ),
        };
      };
      return {
        trigger: measure(window.bottomControlsHarness.required(trigger)),
        container: measure(container),
        popup: measure(popup),
        action: measure(action),
        anchor: Number.parseFloat(popup.style.left),
      };
    }, label);

/** @param {Awaited<ReturnType<typeof confirmationGeometry>>} geometry */
const assertConfirmationAnchor = (geometry) => {
  const [triggerX, , triggerWidth] = geometry.trigger.rect;
  const [containerX, , containerWidth] = geometry.container.rect;
  const expected = Math.min(
    containerWidth - 16,
    Math.max(16, triggerX + triggerWidth / 2 - containerX),
  );
  assert.equal(geometry.anchor, expected);
  const [popupX, , popupWidth] = geometry.popup.rect;
  assert.ok(Math.abs(popupX + popupWidth / 2 - containerX - expected) < 0.02);
};

/** @param {string | undefined} baselineDirectory @param {string} outputDirectory */
const prepareConfirmationOutputDirectory = (
  baselineDirectory,
  outputDirectory,
) => {
  mkdirSync(outputDirectory, { recursive: true });
  if (baselineDirectory) {
    assert.notEqual(
      realpathSync(outputDirectory),
      realpathSync(baselineDirectory),
      "Confirmation baseline and output directories must be different",
    );
  }
};

for (const alias of /** @type {const} */ ([
  "same path",
  "relative path",
  "symlink",
])) {
  test(`confirmation capture rejects a shared directory via ${alias}`, (t) => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "mons-confirmation-guard-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const baselineDirectory = path.join(directory, "baseline");
    mkdirSync(baselineDirectory);
    const outputDirectory =
      alias === "relative path"
        ? path.relative(process.cwd(), baselineDirectory)
        : alias === "symlink"
          ? path.join(directory, "output")
          : baselineDirectory;
    if (alias === "symlink") {
      symlinkSync(baselineDirectory, outputDirectory, "dir");
    }
    const sentinels = ["1200x900-light-timer.png", "1200x900-light-timer.json"];
    for (const name of sentinels) {
      writeFileSync(path.join(baselineDirectory, name), "original baseline");
    }
    assert.throws(
      () =>
        prepareConfirmationOutputDirectory(baselineDirectory, outputDirectory),
      /Confirmation baseline and output directories must be different/,
    );
    for (const name of sentinels) {
      assert.equal(
        readFileSync(path.join(baselineDirectory, name), "utf8"),
        "original baseline",
      );
    }
  });
}

test(
  "confirmation placement preserves immediate, painted, and resized geometry",
  { timeout: 120000 },
  async (t) => {
    const baselineDirectory = process.env.MONS_BOTTOM_CONTROLS_BASELINE;
    const outputDirectory = path.resolve(
      process.env.MONS_BOTTOM_CONTROLS_OUTPUT ||
        "test-results/bottom-controls-current",
    );
    prepareConfirmationOutputDirectory(baselineDirectory, outputDirectory);
    let captures = 0;
    for (const mobile of /** @type {const} */ ([false, true])) {
      await fixture(
        async (page) => {
          const viewports = mobile
            ? [
                { width: 390, height: 844 },
                { width: 320, height: 568 },
                { width: 844, height: 390 },
              ]
            : [{ width: 1200, height: 900 }];
          for (const viewport of viewports) {
            for (const colorScheme of /** @type {const} */ ([
              "light",
              "dark",
            ])) {
              await page.setViewportSize(viewport);
              await page.emulateMedia({ colorScheme });
              await page.evaluate(() => document.fonts.ready);
              for (const label of /** @type {const} */ ([
                "Start a Timer",
                "Claim Victory",
              ])) {
                await page.evaluate((label) => {
                  const { port, run, applyDisposedControlsPreset } =
                    window.bottomControlsHarness;
                  run(() => {
                    applyDisposedControlsPreset(false);
                    port.setHomeVisible(true);
                    port.setNavigationListButtonVisible(true);
                    port.showMoveHistoryButton(true);
                    port.showVoiceReactionButton(true);
                    port.showResignButton();
                    if (label === "Start a Timer") {
                      port.showTimerButtonProgressing(10, 10, true);
                    } else {
                      port.enableTimerVictoryClaim();
                    }
                  });
                }, label);
                await page.clock.runFor(40);
                await click(page, label === "Start a Timer" ? "Timer" : label);
                const opening = await confirmationGeometry(page, label);
                assertConfirmationAnchor(opening);
                await page.clock.runFor(40);
                const painted = await confirmationGeometry(page, label);
                assert.deepEqual(painted, opening);
                await page.screenshot({ animations: "disabled" });
                const png = await page.screenshot({ animations: "disabled" });
                assert.ok(
                  png.equals(await page.screenshot({ animations: "disabled" })),
                  "confirmation capture must be stable",
                );
                await page.setViewportSize({
                  width: viewport.width - 37,
                  height: viewport.height - 19,
                });
                await page.evaluate(() =>
                  window.bottomControlsHarness.run(() =>
                    window.dispatchEvent(new Event("resize")),
                  ),
                );
                await page.clock.runFor(40);
                const resized = await confirmationGeometry(page, label);
                assertConfirmationAnchor(resized);
                await page.setViewportSize(viewport);
                await page.evaluate(() =>
                  window.bottomControlsHarness.run(() =>
                    window.dispatchEvent(new Event("resize")),
                  ),
                );
                await page.clock.runFor(40);
                const restored = await confirmationGeometry(page, label);
                assert.deepEqual(restored, painted);
                const geometry = { opening, painted, resized, restored };
                const name = `${viewport.width}x${viewport.height}-${colorScheme}-${label === "Start a Timer" ? "timer" : "claim"}`;
                writeFileSync(path.join(outputDirectory, name + ".png"), png);
                writeFileSync(
                  path.join(outputDirectory, name + ".json"),
                  JSON.stringify(geometry, null, 2),
                );
                if (baselineDirectory) {
                  assert.deepEqual(
                    geometry,
                    JSON.parse(
                      readFileSync(
                        path.join(baselineDirectory, name + ".json"),
                        "utf8",
                      ),
                    ),
                    name + ": confirmation geometry/styles changed",
                  );
                  assert.ok(
                    png.equals(
                      readFileSync(path.join(baselineDirectory, name + ".png")),
                    ),
                    name + ": confirmation screenshot changed",
                  );
                }
                captures += 1;
              }
            }
          }
        },
        { mobile, productionStyles: true },
      );
    }
    t.diagnostic(
      `${baselineDirectory ? "Compared" : "Captured"} ${captures} confirmation screenshots and geometry/style snapshots.`,
    );
  },
);

/** @param {import("playwright").Page} page */
const rematchButtons = (page) =>
  page.getByRole("group", { name: "Rematch series" }).getByRole("button");
/** @param {string} matchId @param {Partial<import("../src/game/gameController.ts").RematchSeriesNavigatorItem>} [overrides] */
const rematchItem = (matchId, overrides = {}) => ({
  matchId,
  index: 0,
  whiteScore: null,
  blackScore: null,
  isPendingResponse: false,
  isActiveMatch: false,
  isSelected: false,
  playerIsWhite: true,
  ...overrides,
});
/** @param {import("playwright").Page} page */
const popupState = (page) =>
  page.evaluate(() => ({
    appearance: !!document.querySelector('[data-testid="appearance-picker"]'),
    history: !!document.querySelector('[data-testid="history-popup"]'),
    navigation: window.bottomControlsHarness.port.hasNavigationPopupVisible(),
    reaction: [...document.querySelectorAll("button")].some(
      (element) => element.textContent === "yo",
    ),
    bottom: window.bottomControlsHarness.port.hasBottomPopupsVisible(),
  }));
/** @param {import("playwright").Page} page */
const showPopupControls = (page) =>
  page.evaluate(() =>
    window.bottomControlsHarness.run(() => {
      window.bottomControlsHarness.port.showMoveHistoryButton(true);
      window.bottomControlsHarness.port.showVoiceReactionButton(true);
      window.bottomControlsHarness.port.showResignButton();
    }),
  );
/** @param {import("playwright").Page} page */
const startAutomatch = async (page) => {
  await page.evaluate(() =>
    window.bottomControlsHarness.run(() => {
      window.bottomControlsHarness.port.setAutomatchVisible(true);
      window.bottomControlsHarness.port.setAutomatchEnabled(true);
    }),
  );
  await click(page, "Automatch");
};
/** @param {import("playwright").Page} page */
const enterEventGame = async (
  page,
  inviteId = "event-game-1",
  eventId = "event-1",
) => {
  await page.evaluate(
    ({ inviteId, eventId }) => {
      window.bottomControlsHarness.navigate({
        mode: "invite",
        inviteId,
        path: inviteId,
      });
      window.bottomControlsHarness.updateConnection({
        inviteId,
        eventId,
        eventOwned: true,
        online: true,
      });
      window.bottomControlsHarness.publishEvent(eventId, [1, 2, 3]);
    },
    { inviteId, eventId },
  );
};
/** @param {import("playwright").Page} page */
const activeEventSubscriptions = (page) =>
  page.evaluate(() =>
    window.bottomControlsHarness.environment.eventSubscriptions
      .filter((subscription) => subscription.active)
      .map((subscription) => subscription.eventId),
  );
/** @param {import("playwright").Page} page */
const eventAvatarSlots = (page) =>
  button(page, "Event").evaluate(
    /** @param {HTMLButtonElement} element */ (element) =>
      [...element.children]
        .filter((child) => child.tagName.toLowerCase() !== "svg")
        .map((child) => child.getAttribute("src")),
  );
/** @param {import("playwright").Page} page */
const rememberEventButton = (page) =>
  button(page, "Event").evaluate(
    /** @param {HTMLButtonElement} element */ (element) => {
      window.savedEventButton = element;
      window.savedEventAvatars = [...element.querySelectorAll("img")];
      window.savedEventSubscription = window.bottomControlsHarness.required(
        window.bottomControlsHarness.environment.eventSubscriptions.findLast(
          (subscription) => subscription.active,
        ),
      );
      window.savedEventSubscriptionCount =
        window.bottomControlsHarness.environment.eventSubscriptions.length;
    },
  );
/** @param {import("playwright").Page} page */
const assertEventButtonRetained = async (page) => {
  assert.deepEqual(
    await button(page, "Event").evaluate(
      /** @param {HTMLButtonElement} element */ (element) => {
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
            window.bottomControlsHarness.environment.eventSubscriptions
              .length === window.savedEventSubscriptionCount,
        };
      },
    ),
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
  "rematch scores refresh in player order and retry only while historical scores are missing",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const items = [
        rematchItem("previous"),
        rematchItem("live", {
          index: 1,
          whiteScore: 12,
          blackScore: 7,
          isActiveMatch: true,
          isSelected: true,
          playerIsWhite: false,
        }),
        rematchItem("pending", { index: 2, isPendingResponse: true }),
      ];
      await page.evaluate(
        (items) => window.bottomControlsHarness.publishRematches(items),
        items,
      );
      assert.equal(await rematchButtons(page).count(), 3);
      assert.equal(await rematchButtons(page).nth(0).textContent(), "·");
      assert.deepEqual(
        await rematchButtons(page).nth(1).locator("span").allTextContents(),
        ["12", "7"],
      );
      assert.equal(await rematchButtons(page).nth(2).locator("svg").count(), 1);
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchPreload(0, [], true),
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        1,
      );
      await page.clock.runFor(649);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.rematchPreloads.length,
        ),
        1,
      );
      await page.clock.runFor(1);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.rematchPreloads.length,
        ),
        2,
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchPreload(1, [
          { matchId: "previous", whiteScore: 15, blackScore: 9 },
        ]),
      );
      assert.deepEqual(
        await rematchButtons(page).nth(0).locator("span").allTextContents(),
        ["9", "15"],
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.publishRematches(
          window.bottomControlsHarness.environment.rematchItems.map((item) =>
            item.matchId === "live" ? { ...item, blackScore: 8 } : item,
          ),
        ),
      );
      assert.deepEqual(
        await rematchButtons(page).nth(1).locator("span").allTextContents(),
        ["12", "8"],
      );
      await page.clock.runFor(6500);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.rematchPreloads.length,
        ),
        2,
      );
    });
  },
);

test(
  "rematch score retries are bounded and cancelled on series changes, match reset, and unmount",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(
        (items) => window.bottomControlsHarness.publishRematches(items),
        [rematchItem("missing")],
      );
      for (let index = 0; index < 9; index++) {
        await page.evaluate(
          (index) => window.bottomControlsHarness.respondRematchPreload(index),
          index,
        );
        await page.clock.runFor(650);
      }
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.rematchPreloads.length,
        ),
        9,
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      await page.evaluate(
        (items) => window.bottomControlsHarness.publishRematches(items),
        [rematchItem("old-series")],
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.publishRematches([]),
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchPreload(9),
      );
      assert.equal(await rematchButtons(page).count(), 0);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      await page.evaluate(
        (items) => window.bottomControlsHarness.publishRematches(items),
        [rematchItem("reset-series")],
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchPreload(10),
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        1,
      );
      await page.evaluate(() => window.bottomControlsHarness.resetMatch());
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      await page.clock.runFor(650);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.rematchPreloads.length,
        ),
        11,
      );
      await page.evaluate(
        (items) => window.bottomControlsHarness.publishRematches(items),
        [rematchItem("unmounted-series")],
      );
      await page.evaluate(() => window.bottomControlsHarness.dispose());
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchPreload(11),
      );
      await page.clock.runFor(650);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.rematchPreloads.length,
        ),
        12,
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      assert.equal(await page.locator("#root").textContent(), "");
    });
  },
);

test(
  "rematch selection locks simultaneous clicks and resets move history only after a successful switch",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(
        (items) => window.bottomControlsHarness.publishRematches(items),
        [
          rematchItem("previous", { whiteScore: 15, blackScore: 9 }),
          rematchItem("live", {
            index: 1,
            whiteScore: 3,
            blackScore: 4,
            isActiveMatch: true,
            isSelected: true,
          }),
        ],
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchPreload(0),
      );
      assert.deepEqual(
        await rematchButtons(page).evaluateAll(
          /** @param {HTMLButtonElement[]} elements */ (elements) =>
            elements.map(
              (element) => getComputedStyle(element, "::before").display,
            ),
        ),
        ["none", "block"],
      );
      await rematchButtons(page).evaluateAll(
        /** @param {HTMLButtonElement[]} elements */ (elements) => {
          window.bottomControlsHarness.run(() => {
            window.bottomControlsHarness.required(elements[0]).click();
            window.bottomControlsHarness.required(elements[1]).click();
          });
        },
      );
      assert.deepEqual(
        await page.evaluate(() =>
          window.bottomControlsHarness.environment.rematchSelections.map(
            ({ matchId }) => matchId,
          ),
        ),
        ["previous"],
      );
      assert.equal(
        await rematchButtons(page).evaluateAll(
          /** @param {HTMLButtonElement[]} elements */ (elements) =>
            elements.every((element) => element.disabled),
        ),
        true,
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchSelection(0, true),
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.historySelectionResets,
        ),
        1,
      );
      assert.deepEqual(
        await rematchButtons(page).evaluateAll(
          /** @param {HTMLButtonElement[]} elements */ (elements) =>
            elements.map(
              (element) => getComputedStyle(element, "::before").display,
            ),
        ),
        ["block", "none"],
      );
      assert.equal(
        await rematchButtons(page).evaluateAll(
          /** @param {HTMLButtonElement[]} elements */ (elements) =>
            elements.every((element) => !element.disabled),
        ),
        true,
      );
      await rematchButtons(page)
        .nth(0)
        .evaluate(
          /** @param {HTMLButtonElement} element */ (element) =>
            window.bottomControlsHarness.run(() => element.click()),
        );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchSelection(1, false),
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.historySelectionResets,
        ),
        1,
      );
      assert.equal(await rematchButtons(page).nth(0).isDisabled(), false);
      await rematchButtons(page)
        .nth(1)
        .evaluate(
          /** @param {HTMLButtonElement} element */ (element) =>
            window.bottomControlsHarness.run(() => element.click()),
        );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondRematchSelection(2, true),
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.historySelectionResets,
        ),
        2,
      );
    });
  },
);

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
        window.bottomControlsHarness.port.setWagerPanelVisibilityChecker(
          () => true,
        ),
      );
      assert.equal((await popupState(page)).bottom, true);
      await page.evaluate(() =>
        window.bottomControlsHarness.port.resetWagerPanelApi(),
      );
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
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.toggleReactionPicker(),
        ),
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
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.toggleReactionPicker(),
        ),
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
      await page.evaluate(() => window.bottomControlsHarness.resetMatch());
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

for (const mobile of /** @type {const} */ ([false, true])) {
  test(
    `${mobile ? "touch" : "mouse"} input excludes each popup's trigger and content while dismissing outside`,
    { timeout: 60000 },
    async () => {
      await fixture(
        async (page) => {
          await showPopupControls(page);
          /** @param {import("playwright").Locator} target */
          const activate = (target) =>
            mobile
              ? target.tap({ force: true })
              : target.click({ force: true });
          for (const [trigger, content, testId] of /** @type {const} */ ([
            ["Appearance", "Appearance contents", "appearance-picker"],
            ["Move History", "History contents", "history-popup"],
            ["Navigation", "Navigation contents", "navigation-picker"],
          ])) {
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
            window.bottomControlsHarness.run(() =>
              window.bottomControlsHarness.port.showTimerButtonProgressing(
                1,
                1,
                true,
              ),
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
          await page.evaluate(() =>
            window.bottomControlsHarness.run(() =>
              window.bottomControlsHarness.port.enableTimerVictoryClaim(),
            ),
          );
          await activate(button(page, "Claim Victory"));
          assert.equal(await count(page, "Claim Victory"), 2);
          await button(page, "Claim Victory")
            .last()
            .locator("..")
            .dispatchEvent(mobile ? "touchstart" : "mousedown");
          assert.equal(await count(page, "Claim Victory"), 2);
          await activate(button(page, "Claim Victory").first());
          assert.equal(await count(page, "Claim Victory"), 1);
          await activate(button(page, "Claim Victory"));
          await activate(page.locator("#monsboard"));
          assert.equal(await count(page, "Claim Victory"), 1);
          await activate(button(page, "Claim Victory"));
          await activate(button(page, "Claim Victory").last());
          assert.equal(await count(page, "Claim Victory"), 1);
          assert.deepEqual(
            await page.evaluate(
              () => window.bottomControlsHarness.environment.calls,
            ),
            [["reaction", { kind: "yo" }], ["timer"], ["claim"]],
          );
        },
        { mobile },
      );
    },
  );
}

test(
  "event navigation survives reset presets and preserved closes, with ordinary close and expiry still dismissing",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await showPopupControls(page);
      await click(page, "Appearance");
      await click(page, "Navigation");
      await page.evaluate(() =>
        window.bottomControlsHarness.publishNavigation([
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
        window.bottomControlsHarness.run(() => {
          window.bottomControlsHarness.port.closeNavigationAndAppearancePopupIfAny(
            {
              preserveNavigationSelection: true,
            },
          );
          window.bottomControlsHarness.applyDisposedControlsPreset(false);
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
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.closeNavigationAndAppearancePopupIfAny(),
        ),
      );
      assert.equal((await popupState(page)).navigation, false);
      await click(page, "Navigation");
      await page.evaluate(() => {
        window.bottomControlsHarness.navigate({
          mode: "event",
          eventId: "event-1",
          path: "event/event-1",
        });
        window.bottomControlsHarness.dismissEvent();
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.closeNavigationAndAppearancePopupIfAny(
            {
              preserveNavigationSelection: true,
            },
          ),
        );
      });
      assert.equal((await popupState(page)).navigation, true);
      await page.clock.runFor(10001);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.applyDisposedControlsPreset(false),
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
      for (const preserveNavigationSelection of /** @type {const} */ ([
        false,
        true,
      ])) {
        await click(page, "Navigation");
        await page.evaluate(() =>
          window.bottomControlsHarness.holdHomeTransition(),
        );
        await click(page, "Open test puzzle");
        assert.equal((await popupState(page)).navigation, false);
        await page.evaluate(
          (preserveNavigationSelection) =>
            window.bottomControlsHarness.run(() => {
              window.bottomControlsHarness.port.closeNavigationAndAppearancePopupIfAny(
                {
                  preserveNavigationSelection,
                },
              );
            }),
          preserveNavigationSelection,
        );
        await page.evaluate(() =>
          window.bottomControlsHarness.releaseHomeTransition(),
        );
        assert.equal(
          await page.evaluate(
            () =>
              window.bottomControlsHarness.environment.calls.filter(
                ([name]) => name === "puzzle",
              ).length,
          ),
          preserveNavigationSelection ? 1 : 0,
        );
      }
      assert.deepEqual(
        await page.evaluate(() =>
          window.bottomControlsHarness.environment.calls.at(-1),
        ),
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
        window.bottomControlsHarness.environment.wagerEligible = true;
        window.bottomControlsHarness.updateConnection({ online: true });
      });
      await showPopupControls(page);
      await click(page, "Voice Reaction");
      await click(page, "Propose a Wager");
      await click(page, "3");
      await click(page, "3");
      assert.equal(await count(page, "Propose 2"), 1);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showVoiceReactionButton(false),
        ),
      );
      assert.equal(await count(page, "Propose 2"), 0);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showVoiceReactionButton(true),
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
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
        [["wager", "slime", 2]],
      );
      await click(page, "Voice Reaction");
      await click(page, "yo");
      assert.equal(await button(page, "Voice Reaction").isDisabled(), true);
      await click(page, "Move History");
      await click(page, "Resign");
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.toggleReactionPicker(),
        ),
      );
      assert.equal(await count(page, "yo"), 0);
      assert.equal(await count(page, "Resign"), 2);
      assert.equal(await page.getByTestId("history-popup").count(), 1);
    });
  },
);

test(
  "wager eligibility follows live confirmation, match, profile, and proposal updates",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        window.bottomControlsHarness.setWagerEligibility();
        window.bottomControlsHarness.publishWager(null, false);
      });
      await showPopupControls(page);
      await click(page, "Voice Reaction");
      assert.equal(await count(page, "Propose a Wager"), 0);
      await click(page, "Voice Reaction");
      await page.evaluate(() =>
        window.bottomControlsHarness.publishWager(null, true),
      );
      await click(page, "Voice Reaction");
      assert.equal(await count(page, "Propose a Wager"), 1);
      for (const confirmed of /** @type {const} */ ([false, true])) {
        await page.evaluate(
          (confirmed) =>
            window.bottomControlsHarness.publishWager(null, confirmed),
          confirmed,
        );
        assert.equal(await count(page, "Propose a Wager"), Number(confirmed));
      }
      for (const state of /** @type {const} */ ([
        { proposedBy: { player: true } },
        { proposals: { player: { material: "dust", count: 1 } } },
        { agreed: {} },
        { resolved: {} },
      ])) {
        await page.evaluate(
          (state) => window.bottomControlsHarness.publishWager(state),
          state,
        );
        assert.equal(
          await count(page, "Propose a Wager"),
          0,
          JSON.stringify(state),
        );
      }
      await page.evaluate(() =>
        window.bottomControlsHarness.publishWager({
          proposals: { opponent: { material: "dust", count: 1 } },
        }),
      );
      assert.equal(await count(page, "Propose a Wager"), 1);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishWager(null),
      );
      for (const eligibility of /** @type {const} */ ([
        { context: { isOnlineGame: false } },
        { context: { isWatchOnly: true } },
        { context: { isGameWithBot: true } },
        { context: { isGameOver: true } },
        { context: { boardViewMode: "historicalView" } },
        { context: { boardViewMode: "waitingLive" } },
        { authStatus: "unauthenticated" },
        { authStatus: "loading" },
        { profileId: "" },
        { playerUid: null },
        { opponentUid: null },
        { opponentProfileId: "" },
      ])) {
        await page.evaluate(
          (eligibility) =>
            window.bottomControlsHarness.setWagerEligibility(eligibility),
          eligibility,
        );
        assert.equal(
          await count(page, "Propose a Wager"),
          0,
          JSON.stringify(eligibility),
        );
        await page.evaluate(() =>
          window.bottomControlsHarness.setWagerEligibility(),
        );
        assert.equal(await count(page, "Propose a Wager"), 1);
      }
      await click(page, "Propose a Wager");
      await click(page, "3");
      await click(page, "3");
      await page.evaluate(() => {
        window.bottomControlsHarness.publishWager(null, false);
        window.bottomControlsHarness.publishMaterials({
          availableMaterials: { dust: 1, slime: 2 },
        });
      });
      assert.equal(await button(page, "Propose 2").isDisabled(), true);
      assert.equal(await button(page, "1").isDisabled(), false);
      assert.equal(await button(page, "2").isDisabled(), false);
      await click(page, "Propose 2");
      assert.deepEqual(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
        [],
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.publishWager(null, true),
      );
      assert.equal(await button(page, "Propose 2").isDisabled(), false);
      assert.equal(await count(page, "1"), 1);
    });
  },
);

test(
  "wager balance status and confirmation update independently without resetting selection",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        window.bottomControlsHarness.setWagerEligibility();
        window.bottomControlsHarness.publishMaterials({
          availableMaterials: { dust: 4, slime: 0 },
          hasConfirmedSnapshot: false,
        });
      });
      await showPopupControls(page);
      await click(page, "Voice Reaction");
      for (const frozenMaterialsStatus of /** @type {const} */ ([
        "loading",
        "unavailable",
      ])) {
        await page.evaluate(
          (frozenMaterialsStatus) =>
            window.bottomControlsHarness.publishMaterials({
              frozenMaterialsStatus,
            }),
          frozenMaterialsStatus,
        );
        assert.equal(await count(page, "Propose a Wager"), 1);
      }
      await click(page, "Propose a Wager");
      assert.equal(
        await button(page, "Balance unavailable").isDisabled(),
        true,
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.publishMaterials({
          frozenMaterialsStatus: "ready",
        }),
      );
      const picker = button(page, "Select a Material").locator("..");
      const materials = picker.locator(":scope > div > button");
      assert.deepEqual(await materials.allTextContents(), ["—", "—"]);
      assert.equal(await materials.nth(0).isDisabled(), false);
      assert.equal(await materials.nth(1).isDisabled(), true);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishMaterials({
          hasConfirmedSnapshot: true,
        }),
      );
      assert.deepEqual(await materials.allTextContents(), ["4", "0"]);
      await click(page, "4");
      for (const status of /** @type {const} */ ([
        "idle",
        "loading",
        "updating",
        "unavailable",
        "ready",
      ])) {
        await page.evaluate(
          (frozenMaterialsStatus) =>
            window.bottomControlsHarness.publishMaterials({
              frozenMaterialsStatus,
            }),
          status,
        );
        const label =
          status === "ready"
            ? "Propose 1"
            : status === "unavailable"
              ? "Balance unavailable"
              : "Checking balance";
        const action = button(page, label);
        assert.equal(await action.isDisabled(), status !== "ready");
        const currentMaterials = action
          .locator("..")
          .locator(":scope > div > button");
        assert.equal(
          await currentMaterials.nth(0).isDisabled(),
          status !== "ready",
        );
        assert.equal(await currentMaterials.nth(1).isDisabled(), true);
        assert.deepEqual(await currentMaterials.allTextContents(), ["4", "0"]);
        if (status !== "ready") {
          await click(page, "4");
          await click(page, label);
        }
      }
      await page.evaluate(() =>
        window.bottomControlsHarness.publishMaterials({
          hasConfirmedSnapshot: false,
        }),
      );
      assert.equal(await button(page, "Propose 1").isDisabled(), false);
      assert.deepEqual(
        await button(page, "Propose 1")
          .locator("..")
          .locator(":scope > div > button")
          .allTextContents(),
        ["—", "—"],
      );
      assert.deepEqual(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
        [],
      );
    });
  },
);

for (const mobile of /** @type {const} */ ([false, true])) {
  test(
    `wager ${mobile ? "touch" : "mouse"} submission preserves direct children, selection, dismissal, and caught rejection`,
    { timeout: 60000 },
    async () => {
      await fixture(
        async (page) => {
          await page.evaluate(() =>
            window.bottomControlsHarness.setWagerEligibility(),
          );
          await showPopupControls(page);
          /** @param {string} name */
          const activate = (name) =>
            mobile
              ? button(page, name).tap({ force: true })
              : button(page, name).click({ force: true });
          for (const reject of /** @type {const} */ ([false, true])) {
            await activate("Voice Reaction");
            await activate("Propose a Wager");
            assert.equal(
              await button(page, "Select a Material").isDisabled(),
              true,
            );
            assert.deepEqual(
              await button(page, "Select a Material").evaluate((action) => {
                const picker = window.bottomControlsHarness.required(
                  action.parentElement,
                );
                const grid = window.bottomControlsHarness.required(
                  picker.lastElementChild,
                );
                return {
                  children: [...picker.children].map(
                    (element) => element.tagName,
                  ),
                  gridChildren: [...grid.children].map(
                    (element) => element.tagName,
                  ),
                  pickerDisplay: getComputedStyle(picker).display,
                  gridDisplay: getComputedStyle(grid).display,
                };
              }),
              {
                children: ["BUTTON", "DIV"],
                gridChildren: ["BUTTON", "BUTTON"],
                pickerDisplay: "flex",
                gridDisplay: "flex",
              },
            );
            await activate("3");
            await activate("3");
            await activate("2");
            await activate("2");
            await activate("2");
            assert.equal(await count(page, "Propose 2"), 1);
            await page.evaluate(() =>
              window.bottomControlsHarness.holdWagerSend(),
            );
            await activate("Propose 2");
            assert.equal(await count(page, "Propose 2"), 0);
            assert.equal(
              await page.evaluate(
                () =>
                  window.bottomControlsHarness.environment.wagerSendGate !==
                  null,
              ),
              true,
            );
            await activate("Voice Reaction");
            assert.equal(await count(page, "yo"), 1);
            await activate("Propose a Wager");
            assert.equal(
              await button(page, "Select a Material").isDisabled(),
              true,
            );
            const outside = page.locator("#monsboard");
            if (mobile) await outside.tap({ force: true });
            else await outside.click({ force: true });
            assert.equal(await count(page, "Select a Material"), 0);
            await page.evaluate(
              (reject) => window.bottomControlsHarness.respondWagerSend(reject),
              reject,
            );
            assert.equal(await count(page, "yo"), 0);
            assert.equal(await count(page, "Select a Material"), 0);
            assert.deepEqual(
              await page.evaluate(
                () => window.bottomControlsHarness.environment.calls,
              ),
              Array.from({ length: reject ? 2 : 1 }, () => [
                "wager",
                "slime",
                2,
              ]),
            );
          }
        },
        { mobile, productionStyles: true },
      );
    },
  );
}

test(
  "wager subscriptions stay active while closed and clean up through StrictMode and remounts",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const subscriptions = () =>
        page.evaluate(() => window.bottomControlsHarness.wagerSubscriptions());
      assert.deepEqual(await subscriptions(), { wager: 2, materials: 1 });
      await page.evaluate(() => {
        window.bottomControlsHarness.setWagerEligibility();
        window.bottomControlsHarness.publishWager({ agreed: {} });
        window.bottomControlsHarness.publishMaterials({
          availableMaterials: { dust: 5, slime: 0 },
        });
      });
      assert.deepEqual(await subscriptions(), { wager: 2, materials: 1 });
      await showPopupControls(page);
      await click(page, "Voice Reaction");
      assert.equal(await count(page, "Propose a Wager"), 0);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishWager(null),
      );
      await click(page, "Propose a Wager");
      assert.equal(await count(page, "5"), 1);
      await click(page, "Voice Reaction");
      assert.deepEqual(await subscriptions(), { wager: 2, materials: 1 });
      await page.evaluate(() => window.bottomControlsHarness.remount());
      assert.deepEqual(await subscriptions(), { wager: 2, materials: 1 });
      await showPopupControls(page);
      await click(page, "Voice Reaction");
      await click(page, "Propose a Wager");
      assert.equal(await count(page, "5"), 1);
      await page.evaluate(() => window.bottomControlsHarness.dispose());
      assert.deepEqual(await subscriptions(), { wager: 0, materials: 0 });
      await page.evaluate(() => {
        window.bottomControlsHarness.publishWager(null, false);
        window.bottomControlsHarness.publishMaterials({
          frozenMaterialsStatus: "unavailable",
        });
      });
    });
  },
);

test(
  "event navigation selection follows overlays and routes while pending creation permits dismissal",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const selectedItem = () =>
        page
          .getByTestId("navigation-picker")
          .getAttribute("data-selected-navigation-item-id");
      await page.evaluate(() => {
        window.bottomControlsHarness.navigate({
          mode: "invite",
          inviteId: "selected-game",
          path: "selected-game",
        });
        window.bottomControlsHarness.render();
      });
      await click(page, "Navigation");
      assert.equal(await selectedItem(), "selected-game");
      await page.evaluate(() => {
        window.bottomControlsHarness.openEvent("overlay-event");
        window.bottomControlsHarness.navigate({
          mode: "event",
          eventId: "route-event",
          path: "event/route-event",
        });
        window.bottomControlsHarness.render();
      });
      assert.equal(await selectedItem(), "event_overlay-event");
      await page.evaluate(() => {
        window.bottomControlsHarness.dismissEvent();
        window.bottomControlsHarness.navigate({
          mode: "event",
          eventId: "route-event",
          path: "event/route-event",
        });
        window.bottomControlsHarness.render();
      });
      assert.equal(await selectedItem(), "event_route-event");
      await page.evaluate(() => {
        window.bottomControlsHarness.navigate({ mode: "home", path: "" });
        window.bottomControlsHarness.render();
      });
      assert.equal(await selectedItem(), null);
      await page.evaluate(() => {
        window.bottomControlsHarness.navigate({
          mode: "invite",
          inviteId: "selected-game",
          path: "selected-game",
        });
        window.bottomControlsHarness.openPendingEvent();
        window.bottomControlsHarness.render();
      });
      assert.equal(await selectedItem(), "selected-game");
      assert.deepEqual(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.eventModalState,
        ),
        {
          isOpen: true,
          eventId: null,
          lastCloseReason: null,
          isPendingCreate: true,
          pendingCreateError: null,
        },
      );
      await page.locator("#monsboard").click({ force: true });
      assert.equal((await popupState(page)).navigation, false);
      await click(page, "Navigation");
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.setNavigationListButtonVisible(
            false,
          ),
        ),
      );
      assert.equal((await popupState(page)).navigation, false);
    });
  },
);

test(
  "event navigation avatars grow from cached previews in join order and freeze at four slots",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        window.bottomControlsHarness.seedEventPreview("a", "event-1", [9]);
        window.bottomControlsHarness.navigate({
          mode: "invite",
          inviteId: "event-game-1",
          path: "event-game-1",
        });
        window.bottomControlsHarness.updateConnection({
          inviteId: "event-game-1",
          eventId: "event-1",
          eventOwned: true,
          online: true,
        });
      });
      assert.deepEqual(await eventAvatarSlots(page), ["/__emoji/9.svg"]);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishEventParticipants("event-1", [
          { emojiId: 3, joinedAtMs: 30 },
          { emojiId: 1, joinedAtMs: 10 },
          { emojiId: null, joinedAtMs: 20 },
        ]),
      );
      const threeSlots = ["/__emoji/1.svg", null, "/__emoji/3.svg"];
      assert.deepEqual(await eventAvatarSlots(page), threeSlots);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishEvent("event-1", [8, 7, 6]),
      );
      assert.deepEqual(await eventAvatarSlots(page), threeSlots);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishEvent("event-1", [8]),
      );
      assert.deepEqual(await eventAvatarSlots(page), threeSlots);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishEventParticipants("event-1", [
          { emojiId: 5, joinedAtMs: 50 },
          { emojiId: 4, joinedAtMs: 40 },
          { joinedAtMs: 20 },
          { emojiId: 3, joinedAtMs: 30 },
          { emojiId: 1, joinedAtMs: 10 },
        ]),
      );
      const fourSlots = [...threeSlots, "/__emoji/4.svg"];
      assert.deepEqual(await eventAvatarSlots(page), fourSlots);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishEvent("event-1", [9, 8, 7, 6, 5]),
      );
      assert.deepEqual(await eventAvatarSlots(page), fourSlots);
    });
  },
);

test(
  "event navigation synchronous snapshots can fill cached avatar previews",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        window.bottomControlsHarness.seedEventPreview("a", "event-1", [9]);
        window.bottomControlsHarness.environment.eventSnapshots.set("event-1", {
          participants: {
            second: { profileId: "second", emojiId: 2, joinedAtMs: 2 },
            first: { profileId: "first", emojiId: 1, joinedAtMs: 1 },
          },
        });
        window.bottomControlsHarness.navigate({
          mode: "invite",
          inviteId: "event-game-1",
          path: "event-game-1",
        });
        window.bottomControlsHarness.updateConnection({
          inviteId: "event-game-1",
          eventId: "event-1",
          eventOwned: true,
          online: true,
        });
      });
      assert.deepEqual(await eventAvatarSlots(page), [
        "/__emoji/1.svg",
        "/__emoji/2.svg",
      ]);
      assert.deepEqual(await activeEventSubscriptions(page), ["event-1"]);
    });
  },
);

test(
  "event navigation discards event callbacks after switching events and unmounting",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await enterEventGame(page);
      await page.evaluate(() => {
        window.oldEventSubscription = window.bottomControlsHarness.required(
          window.bottomControlsHarness.environment.eventSubscriptions.findLast(
            (subscription) => subscription.active,
          ),
        );
        window.bottomControlsHarness.updateConnection({
          inviteId: "event-game-1",
          eventId: "event-2",
          eventOwned: true,
          online: true,
        });
        window.bottomControlsHarness.publishEvent("event-2", [7]);
        window.bottomControlsHarness.run(() =>
          window.oldEventSubscription.update({
            participants: {
              old: { profileId: "old", emojiId: 9, joinedAtMs: 1 },
              older: { profileId: "older", emojiId: 8, joinedAtMs: 2 },
            },
          }),
        );
      });
      assert.equal(
        await page.evaluate(() => window.oldEventSubscription.active),
        false,
      );
      assert.deepEqual(await eventAvatarSlots(page), ["/__emoji/7.svg"]);
      assert.deepEqual(await activeEventSubscriptions(page), ["event-2"]);
      await page.evaluate(() => {
        window.oldEventSubscription = window.bottomControlsHarness.required(
          window.bottomControlsHarness.environment.eventSubscriptions.findLast(
            (subscription) => subscription.active,
          ),
        );
        window.bottomControlsHarness.remount();
        window.bottomControlsHarness.publishEvent("event-2", [6]);
        window.bottomControlsHarness.run(() =>
          window.oldEventSubscription.update({
            participants: {
              old: { profileId: "old", emojiId: 9, joinedAtMs: 1 },
              older: { profileId: "older", emojiId: 8, joinedAtMs: 2 },
            },
          }),
        );
      });
      assert.equal(
        await page.evaluate(() => window.oldEventSubscription.active),
        false,
      );
      assert.deepEqual(await eventAvatarSlots(page), ["/__emoji/6.svg"]);
      assert.deepEqual(await activeEventSubscriptions(page), ["event-2"]);
    });
  },
);

test(
  "event navigation resets cached avatars when profiles change within the same event",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        window.bottomControlsHarness.seedEventPreview("a", "event-1", [1, 2]);
        window.bottomControlsHarness.seedEventPreview("b", "event-1", [7]);
        window.bottomControlsHarness.navigate({
          mode: "invite",
          inviteId: "event-game-1",
          path: "event-game-1",
        });
        window.bottomControlsHarness.updateConnection({
          inviteId: "event-game-1",
          eventId: "event-1",
          eventOwned: true,
          online: true,
        });
      });
      assert.deepEqual(await eventAvatarSlots(page), [
        "/__emoji/1.svg",
        "/__emoji/2.svg",
      ]);
      await page.evaluate(() => {
        window.profileEventSubscription = window.bottomControlsHarness.required(
          window.bottomControlsHarness.environment.eventSubscriptions.findLast(
            (subscription) => subscription.active,
          ),
        );
        window.profileEventSubscriptionCount =
          window.bottomControlsHarness.environment.eventSubscriptions.length;
        window.bottomControlsHarness.publishEvent("event-1", [3, 4, 5]);
      });
      assert.deepEqual(await eventAvatarSlots(page), [
        "/__emoji/3.svg",
        "/__emoji/4.svg",
        "/__emoji/5.svg",
      ]);
      await page.evaluate(() => window.bottomControlsHarness.render("b"));
      assert.deepEqual(await eventAvatarSlots(page), ["/__emoji/7.svg"]);
      await page.evaluate(() => window.bottomControlsHarness.render("a"));
      assert.deepEqual(await eventAvatarSlots(page), []);
      await page.evaluate(() =>
        window.bottomControlsHarness.publishEvent("event-1", [1, 2]),
      );
      assert.deepEqual(await eventAvatarSlots(page), [
        "/__emoji/1.svg",
        "/__emoji/2.svg",
      ]);
      assert.deepEqual(await activeEventSubscriptions(page), ["event-1"]);
      assert.deepEqual(
        await page.evaluate(() => ({
          sameSubscription:
            window.bottomControlsHarness.environment.eventSubscriptions.findLast(
              (subscription) => subscription.active,
            ) === window.profileEventSubscription,
          originalStillActive: window.profileEventSubscription.active,
          subscriptionCountUnchanged:
            window.bottomControlsHarness.environment.eventSubscriptions
              .length === window.profileEventSubscriptionCount,
        })),
        {
          sameSubscription: true,
          originalStillActive: true,
          subscriptionCountUnchanged: true,
        },
      );
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
          () => !window.bottomControlsHarness.navigationState().transitioning,
        );
        await page.evaluate(() => {
          window.bottomControlsHarness.updateConnection({
            inviteId: "event-game-1",
            eventId: "event-1",
            eventOwned: true,
            online: true,
          });
          window.bottomControlsHarness.publishEvent("event-1", [1, 2, 3]);
        });
        await rememberEventButton(page);
        await click(page, "Event");
        await page.evaluate(() => {
          window.bottomControlsHarness.holdBootstrap("event-game-2");
          window.bottomControlsHarness.launchEventGame("event-game-2");
        });
        await page.waitForFunction(
          () =>
            window.bottomControlsHarness.navigationState().bootstraps.at(-1) ===
            "event-game-2",
        );
        assert.deepEqual(
          await page.evaluate(() => {
            const { route, modal, transitioning } =
              window.bottomControlsHarness.navigationState();
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
            () => window.bottomControlsHarness.navigationState().modal.eventId,
          ),
          "event-1",
        );
        await assertEventButtonRetained(page);
        await page.evaluate(() =>
          window.bottomControlsHarness.launchEventGame("event-game-2"),
        );
        await assertEventButtonRetained(page);

        await page.evaluate(() => window.history.back());
        await page.waitForFunction(
          () =>
            window.bottomControlsHarness.navigationState().modal.eventId ===
            "event-1",
        );
        await assertEventButtonRetained(page);
        await page.evaluate(() => window.history.forward());
        await page.waitForFunction(
          () => !window.bottomControlsHarness.navigationState().modal.isOpen,
        );
        await assertEventButtonRetained(page);

        await page.evaluate(() =>
          window.bottomControlsHarness.releaseBootstrap(),
        );
        await page.waitForFunction(
          () => !window.bottomControlsHarness.navigationState().transitioning,
        );
        assert.deepEqual(
          await page.evaluate(
            () => window.bottomControlsHarness.navigationState().bootstraps,
          ),
          ["event-game-1", "event-game-2"],
        );
        await page.evaluate(() =>
          window.bottomControlsHarness.updateConnection({
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
        window.bottomControlsHarness.launchEventGame("event-game-2");
        window.bottomControlsHarness.updateConnection();
        window.bottomControlsHarness.resetMatch();
      });
      await assertEventButtonRetained(page);
      await page.clock.runFor(3001);
      await assertEventButtonRetained(page);
      await click(page, "Event");
      assert.equal(
        await page.evaluate(
          () =>
            window.bottomControlsHarness.environment.eventModalState.eventId,
        ),
        "event-1",
      );
      await assertEventButtonRetained(page);
      await page.evaluate(() => window.bottomControlsHarness.dismissEvent());
      await assertEventButtonRetained(page);
      await page.clock.runFor(10000);
      await assertEventButtonRetained(page);
      await page.evaluate(() =>
        window.bottomControlsHarness.updateConnection({
          inviteId: "event-game-2",
          eventId: "event-1",
          eventOwned: true,
          online: true,
        }),
      );
      await assertEventButtonRetained(page);
      await page.evaluate(() => window.bottomControlsHarness.dispose());
      assert.deepEqual(await activeEventSubscriptions(page), []);
      assert.deepEqual(
        await page.evaluate(() => ({
          modalListeners:
            window.bottomControlsHarness.environment.eventModalListeners.size,
          navigationListeners:
            window.bottomControlsHarness.environment.navigationListeners.size,
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
        window.bottomControlsHarness.openEvent("event-2");
        window.bottomControlsHarness.launchEventGame("event-2-game-1");
      });
      assert.deepEqual(await activeEventSubscriptions(page), ["event-2"]);
      await click(page, "Event");
      assert.equal(
        await page.evaluate(
          () =>
            window.bottomControlsHarness.environment.eventModalState.eventId,
        ),
        "event-2",
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.launchEventGame("event-2-game-2"),
      );
      assert.deepEqual(await activeEventSubscriptions(page), ["event-2"]);
      await page.evaluate(() => {
        window.bottomControlsHarness.openEvent("event-3");
        window.bottomControlsHarness.launchEventGame("event-3-game-1");
        window.bottomControlsHarness.updateConnection({
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
          () =>
            window.bottomControlsHarness.environment.eventModalState.eventId,
        ),
        "event-3",
      );
      await page.evaluate(() => {
        window.bottomControlsHarness.dismissEvent();
        window.bottomControlsHarness.updateConnection({
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
      for (const route of /** @type {const} */ ([
        { mode: "home", path: "" },
        { mode: "invite", inviteId: "unrelated-game", path: "unrelated-game" },
      ])) {
        await enterEventGame(page);
        await click(page, "Event");
        await page.evaluate(() =>
          window.bottomControlsHarness.launchEventGame("event-game-2"),
        );
        assert.equal(await count(page, "Event"), 1);
        await page.evaluate(
          (route) => window.bottomControlsHarness.navigate(route),
          route,
        );
        assert.equal(await count(page, "Event"), 0);
        assert.deepEqual(await activeEventSubscriptions(page), []);
        await page.evaluate(() => {
          window.bottomControlsHarness.navigate({
            mode: "invite",
            inviteId: "event-game-2",
            path: "event-game-2",
          });
          window.bottomControlsHarness.render();
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
      for (const destination of /** @type {const} */ ([
        { eventId: null, eventOwned: true, expectedEventId: null },
        { eventId: "event-1", eventOwned: false, expectedEventId: null },
        { eventId: "event-2", eventOwned: true, expectedEventId: "event-2" },
      ])) {
        await enterEventGame(page);
        await click(page, "Event");
        await page.evaluate(() => {
          window.bottomControlsHarness.launchEventGame("event-game-2");
          window.bottomControlsHarness.updateConnection();
        });
        assert.equal(await count(page, "Event"), 1);
        await page.evaluate(
          (destination) =>
            window.bottomControlsHarness.updateConnection({
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
              () =>
                window.bottomControlsHarness.environment.eventModalState
                  .eventId,
            ),
            destination.expectedEventId,
          );
          await page.evaluate(() =>
            window.bottomControlsHarness.dismissEvent(),
          );
        }
        await page.evaluate(() =>
          window.bottomControlsHarness.updateConnection(),
        );
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
        const { port, environment, run } = window.bottomControlsHarness;
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
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.enableTimerVictoryClaim(),
        ),
      );
      await click(page, "Claim Victory");
      assert.equal(await count(page, "Claim Victory"), 2);
      await button(page, "Claim Victory")
        .last()
        .evaluate(
          /** @param {HTMLButtonElement} element */ (element) =>
            window.bottomControlsHarness.run(() => element.click()),
        );
      assert.equal(await count(page, "Claim Victory"), 1);
      assert.equal(await button(page, "Claim Victory").isDisabled(), true);
      await click(page, "Resign");
      assert.equal(await count(page, "Resign"), 2);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showTimerButtonProgressing(
            1,
            1,
            true,
          ),
        ),
      );
      assert.equal(await count(page, "Resign"), 2);
      await click(page, "Timer");
      assert.equal(await count(page, "Resign"), 1);
      assert.equal(await count(page, "Start a Timer"), 1);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.disableAndHideUndoResignAndTimerControls(),
        ),
      );
      assert.equal(await count(page, "Resign"), 0);
      assert.equal(await count(page, "Start a Timer"), 0);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showPrimaryAction(
            window.bottomControlsHarness.port.PrimaryActionType.JoinGame,
          ),
        ),
      );
      await click(page, "Join Game");
      assert.equal(await count(page, "Join Game"), 0);
      assert.equal(await count(page, "Play Again"), 0);
      assert.deepEqual(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
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
        const { port, environment, run } = window.bottomControlsHarness;
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
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
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
        window.bottomControlsHarness.respondAutomatch(0, {
          ok: true,
          mode: "pending",
          inviteId: "fresh",
        }),
      );
      await page.clock.runFor(3000);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.setAutomatchWaitingState(true),
        ),
      );
      await page.clock.runFor(3999);
      assert.equal(await count(page, "Cancel"), 0);
      await page.clock.runFor(1);
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.setAutomatchWaitingState(false),
        ),
      );
      assert.equal(await count(page, "Cancel"), 0);
      assert.equal(await button(page, "Automatch").isDisabled(), true);
      await click(page, "Navigation");
      await page.evaluate(() =>
        window.bottomControlsHarness.publishPending("existing"),
      );
      await click(page, "Open existing");
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.setAutomatchWaitingState(true),
        ),
      );
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      assert.deepEqual(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
        [["connect", "existing"]],
      );
    });
  },
);

test(
  "preserved disposal retains the optimistic automatch and its Cancel deadline before entering its invite",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await startAutomatch(page);
      await page.clock.runFor(3000);
      await page.evaluate(() =>
        window.bottomControlsHarness.respondAutomatch(
          0,
          { ok: true, mode: "pending", inviteId: "fresh-after-reset" },
          false,
        ),
      );
      await page.evaluate(() => window.bottomControlsHarness.resetMatch());
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.applyDisposedControlsPreset(true),
        ),
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      assert.equal(await count(page, "Automatching"), 1);
      await click(page, "Navigation");
      assert.equal(await count(page, "Open fresh-after-reset"), 1);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() => {
          window.bottomControlsHarness.environment.route = {
            mode: "invite",
            inviteId: "fresh-after-reset",
            path: "fresh-after-reset",
          };
          window.bottomControlsHarness.applyRouteControlsPreset(
            "automatchTransition",
          );
        }),
      );
      await page.clock.runFor(6999);
      assert.equal(await count(page, "Cancel"), 0);
      await page.clock.runFor(1);
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
    });
  },
);

test(
  "ordinary disposal clears the optimistic automatch and pending cancellation intent",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await startAutomatch(page);
      await page.clock.runFor(3000);
      await page.evaluate(() =>
        window.bottomControlsHarness.respondAutomatch(
          0,
          { ok: true, mode: "pending", inviteId: "discarded-pending" },
          false,
        ),
      );
      await click(page, "Navigation");
      assert.equal(await count(page, "Open discarded-pending"), 1);
      await page.evaluate(() => {
        window.bottomControlsHarness.resetMatch();
        window.bottomControlsHarness.run(() => {
          window.bottomControlsHarness.applyDisposedControlsPreset(false);
          window.bottomControlsHarness.applyRouteControlsPreset("lobby");
        });
      });
      assert.equal(await button(page, "Automatch").isDisabled(), false);
      assert.equal(await count(page, "Cancel"), 0);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      await click(page, "Navigation");
      assert.equal(await count(page, "Open discarded-pending"), 0);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() => {
          window.bottomControlsHarness.environment.route = {
            mode: "invite",
            inviteId: "discarded-pending",
            path: "discarded-pending",
          };
          window.bottomControlsHarness.applyRouteControlsPreset(
            "automatchTransition",
          );
        }),
      );
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
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
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.setAutomatchWaitingState(true),
        ),
      );
      await click(page, "Cancel");
      assert.equal(await button(page, "Canceling").isDisabled(), true);
      assert.equal(await count(page, "Automatching"), 0);
      await page.evaluate(() =>
        window.bottomControlsHarness.respondCancel(0, { ok: false }),
      );
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() =>
        window.bottomControlsHarness.respondCancel(1, null, true),
      );
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() => window.bottomControlsHarness.render("b"));
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      await click(page, "Cancel");
      await page.evaluate(() =>
        window.bottomControlsHarness.respondCancel(2, { ok: true }),
      );
      assert.equal(await button(page, "Canceling").isDisabled(), true);
      assert.deepEqual(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
        [],
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondCancel(3, { ok: false }),
      );
      await click(page, "Cancel");
      await page.evaluate(() =>
        window.bottomControlsHarness.respondCancel(4, { ok: true }),
      );
      assert.deepEqual(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
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
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showTimerButtonProgressing(
            0,
            10,
            true,
          ),
        ),
      );
      assert.equal(await button(page, "Timer").isDisabled(), true);
      await page.clock.setSystemTime(new Date("2026-01-01T00:00:11Z"));
      assert.equal(await button(page, "Timer").isDisabled(), true);
      assert.equal(await count(page, "Cancel"), 0);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() => {
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("focus"));
          window.dispatchEvent(new Event("pageshow"));
        }),
      );
      assert.equal(await button(page, "Timer").isDisabled(), false);
      assert.equal(await button(page, "Cancel").isDisabled(), false);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
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
          () => window.bottomControlsHarness.environment.transientHandlers.size,
        ),
        1,
      );
      await startAutomatch(page);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showTimerButtonProgressing(
            0,
            10,
            true,
          ),
        ),
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        2,
      );
      await page.evaluate(() => window.bottomControlsHarness.resetMatch());
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      await page.clock.runFor(10001);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      assert.equal(await button(page, "Timer").isDisabled(), true);
      assert.equal(await count(page, "Cancel"), 0);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() => {
          window.bottomControlsHarness.port.setAutomatchWaitingState(false);
          window.bottomControlsHarness.port.hideTimerButtons();
        }),
      );
      await startAutomatch(page);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showTimerButtonProgressing(
            0,
            10,
            true,
          ),
        ),
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        2,
      );
      await page.evaluate(() => window.bottomControlsHarness.dispose());
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.transientHandlers.size,
        ),
        0,
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.respondAutomatch(1, { ok: false }, false),
      );
      await page.clock.runFor(10001);
      const unmountedUpdates = await page.evaluate(() => {
        const { port, controlsStore, run } = window.bottomControlsHarness;
        const snapshot = controlsStore.getGameControlsSnapshot();
        const before = structuredClone(snapshot);
        let notifications = 0;
        const unsubscribe = controlsStore.subscribeGameControls(() => {
          notifications += 1;
        });
        try {
          run(() => {
            port.setBrushAndNavigationButtonDimmed(true);
            port.showMoveHistoryButton(true);
            port.showResignButton();
            port.showWaitingStateText("waiting after unmount");
            port.setIsReadyToCopyExistingInviteLink();
            port.enableTimerVictoryClaim();
            port.setPlaySamePuzzleAgainButtonVisible(true);
            port.setEndMatchVisible(true);
            port.setEndMatchConfirmed(true);
            port.setBotGameOptionVisible(true);
            port.setHomeVisible(true);
            port.setAutomoveActionEnabled(false);
            port.setAutomoveActionVisible(true);
            port.setUndoVisible(true);
            port.setWatchOnlyVisible(true);
            port.setUndoEnabled(true);
            port.showPrimaryAction(port.PrimaryActionType.Rematch);
            port.disableAndHideUndoResignAndTimerControls();
            window.dispatchEvent(new Event("focus"));
          });
          return {
            before,
            after: controlsStore.getGameControlsSnapshot(),
            sameSnapshot: controlsStore.getGameControlsSnapshot() === snapshot,
            notifications,
          };
        } finally {
          unsubscribe();
        }
      });
      assert.equal(unmountedUpdates.sameSnapshot, true);
      assert.equal(unmountedUpdates.notifications, 0);
      assert.deepEqual(unmountedUpdates.after, unmountedUpdates.before);
      assert.equal(await page.locator("#root").textContent(), "");
      assert.deepEqual(
        await page.evaluate(
          () => window.bottomControlsHarness.environment.calls,
        ),
        [],
      );
    });
  },
);

test(
  "a mounted controls reset publishes only its completed context and presentation",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const result = await page.evaluate(() => {
        const { run, controlsStore, applyGameplayControlsPreset, port } =
          window.bottomControlsHarness;
        /** @type {ReturnType<typeof controlsStore.getGameControlsSnapshot>[]} */
        const observed = [];
        const unsubscribe = controlsStore.subscribeGameControls(() => {
          observed.push(controlsStore.getGameControlsSnapshot());
        });
        /** @type {ReturnType<typeof controlsStore.getGameControlsSnapshot> | undefined} */
        let intermediate;
        /** @returns {ReturnType<typeof controlsStore.getGameControlsSnapshot> | undefined} */
        const readIntermediate = () => intermediate;
        let notificationsInside;
        let returned;
        try {
          run(() => {
            returned = controlsStore.batchGameControlsUpdates(() => {
              controlsStore.updateGameControlsContext({
                sessionId: 2,
                puzzleMode: true,
                selectedPuzzleId: "test-puzzle",
              });
              applyGameplayControlsPreset("puzzle");
              intermediate = controlsStore.getGameControlsSnapshot();
              notificationsInside = observed.length;
              port.showPrimaryAction(port.PrimaryActionType.Rematch);
              return controlsStore.getGameControlsSnapshot();
            });
          });
          run(() =>
            controlsStore.batchGameControlsUpdates(() => {
              controlsStore.updateGameControlsContext({ sessionId: 2 });
              port.setHomeVisible(true);
            }),
          );
          return {
            notificationsInside,
            intermediate: readIntermediate(),
            observed,
            final: controlsStore.getGameControlsSnapshot(),
            returnedFinal: returned === controlsStore.getGameControlsSnapshot(),
          };
        } finally {
          unsubscribe();
        }
      });
      assert.equal(result.notificationsInside, 0);
      assert.equal(required(result.intermediate).context.sessionId, 2);
      assert.equal(required(result.intermediate).context.puzzleMode, true);
      assert.equal(
        required(result.intermediate).presentation.homeVisible,
        true,
      );
      assert.equal(result.returnedFinal, true);
      assert.deepEqual(result.observed, [result.final]);
      assert.equal(
        result.final.presentation.gameControls.primaryAction,
        "rematch",
      );
      assert.equal(await count(page, "Next Lesson"), 1);
      assert.equal(await count(page, "Play Again"), 0);
    });
  },
);

test(
  "published context rerenders primary actions without a presentation command",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() => {
          window.bottomControlsHarness.port.showPrimaryAction(
            window.bottomControlsHarness.port.PrimaryActionType.Rematch,
          );
        }),
      );
      assert.equal(await count(page, "Play Again"), 1);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() => {
          window.bottomControlsHarness.controlsStore.updateGameControlsContext({
            puzzleMode: true,
            selectedPuzzleId: "test-puzzle",
          });
        }),
      );
      assert.equal(await count(page, "Play Again"), 0);
      assert.equal(await count(page, "Next Lesson"), 1);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() => {
          window.bottomControlsHarness.controlsStore.updateGameControlsContext({
            puzzleMode: false,
            selectedPuzzleId: null,
          });
        }),
      );
      assert.equal(await count(page, "Next Lesson"), 0);
      assert.equal(await count(page, "Play Again"), 1);
    });
  },
);

test(
  "a real remount starts fresh presentation while rerender and StrictMode preserve it",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() => {
          const { port, controlsStore } = window.bottomControlsHarness;
          controlsStore.updateGameControlsContext({
            puzzleMode: true,
            selectedPuzzleId: "test-puzzle",
          });
          port.showResignButton();
          port.showPrimaryAction(port.PrimaryActionType.Rematch);
          port.setEndMatchVisible(true);
          port.setEndMatchConfirmed(true);
        }),
      );
      await click(page, "Resign");
      assert.equal((await popupState(page)).bottom, true);
      await page.evaluate(() => window.bottomControlsHarness.render());
      assert.equal(await count(page, "Next Lesson"), 1);
      assert.equal(await count(page, "Finished"), 1);
      assert.equal((await popupState(page)).bottom, true);
      await page.evaluate(() => window.bottomControlsHarness.remount());
      assert.equal(await count(page, "Next Lesson"), 0);
      assert.equal(await count(page, "Finished"), 0);
      assert.equal((await popupState(page)).bottom, false);
      assert.deepEqual(
        await page.evaluate(() => {
          const { context, presentation } =
            window.bottomControlsHarness.controlsStore.getGameControlsSnapshot();
          return {
            puzzleMode: context.puzzleMode,
            selectedPuzzleId: context.selectedPuzzleId,
            confirmation: presentation.gameControls.confirmation,
          };
        }),
        {
          puzzleMode: true,
          selectedPuzzleId: "test-puzzle",
          confirmation: "none",
        },
      );
    });
  },
);

test(
  "reaction cooldown expires at 9999ms and match reset re-enables the control",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await showPopupControls(page);
      await click(page, "Voice Reaction");
      await click(page, "yo");
      assert.equal(await button(page, "Voice Reaction").isDisabled(), true);
      await page.clock.runFor(9998);
      assert.equal(await button(page, "Voice Reaction").isDisabled(), true);
      await page.clock.runFor(1);
      assert.equal(await button(page, "Voice Reaction").isDisabled(), false);
      await click(page, "Voice Reaction");
      await click(page, "yo");
      await page.evaluate(() => window.bottomControlsHarness.resetMatch());
      assert.equal(await button(page, "Voice Reaction").isDisabled(), false);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      await page.clock.runFor(9999);
      assert.equal(await button(page, "Voice Reaction").isDisabled(), false);
    });
  },
);

for (const isGameWithBot of /** @type {const} */ ([false, true])) {
  test(
    `${isGameWithBot ? "bot reply" : "reaction cooldown"} timers clear on unmount`,
    { timeout: 60000 },
    async () => {
      await fixture(async (page) => {
        await showPopupControls(page);
        await page.evaluate((isGameWithBot) => {
          window.bottomControlsHarness.run(() =>
            window.bottomControlsHarness.controlsStore.updateGameControlsContext(
              {
                isGameWithBot,
              },
            ),
          );
        }, isGameWithBot);
        await click(page, "Voice Reaction");
        await click(page, "yo");
        assert.equal(
          await page.evaluate(
            () => window.bottomControlsHarness.counters().uiTimeouts,
          ),
          1,
        );
        await page.evaluate(() => window.bottomControlsHarness.dispose());
        assert.equal(
          await page.evaluate(
            () => window.bottomControlsHarness.counters().uiTimeouts,
          ),
          0,
        );
        await page.clock.runFor(9999);
      });
    },
  );
}

test(
  "reaction callbacks read the current context during synchronous mode changes",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showVoiceReactionButton(true),
        ),
      );
      await click(page, "Voice Reaction");
      await button(page, "yo").evaluate(
        /** @param {HTMLButtonElement} element */ (element) =>
          window.bottomControlsHarness.run(() => {
            window.bottomControlsHarness.controlsStore.updateGameControlsContext(
              {
                isGameWithBot: true,
              },
            );
            element.click();
          }),
      );
      assert.deepEqual(
        await page.evaluate(() =>
          window.bottomControlsHarness.environment.calls.filter(
            ([name]) => name === "reaction",
          ),
        ),
        [],
      );
      await page.clock.runFor(2000);
      await click(page, "Voice Reaction");
      await button(page, "yo").evaluate(
        /** @param {HTMLButtonElement} element */ (element) =>
          window.bottomControlsHarness.run(() => {
            window.bottomControlsHarness.controlsStore.updateGameControlsContext(
              {
                isGameWithBot: false,
                puzzleMode: true,
              },
            );
            element.click();
          }),
      );
      assert.deepEqual(
        await page.evaluate(() =>
          window.bottomControlsHarness.environment.calls.filter(
            ([name]) => name === "reaction",
          ),
        ),
        [],
      );
    });
  },
);

test(
  "session presets publish one final snapshot and unchanged repeats preserve identity",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (const preset of /** @type {const} */ ([
        "lobby",
        "watch",
        "snapshot",
        "invite",
        "automatchTransition",
        "localMatch",
        "automatchRequest",
        "puzzle",
        false,
        true,
      ])) {
        const result = await page.evaluate((preset) => {
          const {
            run,
            port,
            controlsStore,
            applyRouteControlsPreset,
            applyDisposedControlsPreset,
            applyGameplayControlsPreset,
          } = window.bottomControlsHarness;
          const applyPreset = () => {
            if (typeof preset === "boolean") {
              applyDisposedControlsPreset(preset);
            } else if (
              preset === "localMatch" ||
              preset === "automatchRequest" ||
              preset === "puzzle"
            ) {
              applyGameplayControlsPreset(preset);
            } else {
              applyRouteControlsPreset(preset);
            }
          };
          run(() => {
            applyDisposedControlsPreset(false);
            if (typeof preset === "boolean") {
              port.setHomeVisible(!preset);
              port.setEndMatchVisible(true);
              port.showWaitingStateText("waiting");
              port.setUndoVisible(true);
              port.setUndoEnabled(true);
            }
          });
          const before = controlsStore.getGameControlsSnapshot();
          /** @type {ReturnType<typeof controlsStore.getGameControlsSnapshot>[]} */
          const observed = [];
          const unsubscribe = controlsStore.subscribeGameControls(() => {
            observed.push(controlsStore.getGameControlsSnapshot());
          });
          try {
            run(applyPreset);
            const after = controlsStore.getGameControlsSnapshot();
            const changedNotifications = observed.length;
            const publishedFinalSnapshot = observed[0] === after;
            observed.length = 0;
            run(applyPreset);
            return {
              changed: after !== before,
              changedNotifications,
              publishedFinalSnapshot,
              repeatedNotifications: observed.length,
              retainedSnapshot:
                controlsStore.getGameControlsSnapshot() === after,
            };
          } finally {
            unsubscribe();
          }
        }, preset);
        assert.deepEqual(
          result,
          {
            changed: true,
            changedNotifications: 1,
            publishedFinalSnapshot: true,
            repeatedNotifications: 0,
            retainedSnapshot: true,
          },
          `preset ${preset}`,
        );
      }
    });
  },
);

test(
  "repeating a disposed preset still dismisses a picker whose reaction button is hidden",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.evaluate(() =>
          window.bottomControlsHarness.run(() =>
            window.bottomControlsHarness.port.toggleReactionPicker(),
          ),
        );
        assert.equal(await count(page, "yo"), 1);
        assert.equal(await count(page, "Voice Reaction"), 0);
        await page.evaluate(() =>
          window.bottomControlsHarness.run(() =>
            window.bottomControlsHarness.applyDisposedControlsPreset(false),
          ),
        );
        assert.equal(await count(page, "yo"), 0);
      }
    });
  },
);

test(
  "route presets retain timer progress while disposal cancels its deadline before another timer starts",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      const retained = await page.evaluate(() => {
        const { run, port, controlsStore, applyRouteControlsPreset } =
          window.bottomControlsHarness;
        run(() => port.showTimerButtonProgressing(0, 10, true));
        const config =
          controlsStore.getGameControlsSnapshot().presentation.gameControls
            .timer.config;
        window.savedTimerConfig = config;
        run(() => applyRouteControlsPreset("invite"));
        return (
          controlsStore.getGameControlsSnapshot().presentation.gameControls
            .timer.config === config
        );
      });
      assert.equal(retained, true);
      assert.equal(await button(page, "Timer").isDisabled(), true);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        1,
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.applyDisposedControlsPreset(false),
        ),
      );
      assert.equal(await count(page, "Timer"), 0);
      assert.equal(
        await page.evaluate(
          () =>
            window.bottomControlsHarness.controlsStore.getGameControlsSnapshot()
              .presentation.gameControls.timer.config ===
            window.savedTimerConfig,
        ),
        true,
      );
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.showTimerButtonProgressing(
            0,
            30,
            false,
          ),
        ),
      );
      await page.clock.runFor(10001);
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.dispatchEvent(new Event("focus")),
        ),
      );
      assert.equal(await button(page, "Timer").isDisabled(), true);
      assert.equal(
        await page.evaluate(
          () => window.bottomControlsHarness.counters().uiTimeouts,
        ),
        0,
      );
    });
  },
);

test(
  "gameplay presets prepare controls while preserving unrelated match state",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() => {
        const {
          run,
          port,
          applyDisposedControlsPreset,
          applyGameplayControlsPreset,
        } = window.bottomControlsHarness;
        run(() => {
          applyDisposedControlsPreset(false);
          port.setAutomoveActionEnabled(false);
          port.setEndMatchVisible(true);
          applyGameplayControlsPreset("localMatch");
        });
      });
      assert.equal(await button(page, "Undo").isDisabled(), true);
      assert.equal(await button(page, "Bot").isDisabled(), false);
      for (const name of /** @type {const} */ ([
        "Move History",
        "Resign",
        "End Match",
      ])) {
        assert.equal(await count(page, name), 1);
      }
      for (const name of /** @type {const} */ ([
        "Automatch",
        "Bot Game",
        "New Link Game",
        "Voice Reaction",
      ])) {
        assert.equal(await count(page, name), 0);
      }

      for (const waiting of /** @type {const} */ ([false, true])) {
        const retained = await page.evaluate((waiting) => {
          const {
            run,
            port,
            controlsStore,
            applyDisposedControlsPreset,
            applyGameplayControlsPreset,
          } = window.bottomControlsHarness;
          run(() => {
            applyDisposedControlsPreset(false);
            port.setAutomatchVisible(true);
            port.setAutomatchEnabled(false);
            port.setAutomatchWaitingState(waiting);
            port.setUndoVisible(true);
            port.setUndoEnabled(true);
            port.setNavigationListButtonVisible(true);
            port.setAutomoveActionVisible(true);
            port.showMoveHistoryButton(true);
            port.showResignButton();
          });
          const before = controlsStore.getGameControlsSnapshot().presentation;
          const timeouts = window.bottomControlsHarness.counters().uiTimeouts;
          run(() => applyGameplayControlsPreset("automatchRequest"));
          const after = controlsStore.getGameControlsSnapshot().presentation;
          return {
            undoUnchanged: before.gameControls.undo === after.gameControls.undo,
            navigationUnchanged:
              before.navigationVisible === after.navigationVisible,
            resignUnchanged:
              before.gameControls.resignVisible ===
              after.gameControls.resignVisible,
            deadlineUnchanged:
              timeouts === window.bottomControlsHarness.counters().uiTimeouts,
          };
        }, waiting);
        assert.deepEqual(retained, {
          undoUnchanged: true,
          navigationUnchanged: true,
          resignUnchanged: true,
          deadlineUnchanged: true,
        });
        assert.equal(
          await button(
            page,
            waiting ? "Automatching" : "Automatch",
          ).isDisabled(),
          true,
        );
        assert.equal(await button(page, "Undo").isDisabled(), false);
        assert.equal(await count(page, "Bot"), 0);
        assert.equal(await count(page, "Move History"), 0);
      }

      for (const visible of /** @type {const} */ ([false, true])) {
        const retained = await page.evaluate((visible) => {
          const {
            run,
            port,
            controlsStore,
            applyDisposedControlsPreset,
            applyGameplayControlsPreset,
          } = window.bottomControlsHarness;
          run(() => {
            applyDisposedControlsPreset(false);
            port.showTimerButtonProgressing(0, 10, false);
            port.setNavigationListButtonVisible(visible);
            port.setAutomoveActionVisible(visible);
            port.setAutomoveActionEnabled(false);
            port.showMoveHistoryButton(visible);
            if (visible) port.showResignButton();
          });
          const before = controlsStore.getGameControlsSnapshot().presentation;
          run(() => applyGameplayControlsPreset("puzzle"));
          const after = controlsStore.getGameControlsSnapshot().presentation;
          return {
            timerUnchanged:
              before.gameControls.timer === after.gameControls.timer,
            automoveUnchanged:
              before.gameControls.automove === after.gameControls.automove,
            navigationUnchanged:
              before.navigationVisible === after.navigationVisible,
            historyUnchanged:
              before.moveHistoryVisible === after.moveHistoryVisible,
            resignUnchanged:
              before.gameControls.resignVisible ===
              after.gameControls.resignVisible,
          };
        }, visible);
        assert.deepEqual(retained, {
          timerUnchanged: true,
          automoveUnchanged: true,
          navigationUnchanged: true,
          historyUnchanged: true,
          resignUnchanged: true,
        });
        assert.equal(await count(page, "Undo"), 1);
        assert.equal(await count(page, "Voice Reaction"), 1);
        assert.equal(await button(page, "Timer").isDisabled(), true);
        assert.equal(await count(page, "Automatch"), 0);
        assert.equal(await count(page, "Bot Game"), 0);
      }
    });
  },
);

test(
  "session presets clear invite loading, copied text, and ready state before reopening",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      for (const preset of /** @type {const} */ ([
        "watch",
        "snapshot",
        false,
        true,
        "localMatch",
        "automatchRequest",
        "puzzle",
      ])) {
        await page.evaluate(() =>
          window.bottomControlsHarness.run(() => {
            window.bottomControlsHarness.applyDisposedControlsPreset(false);
            window.bottomControlsHarness.applyRouteControlsPreset("lobby");
          }),
        );
        await click(page, "New Link Game");
        assert.equal(await count(page, "Creating a Link..."), 1);
        const hideInvite = () =>
          page.evaluate(
            (preset) =>
              window.bottomControlsHarness.run(() => {
                if (typeof preset === "boolean") {
                  window.bottomControlsHarness.applyDisposedControlsPreset(
                    preset,
                  );
                } else if (
                  preset === "localMatch" ||
                  preset === "automatchRequest" ||
                  preset === "puzzle"
                ) {
                  window.bottomControlsHarness.applyGameplayControlsPreset(
                    preset,
                  );
                } else {
                  window.bottomControlsHarness.applyRouteControlsPreset(preset);
                }
              }),
            preset,
          );
        const openLobby = () =>
          page.evaluate(() =>
            window.bottomControlsHarness.run(() =>
              window.bottomControlsHarness.applyRouteControlsPreset("lobby"),
            ),
          );
        const completeInvite = () =>
          page.evaluate(() =>
            window.bottomControlsHarness.run(() =>
              window.bottomControlsHarness.required(
                window.bottomControlsHarness.environment.inviteRequests.at(-1),
              )(true),
            ),
          );
        await hideInvite();
        await openLobby();
        assert.equal(await button(page, "New Link Game").isDisabled(), false);
        assert.equal(await count(page, "Creating a Link..."), 0);
        await click(page, "New Link Game");
        await completeInvite();
        await click(page, "Copy Link");
        await completeInvite();
        assert.equal(await count(page, "Link is copied"), 1);
        await hideInvite();
        assert.equal(
          await page.evaluate(
            () =>
              window.bottomControlsHarness.controlsStore.getGameControlsSnapshot()
                .presentation.inviteReadyToCopy,
          ),
          false,
        );
        await openLobby();
        assert.equal(await count(page, "New Link Game"), 1);
        await click(page, "New Link Game");
        await completeInvite();
        assert.equal(await count(page, "Copy Link"), 1);
        assert.equal(await count(page, "Link is copied"), 0);
      }
    });
  },
);

test(
  "session presets cannot mutate presentation before binding or after unmount",
  { timeout: 60000 },
  async () => {
    await fixture(
      async (page) => {
        const checkUnboundPresets = () =>
          page.evaluate(() => {
            const {
              run,
              controlsStore,
              applyRouteControlsPreset,
              applyDisposedControlsPreset,
              applyGameplayControlsPreset,
            } = window.bottomControlsHarness;
            const before = controlsStore.getGameControlsSnapshot();
            let notifications = 0;
            const unsubscribe = controlsStore.subscribeGameControls(() => {
              notifications += 1;
            });
            try {
              run(() => {
                for (const preset of /** @type {const} */ ([
                  "lobby",
                  "watch",
                  "snapshot",
                  "invite",
                  "automatchTransition",
                ])) {
                  applyRouteControlsPreset(preset);
                }
                applyDisposedControlsPreset(false);
                applyDisposedControlsPreset(true);
                for (const preset of /** @type {const} */ ([
                  "localMatch",
                  "automatchRequest",
                  "puzzle",
                ])) {
                  applyGameplayControlsPreset(preset);
                }
              });
              return {
                unchanged: controlsStore.getGameControlsSnapshot() === before,
                notifications,
              };
            } finally {
              unsubscribe();
            }
          });
        assert.deepEqual(await checkUnboundPresets(), {
          unchanged: true,
          notifications: 0,
        });
        await page.evaluate(() => {
          window.bottomControlsHarness.render();
          window.bottomControlsHarness.run(() =>
            window.bottomControlsHarness.applyRouteControlsPreset("lobby"),
          );
        });
        assert.equal(await count(page, "New Link Game"), 1);
        await page.evaluate(() => window.bottomControlsHarness.dispose());
        assert.deepEqual(await checkUnboundPresets(), {
          unchanged: true,
          notifications: 0,
        });
        assert.equal(await page.locator("#root").textContent(), "");
      },
      { mount: false },
    );
  },
);

test(
  "late invite callbacks from a disposed instance cannot update a remounted presentation",
  { timeout: 60000 },
  async () => {
    await fixture(async (page) => {
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.setInviteLinkActionVisible(true),
        ),
      );
      await click(page, "New Link Game");
      assert.equal(await count(page, "Creating a Link..."), 1);
      await page.evaluate(() => window.bottomControlsHarness.remount());
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.required(
            window.bottomControlsHarness.environment.inviteRequests[0],
          )(true),
        ),
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.bottomControlsHarness.controlsStore.getGameControlsSnapshot()
              .presentation.inviteReadyToCopy,
        ),
        false,
      );
      await page.evaluate(() =>
        window.bottomControlsHarness.run(() =>
          window.bottomControlsHarness.port.setInviteLinkActionVisible(true),
        ),
      );
      assert.equal(await count(page, "New Link Game"), 1);
      assert.equal(await count(page, "Copy Link"), 0);
    });
  },
);
