import React from "react";
import styled from "styled-components";
import { isMobile } from "../utils/misc";
import { didDismissSomethingWithOutsideTapJustNow } from "./BottomControls";

const NotificationBanner = styled.div<{
  isVisible: boolean;
  dismissType?: "click" | "close" | null;
}>`
  position: fixed;
  top: 56px;
  right: 9pt;
  background-color: var(--overlay-light-95);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 23px;
  padding: 0;
  width: min(280px, 85dvw);
  box-shadow: 0 6px 20px var(--notificationBannerShadow);
  z-index: 6;
  opacity: ${(props) => (props.isVisible ? 1 : 0)};
  transform: ${(props) => {
    if (props.isVisible) return "translateX(0) scale(1)";
    if (props.dismissType === "click") return "translateX(0) scale(0.95)";
    return "translateX(100%) scale(1)";
  }};
  pointer-events: ${(props) => (props.isVisible ? "auto" : "none")};
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  height: 69px;
  -webkit-touch-callout: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: ${(props) => {
    if (props.dismissType === "click") return "all 0.2s ease-out";
    return "all 0.45s cubic-bezier(0.25, 0.8, 0.25, 1)";
  }};

  &:active {
    transform: ${(props) => {
      if (!props.isVisible)
        return props.dismissType === "click"
          ? "translateX(0) scale(0.95)"
          : "translateX(100%) scale(1)";
      return "translateX(0) scale(0.98)";
    }};
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--overlay-dark-95);
    color: var(--color-gray-f5);
  }

  @media screen and (max-height: 500px) {
    top: 53px;
  }

  @media screen and (max-height: 453px) {
    top: 50px;
  }

  @media screen and (max-width: 420px) {
    right: 8px;
  }

  @media screen and (max-width: 387px) {
    right: 6px;
  }
`;

const NotificationImage = styled.img`
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  margin-left: 16px;
  align-self: center;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-tap-highlight-color: transparent;
`;

const NotificationContent = styled.div`
  flex: 1;
  padding: 12px 8px;
  padding-right: 40px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-tap-highlight-color: transparent;
`;

const NotificationTitle = styled.div`
  font-size: 18px;
  font-weight: 800;
  color: var(--color-blue-0066cc);
  margin-bottom: 2px;
  line-height: 1.2;
  text-align: left;
  touch-action: none;

  @media (prefers-color-scheme: dark) {
    color: var(--color-blue-66b3ff);
  }
`;

const NotificationSubtitle = styled.div`
  font-size: 13px;
  font-weight: 500;
  color: var(--color-gray-69);
  line-height: 1.3;
  touch-action: none;
  text-align: left;

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-99);
  }
`;

const CloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-gray-fb);
  border: none;
  color: var(--notificationCloseButtonColor);
  cursor: pointer;
  font-size: 18px;
  font-weight: 230;
  line-height: 18px;
  position: absolute;
  border-radius: 50%;
  height: 26px;
  width: 26px;
  right: 6px;
  top: 6px;
  padding: 0;
  -webkit-touch-callout: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  -webkit-tap-highlight-color: transparent;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background: var(--color-gray-f0);
      color: var(--color-gray-99);
    }
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-42);
    background: var(--color-gray-23);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background: var(--notificationCloseButtonBackgroundHoverDark);
        color: var(--color-gray-69);
      }
    }
  }
`;

interface NotificationBannerComponentProps {
  isVisible: boolean;
  onClose: () => void;
  onClick: () => void;
  title: string;
  subtitle: string;
  emojiId: string;
  dismissType?: "click" | "close" | null;
}

export const NotificationBannerComponent: React.FC<
  NotificationBannerComponentProps
> = ({
  isVisible,
  onClose,
  onClick,
  title,
  subtitle,
  emojiId,
  dismissType,
}) => {
  const handleNotificationClick = (
    event: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    didDismissSomethingWithOutsideTapJustNow();
    onClick();
  };

  const handleCloseClick = (
    event:
      React.MouseEvent<HTMLButtonElement> | React.TouchEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    didDismissSomethingWithOutsideTapJustNow();
    onClose();
  };

  return (
    <NotificationBanner
      data-notification-banner="true"
      isVisible={isVisible}
      dismissType={dismissType}
      onClick={handleNotificationClick}
    >
      <NotificationImage
        src={`https://cdn.lil.org/mons/emojipack/regular/${emojiId}.webp`}
        alt=""
      />
      <NotificationContent>
        <NotificationTitle>{title}</NotificationTitle>
        <NotificationSubtitle>{subtitle}</NotificationSubtitle>
      </NotificationContent>
      <CloseButton
        onClick={!isMobile ? handleCloseClick : undefined}
        onTouchStart={isMobile ? handleCloseClick : undefined}
      >
        ×
      </CloseButton>
    </NotificationBanner>
  );
};
