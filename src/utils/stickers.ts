import {
  isStickerSlot,
  type StickerSlot,
  type StickerName,
} from "@mons/shared/appearance";
interface Sticker<Slot extends StickerSlot> {
  name: StickerName<Slot>;
  x: number;
  y: number;
  w: number;
  h: number;
}

const stickerPaths = {
  "big-mon-top-right": [
    { name: "applecreme", x: 0.653497, y: 0.250265, w: 0.258024, h: 0.290031 },
    {
      name: "armored-gummoskullj",
      x: 0.678189,
      y: 0.19141,
      w: 0.224691,
      h: 0.341463,
    },
    {
      name: "crystal-cloud-gabber",
      x: 0.681069,
      y: 0.205726,
      w: 0.195884,
      h: 0.33404,
    },
    {
      name: "crystal-gummy-deino",
      x: 0.73786,
      y: 0.209968,
      w: 0.13,
      h: 0.330858,
    },
    { name: "gate", x: 0.73786, y: 0.209968, w: 0.13, h: 0.330858 },
    { name: "crystal-owg", x: 0.672016, y: 0.21633, w: 0.183127, h: 0.304878 },
    { name: "estalibur", x: 0.691358, y: 0.203075, w: 0.217283, h: 0.330858 },
    { name: "gerp", x: 0.71358, y: 0.177094, w: 0.174897, h: 0.362672 },
    { name: "gummy-deino", x: 0.65432, y: 0.172852, w: 0.17037, h: 0.35737 },
    { name: "hatchat", x: 0.690534, y: 0.199363, w: 0.198353, h: 0.337751 },
    { name: "king-snowbie", x: 0.65679, y: 0.180275, w: 0.247736, h: 0.344114 },
    {
      name: "lord-idgecreist",
      x: 0.665432,
      y: 0.139448,
      w: 0.237448,
      h: 0.395546,
    },
    { name: "melmut", x: 0.671604, y: 0.183987, w: 0.202469, h: 0.33563 },
    { name: "omen-statue", x: 0.676954, y: 0.165959, w: 0.247736, h: 0.373806 },
    { name: "omom-2", x: 0.706995, y: 0.241251, w: 0.193827, h: 0.294803 },
    { name: "omom-3", x: 0.687242, y: 0.241781, w: 0.203703, h: 0.305408 },
    { name: "omom-4", x: 0.669958, y: 0.233828, w: 0.221399, h: 0.312831 },
    { name: "omom", x: 0.676954, y: 0.253446, w: 0.197942, h: 0.295864 },
    { name: "speklmic", x: 0.690946, y: 0.175503, w: 0.187654, h: 0.352067 },
    {
      name: "super-mana-piece-3",
      x: 0.723456,
      y: 0.290562,
      w: 0.132098,
      h: 0.183987,
    },
    { name: "zemred", x: 0.663786, y: 0.200954, w: 0.250617, h: 0.325556 },
  ],
  "bottom-left": [
    { name: "heart", x: 0.103292, y: 0.769353, w: 0.081893, h: 0.109225 },
    { name: "rock", x: 0.104526, y: 0.776246, w: 0.082716, h: 0.098621 },
  ],
  "bottom-right": [
    { name: "cursor", x: 0.762551, y: 0.57317, w: 0.076543, h: 0.105514 },
    { name: "star", x: 0.755555, y: 0.563096, w: 0.090534, h: 0.11983 },
  ],
  mana: [
    { name: "blue-mana", x: 0.509876, y: 0.397667, w: 0.062551, h: 0.105514 },
    { name: "metal-mana", x: 0.518106, y: 0.402439, w: 0.058847, h: 0.093849 },
  ],
  "middle-left": [
    {
      name: "super-mana-piece-2",
      x: 0.205349,
      y: 0.630434,
      w: 0.110699,
      h: 0.155355,
    },
    {
      name: "super-mana-piece",
      x: 0.203703,
      y: 0.64316,
      w: 0.109053,
      h: 0.141569,
    },
  ],
  "middle-right": [
    {
      name: "glitter-rock",
      x: 0.615226,
      y: 0.574231,
      w: 0.077366,
      h: 0.086956,
    },
    {
      name: "metal-mana-pog",
      x: 0.633744,
      y: 0.563096,
      w: 0.07037,
      h: 0.092258,
    },
    { name: "swag-coin", x: 0.624279, y: 0.540296, w: 0.092181, h: 0.118769 },
  ],
  "mini-logo": [
    { name: "bomb", x: 0.385185, y: 0.591198, w: 0.054732, h: 0.080063 },
    { name: "mana", x: 0.385185, y: 0.59703, w: 0.043209, h: 0.07211 },
    { name: "potion", x: 0.386008, y: 0.594379, w: 0.049794, h: 0.074231 },
    { name: "super-mana", x: 0.384773, y: 0.600742, w: 0.05144, h: 0.056203 },
  ],
  "type-logo": [
    { name: "angel", x: 0.497942, y: 0.59544, w: 0.074074, h: 0.089077 },
    { name: "demon", x: 0.518106, y: 0.612937, w: 0.063374, h: 0.071049 },
    { name: "drainer", x: 0.51893, y: 0.609225, w: 0.063374, h: 0.0737 },
    { name: "mystic", x: 0.509053, y: 0.591198, w: 0.053909, h: 0.093319 },
    { name: "spirit", x: 0.505761, y: 0.612407, w: 0.057201, h: 0.085896 },
  ],
} satisfies { [Slot in StickerSlot]: Sticker<Slot>[] };

export type StickerType = StickerSlot;

export const STICKER_PATHS = stickerPaths;

export const isStickerType = isStickerSlot;

export const STICKER_ADD_PROMPTS_FRAMES: Record<
  StickerSlot,
  { x: number; y: number; w: number }
> = {
  "big-mon-top-right": { x: 0.8, y: 0.4, w: 0.1 },
  "bottom-left": { x: 0.144, y: 0.813, w: 0.07 },
  "bottom-right": { x: 0.799, y: 0.62, w: 0.07 },
  mana: { x: 0.54, y: 0.455, w: 0.07 },
  "middle-left": { x: 0.265, y: 0.72, w: 0.07 },
  "middle-right": { x: 0.655, y: 0.61, w: 0.07 },
  "mini-logo": { x: 0.41, y: 0.63, w: 0.07 },
  "type-logo": { x: 0.535, y: 0.645, w: 0.07 },
} satisfies Record<StickerType, { x: number; y: number; w: number }>;
