import { requireValue } from "./browserAssertions";
import type { MaterialName } from "../../src/services/rocksMiningService";
import type { MatchWagerState } from "../../src/connection/connectionModels";
import type { FrozenMaterialsStatus } from "../../src/services/wagerMaterialsService";
import type {
  WagerRenderState,
  WagerPileAnimation,
} from "../../src/game/boardWagerModels";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import BoardComponent from "../../src/ui/BoardComponent";
import * as boardUi from "../../src/game/boardUiPort";
import {
  createEmptyPlayerInfoOverlayState,
  getBoardPlayerInfoOverlayState,
  type BoardPlayerInfoOverlayState,
} from "../../src/game/boardUiPort";
import { showVideoReaction } from "../../src/ui/controls/boardReactionPort";
import {
  createWagerPile,
  syncWagerPileIcons,
  updateWagerPileLayout,
  buildWagerRenderState,
  MAX_WAGER_WIN_PILE_ITEMS,
} from "../../src/game/boardWagerModels";
import {
  environment as e,
  materialImage,
  setWatchOnly,
  playerSideMetadata,
  opponentSideMetadata,
} from "./boardWagersEnvironment";
import "../../src/index.css";
let root: ReturnType<typeof createRoot>;
let revision = 0;
const empty = (): WagerRenderState => ({
  player: null,
  opponent: null,
  winner: null,
  playerDisappearing: null,
  opponentDisappearing: null,
  winAnimationActive: false,
});
let renderState: WagerRenderState = empty();
const pileKeys = [
  "player",
  "opponent",
  "winner",
  "playerDisappearing",
  "opponentDisappearing",
] as const;
const run = (callback: () => void) => flushSync(callback);
function names(long = false, flipped = false) {
  const value = createEmptyPlayerInfoOverlayState();
  for (const side of ["player", "opponent"] as const) {
    value[side] = {
      ...value[side],
      visible: true,
      nameVisible: true,
      nameText: long
        ? side + "_a_very_long_player_name"
        : side === "player"
          ? "Moss"
          : "Luna",
      scoreText: side === "player" ? "12" : "8",
      timerText: "00:42",
      timerVisible: true,
      nameReactionText: "Wow!",
      profileMetadataIsOpponent: flipped
        ? side === "player"
        : side === "opponent",
    };
  }
  value.wagerLayoutRevision = ++revision;
  e.requestedLayoutRevision = revision;
  run(() => boardUi.setBoardPlayerInfoOverlayState(value));
}
function pile(
  side: "player" | "opponent" | "winner",
  count = 8,
  material: MaterialName = "dust",
  animation: WagerPileAnimation = "none",
  pending = true,
) {
  const model = createWagerPile();
  syncWagerPileIcons(
    model,
    material,
    count,
    undefined,
    side === "winner" ? MAX_WAGER_WIN_PILE_ITEMS : undefined,
  );
  const layout = e.layouts?.[side === "winner" ? "player" : side];
  if (!layout) throw new Error("Missing wager slot layout for " + side);
  updateWagerPileLayout(
    model,
    side === "winner" ? layout.winner : layout.pile,
    0.777,
  );
  model.materialUrl = materialImage(material === "metal");
  return buildWagerRenderState(model, side, animation, pending);
}
e.replay = () => {
  const hasPiles = pileKeys.some((key) => renderState[key] !== null);
  if (hasPiles && !e.layouts) return;
  const next = { ...renderState };
  for (const key of pileKeys) {
    const previous = next[key];
    if (previous)
      next[key] = pile(
        previous.side,
        previous.actualCount,
        previous.materialUrl === materialImage(true) ? "metal" : "dust",
        "none",
        previous.isPending,
      );
  }
  renderState = next;
  if (e.render) e.renderReplays++;
  e.render?.(renderState);
};
export const harness = {
  e,
  run,
  names,
  pile,
  botStrength({
    visible = true,
    mode,
    topControlSlot,
  }: {
    visible?: boolean;
    mode?: BoardPlayerInfoOverlayState["botStrengthControlMode"];
    topControlSlot?: BoardPlayerInfoOverlayState["topControlSlot"];
  } = {}) {
    const value = getBoardPlayerInfoOverlayState();
    run(() =>
      boardUi.setBoardPlayerInfoOverlayState({
        ...value,
        botStrengthControlVisible: visible,
        botStrengthControlMode: mode ?? value.botStrengthControlMode,
        topControlSlot: topControlSlot ?? value.topControlSlot,
      }),
    );
  },
  bridge(playerUid: string, opponentUid: string) {
    playerSideMetadata.uid = playerUid;
    opponentSideMetadata.uid = opponentUid;
    run(() => boardUi.updateWagerPlayerUids(playerUid, opponentUid));
  },
  mount({ seedNames = true } = {}) {
    root = createRoot(requireValue(document.getElementById("root")));
    run(() =>
      root.render(
        <React.StrictMode>
          <BoardComponent />
        </React.StrictMode>,
      ),
    );
    if (seedNames) names();
  },
  state(state: MatchWagerState | null) {
    e.state = state;
    run(() => e.subscribers.forEach((callback) => callback(state)));
  },
  confirmed(value: boolean) {
    e.snapshotConfirmed = value;
    run(() => e.subscribers.forEach((callback) => callback(e.state)));
  },
  proposals(playerCount = 4, opponentCount = 8) {
    this.state({
      proposals: {
        p: { material: "dust", count: playerCount },
        o: { material: "dust", count: opponentCount },
      },
    });
  },
  balance(count: number, status: FrozenMaterialsStatus = "ready") {
    e.balance = {
      availableMaterials: {
        dust: count,
        slime: 0,
        gum: 0,
        metal: count,
        ice: 0,
      },
      frozenMaterialsStatus: status,
      hasConfirmedSnapshot: status === "ready",
    };
    run(() => e.materialSubscribers.forEach((callback) => callback()));
  },
  materialBalances(dust: number, metal: number) {
    e.balance = {
      availableMaterials: { dust, slime: 0, gum: 0, metal, ice: 0 },
      frozenMaterialsStatus: "ready",
      hasConfirmedSnapshot: true,
    };
    run(() => e.materialSubscribers.forEach((callback) => callback()));
  },
  watch(value: boolean) {
    run(() => setWatchOnly(value));
  },
  style(value: string) {
    e.style = value;
    run(() => e.styleSubscribers.forEach((callback) => callback()));
  },
  styleViaBoardPort(value: string) {
    e.style = value;
    run(() => boardUi.updateBoardComponentForBoardStyleChange());
  },
  overlay(label: string | null) {
    const element = label
      ? document.createElementNS("http://www.w3.org/2000/svg", "rect")
      : null;
    if (element && label !== null)
      element.setAttribute("data-fixture-overlay", label);
    run(() =>
      boardUi.setTopBoardOverlayVisible(
        false,
        element,
        !!label,
        () => e.calls.push(`confirm:${label}`),
        () => e.calls.push(`cancel:${label}`),
      ),
    );
  },
  aura(opponent: boolean, visible: boolean) {
    const avatar = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    avatar.setAttribute("x", "20");
    avatar.setAttribute("y", "30");
    avatar.setAttribute("width", "40");
    avatar.setAttribute("height", "50");
    requireValue(document.getElementById("avatarLayer")).append(avatar);
    const { left, top, width, height } = avatar.getBoundingClientRect();
    run(() => {
      boardUi.updateAuraForAvatarElement(opponent, avatar);
      boardUi.showRaibowAura(visible, `mask:${opponent}`, opponent);
    });
    avatar.remove();
    return { left, top, width, height };
  },
  emit(
    options: {
      playerCount?: number;
      opponentCount?: number;
      material?: MaterialName;
      animation?: WagerPileAnimation;
      overrides?: Partial<WagerRenderState>;
      image?: string;
    } = {},
  ) {
    renderState = {
      ...empty(),
      player: pile(
        "player",
        options.playerCount ?? 4,
        options.material ?? "dust",
        options.animation ?? "none",
      ),
      opponent: pile(
        "opponent",
        options.opponentCount ?? 8,
        options.material ?? "dust",
        options.animation ?? "none",
      ),
      ...options.overrides,
    };
    if (options.image) {
      requireValue(renderState.player).materialUrl = options.image;
      requireValue(renderState.opponent).materialUrl = options.image;
    }
    run(() => e.render?.(renderState));
  },
  disappear() {
    renderState = {
      ...empty(),
      playerDisappearing: renderState.player,
      opponentDisappearing: renderState.opponent,
    };
    run(() => e.render?.(renderState));
  },
  winner(active = false) {
    renderState = {
      ...empty(),
      winner: pile("winner", 26, "metal", "none", false),
      winAnimationActive: active,
    };
    run(() => e.render?.(renderState));
  },
  clearPiles() {
    renderState = empty();
    run(() => e.render?.(renderState));
  },
  reset() {
    run(() => e.transient?.(false));
  },
  videos() {
    run(() => {
      showVideoReaction(false, 1);
      showVideoReaction(true, 2);
    });
  },
  dispose() {
    run(() => root.unmount());
  },
  bindings() {
    return {
      wager: e.subscribers.size,
      watch: e.watchSubscribers.size,
      material: e.materialSubscribers.size,
      styles: e.styleSubscribers.size,
      squares: e.squareSubscribers.size,
      render: !!e.render,
      layouts: !!e.layouts,
      outside: !!e.outside,
      visible: e.visible(),
      transient: !!e.transient,
    };
  },
};
window.boardWagersHarness = harness;
harness.mount();
