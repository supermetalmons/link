import "../../src/ui/ShinyCard";
import "../../src/index.css";
import * as cardUi from "../../src/ui/shinyCardUiPort";
import { bindShinyCardRuntime } from "../../src/ui/shinyCardRuntimePort";
import { environment, spriteForKey } from "./shinyCardEnvironment";

bindShinyCardRuntime({
  updateProfileCounter: (value) => environment.writes.push(["counter", value]),
  updateCardBackgroundId: (value) =>
    environment.writes.push(["background", value]),
  updateCardSubtitleId: (value) => environment.writes.push(["subtitle", value]),
  updateProfileMons: (value) => environment.writes.push(["mons", value]),
  updateCardStickers: (value) => environment.writes.push(["stickers", value]),
  didClickAndChangePlayerEmoji: (value, url, aura) => {
    environment.values.PlayerEmojiId = String(value);
    environment.writes.push(["emoji", value, url, aura]);
  },
  didUpdateIdCardMons: async () => {
    environment.writes.push(["monsChanged"]);
  },
});

const card = () =>
  document.querySelector<HTMLElement>('[data-shiny-card="true"]');
const background = () =>
  card()?.querySelector<HTMLImageElement>('img[src*="/backgrounds/"]');
const click = (element: Element | null | undefined) => {
  if (!element) throw new Error("Missing fixture click target");
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
};
let retiredCard: HTMLElement | null = null;
let retiredMutations = 0;
let retiredObserver: MutationObserver | null = null;

(window as any).harness = {
  environment,
  spriteForKey,
  show: cardUi.showShinyCard,
  own: () => cardUi.showShinyCard(null, "Owner A", false),
  other: (id = "other-b") =>
    cardUi.showShinyCard(
      {
        id,
        emoji: "2",
        cardBackgroundId: 7,
        cardSubtitleId: 1,
        profileMons: "1,1,1,1,1",
        cardStickers: "",
        rating: 1600,
        nonce: 5,
        totalManaPoints: 12,
      } as any,
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
