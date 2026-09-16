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

export async function conditionalGameplayRead<T>(
  url: URL,
  tokenProvider: AuthTokenProvider,
  validate: (value: unknown) => value is T,
  options: ConditionalReadOptions,
): Promise<ConditionalRead<T>> {
  if (options.signal?.aborted) {
    throw new GameplayApiError("aborted", "request-aborted");
  }
  const controller = new AbortController();
  let cancellationKind: "caller" | "timeout" | null = null;
  let rejectCancellation: ((error: GameplayApiError) => void) | null = null;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (kind: "caller" | "timeout") => {
    if (cancellationKind) return;
    cancellationKind = kind;
    controller.abort();
    rejectCancellation?.(
      kind === "caller"
        ? new GameplayApiError("aborted", "request-aborted")
        : new GameplayApiError("unavailable", "Gameplay request timed out."),
    );
  };
  const timeoutId = setTimeout(
    () => cancel("timeout"),
    GAMEPLAY_API_TIMEOUT_MS,
  );
  const handleCallerAbort = () => cancel("caller");
  options.signal?.addEventListener("abort", handleCallerAbort, { once: true });
  const run = async (): Promise<ConditionalRead<T>> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const token = await tokenProvider(attempt === 1);
        if (controller.signal.aborted) {
          throw cancellationKind === "caller"
            ? new GameplayApiError("aborted", "request-aborted")
            : new GameplayApiError(
                "unavailable",
                "Gameplay request timed out.",
              );
        }
        tokenProvider.assertCurrentUser?.();
        const headers = new Headers({
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        });
        const etag = options.etag?.trim();
        const bookmark = options.bookmark?.trim();
        if (etag) headers.set("If-None-Match", etag);
        if (bookmark) headers.set(EVENT_BOOKMARK_HEADER, bookmark);
        const response = await fetch(url, {
          method: "GET",
          headers,
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401 && attempt === 0) {
          cancelBody(response);
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
        );
        if (!response.ok) throw responseError(payload, response.status);
        const responseEtag = conditionalHeader(response, EVENT_ETAG_HEADER);
        const responseBookmark = conditionalHeader(
          response,
          EVENT_BOOKMARK_HEADER,
        );
        if (!responseEtag || !responseBookmark) {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay service is unavailable.",
          );
        }
        if (!validate(payload)) {
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
      } catch (error) {
        if (cancellationKind === "caller") {
          throw new GameplayApiError("aborted", "request-aborted");
        }
        if (cancellationKind === "timeout") {
          throw new GameplayApiError(
            "unavailable",
            "Gameplay request timed out.",
          );
        }
        if (error instanceof GameplayApiError) throw error;
        if (error instanceof AuthApiError) {
          throw new GameplayApiError(error.code, error.message, error.details);
        }
        throw new GameplayApiError(
          "unavailable",
          "Gameplay service is unavailable.",
        );
      }
    }
    throw new GameplayApiError("unauthenticated", "authentication-required");
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", handleCallerAbort);
  }
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
