// Generated from src/shared/appearance.ts. Run npm run generate:runtime.
export type EmojiId = number;
export type Aura = "none" | "rainbow";
export type ProfileCounter = "gp" | "mp";
export declare const PROFILE_FALLBACK_EMOJI_COUNT = 155;
export declare const INVENTORY_EMOJI_START = 1000;
export declare const INVENTORY_EMOJI_END = 1466;
export declare const CARD_BACKGROUND_IDS: readonly [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  100,
];
export declare const CARD_SUBTITLE_IDS: readonly [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
];
export type CardBackgroundId = (typeof CARD_BACKGROUND_IDS)[number];
export type CardSubtitleId = (typeof CARD_SUBTITLE_IDS)[number];
export declare const MON_SELECTION_CATALOG: {
  readonly demon: readonly ["borgalo", "notchur"];
  readonly angel: readonly [
    "applecreme",
    "gerp",
    "goxfold",
    "mowch",
    "mummyfly",
  ];
  readonly drainer: readonly [
    "deino",
    "greenseech",
    "omom",
    "supermetaldrop",
    "zwubbi",
    "royal_aguapwoshi",
  ];
  readonly spirit: readonly ["melmut", "omenstatue", "owg"];
  readonly mystic: readonly ["chamgot", "dart", "estalibur"];
};
export type SelectedMons = {
  demon: 0 | 1;
  angel: 0 | 1 | 2 | 3 | 4;
  drainer: 0 | 1 | 2 | 3 | 4 | 5;
  spirit: 0 | 1 | 2;
  mystic: 0 | 1 | 2;
};
export type MonSelectionKind = keyof SelectedMons;
export declare const PROFILE_STICKER_CATALOG: {
  readonly "big-mon-top-right": readonly [
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
  ];
  readonly "bottom-left": readonly ["heart", "rock"];
  readonly "bottom-right": readonly ["cursor", "star"];
  readonly mana: readonly ["blue-mana", "metal-mana"];
  readonly "middle-left": readonly ["super-mana-piece-2", "super-mana-piece"];
  readonly "middle-right": readonly [
    "glitter-rock",
    "metal-mana-pog",
    "swag-coin",
  ];
  readonly "mini-logo": readonly ["bomb", "mana", "potion", "super-mana"];
  readonly "type-logo": readonly [
    "angel",
    "demon",
    "drainer",
    "mystic",
    "spirit",
  ];
};
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
export declare const isEmojiId: (value: unknown) => value is EmojiId;
export declare const isAura: (value: unknown) => value is Aura;
export declare const isEmojiAppearance: (
  value: unknown,
) => value is Pick<ProfileAppearance, "emoji" | "aura">;
export declare const isProfileCounter: (
  value: unknown,
) => value is ProfileCounter;
export declare const isCardBackgroundId: (
  value: unknown,
) => value is CardBackgroundId;
export declare const isCardSubtitleId: (
  value: unknown,
) => value is CardSubtitleId;
export declare function isMonSelectionIndex<Kind extends MonSelectionKind>(
  kind: Kind,
  value: unknown,
): value is SelectedMons[Kind];
export declare const isSelectedMons: (value: unknown) => value is SelectedMons;
export declare const isStickerSlot: (value: unknown) => value is StickerSlot;
export declare function isStickerName<Slot extends StickerSlot>(
  slot: Slot,
  value: unknown,
): value is StickerName<Slot>;
export declare const isStickerMap: (value: unknown) => value is StickerMap;
export declare function withStickerSelection<Slot extends StickerSlot>(
  current: StickerMap,
  slot: Slot,
  name: StickerMap[Slot],
): StickerMap;
export declare function withMonSelection<Kind extends MonSelectionKind>(
  current: SelectedMons,
  kind: Kind,
  index: SelectedMons[Kind],
): SelectedMons;
export declare function createDefaultProfileAppearance(
  emoji?: EmojiId,
): ProfileAppearance;
export declare function getProfileFallbackEmojiId(profileId: string): EmojiId;
