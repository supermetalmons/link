import React from "react";
import type { ColorSet } from "../content/boardStyles";
import {
  getBoardPatternSquareColorKey,
  type BoardSquareTypeGrid,
} from "../game/boardSquareTypes";

interface BoardPatternProps {
  colorSet: ColorSet;
  size: number;
  cellSize: number;
  offsetY?: number;
  keyPrefix?: string;
  squareTypes?: BoardSquareTypeGrid | null;
  useLightTileManaBaseShade?: boolean;
}

export const generateBoardPattern = ({
  colorSet,
  size,
  cellSize,
  offsetY = 0,
  keyPrefix = "square",
  squareTypes,
  useLightTileManaBaseShade = false,
}: BoardPatternProps): React.JSX.Element[] => {
  const elements: React.JSX.Element[] = [];
  const boardSize = Math.round(size / cellSize);

  for (let row = 0; row < boardSize; row += 1) {
    for (let col = 0; col < boardSize; col += 1) {
      const x = col * cellSize;
      const y = row * cellSize + offsetY;
      elements.push(
        <rect
          key={`${keyPrefix}-${row}-${col}`}
          x={x}
          y={y}
          width={cellSize}
          height={cellSize}
          fill={
            colorSet[
              getBoardPatternSquareColorKey(
                row,
                col,
                squareTypes,
                useLightTileManaBaseShade,
              )
            ]
          }
        />,
      );
    }
  }

  return elements;
};
