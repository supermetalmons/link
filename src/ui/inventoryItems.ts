import type { EventPrizeAssignment } from "../connection/connectionModels";

export const SWAGPACK_ID_OFFSET = 1000;
export const SWAGPACK_INVENTORY_IMAGE_BASE_URL =
  "https://cdn.lil.org/mons/emojipack/swagpack/420";

export interface SwagAvatarItem {
  id: number;
  count: number;
}

export type InventoryApplicableItem =
  | { kind: "avatar"; item: SwagAvatarItem }
  | { kind: "special"; item: SwagAvatarItem };

export type InventoryPreviewItem =
  InventoryApplicableItem | { kind: "eventPrize"; prize: EventPrizeAssignment };
