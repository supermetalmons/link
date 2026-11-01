export type EmojiId = number;
export type Aura = "none" | "rainbow";
export type ProfileCounter = "gp" | "mp";

export const PROFILE_FALLBACK_EMOJI_COUNT = 155;
export const INVENTORY_EMOJI_START = 1000;
export const INVENTORY_EMOJI_END = 1466;
export const CARD_BACKGROUND_IDS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 100,
] as const;
export const CARD_SUBTITLE_IDS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 27, 28, 29,
] as const;
export type CardBackgroundId = (typeof CARD_BACKGROUND_IDS)[number];
export type CardSubtitleId = (typeof CARD_SUBTITLE_IDS)[number];

export const MON_SELECTION_CATALOG = {
  demon: ["borgalo", "notchur"],
  angel: ["applecreme", "gerp", "goxfold", "mowch", "mummyfly"],
  drainer: [
    "deino",
    "greenseech",
    "omom",
    "supermetaldrop",
    "zwubbi",
    "royal_aguapwoshi",
  ],
  spirit: ["melmut", "omenstatue", "owg"],
  mystic: ["chamgot", "dart", "estalibur"],
} as const;

export type SelectedMons = {
  demon: 0 | 1;
  angel: 0 | 1 | 2 | 3 | 4;
  drainer: 0 | 1 | 2 | 3 | 4 | 5;
  spirit: 0 | 1 | 2;
  mystic: 0 | 1 | 2;
};
export type MonSelectionKind = keyof SelectedMons;

export const PROFILE_STICKER_CATALOG = {
  "big-mon-top-right": [
    "applecreme",
    "armored-gummoskullj",
    "crystal-cloud-gabber",
    "crystal-gummy-deino",
    "gate",
    "crystal-owg",
    "estalibur",
    "gerp",
    "gummy-deino",
    "hatchat",
    "king-snowbie",
    "lord-idgecreist",
    "melmut",
    "omen-statue",
    "omom-2",
    "omom-3",
    "omom-4",
    "omom",
    "speklmic",
    "super-mana-piece-3",
    "zemred",
  ],
  "bottom-left": ["heart", "rock"],
  "bottom-right": ["cursor", "star"],
  mana: ["blue-mana", "metal-mana"],
  "middle-left": ["super-mana-piece-2", "super-mana-piece"],
  "middle-right": ["glitter-rock", "metal-mana-pog", "swag-coin"],
  "mini-logo": ["bomb", "mana", "potion", "super-mana"],
  "type-logo": ["angel", "demon", "drainer", "mystic", "spirit"],
} as const;

export type StickerSlot = keyof typeof PROFILE_STICKER_CATALOG;
export type StickerName<Slot extends StickerSlot = StickerSlot> =
  (typeof PROFILE_STICKER_CATALOG)[Slot][number];
export type StickerMap = {
  [Slot in StickerSlot]?: StickerName<Slot>;
};

export type ProfileAppearance = {
  emoji: EmojiId;
  aura: Aura;
  cardBackgroundId: CardBackgroundId;
  cardSubtitleId: CardSubtitleId;
  profileCounter: ProfileCounter;
  profileMons: SelectedMons | null;
  cardStickers: StickerMap;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isEmojiId = (value: unknown): value is EmojiId =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  ((value >= 0 && value <= PROFILE_FALLBACK_EMOJI_COUNT) ||
    (value >= INVENTORY_EMOJI_START && value <= INVENTORY_EMOJI_END));

export const isAura = (value: unknown): value is Aura =>
  value === "none" || value === "rainbow";

export const isEmojiAppearance = (
  value: unknown,
): value is Pick<ProfileAppearance, "emoji" | "aura"> =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  isEmojiId(value.emoji) &&
  isAura(value.aura);

export const isProfileCounter = (value: unknown): value is ProfileCounter =>
  value === "gp" || value === "mp";

export const isCardBackgroundId = (value: unknown): value is CardBackgroundId =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  ((value >= 0 && value < 37) || value === 100);

export const isCardSubtitleId = (value: unknown): value is CardSubtitleId =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value < 30;

export function isMonSelectionIndex<Kind extends MonSelectionKind>(
  kind: Kind,
  value: unknown,
): value is SelectedMons[Kind] {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < MON_SELECTION_CATALOG[kind].length
  );
}

export const isSelectedMons = (value: unknown): value is SelectedMons =>
  isRecord(value) &&
  Object.keys(value).length === 5 &&
  isMonSelectionIndex("demon", value.demon) &&
  isMonSelectionIndex("angel", value.angel) &&
  isMonSelectionIndex("drainer", value.drainer) &&
  isMonSelectionIndex("spirit", value.spirit) &&
  isMonSelectionIndex("mystic", value.mystic);

export const isStickerSlot = (value: unknown): value is StickerSlot =>
  typeof value === "string" && Object.hasOwn(PROFILE_STICKER_CATALOG, value);

export function isStickerName<Slot extends StickerSlot>(
  slot: Slot,
  value: unknown,
): value is StickerName<Slot> {
  const names: readonly string[] = PROFILE_STICKER_CATALOG[slot];
  return typeof value === "string" && names.includes(value);
}

export const isStickerMap = (value: unknown): value is StickerMap =>
  isRecord(value) &&
  Object.entries(value).every(
    ([slot, name]) => isStickerSlot(slot) && isStickerName(slot, name),
  );

export function withStickerSelection<Slot extends StickerSlot>(
  current: StickerMap,
  slot: Slot,
  name: StickerMap[Slot],
): StickerMap {
  if (name !== undefined && !isStickerName(slot, name))
    throw new Error("invalid-sticker-selection");
  const next: StickerMap = { ...current };
  if (name === undefined) delete next[slot];
  else next[slot] = name;
  return next;
}

export function withMonSelection<Kind extends MonSelectionKind>(
  current: SelectedMons,
  kind: Kind,
  index: SelectedMons[Kind],
): SelectedMons {
  if (!isMonSelectionIndex(kind, index))
    throw new Error("invalid-mon-selection");
  return { ...current, [kind]: index };
}

export function createDefaultProfileAppearance(
  emoji: EmojiId = 1,
): ProfileAppearance {
  if (!isEmojiId(emoji)) throw new Error("invalid-profile-emoji");
  return {
    emoji,
    aura: "none",
    cardBackgroundId: 30,
    cardSubtitleId: 0,
    profileCounter: "gp",
    profileMons: null,
    cardStickers: {},
  };
}

export function getProfileFallbackEmojiId(profileId: string): EmojiId {
  let hash = 0;
  for (let index = 0; index < profileId.length; index++) {
    hash += profileId.charCodeAt(index);
  }
  return (hash % PROFILE_FALLBACK_EMOJI_COUNT) + 1;
}
