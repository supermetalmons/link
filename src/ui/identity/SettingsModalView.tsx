import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AuthVerificationResponse } from "@mons/shared/auth";
import { flushSync } from "react-dom";
import styled from "styled-components";
import {
  ModalOverlay,
  ModalPopup,
  ModalTitle,
  ButtonsContainer,
  SaveButton,
  handleModalKeyDown,
} from "../SharedModalComponents";
import { connection } from "../../connection/connection";
import { formatAuthCooldownErrorMessage } from "../../connection/authCooldownErrors";
import { storage } from "../../utils/storage";
import { updateProfileDisplayName } from "./profileUiPort";
import { handleLoginSuccess } from "../../connection/loginSuccess";
import { setAuthStatusGlobally } from "../../connection/authentication";
import { useEthereumWalletPicker } from "../EthereumWalletPicker";
import { primeInjectedEthereumProviderDiscovery } from "../../connection/injectedEthereumProviders";
import {
  clearAppleSignInTransientState,
  preloadAppleSignInLibrary,
  signInWithApplePopup,
} from "../../connection/appleConnection";
import {
  isXRedirectStartedError,
  startXRedirectAuth,
} from "../../connection/xConnection";
import { formatXAuthErrorMessage } from "../../connection/xAuthErrors";
import { isMobile } from "../../utils/misc";
import { notifyOtherTabsAboutSignIn } from "../../session/logoutOrchestrator";
import { resetNftCache } from "../../services/nftCache";
import {
  type AppleButtonUiState,
  type AuthIntentResponse,
  APPLE_INTENT_REFRESH_BUFFER_MS,
  getSettingsAppleFlowInProgress,
  isAppleIntentUsable,
  setSettingsAppleFlowInProgress,
  subscribeSettingsAppleFlowProgress,
} from "./authFlowState";

const SettingsPopup = styled(ModalPopup)`
  padding: 20px;
  outline: none;
  max-width: 360px;
`;

const SettingsTitle = styled(ModalTitle)`
  margin-bottom: 8px;
  text-align: left;
`;

const MethodsList = styled.div`
  display: flex;
  flex-direction: column;
  margin-bottom: 12px;
  border-radius: 12px;
  border: 1px solid rgba(224, 224, 224, 0.45);
  overflow: hidden;
  background: var(--color-gray-f9);

  @media (prefers-color-scheme: dark) {
    border-color: rgba(68, 68, 68, 0.45);
    background: var(--color-gray-27);
  }
`;

const MethodRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  min-height: 34px;

  & + & {
    border-top: 1px solid rgba(224, 224, 224, 0.45);
  }

  @media (prefers-color-scheme: dark) {
    & + & {
      border-top-color: rgba(68, 68, 68, 0.45);
    }
  }
`;

const MethodMeta = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
`;

const MethodName = styled.div<{ $linked: boolean }>`
  font-size: 0.82rem;
  font-weight: 600;
  color: ${(props) =>
    props.$linked ? "var(--color-gray-33)" : "var(--color-gray-99)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$linked ? "var(--color-gray-f0)" : "var(--color-gray-77)"};
  }
`;

const RowActions = styled.div`
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-width: 76px;
`;

const ActionSpacer = styled.div`
  width: 72px;
  height: 22px;
`;

const ConnectButton = styled.button<{ $message?: boolean }>`
  border: none;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  color: ${(props) =>
    props.$message ? "var(--color-gray-33)" : "var(--color-blue-primary)"};
  background: var(--color-gray-f0);
  min-width: 76px;
  text-align: center;
  white-space: nowrap;
  transition: background-color 0.3s ease;
  -webkit-tap-highlight-color: transparent;

  &:disabled {
    opacity: 0.55;
    cursor: default;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background: var(--color-gray-e0);
    }
  }

  &:active:not(:disabled) {
    background: var(--color-gray-d0);
  }

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$message
        ? "var(--color-gray-f0)"
        : "var(--color-blue-primary-dark)"};
    background: var(--color-gray-33);

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background: var(--color-gray-44);
      }
    }

    &:active:not(:disabled) {
      background: var(--color-gray-55);
    }
  }
`;

const RemoveIconButton = styled.button`
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: none;
  background: var(--color-gray-f0);
  color: var(--color-gray-77);
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  transition: background-color 0.3s ease;
  -webkit-tap-highlight-color: transparent;

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background: var(--color-gray-e0);
    }
  }

  &:active:not(:disabled) {
    background: var(--color-gray-d0);
  }

  &:disabled {
    opacity: 0.55;
    cursor: default;
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-33);
    color: var(--color-gray-a0);

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background: var(--color-gray-44);
      }
    }

    &:active:not(:disabled) {
      background: var(--color-gray-55);
    }
  }
`;

const ConnectIconButton = styled(RemoveIconButton)`
  color: var(--color-blue-primary);

  @media (prefers-color-scheme: dark) {
    color: var(--color-blue-primary-dark);
  }
`;

const RemoveConfirmButton = styled.button`
  border: none;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  color: var(--color-white);
  background: var(--dangerButtonBackground);
  min-width: 76px;
  text-align: center;
  white-space: nowrap;

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background: var(--dangerButtonBackgroundHover);
    }
  }

  &:active:not(:disabled) {
    background: var(--dangerButtonBackgroundActive);
  }

  &:disabled {
    opacity: 0.55;
    cursor: default;
  }

  @media (prefers-color-scheme: dark) {
    background: var(--dangerButtonBackgroundDark);

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background: var(--dangerButtonBackgroundHoverDark);
      }
    }

    &:active:not(:disabled) {
      background: var(--dangerButtonBackgroundActiveDark);
    }
  }
`;

const InlineAuthError = styled.div`
  border-radius: 8px;
  background: rgba(220, 53, 69, 0.08);
  color: var(--dangerButtonBackground);
  font-size: 0.74rem;
  line-height: 1.35;
  padding: 8px 10px;
  margin-bottom: 12px;
  text-align: left;

  @media (prefers-color-scheme: dark) {
    background: rgba(220, 53, 69, 0.22);
    color: var(--dangerButtonBackgroundDark);
  }
`;

type MethodKey = "apple" | "eth" | "sol" | "x";
type NonAppleMethodKey = Exclude<MethodKey, "apple">;
type LinkedMethods = Record<MethodKey, boolean>;
type PendingDisconnectStep = "remove" | "confirm";
type PendingDisconnectState = {
  method: MethodKey;
  step: PendingDisconnectStep;
};

const EMPTY_LINKED_METHODS: LinkedMethods = {
  apple: false,
  eth: false,
  sol: false,
  x: false,
};

interface SettingsModalProps {
  onClose: () => void;
  xInlineMessage?: { id: number; message: string } | null;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  onClose,
  xInlineMessage = null,
}) => {
  const popupRef = useRef<HTMLDivElement>(null);
  const [linkedMethods, setLinkedMethods] =
    useState<LinkedMethods>(EMPTY_LINKED_METHODS);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [busyMethod, setBusyMethod] = useState<MethodKey | null>(null);
  const [appleButtonState, setAppleButtonState] =
    useState<AppleButtonUiState>("idle");
  const [pendingDisconnectState, setPendingDisconnectState] =
    useState<PendingDisconnectState | null>(null);
  const [solanaConnectText, setSolanaConnectText] = useState<string>("Connect");
  const [ethConnectText, setEthConnectText] = useState<string>("Connect");
  const { requestWalletSelection, pickerElement } = useEthereumWalletPicker();
  const [isGlobalAppleFlowInProgress, setIsGlobalAppleFlowInProgress] =
    useState<boolean>(getSettingsAppleFlowInProgress);
  const [authMessage, setAuthMessage] = useState<string>(
    () => xInlineMessage?.message ?? "",
  );
  const appleIntentRef = useRef<AuthIntentResponse | null>(null);
  const appleIntentPromiseRef = useRef<Promise<AuthIntentResponse> | null>(
    null,
  );
  const isMountedRef = useRef(true);
  const latestAppleActionRef = useRef(0);
  const previousGlobalAppleFlowRef = useRef(getSettingsAppleFlowInProgress());
  const appleConfirmExpiryTimeoutRef = useRef<number | null>(null);
  const pendingDisconnectTimeoutRef = useRef<number | null>(null);
  const solanaNotFoundTimeoutRef = useRef<number | null>(null);
  const ethNotFoundTimeoutRef = useRef<number | null>(null);
  const hasLoadedLinkedMethodsRef = useRef(false);
  const shouldRefreshAfterAppleFlowLoadRef = useRef(false);
  const appliedXInlineMessageIdRef = useRef<number | null>(
    xInlineMessage?.id ?? null,
  );

  const linkedCount = useMemo(() => {
    return Object.values(linkedMethods).filter(Boolean).length;
  }, [linkedMethods]);

  const refreshLinkedMethods = useCallback(async () => {
    const shouldShowLoading = !hasLoadedLinkedMethodsRef.current;
    if (shouldShowLoading) {
      setIsLoading(true);
    }
    try {
      const data = await connection.getLinkedAuthMethods();
      const linked =
        data && data.linkedMethods ? data.linkedMethods : EMPTY_LINKED_METHODS;
      setLinkedMethods({
        apple: !!linked.apple,
        eth: !!linked.eth,
        sol: !!linked.sol,
        x: !!linked.x,
      });
    } catch (error) {
      console.error("Failed to fetch linked methods:", error);
    } finally {
      if (shouldShowLoading) {
        hasLoadedLinkedMethodsRef.current = true;
        setIsLoading(false);
      }
    }
  }, []);

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

  const clearAppleConfirmExpiryTimeout = useCallback(() => {
    if (appleConfirmExpiryTimeoutRef.current) {
      window.clearTimeout(appleConfirmExpiryTimeoutRef.current);
      appleConfirmExpiryTimeoutRef.current = null;
    }
  }, []);

  const clearSolanaNotFoundTimeout = useCallback(() => {
    if (solanaNotFoundTimeoutRef.current !== null) {
      window.clearTimeout(solanaNotFoundTimeoutRef.current);
      solanaNotFoundTimeoutRef.current = null;
    }
  }, []);

  const clearEthNotFoundTimeout = useCallback(() => {
    if (ethNotFoundTimeoutRef.current !== null) {
      window.clearTimeout(ethNotFoundTimeoutRef.current);
      ethNotFoundTimeoutRef.current = null;
    }
  }, []);

  const clearPendingDisconnectTimeout = useCallback(() => {
    if (pendingDisconnectTimeoutRef.current !== null) {
      window.clearTimeout(pendingDisconnectTimeoutRef.current);
      pendingDisconnectTimeoutRef.current = null;
    }
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

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearAppleConfirmExpiryTimeout();
      clearPendingDisconnectTimeout();
      clearSolanaNotFoundTimeout();
      clearEthNotFoundTimeout();
    };
  }, [
    clearAppleConfirmExpiryTimeout,
    clearPendingDisconnectTimeout,
    clearSolanaNotFoundTimeout,
    clearEthNotFoundTimeout,
  ]);

  useEffect(() => {
    if (
      pendingDisconnectState &&
      !linkedMethods[pendingDisconnectState.method]
    ) {
      setPendingDisconnectState(null);
    }
  }, [linkedMethods, pendingDisconnectState]);

  useEffect(() => {
    clearPendingDisconnectTimeout();
    if (
      !pendingDisconnectState ||
      busyMethod === pendingDisconnectState.method
    ) {
      return;
    }
    const { method, step } = pendingDisconnectState;
    pendingDisconnectTimeoutRef.current = window.setTimeout(() => {
      pendingDisconnectTimeoutRef.current = null;
      setPendingDisconnectState((current) => {
        if (!current) {
          return current;
        }
        if (current.method !== method || current.step !== step) {
          return current;
        }
        return null;
      });
    }, 1500);
    return clearPendingDisconnectTimeout;
  }, [busyMethod, clearPendingDisconnectTimeout, pendingDisconnectState]);

  useEffect(() => {
    if (solanaConnectText !== "Not Found") {
      clearSolanaNotFoundTimeout();
      return;
    }
    clearSolanaNotFoundTimeout();
    solanaNotFoundTimeoutRef.current = window.setTimeout(() => {
      solanaNotFoundTimeoutRef.current = null;
      setSolanaConnectText("Connect");
    }, 650);
    return clearSolanaNotFoundTimeout;
  }, [clearSolanaNotFoundTimeout, solanaConnectText]);

  useEffect(() => {
    if (ethConnectText !== "Not Found") {
      clearEthNotFoundTimeout();
      return;
    }
    clearEthNotFoundTimeout();
    ethNotFoundTimeoutRef.current = window.setTimeout(() => {
      ethNotFoundTimeoutRef.current = null;
      setEthConnectText("Connect");
    }, 650);
    return clearEthNotFoundTimeout;
  }, [clearEthNotFoundTimeout, ethConnectText]);

  useEffect(() => {
    return subscribeSettingsAppleFlowProgress((inProgress) => {
      if (isMountedRef.current) {
        setIsGlobalAppleFlowInProgress(inProgress);
      }
    });
  }, []);

  useEffect(() => {
    if (popupRef.current) {
      popupRef.current.focus();
    }
    void refreshLinkedMethods();
  }, [refreshLinkedMethods]);

  useEffect(() => {
    if (
      !xInlineMessage ||
      appliedXInlineMessageIdRef.current === xInlineMessage.id
    ) {
      return;
    }
    appliedXInlineMessageIdRef.current = xInlineMessage.id;
    setAuthMessage(xInlineMessage.message);
  }, [xInlineMessage]);

  useEffect(() => {
    if (isLoading || linkedMethods.apple) {
      return;
    }
    void preloadAppleSignInLibrary().catch(() => {});
    void ensurePreparedAppleIntent().catch(() => {});
  }, [isLoading, linkedMethods.apple, ensurePreparedAppleIntent]);

  useEffect(() => {
    if (isLoading) {
      return;
    }
    if (!linkedMethods.eth) {
      void import("../../connection/ethereumConnection").catch(() => {});
      primeInjectedEthereumProviderDiscovery();
    }
    if (!linkedMethods.sol) {
      void import("../../connection/solanaConnection").catch(() => {});
    }
  }, [isLoading, linkedMethods.eth, linkedMethods.sol]);

  useEffect(() => {
    if (!linkedMethods.apple) {
      return;
    }
    latestAppleActionRef.current += 1;
    clearAppleConfirmExpiryTimeout();
    setAppleButtonState("idle");
  }, [clearAppleConfirmExpiryTimeout, linkedMethods.apple]);

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
    const wasInProgress = previousGlobalAppleFlowRef.current;
    previousGlobalAppleFlowRef.current = isGlobalAppleFlowInProgress;
    if (
      !wasInProgress ||
      isGlobalAppleFlowInProgress ||
      busyMethod === "apple"
    ) {
      return;
    }
    if (isLoading) {
      shouldRefreshAfterAppleFlowLoadRef.current = true;
      return;
    }
    void refreshLinkedMethods();
  }, [
    busyMethod,
    isGlobalAppleFlowInProgress,
    isLoading,
    refreshLinkedMethods,
  ]);

  useEffect(() => {
    if (isLoading || !shouldRefreshAfterAppleFlowLoadRef.current) {
      return;
    }
    shouldRefreshAfterAppleFlowLoadRef.current = false;
    void refreshLinkedMethods();
  }, [isLoading, refreshLinkedMethods]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    handleModalKeyDown(e, popupRef.current, onClose);
    if (
      !e.defaultPrevented &&
      e.key === "Enter" &&
      e.target === e.currentTarget
    ) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const runConnectFlow = useCallback(
    async (method: NonAppleMethodKey) => {
      setAuthMessage("");
      setBusyMethod(method);
      let didStartXRedirect = false;
      try {
        let result: AuthVerificationResponse | null = null;
        if (method === "eth") {
          const choice = await requestWalletSelection();
          if (choice.status === "cancelled") {
            return;
          }
          const { connectToEthereumAndSign } =
            await import("../../connection/ethereumConnection");
          const { message, signature, intentId } =
            await connectToEthereumAndSign(choice.wallet);
          clearEthNotFoundTimeout();
          result = await connection.verifyEthAddress(
            message,
            signature,
            intentId,
          );
        } else if (method === "sol") {
          const { connectToSolana } =
            await import("../../connection/solanaConnection");
          const { publicKey, signature, intentId } = await connectToSolana();
          clearSolanaNotFoundTimeout();
          result = await connection.verifySolanaAddress(
            publicKey,
            signature,
            intentId,
          );
        } else if (method === "x") {
          const intent = await connection.beginAuthIntent("x");
          didStartXRedirect = true;
          await startXRedirectAuth({
            intentId: intent.intentId,
            consentSource: "settings",
          });
        }
        if (!isMountedRef.current) {
          return;
        }

        if (result && result.ok === true && handleLoginSuccess(result)) {
          setAuthMessage("");
          setAuthStatusGlobally("authenticated");
        }
        if (method === "sol") {
          setSolanaConnectText("Connect");
        }
        if (method === "eth") {
          setEthConnectText("Connect");
        }
      } catch (error) {
        console.error(`Failed to connect ${method}:`, error);
        if (!isMountedRef.current) {
          return;
        }
        const cooldownMessage = formatAuthCooldownErrorMessage(error);
        if (cooldownMessage) {
          setAuthMessage(cooldownMessage);
        } else if (method === "x") {
          if (isXRedirectStartedError(error)) {
            setAuthMessage("");
          } else {
            setAuthMessage(formatXAuthErrorMessage(error, "link"));
          }
        }
        if (method === "sol") {
          const errorMessage = error instanceof Error ? error.message : "";
          if (errorMessage === "not found") {
            setSolanaConnectText("Not Found");
          } else {
            setSolanaConnectText("Connect");
          }
        }
        if (method === "eth") {
          const errorMessage = error instanceof Error ? error.message : "";
          if (errorMessage === "not found") {
            setEthConnectText("Not Found");
          } else {
            setEthConnectText("Connect");
          }
        }
      } finally {
        if (didStartXRedirect) {
          if (isMountedRef.current) {
            setBusyMethod(null);
          }
        } else if (isMountedRef.current) {
          setBusyMethod(null);
          await refreshLinkedMethods();
        }
      }
    },
    [
      clearEthNotFoundTimeout,
      clearSolanaNotFoundTimeout,
      refreshLinkedMethods,
      requestWalletSelection,
    ],
  );

  const runAppleConnectFlow = useCallback(async () => {
    if (isLoading || busyMethod !== null) {
      return;
    }
    if (getSettingsAppleFlowInProgress()) {
      return;
    }

    setAuthMessage("");
    const actionId = latestAppleActionRef.current + 1;
    latestAppleActionRef.current = actionId;
    const isActionCurrent = () => latestAppleActionRef.current === actionId;
    const setAppleUiIfMounted = (nextState: AppleButtonUiState) => {
      if (!isMountedRef.current || !isActionCurrent()) {
        return;
      }
      setAppleButtonState(nextState);
    };

    const intent = takePreparedAppleIntent();
    if (!intent) {
      setAppleUiIfMounted("preparing");
      try {
        await Promise.all([
          preloadAppleSignInLibrary(),
          ensurePreparedAppleIntent(),
        ]);
        if (!isActionCurrent()) {
          return;
        }
        if (!isAppleIntentUsable(appleIntentRef.current)) {
          setAppleUiIfMounted("idle");
          return;
        }
        if (isMountedRef.current && isActionCurrent()) {
          setAppleButtonState("confirm");
        }
      } catch (error) {
        console.error("Failed to prepare apple sign in:", error);
        setAppleUiIfMounted("idle");
      }
      return;
    }

    setSettingsAppleFlowInProgress(true);
    if (isMountedRef.current && isActionCurrent()) {
      flushSync(() => {
        setBusyMethod("apple");
        setAppleButtonState("connecting");
      });
    }
    try {
      const signInResult = await signInWithApplePopup({
        nonce: intent.nonce,
        state: intent.state,
        intentId: intent.intentId,
        expiresAtMs: intent.expiresAtMs,
        consentSource: "settings",
      });
      if (!isActionCurrent()) {
        return;
      }
      if (!signInResult) {
        setAppleUiIfMounted("idle");
        return;
      }
      const { idToken } = signInResult;
      setAppleUiIfMounted("verifying");
      const result = await connection.verifyAppleToken(
        intent.intentId,
        idToken,
        "settings",
      );
      if (!isActionCurrent()) {
        return;
      }
      if (result && result.ok === true && handleLoginSuccess(result)) {
        setAuthMessage("");
        setAuthStatusGlobally("authenticated");
      }
    } catch (error) {
      console.error("Failed to connect apple:", error);
      const cooldownMessage = formatAuthCooldownErrorMessage(error);
      if (cooldownMessage) {
        setAuthMessage(cooldownMessage);
      }
    } finally {
      setSettingsAppleFlowInProgress(false);
      if (isActionCurrent() && isMountedRef.current) {
        setBusyMethod((current) => (current === "apple" ? null : current));
        setAppleButtonState("idle");
        await refreshLinkedMethods();
      }
    }
  }, [
    busyMethod,
    ensurePreparedAppleIntent,
    isLoading,
    refreshLinkedMethods,
    takePreparedAppleIntent,
  ]);

  const handleConnectClick = useCallback(
    (method: MethodKey) => {
      setPendingDisconnectState(null);
      if (method === "apple") {
        void runAppleConnectFlow();
        return;
      }
      void runConnectFlow(method);
    },
    [runAppleConnectFlow, runConnectFlow],
  );

  const runDisconnectFlow = useCallback(
    async (method: MethodKey) => {
      setAuthMessage("");
      setPendingDisconnectState({ method, step: "confirm" });
      setBusyMethod(method);
      try {
        const result = (await connection.unlinkAuthMethod(method)).read();
        if (result && result.ok === true) {
          if (method === "eth") {
            storage.setEthAddress("");
          }
          if (method === "sol") {
            storage.setSolAddress("");
          }
          if (method === "apple") {
            clearAppleSignInTransientState();
            appleIntentRef.current = null;
            appleIntentPromiseRef.current = null;
          }
          updateProfileDisplayName(
            storage.getUsername(""),
            storage.getEthAddress(""),
            storage.getSolAddress(""),
          );
          if (method === "eth" || method === "sol") {
            resetNftCache();
            storage.setReactionExtraStickerCache(null);
            setAuthStatusGlobally("authenticated");
            notifyOtherTabsAboutSignIn(
              storage.getProfileId(""),
              storage.getLoginId(""),
            );
          }
        }
      } catch (error) {
        console.error(`Failed to unlink ${method}:`, error);
      } finally {
        setPendingDisconnectState(null);
        await refreshLinkedMethods();
        setBusyMethod((current) => (current === method ? null : current));
      }
    },
    [refreshLinkedMethods],
  );

  const renderMethodRow = (method: MethodKey, label: string) => {
    const isLinked = linkedMethods[method];
    const isBusy = busyMethod === method;
    const isAppleMethod = method === "apple";
    const isOtherMethodBusy = busyMethod !== null && busyMethod !== method;
    const isApplePreparing = appleButtonState === "preparing";
    const isAppleBusyState =
      isGlobalAppleFlowInProgress ||
      appleButtonState === "connecting" ||
      appleButtonState === "verifying";
    const disableConnect = isAppleMethod
      ? isLoading ||
        isBusy ||
        isOtherMethodBusy ||
        isApplePreparing ||
        isAppleBusyState
      : isLoading || isBusy || busyMethod !== null;
    const disableDisconnect =
      isLoading || isBusy || busyMethod !== null || linkedCount <= 1;
    const connectText =
      method === "sol"
        ? solanaConnectText
        : method === "eth"
          ? ethConnectText
          : "Connect";
    const showDisconnectControl = isLinked;
    const pendingDisconnectStep =
      pendingDisconnectState?.method === method
        ? pendingDisconnectState.step
        : null;
    const handleConnectPress = () => {
      if (disableConnect) {
        return;
      }
      handleConnectClick(method);
    };
    const handleDisconnectReveal = () => {
      if (!showDisconnectControl || disableDisconnect) {
        return;
      }
      setPendingDisconnectState((current) => {
        if (current && current.method === method) {
          return null;
        }
        return { method, step: "remove" };
      });
    };
    const handleDisconnectAdvance = () => {
      if (disableDisconnect) {
        return;
      }
      setPendingDisconnectState({ method, step: "confirm" });
    };
    const handleDisconnectPress = () => {
      if (disableDisconnect) {
        return;
      }
      void runDisconnectFlow(method);
    };
    const connectOnClick = isAppleMethod
      ? handleConnectPress
      : !isMobile
        ? handleConnectPress
        : undefined;
    const connectOnTouchEnd =
      !isAppleMethod && isMobile ? handleConnectPress : undefined;
    const disconnectRevealOnClick = !isMobile
      ? handleDisconnectReveal
      : undefined;
    const disconnectRevealOnTouchEnd = isMobile
      ? handleDisconnectReveal
      : undefined;
    const disconnectAdvanceOnClick = !isMobile
      ? handleDisconnectAdvance
      : undefined;
    const disconnectAdvanceOnTouchEnd = isMobile
      ? handleDisconnectAdvance
      : undefined;
    const disconnectOnClick = !isMobile ? handleDisconnectPress : undefined;
    const disconnectOnTouchEnd = isMobile ? handleDisconnectPress : undefined;
    return (
      <MethodRow key={method}>
        <MethodMeta>
          <MethodName $linked={!isLoading && isLinked}>{label}</MethodName>
        </MethodMeta>
        <RowActions>
          {isLoading ? (
            <ActionSpacer />
          ) : isLinked ? (
            showDisconnectControl ? (
              isBusy ? (
                <RemoveConfirmButton disabled={true}>
                  Removing...
                </RemoveConfirmButton>
              ) : pendingDisconnectStep === "remove" ? (
                <RemoveConfirmButton
                  disabled={disableDisconnect}
                  onClick={disconnectAdvanceOnClick}
                  onTouchEnd={disconnectAdvanceOnTouchEnd}
                >
                  Remove
                </RemoveConfirmButton>
              ) : pendingDisconnectStep === "confirm" ? (
                <RemoveConfirmButton
                  disabled={disableDisconnect}
                  onClick={disconnectOnClick}
                  onTouchEnd={disconnectOnTouchEnd}
                >
                  Confirm
                </RemoveConfirmButton>
              ) : (
                <RemoveIconButton
                  disabled={disableDisconnect}
                  onClick={disconnectRevealOnClick}
                  onTouchEnd={disconnectRevealOnTouchEnd}
                >
                  ×
                </RemoveIconButton>
              )
            ) : (
              <ActionSpacer />
            )
          ) : connectText !== "Connect" ? (
            <ConnectButton disabled={true} $message={true}>
              {connectText}
            </ConnectButton>
          ) : (
            <ConnectIconButton
              disabled={disableConnect}
              onClick={connectOnClick}
              onTouchEnd={connectOnTouchEnd}
            >
              +
            </ConnectIconButton>
          )}
        </RowActions>
      </MethodRow>
    );
  };

  return (
    <ModalOverlay onClick={onClose}>
      <SettingsPopup
        ref={popupRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
      >
        <SettingsTitle id="settings-dialog-title">Settings</SettingsTitle>
        <MethodsList>
          {renderMethodRow("eth", "Ethereum")}
          {renderMethodRow("sol", "Solana")}
          {renderMethodRow("apple", "Apple")}
          {renderMethodRow("x", "X")}
        </MethodsList>
        {authMessage ? <InlineAuthError>{authMessage}</InlineAuthError> : null}
        <ButtonsContainer>
          <SaveButton disabled={false} onClick={onClose}>
            OK
          </SaveButton>
        </ButtonsContainer>
        {pickerElement}
      </SettingsPopup>
    </ModalOverlay>
  );
};
