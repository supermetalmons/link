import { useCallback } from "react";
import { STICKER_ID_WHITELIST } from "@mons/shared/reactions";
import { connection } from "../../connection/connection";
import type { Reaction } from "../../connection/connectionModels";
import {
  newReactionOfKind,
  newStickerReaction,
  playReaction,
  playSounds,
} from "../../content/sounds";
import { getGameControlsSnapshot } from "../../game/gameControlsStore";
import { Sound } from "../../utils/gameModels";
import {
  isMetadataSideDisplayedAtOpponentSlot,
  showVideoReaction,
  showVoiceReactionText,
} from "./boardReactionPort";

type ReactionActionsOptions = {
  isVisible: boolean;
  canSendSticker: (stickerId: number) => boolean;
  dismissPicker: () => void;
  setDisabled: (disabled: boolean) => void;
  setMatchScopedTimeout: (callback: () => void, delay: number) => number;
};

export const useReactionActions = ({
  isVisible,
  canSendSticker,
  dismissPicker,
  setDisabled,
  setMatchScopedTimeout,
}: ReactionActionsOptions) => {
  const completeReaction = useCallback(
    (
      createNetworkReaction: () => Reaction,
      createBotReply: () => () => void,
      botReplyDelayMs: number,
    ) => {
      if (getGameControlsSnapshot().context.isGameWithBot) {
        const sessionGuard = connection.createSessionGuard();
        const reply = createBotReply();
        setMatchScopedTimeout(() => {
          if (!sessionGuard()) {
            return;
          }
          reply();
        }, botReplyDelayMs);
      } else if (!getGameControlsSnapshot().context.puzzleMode) {
        connection.sendVoiceReaction(createNetworkReaction());
        setDisabled(true);
        setMatchScopedTimeout(() => {
          setDisabled(false);
        }, 9999);
      }
    },
    [setDisabled, setMatchScopedTimeout],
  );

  const handleStickerSelect = useCallback(
    (stickerId: number) => {
      if (!isVisible) {
        dismissPicker();
        return;
      }
      if (!canSendSticker(stickerId)) {
        dismissPicker();
        return;
      }
      dismissPicker();
      showVideoReaction(
        isMetadataSideDisplayedAtOpponentSlot(false),
        stickerId,
      );
      playSounds([Sound.EmoteSent]);
      completeReaction(
        () => newStickerReaction(stickerId),
        () => {
          const responseStickerId =
            STICKER_ID_WHITELIST[
              Math.floor(Math.random() * STICKER_ID_WHITELIST.length)
            ];
          return () => {
            showVideoReaction(
              isMetadataSideDisplayedAtOpponentSlot(true),
              responseStickerId,
            );
            playSounds([Sound.EmoteReceived]);
          };
        },
        5000,
      );
    },
    [canSendSticker, completeReaction, dismissPicker, isVisible],
  );

  const handleReactionSelect = useCallback(
    (reaction: string) => {
      if (!isVisible) {
        dismissPicker();
        return;
      }
      dismissPicker();
      const reactionObj = newReactionOfKind(reaction);
      playReaction(reactionObj);
      showVoiceReactionText(reaction, false);
      completeReaction(
        () => reactionObj,
        () => {
          const responseReactionObj = newReactionOfKind(reaction);
          return () => {
            playReaction(responseReactionObj);
            showVoiceReactionText(reaction, true);
          };
        },
        2000,
      );
    },
    [completeReaction, dismissPicker, isVisible],
  );

  return { handleStickerSelect, handleReactionSelect };
};
