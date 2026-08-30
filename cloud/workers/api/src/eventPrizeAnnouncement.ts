import {
  buildEventPrizeAnnouncement,
  type EventPrizeAnnouncement,
} from "../../../functions/telegram/eventPrizeAnnouncement.js";
import {
  sendTelegramMediaGroup,
  type TelegramFailure,
  type TelegramResult,
} from "../../../functions/telegram/client.js";
import { readBoundedBody } from "./http.ts";
import { hasValidTelegramBridgeSignature } from "./telegramBridgeAuth.ts";
import {
  createD1TelegramAnnouncementRepository,
  readTelegramStorageMode,
  type TelegramAnnouncementRepository,
} from "./telegramD1.ts";

export const EVENT_PRIZE_ANNOUNCEMENT_PATH =
  "/internal/telegram/event-prize-announcement";
export const MAX_EVENT_PRIZE_ANNOUNCEMENT_BODY_BYTES = 8 * 1024;

const REQUEST_KEYS = new Set(["collectionName", "eventId", "requestId"]);
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AnnouncementRequest = {
  announcement: EventPrizeAnnouncement;
  requestId: string;
};

type Reservation =
  | { kind: "reserved" }
  | { kind: "conflict" }
  | { kind: "duplicate" }
  | { kind: "sent"; messageIds: number[] };

type EventPrizeAnnouncementDependencies = {
  logError?: (record: Record<string, unknown>) => void;
  logSuccess?: (record: Record<string, unknown>) => void;
  now?: () => number;
  repository?: TelegramAnnouncementRepository;
  send?: typeof sendTelegramMediaGroup;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMessageIds(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((messageId) => Number.isInteger(messageId) && messageId > 0)
    ? value
    : null;
}

function announcementResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function failureBody(error: string, result?: TelegramFailure) {
  return {
    ok: false,
    error,
    ...(result
      ? {
          code: result.code,
          description: result.description,
          ...(result.retryAfterSeconds
            ? { retryAfterSeconds: result.retryAfterSeconds }
            : {}),
        }
      : {}),
  };
}

function logFailure(
  dependencies: EventPrizeAnnouncementDependencies,
  request: AnnouncementRequest,
  classification: string,
  code: string,
): void {
  (
    dependencies.logError || ((record) => console.error(JSON.stringify(record)))
  )({
    event: "event_prize_announcement_failed",
    eventId: request.announcement.eventId,
    requestId: request.requestId,
    classification,
    code,
  });
}

function telegramFailureResponse(
  result: TelegramFailure,
  request: AnnouncementRequest,
  dependencies: EventPrizeAnnouncementDependencies,
): Response {
  logFailure(dependencies, request, result.classification, result.code);
  if (result.classification === "uncertain") {
    return announcementResponse(
      409,
      failureBody("telegram-delivery-uncertain", result),
    );
  }
  if (result.classification === "retryable") {
    return announcementResponse(
      503,
      failureBody("telegram-unavailable", result),
      result.retryAfterSeconds
        ? { "Retry-After": String(result.retryAfterSeconds) }
        : undefined,
    );
  }
  return announcementResponse(502, failureBody("telegram-rejected", result));
}

function parseAnnouncementRequest(body: string): AnnouncementRequest {
  const value = toRecord(JSON.parse(body) as unknown);
  if (
    !value ||
    Object.keys(value).length !== REQUEST_KEYS.size ||
    Object.keys(value).some((key) => !REQUEST_KEYS.has(key)) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    throw new TypeError("invalid-request");
  }
  return {
    requestId: value.requestId,
    announcement: buildEventPrizeAnnouncement({
      collectionName: value.collectionName,
      eventId: value.eventId,
    }),
  };
}

async function createPayloadDigest(
  announcement: EventPrizeAnnouncement,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${announcement.eventId}\0${announcement.text}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function reserveAnnouncement(
  repository: TelegramAnnouncementRepository,
  request: AnnouncementRequest,
  payloadDigest: string,
  nowMs: number,
): Promise<Reservation> {
  const reserved = await repository.reserve({
    requestId: request.requestId,
    payloadDigest,
    createdAtMs: nowMs,
  });
  if (reserved === "reserved") return { kind: "reserved" };
  const record = reserved;
  if (!record || record.payloadDigest !== payloadDigest) {
    return { kind: "conflict" };
  }
  if (record.status === "sent" && record.messageIds) {
    return { kind: "sent", messageIds: record.messageIds };
  }
  return { kind: "duplicate" };
}

async function storeAnnouncementOutcome(
  repository: TelegramAnnouncementRepository,
  request: AnnouncementRequest,
  payloadDigest: string,
  status: string,
  nowMs: number,
  messageIds?: number[],
): Promise<boolean> {
  return repository.storeOutcome({
    requestId: request.requestId,
    payloadDigest,
    status,
    updatedAtMs: nowMs,
    ...(messageIds ? { messageIds } : {}),
  });
}

async function storeOutcomeWithoutThrowing(
  repository: TelegramAnnouncementRepository,
  request: AnnouncementRequest,
  payloadDigest: string,
  status: string,
  dependencies: EventPrizeAnnouncementDependencies,
  messageIds?: number[],
): Promise<boolean> {
  try {
    return await storeAnnouncementOutcome(
      repository,
      request,
      payloadDigest,
      status,
      (dependencies.now || Date.now)(),
      messageIds,
    );
  } catch {
    logFailure(dependencies, request, "repository", "outcome-write-failed");
    return false;
  }
}

function successResponse(
  request: AnnouncementRequest,
  messageIds: number[],
): Response {
  return announcementResponse(200, {
    ok: true,
    eventId: request.announcement.eventId,
    eventUrl: request.announcement.eventUrl,
    messageIds,
  });
}

async function sendAnnouncement(
  request: AnnouncementRequest,
  env: Env,
  repository: TelegramAnnouncementRepository,
  payloadDigest: string,
  dependencies: EventPrizeAnnouncementDependencies,
): Promise<Response> {
  let result: TelegramResult;
  try {
    result = await (dependencies.send || sendTelegramMediaGroup)({
      chatId: env.TELEGRAM_EXTRA_CHAT_ID.trim(),
      imageUrls: request.announcement.imageUrls,
      text: request.announcement.text,
      hasSpoiler: true,
      parseMode: request.announcement.parseMode,
      silent: false,
      token: env.TELEGRAM_BOT_TOKEN.trim(),
    });
  } catch {
    await storeOutcomeWithoutThrowing(
      repository,
      request,
      payloadDigest,
      "uncertain",
      dependencies,
    );
    logFailure(dependencies, request, "uncertain", "send-threw");
    return announcementResponse(
      409,
      failureBody("telegram-delivery-uncertain"),
    );
  }
  if (!result.ok) {
    await storeOutcomeWithoutThrowing(
      repository,
      request,
      payloadDigest,
      result.classification,
      dependencies,
    );
    return telegramFailureResponse(result, request, dependencies);
  }
  const messageIds = parseMessageIds(result.messageIds);
  if (
    !messageIds ||
    messageIds.length !== request.announcement.imageUrls.length
  ) {
    await storeOutcomeWithoutThrowing(
      repository,
      request,
      payloadDigest,
      "uncertain",
      dependencies,
    );
    logFailure(dependencies, request, "uncertain", "missing-message-id");
    return announcementResponse(409, {
      ok: false,
      error: "telegram-delivery-uncertain",
      code: "missing-message-id",
      description: "Telegram did not return every message ID.",
    });
  }
  if (
    !(await storeOutcomeWithoutThrowing(
      repository,
      request,
      payloadDigest,
      "sent",
      dependencies,
      messageIds,
    ))
  ) {
    return announcementResponse(
      409,
      failureBody("telegram-delivery-uncertain"),
    );
  }
  (
    dependencies.logSuccess ||
    ((record) => console.info(JSON.stringify(record)))
  )({
    event: "event_prize_announcement_sent",
    eventId: request.announcement.eventId,
    requestId: request.requestId,
    messageCount: messageIds.length,
  });
  return successResponse(request, messageIds);
}

export async function handleEventPrizeAnnouncement(
  request: Request,
  env: Env,
  dependencies: EventPrizeAnnouncementDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return announcementResponse(405, {
      ok: false,
      error: "method-not-allowed",
    });
  }
  let body: string;
  try {
    body = await readBoundedBody(
      request,
      MAX_EVENT_PRIZE_ANNOUNCEMENT_BODY_BYTES,
    );
  } catch {
    return announcementResponse(400, {
      ok: false,
      error: "invalid-request",
    });
  }
  const timestamp =
    request.headers.get("X-Mons-Telegram-Timestamp")?.trim() || "";
  const signature =
    request.headers.get("X-Mons-Telegram-Signature")?.trim() || "";
  const secret = env.TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET.trim();
  if (
    !secret ||
    !(await hasValidTelegramBridgeSignature(
      body,
      secret,
      timestamp,
      signature,
      (dependencies.now || Date.now)(),
    ))
  ) {
    return announcementResponse(401, {
      ok: false,
      error: "unauthenticated",
    });
  }
  let announcementRequest: AnnouncementRequest;
  try {
    announcementRequest = parseAnnouncementRequest(body);
  } catch {
    return announcementResponse(400, {
      ok: false,
      error: "invalid-request",
    });
  }
  if (!env.TELEGRAM_BOT_TOKEN.trim() || !env.TELEGRAM_EXTRA_CHAT_ID.trim()) {
    logFailure(
      dependencies,
      announcementRequest,
      "configuration",
      "unavailable",
    );
    return announcementResponse(503, failureBody("telegram-unavailable"));
  }
  const storageMode = await readTelegramStorageMode(env.TELEGRAM_DB);
  if (storageMode === "frozen") {
    return announcementResponse(503, failureBody("telegram-frozen"), {
      "Retry-After": "60",
    });
  }
  const repository =
    dependencies.repository ||
    createD1TelegramAnnouncementRepository(env.TELEGRAM_DB);
  const payloadDigest = await createPayloadDigest(
    announcementRequest.announcement,
  );
  let reservation: Reservation;
  try {
    reservation = await reserveAnnouncement(
      repository,
      announcementRequest,
      payloadDigest,
      (dependencies.now || Date.now)(),
    );
  } catch {
    logFailure(dependencies, announcementRequest, "repository", "unavailable");
    return announcementResponse(503, failureBody("telegram-unavailable"));
  }
  if (reservation.kind === "conflict") {
    return announcementResponse(400, failureBody("invalid-request"));
  }
  if (reservation.kind === "duplicate") {
    return announcementResponse(
      409,
      failureBody("telegram-delivery-uncertain"),
    );
  }
  if (reservation.kind === "sent") {
    return reservation.messageIds.length ===
      announcementRequest.announcement.imageUrls.length
      ? successResponse(announcementRequest, reservation.messageIds)
      : announcementResponse(409, failureBody("telegram-delivery-uncertain"));
  }
  return sendAnnouncement(
    announcementRequest,
    env,
    repository,
    payloadDigest,
    dependencies,
  );
}
