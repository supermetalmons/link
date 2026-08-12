import type { MaterialName } from "../services/rocksMiningService";

const MATERIAL_BASE_URL = "https://cdn.lil.org/mons/rocks/materials";
export const MAX_WAGER_PILE_ITEMS = 13;
export const MAX_WAGER_WIN_PILE_ITEMS = 32;
export const WAGER_WIN_PILE_SCALE = 1.3333;
const WAGER_ICON_SIZE_MULTIPLIER = 0.56;
const WAGER_ICON_PADDING_FRAC = 0.15;
const WAGER_STACK_BOTTOM_V = 0.86;
const WAGER_STACK_TOP_V = 0.14;
const WAGER_STACK_MAX_STEP_V = 0.16;
const WAGER_STACK_U_JITTER = 0.008;

export type WagerPoint = { x: number; y: number };
export type WagerPosition = { u: number; v: number };
export type WagerPile = {
  positions: WagerPosition[];
  frames: WagerPoint[];
  material: MaterialName | null;
  materialUrl: string | null;
  count: number;
  actualCount: number;
  rect: WagerPileRect | null;
  iconSize: number;
};

export type WagerPileSide = "player" | "opponent";
export type WagerPileRect = { x: number; y: number; w: number; h: number };
export type WagerSlotLayout = {
  pile: WagerPileRect;
  winner: WagerPileRect;
};
export type WagerSlotLayoutMap = Partial<
  Record<WagerPileSide, WagerSlotLayout>
>;
export type WagerPileAnimation = "none" | "appear" | "disappear";
export type WagerPileRenderState = {
  side: WagerPileSide | "winner";
  rect: WagerPileRect;
  iconSize: number;
  materialUrl: string;
  frames: WagerPoint[];
  count: number;
  actualCount: number;
  animation: WagerPileAnimation;
  isPending: boolean;
};
export type WagerRenderState = {
  player: WagerPileRenderState | null;
  opponent: WagerPileRenderState | null;
  winner: WagerPileRenderState | null;
  winAnimationActive: boolean;
  playerDisappearing: WagerPileRenderState | null;
  opponentDisappearing: WagerPileRenderState | null;
};

export type WagerIconLayout = {
  iconSize: number;
  padding: number;
  maxX: number;
  maxY: number;
};

export const getWagerMaterialUrl = (name: MaterialName): string =>
  `${MATERIAL_BASE_URL}/${name}.webp`;

export const createWagerPile = (): WagerPile => ({
  positions: [],
  frames: [],
  material: null,
  materialUrl: null,
  count: 0,
  actualCount: 0,
  rect: null,
  iconSize: 0,
});

export const computeWagerStackHeights = (
  count: number,
  stackCount: number,
): number[] => {
  const safeStacks = Math.max(1, stackCount);
  const base = Math.floor(count / safeStacks);
  const extra = count % safeStacks;
  const heights = Array.from({ length: safeStacks }, () => base);
  const order = getWagerStackTallOrder(safeStacks);
  for (let i = 0; i < extra; i += 1) {
    heights[order[i]] += 1;
  }
  return heights;
};

export const getWagerStackTallOrder = (stackCount: number): number[] => {
  if (stackCount <= 1) return [0];
  if (stackCount === 2) return [0, 1];
  if (stackCount === 3) return [1, 0, 2];
  if (stackCount === 4) return [1, 2, 0, 3];
  return Array.from({ length: stackCount }, (_, index) => index);
};

export const computeWagerStackCenterUs = (stackCount: number): number[] => {
  if (stackCount <= 1) return [0.5];
  if (stackCount === 2) return [0.27, 0.73];
  if (stackCount === 3) return [0.16, 0.5, 0.84];
  if (stackCount === 4) return [0.12, 0.38, 0.62, 0.88];
  return Array.from(
    { length: stackCount },
    (_, index) => (index + 0.5) / stackCount,
  );
};

export const getWagerStackColumnCount = (count: number): number => {
  if (count <= 3) return 1;
  if (count <= 8) return 2;
  if (count <= 18) return 3;
  return 4;
};

export const generateWagerPositions = (count: number): WagerPosition[] => {
  if (count <= 0) return [];
  const stackCount = getWagerStackColumnCount(count);
  const stackHeights = computeWagerStackHeights(count, stackCount);
  const tallestStack = Math.max(1, ...stackHeights);
  const stackUs = computeWagerStackCenterUs(stackCount);
  const availableV = WAGER_STACK_BOTTOM_V - WAGER_STACK_TOP_V;
  const stepV =
    tallestStack > 1
      ? Math.min(WAGER_STACK_MAX_STEP_V, availableV / (tallestStack - 1))
      : 0;
  const clampStackCoord = (value: number) =>
    Math.max(WAGER_STACK_TOP_V, Math.min(WAGER_STACK_BOTTOM_V, value));
  const positions: WagerPosition[] = [];
  for (let stackIndex = 0; stackIndex < stackCount; stackIndex += 1) {
    const baseU = stackUs[stackIndex];
    const height = stackHeights[stackIndex];
    for (let index = 0; index < height; index += 1) {
      const jitter = (index % 2 === 0 ? -1 : 1) * WAGER_STACK_U_JITTER;
      positions.push({
        u: clampStackCoord(baseU + jitter),
        v: clampStackCoord(WAGER_STACK_BOTTOM_V - index * stepV),
      });
    }
  }
  return positions;
};

export const syncWagerPileIcons = (
  pile: WagerPile,
  material: MaterialName,
  count: number,
  materialUrl?: string | null,
  maxItems = MAX_WAGER_PILE_ITEMS,
): void => {
  const visibleCount = Math.max(0, Math.min(maxItems, count));
  const nextUrl = materialUrl || getWagerMaterialUrl(material);
  const reusePositions =
    pile.material === material &&
    pile.count === visibleCount &&
    pile.positions.length === visibleCount;
  pile.material = material;
  pile.materialUrl = nextUrl;
  pile.count = visibleCount;
  pile.actualCount = count;
  if (!reusePositions) {
    pile.positions =
      visibleCount <= 0 ? [] : generateWagerPositions(visibleCount);
  }
  pile.frames = [];
};

export const wagerRectsEqual = (
  a?: WagerPileRect,
  b?: WagerPileRect,
): boolean =>
  a === b ||
  (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export const wagerRectIsVisible = (
  rect: WagerPileRect | null | undefined,
): rect is WagerPileRect => !!rect && rect.w > 0 && rect.h > 0;

export const wagerPileHiddenByLayout = (pile: WagerPile | null): boolean =>
  !!pile && pile.count > 0 && !!pile.rect && !wagerRectIsVisible(pile.rect);

export const wagerSlotLayoutEqual = (
  a?: WagerSlotLayout,
  b?: WagerSlotLayout,
): boolean =>
  wagerRectsEqual(a?.pile, b?.pile) && wagerRectsEqual(a?.winner, b?.winner);

export const wagerSlotLayoutsEqual = (
  a: WagerSlotLayoutMap | null,
  b: WagerSlotLayoutMap | null,
): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    wagerSlotLayoutEqual(a.player, b.player) &&
    wagerSlotLayoutEqual(a.opponent, b.opponent));

export const getWagerIconLayout = (
  rect: WagerPileRect,
  avatarSize: number,
  iconSizeOverride?: number,
): WagerIconLayout => {
  const visibleScale = Math.max(0.1, 1 - WAGER_ICON_PADDING_FRAC * 2);
  const rawIconSize = avatarSize * WAGER_ICON_SIZE_MULTIPLIER;
  const maxIconSize = Math.min(rect.w, rect.h) / visibleScale;
  const iconSize = Math.min(iconSizeOverride ?? rawIconSize, maxIconSize);
  const padding = iconSize * WAGER_ICON_PADDING_FRAC;
  const visibleSize = iconSize * visibleScale;
  return {
    iconSize,
    padding,
    maxX: Math.max(0, rect.w - visibleSize),
    maxY: Math.max(0, rect.h - visibleSize),
  };
};

export const getWagerIconFrame = (
  rect: WagerPileRect,
  layout: WagerIconLayout,
  position: WagerPosition,
): WagerPoint => ({
  x: rect.x - layout.padding + position.u * layout.maxX,
  y: rect.y - layout.padding + position.v * layout.maxY,
});

export const updateWagerPileLayout = (
  pile: WagerPile,
  rect: WagerPileRect,
  avatarSize: number,
): void => {
  const layout = getWagerIconLayout(rect, avatarSize);
  pile.rect = rect;
  pile.iconSize = layout.iconSize;
  pile.frames = pile.positions
    .slice(0, pile.count)
    .map((position) =>
      getWagerIconFrame(rect, layout, position ?? { u: 0.5, v: 0.5 }),
    );
  while (pile.frames.length < pile.count) {
    pile.frames.push(getWagerIconFrame(rect, layout, { u: 0.5, v: 0.5 }));
  }
};

export const buildWagerRenderState = (
  pile: WagerPile | null,
  side: WagerPileSide | "winner",
  animation: WagerPileAnimation,
  isPending: boolean,
): WagerPileRenderState | null => {
  if (!pile || pile.count === 0 || !wagerRectIsVisible(pile.rect)) {
    return null;
  }
  const materialUrl =
    pile.materialUrl ||
    (pile.material ? getWagerMaterialUrl(pile.material) : "");
  if (!materialUrl) {
    return null;
  }
  return {
    side,
    rect: { ...pile.rect },
    iconSize: pile.iconSize,
    materialUrl,
    frames: pile.frames.map((frame) => ({ ...frame })),
    count: pile.count,
    actualCount: pile.actualCount,
    animation,
    isPending,
  };
};

export const buildWagerFrames = (
  rect: WagerPileRect,
  layout: WagerIconLayout,
  positions: WagerPosition[],
  count: number,
): WagerPoint[] => {
  const frames = positions
    .slice(0, count)
    .map((position) => getWagerIconFrame(rect, layout, position));
  while (frames.length < count) {
    frames.push(
      getWagerIconFrame(rect, layout, {
        u: Math.random(),
        v: Math.random(),
      }),
    );
  }
  return frames;
};

export const clampWagerUnit = (value: number): number =>
  Math.max(0, Math.min(1, value));

export const remapWagerFrame = (
  frame: WagerPoint,
  previousRect: WagerPileRect,
  nextRect: WagerPileRect,
  previousIconSize: number,
  nextIconSize: number,
  avatarSize: number,
): WagerPoint => {
  const previousLayout = getWagerIconLayout(
    previousRect,
    avatarSize,
    previousIconSize,
  );
  const nextLayout = getWagerIconLayout(nextRect, avatarSize, nextIconSize);
  const u =
    previousLayout.maxX > 0
      ? clampWagerUnit(
          (frame.x - previousRect.x + previousLayout.padding) /
            previousLayout.maxX,
        )
      : 0.5;
  const v =
    previousLayout.maxY > 0
      ? clampWagerUnit(
          (frame.y - previousRect.y + previousLayout.padding) /
            previousLayout.maxY,
        )
      : 0.5;
  return getWagerIconFrame(nextRect, nextLayout, { u, v });
};
