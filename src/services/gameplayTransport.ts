import {
  EVENT_BOOKMARK_HEADER,
  EVENT_ETAG_HEADER,
  MAX_EVENT_READ_RESPONSE_BYTES,
} from "@mons/shared/events";
import { AuthApiError, type AuthTokenProvider } from "./authApi";

export const GAMEPLAY_API_ROOT = "https://api.mons.link";
export const GAMEPLAY_API_TIMEOUT_MS = 30_000;

export type ConditionalRead<T> =
  | {
      kind: "modified";
      value: T;
      etag: string;
      bookmark: string;
    }
  | {
      kind: "not-modified";
      etag: string;
      bookmark: string;
    };

export type ConditionalReadOptions = {
  etag?: string | null;
  bookmark?: string | null;
  signal?: AbortSignal;
};

export class GameplayApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "GameplayApiError";
    this.code = code;
    this.details = details;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    cancelBody(response);
    throw new GameplayApiError(
      "unavailable",
      "Gameplay service is unavailable.",
    );
  }
  if (!response.body) {
    throw new GameplayApiError(
      "unavailable",
      "Gameplay service is unavailable.",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  const cancelRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelRead, { once: true });
  try {
    if (signal?.aborted) {
      cancelRead();
      throw new Error("request-aborted");
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        throw new Error("oversized-response");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join("")) as unknown;
  } catch {
    cancelRead();
    throw new GameplayApiError(
      "unavailable",
      "Gameplay service is unavailable.",
    );
  } finally {
    signal?.removeEventListener("abort", cancelRead);
  }
}

function conditionalHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name)?.trim() || "";
  return value && value.length <= 4_096 ? value : null;
}

type ConditionalGameplayReader = <T>(
  url: URL,
  validate: (value: unknown) => value is T,
  options?: Pick<ConditionalReadOptions, "etag" | "bookmark">,
) => Promise<ConditionalRead<T>>;

export async function withConditionalGameplayReads<T>(
  tokenProvider: AuthTokenProvider,
  options: ConditionalReadOptions,
  operation: (read: ConditionalGameplayReader) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) {
    throw new GameplayApiError("aborted", "request-aborted");
  }
  const controller = new AbortController();
  let cancellationKind: "caller" | "timeout" | null = null;
  let rejectCancellation: ((error: GameplayApiError) => void) | null = null;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancellationError = () =>
    cancellationKind === "caller"
      ? new GameplayApiError("aborted", "request-aborted")
      : new GameplayApiError("unavailable", "Gameplay request timed out.");
  const assertActive = () => {
    if (cancellationKind) throw cancellationError();
  };
  const cancel = (kind: "caller" | "timeout") => {
    if (cancellationKind) return;
    cancellationKind = kind;
    controller.abort();
    rejectCancellation?.(cancellationError());
  };
  const timeoutId = setTimeout(
    () => cancel("timeout"),
    GAMEPLAY_API_TIMEOUT_MS,
  );
  const handleCallerAbort = () => cancel("caller");
  options.signal?.addEventListener("abort", handleCallerAbort, { once: true });
  let refreshedAuthentication = false;
  let initializedAuthentication = false;
  const read: ConditionalGameplayReader = async (
    url,
    validate,
    readOptions = {},
  ) => {
    let forceRefresh = false;
    while (true) {
      assertActive();
      if (initializedAuthentication) tokenProvider.assertCurrentUser?.();
      const token = await tokenProvider(forceRefresh);
      assertActive();
      tokenProvider.assertCurrentUser?.();
      initializedAuthentication = true;
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      });
      const etag = readOptions.etag?.trim();
      const bookmark = readOptions.bookmark?.trim();
      if (etag) headers.set("If-None-Match", etag);
      if (bookmark) headers.set(EVENT_BOOKMARK_HEADER, bookmark);
      const response = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) cancelBody(response);
      assertActive();
      if (response.status === 401 && !refreshedAuthentication) {
        cancelBody(response);
        refreshedAuthentication = true;
        forceRefresh = true;
        continue;
      }
      if (response.status === 304) {
        const responseEtag = conditionalHeader(response, EVENT_ETAG_HEADER);
        const responseBookmark = conditionalHeader(
          response,
          EVENT_BOOKMARK_HEADER,
        );
        if (!etag || !responseEtag || !responseBookmark) {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay service is unavailable.",
          );
        }
        tokenProvider.assertCurrentUser?.();
        return {
          kind: "not-modified",
          etag: responseEtag,
          bookmark: responseBookmark,
        };
      }
      const payload = await readBoundedJson(
        response,
        MAX_EVENT_READ_RESPONSE_BYTES,
        controller.signal,
      );
      assertActive();
      if (!response.ok) throw responseError(payload, response.status);
      const responseEtag = conditionalHeader(response, EVENT_ETAG_HEADER);
      const responseBookmark = conditionalHeader(
        response,
        EVENT_BOOKMARK_HEADER,
      );
      if (!responseEtag || !responseBookmark || !validate(payload)) {
        throw new GameplayApiError(
          "unavailable",
          "Gameplay service is unavailable.",
        );
      }
      tokenProvider.assertCurrentUser?.();
      return {
        kind: "modified",
        value: payload,
        etag: responseEtag,
        bookmark: responseBookmark,
      };
    }
  };
  const run = async () => {
    try {
      const result = await operation(read);
      assertActive();
      tokenProvider.assertCurrentUser?.();
      return result;
    } catch (error) {
      assertActive();
      if (error instanceof GameplayApiError) throw error;
      if (error instanceof AuthApiError) {
        throw new GameplayApiError(error.code, error.message, error.details);
      }
      throw new GameplayApiError(
        "unavailable",
        "Gameplay service is unavailable.",
      );
    }
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", handleCallerAbort);
  }
}

export function conditionalGameplayRead<T>(
  url: URL,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
  options: ConditionalReadOptions,
): Promise<ConditionalRead<T>> {
  return withConditionalGameplayReads(tokenProvider, options, (read) =>
    read(url, validate, options),
  );
}

export function responseError(
  value: unknown,
  status: number,
): GameplayApiError {
  const body = isRecord(value) ? value : {};
  const code =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : status === 401
        ? "unauthenticated"
        : "unavailable";
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : "Gameplay service is unavailable.";
  return new GameplayApiError(code, message, body.details);
}
