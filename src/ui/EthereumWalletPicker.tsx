import React, { useCallback, useEffect, useRef, useState } from "react";
import styled from "styled-components";
import {
  ModalOverlay,
  ModalPopup,
  ModalTitle,
  handleModalKeyDown,
} from "./SharedModalComponents";
import {
  getInjectedWalletIconSrc,
  listInjectedEthereumProviders,
  type EIP6963ProviderDetail,
} from "../connection/injectedEthereumProviders";

const PickerPopup = styled(ModalPopup)`
  padding: 20px;
  max-width: 300px;
`;

const PickerTitle = styled(ModalTitle)`
  margin-bottom: 16px;
  text-align: left;
`;

const WalletList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const WalletButton = styled.button.attrs({ type: "button" })<{
  $muted?: boolean;
}>`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 11px 14px;
  border: none;
  border-radius: 10px;
  font-weight: bold;
  font-size: 0.9rem;
  text-align: left;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  outline: none;
  touch-action: none;
  background-color: var(--color-gray-f0);
  color: ${(props) =>
    props.$muted ? "var(--color-gray-77)" : "var(--color-black)"};

  &:focus-visible {
    outline: 2px solid var(--color-blue-0066cc);
    outline-offset: 2px;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--color-gray-e0);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-gray-33);
    color: ${(props) =>
      props.$muted ? "var(--color-gray-a0)" : "var(--color-gray-f5)"};

    &:focus-visible {
      outline-color: var(--color-blue-66b3ff);
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--color-gray-44);
      }
    }
  }
`;

const WalletIcon = styled.img`
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: 4px;
  object-fit: contain;
`;

const WalletName = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export type EthereumWalletChoice =
  | { status: "resolved"; wallet: EIP6963ProviderDetail | null }
  | { status: "cancelled" };

type PendingSelection = {
  wallets: EIP6963ProviderDetail[];
  resolve: (choice: EthereumWalletChoice) => void;
};

const EthereumWalletPickerModal: React.FC<{
  wallets: EIP6963ProviderDetail[];
  onSelect: (wallet: EIP6963ProviderDetail) => void;
  onCancel: () => void;
}> = ({ wallets, onSelect, onCancel }) => {
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    if (popupRef.current) {
      popupRef.current.focus({ preventScroll: true });
    }
    return () => {
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused !== document.body &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <ModalOverlay
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
    >
      <PickerPopup
        ref={popupRef}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => handleModalKeyDown(e, popupRef.current, onCancel)}
        tabIndex={0}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ethereum-wallet-picker-title"
      >
        <PickerTitle id="ethereum-wallet-picker-title">
          Select Wallet
        </PickerTitle>
        <WalletList>
          {wallets.map((wallet) => {
            const iconSrc = getInjectedWalletIconSrc(wallet.info.icon);
            return (
              <WalletButton
                key={wallet.info.rdns || wallet.info.uuid}
                onClick={() => onSelect(wallet)}
              >
                {iconSrc && <WalletIcon src={iconSrc} alt="" aria-hidden />}
                <WalletName>{wallet.info.name}</WalletName>
              </WalletButton>
            );
          })}
          <WalletButton $muted onClick={onCancel}>
            <WalletName>Cancel</WalletName>
          </WalletButton>
        </WalletList>
      </PickerPopup>
    </ModalOverlay>
  );
};

export const useEthereumWalletPicker = (): {
  requestWalletSelection: () => Promise<EthereumWalletChoice>;
  pickerElement: React.ReactElement | null;
  closePicker: () => void;
} => {
  const [pendingSelection, setPendingSelection] =
    useState<PendingSelection | null>(null);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);
  const isMountedRef = useRef(true);

  const settleSelection = useCallback((choice: EthereumWalletChoice) => {
    const pending = pendingSelectionRef.current;
    pendingSelectionRef.current = null;
    setPendingSelection(null);
    if (pending) {
      pending.resolve(choice);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      const pending = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      if (pending) {
        pending.resolve({ status: "cancelled" });
      }
    };
  }, []);

  const closePicker = useCallback(() => {
    if (!pendingSelectionRef.current) {
      return;
    }
    settleSelection({ status: "cancelled" });
  }, [settleSelection]);

  const requestWalletSelection =
    useCallback(async (): Promise<EthereumWalletChoice> => {
      const wallets = await listInjectedEthereumProviders();
      if (!isMountedRef.current) {
        return { status: "cancelled" };
      }
      if (wallets.length <= 1) {
        return { status: "resolved", wallet: wallets[0] ?? null };
      }
      closePicker();
      return new Promise<EthereumWalletChoice>((resolve) => {
        const pending: PendingSelection = { wallets, resolve };
        pendingSelectionRef.current = pending;
        setPendingSelection(pending);
      });
    }, [closePicker]);

  const pickerElement = pendingSelection ? (
    <EthereumWalletPickerModal
      wallets={pendingSelection.wallets}
      onSelect={(wallet) => settleSelection({ status: "resolved", wallet })}
      onCancel={() => settleSelection({ status: "cancelled" })}
    />
  ) : null;

  return { requestWalletSelection, pickerElement, closePicker };
};
