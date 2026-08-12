import type { EventMatch, EventRound } from "../../connection/connectionModels";
import { parseEventMatchKey } from "@mons/shared/events";
import { getSortedMatches } from "./eventState";

export const BRACKET_MATCH_W = 72;
export const BRACKET_MATCH_H = 40;
const BRACKET_SLOT_PITCH = 88;
const BRACKET_CONNECTOR_W = 40;
const BRACKET_COMPACT_CONNECTOR_W = 18;
const BRACKET_CORNER_R = 10;

export type ClassicBracketMatchPosition = {
  x: number;
  y: number;
  key: string;
  match: EventMatch;
  width: number;
  height: number;
};

export type ClassicBracketConnector = {
  d: string;
  isBlocked: boolean;
  crossX: number | null;
  crossY: number | null;
};

export type ClassicBracketLayout = {
  width: number;
  height: number;
  positions: ClassicBracketMatchPosition[];
  connectors: ClassicBracketConnector[];
};

export type ThirdPlaceMatchLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
  match: EventMatch;
};

export type BracketMatchLayout = {
  width: number;
  height: number;
  useCompactEntry: boolean;
};

export const getBracketMatchLayout = (
  roundIndex: number,
  totalRounds: number,
): BracketMatchLayout => {
  return {
    width: BRACKET_MATCH_W,
    height: BRACKET_MATCH_H,
    useCompactEntry: roundIndex < totalRounds - 1,
  };
};

export const getBracketMatchTop = (
  depthIndex: number,
  matchIndex: number,
  matchHeight: number,
): number => {
  const slotSpan = BRACKET_SLOT_PITCH * Math.pow(2, depthIndex);
  return Math.round((slotSpan - matchHeight) / 2 + matchIndex * slotSpan);
};

export const getBracketMatchCenterY = (
  depthIndex: number,
  matchIndex: number,
  matchHeight: number,
): number => {
  return (
    getBracketMatchTop(depthIndex, matchIndex, matchHeight) + matchHeight / 2
  );
};

export const getClassicConnectorMidX = (x1: number, x2: number): number => {
  return x1 + (x2 - x1) / 2;
};

export const buildClassicElbowConnectorPath = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string => {
  const direction = x2 >= x1 ? 1 : -1;
  const mx = getClassicConnectorMidX(x1, x2);
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) {
    return `M${x1},${y1}H${x2}`;
  }
  const signY = dy > 0 ? 1 : -1;
  const r = Math.min(
    BRACKET_CORNER_R,
    Math.abs(dy) / 2,
    Math.abs(mx - x1),
    Math.abs(x2 - mx),
  );
  if (r < 1) {
    return `M${x1},${y1}H${mx}V${y2}H${x2}`;
  }
  return [
    `M${x1},${y1}`,
    `H${mx - direction * r}`,
    `Q${mx},${y1} ${mx},${y1 + signY * r}`,
    `V${y2 - signY * r}`,
    `Q${mx},${y2} ${mx + direction * r},${y2}`,
    `H${x2}`,
  ].join("");
};

export const buildClassicTopBottomEntryConnectorPath = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string => {
  const direction = x2 >= x1 ? 1 : -1;
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) {
    return `M${x1},${y1}H${x2}`;
  }
  const signY = dy > 0 ? 1 : -1;
  const r = Math.min(BRACKET_CORNER_R, Math.abs(dy), Math.abs(x2 - x1));
  if (r < 1) {
    return `M${x1},${y1}H${x2}V${y2}`;
  }
  return [
    `M${x1},${y1}`,
    `H${x2 - direction * r}`,
    `Q${x2},${y1} ${x2},${y1 + signY * r}`,
    `V${y2}`,
  ].join("");
};

export const getClassicElbowConnectorCrossPoint = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } => {
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) {
    return {
      x: getClassicConnectorMidX(x1, x2),
      y: y1,
    };
  }

  const direction = x2 >= x1 ? 1 : -1;
  const mx = getClassicConnectorMidX(x1, x2);
  const r = Math.min(
    BRACKET_CORNER_R,
    Math.abs(dy) / 2,
    Math.abs(mx - x1),
    Math.abs(x2 - mx),
  );
  const horizontalEndX = r < 1 ? mx : mx - direction * r;

  return {
    x: getClassicConnectorMidX(x1, horizontalEndX),
    y: y1,
  };
};

export const getClassicTopBottomEntryConnectorCrossPoint = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } => {
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) {
    return {
      x: getClassicConnectorMidX(x1, x2),
      y: y1,
    };
  }

  const direction = x2 >= x1 ? 1 : -1;
  const r = Math.min(BRACKET_CORNER_R, Math.abs(dy), Math.abs(x2 - x1));
  const horizontalEndX = r < 1 ? x2 : x2 - direction * r;

  return {
    x: getClassicConnectorMidX(x1, horizontalEndX),
    y: y1,
  };
};

export const canRenderSymmetricalBracket = (rounds: EventRound[]): boolean => {
  if (rounds.length === 0) {
    return false;
  }

  const matchCounts = rounds.map((round) => getSortedMatches(round).length);
  if (matchCounts.some((count) => count <= 0)) {
    return false;
  }

  const hasCanonicalMatchKeys = rounds.every((round) => {
    const matches = getSortedMatches(round);
    for (let i = 0; i < matches.length; i += 1) {
      const parsed = parseEventMatchKey(matches[i].matchKey);
      if (!parsed || parsed.roundIndex !== round.roundIndex) {
        return false;
      }
      if (parsed.matchIndex !== i) {
        return false;
      }
    }
    return true;
  });
  if (!hasCanonicalMatchKeys) {
    return false;
  }

  if (rounds.length === 1) {
    return matchCounts[0] === 1;
  }

  if (matchCounts[rounds.length - 1] !== 1) {
    return false;
  }

  for (let i = 0; i < rounds.length - 1; i += 1) {
    if (matchCounts[i] !== matchCounts[i + 1] * 2) {
      return false;
    }
  }

  return true;
};

export const computeSymmetricalBracket = (
  rounds: EventRound[],
): ClassicBracketLayout | null => {
  if (rounds.length === 0) {
    return null;
  }

  const totalRounds = rounds.length;
  const sideRounds = totalRounds - 1;
  const roundLayouts = rounds.map((_, roundIndex) =>
    getBracketMatchLayout(roundIndex, totalRounds),
  );
  const finalLayout = roundLayouts[totalRounds - 1];

  if (sideRounds === 0) {
    const match = getSortedMatches(rounds[0])[0];
    if (!match) return null;
    return {
      width: finalLayout.width,
      height: finalLayout.height,
      positions: [
        {
          x: 0,
          y: 0,
          key: "FINAL",
          match,
          width: finalLayout.width,
          height: finalLayout.height,
        },
      ],
      connectors: [],
    };
  }

  const totalCols = 2 * sideRounds + 1;
  const columnRoundIndices = [
    ...Array.from({ length: sideRounds }, (_, roundIndex) => roundIndex),
    totalRounds - 1,
    ...Array.from(
      { length: sideRounds },
      (_, offset) => sideRounds - 1 - offset,
    ),
  ];
  const columnWidths = [
    ...roundLayouts.slice(0, sideRounds).map((layout) => layout.width),
    finalLayout.width,
    ...roundLayouts
      .slice(0, sideRounds)
      .reverse()
      .map((layout) => layout.width),
  ];
  const gapAfterColumn = Array.from(
    { length: Math.max(0, totalCols - 1) },
    (_, colIndex) => {
      const inwardColumnIndex = colIndex < sideRounds ? colIndex + 1 : colIndex;
      if (inwardColumnIndex === sideRounds) {
        return BRACKET_CONNECTOR_W;
      }
      const inwardRoundIndex = columnRoundIndices[inwardColumnIndex];
      return roundLayouts[inwardRoundIndex]?.useCompactEntry
        ? BRACKET_COMPACT_CONNECTOR_W
        : BRACKET_CONNECTOR_W;
    },
  );
  const columnX: number[] = [];
  let currentX = 0;
  for (let i = 0; i < totalCols; i += 1) {
    columnX.push(currentX);
    currentX += columnWidths[i] + (gapAfterColumn[i] ?? 0);
  }
  const width =
    totalCols === 0 ? 0 : columnX[totalCols - 1] + columnWidths[totalCols - 1];

  const positions: ClassicBracketMatchPosition[] = [];
  const connectors: ClassicBracketConnector[] = [];
  let maxBottom = 0;

  const colX = (col: number): number => columnX[col] ?? 0;
  const pushPosition = (
    x: number,
    y: number,
    key: string,
    match: EventMatch,
    layout: BracketMatchLayout,
  ): void => {
    positions.push({
      x,
      y,
      key,
      match,
      width: layout.width,
      height: layout.height,
    });
    maxBottom = Math.max(maxBottom, y + layout.height);
  };
  const pushConnector = (
    d: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    isBlocked: boolean,
    crossPoint?: { x: number; y: number },
  ): void => {
    connectors.push({
      d,
      isBlocked,
      crossX: isBlocked ? (crossPoint?.x ?? (x1 + x2) / 2) : null,
      crossY: isBlocked ? (crossPoint?.y ?? (y1 + y2) / 2) : null,
    });
  };

  for (let r = 0; r < sideRounds; r++) {
    const layout = roundLayouts[r];
    const x = colX(r);
    const roundMatches = getSortedMatches(rounds[r]);
    const perSideCount = Math.ceil(roundMatches.length / 2);

    for (let m = 0; m < perSideCount; m++) {
      const match = roundMatches[m];
      const y = getBracketMatchTop(r, m, layout.height);
      pushPosition(x, y, `L${r}_${m}`, match, layout);
    }

    if (r < sideRounds - 1) {
      const nextX = colX(r + 1);
      const nextLayout = roundLayouts[r + 1];
      const nextPerSideCount = Math.ceil(
        getSortedMatches(rounds[r + 1]).length / 2,
      );
      for (let j = 0; j < nextPerSideCount; j++) {
        const srcA = 2 * j;
        const srcB = 2 * j + 1;
        if (srcA >= perSideCount) {
          continue;
        }
        const y1 = getBracketMatchCenterY(r, srcA, layout.height);
        const nextMatchTop = getBracketMatchTop(r + 1, j, nextLayout.height);
        const sx = x + layout.width;
        const sourceMatchA = roundMatches[srcA];
        if (nextLayout.useCompactEntry) {
          const entryX = nextX + nextLayout.width / 2;
          pushConnector(
            buildClassicTopBottomEntryConnectorPath(
              sx,
              y1,
              entryX,
              nextMatchTop,
            ),
            sx,
            y1,
            entryX,
            nextMatchTop,
            sourceMatchA?.winnerDisqualified === true,
            getClassicTopBottomEntryConnectorCrossPoint(
              sx,
              y1,
              entryX,
              nextMatchTop,
            ),
          );
          if (srcB < perSideCount) {
            const y2 = getBracketMatchCenterY(r, srcB, layout.height);
            const sourceMatchB = roundMatches[srcB];
            pushConnector(
              buildClassicTopBottomEntryConnectorPath(
                sx,
                y2,
                entryX,
                nextMatchTop + nextLayout.height,
              ),
              sx,
              y2,
              entryX,
              nextMatchTop + nextLayout.height,
              sourceMatchB?.winnerDisqualified === true,
              getClassicTopBottomEntryConnectorCrossPoint(
                sx,
                y2,
                entryX,
                nextMatchTop + nextLayout.height,
              ),
            );
          }
        }
      }
    }

    if (r === sideRounds - 1) {
      const y = getBracketMatchCenterY(r, 0, layout.height);
      const sx = x + layout.width;
      const ex = colX(sideRounds);
      const finalY = getBracketMatchCenterY(r, 0, finalLayout.height);
      pushConnector(
        buildClassicElbowConnectorPath(sx, y, ex, finalY),
        sx,
        y,
        ex,
        finalY,
        roundMatches[0]?.winnerDisqualified === true,
        getClassicElbowConnectorCrossPoint(sx, y, ex, finalY),
      );
    }
  }

  {
    const x = colX(sideRounds);
    const finalRound = rounds[totalRounds - 1];
    const finalMatches = getSortedMatches(finalRound);
    const match = finalMatches[0];
    if (match) {
      const y = getBracketMatchTop(sideRounds - 1, 0, finalLayout.height);
      pushPosition(x, y, "FINAL", match, finalLayout);
    }
  }

  for (let r = 0; r < sideRounds; r++) {
    const layout = roundLayouts[r];
    const col = 2 * sideRounds - r;
    const x = colX(col);
    const roundMatches = getSortedMatches(rounds[r]);
    const totalCount = roundMatches.length;
    const perSideCount = Math.ceil(totalCount / 2);
    const offset = perSideCount;

    for (let m = 0; m < totalCount - perSideCount; m++) {
      const match = roundMatches[offset + m];
      const y = getBracketMatchTop(r, m, layout.height);
      pushPosition(x, y, `R${r}_${m}`, match, layout);
    }

    if (r < sideRounds - 1) {
      const innerCol = 2 * sideRounds - (r + 1);
      const innerX = colX(innerCol);
      const nextLayout = roundLayouts[r + 1];
      const nextRoundMatches = getSortedMatches(rounds[r + 1]);
      const nextTotalCount = nextRoundMatches.length;
      const nextPerSide = Math.ceil(nextTotalCount / 2);
      const innerMatchCount = nextTotalCount - nextPerSide;
      const currentSideCount = totalCount - perSideCount;
      for (let j = 0; j < innerMatchCount; j++) {
        const srcA = 2 * j;
        const srcB = 2 * j + 1;
        if (srcA >= currentSideCount) {
          continue;
        }
        const y1 = getBracketMatchCenterY(r, srcA, layout.height);
        const nextMatchTop = getBracketMatchTop(r + 1, j, nextLayout.height);
        const sx = x;
        const sourceMatchA = roundMatches[offset + srcA];
        if (nextLayout.useCompactEntry) {
          const entryX = innerX + nextLayout.width / 2;
          pushConnector(
            buildClassicTopBottomEntryConnectorPath(
              sx,
              y1,
              entryX,
              nextMatchTop,
            ),
            sx,
            y1,
            entryX,
            nextMatchTop,
            sourceMatchA?.winnerDisqualified === true,
            getClassicTopBottomEntryConnectorCrossPoint(
              sx,
              y1,
              entryX,
              nextMatchTop,
            ),
          );
          if (srcB < currentSideCount) {
            const y2 = getBracketMatchCenterY(r, srcB, layout.height);
            const sourceMatchB = roundMatches[offset + srcB];
            pushConnector(
              buildClassicTopBottomEntryConnectorPath(
                sx,
                y2,
                entryX,
                nextMatchTop + nextLayout.height,
              ),
              sx,
              y2,
              entryX,
              nextMatchTop + nextLayout.height,
              sourceMatchB?.winnerDisqualified === true,
              getClassicTopBottomEntryConnectorCrossPoint(
                sx,
                y2,
                entryX,
                nextMatchTop + nextLayout.height,
              ),
            );
          }
        }
      }
    }

    if (r === sideRounds - 1) {
      const y = getBracketMatchCenterY(r, 0, layout.height);
      const sx = x;
      const ex = colX(sideRounds) + finalLayout.width;
      const finalY = getBracketMatchCenterY(r, 0, finalLayout.height);
      pushConnector(
        buildClassicElbowConnectorPath(sx, y, ex, finalY),
        sx,
        y,
        ex,
        finalY,
        roundMatches[offset]?.winnerDisqualified === true,
        getClassicElbowConnectorCrossPoint(sx, y, ex, finalY),
      );
    }
  }

  return {
    width,
    height: Math.max(maxBottom, finalLayout.height),
    positions,
    connectors,
  };
};
