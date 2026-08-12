export type AuthIntentResponse = {
  ok: boolean;
  intentId: string;
  nonce: string;
  state: string;
  expiresAtMs: number;
};

export type AppleButtonUiState =
  "idle" | "preparing" | "confirm" | "connecting" | "verifying";

export type XButtonUiState = "idle" | "connecting";

export const APPLE_INTENT_REFRESH_BUFFER_MS = 30 * 1000;

export const isAppleIntentUsable = (
  intent: AuthIntentResponse | null,
  nowMs = Date.now(),
): intent is AuthIntentResponse => {
  if (!intent) {
    return false;
  }
  return (
    typeof intent.intentId === "string" &&
    intent.intentId !== "" &&
    typeof intent.nonce === "string" &&
    intent.nonce !== "" &&
    typeof intent.state === "string" &&
    intent.state !== "" &&
    typeof intent.expiresAtMs === "number" &&
    Number.isFinite(intent.expiresAtMs) &&
    intent.expiresAtMs - nowMs > APPLE_INTENT_REFRESH_BUFFER_MS
  );
};

export const getAppleButtonLabel = (state: AppleButtonUiState): string => {
  if (state === "preparing") {
    return "Preparing...";
  }
  if (state === "verifying") {
    return "Verifying...";
  }
  return "Apple";
};

export const getXButtonLabel = (state: XButtonUiState): string => {
  return state === "connecting" ? "Connecting..." : "X";
};

let isSettingsAppleFlowInProgress = false;
const settingsAppleFlowListeners = new Set<(inProgress: boolean) => void>();

export const getSettingsAppleFlowInProgress = (): boolean => {
  return isSettingsAppleFlowInProgress;
};

export const setSettingsAppleFlowInProgress = (inProgress: boolean): void => {
  if (isSettingsAppleFlowInProgress === inProgress) {
    return;
  }
  isSettingsAppleFlowInProgress = inProgress;
  settingsAppleFlowListeners.forEach((listener) => {
    try {
      listener(inProgress);
    } catch {}
  });
};

export const subscribeSettingsAppleFlowProgress = (
  listener: (inProgress: boolean) => void,
): (() => void) => {
  settingsAppleFlowListeners.add(listener);
  return () => {
    settingsAppleFlowListeners.delete(listener);
  };
};
