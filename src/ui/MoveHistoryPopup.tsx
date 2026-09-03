import React from "react";
import styled from "styled-components";
import { FaSyncAlt } from "react-icons/fa";
import {
  getVerboseTrackingEntities,
  didSelectVerboseTrackingEntity,
  didOpenMoveHistoryPopup,
  didDismissMoveHistoryPopup,
  getFenForMoveHistoryIndex,
  didToggleMoveHistoryBoardFlip,
} from "../game/gameController";
import { useGameAssets } from "../hooks/useGameAssets";
import { useEmojis } from "../hooks/useEmojis";
import type {
  MoveHistoryEntry,
  MoveHistorySegment,
  MoveHistoryToken,
  MoveHistorySegmentRole,
} from "../game/moveEventStrings";
import { colors } from "../content/boardStyles";
import {
  getMoveHistoryPopupFollowingLatest,
  setMoveHistoryPopupFollowingLatest,
  setMoveHistoryPopupState,
  subscribeMoveHistoryPopupReload,
  subscribeMoveHistoryPopupSelectionReset,
} from "./controls/moveHistoryPopupStore";

export {
  isMoveHistoryPopupFollowingLatest,
  subscribeMoveHistoryPopupReload,
  triggerMoveHistoryPopupReload,
  triggerMoveHistoryPopupSelectionReset,
} from "./controls/moveHistoryPopupStore";

const ITEM_HEIGHT = 24;
const VISIBLE_ITEMS = 7;
const PADDING_ITEMS = Math.floor(VISIBLE_ITEMS / 2);
const PICKER_HEIGHT = ITEM_HEIGHT * VISIBLE_ITEMS;
const PLACEHOLDER_LABEL = "";
const PADDING_INDICES = Array.from(
  { length: PADDING_ITEMS },
  (_, index) => index,
);

const MoveHistoryPopupContainer = styled.div`
  position: fixed;
  bottom: calc(
    max(50px, calc(env(safe-area-inset-bottom) + 44px)) +
      var(--bottom-controls-offset, 0px)
  );
  right: 8px;
  width: 150px;
  height: ${PICKER_HEIGHT}px;
  display: flex;
  flex-direction: column;
  background-color: var(--panel-light-90);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 7pt;
  z-index: 7;
  overflow: hidden;

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

const WheelContainer = styled.div`
  position: relative;
  height: 100%;
  overflow: hidden;
`;

const TopActions = styled.div`
  position: absolute;
  top: 23px;
  left: 8px;
  right: 8px;
  display: flex;
  justify-content: center;
  z-index: 3;
  pointer-events: none;
`;

const TopActionButton = styled.button`
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.12);
  color: var(--color-gray-33);
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1;
  font-weight: 600;
  transition: background-color 0.15s ease;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: rgba(0, 0, 0, 0.18);
  }

  &:active {
    background: rgba(0, 0, 0, 0.18);
  }

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.18);
    color: var(--color-gray-f0);

    &:hover {
      background: rgba(255, 255, 255, 0.24);
    }
  }
`;

const TopActionIcon = styled(FaSyncAlt)`
  font-size: 8px;
  display: block;
  align-self: center;
`;

const TopActionLabel = styled.span`
  display: block;
  line-height: 1;
`;

const SelectionIndicator = styled.div`
  position: absolute;
  top: 50%;
  left: 8px;
  right: 8px;
  height: ${ITEM_HEIGHT}px;
  transform: translateY(-50%);
  background-color: rgba(120, 120, 128, 0.12);
  border-radius: 6px;
  pointer-events: none;
  z-index: 1;

  @media (prefers-color-scheme: dark) {
    background-color: rgba(120, 120, 128, 0.24);
  }
`;

const ScrollWheel = styled.div`
  height: 100%;
  overflow-y: scroll;
  scroll-snap-type: y mandatory;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;
  overscroll-behavior: contain;
  touch-action: pan-y;

  &::-webkit-scrollbar {
    display: none;
  }
`;

const WheelItem = styled.div<{
  $isSelected: boolean;
  $distance: number;
  $isPlaceholder?: boolean;
}>`
  height: ${ITEM_HEIGHT}px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  position: relative;
  min-width: 0;
  scroll-snap-align: ${(props) => (props.$isPlaceholder ? "none" : "center")};
  font-size: 12px;
  padding: 0 10px;
  cursor: ${(props) => (props.$isPlaceholder ? "default" : "pointer")};
  pointer-events: ${(props) => (props.$isPlaceholder ? "none" : "auto")};
  user-select: none;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
  color: var(--color-gray-33);
  opacity: ${(props) => {
    let opacity = 0.15;
    if (props.$isSelected) opacity = 1;
    else if (props.$distance === 1) opacity = 0.7;
    else if (props.$distance === 2) opacity = 0.45;
    else if (props.$distance === 3) opacity = 0.25;
    return props.$isPlaceholder ? opacity * 0.85 : opacity;
  }};
  transform: ${(props) => {
    if (props.$isSelected) return "scale(1)";
    if (props.$distance === 1) return "scale(0.96)";
    if (props.$distance === 2) return "scale(0.92)";
    if (props.$distance === 3) return "scale(0.88)";
    return "scale(0.85)";
  }};
  font-weight: ${(props) => (props.$isSelected ? 500 : 400)};

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f0);
  }
`;

const ItemContent = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  width: 100%;
  pointer-events: none;
`;

const IndexLabel = styled.span`
  flex-shrink: 0;
  min-width: 20px;
  text-align: right;
`;

const EventRow = styled.div`
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  overflow: visible;
  white-space: nowrap;
`;

const EventSegment = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
`;

const EventIcon = styled.img`
  width: 21px;
  height: 21px;
  flex-shrink: 0;
  -webkit-user-drag: none;
  user-drag: none;
`;

const EmojiIcon = styled.img`
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  margin-left: -2px;
  margin-right: -2px;
  -webkit-user-drag: none;
  user-drag: none;
`;

const ActionEmojiIcon = styled(EmojiIcon)`
  margin-left: 1px;
  margin-right: 1px;
`;

const SquareIcon = styled.svg`
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  margin-left: 1px;
  margin-right: 1px;
`;

const CompositeIcon = styled.span`
  position: relative;
  width: 21px;
  height: 21px;
  flex-shrink: 0;
  overflow: visible;
`;

const CompositeBase = styled.img`
  width: 100%;
  height: 100%;
  display: block;
  -webkit-user-drag: none;
  user-drag: none;
`;

const CompositeOverlay = styled.img`
  position: absolute;
  width: var(--overlay-size, 80%);
  height: var(--overlay-size, 80%);
  left: var(--overlay-left, 30%);
  top: var(--overlay-top, 20%);
  -webkit-user-drag: none;
  user-drag: none;
`;

const EventText = styled.span`
  display: inline-flex;
  align-items: center;
  line-height: 1;
`;

const MoveHistoryPopup = React.forwardRef<HTMLDivElement>((_, ref) => {
  const { assets } = useGameAssets();
  const { emojis } = useEmojis();
  const [version, setVersion] = React.useState(0);
  const items = React.useMemo<MoveHistoryEntry[]>(() => {
    void version;
    try {
      return getVerboseTrackingEntities();
    } catch {
      return [{ segments: [] }];
    }
  }, [version]);
  const [selectedIndex, setSelectedIndex] = React.useState(items.length - 1);
  const selectedIndexRef = React.useRef(selectedIndex);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const isDraggingRef = React.useRef(false);
  const startYRef = React.useRef(0);
  const startScrollTopRef = React.useRef(0);
  const pendingScrollIndexRef = React.useRef<number | null>(items.length - 1);
  const [isAtTop, setIsAtTop] = React.useState(false);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    if (pendingScrollIndexRef.current !== null) {
      const target = pendingScrollIndexRef.current;
      pendingScrollIndexRef.current = null;
      el.scrollTop = target * ITEM_HEIGHT;
    }
    const atTop = el.scrollTop <= 1;
    setIsAtTop((prev) => (prev === atTop ? prev : atTop));
  }, [items.length, selectedIndex, version]);

  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el || items.length === 0) return;
    const atTop = el.scrollTop <= 1;
    setIsAtTop((prev) => (prev === atTop ? prev : atTop));
    const newIndex = Math.round(el.scrollTop / ITEM_HEIGHT);
    const clamped = Math.max(0, Math.min(items.length - 1, newIndex));
    if (clamped !== selectedIndexRef.current) {
      selectedIndexRef.current = clamped;
      setMoveHistoryPopupFollowingLatest(clamped >= items.length - 1);
      setSelectedIndex(clamped);
      setSnapshotIndex(null);
      didSelectVerboseTrackingEntity(clamped);
    }
  }, [items.length]);

  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    isDraggingRef.current = true;
    startYRef.current = e.clientY;
    startScrollTopRef.current = scrollRef.current?.scrollTop || 0;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }, []);

  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !scrollRef.current) return;
      const deltaY = startYRef.current - e.clientY;
      scrollRef.current.scrollTop = startScrollTopRef.current + deltaY;
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const lastClickTimeRef = React.useRef(0);
  const clickCountRef = React.useRef(0);
  const lastClickedIndexRef = React.useRef(-1);
  const [snapshotIndex, setSnapshotIndex] = React.useState<number | null>(null);

  const handleSnapshotOpen = React.useCallback(
    (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      const fen = getFenForMoveHistoryIndex(index);
      if (fen) {
        const link =
          window.location.origin + "/snapshot/" + encodeURIComponent(fen);
        window.open(link, "_blank", "noopener,noreferrer");
      }
      setSnapshotIndex(null);
    },
    [],
  );

  const handleFlipBoard = React.useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      didToggleMoveHistoryBoardFlip(selectedIndexRef.current);
    },
    [],
  );

  const handleItemClick = React.useCallback(
    (index: number) => {
      if (isDraggingRef.current) return;

      if (snapshotIndex !== null) {
        setSnapshotIndex(null);
        return;
      }

      const now = Date.now();
      if (
        index === lastClickedIndexRef.current &&
        now - lastClickTimeRef.current < 500
      ) {
        clickCountRef.current += 1;
      } else {
        clickCountRef.current = 1;
      }
      lastClickTimeRef.current = now;
      lastClickedIndexRef.current = index;

      if (clickCountRef.current >= 2) {
        clickCountRef.current = 0;
        setSnapshotIndex(index);
        return;
      }

      selectedIndexRef.current = index;
      setMoveHistoryPopupFollowingLatest(index >= items.length - 1);
      setSelectedIndex(index);
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = index * ITEM_HEIGHT;
      }
      didSelectVerboseTrackingEntity(index);
    },
    [items.length, snapshotIndex],
  );

  React.useEffect(() => {
    setMoveHistoryPopupState(true, true);
    try {
      didOpenMoveHistoryPopup();
    } catch {}

    const unsubscribe = subscribeMoveHistoryPopupReload(() => {
      let newItems: MoveHistoryEntry[];
      try {
        newItems = getVerboseTrackingEntities();
      } catch {
        newItems = [{ segments: [] }];
      }
      const newLatest = Math.max(0, newItems.length - 1);
      const currentSel = selectedIndexRef.current;
      const wasFollowing = getMoveHistoryPopupFollowingLatest();

      let newSelection: number;
      if (wasFollowing || currentSel >= newLatest) {
        newSelection = newLatest;
        setMoveHistoryPopupFollowingLatest(true);
      } else {
        newSelection = Math.min(currentSel, newLatest);
        setMoveHistoryPopupFollowingLatest(newSelection >= newLatest);
      }

      selectedIndexRef.current = newSelection;
      pendingScrollIndexRef.current = newSelection;
      setSelectedIndex(newSelection);
      setSnapshotIndex(null);
      setVersion((v) => v + 1);

      if (getMoveHistoryPopupFollowingLatest() && !wasFollowing) {
        queueMicrotask(() => didSelectVerboseTrackingEntity(newSelection));
      }
    });

    const unsubscribeSelectionReset = subscribeMoveHistoryPopupSelectionReset(
      () => {
        let newItems: MoveHistoryEntry[];
        try {
          newItems = getVerboseTrackingEntities();
        } catch {
          newItems = [{ segments: [] }];
        }
        const newLatest = Math.max(0, newItems.length - 1);
        setMoveHistoryPopupFollowingLatest(true);
        selectedIndexRef.current = newLatest;
        pendingScrollIndexRef.current = newLatest;
        setSelectedIndex(newLatest);
        setVersion((v) => v + 1);
      },
    );

    return () => {
      unsubscribe();
      unsubscribeSelectionReset();
      setMoveHistoryPopupState(false, false);
      try {
        didDismissMoveHistoryPopup();
      } catch {}
    };
  }, []);

  const getDistance = (index: number) => Math.abs(index - selectedIndex);

  const getIconImage = React.useCallback(
    (iconName: string) => {
      if (!assets || !assets[iconName]) {
        return "data:image/svg+xml,%3Csvg width='20' height='20' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='10' cy='10' r='8' fill='%23cccccc' fill-opacity='0.5'/%3E%3C/svg%3E";
      }
      return `data:image/png;base64,${assets[iconName]}`;
    },
    [assets],
  );

  const renderToken = React.useCallback(
    (
      token: MoveHistoryToken,
      tokenIndex: number,
      segmentRole?: MoveHistorySegmentRole,
    ) => {
      if (token.type === "icon") {
        const isRegularManaIcon =
          token.icon === "mana" || token.icon === "manaB";
        const iconStyle = isRegularManaIcon
          ? ({
              marginLeft: segmentRole === "destination" ? "-4px" : "-2px",
              marginRight: segmentRole === "destination" ? "-4px" : "-2px",
            } as React.CSSProperties)
          : undefined;
        return (
          <EventIcon
            key={`icon-${tokenIndex}`}
            src={getIconImage(token.icon)}
            alt={token.alt}
            style={iconStyle}
          />
        );
      }
      if (token.type === "emoji") {
        const src = emojis?.[token.emoji]
          ? `data:image/png;base64,${emojis[token.emoji]}`
          : "data:image/svg+xml,%3Csvg width='20' height='20' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='10' cy='10' r='8' fill='%23cccccc' fill-opacity='0.5'/%3E%3C/svg%3E";
        const EmojiComponent =
          token.emoji === "statusAction" || token.emoji === "statusPotion"
            ? ActionEmojiIcon
            : EmojiIcon;
        return (
          <EmojiComponent
            key={`emoji-${tokenIndex}`}
            src={src}
            alt={token.alt}
          />
        );
      }
      if (token.type === "square") {
        return (
          <SquareIcon
            key={`square-${tokenIndex}`}
            viewBox="0 0 12 12"
            aria-label={token.alt}
          >
            <rect
              x="0"
              y="0"
              width="12"
              height="12"
              fill={token.color}
              rx="1"
              ry="1"
            />
          </SquareIcon>
        );
      }
      if (token.type === "composite") {
        const overlayStyle =
          token.variant === "supermana"
            ? ({
                "--overlay-left": "14%",
                "--overlay-top": "-11%",
                "--overlay-size": "72%",
              } as React.CSSProperties)
            : token.variant === "bomb"
              ? ({
                  "--overlay-left": "54%",
                  "--overlay-top": "52%",
                  "--overlay-size": "50%",
                } as React.CSSProperties)
              : ({
                  "--overlay-left": "35%",
                  "--overlay-top": "27%",
                  "--overlay-size": "93%",
                } as React.CSSProperties);
        return (
          <CompositeIcon
            key={`composite-${tokenIndex}`}
            style={overlayStyle}
            aria-label={token.alt}
          >
            <CompositeBase src={getIconImage(token.baseIcon)} alt={token.alt} />
            <CompositeOverlay
              src={getIconImage(token.overlayIcon)}
              alt={token.overlayAlt}
            />
          </CompositeIcon>
        );
      }
      return <EventText key={`text-${tokenIndex}`}>{token.text}</EventText>;
    },
    [getIconImage, emojis],
  );

  const renderSegment = React.useCallback(
    (
      segment: MoveHistorySegment,
      segmentIndex: number,
      role?: MoveHistorySegmentRole,
    ) => (
      <EventSegment key={`segment-${segmentIndex}`}>
        {segment.map((token, tokenIndex) =>
          renderToken(token, tokenIndex, role),
        )}
      </EventSegment>
    ),
    [renderToken],
  );

  return (
    <MoveHistoryPopupContainer ref={ref}>
      <WheelContainer>
        {isAtTop && (
          <TopActions>
            <TopActionButton type="button" onClick={handleFlipBoard}>
              <TopActionIcon aria-hidden="true" />
              <TopActionLabel>Flip Board</TopActionLabel>
            </TopActionButton>
          </TopActions>
        )}
        <SelectionIndicator />
        <ScrollWheel
          ref={scrollRef}
          onScroll={handleScroll}
          onMouseDown={handleMouseDown}
        >
          {PADDING_INDICES.map((offset) => {
            const virtualIndex = offset - PADDING_ITEMS;
            return (
              <WheelItem
                key={`placeholder-top-${offset}`}
                $isSelected={false}
                $distance={getDistance(virtualIndex)}
                $isPlaceholder
                aria-hidden="true"
              >
                {PLACEHOLDER_LABEL}
              </WheelItem>
            );
          })}
          {items.map((entry, index) => (
            <WheelItem
              key={index}
              $isSelected={index === selectedIndex}
              $distance={getDistance(index)}
              onClick={() => handleItemClick(index)}
            >
              {snapshotIndex === index ? (
                <ItemContent
                  style={{
                    justifyContent: "center",
                    pointerEvents: "auto",
                    cursor: "pointer",
                  }}
                  onClick={(e) => handleSnapshotOpen(e, index)}
                >
                  <EventText style={{ fontSize: 11, opacity: 0.85 }}>
                    Open in new tab
                  </EventText>
                </ItemContent>
              ) : (
                <ItemContent>
                  <IndexLabel>{index}.</IndexLabel>
                  <EventRow>
                    {entry.segments.length > 0 ? (
                      entry.segments.map((segment, segmentIndex) =>
                        renderSegment(
                          segment,
                          segmentIndex,
                          entry.segmentRoles?.[segmentIndex],
                        ),
                      )
                    ) : index === 0 ? (
                      <SquareIcon viewBox="0 0 12 12" aria-label="score">
                        <rect
                          x="0"
                          y="0"
                          width="12"
                          height="12"
                          fill={colors.manaPool}
                          rx="1"
                          ry="1"
                        />
                      </SquareIcon>
                    ) : (
                      <EventText>{PLACEHOLDER_LABEL}</EventText>
                    )}
                  </EventRow>
                </ItemContent>
              )}
            </WheelItem>
          ))}
          {PADDING_INDICES.map((offset) => {
            const virtualIndex = items.length + offset;
            return (
              <WheelItem
                key={`placeholder-bottom-${offset}`}
                $isSelected={false}
                $distance={getDistance(virtualIndex)}
                $isPlaceholder
                aria-hidden="true"
              >
                {PLACEHOLDER_LABEL}
              </WheelItem>
            );
          })}
        </ScrollWheel>
      </WheelContainer>
    </MoveHistoryPopupContainer>
  );
});

MoveHistoryPopup.displayName = "MoveHistoryPopup";

export default MoveHistoryPopup;
