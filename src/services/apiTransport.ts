export type AuthTokenProvider = ((forceRefresh: boolean) => Promise<string>) & {
  readonly assertCurrentUser?: () => void;
};

export type ApiErrorPolicy = {
  createError: (code: string, message: string, details?: unknown) => Error;
  normalizeError: (error: unknown) => Error | undefined;
  normalizeResponseError?: (error: unknown) => Error | undefined;
  unavailableMessage: string;
  timeoutMessage: string;
  timeoutCode?: string;
};

type AuthenticatedJsonRequest<T> = {
  url: string;
  createRequestInit: () => Omit<RequestInit, "cache" | "headers" | "signal">;
  tokenProvider: AuthTokenProvider;
  validate: (value: unknown) => value is T;
  timeoutMs: number;
  maxResponseBytes: number;
  fetcher?: typeof fetch;
  assertCurrentUser?: () => void;
  errors: ApiErrorPolicy;
};

type SnapshotJsonRead<T> = {
  url: string;
  tokenProvider?: AuthTokenProvider;
  signal?: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
  validate: (value: unknown) => value is T;
  createError: (code: string, status?: number, retryAfterMs?: number) => Error;
};

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
  unavailableError: () => Error,
  normalizeError?: (error: unknown) => Error | undefined,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    cancelBody(response);
    throw unavailableError();
  }
  if (!response.body) {
    throw unavailableError();
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    if (signal.aborted) {
      throw unavailableError();
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxResponseBytes) {
        throw unavailableError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join("")) as unknown;
  } catch (error) {
    cancel();
    throw normalizeError?.(error) ?? unavailableError();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function responseError(
  payload: unknown,
  status: number,
  errors: ApiErrorPolicy,
): Error {
  const body =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const code =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : status === 401
        ? "unauthenticated"
        : "unavailable";
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : errors.unavailableMessage;
  return errors.createError(code, message, body.details);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

export async function readSnapshotJson<T>({
  url,
  tokenProvider,
  signal,
  timeoutMs,
  maxResponseBytes,
  validate,
  createError,
}: SnapshotJsonRead<T>): Promise<T> {
  if (signal?.aborted) throw createError("aborted");
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (code: string) => {
    rejectCancellation(createError(code));
    controller.abort();
  };
  const onAbort = () => cancel("aborted");
  const timer = setTimeout(() => cancel("timeout"), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  const assertCurrent = () => {
    if (controller.signal.aborted) throw createError("aborted");
    if (Date.now() >= deadline) {
      controller.abort();
      throw createError("timeout");
    }
    tokenProvider?.assertCurrentUser?.();
  };
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      assertCurrent();
      const token = tokenProvider ? await tokenProvider(attempt === 1) : null;
      assertCurrent();
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      try {
        assertCurrent();
      } catch (error) {
        cancelBody(response);
        throw error;
      }
      if (response.status === 401 && tokenProvider && attempt === 0) {
        cancelBody(response);
        continue;
      }
      if (!response.ok) {
        cancelBody(response);
        throw createError(
          `http-${response.status}`,
          response.status,
          retryAfterMs(response),
        );
      }
      const payload = await readBoundedJson(
        response,
        maxResponseBytes,
        controller.signal,
        () => createError("invalid-response"),
      );
      assertCurrent();
      if (!validate(payload)) throw createError("invalid-response");
      return payload;
    }
    throw createError("unauthenticated", 401);
  };
  try {
    return await Promise.race([run(), cancellation]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function authenticatedJsonRequest<T>({
  url,
  createRequestInit,
  tokenProvider,
  validate,
  timeoutMs,
  maxResponseBytes,
  fetcher,
  assertCurrentUser,
  errors,
}: AuthenticatedJsonRequest<T>): Promise<T> {
  const controller = new AbortController();
  const unavailableError = () =>
    errors.createError("unavailable", errors.unavailableMessage);
  const timeoutError = () =>
    errors.createError(
      errors.timeoutCode ?? "unavailable",
      errors.timeoutMessage,
    );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await tokenProvider(attempt === 1);
        if (controller.signal.aborted) {
          throw timeoutError();
        }
        assertCurrentUser?.();
        const init = createRequestInit();
        const headers = new Headers({
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        });
        if (init.body !== undefined) {
          headers.set("Content-Type", "application/json");
        }
        const response = await (fetcher ?? fetch)(url, {
          ...init,
          headers,
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401 && attempt === 0) {
          cancelBody(response);
          continue;
        }
        const payload = await readBoundedJson(
          response,
          maxResponseBytes,
          controller.signal,
          unavailableError,
          errors.normalizeResponseError,
        );
        if (!response.ok) {
          throw responseError(payload, response.status, errors);
        }
        if (!validate(payload)) {
          throw unavailableError();
        }
        assertCurrentUser?.();
        return payload;
      } catch (error) {
        throw errors.normalizeError(error) ?? unavailableError();
      }
    }
    throw errors.createError("unauthenticated", "authentication-required");
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
