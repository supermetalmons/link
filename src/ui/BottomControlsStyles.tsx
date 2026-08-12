import styled, { keyframes } from "styled-components";

export const ControlsContainer = styled.div`
  position: fixed;
  bottom: max(10px, env(safe-area-inset-bottom));
  right: 10px;
  left: 46px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;

  @media screen and (max-height: 453px) {
    bottom: max(6px, env(safe-area-inset-bottom));
  }

  @media screen and (orientation: portrait) {
    right: 8px;
  }

  @media screen and (max-width: 435px) {
    gap: 6px;
  }

  @media screen and (max-width: 387px) {
    right: 6px;
    left: 38px;
    gap: 5px;
  }

  @media screen and (max-width: 359px) {
    gap: 4px;
  }

  @media screen and (max-width: 320px) {
    gap: 3px;
  }
`;

export const BrushButton = styled.button<{
  disabled?: boolean;
  $dimmed?: boolean;
}>`
  position: fixed;
  bottom: max(10px, env(safe-area-inset-bottom));
  left: 9px;
  width: 32px;
  height: 32px;
  border-radius: 16px;
  z-index: 1;
  opacity: ${(props) => (props.$dimmed ? 0.77 : 1)};
  background-color: var(--color-gray-f9);
  border: none;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  outline: none;
  -webkit-touch-callout: none;
  touch-action: none;
  overflow: visible;

  @media screen and (max-height: 453px) {
    bottom: max(6px, env(safe-area-inset-bottom));
  }

  @media screen and (orientation: portrait) {
    left: 8px;
  }

  @media screen and (max-width: 387px) {
    width: 27px;
    left: 6px;
  }

  svg {
    width: 12px;
    height: 12px;
    color: var(--mutedTextColor);
    overflow: visible;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover svg {
      color: var(--mutedTextColorHover);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--primaryContainerBackgroundDark);
    svg {
      color: var(--mutedTextColorDark);
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover svg {
        color: var(--mutedTextColorHoverDark);
      }
    }
  }
`;

export const BottomPillButton = styled.button<{
  $isPink?: boolean;
  $isBlue?: boolean;
  $isViewOnly?: boolean;
  disabled?: boolean;
}>`
  height: 32px;
  font-weight: 888;
  font-size: 0.88rem;
  border-radius: 16px;
  padding: 0px 16px;

  svg {
    width: 0.9em;
    height: 0.9em;
    margin-right: 6px;
    flex-shrink: 0;
  }

  @media screen and (max-width: 520px) {
    font-size: 0.81rem;
    font-weight: 750;
  }

  @media screen and (max-width: 491px) {
    padding: 0px 12px;
    font-size: 0.77rem;
  }

  @media screen and (max-width: 468px) {
    padding: 0px 10px;
    font-size: 0.75rem;
    font-weight: 700;
  }

  @media screen and (max-width: 430px) {
    padding: 0px 8px;
    font-size: 0.69rem;
  }

  @media screen and (max-width: 399px) {
    font-size: 0.65rem;
  }

  @media screen and (max-width: 375px) {
    padding: 0px 7px;
    font-size: 0.62rem;
  }

  @media screen and (max-width: 359px) {
    svg {
      margin-right: 3px !important;
    }
  }

  @media screen and (max-width: 345px) {
    font-size: 0.59rem;
  }

  @media screen and (max-width: 331px) {
    font-size: 0.55rem;
  }

  @media screen and (max-width: 316px) {
    font-size: 0.5rem;
  }

  @media screen and (max-width: 300px) {
    font-size: 0.42rem;
  }

  @media screen and (max-width: 275px) {
    font-size: 0.35rem;
  }

  @media screen and (max-width: 235px) {
    font-size: 0.3rem;
  }

  cursor: ${(props) =>
    props.disabled || props.$isViewOnly ? "default" : "pointer"};
  transition: background-color 0.3s ease;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;

  background-color: ${(props) =>
    props.$isViewOnly
      ? "var(--color-gray-f0)"
      : props.$isBlue
        ? "var(--color-gray-f0)"
        : props.$isPink && props.disabled
          ? "var(--pinkButtonBackgroundDisabled)"
          : props.$isPink
            ? "var(--color-pink-light)"
            : "var(--color-blue-primary)"};
  color: ${(props) =>
    props.$isPink && props.disabled
      ? "var(--color-white)"
      : props.$isViewOnly
        ? "var(--viewOnlyButtonTextColor)"
        : props.$isBlue
          ? "var(--color-blue-primary)"
          : "var(--color-white)"};
  border: none;

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background-color: ${(props) =>
        props.$isViewOnly
          ? "var(--color-gray-f0)"
          : props.$isBlue
            ? "var(--color-gray-e0)"
            : props.$isPink && props.disabled
              ? "var(--pinkButtonBackgroundDisabled)"
              : props.$isPink
                ? "var(--color-pink-mid)"
                : "var(--bottomButtonBackgroundHover)"};
    }
  }

  &:active:not(:disabled) {
    background-color: ${(props) =>
      props.$isViewOnly
        ? "var(--color-gray-f0)"
        : props.$isBlue
          ? "var(--color-gray-d0)"
          : props.$isPink && props.disabled
            ? "var(--pinkButtonBackgroundDisabled)"
            : props.$isPink
              ? "var(--pinkButtonBackgroundActive)"
              : "var(--bottomButtonBackgroundActive)"};
  }

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isPink && props.disabled
        ? "var(--color-text-on-pink-disabled)"
        : props.$isViewOnly
          ? "var(--color-gray-77)"
          : props.$isBlue
            ? "var(--color-blue-primary-dark)"
            : "var(--color-white)"};

    background-color: ${(props) =>
      props.$isViewOnly
        ? "var(--color-gray-33)"
        : props.$isBlue
          ? "var(--color-gray-33)"
          : props.$isPink && props.disabled
            ? "var(--pinkButtonBackgroundDisabledDark)"
            : props.$isPink
              ? "var(--color-pink-mid)"
              : "var(--color-blue-primary-dark)"};

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background-color: ${(props) =>
          props.$isViewOnly
            ? "var(--color-gray-33)"
            : props.$isBlue
              ? "var(--color-gray-44)"
              : props.$isPink && props.disabled
                ? "var(--pinkButtonBackgroundDisabledDark)"
                : props.$isPink
                  ? "var(--color-pink-light)"
                  : "var(--bottomButtonBackgroundHoverDark)"};
      }
    }

    &:active:not(:disabled) {
      background-color: ${(props) =>
        props.$isViewOnly
          ? "var(--color-gray-33)"
          : props.$isBlue
            ? "var(--color-gray-55)"
            : props.$isPink && props.disabled
              ? "var(--pinkButtonBackgroundDisabledDark)"
              : props.$isPink
                ? "var(--pinkButtonBackgroundActiveDark)"
                : "var(--bottomButtonBackgroundActiveDark)"};
    }
  }

  ${(props) =>
    props.$isViewOnly &&
    `
    font-weight: 600;
    letter-spacing: 0.015em;
    background-color: rgba(0, 0, 0, 0.04);
    color: #aaa;

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: rgba(0, 0, 0, 0.04);
      }
    }

    &:active {
      background-color: rgba(0, 0, 0, 0.04);
    }

    @media (prefers-color-scheme: dark) {
      background-color: rgba(255, 255, 255, 0.06);
      color: #606060;

      @media (hover: hover) and (pointer: fine) {
        &:hover {
          background-color: rgba(255, 255, 255, 0.06);
        }
      }

      &:active {
        background-color: rgba(255, 255, 255, 0.06);
      }
    }
  `}
`;

const shimmer = keyframes`
  0% { background-position: 200% center; }
  100% { background-position: -200% center; }
`;

export const ShimmerText = styled.span`
  color: #aaa;

  @supports ((-webkit-background-clip: text) or (background-clip: text)) {
    background: linear-gradient(
      90deg,
      #aaa 0%,
      #aaa 40%,
      #666 50%,
      #aaa 60%,
      #aaa 100%
    );
    background-size: 200% auto;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: ${shimmer} 2s ease-in-out infinite;
  }

  @media (prefers-color-scheme: dark) {
    color: #606060;

    @supports ((-webkit-background-clip: text) or (background-clip: text)) {
      color: transparent;
      -webkit-text-fill-color: transparent;
      background-image: linear-gradient(
        90deg,
        #606060 0%,
        #606060 40%,
        #999 50%,
        #606060 60%,
        #606060 100%
      );
    }
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }

  @media (forced-colors: active) {
    background: none;
    animation: none;
    color: ButtonText;
    -webkit-text-fill-color: ButtonText;
  }
`;

export const NavigationListButton = styled.button<{
  disabled?: boolean;
  $dimmed?: boolean;
}>`
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: ${(props) => (props.$dimmed ? "16px" : "16px")};
  background-color: var(--color-gray-f0);
  border: none;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  outline: none;
  -webkit-touch-callout: none;
  touch-action: none;
  overflow: visible;

  svg {
    width: ${(props) => (props.$dimmed ? "16px" : "13px")};
    height: ${(props) => (props.$dimmed ? "16px" : "13px")};
    color: ${(props) =>
      props.$dimmed ? "var(--color-gray-33)" : "var(--color-blue-primary)"};
    overflow: visible;
  }

  @media screen and (max-width: 387px) {
    width: ${(props) => (props.$dimmed ? "32px" : "27px")};

    svg {
      width: ${(props) => (props.$dimmed ? "16px" : "10px")};
      height: ${(props) => (props.$dimmed ? "16px" : "10px")};
    }
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--color-gray-e0);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-gray-33);
    svg {
      color: ${(props) =>
        props.$dimmed
          ? "var(--color-gray-f0)"
          : "var(--color-blue-primary-dark)"};
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--color-gray-44);
      }
    }
  }
`;

export const ControlButton = styled.button<{ disabled?: boolean }>`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background-color: var(--color-gray-f0);
  border: none;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: ${(props) => (props.disabled ? "default" : "pointer")};
  transition: background-color 0.3s ease;
  -webkit-tap-highlight-color: transparent;
  overflow: visible;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.disabled ? "var(--color-gray-f0)" : "var(--color-gray-e0)"};
    }
  }

  &:active {
    background-color: ${(props) =>
      props.disabled ? "var(--color-gray-f0)" : "var(--color-gray-d0)"};
  }

  svg {
    width: 16px;
    height: 16px;
    color: ${(props) =>
      props.disabled
        ? "var(--lightDisabledTextColor2)"
        : "var(--color-gray-33)"};
    overflow: visible;
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-gray-33);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.disabled ? "var(--color-gray-33)" : "var(--color-gray-44)"};
      }
    }

    &:active {
      background-color: ${(props) =>
        props.disabled ? "var(--color-gray-33)" : "var(--color-gray-55)"};
    }

    svg {
      color: ${(props) =>
        props.disabled ? "var(--color-gray-77)" : "var(--color-gray-f0)"};
    }
  }
`;

const ReactionPicker = styled.div<{ $offsetToTheRight?: boolean }>`
  position: absolute;
  bottom: 40px;
  right: ${(props) => (props.$offsetToTheRight ? "22px" : "64px")};
  background-color: var(--panel-light-90);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 8px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;

  @media screen and (max-height: 453px) {
    bottom: 38px;
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--panel-dark-90);
  }
`;

const ReactionButton = styled.button`
  background: none;
  border: none;
  padding: 4px 8px;
  cursor: pointer;
  text-align: left;
  color: var(--color-gray-33);

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--interactiveHoverBackgroundLight);
    }
  }

  &:active {
    background-color: var(--interactiveActiveBackgroundLight);
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f0);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--interactiveHoverBackgroundDark);
      }
    }

    &:active {
      background-color: var(--interactiveActiveBackgroundDark);
    }
  }
`;

export const ResignConfirmation = styled(ReactionPicker)`
  right: 10px;
  padding: 12px;
`;

export const ResignButton = styled(ReactionButton)`
  background-color: var(--resignButtonBackground);
  color: var(--color-white);
  border-radius: 16px;
  padding: 8px 16px;
  font-weight: bold;

  &:active {
    background-color: var(--resignButtonBackgroundActive);
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--resignButtonBackgroundHover);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--resignButtonBackgroundDark);

    &:active {
      background-color: var(--resignButtonBackgroundActiveDark);
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--resignButtonBackgroundHoverDark);
      }
    }
  }
`;

export const ReactionPillsContainer = styled.div<{
  $animatedMaxHeight?: number;
}>`
  position: fixed;
  bottom: max(50px, calc(env(safe-area-inset-bottom) + 44px));
  right: 8px;
  background-color: var(--panel-light-90);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 12px;
  padding: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: min(90vw, 204px);
  max-height: ${(props) =>
    props.$animatedMaxHeight
      ? `min(calc(100dvh - 120px - env(safe-area-inset-bottom)), ${props.$animatedMaxHeight}px)`
      : "calc(100dvh - 120px - env(safe-area-inset-bottom))"};
  transition: max-height 0.16s ease-out;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  z-index: 7;

  & > * {
    flex: 1 0 auto;
  }

  &::after {
    content: "";
    flex: 999 1 0;
    height: 0;
    pointer-events: none;
  }

  @media screen and (max-height: 453px) {
    bottom: max(44px, calc(env(safe-area-inset-bottom) + 38px));
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--panel-dark-90);
  }
`;

export const ReactionPill = styled.button`
  height: 30px;
  border-radius: 16px;
  padding: 0 10px;
  border: none;
  background-color: var(--color-gray-f0);
  color: var(--color-gray-33);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.84rem;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--color-gray-e0);
    }
  }

  &:active {
    background-color: var(--color-gray-d0);
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-gray-33);
    color: var(--color-gray-f0);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--color-gray-44);
      }
    }

    &:active {
      background-color: var(--color-gray-55);
    }
  }
`;

export const StickerPill = styled(ReactionPill)`
  padding: 0 6px;
  img {
    width: 24px;
    height: 24px;
    display: block;
  }
`;

export const WagerBetButton = styled.button<{ $ready?: boolean }>`
  width: 100%;
  height: 34px;
  border-radius: 17px;
  padding: 0 14px;
  border: none;
  background-color: ${(p) =>
    p.$ready
      ? "var(--wagerButtonBackgroundReady)"
      : "var(--wagerButtonBackground)"};
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-weight: 700;
  font-size: 0.84rem;
  letter-spacing: 0.02em;
  cursor: ${(p) => (p.$ready ? "pointer" : "default")};
  -webkit-tap-highlight-color: transparent;
  flex-shrink: 0;
  margin-bottom: 2px;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(p) =>
        p.$ready
          ? "var(--wagerButtonBackgroundReadyHover)"
          : "var(--wagerButtonBackground)"};
    }
  }

  &:active {
    background-color: ${(p) =>
      p.$ready
        ? "var(--wagerButtonBackgroundReadyActive)"
        : "var(--wagerButtonBackground)"};
  }

  @media (prefers-color-scheme: dark) {
    background-color: ${(p) =>
      p.$ready
        ? "var(--wagerButtonBackgroundReadyDark)"
        : "var(--wagerButtonBackgroundDark)"};
    color: #fff;

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(p) =>
          p.$ready
            ? "var(--wagerButtonBackgroundReadyHoverDark)"
            : "var(--wagerButtonBackgroundDark)"};
      }
    }

    &:active {
      background-color: ${(p) =>
        p.$ready
          ? "var(--wagerButtonBackgroundReadyActiveDark)"
          : "var(--wagerButtonBackgroundDark)"};
    }
  }
`;

export const WagerMaterialsGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  justify-content: center;
`;

export const WagerMaterialItem = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: var(--color-gray-f0);
  border-radius: 999px;
  padding: 4px 10px 4px 5px;
  border: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
  transition: background 120ms ease;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background: var(--color-gray-e0);
    }
  }

  &:active {
    background: var(--color-gray-d0);
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-33);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background: var(--color-gray-44);
      }
    }

    &:active {
      background: var(--color-gray-55);
    }
  }
`;

export const WagerMaterialIcon = styled.img`
  width: 28px;
  height: 28px;
  display: block;
`;

export const WagerMaterialAmount = styled.span`
  font-size: 12px;
  line-height: 1;
  color: var(--color-gray-33);
  font-weight: 600;
  font-family:
    ui-monospace,
    SFMono-Regular,
    SF Mono,
    Menlo,
    Consolas,
    "Liberation Mono",
    "Courier New",
    monospace;
  letter-spacing: 0.2px;

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f0);
  }
`;

export const WagerButtonBadge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 3px;
`;

export const WagerButtonIcon = styled.img`
  width: 20px;
  height: 20px;
  display: block;
`;

export const WagerButtonAmount = styled.span`
  font-size: 12px;
  line-height: 1;
  color: inherit;
  font-weight: 700;
  font-family:
    ui-monospace,
    SFMono-Regular,
    SF Mono,
    Menlo,
    Consolas,
    "Liberation Mono",
    "Courier New",
    monospace;
  letter-spacing: 0.2px;
`;
