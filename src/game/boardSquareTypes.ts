export type BoardSquareType =
  | "regular"
  | "manaBase"
  | "supermanaBase"
  | "manaPool"
  | "consumableBase"
  | "monBase";

export type BoardSquareTypeGrid = BoardSquareType[][];

export const BOARD_GRID_SIZE = 11;

const LEGACY_BOARD_SQUARE_TYPES: Record<string, BoardSquareType> = {
  "0-0": "manaPool",
  "0-10": "manaPool",
  "5-5": "supermanaBase",
  "10-0": "manaPool",
  "10-10": "manaPool",
  "5-0": "consumableBase",
  "5-10": "consumableBase",
  "3-4": "manaBase",
  "3-6": "manaBase",
  "4-3": "manaBase",
  "4-5": "manaBase",
  "4-7": "manaBase",
  "6-3": "manaBase",
  "6-5": "manaBase",
  "6-7": "manaBase",
  "7-4": "manaBase",
  "7-6": "manaBase",
};

export const createLegacyBoardSquareTypeGrid = (): BoardSquareTypeGrid =>
  Array.from({ length: BOARD_GRID_SIZE }, (_, row) =>
    Array.from({ length: BOARD_GRID_SIZE }, (_, col) =>
      getLegacyBoardSquareType(row, col),
    ),
  );

const getLegacyBoardSquareType = (row: number, col: number): BoardSquareType =>
  LEGACY_BOARD_SQUARE_TYPES[`${row}-${col}`] ?? "regular";

export const getDisplayedBoardSquareType = (
  squareType: BoardSquareType,
  shouldHighlightManaBases: boolean,
): BoardSquareType => {
  if (squareType === "manaBase" && !shouldHighlightManaBases) {
    return "regular";
  }
  return squareType;
};

export const getBoardPatternSquareColorKey = (
  row: number,
  col: number,
  squareTypes?: BoardSquareTypeGrid | null,
  useLightTileManaBaseShade: boolean = false,
) => {
  const isLightTile = (row + col) % 2 === 0;
  const defaultFill = isLightTile ? "lightSquare" : "darkSquare";
  let squareType: BoardSquareType;
  if (squareTypes === undefined) {
    squareType = getLegacyBoardSquareType(row, col);
  } else if (squareTypes === null) {
    squareType = getDisplayedBoardSquareType(
      getLegacyBoardSquareType(row, col),
      false,
    );
  } else {
    squareType = squareTypes[row]?.[col] ?? "regular";
  }

  switch (squareType) {
    case "manaBase":
      return useLightTileManaBaseShade && isLightTile
        ? "simpleManaSquareOnLightTile"
        : "simpleManaSquare";
    case "supermanaBase":
    case "manaPool":
      return "manaPool";
    case "consumableBase":
      return "pickupItemSquare";
    case "monBase":
    case "regular":
    default:
      return defaultFill;
  }
};
