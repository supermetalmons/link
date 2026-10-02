import { emojipackSize, getIncrementedEmojiId } from "../content/emojis";
import { asciimojisCount, getAsciimojiAtIndex } from "../utils/asciimoji";
import { isMobile, getStableRandomIdForProfileId } from "../utils/misc";
import { storage } from "../utils/storage";
import { handleEditDisplayName } from "./identity/profileUiPort";
import { getNextRegularId, parseStickerMap } from "./shinyCardModels";
import { STICKER_ADD_PROMPTS_FRAMES, STICKER_PATHS } from "../utils/stickers";
import type { PlayerProfile } from "../connection/connectionModels";
import { normalizeProfileEmojiId } from "@mons/shared/profiles";
import {
  MonType,
  getMonId,
  mysticTypes,
  spiritTypes,
  demonTypes,
  angelTypes,
  drainerTypes,
  getMonsIndexes,
} from "../utils/namedMons";
import {
  attachRainbowAura,
  setRainbowAuraMask,
  showRainbowAura,
  hideRainbowAura,
} from "./rainbowAura";

const CARD_BACKGROUND_GRADIENT =
  "linear-gradient(135deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.1) 100%)";
const IDLE_SHINE_GRADIENT =
  "linear-gradient(135deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.3) 50%, rgba(255,255,255,0) 100%)";
const HOVER_SHINE_GRADIENT = (percentX: number, percentY: number) =>
  `radial-gradient(circle at ${percentX}% ${percentY}%, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0) 60%)`;
const TRANSITION_SHINE_GRADIENT = (
  lastShineX: number,
  lastShineY: number,
  radialOpacity: number,
  linearOpacity: number,
) =>
  `radial-gradient(circle at ${lastShineX}% ${lastShineY}%,
    rgba(255,255,255,${radialOpacity}) 0%,
    rgba(255,255,255,0) 60%),
  linear-gradient(135deg,
    rgba(255,255,255,0) 0%,
    rgba(255,255,255,${linearOpacity}) 50%,
    rgba(255,255,255,0) 100%)`;

const totalCardBgsCount = 37;
const bubblePlaceholderColor = "white";
const borderedCardAspectRatio = 2217 / 1625;
const cardContentsAspectRatio = 2430 / 1886;

const defaultCardBgIndex = 30;
const defaultSubtitleIndex = 0;

export const CARD_MONS: Record<
  MonType,
  { index: number; left: string; regularCount: number }
> = {
  [MonType.DEMON]: {
    index: 0,
    left: "32.13%",
    regularCount: demonTypes.length,
  },
  [MonType.ANGEL]: {
    index: 1,
    left: "44.35%",
    regularCount: angelTypes.length,
  },
  [MonType.DRAINER]: {
    index: 2,
    left: "56.85%",
    regularCount: drainerTypes.length - 1,
  },
  [MonType.SPIRIT]: {
    index: 3,
    left: "69.2%",
    regularCount: spiritTypes.length,
  },
  [MonType.MYSTIC]: {
    index: 4,
    left: "81.5%",
    regularCount: mysticTypes.length,
  },
};

const cardStyles = `
@media screen and (max-width: 420px){
  [data-shiny-card="true"]{ right:9px !important; }
}
@media screen and (max-width: 387px){
  [data-shiny-card="true"]{ right:7px !important; }
}`;

const SHINY_CARD_Z_INDEX = 100200;

type ShinyCardSessionOptions = {
  profile: PlayerProfile | null;
  displayName: string;
  isOtherPlayer: boolean;
  ownerProfileId: string | null;
  onUpdateContent: (contentType: string, newId: any, oldId: any | null) => void;
  onUndo: () => void;
  getUndoSize: () => number;
  onMonsChanged: () => void;
  onDispose: (session: ShinyCardSession) => void;
};

function getBgIdForProfile(profile: PlayerProfile | null): number {
  return profile?.cardBackgroundId ?? defaultCardBgIndex;
}

function getEmojiIdForProfile(profile: PlayerProfile | null): number {
  return normalizeProfileEmojiId(
    profile?.emoji,
    getStableRandomIdForProfileId(profile?.id ?? "", emojipackSize),
  );
}

function getSubtitleIdForProfile(profile: PlayerProfile | null): number {
  return profile?.cardSubtitleId ?? defaultSubtitleIndex;
}

const getNextRegularCardBackgroundId = (currentBgId: number): number =>
  getNextRegularId(currentBgId, totalCardBgsCount);

export class ShinyCardSession {
  private displayedMonsIndexes: ReturnType<typeof getMonsIndexes> = [
    0, 0, 0, 0, 0,
  ];
  private currentlySelectedStickers: Record<string, string> = {};

  private panelUndoButton: HTMLButtonElement | null = null;
  private isEditingMode = false;

  private ownEmojiImg: HTMLImageElement | null = null;
  private ownEmojiAuraInner: HTMLDivElement | null = null;
  private ownEmojiAuraBackground: HTMLDivElement | null = null;
  private ownBgImg: HTMLImageElement | null = null;
  private ownSubtitleElement: HTMLElement | null = null;
  private nameElement: HTMLElement | null = null;
  private ownMonImages: Partial<Record<MonType, HTMLImageElement>> = {};
  private ownCardContentsLayer: HTMLDivElement | null = null;
  private ownCounterElement: HTMLElement | null = null;
  private editingPanel: HTMLDivElement | null = null;
  private editingPanelKeyboardCleanup: (() => void) | null = null;

  private cardResizeObserver: ResizeObserver | null = null;
  private textElements: Array<{ element: HTMLElement; card: HTMLElement }> = [];
  private stickerElements: Record<string, HTMLImageElement> = {};
  private stickerHitAreas: Record<string, HTMLDivElement> = {};
  private dynamicallyRoundedElements: Array<{
    element: HTMLElement;
    radius: number;
  }> = [];
  private enterEditingMode: (() => void) | null = null;
  private handlePointerLeave: (() => void) | null = null;

  readonly profile: PlayerProfile | null;
  readonly isOtherPlayer: boolean;
  readonly ownerProfileId: string | null;
  private readonly options: ShinyCardSessionOptions;
  private root: HTMLDivElement | null = null;
  private disposed = false;
  private cardIndex = defaultCardBgIndex;
  private asciimojiIndex = defaultSubtitleIndex;
  private readonly timeouts = new Set<number>();
  private readonly frames = new Set<number>();
  private readonly cleanups = new Map<EventTarget, Set<() => void>>();
  private readonly monRevisions: Partial<Record<MonType, number>> = {};
  private removalObserver: MutationObserver | null = null;

  constructor(options: ShinyCardSessionOptions) {
    this.options = options;
    this.profile = options.profile;
    this.isOtherPlayer = options.isOtherPlayer;
    this.ownerProfileId = options.ownerProfileId;
  }

  private isLive(): boolean {
    return (
      !this.disposed &&
      this.root?.isConnected === true &&
      (this.isOtherPlayer ||
        this.ownerProfileId === (storage.getProfileId("").trim() || null))
    );
  }

  private updateContent(
    contentType: string,
    newId: any,
    oldId: any | null,
  ): void {
    if (this.isLive() && !this.isOtherPlayer) {
      this.options.onUpdateContent(contentType, newId, oldId);
    }
  }

  private scheduleTimeout(callback: () => void, delay: number): void {
    if (this.disposed) return;
    const id = window.setTimeout(() => {
      this.timeouts.delete(id);
      if (this.isLive()) callback();
    }, delay);
    this.timeouts.add(id);
  }

  private requestFrame(callback: () => void): void {
    if (this.disposed) return;
    const id = window.requestAnimationFrame(() => {
      this.frames.delete(id);
      if (this.isLive()) callback();
    });
    this.frames.add(id);
  }

  private listen<T extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: T) => void,
    options?: AddEventListenerOptions,
  ): () => void {
    if (this.disposed) return () => {};
    const guarded = (event: Event) => {
      if (this.isLive()) listener(event as T);
    };
    target.addEventListener(type, guarded, options);
    return this.trackCleanup(target, () => {
      target.removeEventListener(type, guarded, options);
    });
  }

  private trackCleanup(target: EventTarget, callback: () => void): () => void {
    const group = this.cleanups.get(target) ?? new Set<() => void>();
    const cleanup = () => {
      callback();
      group.delete(cleanup);
      if (group.size === 0) this.cleanups.delete(target);
    };
    group.add(cleanup);
    this.cleanups.set(target, group);
    return cleanup;
  }

  private releaseElement(element: HTMLElement): void {
    for (const [target, group] of this.cleanups) {
      if (
        target === element ||
        (target instanceof Node && element.contains(target))
      ) {
        for (const cleanup of group) cleanup();
      }
    }
  }

  private setImageCallbacks(
    image: HTMLImageElement,
    onLoad: () => void,
    onError: () => void,
  ): void {
    if (this.disposed) return;
    image.onload = () => {
      if (this.isLive() && image.isConnected) onLoad();
    };
    image.onerror = () => {
      if (this.isLive() && image.isConnected) onError();
    };
    this.trackCleanup(image, () => {
      image.onload = null;
      image.onerror = null;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const frame of this.frames) window.cancelAnimationFrame(frame);
    for (const timeout of this.timeouts) window.clearTimeout(timeout);
    this.frames.clear();
    this.timeouts.clear();
    this.cardResizeObserver?.disconnect();
    this.removalObserver?.disconnect();
    this.cardResizeObserver = null;
    this.removalObserver = null;
    for (const group of this.cleanups.values()) {
      for (const cleanup of group) cleanup();
    }
    this.cleanups.clear();
    this.root?.remove();
    this.root = null;
    this.editingPanelKeyboardCleanup = null;
    this.editingPanel = null;
    this.panelUndoButton = null;
    this.ownEmojiImg = null;
    this.ownEmojiAuraInner = null;
    this.ownEmojiAuraBackground = null;
    this.ownBgImg = null;
    this.ownSubtitleElement = null;
    this.nameElement = null;
    this.ownMonImages = {};
    this.ownCardContentsLayer = null;
    this.ownCounterElement = null;
    this.textElements = [];
    this.stickerElements = {};
    this.stickerHitAreas = {};
    this.dynamicallyRoundedElements = [];
    this.currentlySelectedStickers = {};
    this.enterEditingMode = null;
    this.handlePointerLeave = null;
    this.options.onDispose(this);
  }

  mount(): void {
    if (this.disposed || this.root) return;
    const { profile, isOtherPlayer } = this;
    const { displayName } = this.options;
    this.cardIndex = storage.getCardBackgroundId(defaultCardBgIndex);
    this.asciimojiIndex = storage.getCardSubtitleId(defaultSubtitleIndex);
    this.isEditingMode = false;

    if (!this.cardResizeObserver) {
      this.cardResizeObserver = new ResizeObserver((entries) => {
        if (!this.isLive()) return;
        for (const entry of entries) {
          const card = entry.target as HTMLElement;
          const cardHeight = card.clientHeight;
          this.textElements.forEach((item) => {
            if (item.card === card) {
              item.element.style.fontSize = `${cardHeight * 0.05}px`;
              item.element.parentElement!.style.borderRadius = `${cardHeight * 0.02}px`;
            }
          });
          this.dynamicallyRoundedElements.forEach((item) => {
            item.element.style.borderRadius = `${cardHeight * item.radius}px`;
          });
        }
      });
    }

    const cardContainer = (this.root = document.createElement("div"));
    cardContainer.style.position = "fixed";
    if (isOtherPlayer) {
      cardContainer.style.top = "42%";
      cardContainer.style.left = "50%";
      cardContainer.style.transform = "translate(-50%, -50%)";
    } else {
      cardContainer.style.top = "56px";
      cardContainer.style.right = "12pt";
    }

    cardContainer.style.aspectRatio = `${borderedCardAspectRatio}`;

    const updateCardWidth = () => {
      const calculatedWidth =
        isOtherPlayer && isMobile
          ? window.innerWidth * 0.69
          : Math.min(window.innerWidth * 0.8, 350);
      cardContainer.style.width = `${calculatedWidth}px`;
      const calculatedHeight = calculatedWidth / borderedCardAspectRatio;
      const maxHeight = window.innerHeight * 0.42;
      if (calculatedHeight > maxHeight) {
        cardContainer.style.width = `${maxHeight * borderedCardAspectRatio}px`;
      }
    };
    updateCardWidth();
    this.listen(window, "resize", updateCardWidth);

    cardContainer.style.perspective = "1000px";
    cardContainer.style.zIndex = `${SHINY_CARD_Z_INDEX}`;
    cardContainer.setAttribute("data-shiny-card", "true");
    cardContainer.style.userSelect = "none";
    cardContainer.style.touchAction = "none";
    const styleTag = document.createElement("style");
    styleTag.textContent = cardStyles;
    cardContainer.appendChild(styleTag);

    const card = document.createElement("div");
    card.style.position = "relative";
    card.style.width = "100%";
    card.style.height = "100%";
    card.style.transformStyle = "preserve-3d";
    this.dynamicallyRoundedElements.push({ element: card, radius: 0.05 });
    card.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.3)";
    card.style.background = CARD_BACKGROUND_GRADIENT;
    card.style.cursor = "pointer";
    card.style.willChange = "transform";
    card.style.userSelect = "none";
    card.style.overflow = "hidden";
    card.style.backdropFilter = "blur(3px)";
    card.setAttribute(
      "style",
      card.getAttribute("style") + "-webkit-backdrop-filter: blur(3px);",
    );

    const cardContentsLayer = document.createElement("div");
    cardContentsLayer.style.position = "relative";
    cardContentsLayer.style.width = "100%";
    cardContentsLayer.style.aspectRatio = `${cardContentsAspectRatio}`;
    this.dynamicallyRoundedElements.push({
      element: cardContentsLayer,
      radius: 0.05,
    });
    cardContentsLayer.style.overflow = "hidden";
    cardContentsLayer.style.transform = "translateY(-2.77%) scale(1.03)";
    cardContentsLayer.style.transformOrigin = "center";

    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.position = "absolute";
    img.style.top = "0";
    img.style.left = "0";
    img.style.right = "0";
    img.style.bottom = "0";
    img.style.margin = "auto";
    img.style.userSelect = "none";
    img.style.pointerEvents = "none";
    img.draggable = false;
    const bgId = isOtherPlayer ? getBgIdForProfile(profile) : this.cardIndex;
    img.src = `https://cdn.lil.org/mons/id_cards/backgrounds/${bgId}.webp`;
    img.style.visibility = "hidden";
    this.setImageCallbacks(
      img,
      () => {
        if (this.ownBgImg !== img || !img.isConnected) {
          return;
        }
        img.style.visibility = "visible";
        this.showHiddenWaitingStickers();
      },
      () => {
        img.style.visibility = "hidden";
      },
    );

    const emojiContainer = document.createElement("div");
    emojiContainer.style.position = "absolute";
    emojiContainer.style.backgroundColor = bubblePlaceholderColor;
    emojiContainer.style.width = "24.9%";
    emojiContainer.style.aspectRatio = "1";
    emojiContainer.style.top = "13.3%";
    emojiContainer.style.left = "7.65%";
    emojiContainer.style.borderRadius = "7%";
    emojiContainer.style.boxShadow = "0 0 1px 1px rgba(0, 0, 0, 0.1)";
    emojiContainer.style.userSelect = "none";
    emojiContainer.style.cursor = "pointer";
    emojiContainer.style.outline = "none";
    emojiContainer.style.setProperty(
      "-webkit-tap-highlight-color",
      "transparent",
    );
    emojiContainer.style.setProperty("-webkit-touch-callout", "none");
    emojiContainer.style.transition = "transform 0.13s ease-out";

    const updateEmojiScale = (event: MouseEvent) => {
      emojiContainer.style.transform = `scale(${event.type === "mouseleave" || !this.isEditingMode ? 1 : 1.023})`;
    };

    if (!isMobile) {
      this.listen(emojiContainer, "mouseenter", updateEmojiScale);
      this.listen(emojiContainer, "mouseleave", updateEmojiScale);
      this.listen(emojiContainer, "mousemove", updateEmojiScale);
    }

    const emojiPlaceholder = document.createElement("div");
    emojiPlaceholder.style.position = "absolute";
    emojiPlaceholder.style.width = "65%";
    emojiPlaceholder.style.height = "65%";
    emojiPlaceholder.style.top = "50%";
    emojiPlaceholder.style.left = "50%";
    emojiPlaceholder.style.transform = "translate(-50%, -50%)";
    emojiPlaceholder.style.borderRadius = "50%";
    emojiPlaceholder.style.backgroundColor = "gray";
    emojiPlaceholder.style.opacity = "0.1";
    emojiPlaceholder.style.pointerEvents = "none";
    emojiPlaceholder.style.zIndex = "0";

    let rainbowAuraBackground: HTMLDivElement | null = null;
    let rainbowAuraInner: HTMLDivElement | null = null;
    {
      const attached = attachRainbowAura(emojiContainer);
      rainbowAuraBackground = attached.background;
      rainbowAuraInner = attached.inner;
    }
    emojiContainer.appendChild(emojiPlaceholder);
    this.ownEmojiAuraInner = rainbowAuraInner;
    this.ownEmojiAuraBackground = rainbowAuraBackground;

    const emojiImg = document.createElement("img");
    emojiImg.crossOrigin = "anonymous";
    emojiImg.style.position = "absolute";
    emojiImg.style.width = "100%";
    emojiImg.style.height = "100%";
    emojiImg.style.top = "0";
    emojiImg.style.left = "0";
    emojiImg.style.userSelect = "none";
    emojiImg.style.visibility = "hidden";
    emojiImg.style.zIndex = "2";
    emojiImg.draggable = false;
    emojiImg.src = `https://cdn.lil.org/mons/emojipack/regular/${isOtherPlayer ? getEmojiIdForProfile(profile) : storage.getPlayerEmojiId("1")}.webp`;
    this.setImageCallbacks(
      emojiImg,
      () => {
        emojiImg.style.visibility = "visible";
        emojiPlaceholder.style.visibility = "hidden";
        if (rainbowAuraInner)
          setRainbowAuraMask(rainbowAuraInner, emojiImg.src);
        if (rainbowAuraBackground) {
          const currentAura = isOtherPlayer
            ? (profile?.aura ?? "")
            : storage.getPlayerEmojiAura("");
          if (currentAura === "rainbow") {
            showRainbowAura(rainbowAuraBackground);
          } else {
            hideRainbowAura(rainbowAuraBackground);
          }
        }
      },
      () => {
        emojiImg.style.visibility = "hidden";
        if (rainbowAuraBackground) hideRainbowAura(rainbowAuraBackground);
      },
    );
    emojiContainer.appendChild(emojiImg);
    this.listen<MouseEvent>(emojiContainer, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isMobile && this.handlePointerLeave) {
        this.handlePointerLeave();
      }
      if (isOtherPlayer) {
        return;
      }

      if (!this.isEditingMode && this.enterEditingMode) {
        this.enterEditingMode();
        if (!isMobile) {
          updateEmojiScale(e);
        }
        return;
      }

      if (isMobile) {
        emojiContainer.style.transform = "scale(0.95)";
        this.scheduleTimeout(() => {
          emojiContainer.style.transform = "scale(1)";
        }, 130);
      } else {
        emojiContainer.style.transform = "scale(0.95)";
        this.scheduleTimeout(() => {
          emojiContainer.style.transform = "scale(1.023)";
        }, 130);
      }

      const oldEmojiId = storage.getPlayerEmojiId("1");
      const oldAura = storage.getPlayerEmojiAura("");
      const playerEmojiId = getIncrementedEmojiId(oldEmojiId);
      this.updateContent(
        "emojiAndAura",
        { emojiId: playerEmojiId, aura: "" },
        { emojiId: oldEmojiId, aura: oldAura },
      );
    });
    this.ownEmojiImg = emojiImg;

    const placeholder = document.createElement("div");
    placeholder.style.position = "absolute";
    placeholder.style.width = "90.5%";
    placeholder.style.height = "83%";
    placeholder.style.backgroundColor = "var(--card-color)";

    placeholder.style.outline = "1px solid var(--shinyCardOutlineColor)";

    this.dynamicallyRoundedElements.push({
      element: placeholder,
      radius: 0.035,
    });
    placeholder.style.top = "50.7%";
    placeholder.style.left = "50%";
    placeholder.style.transform = "translate(-50%, -50%)";
    placeholder.style.userSelect = "none";
    placeholder.style.pointerEvents = "none";

    const shinyOverlay = document.createElement("div");
    shinyOverlay.style.position = "absolute";
    shinyOverlay.style.top = "0";
    shinyOverlay.style.left = "0";
    shinyOverlay.style.width = "100%";
    shinyOverlay.style.height = "100%";
    this.dynamicallyRoundedElements.push({
      element: shinyOverlay,
      radius: 0.05,
    });
    shinyOverlay.style.background = IDLE_SHINE_GRADIENT;
    shinyOverlay.style.opacity = "0.63";
    shinyOverlay.style.pointerEvents = "none";
    shinyOverlay.style.zIndex = "100";
    shinyOverlay.style.transition = "none";
    shinyOverlay.style.willChange = "background";
    shinyOverlay.style.userSelect = "none";

    this.listen(cardContainer, "contextmenu", (e) => {
      e.preventDefault();
      return false;
    });

    let isMouseOver = false;
    let time = Math.random() * Math.PI * 2;
    let animationStartDelay = 1500;
    let animationStartTime = Date.now() + animationStartDelay;
    let animationIntensity = 0;

    let lastMouseX = 50;
    let lastMouseY = 50;
    let lastShineX = 50;
    let lastShineY = 50;
    let transitioningFromMouse = false;
    let transitionProgress = 0;
    const standardTransitionDuration = 180;

    let currentRotateX = 0;
    let currentRotateY = 0;
    let targetRotateX = 0;
    let targetRotateY = 0;
    let editRevision = 0;
    const easeAmount = 0.15;

    this.enterEditingMode = () => {
      if (this.isEditingMode || isOtherPlayer) return;

      if (this.handlePointerLeave) {
        this.handlePointerLeave();
      }

      this.isEditingMode = true;
      const currentEditRevision = ++editRevision;
      isMouseOver = false;

      const startX = lastShineX;
      const startY = lastShineY;
      const startTime = Date.now();
      const animationDuration = 500;

      if (cardContainer) {
        cardContainer.style.transition = "transform 0.3s ease-out";
        cardContainer.style.transformOrigin = "top right";
        cardContainer.style.transform = "scale(1.03)";
      }

      cardContentsLayer.style.transition = "transform 0.3s ease-out";
      cardContentsLayer.style.transform = "translateY(-2.81%) scale(1.042)";

      const animateDisperse = () => {
        if (!this.isEditingMode || editRevision !== currentEditRevision) {
          return;
        }
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / animationDuration, 1);
        const easedProgress = 1 - Math.pow(1 - progress, 3);
        const dispersedX = 50 + (startX - 50) * (1 - easedProgress);
        const dispersedY = 50 + (startY - 50) * (1 - easedProgress);
        const opacity = 1 - easedProgress;
        shinyOverlay.style.background = TRANSITION_SHINE_GRADIENT(
          dispersedX,
          dispersedY,
          opacity * 0.8,
          opacity * 0.3,
        );
        if (progress < 1) {
          this.requestFrame(animateDisperse);
        } else {
          shinyOverlay.style.background = "none";
        }
      };
      animateDisperse();
      this.showHitAreasForStickersThatAreNotSet();
      showEditingPanel();
    };

    const exitEditingMode = () => {
      if (!this.isEditingMode || isOtherPlayer) return;

      this.isEditingMode = false;
      editRevision += 1;

      if (cardContainer) {
        cardContainer.style.transition = "transform 0.3s ease-out";
        cardContainer.style.transform = "scale(1)";
      }

      cardContentsLayer.style.transition = "transform 0.3s ease-out";
      cardContentsLayer.style.transform = "translateY(-2.77%) scale(1.03)";

      Object.keys(STICKER_ADD_PROMPTS_FRAMES).forEach((stickerType) => {
        if (!this.currentlySelectedStickers[stickerType]) {
          const hitArea = this.stickerHitAreas[stickerType];
          if (hitArea) {
            hitArea.style.opacity = "0";
            this.scheduleTimeout(() => {
              if (!this.disposed && this.isEditingMode) {
                hitArea.style.opacity = "1";
                return;
              }
              if (hitArea.parentNode) {
                this.releaseElement(hitArea);
                hitArea.parentNode.removeChild(hitArea);
              }
              if (
                !this.disposed &&
                this.stickerHitAreas[stickerType] === hitArea
              ) {
                delete this.stickerHitAreas[stickerType];
              }
            }, 200);
          }
        }
      });

      shinyOverlay.style.background = IDLE_SHINE_GRADIENT;
      hideEditingPanel();
    };

    const showEditingPanel = () => {
      if (this.editingPanel || isOtherPlayer) return;

      this.editingPanel = document.createElement("div");
      this.editingPanel.className = "shiny-card-editing-panel";

      const undoBtn = document.createElement("button");
      undoBtn.className = "shiny-card-undo-button";
      undoBtn.disabled = this.options.getUndoSize() === 0;

      const undoSvg = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      undoSvg.setAttribute("viewBox", "0 0 512 512");
      undoSvg.style.width = "14px";
      undoSvg.style.height = "14px";
      undoSvg.style.fill = "currentColor";

      const undoPath = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      undoPath.setAttribute(
        "d",
        "M125.7 160H176c17.7 0 32 14.3 32 32s-14.3 32-32 32H48c-17.7 0-32-14.3-32-32V64c0-17.7 14.3-32 32-32s32 14.3 32 32v51.2L97.6 97.6c87.5-87.5 229.3-87.5 316.8 0s87.5 229.3 0 316.8s-229.3 87.5-316.8 0c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0c62.5 62.5 163.8 62.5 226.3 0s62.5-163.8 0-226.3s-163.8-62.5-226.3 0L125.7 160z",
      );

      undoSvg.appendChild(undoPath);
      undoBtn.appendChild(undoSvg);

      const doneButton = document.createElement("button");
      doneButton.textContent = "Done";
      doneButton.className = "shiny-card-done-button";

      const handleUndoAction = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        this.options.onUndo();
      };

      const handleDoneAction = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        exitEditingMode();
      };

      this.listen(undoBtn, "click", handleUndoAction);
      this.listen(doneButton, "click", handleDoneAction);

      const editingPanelKeyboardHandler = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === "Escape") {
          handleDoneAction(e);
        } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
          e.preventDefault();
          if (this.options.getUndoSize() > 0) {
            handleUndoAction(e);
          }
        }
      };

      undoBtn.tabIndex = 0;
      doneButton.tabIndex = 0;

      this.editingPanel.appendChild(undoBtn);
      this.editingPanel.appendChild(doneButton);
      cardContainer.appendChild(this.editingPanel);
      this.editingPanelKeyboardCleanup = this.listen(
        document,
        "keydown",
        editingPanelKeyboardHandler,
      );
      this.panelUndoButton = undoBtn;

      const panelToShow = this.editingPanel;
      this.requestFrame(() => {
        if (this.editingPanel !== panelToShow || !panelToShow.isConnected) {
          return;
        }
        panelToShow.style.opacity = "1";
        doneButton.focus();
      });
    };

    const hideEditingPanel = () => {
      if (!this.editingPanel) return;
      const panelToHide = this.editingPanel;

      this.editingPanelKeyboardCleanup?.();
      this.editingPanelKeyboardCleanup = null;

      this.panelUndoButton = null;
      panelToHide.style.opacity = "0";
      this.editingPanel = null;
      this.scheduleTimeout(() => {
        if (panelToHide.parentNode) {
          this.releaseElement(panelToHide);
          panelToHide.parentNode.removeChild(panelToHide);
        }
      }, 300);
    };

    const animateCard = () => {
      const now = Date.now();

      if (now > animationStartTime) {
        animationIntensity = Math.min(1, (now - animationStartTime) / 2000);
      }

      time += 0.01;

      if (isMouseOver) {
        currentRotateX += (targetRotateX - currentRotateX) * easeAmount;
        currentRotateY += (targetRotateY - currentRotateY) * easeAmount;

        card.style.transform = `rotateY(${currentRotateY}deg) rotateX(${currentRotateX}deg)`;

        lastMouseX = currentRotateX;
        lastMouseY = currentRotateY;

        transitioningFromMouse = false;
        transitionProgress = 0;
      } else {
        const naturalRotateX = Math.sin(time) * 3 * animationIntensity;
        const naturalRotateY = Math.cos(time * 0.8) * 3 * animationIntensity;

        if (transitioningFromMouse) {
          const transitionDuration = this.isEditingMode
            ? 50
            : standardTransitionDuration;
          transitionProgress = Math.min(
            transitionProgress + 1,
            transitionDuration,
          );
          const t = transitionProgress / transitionDuration;

          const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
          const easedT = easeOutCubic(t);

          currentRotateX = (1 - easedT) * lastMouseX + easedT * naturalRotateX;
          currentRotateY = (1 - easedT) * lastMouseY + easedT * naturalRotateY;

          card.style.transform = `rotateY(${currentRotateY}deg) rotateX(${currentRotateX}deg)`;

          if (transitionProgress < transitionDuration) {
            const radialOpacity = (1 - easedT) * 0.8;
            const linearOpacity = easedT * 0.3;

            if (!this.isEditingMode) {
              shinyOverlay.style.background = TRANSITION_SHINE_GRADIENT(
                lastShineX,
                lastShineY,
                radialOpacity,
                linearOpacity,
              );
            }
          } else {
            if (!this.isEditingMode) {
              shinyOverlay.style.background = IDLE_SHINE_GRADIENT;
            }
            transitioningFromMouse = false;
          }
        } else if (!this.isEditingMode) {
          currentRotateX += (naturalRotateX - currentRotateX) * 0.05;
          currentRotateY += (naturalRotateY - currentRotateY) * 0.05;

          card.style.transform = `rotateY(${currentRotateY}deg) rotateX(${currentRotateX}deg)`;

          shinyOverlay.style.background = IDLE_SHINE_GRADIENT;
        }
      }

      this.requestFrame(animateCard);
    };

    currentRotateX = 0;
    currentRotateY = 0;

    this.requestFrame(animateCard);

    let lastMoveTime = 0;
    const moveThreshold = 5;

    const handlePointerMove = (e: MouseEvent | TouchEvent) => {
      if (this.isEditingMode) return;
      const now = Date.now();
      if (now - lastMoveTime < moveThreshold) return;
      lastMoveTime = now;

      isMouseOver = true;

      const rect = cardContainer.getBoundingClientRect();

      let clientX, clientY;
      if ("touches" in e) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = (e as MouseEvent).clientX;
        clientY = (e as MouseEvent).clientY;
      }

      const x = clientX - rect.left;
      const y = clientY - rect.top;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      targetRotateY = (x - centerX) / 15;
      targetRotateX = (centerY - y) / 15;

      const percentX = (x / rect.width) * 100;
      const percentY = (y / rect.height) * 100;

      lastShineX = percentX;
      lastShineY = percentY;

      shinyOverlay.style.background = HOVER_SHINE_GRADIENT(percentX, percentY);
    };

    this.handlePointerLeave = () => {
      if (this.isEditingMode) return;
      isMouseOver = false;
      transitioningFromMouse = true;
      transitionProgress = 0;
    };

    if (isMobile) {
      this.listen(cardContainer, "touchmove", handlePointerMove, {
        passive: true,
      });
      this.listen(cardContainer, "touchstart", handlePointerMove, {
        passive: true,
      });
      this.listen(cardContainer, "touchend", this.handlePointerLeave);
      this.listen(cardContainer, "touchcancel", this.handlePointerLeave);
    } else {
      this.listen(cardContainer, "mousemove", handlePointerMove);
      this.listen(cardContainer, "mouseleave", this.handlePointerLeave);
    }

    this.listen(card, "click", () => {
      if (isMobile && this.handlePointerLeave) {
        this.handlePointerLeave();
      }
      if (isOtherPlayer) {
        return;
      }
      if (!this.isEditingMode && this.enterEditingMode) {
        this.enterEditingMode();
        return;
      }
      this.updateContent(
        "bg",
        getNextRegularCardBackgroundId(this.cardIndex),
        this.cardIndex,
      );
    });
    this.ownBgImg = img;

    cardContentsLayer.appendChild(placeholder);
    cardContentsLayer.appendChild(img);
    cardContentsLayer.appendChild(emojiContainer);
    cardContentsLayer.appendChild(shinyOverlay);
    card.appendChild(cardContentsLayer);
    this.ownCardContentsLayer = cardContentsLayer;

    if (this.cardResizeObserver) {
      this.cardResizeObserver.observe(cardContentsLayer);
    }

    const textBubbleHeight = "8.6%";
    this.nameElement = this.addTextBubble(
      cardContentsLayer,
      displayName,
      "34.3%",
      "26%",
      textBubbleHeight,
      () => {
        if (isOtherPlayer) {
          const eth = profile?.eth;
          const sol = profile?.sol;
          if (eth) {
            window.open(
              `https://etherscan.io/address/${eth}`,
              "_blank",
              "noopener,noreferrer",
            );
          } else if (sol) {
            window.open(
              `https://explorer.solana.com/address/${sol}`,
              "_blank",
              "noopener,noreferrer",
            );
          }
        } else {
          handleEditDisplayName();
        }
      },
    );

    const ratingText = isOtherPlayer
      ? (profile?.rating ?? 1500).toString()
      : storage.getPlayerRating(1500).toString();
    this.addTextBubble(
      cardContentsLayer,
      ratingText,
      "34.3%",
      "36.6%",
      textBubbleHeight,
    );

    const subtitleText = getAsciimojiAtIndex(
      isOtherPlayer ? getSubtitleIdForProfile(profile) : this.asciimojiIndex,
    );
    this.ownSubtitleElement = this.addTextBubble(
      cardContentsLayer,
      subtitleText,
      "7.4%",
      "47.5%",
      textBubbleHeight,
      () => {
        if (isOtherPlayer) {
          return;
        }
        this.updateContent(
          "subtitle",
          (this.asciimojiIndex + 1) % asciimojisCount,
          this.asciimojiIndex,
        );
      },
    );

    const gpValue =
      (isOtherPlayer ? (profile?.nonce ?? -1) : storage.getPlayerNonce(-1)) + 1;
    const mpValue = isOtherPlayer
      ? (profile?.totalManaPoints ?? 0)
      : storage.getPlayerTotalManaPoints(0);

    const profileCounter = isOtherPlayer
      ? (profile?.profileCounter ?? "gp")
      : storage.getProfileCounter("gp");
    const counterText =
      profileCounter === "mp" ? `mp: ${mpValue}` : `gp: ${gpValue}`;

    let currentViewCounter = profileCounter;

    this.ownCounterElement = this.addTextBubble(
      cardContentsLayer,
      counterText,
      "7.4%",
      "58.7%",
      textBubbleHeight,
      () => {
        if (isOtherPlayer) {
          currentViewCounter = currentViewCounter === "gp" ? "mp" : "gp";
          const newCounterText =
            currentViewCounter === "mp" ? `mp: ${mpValue}` : `gp: ${gpValue}`;
          if (this.ownCounterElement) {
            this.ownCounterElement.textContent = newCounterText;
          }
          return;
        }
        const currentCounter = storage.getProfileCounter("gp");
        const newCounter = currentCounter === "gp" ? "mp" : "gp";
        this.updateContent("profileCounter", newCounter, currentCounter);
      },
      isOtherPlayer,
    );

    cardContainer.appendChild(card);
    document.body.appendChild(cardContainer);

    this.removalObserver = new MutationObserver(() => {
      if (!cardContainer.isConnected) this.dispose();
    });
    this.removalObserver.observe(document.body, { childList: true });
    void this.showMons(cardContentsLayer, isOtherPlayer, profile).catch(
      () => {},
    );
    if (!this.isLive() || !card.isConnected) {
      return;
    }

    const stickersJson = isOtherPlayer
      ? (profile?.cardStickers ?? "")
      : storage.getCardStickers("");
    this.displayStickers(cardContentsLayer, stickersJson);
    this.updateUndoButton();
  }

  private showHiddenWaitingStickers() {
    Object.values(this.stickerElements).forEach((sticker) => {
      sticker.style.visibility = "visible";
    });
  }

  private didUpdateSticker(
    stickerType: string,
    nextSticker: string | undefined,
  ) {
    if (nextSticker) {
      const element = this.stickerElements[stickerType];
      if (element) {
        const stickerUrl = `https://cdn.lil.org/mons/id_cards/stickers_overlays/${stickerType}/${nextSticker}.webp`;
        element.src = stickerUrl;
        const hitArea = this.stickerHitAreas[stickerType];
        if (hitArea) {
          this.applyStickerFrame(hitArea, stickerType, nextSticker, element);
        }
      } else if (this.ownCardContentsLayer) {
        this.appendStickerLayer(
          this.ownCardContentsLayer,
          stickerType,
          nextSticker,
        );
      }
    } else {
      const element = this.stickerElements[stickerType];
      if (element) {
        this.releaseElement(element);
        element.remove();
        delete this.stickerElements[stickerType];
      }

      this.setupHitAreaForStickerType(stickerType, true, false);
    }
  }

  private cleanUpVisibleHitAreaWhenStickerIsSet(hitArea: HTMLElement) {
    hitArea.style.background = "none";
    hitArea.style.borderRadius = "0%";
    hitArea.style.boxShadow = "none";
    while (hitArea.firstChild) {
      hitArea.removeChild(hitArea.firstChild);
    }
  }

  private showHitAreasForStickersThatAreNotSet() {
    Object.keys(STICKER_ADD_PROMPTS_FRAMES).forEach((stickerType) => {
      if (!this.currentlySelectedStickers[stickerType]) {
        this.setupHitAreaForStickerType(stickerType, true, true);
      }
    });
  }

  private setupHitAreaForStickerType(
    stickerType: string,
    visible: boolean,
    animated: boolean,
  ): HTMLDivElement {
    let hitArea = this.stickerHitAreas[stickerType];
    if (!hitArea) {
      hitArea = document.createElement("div");
      hitArea.style.position = "absolute";
      hitArea.style.userSelect = "none";
      hitArea.style.outline = "none";
      hitArea.style.setProperty("-webkit-tap-highlight-color", "transparent");
      hitArea.style.setProperty("-webkit-touch-callout", "none");
      hitArea.style.pointerEvents = "auto";

      const updateStickerScale = (event: MouseEvent) => {
        if (!isMobile) {
          hitArea.style.transform = `scale(${event.type === "mouseleave" || !this.isEditingMode ? 1 : 1.095})`;
          const element = this.stickerElements[stickerType];
          if (element) {
            element.style.transform = `scale(${event.type === "mouseleave" || !this.isEditingMode ? 1 : 1.095})`;
          }
        }
      };

      this.listen<MouseEvent>(hitArea, "click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isMobile && this.handlePointerLeave) {
          this.handlePointerLeave?.();
        }
        if (!this.isEditingMode && this.enterEditingMode) {
          this.enterEditingMode();
          if (!isMobile) {
            updateStickerScale(e);
          }
          return;
        }
        this.handleStickerClick(stickerType);

        const element = this.stickerElements[stickerType];
        if (!isMobile) {
          hitArea.style.transform = "scale(0.95)";
          if (element) {
            element.style.transform = "scale(0.95)";
          }
          this.scheduleTimeout(() => {
            hitArea.style.transform = "scale(1.095)";
            if (element) {
              element.style.transform = "scale(1.095)";
            }
            this.scheduleTimeout(() => {
              const rect = hitArea.getBoundingClientRect();
              const isPointerInside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
              if (!isPointerInside) {
                hitArea.style.transform = "scale(1)";
                if (element) {
                  element.style.transform = "scale(1)";
                }
              }
            }, 130);
          }, 130);
        } else {
          hitArea.style.transform = "scale(0.95)";
          if (element) {
            element.style.transform = "scale(0.95)";
          }
          this.scheduleTimeout(() => {
            hitArea.style.transform = "scale(1)";
            if (element) {
              element.style.transform = "scale(1)";
            }
          }, 130);
        }
      });
      if (this.ownCardContentsLayer) {
        hitArea.style.transition =
          "opacity 0.2s ease-out, transform 0.13s ease-out";
        if (visible && animated) {
          hitArea.style.opacity = "0";
          this.ownCardContentsLayer.appendChild(hitArea);
          this.requestFrame(() => {
            hitArea.style.opacity = "1";
          });
        } else {
          this.ownCardContentsLayer.appendChild(hitArea);
        }
      }

      this.listen(hitArea, "mouseenter", updateStickerScale);
      this.listen(hitArea, "mouseleave", updateStickerScale);
      this.listen(hitArea, "mousemove", updateStickerScale);
      this.stickerHitAreas[stickerType] = hitArea;
    }

    if (visible) {
      const blue = "var(--link-color-dark)";
      hitArea.style.background = "white";
      const frame = STICKER_ADD_PROMPTS_FRAMES[stickerType];
      if (frame) {
        const width = frame.w * 100;
        const height = width * cardContentsAspectRatio;
        hitArea.style.width = `${width}%`;
        hitArea.style.height = `${height}%`;
        hitArea.style.borderRadius = "50%";
        hitArea.style.left = `${frame.x * 100 - width * 0.5}%`;
        hitArea.style.top = `${frame.y * 100 - height * 0.5}%`;
        hitArea.style.boxShadow = "0 0 1px 1px rgba(0, 0, 0, 0.1)";

        const plusSvg = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        plusSvg.setAttribute("viewBox", "0 0 24 24");
        plusSvg.style.position = "absolute";
        plusSvg.style.left = "50%";
        plusSvg.style.top = "50%";
        plusSvg.style.transform = "translate(-50%, -50%)";
        plusSvg.style.width = "50%";
        plusSvg.style.height = "50%";
        plusSvg.style.fill = blue;
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute("d", "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z");
        path.style.strokeWidth = "3";
        path.style.stroke = blue;
        plusSvg.appendChild(path);
        hitArea.appendChild(plusSvg);
      }
    }

    return hitArea;
  }

  private displayStickers(
    cardContentsLayer: HTMLElement,
    stickersJson: string,
  ) {
    const selectedStickers = parseStickerMap(stickersJson);
    this.currentlySelectedStickers = selectedStickers;
    for (const [path, sticker] of Object.entries(selectedStickers)) {
      this.appendStickerLayer(cardContentsLayer, path, sticker);
    }
  }

  private handleStickerClick(type: string) {
    const stickersForType = STICKER_PATHS[type];
    const currentSticker = this.currentlySelectedStickers[type];

    let nextSticker: string | undefined;

    if (!currentSticker) {
      nextSticker = stickersForType[0]?.name;
    } else {
      const currentIndex = stickersForType.findIndex(
        (s) => s.name === currentSticker,
      );
      if (currentIndex === stickersForType.length - 1 || currentIndex === -1) {
        nextSticker = undefined;
      } else {
        nextSticker = stickersForType[currentIndex + 1]?.name;
        if (nextSticker === "gate") {
          nextSticker = stickersForType[currentIndex + 2]?.name;
        }
      }
    }

    this.updateContent(type, nextSticker, currentSticker);
  }

  private appendStickerLayer(to: HTMLElement, type: string, name: string) {
    const stickers = this.createOverlayStickersImage(type, name);
    to.appendChild(stickers);

    const hitArea = this.stickerHitAreas[type];
    if (hitArea) {
      this.applyStickerFrame(hitArea, type, name, stickers);
      this.cleanUpVisibleHitAreaWhenStickerIsSet(hitArea);
    } else {
      const rect = this.setupHitAreaForStickerType(type, false, false);
      this.applyStickerFrame(rect, type, name, stickers);
    }

    this.stickerElements[type] = stickers;
  }

  private applyStickerFrame(
    hitArea: HTMLElement,
    type: string,
    name: string,
    stickerElement: HTMLElement,
  ) {
    const stickerPath = STICKER_PATHS[type]?.find(
      (sticker) => sticker.name === name,
    );
    if (!stickerPath) return;
    const { x, y, w, h } = stickerPath;
    hitArea.style.left = `${x * 100}%`;
    hitArea.style.top = `${y * 100}%`;
    hitArea.style.width = `${w * 100}%`;
    hitArea.style.height = `${h * 100}%`;

    const centerX = x + w / 2;
    const centerY = y + h / 2;
    stickerElement.style.transformOrigin = `${centerX * 100}% ${centerY * 100}%`;
  }

  private addImageToCard(
    cardContentsLayer: HTMLElement,
    leftPosition: string,
    topPosition: string,
    imageData: string,
    alpha: number,
    monType: MonType | "" = "",
    isOtherPlayer: boolean,
  ): HTMLElement {
    const imageContainer = document.createElement("div");
    imageContainer.style.position = "absolute";
    imageContainer.style.left = leftPosition;
    imageContainer.style.top = topPosition;
    imageContainer.style.backgroundColor = bubblePlaceholderColor;
    imageContainer.style.width = "10.7%";
    imageContainer.style.borderRadius = "10%";
    imageContainer.style.boxShadow = "0 0 1px 1px rgba(0, 0, 0, 0.1)";
    imageContainer.style.aspectRatio = "1";
    imageContainer.style.overflow = "hidden";
    imageContainer.style.userSelect = "none";
    imageContainer.style.pointerEvents = monType ? "auto" : "none";
    imageContainer.setAttribute(
      "style",
      imageContainer.getAttribute("style") +
        "-webkit-tap-highlight-color: transparent; outline: none; -webkit-touch-callout: none;",
    );

    if (imageData) {
      const img = document.createElement("img");
      img.crossOrigin = "anonymous";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      img.style.objectPosition = "0% 50%";
      img.style.display = "block";
      img.style.imageRendering = "pixelated";
      img.style.opacity = alpha.toString();
      img.style.userSelect = "none";
      img.style.pointerEvents = "none";
      img.setAttribute(
        "style",
        img.getAttribute("style") + "-webkit-tap-highlight-color: transparent;",
      );
      img.draggable = false;
      img.src = `data:image/webp;base64,${imageData}`;
      this.setImageCallbacks(
        img,
        () => {
          img.style.visibility = "visible";
        },
        () => {
          img.style.visibility = "hidden";
        },
      );

      if (monType) {
        const updateMonScale = (event: MouseEvent) => {
          if (!isMobile) {
            imageContainer.style.transform = `scale(${event.type === "mouseleave" || !this.isEditingMode ? 1 : 1.05})`;
          }
        };

        this.listen<MouseEvent>(imageContainer, "click", async (event) => {
          event.preventDefault();
          event.stopPropagation();

          if (isMobile) {
            this.handlePointerLeave?.();
          }

          if (!isOtherPlayer) {
            if (!this.isEditingMode && this.enterEditingMode) {
              this.enterEditingMode();
              if (!isMobile) {
                updateMonScale(event);
              }
              return;
            }

            if (isMobile) {
              imageContainer.style.transform = "scale(0.95)";
              this.scheduleTimeout(() => {
                imageContainer.style.transform = "scale(1)";
              }, 130);
            } else {
              imageContainer.style.transform = "scale(0.95)";
              this.scheduleTimeout(() => {
                imageContainer.style.transform = "scale(1.023)";
              }, 130);
            }

            this.didClickMonImage(monType);
          }
        });

        imageContainer.style.transition = "transform 0.13s ease-out";

        this.listen(imageContainer, "mouseenter", updateMonScale);
        this.listen(imageContainer, "mouseleave", updateMonScale);
        this.listen(imageContainer, "mousemove", updateMonScale);

        this.ownMonImages[monType] = img;
      }

      imageContainer.appendChild(img);
    }

    cardContentsLayer.appendChild(imageContainer);
    return imageContainer;
  }

  private addTextBubble(
    cardContentsLayer: HTMLElement,
    text: string,
    left: string,
    top: string,
    height: string,
    onClick?: () => void,
    skipEditingModeCheck?: boolean,
  ): HTMLElement {
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.left = left;
    container.style.top = top;
    container.style.height = height;
    container.style.maxWidth = "57.5%";
    container.style.padding = "0 2.6% 0 2.3%";
    container.style.boxSizing = "border-box";
    container.style.backgroundColor = bubblePlaceholderColor;
    container.style.opacity = "1";
    container.style.overflow = "hidden";
    container.style.display = "inline-flex";
    container.style.justifyContent = "center";
    container.style.alignItems = "center";
    container.style.userSelect = "none";
    container.style.pointerEvents = "auto";
    container.style.boxShadow = "0 0 1px 1px rgba(0, 0, 0, 0.1)";
    container.setAttribute(
      "style",
      container.getAttribute("style") +
        "-webkit-tap-highlight-color: transparent; outline: none; -webkit-touch-callout: none;",
    );

    const updateTextContainerScale = (event: MouseEvent) => {
      if (!isMobile) {
        container.style.transform = `scale(${event.type === "mouseleave" || !this.isEditingMode ? 1 : 1.035})`;
      }
    };

    if (onClick) {
      container.style.transition = "transform 0.13s ease-out";
      this.listen(container, "mouseenter", updateTextContainerScale);
      this.listen(container, "mouseleave", updateTextContainerScale);
      this.listen(container, "mousemove", updateTextContainerScale);
    }

    const textElement = document.createElement("span");
    textElement.textContent = text;
    textElement.style.whiteSpace = "nowrap";
    textElement.style.color = "var(--shinyCardTextColor)";
    textElement.style.fontFamily = "Arial, sans-serif";
    textElement.style.fontSize = "0.75em";
    textElement.style.fontWeight = "630";
    textElement.style.pointerEvents = "none";
    textElement.style.userSelect = "none";
    container.appendChild(textElement);

    this.textElements.push({ element: textElement, card: cardContentsLayer });
    const cardHeight = cardContentsLayer.clientHeight;
    if (cardHeight > 0) {
      textElement.style.fontSize = `${cardHeight * 0.05}px`;
      container.style.borderRadius = `${cardHeight * 0.02}px`;
    }

    this.listen<MouseEvent>(container, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (isMobile) {
        this.handlePointerLeave?.();
      }

      if (
        !skipEditingModeCheck &&
        !this.isEditingMode &&
        this.enterEditingMode
      ) {
        this.enterEditingMode();
        if (!isMobile) {
          updateTextContainerScale(event);
        }
        return;
      }

      if (onClick) {
        if (isMobile) {
          container.style.transform = "scale(0.95)";
          this.scheduleTimeout(() => {
            container.style.transform = "scale(1)";
          }, 130);
        } else {
          container.style.transform = "scale(0.95)";
          this.scheduleTimeout(() => {
            container.style.transform = "scale(1.035)";
            this.scheduleTimeout(() => {
              const rect = container.getBoundingClientRect();
              const isPointerInside =
                event.clientX >= rect.left &&
                event.clientX <= rect.right &&
                event.clientY >= rect.top &&
                event.clientY <= rect.bottom;
              if (!isPointerInside) {
                container.style.transform = "scale(1)";
              }
            }, 130);
          }, 130);
        }
        onClick();
      }
    });

    cardContentsLayer.appendChild(container);
    return textElement;
  }

  private createOverlayStickersImage(
    type: string,
    name: string,
  ): HTMLImageElement {
    const url = `https://cdn.lil.org/mons/id_cards/stickers_overlays/${type}/${name}.webp`;
    const overlayImg = document.createElement("img");
    overlayImg.crossOrigin = "anonymous";
    overlayImg.style.width = "100%";
    overlayImg.style.height = "100%";
    overlayImg.style.transition = "transform 0.13s ease-out";
    overlayImg.style.objectFit = "contain";
    overlayImg.style.position = "absolute";
    overlayImg.style.top = "0";
    overlayImg.style.zIndex = "10";
    overlayImg.style.left = "0";
    overlayImg.style.right = "0";
    overlayImg.style.bottom = "0";
    overlayImg.style.margin = "auto";
    overlayImg.style.userSelect = "none";
    overlayImg.style.pointerEvents = "none";
    overlayImg.draggable = false;
    overlayImg.src = url;
    overlayImg.style.visibility = "hidden";
    this.setImageCallbacks(
      overlayImg,
      () => {
        overlayImg.style.visibility =
          this.ownBgImg?.style.visibility ?? "hidden";
      },
      () => {
        overlayImg.style.visibility = "hidden";
      },
    );
    return overlayImg;
  }

  private async showMons(
    cardContentsLayer: HTMLElement,
    isOtherPlayer: boolean,
    profile: PlayerProfile | null,
  ) {
    const getSpriteByKey = (await import(`../assets/monsSprites`))
      .getSpriteByKey;
    if (
      !this.isLive() ||
      !cardContentsLayer.isConnected ||
      this.ownCardContentsLayer !== cardContentsLayer
    ) {
      return;
    }
    const monsIndexes = getMonsIndexes(isOtherPlayer, profile);
    if (!this.isLive()) return;
    this.displayedMonsIndexes = monsIndexes;
    for (const monType of Object.values(MonType)) {
      const { index, left } = CARD_MONS[monType];
      this.addImageToCard(
        cardContentsLayer,
        left,
        "74.37%",
        getSpriteByKey(getMonId(monType, this.displayedMonsIndexes[index])),
        1,
        monType,
        isOtherPlayer,
      );
    }
  }

  private didClickMonImage(monType: MonType) {
    const { index, regularCount } = CARD_MONS[monType];
    const currentIndex = this.displayedMonsIndexes[index];
    void this.updateContent(
      monType,
      getNextRegularId(currentIndex, regularCount),
      currentIndex,
    );
    this.options.onMonsChanged();
  }

  updateDisplayName(displayName: string): void {
    if (this.isLive() && !this.isOtherPlayer && this.nameElement) {
      this.nameElement.textContent = displayName;
    }
  }

  updateUndoButton(): void {
    if (this.isLive() && this.panelUndoButton) {
      this.panelUndoButton.disabled = this.options.getUndoSize() === 0;
    }
  }

  applyPresentationChange(contentType: string, newId: any): void {
    if (!this.isLive() || this.isOtherPlayer) return;
    switch (contentType) {
      case "profileCounter": {
        const gpValue = storage.getPlayerNonce(-1) + 1;
        const mpValue = storage.getPlayerTotalManaPoints(0);
        if (this.ownCounterElement) {
          this.ownCounterElement.textContent =
            newId === "mp" ? `mp: ${mpValue}` : `gp: ${gpValue}`;
        }
        break;
      }
      case "emojiAndAura": {
        const url = `https://cdn.lil.org/mons/emojipack/regular/${newId?.emojiId}.webp`;
        if (this.ownEmojiImg) this.ownEmojiImg.src = url;
        if (this.ownEmojiAuraInner)
          setRainbowAuraMask(this.ownEmojiAuraInner, url);
        if (this.ownEmojiAuraBackground) {
          if (newId?.aura === "rainbow")
            showRainbowAura(this.ownEmojiAuraBackground);
          else hideRainbowAura(this.ownEmojiAuraBackground);
        }
        break;
      }
      case "bg": {
        this.cardIndex = newId;
        if (this.ownBgImg) {
          this.ownBgImg.style.visibility = "hidden";
          this.ownBgImg.src = `https://cdn.lil.org/mons/id_cards/backgrounds/${newId}.webp`;
        }
        break;
      }
      case "subtitle": {
        this.asciimojiIndex = newId;
        if (this.ownSubtitleElement)
          this.ownSubtitleElement.textContent = getAsciimojiAtIndex(newId);
        break;
      }
      case MonType.DEMON:
      case MonType.ANGEL:
      case MonType.DRAINER:
      case MonType.SPIRIT:
      case MonType.MYSTIC: {
        const monsIndexes = getMonsIndexes(false, null);
        if (!this.isLive()) return;
        this.displayedMonsIndexes = monsIndexes;
        const revision = (this.monRevisions[contentType] ?? 0) + 1;
        this.monRevisions[contentType] = revision;
        const image = this.ownMonImages[contentType];
        if (image)
          void this.updateMonImage(contentType, newId, image, revision).catch(
            () => {},
          );
        break;
      }
      default: {
        if (!(contentType in STICKER_ADD_PROMPTS_FRAMES)) return;
        this.currentlySelectedStickers = parseStickerMap(
          storage.getCardStickers(""),
        );
        this.didUpdateSticker(contentType, newId);
      }
    }
  }

  private async updateMonImage(
    type: MonType,
    id: number,
    image: HTMLImageElement,
    revision: number,
  ): Promise<void> {
    const { getSpriteByKey } = await import("../assets/monsSprites");
    if (
      !this.isLive() ||
      this.ownMonImages[type] !== image ||
      !image.isConnected ||
      this.monRevisions[type] !== revision
    )
      return;
    image.src = `data:image/webp;base64,${getSpriteByKey(getMonId(type, id))}`;
  }
}
