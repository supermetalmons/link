import type { MatchWagerState } from "../../src/connection/connectionModels";
import type {
  WagerRenderState,
  WagerSlotLayoutMap,
} from "../../src/game/boardWagerModels";
import type { AvailableMaterialsSnapshot } from "../../src/services/availableMaterials";
import { requireValue } from "./browserAssertions";
type WagerSubscriber = (state: MatchWagerState | null) => void;
type SquareSubscriber = Parameters<
  typeof import("../../src/game/gameController").subscribeToDisplayedBoardSquareTypes
>[0];
type OutsideHandler = NonNullable<
  Parameters<
    typeof import("../../src/ui/controls/bottomControlsPort").setWagerPanelOutsideTapHandler
  >[0]
>;
import { useSyncExternalStore } from "react";
import { wagerSlotLayoutsEqual } from "../../src/game/boardWagerModels";
export const environment = {
  calls: [] as string[],
  botStrengthActivations: 0,
  boardSquareColorReads: 0,
  subscribers: new Set<WagerSubscriber>(),
  watchSubscribers: new Set<(value: boolean) => void>(),
  styleSubscribers: new Set<() => void>(),
  materialSubscribers: new Set<() => void>(),
  squareSubscribers: new Set<SquareSubscriber>(),
  transient: null as ((fadeOutVideos?: boolean) => void) | null,
  render: null as ((state: WagerRenderState) => void) | null,
  layouts: null as WagerSlotLayoutMap | null,
  replay: null as (() => void) | null,
  requestedLayoutRevision: 0,
  committedLayoutRevision: -1,
  layoutCalls: [] as {
    revision: number | undefined;
    accepted: boolean;
    binding: boolean;
  }[],
  renderReplays: 0,
  renderBindings: [] as {
    requested: number;
    committed: number;
    hasLayout: boolean;
  }[],
  outside: null as OutsideHandler | null,
  visible: () => false,
  style: "grid",
  mobile: new URLSearchParams(location.search).has("mobile"),
  state: null as MatchWagerState | null,
  snapshotConfirmed: true,
  balance: {
    availableMaterials: { dust: 50, slime: 0, gum: 0, metal: 50, ice: 0 },
    frozenMaterialsStatus: "ready",
    hasConfirmedSnapshot: true,
  } as AvailableMaterialsSnapshot,
};
export const materialImage = (gold = false) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="M4 29 8 12 22 3 35 13 37 29 22 37Z" fill="' +
      (gold ? "#dba436" : "#79589f") +
      '" stroke="#242138" stroke-width="2"/><path d="m8 12 14 5 13-4M22 17v20M22 17 22 3" fill="none" stroke="#b9aac9" stroke-width="2"/></svg>',
  );
const subscribe = <Callback,>(set: Set<Callback>, callback: Callback) => {
  set.add(callback);
  return () => set.delete(callback);
};
export let isWatchOnly = false;
export const setWatchOnly = (value: boolean) => {
  isWatchOnly = value;
  environment.watchSubscribers.forEach((callback) => callback(value));
};
export const subscribeToWatchOnly = (cb: (value: boolean) => void) => {
  const unsubscribe = subscribe(environment.watchSubscribers, cb);
  cb(isWatchOnly);
  return unsubscribe;
};
export const getCurrentDisplayedBoardSquareTypes = () => null;
export const subscribeToDisplayedBoardSquareTypes = (cb: SquareSubscriber) => {
  const unsubscribe = subscribe(environment.squareSubscribers, cb);
  cb(getCurrentDisplayedBoardSquareTypes());
  return unsubscribe;
};
export const didClickBotStrengthControlButton = () => {
  environment.botStrengthActivations++;
};
export { WAGER_WIN_PILE_SCALE } from "../../src/game/boardWagerModels";
export const playerSideMetadata = { uid: "p" };
export const opponentSideMetadata = { uid: "o" };
export const setWagerRenderHandler = (
  callback: ((state: WagerRenderState) => void) | null,
) => {
  environment.render = callback;
  if (callback) {
    environment.renderBindings.push({
      requested: environment.requestedLayoutRevision,
      committed: environment.committedLayoutRevision,
      hasLayout: !!environment.layouts,
    });
    environment.replay?.();
  }
};
export const setWagerSlotLayouts = (
  layouts: WagerSlotLayoutMap | null,
  revision?: number,
) => {
  const accepted = !layouts || revision === environment.requestedLayoutRevision;
  environment.layoutCalls.push({
    revision,
    accepted,
    binding: !!environment.render,
  });
  if (!accepted) return;
  environment.committedLayoutRevision = layouts ? requireValue(revision) : -1;
  const changed = !wagerSlotLayoutsEqual(environment.layouts, layouts);
  environment.layouts = layouts;
  if (layouts && changed) environment.replay?.();
};
export const openBoardPlayerInfoProfile = () => {};
export const applyInviteBotButtonLayout = () => {};
export const connection = Object.fromEntries(
  ["cancelWagerProposal", "declineWagerProposal", "acceptWagerProposal"].map(
    (name) => [
      name,
      async () => {
        environment.calls.push(name);
      },
    ],
  ),
);
export const subscribeToWagerState = (callback: WagerSubscriber) => {
  const unsubscribe = subscribe(environment.subscribers, callback);
  callback(environment.state);
  return unsubscribe;
};
export const hasConfirmedWagerSnapshot = () => environment.snapshotConfirmed;
const materialSubscribe = (cb: () => void) =>
  subscribe(environment.materialSubscribers, cb);
export const useAvailableMaterials = () =>
  useSyncExternalStore(materialSubscribe, () => environment.balance);
export const isMobile = environment.mobile;
export const defaultInputEventName = isMobile ? "touchstart" : "click";
export const colors = { scoreText: "#716975" };
export const getCurrentColorSet = () => ({
  lightSquare: "#e7dfd4",
  darkSquare: "#b5a89b",
  simpleManaSquare: "#bea7c5",
  simpleManaSquareOnLightTile: "#d7c6db",
  manaPool: "#98bab4",
  pickupItemSquare: "#cdbda2",
});
export const isCustomPictureBoardEnabled = () =>
  environment.style === "pangchiu";
export const isPangchiuBoard = isCustomPictureBoardEnabled;
export const subscribeToBoardStyleSetChanges = (cb: () => void) =>
  subscribe(environment.styleSubscribers, cb);
export const subscribeToBoardColorSetChanges = subscribeToBoardStyleSetChanges;
export const getImageResource = () => ({
  load: async () => materialImage(),
  getSnapshot: materialImage,
  getCachedValue: materialImage,
});
export const attachRainbowAura = (container: HTMLElement) => {
  const background = document.createElement("div");
  const inner = document.createElement("div");
  background.dataset.fixtureAura = "true";
  background.append(inner);
  container.append(background);
  return { background, inner };
};
export const hideRainbowAura = (background: HTMLElement) => {
  background.dataset.visible = "false";
};
export const setRainbowAuraMask = (inner: HTMLElement, url: string) => {
  inner.dataset.mask = url;
};
export const showRainbowAura = (background: HTMLElement) => {
  background.dataset.visible = "true";
};
export const registerBoardTransientUiHandler = (
  callback: (fadeOutVideos?: boolean) => void,
) => {
  environment.transient = callback;
  return () => {
    environment.transient = null;
  };
};
export const setWagerPanelOutsideTapHandler = (
  callback: OutsideHandler | null,
) => {
  environment.outside = callback;
};
export const setWagerPanelVisibilityChecker = (callback: () => boolean) => {
  environment.visible = callback;
};
