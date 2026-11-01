import { forwardRef } from "react";
import styled, { css } from "styled-components";
import { useGameAssets } from "../hooks/useGameAssets";
import { useEmojis } from "../hooks/useEmojis";
import { TopRightPopoverBase } from "./TopRightPopoverBase";

export const HowToPlayPopoverSurface = styled(TopRightPopoverBase)`
  max-height: calc(100dvh - 113px - env(safe-area-inset-bottom));
  padding-top: 8px;
  padding-right: 12px;
  padding-bottom: 8px;
  padding-left: 12px;
  width: min(277px, 85dvw);
  text-align: left;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  flex-grow: 1;
  transform: none;
  transition: none;

  &:focus-visible {
    outline: none;
  }
`;

export const howToPlayContentStyles = css`
  white-space: pre-wrap;
  line-height: 2.1;

  img {
    vertical-align: middle;
    margin-right: 4px;
  }

  .icon-image {
    width: 20px;
    height: 20px;
  }

  .emoji-image {
    width: 16px;
    height: 16px;
  }
`;

const StyledInfoPopover = styled(HowToPlayPopoverSurface)`
  ${howToPlayContentStyles}
`;

const ICON_FALLBACK =
  "data:image/svg+xml,%3Csvg width='20' height='20' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='10' cy='10' r='8' fill='%23cccccc' fill-opacity='0.5'/%3E%3C/svg%3E";

interface HowToPlaySeparatorProps {
  ariaHidden?: boolean;
}

export const HowToPlaySeparator = ({
  ariaHidden = false,
}: HowToPlaySeparatorProps) => (
  <span style={{ opacity: 0.95 }} aria-hidden={ariaHidden ? true : undefined}>
    ⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯⋯
  </span>
);

export const HowToPlayContent = () => {
  const { assets } = useGameAssets();
  const { emojis } = useEmojis();

  const getIconImage = (iconName: string) =>
    assets?.[iconName]
      ? `data:image/png;base64,${assets[iconName]}`
      : ICON_FALLBACK;

  const getEmojiImage = (
    emojiName: "statusMove" | "statusAction" | "statusMana",
  ) =>
    emojis?.[emojiName]
      ? `data:image/png;base64,${emojis[emojiName]}`
      : ICON_FALLBACK;

  return (
    <>
      <img className="icon-image" src={getIconImage("drainer")} alt="drainer" />{" "}
      Carry mana with the drainer.
      <br />
      <img
        className="icon-image"
        src={getIconImage("manaB")}
        alt="manaB"
      />{" "}
      Bring mana to the corners to score.
      <br />
      <img className="icon-image" src={getIconImage("mana")} alt="mana" /> Score
      5 points to win.
      <br />
      <HowToPlaySeparator />
      <br />
      <img
        className="emoji-image"
        src={getEmojiImage("statusMove")}
        alt="move"
      />{" "}
      Move your mons up to a total of 5 spaces.
      <br />
      <img
        className="emoji-image"
        src={getEmojiImage("statusAction")}
        alt="action"
      />{" "}
      Use one action: demon, spirit, or mystic.
      <br />
      <img
        className="emoji-image"
        src={getEmojiImage("statusMana")}
        alt="mana"
      />{" "}
      Use your one mana move to end your turn.
    </>
  );
};

interface InfoPopoverProps {
  id: string;
  isOpen: boolean;
}

export const InfoPopover = forwardRef<HTMLDivElement, InfoPopoverProps>(
  ({ id, isOpen }, ref) => (
    <StyledInfoPopover
      ref={ref}
      id={id}
      $isOpen={isOpen}
      role="dialog"
      aria-label="How to play"
      aria-hidden={!isOpen}
      tabIndex={-1}
    >
      <HowToPlayContent />
    </StyledInfoPopover>
  ),
);

InfoPopover.displayName = "InfoPopover";
