import {
  APPLICATION_DATA_EPOCH,
  APPLICATION_RELEASE_PATH,
  isApplicationReleaseStatus,
  type ApplicationReleaseStatus,
} from "@mons/shared/data-contract";
import { APPLICATION_RELOAD_MARKER } from "./applicationDataStorage.ts";

export type ApplicationBlockReason =
  "maintenance" | "update-required" | "unavailable";

export class ApplicationDataUnavailableError extends Error {
  readonly code: ApplicationBlockReason;

  constructor(code: ApplicationBlockReason) {
    super(code);
    this.name = "ApplicationDataUnavailableError";
    this.code = code;
  }
}

export class ApplicationDataGate {
  private reason: ApplicationBlockReason | null = null;
  private readonly listeners = new Set<
    (reason: ApplicationBlockReason) => void
  >();

  get blocked(): boolean {
    return this.reason !== null;
  }

  assertAvailable(): void {
    if (this.reason !== null)
      throw new ApplicationDataUnavailableError(this.reason);
  }

  block(reason: ApplicationBlockReason): void {
    if (this.reason !== null) return;
    this.reason = reason;
    for (const listener of this.listeners) listener(reason);
  }

  subscribe(listener: (reason: ApplicationBlockReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const applicationDataGate = new ApplicationDataGate();

function hasDifferentReleaseEpoch(
  value: unknown,
): value is { dataEpoch: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "dataEpoch" in value &&
    typeof value.dataEpoch === "number" &&
    Number.isSafeInteger(value.dataEpoch) &&
    value.dataEpoch >= 0 &&
    value.dataEpoch !== APPLICATION_DATA_EPOCH
  );
}

export async function readApplicationRelease(
  fetcher: typeof fetch = fetch,
): Promise<ApplicationReleaseStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(
      `https://api.mons.link${APPLICATION_RELEASE_PATH}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (
      !response.ok ||
      Number(response.headers.get("Content-Length")) > 1_024 ||
      !response.body
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new ApplicationDataUnavailableError("unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1_024)
          throw new ApplicationDataUnavailableError("unavailable");
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (hasDifferentReleaseEpoch(payload)) {
      if ("state" in payload && payload.state === "maintenance") {
        if (
          !isApplicationReleaseStatus({
            ...payload,
            dataEpoch: APPLICATION_DATA_EPOCH,
          })
        )
          throw new ApplicationDataUnavailableError("unavailable");
        throw new ApplicationDataUnavailableError("maintenance");
      }
      throw new ApplicationDataUnavailableError("update-required");
    }
    if (!isApplicationReleaseStatus(payload))
      throw new ApplicationDataUnavailableError("unavailable");
    return payload;
  } catch (error) {
    if (error instanceof ApplicationDataUnavailableError) throw error;
    throw new ApplicationDataUnavailableError("unavailable");
  } finally {
    clearTimeout(timer);
  }
}

export function requestApplicationReloadOnce(
  store: Pick<Storage, "getItem" | "setItem">,
  reload: () => void,
): boolean {
  try {
    const marker = String(APPLICATION_DATA_EPOCH);
    if (store.getItem(APPLICATION_RELOAD_MARKER) === marker) return false;
    store.setItem(APPLICATION_RELOAD_MARKER, marker);
    reload();
    return true;
  } catch {
    return false;
  }
}

export async function startApplicationData(dependencies: {
  readRelease: () => Promise<ApplicationReleaseStatus>;
  enforcePendingLogout: () => Promise<void>;
  resetStorage: () => void;
  start: () => Promise<void>;
  onBlocked: (reason: ApplicationBlockReason) => void;
  gate?: ApplicationDataGate;
}): Promise<void> {
  const gate = dependencies.gate ?? applicationDataGate;
  try {
    const release = await dependencies.readRelease();
    if (release.state === "maintenance") {
      throw new ApplicationDataUnavailableError("maintenance");
    }
    gate.assertAvailable();
    await dependencies.enforcePendingLogout();
    gate.assertAvailable();
    dependencies.resetStorage();
    gate.assertAvailable();
    await dependencies.start();
  } catch (error) {
    const reason =
      error instanceof ApplicationDataUnavailableError
        ? error.code
        : "unavailable";
    gate.block(reason);
    dependencies.onBlocked(reason);
  }
}

export function showApplicationUnavailable(
  reason: ApplicationBlockReason,
  retry: () => void,
): void {
  const root = document.getElementById("root");
  if (root) {
    root.inert = true;
    root.style.display = "none";
  }
  const panel = document.createElement("main");
  panel.id = "application-status";
  panel.setAttribute("aria-live", "polite");
  panel.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;box-sizing:border-box;font-family:system-ui,sans-serif;text-align:center;background:Canvas;color:CanvasText;color-scheme:light dark";
  const title = document.createElement("h1");
  title.textContent =
    reason === "maintenance"
      ? "Mons is being updated"
      : reason === "update-required"
        ? "A new version is ready"
        : "Unable to connect to Mons";
  const description = document.createElement("p");
  description.textContent =
    reason === "maintenance"
      ? "Please try again shortly."
      : reason === "update-required"
        ? "Reload to continue playing."
        : "Check your connection and try again.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = reason === "update-required" ? "Reload" : "Try again";
  button.style.cssText =
    "font:inherit;padding:10px 20px;cursor:pointer;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit";
  button.addEventListener("click", retry);
  panel.append(title, description, button);
  document.getElementById(panel.id)?.remove();
  document.body.appendChild(panel);
}
