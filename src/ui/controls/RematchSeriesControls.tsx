import React from "react";
import { FaHourglassHalf } from "react-icons/fa";
import styled from "styled-components";
import type { RematchSeriesNavigatorItem } from "../../game/gameController";

const rematchSeriesDigitsFontFamily =
  'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", "Courier New", monospace';
const RematchSeriesInlineControl = styled.div`
  flex: 1 1 0;
  min-width: 0;
  height: 32px;
  display: flex;
  align-items: center;
  padding: 0;
  overflow: hidden;
  mask-image: linear-gradient(to left, transparent 0px, black 6px);
  -webkit-mask-image: linear-gradient(to left, transparent 0px, black 6px);
`;

const RematchSeriesScroll = styled.div`
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;

  &::-webkit-scrollbar {
    display: none;
  }
`;

const RematchSeriesTrack = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  background: transparent;
  border-radius: 16px;
  height: 32px;
  flex-shrink: 0;
  padding: 0 1px;
`;

const RematchSeriesChip = styled.button<{ $isSelected: boolean }>`
  border: none;
  border-radius: 9px;
  height: 30px;
  min-width: 26px;
  padding: 0 7px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  flex-shrink: 0;
  cursor: pointer;
  font-family: ${rematchSeriesDigitsFontFamily};
  font-variant-numeric: tabular-nums;
  background: transparent;
  position: relative;

  &::before {
    content: "";
    display: ${(props) => (props.$isSelected ? "block" : "none")};
    position: absolute;
    left: 50%;
    top: 50%;
    width: 18px;
    height: 30px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: rgba(249, 249, 249, 0.77);
    z-index: 0;

    @media (prefers-color-scheme: dark) {
      background: rgba(36, 36, 36, 0.77);
    }
  }

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

const RematchScoreOpponent = styled.span<{ $isSelected: boolean }>`
  font-size: 10px;
  line-height: 1;
  font-weight: 400;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.34)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchScorePlayer = styled.span<{ $isSelected: boolean }>`
  font-size: 10px;
  line-height: 1;
  font-weight: 400;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.34)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchSeriesSeparator = styled.div<{ $hidden: boolean }>`
  width: 0.5px;
  height: 14px;
  background: rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  opacity: ${(props) => (props.$hidden ? 0 : 1)};
  transition: opacity 0.15s ease;

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.12);
  }
`;

const RematchWaitingIcon = styled.span<{ $isSelected: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.4)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchLoadingDots = styled.span<{ $isSelected: boolean }>`
  font-size: 11px;
  line-height: 1;
  letter-spacing: 1px;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.15)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.4)"
        : "rgba(255, 255, 255, 0.15)"};
  }
`;

type RematchSeriesControlsProps = {
  items: RematchSeriesNavigatorItem[];
  isSelecting: boolean;
  selectMatch: (matchId: string) => Promise<void>;
};

function RematchSeriesChipContent({
  item,
}: {
  item: RematchSeriesNavigatorItem;
}) {
  if (item.isPendingResponse) {
    return (
      <RematchWaitingIcon $isSelected={item.isSelected}>
        <FaHourglassHalf />
      </RematchWaitingIcon>
    );
  }
  if (item.whiteScore !== null && item.blackScore !== null) {
    const opponentScore = item.playerIsWhite
      ? item.blackScore
      : item.whiteScore;
    const playerScore = item.playerIsWhite ? item.whiteScore : item.blackScore;
    return (
      <>
        <RematchScoreOpponent $isSelected={item.isSelected}>
          {opponentScore}
        </RematchScoreOpponent>
        <RematchScorePlayer $isSelected={item.isSelected}>
          {playerScore}
        </RematchScorePlayer>
      </>
    );
  }
  return (
    <RematchLoadingDots $isSelected={item.isSelected}>·</RematchLoadingDots>
  );
}

export function RematchSeriesControls({
  items,
  isSelecting,
  selectMatch,
}: RematchSeriesControlsProps) {
  if (items.length === 0) return null;

  return (
    <RematchSeriesInlineControl role="group" aria-label="Rematch series">
      <RematchSeriesScroll>
        <RematchSeriesTrack>
          {items.map((item, index) => (
            <React.Fragment key={item.matchId}>
              <RematchSeriesChip
                $isSelected={item.isSelected}
                disabled={isSelecting}
                onClick={() => void selectMatch(item.matchId)}
              >
                <RematchSeriesChipContent item={item} />
              </RematchSeriesChip>
              {index < items.length - 1 && (
                <RematchSeriesSeparator $hidden={false} />
              )}
            </React.Fragment>
          ))}
        </RematchSeriesTrack>
      </RematchSeriesScroll>
    </RematchSeriesInlineControl>
  );
}
