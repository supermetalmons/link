import {
  buildEventPrizeAnnouncement,
  EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS,
} from "../../../functions/telegram/eventPrizeAnnouncement.js";
import {
  buildSundayMonsReminder,
  isSundayMonsReminderLeadMs,
} from "../../../functions/telegram/sundayMonsReminder.js";
import {
  sendTelegramMediaGroup,
  sendTelegramMessage,
  TELEGRAM_HTTP_TIMEOUT_MS,
  type TelegramResult,
} from "../../../functions/telegram/client.js";
import { createEventLockManagerCore } from "../../../functions/events/lockManagerCore.js";
import type { TelegramRepository } from "../../../functions/telegram/deliveryEngine.js";
import { readEventRuntimeControl } from "./eventD1.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  EVENT_ANNOUNCEMENT_KINDS,
  EVENT_ANNOUNCEMENT_SPECS,
  type EventAnnouncementKind,
} from "./eventAnnouncementKinds.ts";
import { profileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";
import {
  createD1TelegramAnnouncementRepository,
  createD1TelegramRepository,
  readTelegramStorageMode,
  type TelegramAnnouncementRecord,
  type TelegramAnnouncementRepository,
} from "./telegramD1.ts";

export type EventPrizeAnnouncementDeliveryInput = {
  kind?: EventAnnouncementKind;
  eventId: string;
  startAtMs: number;
  runAtMs: number;
  firstQueuedAtMs: number;
};

export type EventPrizeAnnouncementDeliveryResult = {
  status: "sent" | "skipped" | "uncertain" | "terminal" | "retryable";
  reason?: string;
  retryAtMs?: number;
};

export type EventPrizeAnnouncementDeliveryDependencies = {
  controlsEnabled?: (env: Env) => Promise<boolean>;
  eventRepository?: Pick<
    GameplayRepository,
    "getRtdbPath" | "transactRtdbPath"
  >;
  log?: (record: Record<string, unknown>) => void;
  now?: () => number;
  repository?: TelegramAnnouncementRepository;
  retryControl?: Pick<
    TelegramRepository,
    "getRetryNotBeforeMs" | "extendRetryNotBeforeMs"
  >;
  send?: typeof sendTelegramMediaGroup;
  sendMessage?: typeof sendTelegramMessage;
};

type AlbumPayload = {
  chatId: string;
  imageUrls: string[];
  text: string;
  parseMode: "HTML";
  hasSpoiler: true;
  silent: false;
};

type ReminderPayload = {
  chatId: string;
  text: string;
  parseMode: "HTML";
  silent: false;
};

type AnnouncementPayload = AlbumPayload | ReminderPayload;

function parsePayload(
  value: unknown,
  kind: EventAnnouncementKind,
): AnnouncementPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.chatId !== "string" ||
    !payload.chatId.trim() ||
    typeof payload.text !== "string" ||
    !payload.text ||
    payload.parseMode !== "HTML" ||
    payload.silent !== false
  ) {
    return null;
  }
  if (kind === "reminder") {
    if (
      Object.hasOwn(payload, "imageUrls") ||
      Object.hasOwn(payload, "hasSpoiler")
    ) {
      return null;
    }
    return {
      chatId: payload.chatId,
      text: payload.text,
      parseMode: "HTML",
      silent: false,
    };
  }
  if (
    payload.hasSpoiler !== true ||
    !Array.isArray(payload.imageUrls) ||
    payload.imageUrls.length < 2 ||
    payload.imageUrls.length > 10 ||
    !payload.imageUrls.every((url) => typeof url === "string" && url.trim())
  ) {
    return null;
  }
  return {
    chatId: payload.chatId,
    imageUrls: payload.imageUrls,
    text: payload.text,
    parseMode: "HTML",
    hasSpoiler: true,
    silent: false,
  };
}

async function createPayloadDigest(
  payload: AnnouncementPayload,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function controlsEnabled(env: Env): Promise<boolean> {
  const [profileEnabled, telegramMode, eventControl] = await Promise.all([
    profileBackgroundMutationsEnabled(env),
    readTelegramStorageMode(env.TELEGRAM_DB),
    readEventRuntimeControl(env.EVENT_DB),
  ]);
  return (
    profileEnabled && telegramMode === "d1" && eventControl.storageMode === "d1"
  );
}

function priorOutcome(
  record: TelegramAnnouncementRecord | null,
): EventPrizeAnnouncementDeliveryResult | null {
  if (!record) return null;
  if (record.status === "sent")
    return { status: "sent", reason: "already-sent" };
  if (record.status === "sending" || record.status === "uncertain") {
    return { status: "uncertain", reason: "previous-send-unresolved" };
  }
  if (record.status !== "retryable") {
    return { status: "terminal", reason: "previous-send-rejected" };
  }
  return null;
}

export async function deliverEventPrizeAnnouncement(
  env: Env,
  input: EventPrizeAnnouncementDeliveryInput,
  dependencies: EventPrizeAnnouncementDeliveryDependencies = {},
): Promise<EventPrizeAnnouncementDeliveryResult> {
  const now = dependencies.now || Date.now;
  const kind = input.kind ?? "prizes";
  if (!EVENT_ANNOUNCEMENT_KINDS.includes(kind)) {
    return { status: "skipped", reason: "invalid-kind" };
  }
  const specification = EVENT_ANNOUNCEMENT_SPECS[kind];
  const leadMs = input.startAtMs - input.runAtMs;
  const log =
    dependencies.log || ((record) => console.info(JSON.stringify(record)));
  const deadlineAtMs = input.runAtMs + EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS;
  const retry = (
    reason: string,
    retryAtMs = now() + 1_000,
  ): EventPrizeAnnouncementDeliveryResult =>
    retryAtMs >= deadlineAtMs
      ? { status: "skipped", reason: "delivery-window-expired" }
      : { status: "retryable", reason, retryAtMs };
  if (
    !isSafeFirebaseKey(input.eventId) ||
    ![input.startAtMs, input.runAtMs, input.firstQueuedAtMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    (kind === "reminder"
      ? !isSundayMonsReminderLeadMs(leadMs)
      : leadMs !== specification.leadMs)
  ) {
    return { status: "skipped", reason: "invalid-schedule" };
  }
  if (input.firstQueuedAtMs > input.runAtMs) {
    return { status: "skipped", reason: "discovered-too-late" };
  }
  if (now() < input.runAtMs) return retry("not-due", input.runAtMs);
  if (now() >= deadlineAtMs) {
    return { status: "skipped", reason: "delivery-window-expired" };
  }
  const readControls = dependencies.controlsEnabled || controlsEnabled;
  let enabled: boolean;
  try {
    enabled = await readControls(env);
  } catch {
    return retry("control-unavailable");
  }
  if (!enabled) return retry("writes-frozen");
  if (!env.TELEGRAM_BOT_TOKEN.trim() || !env.TELEGRAM_EXTRA_CHAT_ID.trim()) {
    return retry("configuration-unavailable");
  }
  const repository =
    dependencies.repository ||
    createD1TelegramAnnouncementRepository(env.TELEGRAM_DB);
  const retryControl =
    dependencies.retryControl ||
    createD1TelegramRepository(env.TELEGRAM_DB, { now });
  const eventRepository =
    dependencies.eventRepository || createEventGameplayRepository(env);
  const lockManager = createEventLockManagerCore({
    now,
    createLockId: () => crypto.randomUUID(),
    transactPath: (path, updater) =>
      eventRepository.transactRtdbPath(path, updater),
  });
  let lock;
  try {
    lock = await lockManager.acquireEventLock(
      input.eventId,
      specification.reason,
    );
  } catch {
    return retry("event-lock-unavailable");
  }
  if (!lock) return retry("event-locked");
  const requestId = `event:${input.eventId}:${kind}:v1`;
  const attemptId = crypto.randomUUID();
  let reservedDigest: string | null = null;
  let sendStarted = false;
  const outcome = async (
    status: string,
    errorCode?: string,
    retryAtMs?: number,
    messageIds?: number[],
  ): Promise<boolean> => {
    try {
      return await repository.storeOutcome({
        requestId,
        payloadDigest: reservedDigest || "",
        attemptId,
        status,
        updatedAtMs: now(),
        ...(errorCode ? { errorCode } : {}),
        ...(retryAtMs ? { retryAtMs } : {}),
        ...(messageIds ? { messageIds } : {}),
      });
    } catch {
      log({
        event: "event_prize_announcement_outcome_failed",
        kind,
        eventId: input.eventId,
        attemptId,
      });
      return false;
    }
  };
  try {
    const eventData = await eventRepository.getRtdbPath(
      `events/${input.eventId}`,
    );
    if (
      !specification.isEligible(input.eventId, eventData) ||
      (eventData as { startAtMs?: unknown }).startAtMs !== input.startAtMs
    ) {
      return { status: "skipped", reason: "event-no-longer-eligible" };
    }
    const existing = await repository.get(requestId);
    if (existing && (existing.kind ?? "prizes") !== kind) {
      return { status: "terminal", reason: "persisted-kind-conflict" };
    }
    const previous = priorOutcome(existing);
    if (previous) return previous;
    const retryAtMs = Math.max(
      existing?.retryAtMs || 0,
      await retryControl.getRetryNotBeforeMs(),
    );
    if (retryAtMs > now()) return retry("retry-not-due", retryAtMs);
    const announcement =
      kind === "prizes"
        ? buildEventPrizeAnnouncement({ eventId: input.eventId })
        : buildSundayMonsReminder({
            eventId: input.eventId,
            eventData,
            leadMs,
          });
    const payload =
      existing?.startAtMs === input.startAtMs
        ? parsePayload(existing.payload, kind)
        : "imageUrls" in announcement
          ? {
              chatId: env.TELEGRAM_EXTRA_CHAT_ID.trim(),
              imageUrls: announcement.imageUrls,
              text: announcement.text,
              parseMode: announcement.parseMode,
              hasSpoiler: true as const,
              silent: false as const,
            }
          : {
              chatId: env.TELEGRAM_EXTRA_CHAT_ID.trim(),
              text: announcement.text,
              parseMode: announcement.parseMode,
              silent: false as const,
            };
    if (!payload)
      return { status: "terminal", reason: "invalid-persisted-payload" };
    const payloadDigest = await createPayloadDigest(payload);
    if (
      existing?.startAtMs === input.startAtMs &&
      existing.payloadDigest !== payloadDigest
    ) {
      return { status: "terminal", reason: "persisted-payload-conflict" };
    }
    if (
      !(await readControls(env)) ||
      !(await lockManager.refreshEventLock(lock))
    ) {
      return retry("event-lock-or-control-changed");
    }
    if (now() >= deadlineAtMs)
      return { status: "skipped", reason: "delivery-window-expired" };
    const reservation = await repository.reserve({
      requestId,
      payloadDigest,
      createdAtMs: now(),
      attempt: {
        ...input,
        kind,
        payload,
        attemptId,
        expectedAttemptId: existing?.attemptId || null,
      },
    });
    if (reservation !== "reserved") {
      return (
        priorOutcome(reservation) ||
        retry("reservation-changed", reservation.retryAtMs || now() + 1_000)
      );
    }
    reservedDigest = payloadDigest;
    if (
      !(await readControls(env)) ||
      !(await lockManager.refreshEventLock(lock))
    ) {
      const retryAtMs = now() + 1_000;
      if (
        !(await outcome(
          "retryable",
          "event-lock-or-control-changed",
          retryAtMs,
        ))
      ) {
        return { status: "uncertain", reason: "outcome-write-failed" };
      }
      return retry("event-lock-or-control-changed", retryAtMs);
    }
    const latestRetryAtMs = await retryControl.getRetryNotBeforeMs();
    if (latestRetryAtMs > now()) {
      if (!(await outcome("retryable", "retry-not-due", latestRetryAtMs))) {
        return { status: "uncertain", reason: "outcome-write-failed" };
      }
      return retry("retry-not-due", latestRetryAtMs);
    }
    const remainingMs = deadlineAtMs - now();
    if (remainingMs <= 0) {
      await outcome("retryable", "delivery-window-expired", now() + 1_000);
      return { status: "skipped", reason: "delivery-window-expired" };
    }
    let result: TelegramResult;
    try {
      sendStarted = true;
      const send =
        kind === "prizes"
          ? dependencies.send || sendTelegramMediaGroup
          : dependencies.sendMessage || sendTelegramMessage;
      result = await send({
        ...payload,
        token: env.TELEGRAM_BOT_TOKEN.trim(),
        timeoutMs: Math.min(TELEGRAM_HTTP_TIMEOUT_MS, remainingMs),
      });
    } catch {
      await outcome("uncertain", "send-threw");
      return { status: "uncertain", reason: "send-threw" };
    }
    if (!result.ok) {
      if (result.classification === "retryable") {
        const delayMs = Math.max(
          Math.min(
            30_000,
            1_000 * 2 ** Math.min(existing?.attemptCount || 0, 5),
          ),
          (result.retryAfterSeconds || 0) * 1_000,
        );
        const nextRetryAtMs = now() + delayMs;
        if (!(await outcome("retryable", result.code, nextRetryAtMs))) {
          return { status: "uncertain", reason: "outcome-write-failed" };
        }
        if (result.code === "rate-limited") {
          try {
            await retryControl.extendRetryNotBeforeMs(nextRetryAtMs);
          } catch {
            log({
              event: "event_prize_announcement_retry_barrier_failed",
              kind,
              eventId: input.eventId,
              attemptId,
            });
          }
        }
        return retry(result.code, nextRetryAtMs);
      }
      const status =
        result.classification === "uncertain" ? "uncertain" : "terminal";
      if (!(await outcome(status, result.code))) {
        return { status: "uncertain", reason: "outcome-write-failed" };
      }
      return { status, reason: result.code };
    }
    const messageIds =
      kind === "prizes" ? result.messageIds : [result.messageId];
    const expectedMessageCount =
      "imageUrls" in payload && Array.isArray(payload.imageUrls)
        ? payload.imageUrls.length
        : 1;
    if (
      !Array.isArray(messageIds) ||
      messageIds.length !== expectedMessageCount ||
      !messageIds.every(
        (messageId): messageId is number =>
          typeof messageId === "number" &&
          Number.isSafeInteger(messageId) &&
          messageId > 0,
      )
    ) {
      await outcome("uncertain", "missing-message-ids");
      return { status: "uncertain", reason: "missing-message-ids" };
    }
    if (!(await outcome("sent", undefined, undefined, messageIds))) {
      return { status: "uncertain", reason: "outcome-write-failed" };
    }
    log({
      event: "event_prize_announcement_sent",
      kind,
      eventId: input.eventId,
      attemptId,
      messageCount: messageIds.length,
    });
    return { status: "sent" };
  } catch {
    if (reservedDigest) {
      if (sendStarted) {
        await outcome("uncertain", "delivery-outcome-failed");
        return { status: "uncertain", reason: "delivery-outcome-failed" };
      }
      if (
        !(await outcome(
          "retryable",
          "delivery-preparation-failed",
          now() + 1_000,
        ))
      ) {
        return { status: "uncertain", reason: "outcome-write-failed" };
      }
    }
    return retry("delivery-preparation-failed");
  } finally {
    await lockManager.releaseEventLock(lock);
  }
}
