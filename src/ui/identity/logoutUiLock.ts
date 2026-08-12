import type { AuthStatus } from "../../connection/authModels";

type LogoutUiLockDependencies = {
  setAuthStatus: (status: AuthStatus) => void;
  performCleanup: (options: { cleanupMode: "thorough" }) => void;
};

export const LOGOUT_UI_RECOVERY_TIMEOUT_MS = 5000;
export const LOGOUT_SIGN_OUT_FALLBACK_DELAY_MS = 700;
export const LOGOUT_UI_LAST_RESORT_UNLOCK_TIMEOUT_MS = 12000;

let logoutUiRecoveryTimeoutId: number | null = null;
let logoutUiLastResortUnlockTimeoutId: number | null = null;
let latestLogoutAttemptId = 0;
let finalizedLogoutAttemptId: number | null = null;
let isLogoutUiLockedGlobal = false;
const logoutUiLockListeners = new Set<(isLocked: boolean) => void>();
let logoutUiLockDependencies: LogoutUiLockDependencies = {
  setAuthStatus: () => {},
  performCleanup: () => {},
};

export const configureLogoutUiLock = (
  dependencies: LogoutUiLockDependencies,
): void => {
  logoutUiLockDependencies = dependencies;
};

const setLogoutUiLocked = (isLocked: boolean) => {
  if (isLogoutUiLockedGlobal === isLocked) {
    return;
  }
  isLogoutUiLockedGlobal = isLocked;
  logoutUiLockListeners.forEach((listener) => {
    try {
      listener(isLocked);
    } catch {}
  });
};

export const isLogoutUiLocked = (): boolean => {
  return isLogoutUiLockedGlobal;
};

export const subscribeToLogoutUiLock = (
  listener: (isLocked: boolean) => void,
): (() => void) => {
  logoutUiLockListeners.add(listener);
  return () => {
    logoutUiLockListeners.delete(listener);
  };
};

export const clearLogoutUiRecoveryTimeout = () => {
  if (logoutUiRecoveryTimeoutId !== null) {
    window.clearTimeout(logoutUiRecoveryTimeoutId);
    logoutUiRecoveryTimeoutId = null;
  }
};

export const clearLogoutUiLastResortUnlockTimeout = () => {
  if (logoutUiLastResortUnlockTimeoutId !== null) {
    window.clearTimeout(logoutUiLastResortUnlockTimeoutId);
    logoutUiLastResortUnlockTimeoutId = null;
  }
};

export const beginLogoutAttempt = (): number => {
  clearLogoutUiRecoveryTimeout();
  clearLogoutUiLastResortUnlockTimeout();
  latestLogoutAttemptId += 1;
  finalizedLogoutAttemptId = null;
  setLogoutUiLocked(true);
  return latestLogoutAttemptId;
};

export const armLogoutUiLastResortUnlockTimeout = (logoutAttemptId: number) => {
  clearLogoutUiLastResortUnlockTimeout();
  logoutUiLastResortUnlockTimeoutId = window.setTimeout(() => {
    logoutUiLastResortUnlockTimeoutId = null;
    if (latestLogoutAttemptId !== logoutAttemptId) {
      return;
    }
    setLogoutUiLocked(false);
    logoutUiLockDependencies.setAuthStatus("unauthenticated");
  }, LOGOUT_UI_LAST_RESORT_UNLOCK_TIMEOUT_MS);
};

export const armLogoutUiRecoveryTimeout = (logoutAttemptId: number) => {
  clearLogoutUiRecoveryTimeout();
  logoutUiRecoveryTimeoutId = window.setTimeout(() => {
    logoutUiRecoveryTimeoutId = null;
    if (latestLogoutAttemptId !== logoutAttemptId) {
      return;
    }
    if (finalizedLogoutAttemptId !== logoutAttemptId) {
      finalizedLogoutAttemptId = logoutAttemptId;
    }
    logoutUiLockDependencies.setAuthStatus("loading");
    armLogoutUiLastResortUnlockTimeout(logoutAttemptId);
    logoutUiLockDependencies.performCleanup({ cleanupMode: "thorough" });
  }, LOGOUT_UI_RECOVERY_TIMEOUT_MS);
};

export const isLatestLogoutAttempt = (logoutAttemptId: number): boolean => {
  return latestLogoutAttemptId === logoutAttemptId;
};

export const didFinalizeLogoutAttempt = (logoutAttemptId: number): boolean => {
  return finalizedLogoutAttemptId === logoutAttemptId;
};

export const markLogoutAttemptFinalized = (
  logoutAttemptId: number,
): boolean => {
  if (!isLatestLogoutAttempt(logoutAttemptId)) {
    return false;
  }
  if (didFinalizeLogoutAttempt(logoutAttemptId)) {
    return false;
  }
  finalizedLogoutAttemptId = logoutAttemptId;
  return true;
};

export const lockLogoutUi = (): void => {
  setLogoutUiLocked(true);
};

export const reconcileLogoutUiLockWithAuthStatus = (
  authStatus: AuthStatus,
): void => {
  if (authStatus === "loading") {
    return;
  }
  clearLogoutUiRecoveryTimeout();
  clearLogoutUiLastResortUnlockTimeout();
  setLogoutUiLocked(false);
};
