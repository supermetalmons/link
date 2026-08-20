import {
  buildEventPrizeAnnouncement,
  type EventPrizeAnnouncement,
} from "../../../functions/telegram/eventPrizeAnnouncement.js";
import {
  sendTelegramMediaGroup,
  type TelegramFailure,
  type TelegramResult,
} from "../../../functions/telegram/client.js";
import {
  createFirebaseRtdbClient,
  type FirebaseRtdbClient,
} from "./firebaseRtdb.ts";
import { readBoundedBody } from "./http.ts";
import { hasValidTelegramBridgeSignature } from "./telegramBridgeAuth.ts";

export const EVENT_PRIZE_ANNOUNCEMENT_PATH =
  "/internal/telegram/event-prize-announcement";
export const MAX_EVENT_PRIZE_ANNOUNCEMENT_BODY_BYTES = 8 * 1024;

const ANNOUNCEMENT_RECORD_ROOT = "telegramEventPrizeAnnouncements";
const REQUEST_KEYS = new Set(["announcement", "eventId", "requestId"]);
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AnnouncementRequest = {
  announcement: EventPrizeAnnouncement;
  requestId: string;
};

type AnnouncementRecord = {
  messageIds: number[] | null;
  payloadDigest: string;
  status: string;
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
  rtdbClient?: FirebaseRtdbClient;
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

function parseAnnouncementRecord(value: unknown): AnnouncementRecord | null {
  const record = toRecord(value);
  return record &&
    typeof record.payloadDigest === "string" &&
    typeof record.status === "string"
    ? {
        payloadDigest: record.payloadDigest,
        status: record.status,
        messageIds: parseMessageIds(record.messageIds),
      }
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
      eventId: value.eventId,
      announcement: value.announcement,
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

function announcementRecordPath(requestId: string): string {
  return `${ANNOUNCEMENT_RECORD_ROOT}/${requestId}`;
}

async function reserveAnnouncement(
  client: FirebaseRtdbClient,
  request: AnnouncementRequest,
  payloadDigest: string,
  nowMs: number,
): Promise<Reservation> {
  const result = await client.transactPath(
    announcementRecordPath(request.requestId),
    (current) => {
      if (current !== null && current !== undefined) {
        return { commit: false, decision: "exists" };
      }
      return {
        value: {
          payloadDigest,
          status: "sending",
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        },
        decision: "reserved",
      };
    },
  );
  if (result.committed) {
    return { kind: "reserved" };
  }
  const record = parseAnnouncementRecord(result.value);
  if (!record || record.payloadDigest !== payloadDigest) {
    return { kind: "conflict" };
  }
  if (record.status === "sent" && record.messageIds) {
    return { kind: "sent", messageIds: record.messageIds };
  }
  return { kind: "duplicate" };
}

async function storeAnnouncementOutcome(
  client: FirebaseRtdbClient,
  request: AnnouncementRequest,
  payloadDigest: string,
  status: string,
  nowMs: number,
  messageIds?: number[],
): Promise<boolean> {
  const result = await client.transactPath(
    announcementRecordPath(request.requestId),
    (current) => {
      const record = parseAnnouncementRecord(current);
      if (
        !record ||
        record.payloadDigest !== payloadDigest ||
        record.status !== "sending"
      ) {
        return { commit: false, decision: "reservation-lost" };
      }
      return {
        value: {
          ...toRecord(current),
          status,
          updatedAtMs: nowMs,
          ...(messageIds ? { messageIds } : {}),
        },
        decision: "stored",
      };
    },
  );
  return result.committed;
}

async function storeOutcomeWithoutThrowing(
  client: FirebaseRtdbClient,
  request: AnnouncementRequest,
  payloadDigest: string,
  status: string,
  dependencies: EventPrizeAnnouncementDependencies,
  messageIds?: number[],
): Promise<boolean> {
  try {
    return await storeAnnouncementOutcome(
      client,
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
  client: FirebaseRtdbClient,
  payloadDigest: string,
  dependencies: EventPrizeAnnouncementDependencies,
): Promise<Response> {
  let result: TelegramResult;
  try {
    result = await (dependencies.send || sendTelegramMediaGroup)({
      chatId: env.TELEGRAM_EXTRA_CHAT_ID.trim(),
      imageUrls: request.announcement.imageUrls,
      text: request.announcement.text,
      silent: false,
      token: env.TELEGRAM_BOT_TOKEN.trim(),
    });
  } catch {
    await storeOutcomeWithoutThrowing(
      client,
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
      client,
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
      client,
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
      client,
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
  const client = dependencies.rtdbClient || createFirebaseRtdbClient(env);
  const payloadDigest = await createPayloadDigest(
    announcementRequest.announcement,
  );
  let reservation: Reservation;
  try {
    reservation = await reserveAnnouncement(
      client,
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
    client,
    payloadDigest,
    dependencies,
  );
}
