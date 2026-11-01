import type {
  AuthIntentResponse,
  AuthMethodKey,
  AuthVerificationResponse,
  LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import type { EIP6963ProviderDetail } from "../../src/connection/injectedEthereumProviders";

type Connection = typeof import("../../src/connection/connection").connection;
type Pending<Value, Data extends object> = Data & {
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
};
type SignedProof = Awaited<
  ReturnType<
    typeof import("../../src/connection/ethereumConnection").connectToEthereumAndSign
  >
> &
  Awaited<
    ReturnType<
      typeof import("../../src/connection/solanaConnection").connectToSolana
    >
  >;
type ConnectCall = Pending<
  SignedProof,
  { method: "eth" | "sol"; wallet?: string }
>;
type VerificationCall = Pending<
  AuthVerificationResponse,
  { method: "eth" | "sol"; args: [string, string, string] }
>;
type IntentCall = Pending<AuthIntentResponse, { method: AuthMethodKey }>;
type RedirectCall = Pending<
  never,
  Parameters<
    typeof import("../../src/connection/xConnection").startXRedirectAuth
  >[0]
>;

const noop = () => {};
const subscribe = () => noop;
const params = new URLSearchParams(location.search);

type XRedirectResult = {
  flowId: string;
  status: "ready" | "failed";
  errorCode: string;
  consentSource: "signin" | "settings";
};
export type XAuthUiFeedback = {
  target: "signin" | "settings";
  kind: "error" | "success";
  message: string;
};
type EventModalState = { isOpen: boolean; eventId: string | null };

export const environment = {
  connectCalls: [] as ConnectCall[],
  verificationCalls: [] as VerificationCall[],
  logins: [] as AuthVerificationResponse[],
  authStatuses: [] as string[],
  linkedReads: 0,
  linkedMethods: { eth: false, sol: false, apple: false, x: false },
  hiddenCards: 0,
  providerReads: 0,
  xIntentCalls: [] as IntentCall[],
  xRedirectCalls: [] as RedirectCall[],
  xPending: params.has("xPendingSource")
    ? ({
        flowId: "pending-flow",
        status: "ready",
        errorCode: "",
        consentSource:
          params.get("xPendingSource") === "settings" ? "settings" : "signin",
      } as XRedirectResult)
    : null,
  xPendingListeners: new Set<(result: XRedirectResult | null) => void>(),
  xFeedback: params.has("xFeedbackTarget")
    ? ({
        target:
          params.get("xFeedbackTarget") === "settings" ? "settings" : "signin",
        kind: params.get("xFeedbackKind") === "success" ? "success" : "error",
        message: params.get("xFeedbackMessage") || "X callback failed.",
      } as XAuthUiFeedback)
    : null,
  xFeedbackListeners: new Set<(feedback: XAuthUiFeedback) => void>(),
  xFeedbackConsumed: 0,
  xFeedbackDeliveries: 0,
  xClearedResults: 0,
  eventModal: {
    isOpen: params.has("eventOpen"),
    eventId: params.has("eventOpen") ? "event-id" : null,
  } as EventModalState,
  eventModalListeners: new Set<(state: EventModalState) => void>(),
  wallets: [
    {
      info: { uuid: "one", rdns: "wallet.one", name: "Wallet One", icon: "" },
      provider: {
        request: async () => {
          throw new Error("unexpected wallet provider request");
        },
      },
    },
    {
      info: { uuid: "two", rdns: "wallet.two", name: "Wallet Two", icon: "" },
      provider: {
        request: async () => {
          throw new Error("unexpected wallet provider request");
        },
      },
    },
  ],
  timers: new Map<number, { callback: () => void; delay: number }>(),
};

const timeout = window.setTimeout.bind(window);
const clearTimeout = window.clearTimeout.bind(window);
let nextTimer = -1;
Reflect.set(
  window,
  "setTimeout",
  (callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (
      [500, 650, 1500, 20_000].includes(delay ?? 0) &&
      typeof callback === "function"
    ) {
      const id = nextTimer--;
      environment.timers.set(id, {
        callback: () => callback(...args),
        delay: delay ?? 0,
      });
      return id;
    }
    return timeout(callback, delay, ...args);
  },
);
window.clearTimeout = (id) => {
  if (typeof id === "number" && id < 0) environment.timers.delete(id);
  else clearTimeout(id);
};

function defer<Value, Data extends object>(
  calls: Pending<Value, Data>[],
  data: Data,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) =>
    calls.push({ ...data, resolve, reject }),
  );
}

export const connectToEthereumAndSign = (
  wallet: EIP6963ProviderDetail | null,
) =>
  defer(environment.connectCalls, {
    method: "eth",
    ...(wallet ? { wallet: wallet.info.name } : {}),
  });
export const connectToSolana = () =>
  defer(environment.connectCalls, { method: "sol" });
export const connection = {
  beginAuthIntent: (method: AuthMethodKey) =>
    defer(environment.xIntentCalls, { method }),
  verifyEthAddress: (...args: Parameters<Connection["verifyEthAddress"]>) =>
    defer(environment.verificationCalls, { method: "eth", args }),
  verifySolanaAddress: (
    ...args: Parameters<Connection["verifySolanaAddress"]>
  ) => defer(environment.verificationCalls, { method: "sol", args }),
  getLinkedAuthMethods: async (): Promise<LinkedAuthMethodsResponse> => {
    environment.linkedReads += 1;
    return {
      ok: true,
      profileId: "profile",
      appleLinked: environment.linkedMethods.apple,
      linkedMethods: { ...environment.linkedMethods },
    };
  },
  isCurrentAuthUser: () => true,
};
export const handleLoginSuccess = (result: AuthVerificationResponse) => {
  environment.logins.push(result);
  return true;
};
export const setAuthStatusGlobally = (status: string) =>
  environment.authStatuses.push(status);
export const storage = {
  getLoginId: () => "viewer",
  getProfileId: () => "profile",
  getUsername: () => "Player",
  getEthAddress: () => "",
  getSolAddress: () => "",
};
export const primeInjectedEthereumProviderDiscovery = noop;
export const listInjectedEthereumProviders = async () => {
  environment.providerReads += 1;
  return environment.wallets;
};
export const getInjectedWalletIconSrc = () => null;
export const useAppleAuthFlow = () => ({
  state: "idle",
  start: noop,
  resetUi: noop,
  invalidateAction: noop,
  clearIntent: noop,
});
export const clearAppleSignInTransientState = noop;
export const setPendingXRedirectResult = (result: XRedirectResult | null) => {
  environment.xPending = result;
  environment.xPendingListeners.forEach((listener) => listener(result));
};
export const clearConsumedXRedirectResult = () => {
  environment.xClearedResults += 1;
  setPendingXRedirectResult(null);
};
export const isXRedirectStartedError = (error: unknown) =>
  error instanceof Error && error.message === "x-redirect-started";
export const peekXRedirectResult = () => environment.xPending;
export const startXRedirectAuth = (
  options: Parameters<
    typeof import("../../src/connection/xConnection").startXRedirectAuth
  >[0],
) => defer(environment.xRedirectCalls, options);
export const subscribeToPendingXRedirectResult = (
  listener: (result: XRedirectResult | null) => void,
) => {
  environment.xPendingListeners.add(listener);
  listener(environment.xPending);
  return () => environment.xPendingListeners.delete(listener);
};
export const consumePendingXAuthUiFeedback = () => {
  const feedback = environment.xFeedback;
  environment.xFeedback = null;
  if (feedback) environment.xFeedbackConsumed += 1;
  return feedback;
};
export const subscribeToXAuthUiFeedback = (
  listener: (feedback: XAuthUiFeedback) => void,
) => {
  environment.xFeedbackListeners.add(listener);
  return () => environment.xFeedbackListeners.delete(listener);
};
export const publishXAuthUiFeedback = (feedback: XAuthUiFeedback) => {
  environment.xFeedback = feedback;
  if (environment.xFeedbackListeners.size === 0) return;
  environment.xFeedbackListeners.forEach((listener) => {
    environment.xFeedbackDeliveries += 1;
    listener(feedback);
  });
  environment.xFeedback = null;
};
export const markAuthNameCommitted = subscribe;
export const notifyVerifiedProfileNameCommitted = subscribe;
export const performLogoutCleanupAndReload = async () => {};
export const reloadAfterLogout = noop;
export const notifyOtherTabsAboutSignIn = noop;
export const resetNftCache = noop;
export const NameEditModal = () => null;
export const LogoutConfirmModal = () => null;
export const isMobile = new URLSearchParams(location.search).has("mobile");
export const defaultEarlyInputEventName = isMobile ? "touchstart" : "mousedown";
export const hideShinyCard = () => (environment.hiddenCards += 1);
export const showShinyCard = noop;
export const showsShinyCardSomewhere = false;
export const updateShinyCardDisplayName = noop;

export const EVENT_MODAL_AUTH_Z_INDEX = 100101;
export const getEventModalState = () => environment.eventModal;
export const subscribeToEventModalState = (
  listener: (state: EventModalState) => void,
) => {
  environment.eventModalListeners.add(listener);
  return () => environment.eventModalListeners.delete(listener);
};
export const setEventModalState = (isOpen: boolean) => {
  environment.eventModal = { isOpen, eventId: isOpen ? "event-id" : null };
  environment.eventModalListeners.forEach((listener) =>
    listener(environment.eventModal),
  );
};
