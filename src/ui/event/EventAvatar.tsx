import React from "react";
import { emojis } from "../../content/emojis";
import { Avatar, AvatarFallback } from "./EventModal.styles";

export const EventAvatar: React.FC<{
  emojiId?: number | null;
  displayName?: string | null;
  size?: number;
  isBlocked?: boolean;
}> = ({ emojiId, displayName, size, isBlocked }) => {
  if (isBlocked) {
    return (
      <AvatarFallback $size={size} aria-hidden="true">
        ∅
      </AvatarFallback>
    );
  }
  if (typeof emojiId === "number" && Number.isFinite(emojiId)) {
    return (
      <Avatar
        $size={size}
        src={emojis.getEmojiUrl(emojiId.toString())}
        alt={displayName ?? ""}
      />
    );
  }
  return (
    <AvatarFallback $size={size} aria-hidden="true">
      ?
    </AvatarFallback>
  );
};
