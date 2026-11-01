import styled from "styled-components";
import { FiCheck, FiCircle, FiPlus } from "react-icons/fi";

export const NavigationPickerContainer = styled.div`
  position: fixed;
  bottom: calc(
    max(50px, calc(env(safe-area-inset-bottom) + 44px)) +
      var(--bottom-controls-offset, 0px)
  );
  right: 8px;
  height: 480px;
  max-height: calc(
    min(100dvh, var(--bottom-controls-viewport-height, 100dvh)) -
      120px - env(safe-area-inset-bottom)
  );
  width: 150pt;
  display: flex;
  flex-direction: column;
  background-color: var(--panel-light-90);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 7pt;
  overflow: hidden;
  padding: 0;
  gap: 0;
  z-index: 7;

  @media (prefers-color-scheme: dark) {
    background-color: var(--panel-dark-90);
  }

  @media screen and (max-height: 453px) {
    bottom: calc(
      max(44px, calc(env(safe-area-inset-bottom) + 38px)) +
        var(--bottom-controls-offset, 0px)
    );
  }
`;

export const ScrollableList = styled.div`
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  flex-grow: 1;
  padding: 6px 0 8px;
  scrollbar-width: none;
  user-select: none;
  -webkit-user-select: none;

  &::-webkit-scrollbar {
    display: none;
  }
`;

export const NavigationPickerButton = styled.button<{ $isSelected?: boolean }>`
  background: ${(props) =>
    props.$isSelected ? "rgba(117, 187, 255, 0.22)" : "transparent"};
  border-radius: 0;
  font-size: 0.8rem;
  border: none;
  padding: 6px 12px;
  cursor: pointer;
  text-align: left;
  color: var(--color-gray-33);
  width: 100%;
  display: flex;
  align-items: center;
  gap: 5px;
  font-weight: 400;
  user-select: none;
  -webkit-user-select: none;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.$isSelected
          ? "rgba(117, 187, 255, 0.30)"
          : "var(--interactiveHoverBackgroundLight)"};
    }
  }

  &:active {
    background-color: ${(props) =>
      props.$isSelected
        ? "rgba(117, 187, 255, 0.38)"
        : "var(--interactiveActiveBackgroundLight)"};
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f0);
    background: ${(props) =>
      props.$isSelected ? "rgba(75, 150, 255, 0.24)" : "transparent"};

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.$isSelected
            ? "rgba(75, 150, 255, 0.34)"
            : "var(--interactiveHoverBackgroundDark)"};
      }
    }

    &:active {
      background-color: ${(props) =>
        props.$isSelected
          ? "rgba(75, 150, 255, 0.42)"
          : "var(--interactiveActiveBackgroundDark)"};
    }
  }
`;

export const GameRow = styled(NavigationPickerButton)<{
  $hasTrailingAction?: boolean;
}>`
  width: 100%;
  min-width: 0;
  padding-right: 12px;
`;

export const EventRow = styled(GameRow)`
  && {
    background: transparent;
  }

  @media (hover: hover) and (pointer: fine) {
    &&:hover {
      background-color: transparent;
    }
  }

  &&:active {
    background-color: transparent;
  }

  @media (prefers-color-scheme: dark) {
    && {
      background: transparent;
    }

    @media (hover: hover) and (pointer: fine) {
      &&:hover {
        background-color: transparent;
      }
    }

    &&:active {
      background-color: transparent;
    }
  }
`;

export const GameRowContainer = styled.div`
  position: relative;
  width: 100%;
  min-width: 0;
`;

export const GameEmojiImage = styled.img.attrs({ draggable: false })`
  width: 20px;
  height: 20px;
  border-radius: 2px;
  flex-shrink: 0;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
`;

export const GameEmojiPlaceholder = styled.div`
  width: 20px;
  height: 20px;
  border-radius: 2px;
  background: rgba(128, 128, 128, 0.22);
  flex-shrink: 0;
`;

export type QueueManaSlot = "top" | "right" | "bottom" | "left";

export const QueueManaCluster = styled.span`
  position: relative;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
`;

export const QueueManaIcon = styled.img<{ $slot: QueueManaSlot }>`
  position: absolute;
  width: 11px;
  height: 11px;
  object-fit: contain;
  left: ${(props) => {
    if (props.$slot === "left") {
      return "27%";
    }
    if (props.$slot === "right") {
      return "73%";
    }
    return "50%";
  }};
  top: ${(props) => {
    if (props.$slot === "top") {
      return "27%";
    }
    if (props.$slot === "bottom") {
      return "73%";
    }
    return "50%";
  }};
  transform: translate(-50%, -50%);
  pointer-events: none;
`;

export const GameText = styled.span`
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const FightCloudWrap = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  flex: 1;
`;

export const EventAvatarImage = styled(GameEmojiImage)``;
const EventAvatarPlaceholder = styled(GameEmojiPlaceholder)`
  background: transparent;
`;
export const EventAvatarQuestionSlot = styled(EventAvatarPlaceholder)`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 2px;
  border-radius: 999px;
  background: rgba(120, 120, 120, 0.12);
  color: rgba(74, 74, 74, 0.48);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.05);
    color: rgba(220, 220, 220, 0.34);
  }
`;

export const EventAvatarQuestionIcon = styled(FiPlus)`
  width: 11px;
  height: 11px;
  stroke-width: 2.3;
`;

export const FightCloudCanvas = styled.svg`
  position: absolute;
  top: 50%;
  left: -8px;
  transform: translateY(-50%);
  width: calc(100% + 18px);
  height: 28px;
  overflow: visible;
  pointer-events: none;
`;

export const CloudShape = styled.path`
  fill: currentColor;
  fill-opacity: 0.05;
  stroke: currentColor;
  stroke-opacity: 0.09;
  stroke-width: 0.6;
  transition:
    fill-opacity 0.12s,
    stroke-opacity 0.12s;

  @media (hover: hover) and (pointer: fine) {
    button:hover & {
      fill-opacity: 0.1;
      stroke-opacity: 0.15;
    }
  }

  button:active & {
    fill-opacity: 0.14;
    stroke-opacity: 0.19;
  }

  @media (prefers-color-scheme: dark) {
    fill-opacity: 0.07;
    stroke-opacity: 0.12;

    @media (hover: hover) and (pointer: fine) {
      button:hover & {
        fill-opacity: 0.12;
        stroke-opacity: 0.17;
      }
    }

    button:active & {
      fill-opacity: 0.16;
      stroke-opacity: 0.21;
    }
  }
`;

export const FightCloudInner = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  z-index: 1;
`;

export const EventPreviewGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
  margin-left: 2px;
`;

export const FightCloudBadge = styled.span`
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 18px;
  height: 18px;
  padding: 0 3px;
  border-radius: 9px;
  font-size: 0.55rem;
  font-weight: 600;
  color: var(--navigationTextMuted);
  flex-shrink: 0;
  letter-spacing: -0.02em;
  white-space: nowrap;
  background: rgba(128, 128, 128, 0.08);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.06);
  }
`;

export const EventTrailingContent = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 6px;
  flex-shrink: 0;
`;

export const QueuePrimaryContent = styled(GameText)``;

export const GameStatus = styled.span<{
  $isSelected?: boolean;
  $highlightSelected?: boolean;
}>`
  margin-left: auto;
  font-size: 0.52rem;
  color: ${(props) =>
    props.$isSelected && props.$highlightSelected
      ? "var(--color-blue-primary)"
      : "var(--navigationTextMuted)"};
  text-transform: uppercase;

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected && props.$highlightSelected
        ? "var(--color-blue-primary-dark)"
        : "var(--navigationTextMuted)"};
  }
`;

export const LiveDot = styled.span`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--color-blue-primary);
  margin-left: auto;
  flex-shrink: 0;

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-blue-primary-dark);
  }
`;

export const GameRemoveButton = styled.button<{ $isDisabled?: boolean }>`
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  z-index: 2;
  pointer-events: auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: none;
  padding: 0;
  background: rgba(128, 128, 128, 0.1);
  color: var(--navigationTextMuted);
  opacity: ${(props) => (props.$isDisabled ? 0.55 : 0.9)};
  cursor: ${(props) => (props.$isDisabled ? "default" : "pointer")};
  user-select: none;
  flex-shrink: 0;

  &::before,
  &::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 8px;
    height: 1.25px;
    border-radius: 999px;
    background: currentColor;
    transform-origin: center;
  }

  &::before {
    transform: translate(-50%, -50%) rotate(45deg);
  }

  &::after {
    transform: translate(-50%, -50%) rotate(-45deg);
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.$isDisabled
          ? "transparent"
          : "var(--interactiveHoverBackgroundLight)"};
      color: var(--color-gray-33);
    }
  }

  &:active {
    background-color: ${(props) =>
      props.$isDisabled
        ? "transparent"
        : "var(--interactiveActiveBackgroundLight)"};
  }

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--navigationTextMuted);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.$isDisabled
            ? "transparent"
            : "var(--interactiveHoverBackgroundDark)"};
        color: var(--color-gray-f0);
      }
    }

    &:active {
      background-color: ${(props) =>
        props.$isDisabled
          ? "transparent"
          : "var(--interactiveActiveBackgroundDark)"};
    }
  }
`;

export const CompletedIcon = styled(FiCheck)`
  color: var(--navigationTextMuted);
  width: 0.63rem;
  height: 0.63rem;
  margin-left: auto;
  flex-shrink: 0;
  padding-left: 4px;
  stroke-width: 1.5;
  stroke: currentColor;

  & path {
    fill: none;
  }
`;

export const IncompleteIcon = styled(FiCircle)`
  color: var(--navigationTextMuted);
  width: 0.63rem;
  height: 0.63rem;
  margin-left: auto;
  flex-shrink: 0;
  padding-left: 4px;
  stroke-width: 1.5;
  stroke: currentColor;
  transform: scale(0.8);
  transform-origin: center;
  overflow: visible;

  & path {
    fill: none;
  }
`;

export const PlaceholderImage = styled.img.attrs({ draggable: false })`
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
`;

export const HomeBoardButton = styled.button<{ $withTopBorder?: boolean }>`
  position: sticky;
  bottom: 0;
  background-color: var(--color-blue-primary);
  color: white;
  border-radius: 21px;
  padding: 8px 16px;
  height: 42px;
  font-size: 0.777rem;
  font-weight: bold;
  border: none;
  cursor: pointer;
  text-align: center;
  width: calc(100% - 12px);
  margin: ${(props) => (props.$withTopBorder ? "8px" : "0")} 6px 8px;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  outline: none;
  z-index: 2;

  &:active {
    background-color: var(--bottomButtonBackgroundActive);
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--bottomButtonBackgroundHover);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-blue-primary-dark);

    &:active {
      background-color: var(--bottomButtonBackgroundActiveDark);
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--bottomButtonBackgroundHoverDark);
      }
    }
  }
`;
