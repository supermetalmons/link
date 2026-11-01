import { requireValue } from "./browserAssertions.ts";
import {
  createDefaultProfileAppearance,
  type StickerSlot,
} from "@mons/shared/appearance";
import "../../src/ui/ShinyCard";
import "../../src/index.css";
import * as cardUi from "../../src/ui/shinyCardUiPort";
import { bindShinyCardRuntime } from "../../src/ui/shinyCardRuntimePort";
import {
  STICKER_ADD_PROMPTS_FRAMES,
  STICKER_PATHS,
} from "../../src/utils/stickers";
import { getAsciimojiAtIndex } from "../../src/utils/asciimoji";
import {
  environment,
  initialValues,
  spriteForKey,
  storage,
  type FixtureValues,
} from "./shinyCardEnvironment";

const recordWrite = (write: unknown[]) => {
  environment.writes.push(write);
  environment.onWrite?.(write);
};

bindShinyCardRuntime({
  updateProfileCounter: (value) => recordWrite(["counter", value]),
  updateCardBackgroundId: (value) => recordWrite(["background", value]),
  updateCardSubtitleId: (value) => recordWrite(["subtitle", value]),
  updateProfileMons: (value) => recordWrite(["mons", value]),
  updateCardStickers: (value) => recordWrite(["stickers", value]),
  didClickAndChangePlayerEmoji: (value, url, aura) => {
    storage.setPlayerEmojiId(value);
    recordWrite(["emoji", value, url, aura]);
  },
  didUpdateIdCardMons: async () => {
    recordWrite(["monsChanged"]);
  },
});

const card = () =>
  document.querySelector<HTMLElement>('[data-shiny-card="true"]');
const background = () =>
  card()?.querySelector<HTMLImageElement>('img[src*="/backgrounds/"]');
const textBubble = (top: string) =>
  Array.from(card()?.querySelectorAll<HTMLElement>("div") ?? []).find(
    (element) => element.style.top === top && element.querySelector("span"),
  );
const stickerTarget = (type: StickerSlot) => {
  const selected = environment.values.CardStickers;
  const sticker = STICKER_PATHS[type].find(
    ({ name }) => name === selected[type],
  );
  const prompt = STICKER_ADD_PROMPTS_FRAMES[type];
  const left = sticker ? sticker.x * 100 : (prompt.x - prompt.w / 2) * 100;
  const top = sticker
    ? sticker.y * 100
    : (prompt.y - (prompt.w * (2430 / 1886)) / 2) * 100;
  return Array.from(card()?.querySelectorAll<HTMLElement>("div") ?? []).find(
    ({ style }) =>
      style.pointerEvents === "auto" &&
      Math.abs(Number.parseFloat(style.left) - left) < 0.0001 &&
      Math.abs(Number.parseFloat(style.top) - top) < 0.0001,
  );
};
let resetCount = 0;
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("Missing fixture click target");
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
};
let retiredCard: HTMLElement | null = null;
let retiredMutations = 0;
let retiredObserver: MutationObserver | null = null;

export const harness = {
  environment,
  spriteForKey,
  storeEmoji: storage.setPlayerEmojiId,
  subtitleForId: getAsciimojiAtIndex,
  stickerNames: Object.fromEntries(
    Object.entries(STICKER_PATHS).map(([type, stickers]) => [
      type,
      stickers.map(({ name }) => name),
    ]),
  ),
  reset(values: Partial<FixtureValues> = {}) {
    cardUi.hideShinyCard();
    environment.values = {
      ...initialValues,
      ProfileId: `fixture-${++resetCount}`,
      ...values,
    };
    environment.writes = [];
    environment.onWrite = null;
  },
  show: cardUi.showShinyCard,
  own: () => cardUi.showShinyCard(null, "Owner A", false),
  other: (id = "other-b") =>
    cardUi.showShinyCard(
      {
        ...createDefaultProfileAppearance(2),
        id,
        username: null,
        eth: null,
        sol: null,
        cardBackgroundId: 7,
        cardSubtitleId: 1,
        profileMons: { demon: 1, angel: 1, drainer: 1, spirit: 1, mystic: 1 },
        cardStickers: {},
        rating: 1600,
        nonce: 5,
        totalManaPoints: 12,
      },
      id,
      true,
    ),
  hide: cardUi.hideShinyCard,
  inventoryEmoji: cardUi.setOwnershipVerifiedIdCardEmoji,
  inventorySpecial: cardUi.setOwnershipVerifiedSpecialItem,
  selection() {
    const { avatarId, specialIds } = cardUi.getActiveInventoryItemSelection();
    return { avatarId, specialIds: [...specialIds].sort() };
  },
  edit: () => click(background()),
  clickBackground: () => click(background()),
  clickEmoji: () =>
    click(card()?.querySelector('img[src*="/emojipack/regular/"]')),
  clickCounter: () => click(textBubble("58.7%")),
  clickSubtitle: () => click(textBubble("47.5%")),
  clickSticker: (type: StickerSlot) => click(stickerTarget(type)),
  clickMon(index = 0) {
    click(card()?.querySelectorAll('img[src^="data:image/"]')[index]);
  },
  undo: () => click(document.querySelector(".shiny-card-undo-button")),
  done: () => click(document.querySelector(".shiny-card-done-button")),
  snapshot() {
    return {
      count: document.querySelectorAll('[data-shiny-card="true"]').length,
      visible: cardUi.showsShinyCardSomewhere,
      text: card()?.textContent ?? null,
      counter: textBubble("58.7%")?.textContent ?? null,
      subtitle: textBubble("47.5%")?.textContent ?? null,
      stickers: Object.fromEntries(
        Array.from(
          card()?.querySelectorAll<HTMLImageElement>(
            'img[src*="/stickers_overlays/"]',
          ) ?? [],
        ).map((image) => {
          const [type, name] = requireValue(
            image.src.split("/stickers_overlays/")[1],
          ).split("/");
          return [
            requireValue(type),
            requireValue(name).replace(/\.webp$/, ""),
          ] as const;
        }),
      ),
      aura:
        card()?.querySelector<HTMLElement>(".mons-rainbow-rotator")
          ?.parentElement?.parentElement?.parentElement?.style.visibility ??
        null,
      background: background()?.getAttribute("src") ?? null,
      emoji:
        card()
          ?.querySelector('img[src*="/emojipack/regular/"]')
          ?.getAttribute("src") ?? null,
      mons: Array.from(
        card()?.querySelectorAll('img[src^="data:image/"]') ?? [],
      ).map((image) => image.getAttribute("src")),
      editing: !!document.querySelector(".shiny-card-editing-panel"),
      undoDisabled:
        document.querySelector<HTMLButtonElement>(".shiny-card-undo-button")
          ?.disabled ?? null,
      bounds: card()
        ? {
            width: card()!.getBoundingClientRect().width,
            height: card()!.getBoundingClientRect().height,
          }
        : null,
    };
  },
  retire() {
    retiredObserver?.disconnect();
    retiredCard = card();
    cardUi.hideShinyCard();
    retiredMutations = 0;
    retiredObserver = new MutationObserver((records) => {
      retiredMutations += records.length;
    });
    if (retiredCard)
      retiredObserver.observe(retiredCard, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
  },
  dispatchRetiredEvents() {
    retiredCard?.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 40, clientY: 40 }),
    );
    retiredCard
      ?.querySelectorAll("img")
      .forEach((image) => image.dispatchEvent(new Event("load")));
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );
  },
  retiredMutations: () => retiredMutations,
};

declare global {
  interface Window {
    shinyCardHarness: typeof harness;
  }
}
window.shinyCardHarness = harness;
