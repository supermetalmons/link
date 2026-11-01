import { applicationStorageKey } from "../session/applicationDataStorage.ts";
type XAuthUiFeedbackTarget = "signin" | "settings";
type XAuthUiFeedbackKind = "error" | "success";

export type XAuthUiFeedback = {
  target: XAuthUiFeedbackTarget;
  kind: XAuthUiFeedbackKind;
  message: string;
};

const STORAGE_KEY = applicationStorageKey("xAuthUiFeedbackV1");

let pendingFeedback: XAuthUiFeedback | null = null;
const listeners = new Set<(feedback: XAuthUiFeedback) => void>();

const toCleanString = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

const normalizeTarget = (value: unknown): XAuthUiFeedbackTarget | null => {
  return value === "settings"
    ? "settings"
    : value === "signin"
      ? "signin"
      : null;
};

const normalizeKind = (value: unknown): XAuthUiFeedbackKind | null => {
  return value === "success" ? "success" : value === "error" ? "error" : null;
};

const normalizeFeedback = (value: unknown): XAuthUiFeedback | null => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3
  ) {
    return null;
  }
  const target = normalizeTarget((value as { target?: unknown }).target);
  const kind = normalizeKind((value as { kind?: unknown }).kind);
  const message = toCleanString((value as { message?: unknown }).message);
  if (!target || !kind || !message) {
    return null;
  }
  return {
    target,
    kind,
    message,
  };
};

const persistFeedback = (feedback: XAuthUiFeedback | null): void => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!feedback) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(feedback));
  } catch {}
};

const readPersistedFeedback = (): XAuthUiFeedback | null => {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return normalizeFeedback(
      JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || "null"),
    );
  } catch {
    return null;
  }
};

export const publishXAuthUiFeedback = (feedback: XAuthUiFeedback): void => {
  const normalized = normalizeFeedback(feedback);
  if (!normalized) {
    return;
  }
  pendingFeedback = normalized;
  persistFeedback(normalized);
  if (listeners.size === 0) {
    return;
  }
  listeners.forEach((listener) => {
    try {
      listener(normalized);
    } catch {}
  });
  pendingFeedback = null;
  persistFeedback(null);
};

export const consumePendingXAuthUiFeedback = (): XAuthUiFeedback | null => {
  const nextFeedback = pendingFeedback || readPersistedFeedback();
  pendingFeedback = null;
  persistFeedback(null);
  return nextFeedback;
};

export const subscribeToXAuthUiFeedback = (
  listener: (feedback: XAuthUiFeedback) => void,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
