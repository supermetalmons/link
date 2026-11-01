import type { MouseEvent } from "react";
import type {
  NavigationEventItem,
  NavigationGameItem,
  NavigationGameStatus,
} from "../../connection/connectionModels";
import type { Problem } from "../../content/problems";
import { emojis } from "../../content/emojis";
import {
  CompletedIcon,
  EventAvatarImage,
  EventAvatarQuestionIcon,
  EventAvatarQuestionSlot,
  EventPreviewGroup,
  EventRow,
  EventTrailingContent,
  FightCloudBadge,
  FightCloudCanvas,
  FightCloudInner,
  FightCloudWrap,
  CloudShape,
  GameEmojiImage,
  GameEmojiPlaceholder,
  GameRemoveButton,
  GameRow,
  GameRowContainer,
  GameStatus,
  GameText,
  IncompleteIcon,
  LiveDot,
  NavigationPickerButton,
  PlaceholderImage,
  QueueManaCluster,
  QueueManaIcon,
  QueuePrimaryContent,
  type QueueManaSlot,
} from "./NavigationPicker.styles";
import {
  deriveEventPreview,
  getEventStatusLabel,
  getGameStatusLabel,
} from "./navigationPickerModel";

const QUEUE_MANA_SLOTS: QueueManaSlot[] = ["top", "right", "bottom", "left"];

function buildFightCloudPath(w: number, h: number): string {
  const parts: string[] = [];
  const insetX = 2.2;
  const insetY = 3.8;
  const left = insetX;
  const right = w - insetX;
  const top = insetY;
  const bottom = h - insetY;
  const midY = h / 2;
  const sideInset = Math.min(6.2, Math.max(4.6, w * 0.11));
  const topStartX = left + sideInset;
  const topEndX = right - sideInset;
  const topPuffCount = Math.max(
    3,
    Math.min(5, Math.round((topEndX - topStartX) / 21)),
  );
  const topStep = (topEndX - topStartX) / topPuffCount;
  const topAmp = Math.min(4.6, Math.max(3.3, (bottom - top) * 0.22));
  const bottomAmp = Math.min(4.2, Math.max(3.0, (bottom - top) * 0.2));
  const sideAmp = Math.min(3.6, Math.max(2.8, w * 0.045));
  const sidePeakOffsetY = (bottom - top) * 0.09;

  const startY = top + 0.45;
  parts.push(`M${topStartX.toFixed(1)},${startY.toFixed(1)}`);

  for (let i = 0; i < topPuffCount; i++) {
    const nextX = topStartX + (i + 1) * topStep;
    const peakX =
      topStartX +
      i * topStep +
      topStep * (0.5 + Math.sin(i * 1.17 + 0.45) * 0.06);
    const peakY = top - topAmp * (0.92 + Math.cos(i * 0.93 - 0.4) * 0.12);
    const valleyY = top + 0.4 + Math.sin((i + 1) * 1.21 + 0.3) * 0.28;

    parts.push(
      `Q${peakX.toFixed(1)},${peakY.toFixed(1)},${nextX.toFixed(1)},${valleyY.toFixed(1)}`,
    );
  }

  parts.push(
    `Q${(right + sideAmp).toFixed(1)},${(midY - sidePeakOffsetY).toFixed(1)},${(topEndX - 0.1).toFixed(1)},${(bottom - 0.45).toFixed(1)}`,
  );

  for (let i = 0; i < topPuffCount; i++) {
    const nextX = topEndX - (i + 1) * topStep;
    const peakX =
      topEndX - i * topStep - topStep * (0.5 + Math.sin(i * 1.11 + 0.8) * 0.06);
    const peakY = bottom + bottomAmp * (0.9 + Math.cos(i * 0.98 + 0.2) * 0.12);
    const valleyY = bottom - 0.42 - Math.sin((i + 1) * 1.17 + 0.55) * 0.26;

    parts.push(
      `Q${peakX.toFixed(1)},${peakY.toFixed(1)},${nextX.toFixed(1)},${valleyY.toFixed(1)}`,
    );
  }

  parts.push(
    `Q${(left - sideAmp).toFixed(1)},${(midY + sidePeakOffsetY).toFixed(1)},${topStartX.toFixed(1)},${startY.toFixed(1)}`,
  );
  parts.push("Z");
  return parts.join("");
}

const fightCloudCache = new Map<string, string>();
function getFightCloudPath(w: number, h: number) {
  const k = `${w}|${h}`;
  let v = fightCloudCache.get(k);
  if (!v) {
    v = buildFightCloudPath(w, h);
    fightCloudCache.set(k, v);
  }
  return v;
}

const FIGHT_CLOUD_BASE_W = 160;
const FIGHT_CLOUD_H = 28;

const getQueuePrimaryLabel = (game: NavigationGameItem): string => {
  if (game.status === "pending") {
    return "Automatching";
  }
  return "Waiting for opponent";
};

type NavigationGameRowProps = {
  game: NavigationGameItem;
  isSelected: boolean;
  isRemoving: boolean;
  queueManaImage: string;
  onSelectGame?: (
    game: NavigationGameItem,
    options: { status: NavigationGameStatus },
  ) => void;
  onRemoveGame?: (inviteId: string) => void;
};

export function NavigationGameRow({
  game,
  isSelected,
  isRemoving,
  queueManaImage,
  onSelectGame,
  onRemoveGame,
}: NavigationGameRowProps) {
  const isQueueStatus = game.status === "waiting" || game.status === "pending";
  const canRemove = game.status === "waiting" && !!onRemoveGame;
  const handleRemoveClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isRemoving) {
      onRemoveGame?.(game.inviteId);
    }
  };
  return (
    <GameRowContainer>
      <GameRow
        $isSelected={isSelected}
        $hasTrailingAction={canRemove}
        data-navigation-active={isSelected ? "true" : undefined}
        data-navigation-selected={isSelected ? "true" : undefined}
        data-navigation-selected-primary={isSelected ? "true" : undefined}
        onClick={() => onSelectGame?.(game, { status: game.status })}
      >
        {isQueueStatus ? (
          <>
            <QueueManaCluster aria-hidden="true">
              {QUEUE_MANA_SLOTS.map((slot) => (
                <QueueManaIcon
                  key={slot}
                  $slot={slot}
                  src={queueManaImage}
                  alt=""
                />
              ))}
            </QueueManaCluster>
            <QueuePrimaryContent>
              {getQueuePrimaryLabel(game)}
            </QueuePrimaryContent>
            {game.status === "pending" ? <GameStatus>NOW</GameStatus> : null}
          </>
        ) : (
          <>
            {typeof game.opponentEmoji === "number" ? (
              <GameEmojiImage
                src={emojis.getEmojiUrl(game.opponentEmoji)}
                alt=""
              />
            ) : (
              <GameEmojiPlaceholder />
            )}
            <GameText>
              {game.opponentName && game.opponentName !== ""
                ? game.opponentName
                : "anon"}
            </GameText>
            {game.status === "active" ? (
              <LiveDot />
            ) : (
              <GameStatus $isSelected={isSelected}>
                {getGameStatusLabel(game)}
              </GameStatus>
            )}
          </>
        )}
      </GameRow>
      {canRemove && (
        <GameRemoveButton
          type="button"
          aria-label="Remove waiting game"
          $isDisabled={isRemoving}
          disabled={isRemoving}
          onClick={handleRemoveClick}
        />
      )}
    </GameRowContainer>
  );
}

type NavigationEventRowProps = {
  event: NavigationEventItem;
  isActive: boolean;
  onSelectGame?: (event: NavigationEventItem, options?: undefined) => void;
};

export function NavigationEventRow({
  event,
  isActive,
  onSelectGame,
}: NavigationEventRowProps) {
  const { emojiIds, showUnknownOpponent, overflowCount } =
    deriveEventPreview(event);
  const hasPreviewContent =
    emojiIds.length > 0 || showUnknownOpponent || overflowCount !== null;
  const cloud = getFightCloudPath(FIGHT_CLOUD_BASE_W, FIGHT_CLOUD_H);
  return (
    <GameRowContainer>
      <EventRow
        $isSelected={false}
        $hasTrailingAction={false}
        data-navigation-active={isActive ? "true" : undefined}
        onClick={() => onSelectGame?.(event, undefined)}
      >
        <FightCloudWrap>
          <FightCloudCanvas
            width={FIGHT_CLOUD_BASE_W}
            height={FIGHT_CLOUD_H}
            viewBox={`0 0 ${FIGHT_CLOUD_BASE_W} ${FIGHT_CLOUD_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <CloudShape d={cloud} />
          </FightCloudCanvas>
          <FightCloudInner>
            {hasPreviewContent && (
              <EventPreviewGroup>
                {emojiIds.map((emojiId, index) => (
                  <EventAvatarImage
                    key={`slot_${index}`}
                    src={emojis.getEmojiUrl(emojiId)}
                    alt=""
                  />
                ))}
                {showUnknownOpponent && (
                  <EventAvatarQuestionSlot aria-hidden="true">
                    <EventAvatarQuestionIcon />
                  </EventAvatarQuestionSlot>
                )}
              </EventPreviewGroup>
            )}
          </FightCloudInner>
        </FightCloudWrap>
        <EventTrailingContent>
          {overflowCount !== null && (
            <FightCloudBadge>+{overflowCount}</FightCloudBadge>
          )}
          {event.status === "active" ? (
            <LiveDot />
          ) : (
            <GameStatus
              $isSelected={false}
              $highlightSelected={event.status === "waiting"}
            >
              {getEventStatusLabel(event)}
            </GameStatus>
          )}
        </EventTrailingContent>
      </EventRow>
    </GameRowContainer>
  );
}

type NavigationProblemRowProps = {
  problem: Pick<Problem, "id" | "label">;
  isSelected: boolean;
  isPrimarySelection: boolean;
  isCompleted: boolean;
  iconImage: string;
  onSelectProblem: (problemId: string) => void;
};

export function NavigationProblemRow({
  problem,
  isSelected,
  isPrimarySelection,
  isCompleted,
  iconImage,
  onSelectProblem,
}: NavigationProblemRowProps) {
  return (
    <NavigationPickerButton
      $isSelected={isSelected}
      data-navigation-selected={isSelected ? "true" : undefined}
      data-navigation-selected-primary={isPrimarySelection ? "true" : undefined}
      onClick={() => onSelectProblem(problem.id)}
    >
      <PlaceholderImage src={iconImage} alt="" />
      {problem.label}
      {isCompleted ? <CompletedIcon /> : <IncompleteIcon />}
    </NavigationPickerButton>
  );
}
