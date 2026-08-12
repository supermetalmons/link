import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from "react";
import { flushSync } from "react-dom";
import styled from "styled-components";
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
import {
  preloadAppleSignInLibrary,
  signInWithApplePopup,
} from "../../connection/appleConnection";
import {
  clearConsumedXRedirectResult,
  isXRedirectStartedError,
  peekXRedirectResult,
  startXRedirectAuth,
  subscribeToPendingXRedirectResult,
} from "../../connection/xConnection";
import { formatAuthCooldownErrorMessage } from "../../connection/authCooldownErrors";
import { formatXAuthErrorMessage } from "../../connection/xAuthErrors";
import {
  consumePendingXAuthUiFeedback,
  subscribeToXAuthUiFeedback,
  XAuthUiFeedback,
} from "../../connection/xAuthUiFeedback";
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
import { performLogoutCleanupAndReload } from "../../session/logoutOrchestrator";
import { useEthereumWalletPicker } from "../EthereumWalletPicker";
import { primeInjectedEthereumProviderDiscovery } from "../../connection/injectedEthereumProviders";
import {
  type AppleButtonUiState,
  type AuthIntentResponse,
  type XButtonUiState,
  APPLE_INTENT_REFRESH_BUFFER_MS,
  getAppleButtonLabel,
  getXButtonLabel,
  isAppleIntentUsable,
} from "./authFlowState";
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
    void performLogoutCleanupAndReload(options);
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

const X_REDIRECT_NAVIGATION_FALLBACK_DELAY_MS = 1500;
const STALE_PENDING_X_SIGNIN_DELAY_MS = 20 * 1000;

interface NotificationState {
  title: string;
  subtitle: string;
  emojiId: string;
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
  const [solanaText, setSolanaText] = useState("Solana");
  const [ethereumText, setEthereumText] = useState("Ethereum");
  const [inlineAuthError, setInlineAuthError] = useState("");
  const [appleButtonState, setAppleButtonState] =
    useState<AppleButtonUiState>("idle");
  const [xButtonState, setXButtonState] = useState<XButtonUiState>("idle");
  const [isPendingXSignInRedirect, setIsPendingXSignInRedirect] =
    useState<boolean>(() => {
      return peekXRedirectResult()?.consentSource === "signin";
    });
  const [isPendingXSignInRedirectStale, setIsPendingXSignInRedirectStale] =
    useState(false);
  const [isSolanaConnecting, setIsSolanaConnecting] = useState(false);
  const [isEthereumConnecting, setIsEthereumConnecting] = useState(false);
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
  const [NotificationComponent, setNotificationComponent] =
    useState<React.ComponentType<any> | null>(null);
  const [isNotificationVisible, setIsNotificationVisible] = useState(false);
  const [notificationState, setNotificationState] =
    useState<NotificationState | null>(null);
  const [isNotificationMounted, setIsNotificationMounted] = useState(false);
  const [notificationDismissType, setNotificationDismissType] = useState<
    "click" | "close" | null
  >(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const notificationTimeoutRef = useRef<number | null>(null);
  const appleIntentRef = useRef<AuthIntentResponse | null>(null);
  const appleIntentPromiseRef = useRef<Promise<AuthIntentResponse> | null>(
    null,
  );
  const appleConfirmExpiryTimeoutRef = useRef<number | null>(null);
  const pendingXSignInStaleTimeoutRef = useRef<number | null>(null);
  const xRedirectNavigationFallbackTimeoutRef = useRef<number | null>(null);
  const xRedirectVisibilityRecoveryHandlerRef = useRef<(() => void) | null>(
    null,
  );
  const logoutReturnFocusIdRef = useRef<string | null>(null);
  const settingsReturnFocusIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const isOpenRef = useRef(isOpen);
  const authStatusRef = useRef(authStatus);
  const latestAppleActionRef = useRef(0);
  const nextSettingsInlineMessageIdRef = useRef(0);
  const shouldReopenSettingsAfterXRedirectRef = useRef(
    peekXRedirectResult()?.consentSource === "settings",
  );

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

  const appleText = getAppleButtonLabel(appleButtonState);
  const xText = getXButtonLabel(xButtonState);
  const isAppleBusy =
    appleButtonState === "preparing" ||
    appleButtonState === "connecting" ||
    appleButtonState === "verifying";
  const isXBusy = xButtonState === "connecting";
  const isPendingXSignInRedirectBlockingUi =
    isPendingXSignInRedirect && !isPendingXSignInRedirectStale;
  const shouldLiftAboveEventModal = isOpen && popupMode === "event";
  const isEventSignInPopup = isOpen && popupMode === "event";

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

  const clearAppleConfirmExpiryTimeout = useCallback(() => {
    if (appleConfirmExpiryTimeoutRef.current) {
      window.clearTimeout(appleConfirmExpiryTimeoutRef.current);
      appleConfirmExpiryTimeoutRef.current = null;
    }
  }, []);

  const clearPendingXSignInStaleTimeout = useCallback(() => {
    if (pendingXSignInStaleTimeoutRef.current !== null) {
      window.clearTimeout(pendingXSignInStaleTimeoutRef.current);
      pendingXSignInStaleTimeoutRef.current = null;
    }
  }, []);

  const clearXRedirectNavigationFallbackTimeout = useCallback(() => {
    if (xRedirectNavigationFallbackTimeoutRef.current !== null) {
      window.clearTimeout(xRedirectNavigationFallbackTimeoutRef.current);
      xRedirectNavigationFallbackTimeoutRef.current = null;
    }
  }, []);

  const clearXRedirectVisibilityRecovery = useCallback(() => {
    if (!xRedirectVisibilityRecoveryHandlerRef.current) {
      return;
    }
    document.removeEventListener(
      "visibilitychange",
      xRedirectVisibilityRecoveryHandlerRef.current,
    );
    xRedirectVisibilityRecoveryHandlerRef.current = null;
  }, []);

  const closeProfileTransientUiForSettingsReopen = useCallback(() => {
    logoutReturnFocusIdRef.current = null;
    closeMenuAndInfoIfAny();
    setIsOpen(false);
    setIsLogoutConfirmOpen(false);
    setIsEditingName(false);
    hideShinyCard();
  }, []);

  const scheduleAppleConfirmExpiryTimeout = useCallback(() => {
    clearAppleConfirmExpiryTimeout();
    const intent = appleIntentRef.current;
    if (!intent) {
      return;
    }
    const msUntilIntentIsStale =
      intent.expiresAtMs - Date.now() - APPLE_INTENT_REFRESH_BUFFER_MS;
    if (msUntilIntentIsStale <= 0) {
      if (isMountedRef.current) {
        setAppleButtonState((current) =>
          current === "confirm" ? "idle" : current,
        );
      }
      return;
    }
    appleConfirmExpiryTimeoutRef.current = window.setTimeout(() => {
      appleConfirmExpiryTimeoutRef.current = null;
      if (!isMountedRef.current) {
        return;
      }
      if (!isAppleIntentUsable(appleIntentRef.current)) {
        setAppleButtonState((current) =>
          current === "confirm" ? "idle" : current,
        );
      }
    }, msUntilIntentIsStale + 50);
  }, [clearAppleConfirmExpiryTimeout]);

  const armPendingXSignInStaleTimeout = useCallback(() => {
    clearPendingXSignInStaleTimeout();
    pendingXSignInStaleTimeoutRef.current = window.setTimeout(() => {
      pendingXSignInStaleTimeoutRef.current = null;
      if (
        !isMountedRef.current ||
        peekXRedirectResult()?.consentSource !== "signin"
      ) {
        return;
      }
      setIsPendingXSignInRedirectStale(true);
    }, STALE_PENDING_X_SIGNIN_DELAY_MS);
  }, [clearPendingXSignInStaleTimeout]);

  const recoverXRedirectNavigationIfStalled = useCallback(() => {
    clearXRedirectNavigationFallbackTimeout();
    clearXRedirectVisibilityRecovery();
    if (!isMountedRef.current || authStatusRef.current === "authenticated") {
      return;
    }
    if (peekXRedirectResult()?.consentSource === "signin") {
      return;
    }
    setXButtonState("idle");
  }, [
    clearXRedirectNavigationFallbackTimeout,
    clearXRedirectVisibilityRecovery,
  ]);

  const scheduleXRedirectNavigationFallback = useCallback(() => {
    clearXRedirectNavigationFallbackTimeout();
    clearXRedirectVisibilityRecovery();
    xRedirectNavigationFallbackTimeoutRef.current = window.setTimeout(() => {
      xRedirectNavigationFallbackTimeoutRef.current = null;
      if (!isMountedRef.current) {
        return;
      }
      if (document.visibilityState === "visible") {
        recoverXRedirectNavigationIfStalled();
        return;
      }
      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") {
          return;
        }
        recoverXRedirectNavigationIfStalled();
      };
      xRedirectVisibilityRecoveryHandlerRef.current = handleVisibilityChange;
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }, X_REDIRECT_NAVIGATION_FALLBACK_DELAY_MS);
  }, [
    clearXRedirectNavigationFallbackTimeout,
    clearXRedirectVisibilityRecovery,
    recoverXRedirectNavigationIfStalled,
  ]);

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
      clearAppleConfirmExpiryTimeout();
      clearPendingXSignInStaleTimeout();
      clearXRedirectNavigationFallbackTimeout();
      clearXRedirectVisibilityRecovery();
      if (notificationTimeoutRef.current) {
        clearTimeout(notificationTimeoutRef.current);
      }
    };
  }, [
    clearAppleConfirmExpiryTimeout,
    clearPendingXSignInStaleTimeout,
    clearXRedirectNavigationFallbackTimeout,
    clearXRedirectVisibilityRecovery,
  ]);

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || authStatus === "authenticated") {
      closePicker();
    }
  }, [isOpen, authStatus, closePicker]);

  useEffect(() => {
    authStatusRef.current = authStatus;
  }, [authStatus]);

  useEffect(() => {
    return subscribeToPendingXRedirectResult((result) => {
      const isPendingSignInRedirect = result?.consentSource === "signin";
      setIsPendingXSignInRedirect(isPendingSignInRedirect);
      if (isPendingSignInRedirect) {
        setIsPendingXSignInRedirectStale(false);
        armPendingXSignInStaleTimeout();
        setInlineAuthError("");
        setIsOpen(false);
        return;
      }
      clearPendingXSignInStaleTimeout();
      setIsPendingXSignInRedirectStale(false);
      if (result?.consentSource === "settings") {
        shouldReopenSettingsAfterXRedirectRef.current = true;
        return;
      }
      if (
        !shouldReopenSettingsAfterXRedirectRef.current ||
        !isMountedRef.current
      ) {
        return;
      }
      shouldReopenSettingsAfterXRedirectRef.current = false;
      closeProfileTransientUiForSettingsReopen();
      setIsSettingsOpen(true);
    });
  }, [
    armPendingXSignInStaleTimeout,
    clearPendingXSignInStaleTimeout,
    closeProfileTransientUiForSettingsReopen,
  ]);

  useEffect(() => {
    if (authStatus === "authenticated" && appleButtonState !== "idle") {
      setAppleButtonState("idle");
      return;
    }
    if (
      authStatus === "authenticated" ||
      !isOpen ||
      appleButtonState !== "confirm"
    ) {
      return;
    }
    if (!isAppleIntentUsable(appleIntentRef.current)) {
      setAppleButtonState("idle");
    }
  }, [authStatus, isOpen, appleButtonState]);

  useEffect(() => {
    if (authStatus === "authenticated" && xButtonState !== "idle") {
      clearXRedirectNavigationFallbackTimeout();
      clearXRedirectVisibilityRecovery();
      setXButtonState("idle");
    }
  }, [
    authStatus,
    clearXRedirectNavigationFallbackTimeout,
    clearXRedirectVisibilityRecovery,
    xButtonState,
  ]);

  useEffect(() => {
    if (appleButtonState !== "confirm") {
      clearAppleConfirmExpiryTimeout();
      return;
    }
    scheduleAppleConfirmExpiryTimeout();
    return clearAppleConfirmExpiryTimeout;
  }, [
    appleButtonState,
    clearAppleConfirmExpiryTimeout,
    scheduleAppleConfirmExpiryTimeout,
  ]);

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
      emojiId: string,
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
      void performLogoutCleanupAndReload();
    };
    const fallbackTimeoutId = window.setTimeout(() => {
      finalizeLogout();
    }, LOGOUT_SIGN_OUT_FALLBACK_DELAY_MS);
    connection
      .signOut()
      .catch(() => {})
      .finally(() => {
        window.clearTimeout(fallbackTimeoutId);
        finalizeLogout();
      });
  };

  const closeProfilePopupInternal = useCallback(() => {
    logoutReturnFocusIdRef.current = null;
    settingsReturnFocusIdRef.current = null;
    didDismissSomethingWithOutsideTapJustNow();
    setIsOpen(false);
    setPopupMode("inline");
    setIsLogoutConfirmOpen(false);
    setIsSettingsOpen(false);
    setSettingsInlineMessage(null);
    setIsEditingName(false);
    hideShinyCard();
  }, []);

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

  const recoverFromStalePendingXSignInRedirect = useCallback(() => {
    clearPendingXSignInStaleTimeout();
    setIsPendingXSignInRedirectStale(false);
    clearConsumedXRedirectResult();
    setInlineAuthError(
      formatXAuthErrorMessage("x-redirect-complete-timeout", "signin"),
    );
  }, [clearPendingXSignInStaleTimeout]);

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
    return registerSignInInlineAuthErrorHandler((message) => {
      if (!isMountedRef.current) {
        return;
      }
      setInlineAuthError(typeof message === "string" ? message : "");
    });
  }, []);

  useEffect(() => {
    const applyFeedback = (feedback: XAuthUiFeedback) => {
      if (!isMountedRef.current) {
        return;
      }
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
    };

    const pendingFeedback = consumePendingXAuthUiFeedback();
    if (pendingFeedback) {
      applyFeedback(pendingFeedback);
    }

    return subscribeToXAuthUiFeedback(applyFeedback);
  }, []);

  useEffect(() => {
    if (isOpen) {
      return;
    }
    setInlineAuthError("");
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

  const ensurePreparedAppleIntent =
    useCallback(async (): Promise<AuthIntentResponse> => {
      if (isAppleIntentUsable(appleIntentRef.current)) {
        return appleIntentRef.current;
      }
      if (!appleIntentPromiseRef.current) {
        const pendingIntentPromise = connection
          .beginAuthIntent("apple")
          .then((intent) => {
            if (appleIntentPromiseRef.current === pendingIntentPromise) {
              appleIntentRef.current = intent;
            }
            return intent;
          })
          .finally(() => {
            if (appleIntentPromiseRef.current === pendingIntentPromise) {
              appleIntentPromiseRef.current = null;
            }
          });
        appleIntentPromiseRef.current = pendingIntentPromise;
      }
      return appleIntentPromiseRef.current;
    }, []);

  const takePreparedAppleIntent = useCallback((): AuthIntentResponse | null => {
    if (!isAppleIntentUsable(appleIntentRef.current)) {
      return null;
    }
    const intent = appleIntentRef.current;
    appleIntentRef.current = null;
    return intent;
  }, []);

  useEffect(() => {
    if (!isOpen || authStatus === "authenticated") {
      return;
    }
    void import("../../connection/solanaConnection").catch(() => {});
    void import("../../connection/ethereumConnection").catch(() => {});
    primeInjectedEthereumProviderDiscovery();
    void preloadAppleSignInLibrary().catch(() => {});
    void ensurePreparedAppleIntent().catch(() => {});
  }, [isOpen, authStatus, ensurePreparedAppleIntent]);

  const handleXClick = async () => {
    if (isXBusy) {
      return;
    }
    clearXRedirectNavigationFallbackTimeout();
    clearXRedirectVisibilityRecovery();
    setInlineAuthError("");
    setXButtonState("connecting");
    let didStartXRedirect = false;
    try {
      const intent = await connection.beginAuthIntent("x");
      await startXRedirectAuth({
        intentId: intent.intentId,
        consentSource: "signin",
      });
    } catch (error) {
      if (isXRedirectStartedError(error)) {
        didStartXRedirect = true;
        if (isMountedRef.current) {
          setInlineAuthError("");
        }
        scheduleXRedirectNavigationFallback();
        return;
      }
      if (!isMountedRef.current) {
        return;
      }
      const cooldownMessage = formatAuthCooldownErrorMessage(error);
      if (cooldownMessage) {
        setInlineAuthError(cooldownMessage);
      } else {
        setInlineAuthError(formatXAuthErrorMessage(error, "signin"));
      }
    } finally {
      if (!didStartXRedirect && isMountedRef.current) {
        clearPendingXSignInStaleTimeout();
        clearXRedirectNavigationFallbackTimeout();
        clearXRedirectVisibilityRecovery();
        setXButtonState("idle");
      }
    }
  };

  const handleSolanaClick = async () => {
    if (isSolanaConnecting) return;

    setInlineAuthError("");
    setIsSolanaConnecting(true);
    try {
      const { connectToSolana } =
        await import("../../connection/solanaConnection");
      const { publicKey, signature, intentId } = await connectToSolana();
      setSolanaText("Verifying...");

      const res = await connection.verifySolanaAddress(
        publicKey,
        signature,
        intentId,
      );
      if (res && res.ok === true) {
        setInlineAuthError("");
        handleLoginSuccess(res, "sol");
        setAuthStatusGlobally("authenticated");
        setIsOpen(false);
        hideShinyCard();
      }

      setSolanaText("Solana");
    } catch (error) {
      const cooldownMessage = formatAuthCooldownErrorMessage(error);
      if (cooldownMessage) {
        setInlineAuthError(cooldownMessage);
      }
      if ((error as Error).message === "not found") {
        setSolanaText("Not Found");
        setTimeout(() => setSolanaText("Solana"), 500);
      } else {
        setSolanaText("Solana");
      }
    } finally {
      setIsSolanaConnecting(false);
    }
  };

  const handleAppleClick = async () => {
    if (isAppleBusy) {
      return;
    }

    setInlineAuthError("");
    const actionId = latestAppleActionRef.current + 1;
    latestAppleActionRef.current = actionId;
    const isActionCurrent = () => latestAppleActionRef.current === actionId;
    const setAppleStateIfMounted = (nextState: AppleButtonUiState) => {
      if (isMountedRef.current && isActionCurrent()) {
        setAppleButtonState(nextState);
      }
    };
    try {
      const intent = takePreparedAppleIntent();
      if (!intent) {
        setAppleStateIfMounted("preparing");
        await Promise.all([
          preloadAppleSignInLibrary(),
          ensurePreparedAppleIntent(),
        ]);
        if (!isActionCurrent()) {
          return;
        }
        if (!isAppleIntentUsable(appleIntentRef.current)) {
          setAppleStateIfMounted("idle");
          return;
        }
        if (isMountedRef.current) {
          if (isOpenRef.current && authStatusRef.current !== "authenticated") {
            setAppleButtonState("confirm");
          } else {
            setAppleButtonState("idle");
          }
        }
        return;
      }
      if (isMountedRef.current && isActionCurrent()) {
        flushSync(() => {
          setAppleButtonState("connecting");
        });
      }
      const signInResult = await signInWithApplePopup({
        nonce: intent.nonce,
        state: intent.state,
        intentId: intent.intentId,
        expiresAtMs: intent.expiresAtMs,
        consentSource: "signin",
      });
      if (!signInResult) {
        setAppleStateIfMounted("idle");
        return;
      }
      if (!isActionCurrent()) {
        return;
      }
      const { idToken } = signInResult;
      setAppleStateIfMounted("verifying");
      const res = await connection.verifyAppleToken(
        intent.intentId,
        idToken,
        "signin",
      );
      if (!isActionCurrent()) {
        return;
      }
      if (res && res.ok === true) {
        setInlineAuthError("");
        handleLoginSuccess(res, "apple");
        setAppleStateIfMounted("idle");
        setAuthStatusGlobally("authenticated");
        setIsOpen(false);
        hideShinyCard();
        return;
      }
      setAppleStateIfMounted("idle");
    } catch (error) {
      console.error("Apple sign in error:", error);
      const cooldownMessage = formatAuthCooldownErrorMessage(error);
      if (cooldownMessage) {
        setInlineAuthError(cooldownMessage);
      }
      setAppleStateIfMounted("idle");
    }
  };

  const handleEthereumClick = async () => {
    if (isEthereumConnecting) return;

    setInlineAuthError("");
    setIsEthereumConnecting(true);
    try {
      const choice = await requestWalletSelection();
      if (choice.status === "cancelled") {
        return;
      }
      const { connectToEthereumAndSign } =
        await import("../../connection/ethereumConnection");
      const { message, signature, intentId } = await connectToEthereumAndSign(
        choice.wallet,
      );
      setEthereumText("Verifying...");

      const res = await connection.verifyEthAddress(
        message,
        signature,
        intentId,
      );
      if (res && res.ok === true) {
        setInlineAuthError("");
        handleLoginSuccess(res, "eth");
        setAuthStatusGlobally("authenticated");
        setIsOpen(false);
        hideShinyCard();
      }

      setEthereumText("Ethereum");
    } catch (error) {
      const cooldownMessage = formatAuthCooldownErrorMessage(error);
      if (cooldownMessage) {
        setInlineAuthError(cooldownMessage);
      }
      if ((error as Error).message === "not found") {
        setEthereumText("Not Found");
        setTimeout(() => setEthereumText("Ethereum"), 500);
      } else {
        setEthereumText("Ethereum");
      }
    } finally {
      setIsEthereumConnecting(false);
    }
  };

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
