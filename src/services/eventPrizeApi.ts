import type {
  ApiPathRequest,
  ApiPathResponse,
} from "@mons/shared/api-contracts";
import {
  isEventPrizeWithdrawalCompletedResponse,
  isEventPrizeWithdrawalProcessingResponse,
  type EventPrizeId,
  type EventPrizeWithdrawalCompletedResponse,
  type EventPrizeWithdrawalResponse,
  type EventPrizeWithdrawalStatusRequest,
} from "@mons/shared/event-prizes";
import {
  authenticatedJsonRequest,
  type ApiErrorPolicy,
  type AuthTokenProvider,
} from "./apiTransport";
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

const withdrawalErrorPolicy: ApiErrorPolicy = {
  createError: (code, message, details) =>
    new EventPrizeWithdrawalApiError(code, message, details),
  normalizeResponseError: (error) =>
    error instanceof EventPrizeWithdrawalApiError ? error : undefined,
  normalizeError: (error) => {
    if (error instanceof EventPrizeWithdrawalApiError) return error;
    if (isAuthApiError(error)) {
      return new EventPrizeWithdrawalApiError(
        error.code,
        error.message,
        error.details,
      );
    }
    return undefined;
  },
  unavailableMessage: "Prize withdrawal service is unavailable.",
  timeoutMessage: "Prize withdrawal timed out.",
};

type WithdrawalPath =
  "/events/prizes/withdrawals" | "/events/prizes/withdrawals/status";

async function postWithdrawalRequest<const Path extends WithdrawalPath>(
  path: Path,
  body: ApiPathRequest<"POST", NoInfer<Path>>,
  tokenProvider: AuthTokenProvider,
  deadlineAt: number,
  dependencies: Required<
    Pick<EventPrizeApiDependencies, "fetcher" | "now" | "requestTimeoutMs">
  >,
): Promise<ApiPathResponse<"POST", Path>> {
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
  return authenticatedJsonRequest({
    url: `${EVENT_PRIZE_API_ROOT}${path}`,
    createRequestInit: () => ({
      method: "POST",
      body: JSON.stringify(body),
    }),
    tokenProvider,
    validate: (value): value is EventPrizeWithdrawalResponse =>
      isEventPrizeWithdrawalProcessingResponse(value) ||
      isEventPrizeWithdrawalCompletedResponse(value),
    timeoutMs,
    maxResponseBytes: EVENT_PRIZE_API_MAX_RESPONSE_BYTES,
    fetcher: dependencies.fetcher,
    assertCurrentUser: () => tokenProvider.assertCurrentUser?.(),
    errors: {
      ...withdrawalErrorPolicy,
      timeoutCode:
        timeoutMs >= remainingMs ? "deadline-exceeded" : "unavailable",
    },
  });
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
