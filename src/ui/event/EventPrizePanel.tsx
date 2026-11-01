import React, { useId } from "react";
import type { EventPrizeDefinition } from "@mons/shared/event-prizes";
import type {
  EventParticipant,
  EventPrizeAssignment,
  EventPrizeId,
  EventRecord,
} from "../../connection/connectionModels";
import { EventAvatar } from "./EventAvatar";
import {
  MysteryPrizeSparkles,
  PrizeChoice,
  PrizeChoiceButton,
  PrizeConcealmentFilters,
  PrizeImage,
  PrizeSelectionAvatarMotion,
  PrizeSelectionAvatarSlot,
  PrizeSelectionAvatars,
  PrizesRow,
} from "./EventModal.styles";
import {
  PRIZE_SELECTION_AVATAR_PX,
  type PrizeSelectionDensity,
} from "./eventLayout";
import {
  getParticipantDisplayName,
  getPrizeAvatarScatter,
} from "./eventPresentation";
import type { EventPrizeSelection } from "./useEventPrizeSelection";

type DisplayedEventPrize = {
  prize: EventPrizeDefinition;
  assignment: EventPrizeAssignment | null;
};

export type EventPrizePanelProps = {
  prizes: readonly DisplayedEventPrize[];
  participants: readonly EventParticipant[];
  participantsById: Readonly<Record<string, EventParticipant>>;
  currentProfileId: string;
  eventStatus: EventRecord["status"];
  concealed: boolean;
  canSelect: boolean;
  selection: Pick<
    EventPrizeSelection,
    | "selections"
    | "isUpdating"
    | "loadedImageIds"
    | "markImageLoaded"
    | "registerAvatar"
  >;
  onSelect: (prizeId: EventPrizeId) => void;
  onParticipantClick: (participant: EventParticipant) => Promise<void>;
};

const getPrizeSelectionDensity = (
  avatarCount: number,
): PrizeSelectionDensity => {
  if (avatarCount <= 3) {
    return "relaxed";
  }
  if (avatarCount <= 6) {
    return "compact";
  }
  return "crowded";
};

export const EventPrizePanel: React.FC<EventPrizePanelProps> = ({
  prizes: displayedEventPrizes,
  participants,
  participantsById,
  currentProfileId,
  eventStatus,
  concealed: areEventPrizesConcealed,
  canSelect: canSelectEventPrize,
  selection,
  onSelect: handlePrizeSelectionClick,
  onParticipantClick: handleParticipantClick,
}) => {
  const concealmentFilterId = useId();
  const {
    selections: eventPrizeSelections,
    isUpdating: isUpdatingPrizeSelection,
    loadedImageIds: loadedPrizeImageIds,
    markImageLoaded: markPrizeImageLoaded,
    registerAvatar,
  } = selection;

  return (
    <PrizesRow
      role="group"
      aria-label="Event prizes"
      aria-busy={isUpdatingPrizeSelection ? "true" : undefined}
    >
      {areEventPrizesConcealed && (
        <PrizeConcealmentFilters aria-hidden="true" focusable="false">
          <defs>
            <filter
              id={concealmentFilterId}
              x="0"
              y="0"
              width="100%"
              height="100%"
              colorInterpolationFilters="sRGB"
            >
              <feFlood floodColor="currentColor" result="background" />
              <feComposite
                in="SourceGraphic"
                in2="background"
                operator="over"
              />
              <feGaussianBlur stdDeviation="23" />
              <feComponentTransfer>
                <feFuncA type="linear" slope="0" intercept="1" />
              </feComponentTransfer>
            </filter>
          </defs>
        </PrizeConcealmentFilters>
      )}
      {displayedEventPrizes.map(({ prize, assignment }, index) => {
        const selectedParticipants = participants.filter(
          (participant) =>
            eventPrizeSelections[participant.profileId] === prize.id,
        );
        const prizeSelectionDensity = getPrizeSelectionDensity(
          selectedParticipants.length,
        );
        const isSelected = eventPrizeSelections[currentProfileId] === prize.id;
        const selectionCountLabel = `${selectedParticipants.length} ${
          selectedParticipants.length === 1 ? "participant" : "participants"
        } selected`;
        const actionLabel = isSelected ? "Deselect" : "Select";
        const awardedParticipant = assignment
          ? participantsById[assignment.profileId]
          : null;
        const awardLabel = assignment
          ? ` Awarded to ${
              awardedParticipant
                ? getParticipantDisplayName(awardedParticipant)
                : assignment.profileId
            } for place ${assignment.place}.`
          : "";
        return (
          <PrizeChoice key={prize.id} $concealed={areEventPrizesConcealed}>
            <PrizeChoiceButton
              type="button"
              $concealed={areEventPrizesConcealed}
              $imageWidth={prize.imageWidth}
              $imageHeight={prize.imageHeight}
              disabled={!canSelectEventPrize}
              aria-pressed={areEventPrizesConcealed ? undefined : isSelected}
              aria-label={
                areEventPrizesConcealed
                  ? "Mystery prize. Reveals less than one hour before the event starts."
                  : `${
                      canSelectEventPrize
                        ? `${actionLabel} ${prize.alt}`
                        : prize.alt
                    }. ${selectionCountLabel}.${awardLabel}`
              }
              onClick={() => handlePrizeSelectionClick(prize.id)}
            >
              <PrizeImage
                $concealed={areEventPrizesConcealed}
                style={
                  areEventPrizesConcealed
                    ? { filter: `url("#${concealmentFilterId}")` }
                    : undefined
                }
                src={prize.imageUrl}
                alt={areEventPrizesConcealed ? "" : prize.alt}
                width={prize.imageWidth}
                height={prize.imageHeight}
                draggable={false}
                onLoad={() => markPrizeImageLoaded(prize.id)}
              />
              {areEventPrizesConcealed && (
                <MysteryPrizeSparkles $index={index} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </MysteryPrizeSparkles>
              )}
            </PrizeChoiceButton>
            {!areEventPrizesConcealed &&
              eventStatus !== "ended" &&
              loadedPrizeImageIds.has(prize.id) &&
              selectedParticipants.length > 0 && (
                <PrizeSelectionAvatars
                  $density={prizeSelectionDensity}
                  role="group"
                  aria-label={`Selected by ${selectedParticipants
                    .map(getParticipantDisplayName)
                    .join(", ")}`}
                >
                  {selectedParticipants.map((participant) => {
                    const scatter = getPrizeAvatarScatter(
                      prize.id,
                      participant.profileId,
                      prizeSelectionDensity,
                    );
                    return (
                      <PrizeSelectionAvatarSlot
                        key={participant.profileId}
                        type="button"
                        data-player-card-trigger="true"
                        $density={prizeSelectionDensity}
                        $offsetX={scatter.x}
                        $offsetY={scatter.y}
                        $layer={scatter.layer}
                        title={getParticipantDisplayName(participant)}
                        aria-label={`Open ${getParticipantDisplayName(participant)}`}
                        onClick={() => void handleParticipantClick(participant)}
                      >
                        <PrizeSelectionAvatarMotion
                          ref={(element) =>
                            registerAvatar(participant.profileId, element)
                          }
                        >
                          <EventAvatar
                            size={PRIZE_SELECTION_AVATAR_PX}
                            emojiId={participant.emojiId}
                            displayName={participant.displayName}
                          />
                        </PrizeSelectionAvatarMotion>
                      </PrizeSelectionAvatarSlot>
                    );
                  })}
                </PrizeSelectionAvatars>
              )}
          </PrizeChoice>
        );
      })}
    </PrizesRow>
  );
};
