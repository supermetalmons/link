import { connection } from "./connection";
import {
  X_REDIRECT_CALLBACK_PARAM_KEYS,
  X_REDIRECT_RESULT_PARAMS,
  X_REDIRECT_STARTED_ERROR_CODE,
  normalizeClientXConsentSource,
  type XConsentSource,
} from "@mons/shared/x-redirect";

type XRedirectStatus = "ready" | "failed";
type XRedirectErrorCode = typeof X_REDIRECT_STARTED_ERROR_CODE;

type XRedirectResult = {
  flowId: string;
  status: XRedirectStatus;
  errorCode: string;
  consentSource: XConsentSource;
};

let pendingXRedirectResult: XRedirectResult | null = null;
let didConsumeInitialXRedirectSnapshot = false;
const pendingXRedirectResultListeners = new Set<
  (result: XRedirectResult | null) => void
>();

const initialXRedirectSnapshot =
  typeof window === "undefined"
    ? null
    : {
        hashRaw: window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : window.location.hash,
        searchRaw: window.location.search.startsWith("?")
          ? window.location.search.slice(1)
          : window.location.search,
      };

const parseXRedirectParamsFromRaw = (raw: string): XRedirectResult | null => {
  if (!raw) {
    return null;
  }
  const params = new URLSearchParams(raw);
  const flowId = (params.get(X_REDIRECT_RESULT_PARAMS.flowId) || "").trim();
  const statusRaw = (params.get(X_REDIRECT_RESULT_PARAMS.status) || "")
    .trim()
    .toLowerCase();
  if (!flowId || (statusRaw !== "ready" && statusRaw !== "failed")) {
    return null;
  }
  return {
    flowId,
    status: statusRaw as XRedirectStatus,
    errorCode: (params.get(X_REDIRECT_RESULT_PARAMS.error) || "").trim(),
    consentSource: normalizeClientXConsentSource(
      params.get(X_REDIRECT_RESULT_PARAMS.consentSource),
    ),
  };
};

const readXRedirectParams = (): XRedirectResult | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const searchRaw = window.location.search.startsWith("?")
    ? window.location.search.slice(1)
    : window.location.search;
  const hashRaw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const fromSearch = parseXRedirectParamsFromRaw(searchRaw);
  if (fromSearch) {
    return fromSearch;
  }
  const fromHash = parseXRedirectParamsFromRaw(hashRaw);
  if (fromHash) {
    return fromHash;
  }
  if (!didConsumeInitialXRedirectSnapshot && initialXRedirectSnapshot) {
    didConsumeInitialXRedirectSnapshot = true;
    const fromInitialSearch = parseXRedirectParamsFromRaw(
      initialXRedirectSnapshot.searchRaw,
    );
    if (fromInitialSearch) {
      return fromInitialSearch;
    }
    const fromInitialHash = parseXRedirectParamsFromRaw(
      initialXRedirectSnapshot.hashRaw,
    );
    if (fromInitialHash) {
      return fromInitialHash;
    }
  }
  return null;
};

export const peekXRedirectResult = (): XRedirectResult | null => {
  if (pendingXRedirectResult) {
    return pendingXRedirectResult;
  }
  if (typeof window === "undefined") {
    return null;
  }
  const searchRaw = window.location.search.startsWith("?")
    ? window.location.search.slice(1)
    : window.location.search;
  const hashRaw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const fromSearch = parseXRedirectParamsFromRaw(searchRaw);
  if (fromSearch) {
    return fromSearch;
  }
  const fromHash = parseXRedirectParamsFromRaw(hashRaw);
  if (fromHash) {
    return fromHash;
  }
  if (didConsumeInitialXRedirectSnapshot || !initialXRedirectSnapshot) {
    return null;
  }
  return (
    parseXRedirectParamsFromRaw(initialXRedirectSnapshot.searchRaw) ||
    parseXRedirectParamsFromRaw(initialXRedirectSnapshot.hashRaw)
  );
};

const notifyPendingXRedirectResultListeners = (): void => {
  pendingXRedirectResultListeners.forEach((listener) => {
    try {
      listener(pendingXRedirectResult);
    } catch {}
  });
};

export const subscribeToPendingXRedirectResult = (
  listener: (result: XRedirectResult | null) => void,
): (() => void) => {
  pendingXRedirectResultListeners.add(listener);
  try {
    listener(pendingXRedirectResult || peekXRedirectResult());
  } catch {}
  return () => {
    pendingXRedirectResultListeners.delete(listener);
  };
};

const clearXRedirectParams = (): void => {
  if (typeof window === "undefined") {
    return;
  }
  const currentUrl = new URL(window.location.href);
  let didChange = false;
  X_REDIRECT_CALLBACK_PARAM_KEYS.forEach((key) => {
    if (currentUrl.searchParams.has(key)) {
      currentUrl.searchParams.delete(key);
      didChange = true;
    }
  });
  if (currentUrl.hash) {
    const hashRaw = currentUrl.hash.startsWith("#")
      ? currentUrl.hash.slice(1)
      : currentUrl.hash;
    const hashParams = new URLSearchParams(hashRaw);
    let hashChanged = false;
    X_REDIRECT_CALLBACK_PARAM_KEYS.forEach((key) => {
      if (hashParams.has(key)) {
        hashParams.delete(key);
        hashChanged = true;
      }
    });
    if (hashChanged) {
      didChange = true;
      const nextHash = hashParams.toString();
      currentUrl.hash = nextHash ? `#${nextHash}` : "";
    }
  }
  if (!didChange) {
    return;
  }
  const cleanUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
  window.history.replaceState({}, document.title, cleanUrl);
};

export const consumeXRedirectResult = (): XRedirectResult | null => {
  if (pendingXRedirectResult) {
    return pendingXRedirectResult;
  }
  const parsed = readXRedirectParams();
  if (!parsed) {
    return null;
  }
  didConsumeInitialXRedirectSnapshot = true;
  clearXRedirectParams();
  pendingXRedirectResult = parsed;
  notifyPendingXRedirectResultListeners();
  return pendingXRedirectResult;
};

export const clearConsumedXRedirectResult = (): void => {
  if (!pendingXRedirectResult) {
    return;
  }
  pendingXRedirectResult = null;
  notifyPendingXRedirectResultListeners();
};

export const clearXSignInTransientState = (): void => {
  pendingXRedirectResult = null;
  didConsumeInitialXRedirectSnapshot = true;
  clearXRedirectParams();
  notifyPendingXRedirectResultListeners();
};

export const isXRedirectStartedError = (value: unknown): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  return code === X_REDIRECT_STARTED_ERROR_CODE;
};

export async function startXRedirectAuth(params: {
  intentId: string;
  consentSource?: XConsentSource;
  returnUrl?: string;
}): Promise<never> {
  if (typeof window === "undefined") {
    throw new Error("X sign in is unavailable in this environment");
  }
  const response = await connection.beginXRedirectAuth({
    intentId: params.intentId,
    consentSource: params.consentSource || "signin",
    returnUrl: params.returnUrl || window.location.href,
  });
  const authUrl =
    typeof response?.authUrl === "string" ? response.authUrl.trim() : "";
  if (!authUrl) {
    throw new Error("X redirect sign in is unavailable.");
  }
  window.location.assign(authUrl);
  const redirectError = new Error("X redirect sign in started.");
  (redirectError as Error & { code?: XRedirectErrorCode }).code =
    X_REDIRECT_STARTED_ERROR_CODE;
  throw redirectError;
}
