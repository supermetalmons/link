const noop = () => {};
const subscribe = () => noop;

export const environment = {
  connectCalls: [] as any[],
  verificationCalls: [] as any[],
  logins: [] as any[],
  authStatuses: [] as string[],
  linkedReads: 0,
  linkedMethods: { eth: false, sol: false, apple: false, x: false },
  hiddenCards: 0,
  providerReads: 0,
  wallets: [
    {
      info: { uuid: "one", rdns: "wallet.one", name: "Wallet One", icon: "" },
      provider: {},
    },
    {
      info: { uuid: "two", rdns: "wallet.two", name: "Wallet Two", icon: "" },
      provider: {},
    },
  ],
  timers: new Map<number, { callback: () => void; delay: number }>(),
};

const timeout = window.setTimeout.bind(window);
const clearTimeout = window.clearTimeout.bind(window);
let nextTimer = -1;
window.setTimeout = ((
  callback: TimerHandler,
  delay?: number,
  ...args: any[]
) => {
  if ((delay === 500 || delay === 650) && typeof callback === "function") {
    const id = nextTimer--;
    environment.timers.set(id, { callback: () => callback(...args), delay });
    return id;
  }
  return timeout(callback, delay, ...args);
}) as typeof window.setTimeout;
window.clearTimeout = (id) => {
  if (id !== undefined && id < 0) environment.timers.delete(id);
  else clearTimeout(id);
};

function defer(calls: any[], data: object) {
  return new Promise<any>((resolve, reject) =>
    calls.push({ ...data, resolve, reject }),
  );
}

export const connectToEthereumAndSign = (wallet: any) =>
  defer(environment.connectCalls, { method: "eth", wallet: wallet?.info.name });
export const connectToSolana = () =>
  defer(environment.connectCalls, { method: "sol" });
export const connection = {
  verifyEthAddress: (...args: any[]) =>
    defer(environment.verificationCalls, { method: "eth", args }),
  verifySolanaAddress: (...args: any[]) =>
    defer(environment.verificationCalls, { method: "sol", args }),
  getLinkedAuthMethods: async () => {
    environment.linkedReads += 1;
    return { linkedMethods: { ...environment.linkedMethods } };
  },
  isCurrentAuthUser: () => true,
};
export const handleLoginSuccess = (result: unknown) => {
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
export const clearConsumedXRedirectResult = noop;
export const isXRedirectStartedError = () => false;
export const peekXRedirectResult = () => null;
export const startXRedirectAuth = noop;
export const subscribeToPendingXRedirectResult = subscribe;
export const consumePendingXAuthUiFeedback = () => null;
export const subscribeToXAuthUiFeedback = subscribe;
export const markAuthNameCommitted = subscribe;
export const notifyVerifiedProfileNameCommitted = subscribe;
export const performLogoutCleanupAndReload = async () => {};
export const reloadAfterLogout = noop;
export const notifyOtherTabsAboutSignIn = noop;
export const resetNftCache = noop;
export const NameEditModal = () => null;
export const LogoutConfirmModal = () => null;
export const SessionResetNotice = () => null;
export const isMobile = new URLSearchParams(location.search).has("mobile");
export const defaultEarlyInputEventName = isMobile ? "touchstart" : "mousedown";
export const hideShinyCard = () => (environment.hiddenCards += 1);
export const showShinyCard = noop;
export const showsShinyCardSomewhere = false;
export const updateShinyCardDisplayName = noop;
export const registerProfileTransientUiHandler = subscribe;

export const EVENT_MODAL_AUTH_Z_INDEX = 100101;
export const getEventModalState = () => ({ isOpen: false, eventId: null });
export const subscribeToEventModalState = subscribe;
