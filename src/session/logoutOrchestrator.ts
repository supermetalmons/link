import { shouldPreserveStorageKeyOnLogout, storage } from "../utils/storage";

const LOGOUT_SYNC_CHANNEL = "mons-link-logout-sync";
const LOGOUT_SYNC_STORAGE_KEY = "__mons_link_logout_sync__";
const LOGOUT_PENDING_WIPE_STORAGE_KEY = "__mons_link_logout_pending_wipe__";
const LOGOUT_PENDING_WIPE_TAB_ACK_SESSION_KEY =
  "__mons_link_logout_pending_wipe_ack__";
const LOGOUT_PENDING_WIPE_UNAUTH_RETENTION_MS = 60 * 1000;
const LOGOUT_PENDING_WIPE_MAX_AGE_MS = 10 * 60 * 1000;
const SIGN_IN_SYNC_CHANNEL = "mons-link-signin-sync";
const SIGN_IN_SYNC_STORAGE_KEY = "__mons_link_signin_sync__";
const FAST_PRE_RELOAD_CLEANUP_MS = 150;
const THOROUGH_PRE_RELOAD_CLEANUP_MS = 2500;
const SAFARI_RELOAD_FALLBACK_DELAY_MS = 180;

type LogoutSignal = {
  id: string;
  cleanupMode?: LogoutCleanupMode;
};

type PendingLogoutWipeMarker = {
  id: string;
  createdAtMs: number;
  cleanupMode: LogoutCleanupMode;
};

type SignInSignal = {
  id: string;
  tabId: string;
  profileId: string;
  loginId: string;
};

type IndexedDbFactoryWithDatabases = IDBFactory & {
  databases?: () => Promise<Array<{ name?: string }>>;
};

type LogoutCleanupMode = "fast" | "thorough";

let logoutBroadcastChannel: BroadcastChannel | null = null;
let signInBroadcastChannel: BroadcastChannel | null = null;
let didInstallListeners = false;
let lastHandledSignalId = "";
let lastHandledSignInSignalId = "";
let isHandlingSignal = false;

const createSignalId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
};

const tabId = createSignalId();

const serializeLogoutSignal = (signal: LogoutSignal): string => {
  return JSON.stringify(signal);
};

const serializeSignInSignal = (signal: SignInSignal): string => {
  return JSON.stringify(signal);
};

const parseLogoutSignal = (value: unknown): LogoutSignal | null => {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown;
      cleanupMode?: unknown;
    } | null;
    if (!parsed || typeof parsed.id !== "string" || parsed.id === "") {
      return null;
    }
    const cleanupMode =
      parsed.cleanupMode === "thorough"
        ? "thorough"
        : parsed.cleanupMode === "fast"
          ? "fast"
          : undefined;
    return { id: parsed.id, cleanupMode };
  } catch {
    return null;
  }
};

const parseSignInSignal = (value: unknown): SignInSignal | null => {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown;
      tabId?: unknown;
      profileId?: unknown;
      loginId?: unknown;
    } | null;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      parsed.id === "" ||
      typeof parsed.tabId !== "string" ||
      parsed.tabId === "" ||
      typeof parsed.profileId !== "string" ||
      parsed.profileId === "" ||
      typeof parsed.loginId !== "string" ||
      parsed.loginId === ""
    ) {
      return null;
    }
    return {
      id: parsed.id,
      tabId: parsed.tabId,
      profileId: parsed.profileId,
      loginId: parsed.loginId,
    };
  } catch {
    return null;
  }
};

const parsePendingLogoutWipeMarker = (
  value: unknown,
): PendingLogoutWipeMarker | null => {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown;
      createdAtMs?: unknown;
      cleanupMode?: unknown;
    } | null;
    if (!parsed || typeof parsed.id !== "string" || parsed.id === "") {
      return null;
    }
    const createdAtMs =
      typeof parsed.createdAtMs === "number"
        ? parsed.createdAtMs
        : Number(parsed.createdAtMs);
    if (!Number.isFinite(createdAtMs)) {
      return null;
    }
    const cleanupMode: LogoutCleanupMode =
      parsed.cleanupMode === "thorough" ? "thorough" : "fast";
    return {
      id: parsed.id,
      createdAtMs: Math.floor(createdAtMs),
      cleanupMode,
    };
  } catch {
    return null;
  }
};

const getPendingLogoutWipeMarker = (): PendingLogoutWipeMarker | null => {
  try {
    const raw = localStorage.getItem(LOGOUT_PENDING_WIPE_STORAGE_KEY);
    return parsePendingLogoutWipeMarker(raw);
  } catch {
    return null;
  }
};

const doesPendingLogoutWipeMarkerMatch = (
  left: PendingLogoutWipeMarker,
  right: PendingLogoutWipeMarker,
): boolean => {
  return (
    left.id === right.id &&
    left.createdAtMs === right.createdAtMs &&
    left.cleanupMode === right.cleanupMode
  );
};

const isPendingLogoutWipeMarkerExpired = (
  marker: PendingLogoutWipeMarker,
): boolean => {
  const ageMs = Date.now() - marker.createdAtMs;
  if (!Number.isFinite(ageMs)) {
    return true;
  }
  return ageMs > LOGOUT_PENDING_WIPE_MAX_AGE_MS;
};

const getHandledPendingLogoutWipeIdForTab = (): string => {
  try {
    return (
      sessionStorage.getItem(LOGOUT_PENDING_WIPE_TAB_ACK_SESSION_KEY) ?? ""
    );
  } catch {
    return "";
  }
};

const hasTabHandledPendingLogoutWipe = (markerId: string): boolean => {
  return markerId !== "" && getHandledPendingLogoutWipeIdForTab() === markerId;
};

const hasPersistedAuthenticatedIdentity = (): boolean => {
  const profileId = storage.getProfileId("");
  const loginId = storage.getLoginId("");
  return profileId !== "" || loginId !== "";
};

const markPendingLogoutWipeHandledForTab = (markerId: string) => {
  if (!markerId) {
    return;
  }
  try {
    sessionStorage.setItem(LOGOUT_PENDING_WIPE_TAB_ACK_SESSION_KEY, markerId);
  } catch {}
};

const clearPendingLogoutWipeHandledForTab = () => {
  try {
    sessionStorage.removeItem(LOGOUT_PENDING_WIPE_TAB_ACK_SESSION_KEY);
  } catch {}
};

const armPendingLogoutWipe = (
  signalId: string,
  cleanupMode: LogoutCleanupMode,
) => {
  if (!signalId) {
    return;
  }
  const existingMarker = getPendingLogoutWipeMarker();
  if (
    existingMarker &&
    existingMarker.id === signalId &&
    existingMarker.cleanupMode === cleanupMode
  ) {
    return;
  }
  const payload = JSON.stringify({
    id: signalId,
    createdAtMs: Date.now(),
    cleanupMode,
  });
  try {
    localStorage.setItem(LOGOUT_PENDING_WIPE_STORAGE_KEY, payload);
  } catch {}
};

const clearPendingLogoutWipe = () => {
  try {
    localStorage.removeItem(LOGOUT_PENDING_WIPE_STORAGE_KEY);
  } catch {}
  clearPendingLogoutWipeHandledForTab();
};

const getLocalStorageKeys = (): string[] => {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) {
        keys.push(key);
      }
    }
    return keys;
  } catch {
    return [];
  }
};

const clearLocalStorageForLogout = (options?: {
  preservePendingLogoutWipe?: boolean;
}) => {
  const preservePendingLogoutWipe =
    options?.preservePendingLogoutWipe !== false;
  getLocalStorageKeys().forEach((key) => {
    if (
      key === LOGOUT_SYNC_STORAGE_KEY ||
      shouldPreserveStorageKeyOnLogout(key)
    ) {
      return;
    }
    if (preservePendingLogoutWipe && key === LOGOUT_PENDING_WIPE_STORAGE_KEY) {
      return;
    }
    try {
      localStorage.removeItem(key);
    } catch {}
  });
};

const clearSessionStorageForLogout = () => {
  try {
    sessionStorage.clear();
  } catch {}
};

const clearCriticalClientPersistenceForLogout = (options?: {
  preservePendingLogoutWipe?: boolean;
}) => {
  const preservePendingLogoutWipe =
    options?.preservePendingLogoutWipe !== false;
  try {
    storage.signOut();
  } catch {}
  try {
    clearLocalStorageForLogout({ preservePendingLogoutWipe });
  } catch {}
  try {
    clearSessionStorageForLogout();
  } catch {}
  try {
    localStorage.removeItem(LOGOUT_SYNC_STORAGE_KEY);
  } catch {}
  if (!preservePendingLogoutWipe) {
    clearPendingLogoutWipe();
  }
};

const deleteIndexedDbDatabase = (name: string): Promise<void> => {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
};

const clearIndexedDbForLogout = async () => {
  if (typeof indexedDB === "undefined") {
    return;
  }
  const factory = indexedDB as IndexedDbFactoryWithDatabases;
  if (typeof factory.databases !== "function") {
    return;
  }
  try {
    const databases = await factory.databases();
    const names = databases
      .map((database) => database.name)
      .filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      );
    await Promise.all(names.map((name) => deleteIndexedDbDatabase(name)));
  } catch {}
};

const clearCacheStorageForLogout = async () => {
  if (typeof caches === "undefined") {
    return;
  }
  try {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  } catch {}
};

const waitFor = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
};

const clearClientPersistenceForLogout = async (
  cleanupMode: LogoutCleanupMode = "fast",
) => {
  clearCriticalClientPersistenceForLogout({ preservePendingLogoutWipe: true });
  const heavyCleanupPromise = Promise.all([
    clearIndexedDbForLogout().catch(() => {}),
    clearCacheStorageForLogout().catch(() => {}),
  ]);
  const preReloadBudgetMs =
    cleanupMode === "thorough"
      ? THOROUGH_PRE_RELOAD_CLEANUP_MS
      : FAST_PRE_RELOAD_CLEANUP_MS;
  await Promise.race([heavyCleanupPromise, waitFor(preReloadBudgetMs)]);
};

export const enforcePendingLogoutWipeIfNeeded = () => {
  const marker = getPendingLogoutWipeMarker();
  if (!marker) {
    return;
  }
  if (isPendingLogoutWipeMarkerExpired(marker)) {
    clearPendingLogoutWipe();
    return;
  }
  if (!hasPersistedAuthenticatedIdentity()) {
    const ageMs = Date.now() - marker.createdAtMs;
    if (
      !Number.isFinite(ageMs) ||
      ageMs >= LOGOUT_PENDING_WIPE_UNAUTH_RETENTION_MS
    ) {
      clearPendingLogoutWipe();
    }
    return;
  }
  if (hasTabHandledPendingLogoutWipe(marker.id)) {
    return;
  }
  clearCriticalClientPersistenceForLogout({ preservePendingLogoutWipe: true });
  markPendingLogoutWipeHandledForTab(marker.id);
};

export const clearPendingLogoutWipeAfterSignIn = () => {
  clearPendingLogoutWipe();
};

const reloadAfterLogout = () => {
  window.location.reload();
  window.setTimeout(() => {
    try {
      window.location.replace(window.location.href);
    } catch {}
  }, SAFARI_RELOAD_FALLBACK_DELAY_MS);
};

const handleLogoutSignal = (
  signal: LogoutSignal,
  options?: { source?: "logout-signal" | "pending-wipe-marker" },
) => {
  if (!signal.id || signal.id === lastHandledSignalId || isHandlingSignal) {
    return;
  }
  isHandlingSignal = true;
  lastHandledSignalId = signal.id;
  const cleanupMode = signal.cleanupMode ?? "fast";
  if (options?.source !== "pending-wipe-marker") {
    armPendingLogoutWipe(signal.id, cleanupMode);
  }
  void clearClientPersistenceForLogout(cleanupMode).finally(() => {
    try {
      reloadAfterLogout();
    } finally {
      isHandlingSignal = false;
    }
  });
};

const handleSignInSignal = (signal: SignInSignal) => {
  if (
    !signal.id ||
    signal.tabId === tabId ||
    signal.id === lastHandledSignInSignalId
  ) {
    return;
  }
  lastHandledSignInSignalId = signal.id;
  reloadAfterLogout();
};

const getLogoutBroadcastChannel = (): BroadcastChannel | null => {
  if (logoutBroadcastChannel) {
    return logoutBroadcastChannel;
  }
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }
  logoutBroadcastChannel = new BroadcastChannel(LOGOUT_SYNC_CHANNEL);
  return logoutBroadcastChannel;
};

const getSignInBroadcastChannel = (): BroadcastChannel | null => {
  if (signInBroadcastChannel) {
    return signInBroadcastChannel;
  }
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }
  signInBroadcastChannel = new BroadcastChannel(SIGN_IN_SYNC_CHANNEL);
  return signInBroadcastChannel;
};

const broadcastLogoutSignal = (
  signalId: string,
  cleanupMode: LogoutCleanupMode,
) => {
  const payload = serializeLogoutSignal({ id: signalId, cleanupMode });
  try {
    localStorage.setItem(LOGOUT_SYNC_STORAGE_KEY, payload);
  } catch {}
  const channel = getLogoutBroadcastChannel();
  if (channel) {
    try {
      channel.postMessage(payload);
    } catch {}
  }
};

const broadcastSignInSignal = (signal: SignInSignal) => {
  const payload = serializeSignInSignal(signal);
  try {
    localStorage.setItem(SIGN_IN_SYNC_STORAGE_KEY, payload);
  } catch {}
  const channel = getSignInBroadcastChannel();
  if (channel) {
    try {
      channel.postMessage(payload);
    } catch {}
  }
};

export const installLogoutSync = () => {
  if (didInstallListeners) {
    return;
  }
  didInstallListeners = true;

  window.addEventListener("storage", (event) => {
    if (!event.newValue) {
      return;
    }
    if (event.key === LOGOUT_PENDING_WIPE_STORAGE_KEY) {
      const marker = parsePendingLogoutWipeMarker(event.newValue);
      if (!marker) {
        return;
      }
      const currentMarker = getPendingLogoutWipeMarker();
      if (
        !currentMarker ||
        !doesPendingLogoutWipeMarkerMatch(marker, currentMarker)
      ) {
        return;
      }
      if (isPendingLogoutWipeMarkerExpired(marker)) {
        clearPendingLogoutWipe();
        return;
      }
      handleLogoutSignal(
        { id: marker.id, cleanupMode: marker.cleanupMode },
        { source: "pending-wipe-marker" },
      );
      return;
    }
    if (event.key === LOGOUT_SYNC_STORAGE_KEY) {
      const signal = parseLogoutSignal(event.newValue);
      if (!signal) {
        return;
      }
      handleLogoutSignal(signal);
      return;
    }
    if (event.key === SIGN_IN_SYNC_STORAGE_KEY) {
      const signal = parseSignInSignal(event.newValue);
      if (!signal) {
        return;
      }
      handleSignInSignal(signal);
    }
  });

  const logoutChannel = getLogoutBroadcastChannel();
  if (logoutChannel) {
    logoutChannel.onmessage = (event: MessageEvent) => {
      const signal = parseLogoutSignal(event.data);
      if (!signal) {
        return;
      }
      handleLogoutSignal(signal);
    };
  }
  const signInChannel = getSignInBroadcastChannel();
  if (signInChannel) {
    signInChannel.onmessage = (event: MessageEvent) => {
      const signal = parseSignInSignal(event.data);
      if (!signal) {
        return;
      }
      handleSignInSignal(signal);
    };
  }
};

export const performLogoutCleanupAndReload = async (options?: {
  cleanupMode?: LogoutCleanupMode;
}) => {
  const cleanupMode = options?.cleanupMode ?? "fast";
  const signalId = createSignalId();
  lastHandledSignalId = signalId;
  armPendingLogoutWipe(signalId, cleanupMode);
  broadcastLogoutSignal(signalId, cleanupMode);
  try {
    await clearClientPersistenceForLogout(cleanupMode);
  } finally {
    reloadAfterLogout();
  }
};

export const notifyOtherTabsAboutSignIn = (
  profileId: string,
  loginId: string,
) => {
  if (!profileId || !loginId) {
    return;
  }
  const signal: SignInSignal = {
    id: createSignalId(),
    tabId,
    profileId,
    loginId,
  };
  lastHandledSignInSignalId = signal.id;
  broadcastSignInSignal(signal);
};
