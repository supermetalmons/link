import {
  isEventPrizeWithdrawalCompletedResponse,
  isEventPrizeWithdrawalProcessingResponse,
  type EventPrizeId,
  type EventPrizeWithdrawalCompletedResponse,
  type EventPrizeWithdrawalResponse,
  type EventPrizeWithdrawalStatusRequest,
} from "@mons/shared/event-prizes";
import type { AuthTokenProvider } from "./authApi";

const EVENT_PRIZE_API_ROOT = "https://api.mons.link";
const EVENT_PRIZE_API_REQUEST_TIMEOUT_MS = 15_000;
const EVENT_PRIZE_API_DEADLINE_MS = 135_000;
const EVENT_PRIZE_API_POLL_INTERVAL_MS = 2_000;
const EVENT_PRIZE_API_MAX_RESPONSE_BYTES = 64 * 1024;

type EventPrizeApiDependencies = {
  deadlineMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class EventPrizeWithdrawalApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "EventPrizeWithdrawalApiError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthApiError(
  value: unknown,
): value is Error & { code: string; details?: unknown } {
  return (
    value instanceof Error &&
    value.name === "AuthApiError" &&
    "code" in value &&
    typeof value.code === "string"
  );
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > EVENT_PRIZE_API_MAX_RESPONSE_BYTES
  ) {
    cancelBody(response);
    throw new EventPrizeWithdrawalApiError(
      "unavailable",
      "Prize withdrawal service is unavailable.",
    );
  }
  if (!response.body) {
    throw new EventPrizeWithdrawalApiError(
      "unavailable",
      "Prize withdrawal service is unavailable.",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > EVENT_PRIZE_API_MAX_RESPONSE_BYTES) {
        throw new Error("oversized-response");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join("")) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof EventPrizeWithdrawalApiError) throw error;
    throw new EventPrizeWithdrawalApiError(
      "unavailable",
      "Prize withdrawal service is unavailable.",
    );
  }
}

function responseError(
  value: unknown,
  status: number,
): EventPrizeWithdrawalApiError {
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
      : "Prize withdrawal service is unavailable.";
  return new EventPrizeWithdrawalApiError(code, message, body.details);
}

async function postWithdrawalRequest(
  path: string,
  body: Record<string, unknown>,
  tokenProvider: AuthTokenProvider,
  deadlineAt: number,
  dependencies: Required<
    Pick<EventPrizeApiDependencies, "fetcher" | "now" | "requestTimeoutMs">
  >,
): Promise<EventPrizeWithdrawalResponse> {
  const remainingMs = deadlineAt - dependencies.now();
  if (remainingMs <= 0) {
    throw new EventPrizeWithdrawalApiError(
      "deadline-exceeded",
      "Prize withdrawal timed out.",
    );
  }
  const timeoutMs = Math.max(
    1,
    Math.min(dependencies.requestTimeoutMs, remainingMs),
  );
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        new EventPrizeWithdrawalApiError(
          timeoutMs >= remainingMs ? "deadline-exceeded" : "unavailable",
          "Prize withdrawal timed out.",
        ),
      );
    }, timeoutMs);
  });
  const run = async (): Promise<EventPrizeWithdrawalResponse> => {
    for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
      try {
        const token = await tokenProvider(authAttempt === 1);
        if (controller.signal.aborted) {
          throw new EventPrizeWithdrawalApiError(
            "unavailable",
            "Prize withdrawal timed out.",
          );
        }
        tokenProvider.assertCurrentUser?.();
        const response = await dependencies.fetcher(
          `${EVENT_PRIZE_API_ROOT}${path}`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (response.status === 401 && authAttempt === 0) {
          cancelBody(response);
          continue;
        }
        const payload = await readBoundedJson(response);
        if (!response.ok) throw responseError(payload, response.status);
        if (
          !isEventPrizeWithdrawalProcessingResponse(payload) &&
          !isEventPrizeWithdrawalCompletedResponse(payload)
        ) {
          throw new EventPrizeWithdrawalApiError(
            "unavailable",
            "Prize withdrawal service is unavailable.",
          );
        }
        tokenProvider.assertCurrentUser?.();
        return payload;
      } catch (error) {
        if (error instanceof EventPrizeWithdrawalApiError) throw error;
        if (isAuthApiError(error)) {
          throw new EventPrizeWithdrawalApiError(
            error.code,
            error.message,
            error.details,
          );
        }
        throw new EventPrizeWithdrawalApiError(
          "unavailable",
          "Prize withdrawal service is unavailable.",
        );
      }
    }
    throw new EventPrizeWithdrawalApiError(
      "unauthenticated",
      "authentication-required",
    );
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withdrawEventPrizeViaApi(
  eventId: string,
  prizeId: EventPrizeId,
  solanaAddress: string,
  tokenProvider: AuthTokenProvider,
  dependencyOverrides: EventPrizeApiDependencies = {},
): Promise<EventPrizeWithdrawalCompletedResponse> {
  const dependencies = {
    deadlineMs: dependencyOverrides.deadlineMs ?? EVENT_PRIZE_API_DEADLINE_MS,
    fetcher: dependencyOverrides.fetcher ?? fetch,
    now: dependencyOverrides.now ?? Date.now,
    pollIntervalMs:
      dependencyOverrides.pollIntervalMs ?? EVENT_PRIZE_API_POLL_INTERVAL_MS,
    requestTimeoutMs:
      dependencyOverrides.requestTimeoutMs ??
      EVENT_PRIZE_API_REQUEST_TIMEOUT_MS,
    sleep: dependencyOverrides.sleep ?? wait,
  };
  const deadlineAt = dependencies.now() + dependencies.deadlineMs;
  let response = await postWithdrawalRequest(
    "/events/prizes/withdrawals",
    { eventId, prizeId, solanaAddress },
    tokenProvider,
    deadlineAt,
    dependencies,
  );
  if (isEventPrizeWithdrawalCompletedResponse(response)) return response;

  const statusRequest: EventPrizeWithdrawalStatusRequest = {
    eventId: response.eventId,
    operationId: response.operationId,
    prizeId: response.prizeId,
  };
  while (dependencies.now() < deadlineAt) {
    await dependencies.sleep(
      Math.min(dependencies.pollIntervalMs, deadlineAt - dependencies.now()),
    );
    try {
      response = await postWithdrawalRequest(
        "/events/prizes/withdrawals/status",
        statusRequest,
        tokenProvider,
        deadlineAt,
        dependencies,
      );
      if (isEventPrizeWithdrawalCompletedResponse(response)) return response;
    } catch (error) {
      if (
        !(error instanceof EventPrizeWithdrawalApiError) ||
        error.code !== "unavailable" ||
        (isRecord(error.details) && error.details.terminal === true)
      ) {
        throw error;
      }
    }
  }
  throw new EventPrizeWithdrawalApiError(
    "deadline-exceeded",
    "Prize withdrawal timed out.",
  );
}

export {
  EVENT_PRIZE_API_DEADLINE_MS,
  EVENT_PRIZE_API_MAX_RESPONSE_BYTES,
  EVENT_PRIZE_API_POLL_INTERVAL_MS,
  EVENT_PRIZE_API_REQUEST_TIMEOUT_MS,
  EVENT_PRIZE_API_ROOT,
};
