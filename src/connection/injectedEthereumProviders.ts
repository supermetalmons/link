export type EIP6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type EIP1193Provider = {
  request: (args: {
    method: string;
    params?: any[] | Record<string, any>;
  }) => Promise<any>;
};

export type EIP6963ProviderDetail = {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
};

declare global {
  interface Window {
    ethereum?: any;
  }
}

const ANNOUNCE_EVENT_NAME = "eip6963:announceProvider";
const REQUEST_EVENT_NAME = "eip6963:requestProvider";
const FIRST_SCAN_MAX_MS = 300;
const FIRST_SCAN_LEGACY_MAX_MS = 100;
const FIRST_SCAN_QUIET_MS = 60;
const FIRST_SCAN_POLL_MS = 20;

const discoveredWalletsByKey = new Map<string, EIP6963ProviderDetail>();
let isListeningForAnnouncements = false;
let didCompleteFirstScan = false;
let firstScanPromise: Promise<EIP6963ProviderDetail[]> | null = null;
let lastAnnouncementAtMs = 0;

const isDiscoverySupported = (): boolean => {
  return (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof window.dispatchEvent === "function"
  );
};

const readAnnouncedWallet = (event: Event): EIP6963ProviderDetail | null => {
  const detail = (event as CustomEvent<unknown>).detail as
    Partial<EIP6963ProviderDetail> | undefined;
  if (!detail || typeof detail !== "object") {
    return null;
  }
  const provider = detail.provider;
  const info = detail.info;
  if (!provider || typeof provider.request !== "function") {
    return null;
  }
  if (!info || typeof info !== "object") {
    return null;
  }
  const uuid = typeof info.uuid === "string" ? info.uuid : "";
  const rdns = typeof info.rdns === "string" ? info.rdns : "";
  const icon = typeof info.icon === "string" ? info.icon : "";
  const name =
    typeof info.name === "string" && info.name !== "" ? info.name : rdns;
  if (!name || (!rdns && !uuid)) {
    return null;
  }
  return { info: { uuid, name, icon, rdns }, provider };
};

const handleProviderAnnouncement = (event: Event): void => {
  const wallet = readAnnouncedWallet(event);
  if (!wallet) {
    return;
  }
  lastAnnouncementAtMs = Date.now();
  const key = wallet.info.rdns || wallet.info.uuid;
  discoveredWalletsByKey.set(key, wallet);
};

const ensureListeningForAnnouncements = (): void => {
  if (isListeningForAnnouncements || !isDiscoverySupported()) {
    return;
  }
  isListeningForAnnouncements = true;
  window.addEventListener(ANNOUNCE_EVENT_NAME, handleProviderAnnouncement);
};

const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
};

const snapshotDiscoveredWallets = (): EIP6963ProviderDetail[] => {
  return Array.from(discoveredWalletsByKey.values());
};

export const getLegacyInjectedProvider = (): EIP1193Provider | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const injectedProvider = window.ethereum;
  if (!injectedProvider || typeof injectedProvider.request !== "function") {
    return null;
  }
  return injectedProvider as EIP1193Provider;
};

export const primeInjectedEthereumProviderDiscovery = (): void => {
  if (!isDiscoverySupported()) {
    return;
  }
  ensureListeningForAnnouncements();
  window.dispatchEvent(new Event(REQUEST_EVENT_NAME));
};

const runFirstScan = async (): Promise<EIP6963ProviderDetail[]> => {
  const startedAtMs = Date.now();
  const maxWaitMs = getLegacyInjectedProvider()
    ? FIRST_SCAN_LEGACY_MAX_MS
    : FIRST_SCAN_MAX_MS;
  primeInjectedEthereumProviderDiscovery();
  await delay(0);
  while (Date.now() - startedAtMs < maxWaitMs) {
    if (
      discoveredWalletsByKey.size > 0 &&
      Date.now() - lastAnnouncementAtMs >= FIRST_SCAN_QUIET_MS
    ) {
      break;
    }
    await delay(FIRST_SCAN_POLL_MS);
  }
  didCompleteFirstScan = true;
  return snapshotDiscoveredWallets();
};

export const listInjectedEthereumProviders = async (): Promise<
  EIP6963ProviderDetail[]
> => {
  if (!isDiscoverySupported()) {
    return [];
  }
  if (didCompleteFirstScan) {
    primeInjectedEthereumProviderDiscovery();
    await delay(0);
    return snapshotDiscoveredWallets();
  }
  if (!firstScanPromise) {
    firstScanPromise = runFirstScan().finally(() => {
      firstScanPromise = null;
    });
  }
  return firstScanPromise;
};

export const getInjectedWalletIconSrc = (icon: string): string | null => {
  return icon.startsWith("data:image/") ? icon : null;
};
