import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styled, { keyframes } from "styled-components";
import { getEventPrizeDefinition } from "@mons/shared/event-prizes";
import { isValidSolanaAddress } from "@mons/shared/solana";
import type { EventPrizeAssignment } from "../connection/connectionModels";
import { AvatarImage } from "./AvatarImage";
import { BottomPillButton } from "./BottomControlsStyles";
import {
  SWAGPACK_ID_OFFSET,
  SWAGPACK_INVENTORY_IMAGE_BASE_URL,
  type InventoryApplicableItem,
  type InventoryPreviewItem,
} from "./inventoryItems";

const SPECIAL_ACTION_COPY: Readonly<
  Partial<Record<number, { action: string; current?: string }>>
> = {
  0: { action: "Pick Drainer" },
  1: { action: "Use card background", current: "Current Background" },
  2: { action: "Apply sticker", current: "Current Sticker" },
};

const previewBackdropEnter = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

const previewArtworkEnter = keyframes`
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
`;

const InventoryPreviewBackdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 90010;
  background: rgba(0, 0, 0, 0.01);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  outline: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  animation: ${previewBackdropEnter} 160ms ease-out both;

  @media (prefers-color-scheme: dark) {
    background: rgba(15, 15, 15, 0.11);
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const InventoryPreviewLayer = styled.div<{ $isCompact: boolean }>`
  position: fixed;
  inset: auto;
  z-index: 90011;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  pointer-events: none;
  cursor: pointer;
  outline: none;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;

  ${(props) =>
    props.$isCompact &&
    `
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 8px 20px;
    `}
`;

const PreviewArtwork = styled.div<{ $isCompact: boolean }>`
  position: relative;
  width: min(50dvh, 92dvw, 420px);
  aspect-ratio: 1 / 1;
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  animation: ${previewArtworkEnter} 180ms cubic-bezier(0.16, 1, 0.3, 1) both;

  ${(props) =>
    props.$isCompact &&
    `
      width: min(
        72dvw,
        260px,
        max(96px, calc(var(--inventory-preview-height) - 126px))
      );
      align-self: center;
      justify-self: center;
    `}

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const PreviewImage = styled.img`
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
`;

const PreviewActionRow = styled.div`
  position: fixed;
  left: 0;
  right: 0;
  bottom: max(14px, env(safe-area-inset-bottom));
  z-index: 90011;
  display: flex;
  justify-content: center;
  pointer-events: none;
`;

const PreviewActionHitbox = styled.div`
  padding: 20px;
  margin: -20px;
  pointer-events: auto;
  cursor: pointer;
`;

const PreviewActionButton = styled(BottomPillButton)`
  min-width: 150px;
  padding-right: 20px;
  padding-left: 20px;
  cursor: pointer;
`;

const PrizeWithdrawalControls = styled.div<{ $isCompact: boolean }>`
  position: absolute;
  left: 50%;
  bottom: max(14px, env(safe-area-inset-bottom));
  z-index: 90012;
  width: min(360px, calc(100dvw - 40px));
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  pointer-events: auto;
  cursor: default;

  ${(props) =>
    props.$isCompact &&
    `
      position: static;
      grid-row: 2;
      width: min(360px, 100%);
      transform: none;
      justify-self: center;
    `}
`;

const PrizeWithdrawalInput = styled.input`
  width: 100%;
  height: 38px;
  box-sizing: border-box;
  border: 1px solid #b8b8b8;
  border-radius: 5px;
  padding: 7px 10px;
  outline: none;
  box-shadow: none;
  background: #fff;
  color: #222;
  font: inherit;
  font-size: 0.82rem;
  text-align: left;
  -webkit-tap-highlight-color: transparent;

  @media (pointer: coarse), (max-width: 520px) {
    font-size: 16px;
  }

  &:focus,
  &:focus-visible {
    outline: none;
    box-shadow: none;
  }

  &:disabled {
    background: #eee;
    color: #777;
  }

  @media (prefers-color-scheme: dark) {
    border-color: #686868;
    background: #2f2f2f;
    color: #f5f5f5;

    &:disabled {
      background: #3a3a3a;
      color: #aaa;
    }
  }
`;

const PrizeWithdrawalError = styled.div`
  min-height: 14px;
  color: #d64a4a;
  font-size: 0.7rem;
  font-weight: 650;
  line-height: 14px;
  text-align: center;
`;

const PrizeWithdrawalButton = styled(PreviewActionButton)<{
  $status: "idle" | "sending" | "success";
}>`
  ${(props) =>
    props.$status === "success" &&
    `
      background-color: #47d14d;
      color: var(--color-white);
      cursor: default;

      @media (hover: hover) and (pointer: fine) {
        &:hover {
          background-color: #47d14d;
        }
      }

      &:active {
        background-color: #47d14d;
      }
    `}
`;

type PrizeWithdrawalStatus = "idle" | "sending" | "success";

interface PreviewViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

const getPreviewViewport = (): PreviewViewport => {
  if (typeof window === "undefined") {
    return { left: 0, top: 0, width: 1024, height: 768 };
  }
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: Math.max(1, viewport?.width ?? window.innerWidth),
    height: Math.max(1, viewport?.height ?? window.innerHeight),
  };
};

const getPrizeWithdrawalErrorMessage = (error: unknown): string => {
  const errorData =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : {};
  const code =
    typeof errorData.code === "string"
      ? errorData.code.replace(/^functions\//, "")
      : "";
  const message =
    typeof errorData.message === "string" ? errorData.message : "";
  if (code === "invalid-argument") {
    return message.includes("destination other than")
      ? "Choose a different destination address."
      : "Enter a valid Solana address.";
  }
  if (code === "not-found" || code === "permission-denied") {
    return "This prize is no longer available.";
  }
  if (code === "aborted") {
    return "Withdrawal is already being processed. Try again shortly.";
  }
  if (code === "failed-precondition") {
    return message.includes("original destination")
      ? "Retry with the original destination address."
      : "This prize cannot be withdrawn right now.";
  }
  return "Could not send the prize. Please try again.";
};

interface InventoryItemPreviewProps {
  item: InventoryPreviewItem;
  isCurrent: boolean;
  isAuthenticated: boolean;
  initialWithdrawalAddress: string;
  onApply: (item: InventoryApplicableItem) => boolean;
  onWithdraw: (prize: EventPrizeAssignment, address: string) => Promise<void>;
  onDismiss: (outsideTap: boolean) => void;
}

export const InventoryItemPreview: React.FC<InventoryItemPreviewProps> = ({
  item: previewItem,
  isCurrent: isPreviewItemCurrent,
  isAuthenticated,
  initialWithdrawalAddress,
  onApply,
  onWithdraw,
  onDismiss,
}) => {
  const [withdrawalAddress, setWithdrawalAddress] = useState(
    initialWithdrawalAddress,
  );
  const [isWithdrawalAddressVisible, setIsWithdrawalAddressVisible] =
    useState(false);
  const [withdrawalStatus, setWithdrawalStatus] =
    useState<PrizeWithdrawalStatus>("idle");
  const [withdrawalError, setWithdrawalError] = useState("");
  const [previewViewport, setPreviewViewport] =
    useState<PreviewViewport>(getPreviewViewport);
  const previewOverlayRef = useRef<HTMLDivElement>(null);
  const previewActionButtonRef = useRef<HTMLButtonElement>(null);
  const withdrawalControlsRef = useRef<HTMLDivElement>(null);
  const withdrawalInputRef = useRef<HTMLInputElement>(null);
  const withdrawalButtonRef = useRef<HTMLButtonElement>(null);
  const withdrawalInFlightRef = useRef(false);
  const withdrawalDismissTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const focusAnimationFrameRef = useRef<number | null>(null);
  const previewEventPrizeDefinition =
    previewItem.kind === "eventPrize"
      ? getEventPrizeDefinition(
          previewItem.prize.eventId,
          previewItem.prize.prizeId,
        )
      : null;
  const isPrizeWithdrawalLocked =
    withdrawalStatus === "sending" || withdrawalStatus === "success";
  const isCompactWithdrawalViewport =
    previewItem.kind === "eventPrize" &&
    isWithdrawalAddressVisible &&
    previewViewport.height < 560;

  useLayoutEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (focusAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(focusAnimationFrameRef.current);
      }
      if (withdrawalDismissTimeoutRef.current !== null) {
        window.clearTimeout(withdrawalDismissTimeoutRef.current);
      }
    };
  }, []);

  const previewActionCopy =
    previewItem.kind === "avatar"
      ? { action: "Set avatar" }
      : previewItem.kind === "special"
        ? SPECIAL_ACTION_COPY[previewItem.item.id]
        : undefined;
  const shouldShowPreviewAction =
    previewActionCopy !== undefined &&
    (!isPreviewItemCurrent || previewActionCopy.current !== undefined);
  const previewDialogLabel =
    previewItem.kind === "avatar"
      ? `Avatar ${previewItem.item.id + SWAGPACK_ID_OFFSET}`
      : previewItem.kind === "special"
        ? `Collectible ${previewItem.item.id}`
        : `Place ${previewItem.prize.place} event prize`;

  const dismissPreview = useCallback(
    (isOutsideTap = false, force = false) => {
      if (
        !isMountedRef.current ||
        ((isPrizeWithdrawalLocked || withdrawalInFlightRef.current) && !force)
      ) {
        return;
      }
      if (withdrawalDismissTimeoutRef.current !== null) {
        window.clearTimeout(withdrawalDismissTimeoutRef.current);
        withdrawalDismissTimeoutRef.current = null;
      }
      onDismiss(isOutsideTap);
    },
    [isPrizeWithdrawalLocked, onDismiss],
  );

  useLayoutEffect(() => {
    previewOverlayRef.current?.focus({ preventScroll: true });
  }, [previewItem]);

  useLayoutEffect(() => {
    const visualViewport = window.visualViewport;
    let animationFrameId: number | null = null;
    const updatePreviewViewport = () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        const next = getPreviewViewport();
        setPreviewViewport((current) =>
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width &&
          current.height === next.height
            ? current
            : next,
        );
      });
    };
    updatePreviewViewport();
    window.addEventListener("resize", updatePreviewViewport);
    visualViewport?.addEventListener("resize", updatePreviewViewport);
    visualViewport?.addEventListener("scroll", updatePreviewViewport);
    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      window.removeEventListener("resize", updatePreviewViewport);
      visualViewport?.removeEventListener("resize", updatePreviewViewport);
      visualViewport?.removeEventListener("scroll", updatePreviewViewport);
    };
  }, [previewItem]);

  useLayoutEffect(() => {
    if (
      !isWithdrawalAddressVisible ||
      previewItem.kind !== "eventPrize" ||
      isPrizeWithdrawalLocked
    ) {
      return;
    }
    withdrawalInputRef.current?.focus({ preventScroll: true });
  }, [isPrizeWithdrawalLocked, isWithdrawalAddressVisible, previewItem]);

  useEffect(() => {
    const handlePreviewEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (isPrizeWithdrawalLocked) {
        return;
      }
      dismissPreview();
    };
    document.addEventListener("keydown", handlePreviewEscape, true);
    return () => {
      document.removeEventListener("keydown", handlePreviewEscape, true);
    };
  }, [dismissPreview, isPrizeWithdrawalLocked]);

  const handleWithdrawEventPrize = async () => {
    if (
      previewItem.kind !== "eventPrize" ||
      previewEventPrizeDefinition?.claimAvailable !== true ||
      isPrizeWithdrawalLocked ||
      withdrawalInFlightRef.current ||
      !isAuthenticated
    ) {
      return;
    }
    if (!isWithdrawalAddressVisible) {
      setWithdrawalError("");
      setIsWithdrawalAddressVisible(true);
      return;
    }
    const recipientAddress = withdrawalAddress.trim();
    if (!isValidSolanaAddress(recipientAddress)) {
      setWithdrawalError("Enter a valid Solana address.");
      return;
    }
    const prize = previewItem.prize;
    withdrawalInFlightRef.current = true;
    setWithdrawalAddress(recipientAddress);
    setWithdrawalError("");
    setWithdrawalStatus("sending");
    try {
      await onWithdraw(prize, recipientAddress);
      if (!isMountedRef.current) {
        return;
      }
      setWithdrawalStatus("success");
      withdrawalDismissTimeoutRef.current = window.setTimeout(() => {
        withdrawalDismissTimeoutRef.current = null;
        dismissPreview(false, true);
      }, 1000);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      withdrawalInFlightRef.current = false;
      setWithdrawalStatus("idle");
      setWithdrawalError(getPrizeWithdrawalErrorMessage(error));
    }
  };

  const handlePreviewDismissClick = (
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    const target = event.target;
    if (
      target instanceof Node &&
      (previewActionButtonRef.current?.contains(target) ||
        withdrawalControlsRef.current?.contains(target))
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dismissPreview(true);
  };

  const handlePreviewKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === "Enter" &&
      previewItem.kind === "eventPrize" &&
      event.target === withdrawalInputRef.current
    ) {
      event.preventDefault();
      event.stopPropagation();
      void handleWithdrawEventPrize();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (previewItem.kind === "eventPrize") {
      if (isPrizeWithdrawalLocked) {
        previewOverlayRef.current?.focus({ preventScroll: true });
        return;
      }
      const controls = [
        withdrawalInputRef.current,
        withdrawalButtonRef.current,
      ].filter((control): control is HTMLInputElement | HTMLButtonElement =>
        Boolean(control),
      );
      const currentIndex = controls.findIndex(
        (control) => control === event.target,
      );
      const nextIndex =
        currentIndex < 0
          ? event.shiftKey
            ? controls.length - 1
            : 0
          : (currentIndex + (event.shiftKey ? -1 : 1) + controls.length) %
            controls.length;
      controls[nextIndex]?.focus({ preventScroll: true });
      return;
    }
    if (shouldShowPreviewAction && !isPreviewItemCurrent) {
      previewActionButtonRef.current?.focus({ preventScroll: true });
    } else {
      previewOverlayRef.current?.focus({ preventScroll: true });
    }
  };

  const handleApplyPreviewItem = () => {
    if (
      previewItem.kind === "eventPrize" ||
      !previewActionCopy ||
      isPreviewItemCurrent ||
      !onApply(previewItem)
    ) {
      return;
    }
    if (focusAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationFrameRef.current);
    }
    focusAnimationFrameRef.current = window.requestAnimationFrame(() => {
      focusAnimationFrameRef.current = null;
      previewOverlayRef.current?.focus({ preventScroll: true });
    });
  };

  return createPortal(
    <>
      <InventoryPreviewBackdrop
        data-inventory-item-preview="true"
        onClick={handlePreviewDismissClick}
      />
      <InventoryPreviewLayer
        ref={previewOverlayRef}
        $isCompact={isCompactWithdrawalViewport}
        style={
          {
            top: previewViewport.top,
            left: previewViewport.left,
            width: previewViewport.width,
            height: previewViewport.height,
            "--inventory-preview-height": `${previewViewport.height}px`,
          } as React.CSSProperties
        }
        data-inventory-item-preview="true"
        role="dialog"
        aria-modal="true"
        aria-label={previewDialogLabel}
        tabIndex={-1}
        onClick={handlePreviewDismissClick}
        onKeyDown={handlePreviewKeyDown}
      >
        <PreviewArtwork $isCompact={isCompactWithdrawalViewport}>
          {previewItem.kind === "avatar" ? (
            <AvatarImage
              src={`${SWAGPACK_INVENTORY_IMAGE_BASE_URL}/${previewItem.item.id}.webp`}
              alt=""
              rainbowAura={previewItem.item.count >= 3}
              loading="eager"
            />
          ) : previewItem.kind === "special" ? (
            <PreviewImage
              src={`https://cdn.lil.org/mons/id_cards/misc/bd4/${previewItem.item.id}.webp`}
              alt=""
              draggable={false}
            />
          ) : previewEventPrizeDefinition ? (
            <PreviewImage
              src={previewEventPrizeDefinition.imageUrl}
              alt=""
              width={previewEventPrizeDefinition.imageWidth}
              height={previewEventPrizeDefinition.imageHeight}
              draggable={false}
            />
          ) : null}
        </PreviewArtwork>
        {previewItem.kind === "eventPrize" && previewEventPrizeDefinition && (
          <PrizeWithdrawalControls
            ref={withdrawalControlsRef}
            $isCompact={isCompactWithdrawalViewport}
          >
            {previewEventPrizeDefinition.claimAvailable &&
              isWithdrawalAddressVisible && (
                <>
                  <PrizeWithdrawalInput
                    ref={withdrawalInputRef}
                    type="text"
                    value={withdrawalAddress}
                    placeholder="Solana address"
                    aria-label="Solana address"
                    aria-invalid={withdrawalError ? "true" : undefined}
                    disabled={isPrizeWithdrawalLocked}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) => {
                      setWithdrawalAddress(event.target.value);
                      setWithdrawalError("");
                    }}
                  />
                  <PrizeWithdrawalError role="status" aria-live="polite">
                    {withdrawalError}
                  </PrizeWithdrawalError>
                </>
              )}
            {previewEventPrizeDefinition.claimAvailable ? (
              <PrizeWithdrawalButton
                ref={withdrawalButtonRef}
                type="button"
                $status={withdrawalStatus}
                $isBlue={withdrawalStatus === "idle"}
                $isViewOnly={withdrawalStatus === "sending"}
                disabled={isPrizeWithdrawalLocked}
                onClick={() => void handleWithdrawEventPrize()}
              >
                {withdrawalStatus === "sending"
                  ? "Sending..."
                  : withdrawalStatus === "success"
                    ? "Success"
                    : isWithdrawalAddressVisible
                      ? "Send"
                      : "Withdraw"}
              </PrizeWithdrawalButton>
            ) : (
              <PrizeWithdrawalButton
                type="button"
                $status="idle"
                $isBlue={false}
                $isViewOnly={true}
                disabled={true}
              >
                Claim coming soon
              </PrizeWithdrawalButton>
            )}
          </PrizeWithdrawalControls>
        )}
        {previewActionCopy && shouldShowPreviewAction && (
          <PreviewActionRow>
            <PreviewActionHitbox>
              <PreviewActionButton
                ref={previewActionButtonRef}
                type="button"
                $isBlue={!isPreviewItemCurrent}
                $isViewOnly={isPreviewItemCurrent}
                disabled={isPreviewItemCurrent}
                onClick={handleApplyPreviewItem}
              >
                {isPreviewItemCurrent
                  ? previewActionCopy.current
                  : previewActionCopy.action}
              </PreviewActionButton>
            </PreviewActionHitbox>
          </PreviewActionRow>
        )}
      </InventoryPreviewLayer>
    </>,
    document.body,
  );
};
