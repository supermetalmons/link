import styled from "styled-components";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const trapModalFocus = (
  event: ReactKeyboardEvent<HTMLElement>,
  modal: HTMLElement | null,
): void => {
  if (event.key !== "Tab" || !modal) {
    return;
  }

  const focusableElements = Array.from(
    modal.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element !== modal &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.getClientRects().length > 0,
  );

  if (focusableElements.length === 0) {
    event.preventDefault();
    modal.focus({ preventScroll: true });
    return;
  }

  const activeIndex = focusableElements.indexOf(
    document.activeElement as HTMLElement,
  );
  const shouldWrapBackward = event.shiftKey && activeIndex <= 0;
  const shouldWrapForward =
    !event.shiftKey &&
    (activeIndex === -1 || activeIndex === focusableElements.length - 1);

  if (!shouldWrapBackward && !shouldWrapForward) {
    return;
  }

  event.preventDefault();
  const nextElement = shouldWrapBackward
    ? focusableElements[focusableElements.length - 1]
    : focusableElements[0];
  nextElement!.focus({ preventScroll: true });
};

export const handleModalKeyDown = (
  event: ReactKeyboardEvent<HTMLElement>,
  modal: HTMLElement | null,
  onDismiss: () => void,
): void => {
  trapModalFocus(event, modal);
  if (event.key !== "Escape") {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  onDismiss();
};

export const ModalOverlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--modalOverlayBackground);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 102300;

  @media (prefers-color-scheme: dark) {
    background-color: var(--modalOverlayBackgroundDark);
  }
`;

export const ModalPopup = styled.div`
  background-color: var(--color-white);
  padding: 24px;
  border-radius: 16px;
  box-shadow: 0 6px 20px var(--standardBoxShadow);
  width: 85%;
  max-width: 320px;
  outline: none;

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-deep-gray);
  }
`;

export const ModalTitle = styled.h3`
  margin-top: 0;
  margin-bottom: 16px;
  cursor: default;
  font-size: 1.1rem;
  color: var(--color-gray-33);

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f0);
  }
`;

export const ButtonsContainer = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
`;

const Button = styled.button.attrs({ type: "button" })`
  padding: 10px 16px;
  border: none;
  border-radius: 20px;
  font-weight: bold;
  font-size: 0.9rem;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  outline: none;
  touch-action: none;
  transition: background-color 0.2s ease;

  &:focus-visible {
    outline: 2px solid var(--color-blue-0066cc);
    outline-offset: 2px;
  }

  @media (prefers-color-scheme: dark) {
    &:focus-visible {
      outline-color: var(--color-blue-66b3ff);
    }
  }
`;

export const CancelButton = styled(Button)`
  background-color: var(--color-gray-f0);
  color: var(--color-black);

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--color-gray-e0);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-gray-33);
    color: var(--color-gray-f5);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--color-gray-44);
      }
    }
  }
`;

export const SaveButton = styled(Button)<{ disabled: boolean }>`
  background-color: ${(props) =>
    props.disabled ? "var(--color-gray-a0)" : "var(--color-blue-primary)"};
  color: white;
  min-width: 80px;
  opacity: ${(props) => (props.disabled ? 0.7 : 1)};

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.disabled
          ? "var(--color-gray-a0)"
          : "var(--bottomButtonBackgroundHover)"};
    }
  }

  &:active {
    background-color: ${(props) =>
      props.disabled
        ? "var(--color-gray-a0)"
        : "var(--bottomButtonBackgroundActive)"};
  }

  @media (prefers-color-scheme: dark) {
    background-color: ${(props) =>
      props.disabled
        ? "var(--color-gray-55)"
        : "var(--color-blue-primary-dark)"};

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.disabled
            ? "var(--color-gray-55)"
            : "var(--bottomButtonBackgroundHoverDark)"};
      }
    }

    &:active {
      background-color: ${(props) =>
        props.disabled
          ? "var(--color-gray-55)"
          : "var(--bottomButtonBackgroundActiveDark)"};
    }
  }
`;

export const DangerButton = styled(Button)<{ disabled?: boolean }>`
  background-color: ${(props) =>
    props.disabled ? "var(--color-gray-a0)" : "var(--dangerButtonBackground)"};
  color: white;
  min-width: 80px;
  opacity: ${(props) => (props.disabled ? 0.7 : 1)};

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.disabled
          ? "var(--color-gray-a0)"
          : "var(--dangerButtonBackgroundHover)"};
    }
  }

  &:active {
    background-color: ${(props) =>
      props.disabled
        ? "var(--color-gray-a0)"
        : "var(--dangerButtonBackgroundActive)"};
  }

  @media (prefers-color-scheme: dark) {
    background-color: ${(props) =>
      props.disabled
        ? "var(--color-gray-55)"
        : "var(--dangerButtonBackgroundDark)"};

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.disabled
            ? "var(--color-gray-55)"
            : "var(--dangerButtonBackgroundHoverDark)"};
      }
    }

    &:active {
      background-color: ${(props) =>
        props.disabled
          ? "var(--color-gray-55)"
          : "var(--dangerButtonBackgroundActiveDark)"};
    }
  }
`;
