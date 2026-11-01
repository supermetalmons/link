import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from "react";
import styled from "styled-components";
import type { EmojiId } from "../../content/emojis";
import { storage } from "../../utils/storage";
import { connection } from "../../connection/connection";
import { ModalOverlay, ModalPopup, ModalTitle } from "../SharedModalComponents";
import { didDismissSomethingWithOutsideTapJustNow } from "../controls/outsideTapState";
import {
  closeMenuAndInfoIfAllowedForEvent,
  closeMenuAndInfoIfAny,
} from "../controls/menuPort";
import { setAuthStatusGlobally } from "../../connection/authentication";
import type { AuthState } from "../../connection/authModels";
import { handleLoginSuccess } from "../../connection/loginSuccess";
import { markAuthNameCommitted } from "../../session/authRestoreTiming";
import { notifyVerifiedProfileNameCommitted } from "../../connection/deferredProfilePresentation";
import { formatAuthCooldownErrorMessage } from "../../connection/authCooldownErrors";
import { NameEditModal } from "../NameEditModal";
import { LogoutConfirmModal } from "../LogoutConfirmModal";
import { SettingsModal } from "./SettingsModalView";
import {
  EVENT_MODAL_AUTH_Z_INDEX,
  getEventModalState,
  subscribeToEventModalState,
} from "../eventModalController";
import { defaultEarlyInputEventName, isMobile } from "../../utils/misc";
import {
  hideShinyCard,
  showShinyCard,
  showsShinyCardSomewhere,
  updateShinyCardDisplayName,
} from "../shinyCardUiPort";
import { registerProfileTransientUiHandler } from "../uiSession";
import {
  performLogoutCleanupAndReload,
  reloadAfterLogout,
} from "../../session/logoutOrchestrator";
import { useEthereumWalletPicker } from "../EthereumWalletPicker";
import { primeInjectedEthereumProviderDiscovery } from "../../connection/injectedEthereumProviders";
import { getAppleButtonLabel, getXButtonLabel } from "./authFlowState";
import { useAppleAuthFlow } from "./useAppleAuthFlow";
import { useWalletAuthFlow } from "./useWalletAuthFlow";
import { useXAuthFlow } from "./useXAuthFlow";
import type { WalletAuthFlowOptions } from "./walletAuthFlowController";
import {
  type ProfileSignInApi,
  type ProfileSignInPopupMode,
  getInitialProfileDisplayName,
  registerProfileDisplayNameHandlers,
  registerProfileSignInApi,
  registerSignInInlineAuthErrorHandler,
  updateProfileDisplayName,
} from "./profileUiPort";
import {
  LOGOUT_SIGN_OUT_FALLBACK_DELAY_MS,
  armLogoutUiRecoveryTimeout,
  beginLogoutAttempt,
  configureLogoutUiLock,
  lockLogoutUi,
  markLogoutAttemptFinalized,
  reconcileLogoutUiLockWithAuthStatus,
} from "./logoutUiLock";
import {
  signInButtonVisualStyles,
  type SignInButtonVisualProps,
} from "./signInButtonStyles";

export { signInButtonVisualStyles } from "./signInButtonStyles";

configureLogoutUiLock({
  setAuthStatus: setAuthStatusGlobally,
  performCleanup: (options) => {
    void performLogoutCleanupAndReload(options).catch(() => undefined);
  },
});

const Container = styled.div<{ $liftAboveEventModal?: boolean }>`
  position: relative;
  z-index: ${(props) =>
    props.$liftAboveEventModal ? EVENT_MODAL_AUTH_Z_INDEX + 3 : "auto"};
`;

const BaseButton = styled.button`
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  outline: none;
  -webkit-touch-callout: none;
  touch-action: none;
`;

const SignInButton = styled(BaseButton)<SignInButtonVisualProps>`
  ${signInButtonVisualStyles}
`;

const ConnectButtonPopover = styled.div`
  position: absolute;
  right: 0;
  top: 100%;
  margin-top: 16px;
  z-index: 50;
  width: 135px;
`;

const ConnectButtonWrapper = styled.div`
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  background-color: var(--color-white);
  border-radius: 12px;
  box-shadow: 0 6px 20px var(--notificationBannerShadow);
  display: flex;
  flex-direction: column;
  gap: 8px;

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-deep-gray);
  }
`;

const CustomConnectButton = styled(BaseButton)`
  width: 100%;
  min-width: 0;
  color: var(--color-black);
  padding: 11px 14px;
  border: none;
  border-radius: 8px;
  font-weight: bold;
  font-size: 0.81rem;
  text-align: center;
  white-space: nowrap;
  cursor: pointer;

  background-color: var(--color-gray-f9);

  &:disabled {
    opacity: 0.55;
    cursor: default;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background-color: var(--color-gray-f5);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-gray-25);
    color: var(--color-gray-f5);

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background-color: var(--color-gray-27);
      }
    }
  }
`;

const InlineAuthError = styled.div`
  width: 100%;
  box-sizing: border-box;
  border-radius: 8px;
  background: rgba(220, 53, 69, 0.08);
  color: var(--dangerButtonBackground);
  font-size: 0.74rem;
  line-height: 1.35;
  padding: 8px 9px;
  text-align: left;

  @media (prefers-color-scheme: dark) {
    background: rgba(220, 53, 69, 0.22);
    color: var(--dangerButtonBackgroundDark);
  }
`;

const EventSignInOverlay = styled(ModalOverlay)`
  z-index: ${EVENT_MODAL_AUTH_Z_INDEX + 2};
`;

const EventSignInPopup = styled(ModalPopup)`
  max-width: 320px;
  padding: 20px 20px 14px;
  outline: none;
  box-shadow: none;
`;

const EventConnectButtonWrapper = styled(ConnectButtonWrapper)`
  box-shadow: none;
  background-color: transparent;
  padding: 0;
  transform: translateY(-6px);
`;

const EventSignInTitle = styled(ModalTitle)`
  margin-bottom: 16px;
  text-align: left;
`;

interface NotificationState {
  title: string;
  subtitle: string;
  emojiId: EmojiId;
  successHandler: () => void;
}

interface ProfileSignInProps {
  authState: AuthState;
}

const ProfileSignIn: React.FC<ProfileSignInProps> = ({ authState }) => {
  const { authStatus } = authState;
  const [isOpen, setIsOpen] = useState(false);
  const [popupMode, setPopupMode] = useState<ProfileSignInPopupMode>("inline");
  const [isEventModalVisible, setIsEventModalVisible] = useState(() => {
    const eventModalState = getEventModalState();
    return eventModalState.isOpen && !!eventModalState.eventId;
  });
  const [inlineAuthError, setInlineAuthError] = useState("");
  const { requestWalletSelection, pickerElement, closePicker } =
    useEthereumWalletPicker();
  const [profileDisplayName, setProfileDisplayName] = useState(
    getInitialProfileDisplayName,
  );
  const [isEditingName, setIsEditingName] = useState(false);
  const [isLogoutConfirmOpen, setIsLogoutConfirmOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInlineMessage, setSettingsInlineMessage] = useState<{
    id: number;
    message: string;
  } | null>(null);
  const [NotificationComponent, setNotificationComponent] = useState<
    | (typeof import("../NotificationBanner"))["NotificationBannerComponent"]
    | null
  >(null);
  const [isNotificationVisible, setIsNotificationVisible] = useState(false);
  const [notificationState, setNotificationState] =
    useState<NotificationState | null>(null);
  const [isNotificationMounted, setIsNotificationMounted] = useState(false);
  const [notificationDismissType, setNotificationDismissType] = useState<
    "click" | "close" | null
  >(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const signInButtonRef = useRef<HTMLButtonElement>(null);
  const notificationTimeoutRef = useRef<number | null>(null);
  const logoutReturnFocusIdRef = useRef<string | null>(null);
  const settingsReturnFocusIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const wasOpenRef = useRef(isOpen);
  const nextSettingsInlineMessageIdRef = useRef(0);

  const restoreFocusById = useCallback(
    (returnFocusIdRef: { current: string | null }) => {
      const returnFocusId = returnFocusIdRef.current;
      returnFocusIdRef.current = null;
      if (!returnFocusId) {
        return;
      }
      window.requestAnimationFrame(() => {
        const target = document.getElementById(returnFocusId);
        if (target instanceof HTMLElement && target.isConnected) {
          target.focus({ preventScroll: true });
        }
      });
    },
    [],
  );

  const {
    state: appleButtonState,
    start: handleAppleClick,
    resetUi: resetAppleUi,
  } = useAppleAuthFlow({
    consentSource: "signin",
    shouldPreload: isOpen && authStatus !== "authenticated",
    canStart: () => true,
    canConfirm: () => isOpen && authStatus !== "authenticated",
    onStart: () => setInlineAuthError(""),
    onVerified: (result, mounted) => {
      if (result.ok === true && handleLoginSuccess(result)) {
        setAuthStatusGlobally("authenticated");
        if (mounted) {
          setInlineAuthError("");
          setIsOpen(false);
          hideShinyCard();
        }
      }
    },
    onError: (error) => {
      console.error("Apple sign in error:", error);
      const cooldownMessage = formatAuthCooldownErrorMessage(error);
      if (cooldownMessage) setInlineAuthError(cooldownMessage);
    },
  });
  const appleText = getAppleButtonLabel(appleButtonState);
  const walletFlowOptions: WalletAuthFlowOptions = {
    canStart: () => true,
    onStart: () => setInlineAuthError(""),
    onVerified: (result, mounted) => {
      if (result.ok === true && handleLoginSuccess(result)) {
        setAuthStatusGlobally("authenticated");
        if (mounted) {
          setInlineAuthError("");
          setIsOpen(false);
          hideShinyCard();
        }
      }
    },
    onError: (error) => {
      const cooldownMessage = formatAuthCooldownErrorMessage(error);
      if (cooldownMessage) setInlineAuthError(cooldownMessage);
    },
  };
  const { state: solanaState, start: handleSolanaClick } = useWalletAuthFlow({
    ...walletFlowOptions,
    method: "sol",
    requestWalletSelection,
    notFoundDurationMs: 500,
  });
  const { state: ethereumState, start: handleEthereumClick } =
    useWalletAuthFlow({
      ...walletFlowOptions,
      method: "eth",
      requestWalletSelection,
      notFoundDurationMs: 500,
    });
  const solanaText =
    solanaState === "not-found"
      ? "Not Found"
      : solanaState === "verifying"
        ? "Verifying..."
        : "Solana";
  const ethereumText =
    ethereumState === "not-found"
      ? "Not Found"
      : ethereumState === "verifying"
        ? "Verifying..."
        : "Ethereum";
  const shouldLiftAboveEventModal = isOpen && popupMode === "event";
  const isEventSignInPopup = isOpen && popupMode === "event";

  useLayoutEffect(() => {
    if (authStatus !== "authenticated" || isEventSignInPopup) return;
    const profileId = authState.profileId;
    const expectedName = profileDisplayName || "Connected";
    const isCurrent = () => {
      const button = signInButtonRef.current;
      return (
        connection.isCurrentAuthUser(storage.getLoginId("")) &&
        storage.getProfileId("") === profileId &&
        button?.isConnected === true &&
        button.textContent === expectedName
      );
    };
    const cancelTiming = markAuthNameCommitted(isCurrent);
    const cancelPresentation = notifyVerifiedProfileNameCommitted(
      { profileId, displayName: expectedName },
      isCurrent,
    );
    return () => {
      cancelTiming();
      cancelPresentation();
    };
  }, [authStatus, authState.profileId, profileDisplayName, isEventSignInPopup]);

  useEffect(() => {
    return subscribeToEventModalState((nextState) => {
      setIsEventModalVisible(nextState.isOpen && !!nextState.eventId);
    });
  }, []);

  useEffect(() => {
    if (popupMode !== "event") {
      return;
    }
    const eventModalState = getEventModalState();
    if (eventModalState.isOpen && !!eventModalState.eventId) {
      return;
    }
    if (isOpen) {
      setIsOpen(false);
    }
    setPopupMode("inline");
  }, [isEventModalVisible, isOpen, popupMode]);

  useEffect(() => {
    if (authStatus !== "authenticated" || popupMode !== "event") {
      return;
    }
    if (isOpen) {
      setIsOpen(false);
    }
    setPopupMode("inline");
  }, [authStatus, isOpen, popupMode]);

  useEffect(() => {
    const handleClickOutside = (event: TouchEvent | MouseEvent) => {
      event.stopPropagation();
      const target = event.target as Node;
      const shinyCardElement = document.querySelector(
        '[data-shiny-card="true"]',
      );
      const isInsidePopover = popoverRef.current?.contains(target) || false;
      const isInsideShinyCard = shinyCardElement?.contains(target) || false;
      const isPlayerCardTrigger =
        target instanceof Element &&
        target.closest("[data-player-card-trigger='true']") !== null;

      if (
        target instanceof Element &&
        target.closest(
          ".info-button, .more-button, .gem-button, .music-button, tr, .shiny-card-done-button",
        )
      ) {
        return;
      }

      if (isPlayerCardTrigger && showsShinyCardSomewhere) {
        setIsOpen(false);
        return;
      }

      if (
        (isOpen || showsShinyCardSomewhere) &&
        !isInsidePopover &&
        !isInsideShinyCard
      ) {
        didDismissSomethingWithOutsideTapJustNow();
        setIsOpen(false);
        hideShinyCard();
        if (!isMobile) {
          closeMenuAndInfoIfAllowedForEvent(event);
        }
      }
    };

    document.addEventListener(defaultEarlyInputEventName, handleClickOutside);
    return () =>
      document.removeEventListener(
        defaultEarlyInputEventName,
        handleClickOutside,
      );
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (notificationTimeoutRef.current) {
        clearTimeout(notificationTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen || authStatus === "authenticated") {
      closePicker();
    }
  }, [isOpen, authStatus, closePicker]);

  useEffect(() => {
    if (authStatus === "authenticated") resetAppleUi();
  }, [authStatus, resetAppleUi]);

  useEffect(() => {
    reconcileLogoutUiLockWithAuthStatus(authStatus);
  }, [authStatus]);

  const beginImmediateLogoutUiCleanup = useCallback(() => {
    logoutReturnFocusIdRef.current = null;
    settingsReturnFocusIdRef.current = null;
    lockLogoutUi();
    setIsOpen(false);
    setIsLogoutConfirmOpen(false);
    setIsSettingsOpen(false);
    setSettingsInlineMessage(null);
    setIsEditingName(false);
    hideShinyCard();
    setAuthStatusGlobally("loading");
  }, []);

  const showNotificationBannerInternal = useCallback(
    async (
      title: string,
      subtitle: string,
      emojiId: EmojiId,
      successHandler: () => void,
    ) => {
      if (notificationTimeoutRef.current) {
        clearTimeout(notificationTimeoutRef.current);
        notificationTimeoutRef.current = null;
      }

      try {
        const { NotificationBannerComponent } =
          await import("../NotificationBanner");
        setNotificationComponent(() => NotificationBannerComponent);
        setNotificationState({ title, subtitle, emojiId, successHandler });
        setNotificationDismissType(null);
        setIsNotificationMounted(true);

        requestAnimationFrame(() => {
          setIsNotificationVisible(true);
        });
      } catch (error) {
        console.error("Failed to load notification component:", error);
      }
    },
    [],
  );

  const hideNotificationBannerInternal = useCallback(() => {
    if (notificationTimeoutRef.current) {
      clearTimeout(notificationTimeoutRef.current);
      notificationTimeoutRef.current = null;
    }

    setIsNotificationVisible(false);

    notificationTimeoutRef.current = window.setTimeout(() => {
      setIsNotificationMounted(false);
      setNotificationState(null);
      setNotificationDismissType(null);
      notificationTimeoutRef.current = null;
    }, 400);
  }, []);

  const performLogout = () => {
    const logoutAttemptId = beginLogoutAttempt();
    beginImmediateLogoutUiCleanup();
    armLogoutUiRecoveryTimeout(logoutAttemptId);
    let didStartFinalReset = false;
    const finalizeLogout = () => {
      if (didStartFinalReset) {
        return;
      }
      if (!markLogoutAttemptFinalized(logoutAttemptId)) {
        return;
      }
      didStartFinalReset = true;
      void performLogoutCleanupAndReload().catch(() => undefined);
    };
    const fallbackTimeoutId = window.setTimeout(() => {
      finalizeLogout();
    }, LOGOUT_SIGN_OUT_FALLBACK_DELAY_MS);
    connection
      .signOut()
      .then((applied) => {
        if (!applied) {
          didStartFinalReset = true;
          reloadAfterLogout();
        }
      })
      .catch(() => {})
      .finally(() => {
        window.clearTimeout(fallbackTimeoutId);
        finalizeLogout();
      });
  };

  const closeProfilePopupInternal = useCallback(() => {
    logoutReturnFocusIdRef.current = null;
    settingsReturnFocusIdRef.current = null;
    if (
      isOpen ||
      isEditingName ||
      isLogoutConfirmOpen ||
      isSettingsOpen ||
      showsShinyCardSomewhere
    )
      didDismissSomethingWithOutsideTapJustNow();
    setIsOpen(false);
    setPopupMode("inline");
    setIsLogoutConfirmOpen(false);
    setIsSettingsOpen(false);
    setSettingsInlineMessage(null);
    setIsEditingName(false);
    hideShinyCard();
  }, [isOpen, isEditingName, isLogoutConfirmOpen, isSettingsOpen]);

  const handleLogoutRequestInternal = useCallback((returnFocusId?: string) => {
    logoutReturnFocusIdRef.current = returnFocusId ?? null;
    setIsLogoutConfirmOpen(true);
  }, []);

  const showSettingsInternal = useCallback((returnFocusId?: string) => {
    settingsReturnFocusIdRef.current = returnFocusId ?? null;
    setIsSettingsOpen(true);
  }, []);

  const handleEditDisplayNameInternal = useCallback(() => {
    setIsEditingName(true);
  }, []);

  useEffect(() => {
    return registerProfileTransientUiHandler(
      hideNotificationBannerInternal,
      closeProfilePopupInternal,
    );
  }, [closeProfilePopupInternal, hideNotificationBannerInternal]);

  useEffect(() => {
    return registerSignInInlineAuthErrorHandler((message) => {
      if (!isMountedRef.current) {
        return;
      }
      setInlineAuthError(typeof message === "string" ? message : "");
    });
  }, []);

  const {
    buttonState: xButtonState,
    pendingSignIn,
    isBusy: isXBusy,
    start: handleXClick,
    retryPendingSignIn: recoverFromStalePendingXSignInRedirect,
  } = useXAuthFlow({
    consentSource: "signin",
    authStatus,
    canStart: () => authStatus !== "authenticated",
    onStart: () => setInlineAuthError(""),
    onError: (message) => setInlineAuthError(message),
    onRedirectStarted: () => setInlineAuthError(""),
    onPendingSignIn: () => {
      setInlineAuthError("");
      setIsOpen(false);
    },
    onSettingsReturn: () => {
      logoutReturnFocusIdRef.current = null;
      closeMenuAndInfoIfAny();
      setIsOpen(false);
      setIsLogoutConfirmOpen(false);
      setIsEditingName(false);
      hideShinyCard();
      setIsSettingsOpen(true);
    },
    onFeedback: (feedback) => {
      if (feedback.target === "signin") {
        const eventModalState = getEventModalState();
        const nextMode: ProfileSignInPopupMode =
          eventModalState.isOpen && !!eventModalState.eventId
            ? "event"
            : "inline";
        closeMenuAndInfoIfAny();
        setPopupMode(nextMode);
        setInlineAuthError(feedback.message);
        setIsOpen(true);
        return;
      }
      if (feedback.kind === "error") {
        nextSettingsInlineMessageIdRef.current += 1;
        setSettingsInlineMessage({
          id: nextSettingsInlineMessageIdRef.current,
          message: feedback.message,
        });
      } else {
        setSettingsInlineMessage(null);
      }
      setIsOpen(false);
      setIsSettingsOpen(true);
    },
  });
  const xText = getXButtonLabel(xButtonState);
  const isPendingXSignInRedirect = pendingSignIn !== "none";
  const isPendingXSignInRedirectBlockingUi = pendingSignIn === "waiting";

  const openProfileSignInPopupInternal = useCallback(
    (mode: ProfileSignInPopupMode = "inline") => {
      if (
        authStatus === "authenticated" ||
        isPendingXSignInRedirectBlockingUi
      ) {
        return;
      }
      if (mode === "event") {
        const eventModalState = getEventModalState();
        if (!eventModalState.isOpen || !eventModalState.eventId) {
          return;
        }
      }
      if (isOpen) {
        if (popupMode !== mode) {
          setPopupMode(mode);
        }
        return;
      }
      if (isPendingXSignInRedirect) {
        recoverFromStalePendingXSignInRedirect();
      }
      closeMenuAndInfoIfAny();
      setPopupMode(mode);
      setIsOpen(true);
    },
    [
      authStatus,
      isOpen,
      isPendingXSignInRedirect,
      isPendingXSignInRedirectBlockingUi,
      popupMode,
      recoverFromStalePendingXSignInRedirect,
    ],
  );

  useLayoutEffect(() => {
    const api: ProfileSignInApi = {
      close: closeProfilePopupInternal,
      editDisplayName: handleEditDisplayNameInternal,
      requestLogout: handleLogoutRequestInternal,
      openSettings: showSettingsInternal,
      hideNotificationBanner: hideNotificationBannerInternal,
      showNotificationBanner: showNotificationBannerInternal,
      openSignInPopup: openProfileSignInPopupInternal,
      hasVisiblePopup: () =>
        isOpen || isEditingName || isLogoutConfirmOpen || isSettingsOpen,
    };
    return registerProfileSignInApi(api);
  }, [
    closeProfilePopupInternal,
    handleEditDisplayNameInternal,
    handleLogoutRequestInternal,
    hideNotificationBannerInternal,
    openProfileSignInPopupInternal,
    showNotificationBannerInternal,
    showSettingsInternal,
    isEditingName,
    isLogoutConfirmOpen,
    isOpen,
    isSettingsOpen,
  ]);

  useLayoutEffect(() => {
    return registerProfileDisplayNameHandlers(
      setProfileDisplayName,
      updateShinyCardDisplayName,
    );
  }, []);

  useEffect(() => {
    if (wasOpenRef.current && !isOpen) setInlineAuthError("");
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  const handleSignInClick = () => {
    if (isEventSignInPopup) {
      return;
    }
    if (isPendingXSignInRedirectBlockingUi) {
      return;
    }
    if (isPendingXSignInRedirect) {
      recoverFromStalePendingXSignInRedirect();
    }
    if (authStatus === "authenticated") {
      if (isOpen) {
        hideShinyCard();
      } else {
        showShinyCard(null, profileDisplayName, false);
      }
    }

    if (!isOpen) {
      closeMenuAndInfoIfAny();
    }

    setIsOpen(!isOpen);
  };

  const handleSaveDisplayName = (newName: string) => {
    updateProfileDisplayName(
      newName,
      storage.getEthAddress(""),
      storage.getSolAddress(""),
    );
    storage.setUsername(newName);
    setIsEditingName(false);
  };

  const handleCancelEditName = () => {
    didDismissSomethingWithOutsideTapJustNow();
    setIsEditingName(false);
  };

  const handleConfirmLogout = () => {
    logoutReturnFocusIdRef.current = null;
    performLogout();
  };

  const handleCancelLogout = () => {
    didDismissSomethingWithOutsideTapJustNow();
    setIsLogoutConfirmOpen(false);
    restoreFocusById(logoutReturnFocusIdRef);
  };

  const handleCloseSettings = () => {
    didDismissSomethingWithOutsideTapJustNow();
    setIsSettingsOpen(false);
    setSettingsInlineMessage(null);
    restoreFocusById(settingsReturnFocusIdRef);
  };

  useEffect(() => {
    if (!isOpen || authStatus === "authenticated") {
      return;
    }
    void import("../../connection/solanaConnection").catch(() => {});
    void import("../../connection/ethereumConnection").catch(() => {});
    primeInjectedEthereumProviderDiscovery();
  }, [isOpen, authStatus]);

  const handleNotificationClick = () => {
    if (notificationState?.successHandler) {
      notificationState.successHandler();
    }
    setNotificationDismissType("click");
    setIsNotificationVisible(false);
  };

  const handleNotificationClose = () => {
    setNotificationDismissType("close");
    setIsNotificationVisible(false);
  };

  const signInOptions = (
    <>
      <CustomConnectButton
        onClick={!isMobile ? handleEthereumClick : undefined}
        onTouchStart={isMobile ? handleEthereumClick : undefined}
      >
        {ethereumText}
      </CustomConnectButton>
      <CustomConnectButton
        onClick={!isMobile ? handleSolanaClick : undefined}
        onTouchStart={isMobile ? handleSolanaClick : undefined}
      >
        {solanaText}
      </CustomConnectButton>
      <CustomConnectButton onClick={handleAppleClick}>
        {appleText}
      </CustomConnectButton>
      <CustomConnectButton disabled={isXBusy} onClick={handleXClick}>
        {xText}
      </CustomConnectButton>
      {inlineAuthError ? (
        <InlineAuthError>{inlineAuthError}</InlineAuthError>
      ) : null}
    </>
  );

  const handleEventSignInBackdropPointerDown = useCallback(
    (
      event:
        React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
    ) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      event.stopPropagation();
    },
    [],
  );

  const handleEventSignInBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      event.stopPropagation();
      closeProfilePopupInternal();
    },
    [closeProfilePopupInternal],
  );

  return (
    <Container
      ref={popoverRef}
      $liftAboveEventModal={shouldLiftAboveEventModal}
    >
      {!isEventSignInPopup && (
        <SignInButton
          ref={signInButtonRef}
          disabled={isPendingXSignInRedirectBlockingUi}
          aria-busy={isPendingXSignInRedirectBlockingUi}
          onClick={!isMobile ? handleSignInClick : undefined}
          onTouchStart={isMobile ? handleSignInClick : undefined}
          $isConnected={authStatus === "authenticated"}
          $isPending={isPendingXSignInRedirectBlockingUi}
        >
          {authStatus === "authenticated"
            ? profileDisplayName || "Connected"
            : isPendingXSignInRedirectBlockingUi
              ? "Verifying..."
              : isPendingXSignInRedirect
                ? "Try Again"
                : "Sign In"}
        </SignInButton>
      )}
      {isOpen &&
        authStatus !== "authenticated" &&
        !isEventSignInPopup &&
        !isPendingXSignInRedirectBlockingUi && (
          <ConnectButtonPopover>
            <ConnectButtonWrapper>{signInOptions}</ConnectButtonWrapper>
          </ConnectButtonPopover>
        )}
      {isOpen &&
        isEventModalVisible &&
        authStatus !== "authenticated" &&
        isEventSignInPopup &&
        !isPendingXSignInRedirectBlockingUi && (
          <EventSignInOverlay
            onMouseDown={handleEventSignInBackdropPointerDown}
            onTouchStart={handleEventSignInBackdropPointerDown}
            onClick={handleEventSignInBackdropClick}
          >
            <EventSignInPopup
              role="dialog"
              aria-label="Sign In"
              onMouseDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <EventSignInTitle>Sign In</EventSignInTitle>
              <EventConnectButtonWrapper>
                {signInOptions}
              </EventConnectButtonWrapper>
            </EventSignInPopup>
          </EventSignInOverlay>
        )}
      {NotificationComponent && isNotificationMounted && notificationState && (
        <NotificationComponent
          isVisible={isNotificationVisible}
          onClose={handleNotificationClose}
          onClick={handleNotificationClick}
          title={notificationState.title}
          subtitle={notificationState.subtitle}
          emojiId={notificationState.emojiId}
          dismissType={notificationDismissType}
        />
      )}
      {isEditingName && (
        <NameEditModal
          initialName={storage.getUsername("")}
          onSave={handleSaveDisplayName}
          onCancel={handleCancelEditName}
        />
      )}
      {isLogoutConfirmOpen && (
        <LogoutConfirmModal
          onConfirm={handleConfirmLogout}
          onCancel={handleCancelLogout}
        />
      )}
      {isSettingsOpen && (
        <SettingsModal
          onClose={handleCloseSettings}
          xInlineMessage={settingsInlineMessage}
        />
      )}
      {pickerElement}
    </Container>
  );
};

export default ProfileSignIn;
