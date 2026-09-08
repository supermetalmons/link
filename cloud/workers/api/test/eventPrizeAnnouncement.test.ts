import assert from "node:assert/strict";
import test from "node:test";
import { buildEventPrizeAnnouncement } from "../../../functions/telegram/eventPrizeAnnouncement.js";
import { buildSundayMonsReminder } from "../../../functions/telegram/sundayMonsReminder.js";
import type { TelegramResult } from "../../../functions/telegram/client.js";
import {
  deliverEventPrizeAnnouncement,
  type EventPrizeAnnouncementDeliveryDependencies,
  type EventPrizeAnnouncementDeliveryInput,
} from "../src/eventPrizeAnnouncement.ts";
import type {
  TelegramAnnouncementRecord,
  TelegramAnnouncementRepository,
} from "../src/telegramD1.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const RUN_AT_MS = Date.UTC(2026, 8, 6, 12);
const EVENT_ID = "z3oj52Iiime";
const REQUEST_ID = `event:${EVENT_ID}:prizes:v1`;
const INPUT: EventPrizeAnnouncementDeliveryInput = {
  eventId: EVENT_ID,
  startAtMs: RUN_AT_MS + 3_600_000,
  runAtMs: RUN_AT_MS,
  firstQueuedAtMs: RUN_AT_MS - 60_000,
};
const SUCCESS: TelegramResult = {
  ok: true,
  outcome: "sent",
  messageIds: [101, 102, 103],
  httpStatus: 200,
};
const env = {
  ...TELEGRAM_TEST_ENV,
  TELEGRAM_BOT_TOKEN: " token\n",
  TELEGRAM_EXTRA_CHAT_ID: " community-chat\n",
} as Env;

function memoryAnnouncementRepository() {
  const values = new Map<string, TelegramAnnouncementRecord>();
  const repository: TelegramAnnouncementRepository = {
    get: async (requestId) => values.get(requestId) ?? null,
    async reserve(input) {
      const current = values.get(input.requestId);
      if (
        current &&
        (!input.attempt ||
          current.status !== "retryable" ||
          current.eventId !== input.attempt.eventId ||
          (current.kind ?? "prizes") !== (input.attempt.kind ?? "prizes") ||
          current.attemptId !== input.attempt.expectedAttemptId ||
          !current.retryAtMs ||
          current.retryAtMs > input.createdAtMs)
      ) {
        return current;
      }
      values.set(input.requestId, {
        ...current,
        payloadDigest: input.payloadDigest,
        status: "sending",
        messageIds: null,
        createdAtMs: current?.createdAtMs || input.createdAtMs,
        updatedAtMs: input.createdAtMs,
        ...(input.attempt
          ? {
              eventId: input.attempt.eventId,
              kind: input.attempt.kind ?? "prizes",
              startAtMs: input.attempt.startAtMs,
              runAtMs: input.attempt.runAtMs,
              firstQueuedAtMs: input.attempt.firstQueuedAtMs,
              payload: input.attempt.payload,
              attemptId: input.attempt.attemptId,
              attemptCount: (current?.attemptCount || 0) + 1,
              retryAtMs: null,
              errorCode: null,
            }
          : {}),
      });
      return "reserved";
    },
    async storeOutcome(input) {
      const current = values.get(input.requestId);
      if (
        !current ||
        current.payloadDigest !== input.payloadDigest ||
        current.status !== "sending" ||
        (current.attemptId ?? null) !== (input.attemptId ?? null)
      ) {
        return false;
      }
      values.set(input.requestId, {
        ...current,
        status: input.status,
        updatedAtMs: input.updatedAtMs,
        messageIds: input.messageIds ?? null,
        retryAtMs: input.retryAtMs ?? null,
        errorCode: input.errorCode ?? null,
      });
      return true;
    },
  };
  return { values, repository };
}

function fixture(input = INPUT) {
  let nowMs = input.runAtMs;
  let retryNotBeforeMs = 0;
  let eventData: unknown = {
    status: "scheduled",
    startAtMs: input.startAtMs,
    isSundayMons: true,
    telegramAnnouncements: { invite: false, matches: false, results: false },
  };
  const locks = new Map<string, unknown>();
  const { values, repository } = memoryAnnouncementRepository();
  const sends: Record<string, unknown>[] = [];
  const reminderSends: Record<string, unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const dependencies: EventPrizeAnnouncementDeliveryDependencies = {
    now: () => nowMs,
    controlsEnabled: async () => true,
    eventRepository: {
      getRtdbPath: async () => eventData,
      transactRtdbPath: async (path, updater) => {
        const current = locks.get(path) ?? null;
        const result = updater(current) as {
          commit?: false;
          decision?: string;
          value?: unknown;
        };
        if (result.commit === false) {
          return {
            committed: false,
            decision: result.decision,
            value: current,
          };
        }
        if (result.value === null) locks.delete(path);
        else locks.set(path, result.value);
        return {
          committed: true,
          decision: result.decision,
          value: result.value,
        };
      },
    },
    repository,
    retryControl: {
      getRetryNotBeforeMs: async () => retryNotBeforeMs,
      extendRetryNotBeforeMs: async (candidate) =>
        (retryNotBeforeMs = Math.max(retryNotBeforeMs, candidate)),
    },
    send: async (input) => {
      assert.equal(locks.size, 1);
      sends.push(input);
      return SUCCESS;
    },
    sendMessage: async (input) => {
      assert.equal(locks.size, 1);
      reminderSends.push(input);
      return { ok: true, outcome: "sent", messageId: 104, httpStatus: 200 };
    },
    log: (record) => logs.push(record),
  };
  return {
    dependencies,
    values,
    sends,
    reminderSends,
    locks,
    logs,
    setNow: (value: number) => void (nowMs = value),
    setEvent: (value: unknown) => void (eventData = value),
    retryNotBefore: () => retryNotBeforeMs,
    deliver: (request = input) =>
      deliverEventPrizeAnnouncement(env, request, dependencies),
  };
}

test("sends a catalog album independently of event Telegram preferences and stores its receipt", async () => {
  const state = fixture();
  assert.deepEqual(await state.deliver(), { status: "sent" });
  const announcement = buildEventPrizeAnnouncement({ eventId: EVENT_ID });
  assert.deepEqual(state.sends, [
    {
      chatId: "community-chat",
      imageUrls: announcement.imageUrls,
      text: announcement.text,
      parseMode: "HTML",
      hasSpoiler: true,
      silent: false,
      token: "token",
      timeoutMs: 10_000,
    },
  ]);
  const receipt = state.values.get(REQUEST_ID)!;
  assert.equal(receipt.status, "sent");
  assert.equal(receipt.eventId, EVENT_ID);
  assert.equal(receipt.startAtMs, INPUT.startAtMs);
  assert.equal(receipt.firstQueuedAtMs, INPUT.firstQueuedAtMs);
  assert.deepEqual(receipt.messageIds, [101, 102, 103]);
  assert.equal(receipt.attemptCount, 1);
  assert.equal(state.locks.size, 0);
});

test("rejects invalid, late-discovered and expired schedules without reserving delivery", async () => {
  for (const [input, time, reason] of [
    [{ ...INPUT, runAtMs: INPUT.runAtMs - 1 }, RUN_AT_MS, "invalid-schedule"],
    [
      { ...INPUT, firstQueuedAtMs: RUN_AT_MS + 1 },
      RUN_AT_MS + 1,
      "discovered-too-late",
    ],
    [INPUT, RUN_AT_MS + 60_000, "delivery-window-expired"],
  ] as const) {
    const state = fixture();
    state.setNow(time);
    assert.deepEqual(await state.deliver(input), { status: "skipped", reason });
    assert.equal(state.values.size, 0);
    assert.equal(state.sends.length, 0);
  }
  const early = fixture();
  early.setNow(RUN_AT_MS - 100);
  assert.deepEqual(await early.deliver(), {
    status: "retryable",
    reason: "not-due",
    retryAtMs: RUN_AT_MS,
  });
});

test("checks the canonical event type, status and scheduled start under the domain lease", async () => {
  for (const event of [
    null,
    { status: "active", startAtMs: INPUT.startAtMs, isSundayMons: true },
    { status: "scheduled", startAtMs: INPUT.startAtMs, isSundayMons: false },
    { status: "scheduled", startAtMs: INPUT.startAtMs, isSundayMons: "true" },
    {
      status: "scheduled",
      startAtMs: INPUT.startAtMs + 60_000,
      isSundayMons: true,
    },
  ]) {
    const state = fixture();
    state.setEvent(event);
    assert.deepEqual(await state.deliver(), {
      status: "skipped",
      reason: "event-no-longer-eligible",
    });
    assert.equal(state.sends.length, 0);
    assert.equal(state.values.size, 0);
    assert.equal(state.locks.size, 0);
  }
  const unknown = fixture();
  assert.equal(
    (await unknown.deliver({ ...INPUT, eventId: "unconfigured" })).status,
    "skipped",
  );
});

test("concurrent executions cannot send twice and successful delivery survives postponement", async () => {
  const state = fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let sends = 0;
  state.dependencies.send = async () => {
    sends++;
    entered();
    await pending;
    return SUCCESS;
  };
  const first = state.deliver();
  await sending;
  assert.equal((await state.deliver()).reason, "event-locked");
  release();
  assert.equal((await first).status, "sent");
  assert.deepEqual(await state.deliver(), {
    status: "sent",
    reason: "already-sent",
  });
  const postponed = {
    ...INPUT,
    startAtMs: INPUT.startAtMs + 3_600_000,
    runAtMs: RUN_AT_MS + 3_600_000,
  };
  state.setNow(postponed.runAtMs);
  state.setEvent({
    status: "scheduled",
    startAtMs: postponed.startAtMs,
    isSundayMons: true,
  });
  assert.equal((await state.deliver(postponed)).reason, "already-sent");
  assert.equal(sends, 1);
});

test("safe failures persist retry time and attempt fencing while preserving the album payload", async () => {
  const state = fixture();
  state.dependencies.send = async () => ({
    ok: false,
    classification: "retryable",
    code: "rate-limited",
    description: "retry later",
    httpStatus: 429,
    retryAfterSeconds: 12,
  });
  const first = await state.deliver();
  assert.deepEqual(first, {
    status: "retryable",
    reason: "rate-limited",
    retryAtMs: RUN_AT_MS + 12_000,
  });
  const previous = structuredClone(state.values.get(REQUEST_ID)!);
  assert.equal(previous.status, "retryable");
  assert.equal(state.retryNotBefore(), RUN_AT_MS + 12_000);
  assert.equal(state.locks.size, 0);
  assert.equal((await state.deliver()).reason, "retry-not-due");
  state.setNow(RUN_AT_MS + 12_000);
  state.dependencies.send = async () => SUCCESS;
  assert.equal((await state.deliver()).status, "sent");
  const receipt = state.values.get(REQUEST_ID)!;
  assert.deepEqual(receipt.payload, previous.payload);
  assert.equal(receipt.attemptCount, 2);
  assert.notEqual(receipt.attemptId, previous.attemptId);
});

test("a retry barrier raised during reservation defers the album without leaving it sending", async () => {
  for (const delayMs of [12_000, 120_000]) {
    const state = fixture();
    const reserve = state.dependencies.repository!.reserve;
    state.dependencies.repository!.reserve = async (input) => {
      const result = await reserve(input);
      await state.dependencies.retryControl!.extendRetryNotBeforeMs(
        RUN_AT_MS + delayMs,
      );
      return result;
    };
    assert.deepEqual(
      await state.deliver(),
      delayMs < 60_000
        ? {
            status: "retryable",
            reason: "retry-not-due",
            retryAtMs: RUN_AT_MS + delayMs,
          }
        : { status: "skipped", reason: "delivery-window-expired" },
    );
    assert.equal(state.sends.length, 0);
    assert.equal(state.locks.size, 0);
    assert.equal(state.values.get(REQUEST_ID)?.status, "retryable");
    assert.equal(state.values.get(REQUEST_ID)?.retryAtMs, RUN_AT_MS + delayMs);
    if (delayMs < 60_000) {
      state.setNow(RUN_AT_MS + delayMs);
      assert.deepEqual(await state.deliver(), { status: "sent" });
      assert.equal(state.sends.length, 1);
      assert.equal(state.values.get(REQUEST_ID)?.status, "sent");
      assert.equal(state.values.get(REQUEST_ID)?.attemptCount, 2);
    }
  }
});

test("an unreadable final retry barrier leaves the reserved attempt safely retryable", async () => {
  const state = fixture();
  let reads = 0;
  state.dependencies.retryControl!.getRetryNotBeforeMs = async () => {
    if (++reads === 2) throw new Error("barrier-unavailable");
    return 0;
  };
  assert.deepEqual(await state.deliver(), {
    status: "retryable",
    reason: "delivery-preparation-failed",
    retryAtMs: RUN_AT_MS + 1_000,
  });
  assert.equal(state.sends.length, 0);
  assert.equal(state.values.get(REQUEST_ID)?.status, "retryable");
  assert.equal(state.locks.size, 0);
});

test("uncertain, thrown and incomplete sends are permanent automatic duplicate barriers", async () => {
  for (const result of [
    {
      ok: false,
      classification: "uncertain",
      code: "timeout",
      description: "timeout",
      httpStatus: null,
      retryAfterSeconds: null,
    },
    { ...SUCCESS, messageIds: [1] },
    { ...SUCCESS, messageIds: [1, 2, 0] },
    null,
  ] satisfies Array<TelegramResult | null>) {
    const state = fixture();
    let sends = 0;
    state.dependencies.send = async () => {
      sends++;
      if (result === null) throw new Error("send-failed");
      return result;
    };
    assert.equal((await state.deliver()).status, "uncertain");
    assert.equal((await state.deliver()).reason, "previous-send-unresolved");
    assert.equal(sends, 1);
    assert.equal(state.locks.size, 0);
  }
});

test("successful send with lost persistence stays sending and cannot be retried", async () => {
  const state = fixture();
  state.dependencies.repository!.storeOutcome = async () => {
    throw new Error("d1-unavailable");
  };
  assert.equal((await state.deliver()).status, "uncertain");
  assert.equal(state.values.get(REQUEST_ID)?.status, "sending");
  assert.equal((await state.deliver()).reason, "previous-send-unresolved");
  assert.equal(state.sends.length, 1);
});

test("definitive rejection is terminal and is not retried", async () => {
  const state = fixture();
  let sends = 0;
  state.dependencies.send = async () => {
    sends++;
    return {
      ok: false,
      classification: "terminal",
      code: "telegram-400",
      description: "bad media",
      httpStatus: 400,
      retryAfterSeconds: null,
    };
  };
  assert.deepEqual(await state.deliver(), {
    status: "terminal",
    reason: "telegram-400",
  });
  assert.equal((await state.deliver()).status, "terminal");
  assert.equal(sends, 1);
});

test("frozen or unreadable controls and missing configuration fail closed", async () => {
  for (const readControls of [
    async () => false,
    async (): Promise<boolean> => {
      throw new Error("control-unavailable");
    },
  ]) {
    const state = fixture();
    state.dependencies.controlsEnabled = readControls;
    assert.equal((await state.deliver()).status, "retryable");
    assert.equal(state.sends.length, 0);
    assert.equal(state.values.size, 0);
  }
  const state = fixture();
  assert.equal(
    (
      await deliverEventPrizeAnnouncement(
        { ...env, TELEGRAM_BOT_TOKEN: "" },
        INPUT,
        state.dependencies,
      )
    ).reason,
    "configuration-unavailable",
  );
  assert.equal(state.sends.length, 0);
});

test("a control change after reservation remains safely retryable without sending", async () => {
  const state = fixture();
  let calls = 0;
  state.dependencies.controlsEnabled = async () => ++calls < 3;
  assert.equal((await state.deliver()).status, "retryable");
  assert.equal(state.values.get(REQUEST_ID)?.status, "retryable");
  assert.equal(state.sends.length, 0);
  assert.equal(state.locks.size, 0);
});

test("checks the grace deadline after reservation and caps the Telegram timeout", async () => {
  for (const remainingMs of [3, 0]) {
    const state = fixture();
    state.setNow(RUN_AT_MS + 50_000);
    const reserve = state.dependencies.repository!.reserve;
    state.dependencies.repository!.reserve = async (input) => {
      const result = await reserve(input);
      state.setNow(RUN_AT_MS + 60_000 - remainingMs);
      return result;
    };
    const result = await state.deliver();
    assert.equal(result.status, remainingMs ? "sent" : "skipped");
    assert.equal(state.sends.length, remainingMs ? 1 : 0);
    if (remainingMs) assert.equal(state.sends[0].timeoutMs, remainingMs);
  }
});

test("an expired safe retry can use a new on-time postponed schedule without resetting sent identity", async () => {
  const state = fixture();
  state.dependencies.send = async () => ({
    ok: false,
    classification: "retryable",
    code: "rate-limited",
    description: "retry later",
    httpStatus: 429,
    retryAfterSeconds: 120,
  });
  assert.equal((await state.deliver()).status, "skipped");
  assert.equal(state.values.get(REQUEST_ID)?.status, "retryable");
  const postponed = {
    ...INPUT,
    startAtMs: INPUT.startAtMs + 3_600_000,
    runAtMs: RUN_AT_MS + 3_600_000,
  };
  state.setNow(postponed.runAtMs);
  state.setEvent({
    status: "scheduled",
    isSundayMons: true,
    startAtMs: postponed.startAtMs,
  });
  state.dependencies.send = async () => SUCCESS;
  assert.equal((await state.deliver(postponed)).status, "sent");
  assert.equal(state.values.size, 1);
});

function reminderInput(
  eventId = EVENT_ID,
  leadMs = 14_400_000,
): EventPrizeAnnouncementDeliveryInput {
  return {
    ...INPUT,
    eventId,
    kind: "reminder",
    runAtMs: INPUT.startAtMs - leadMs,
    firstQueuedAtMs: INPUT.startAtMs - leadMs - 60_000,
  };
}

test("reminds a Sunday event without prizes using one Telegram text message", async () => {
  const input = reminderInput("sunday-without-prizes");
  const state = fixture(input);
  const reminder = buildSundayMonsReminder({ eventId: input.eventId });
  assert.deepEqual(await state.deliver(), { status: "sent" });
  assert.deepEqual(state.reminderSends, [
    {
      chatId: "community-chat",
      text: reminder.text,
      parseMode: "HTML",
      silent: false,
      token: "token",
      timeoutMs: 10_000,
    },
  ]);
  assert.equal(state.sends.length, 0);
  const receipt = state.values.get(`event:${input.eventId}:reminder:v1`)!;
  assert.equal(receipt.kind, "reminder");
  assert.deepEqual(receipt.messageIds, [104]);
  assert.equal(Object.hasOwn(receipt.payload!, "imageUrls"), false);
  assert.equal((await state.deliver()).reason, "already-sent");
  assert.equal(state.reminderSends.length, 1);
});

test("legacy three-hour delivery retains its timing, text, and single reminder receipt", async () => {
  const input = reminderInput("sunday-without-prizes", 10_800_000);
  const state = fixture(input);
  state.setNow(input.runAtMs - 1);
  assert.deepEqual(await state.deliver(), {
    status: "retryable",
    reason: "not-due",
    retryAtMs: input.runAtMs,
  });
  assert.equal(state.reminderSends.length, 0);
  state.setNow(input.runAtMs);
  assert.deepEqual(await state.deliver(), { status: "sent" });
  assert.match(String(state.reminderSends[0].text), /^sunday mons in 3 hours!/);
  assert.match(
    String(state.reminderSends[0].text),
    /https:\/\/mons\.link\/event\/sunday-without-prizes/,
  );
  const receiptId = `event:${input.eventId}:reminder:v1`;
  assert.deepEqual([...state.values.keys()], [receiptId]);
  const receipt = state.values.get(receiptId)!;
  assert.equal(receipt.startAtMs, input.startAtMs);
  assert.equal(receipt.runAtMs, input.runAtMs);
  assert.equal(receipt.firstQueuedAtMs, input.firstQueuedAtMs);
  assert.equal(receipt.payload?.text, state.reminderSends[0].text);
  assert.equal((await state.deliver()).reason, "already-sent");
  assert.equal(state.reminderSends.length, 1);
  assert.equal(state.sends.length, 0);
});

test("reminder delivery rejects unsupported lead times without reserving or sending", async () => {
  for (const leadMs of [
    3_600_000, 10_799_999, 10_800_001, 14_399_999, 14_400_001, 18_000_000,
  ]) {
    const state = fixture(reminderInput(EVENT_ID, leadMs));
    assert.deepEqual(await state.deliver(), {
      status: "skipped",
      reason: "invalid-schedule",
    });
    assert.equal(state.reminderSends.length, 0);
    assert.equal(state.values.size, 0);
    assert.equal(state.locks.size, 0);
  }
});

test("reminder delivery renders the participants from its locked canonical event snapshot", async () => {
  const input = reminderInput();
  const state = fixture(input);
  const eventData = {
    status: "scheduled",
    startAtMs: input.startAtMs,
    isSundayMons: true,
    participants: {
      ivan: {
        profileId: "ivan",
        displayName: "ivan",
        emojiId: 47,
        joinedAtMs: 1,
      },
      second: {
        profileId: "second",
        displayName: "Second <player>",
        emojiId: 138,
        joinedAtMs: 2,
      },
    },
  };
  state.setEvent(eventData);
  assert.deepEqual(await state.deliver(), { status: "sent" });
  const expected = buildSundayMonsReminder({
    eventId: input.eventId,
    eventData,
  });
  assert.equal(state.reminderSends[0].text, expected.text);
  assert.match(String(state.reminderSends[0].text), /ivan/);
  assert.match(String(state.reminderSends[0].text), /Second &lt;player&gt;/);
  const receipt = state.values.get(`event:${input.eventId}:reminder:v1`)!;
  assert.equal(receipt.payload?.text, expected.text);
});

test("reminder timing and strict Sunday eligibility are separate from prize eligibility", async () => {
  for (const event of [
    { status: "scheduled", isSundayMons: false, startAtMs: INPUT.startAtMs },
    { status: "scheduled", isSundayMons: "true", startAtMs: INPUT.startAtMs },
    { status: "active", isSundayMons: true, startAtMs: INPUT.startAtMs },
  ]) {
    const state = fixture(reminderInput("sunday-without-prizes"));
    state.setEvent(event);
    assert.equal((await state.deliver()).reason, "event-no-longer-eligible");
    assert.equal(state.reminderSends.length, 0);
  }
  const state = fixture(reminderInput());
  assert.equal(
    (await state.deliver({ ...INPUT, kind: "reminder" })).reason,
    "invalid-schedule",
  );
  const late = {
    ...reminderInput(),
    firstQueuedAtMs: reminderInput().runAtMs + 1,
  };
  assert.equal((await state.deliver(late)).reason, "discovered-too-late");
});

test("sent or uncertain reminders do not consume the same event's prize announcement", async () => {
  for (const uncertain of [false, true]) {
    const state = fixture(reminderInput());
    let reminders = 0;
    state.dependencies.sendMessage = async () => {
      reminders++;
      return uncertain
        ? {
            ok: false,
            classification: "uncertain",
            code: "timeout",
            description: "timeout",
            httpStatus: null,
            retryAfterSeconds: null,
          }
        : { ok: true, outcome: "sent", messageId: 104, httpStatus: 200 };
    };
    assert.equal(
      (await state.deliver()).status,
      uncertain ? "uncertain" : "sent",
    );
    assert.equal(
      (await state.deliver()).reason,
      uncertain ? "previous-send-unresolved" : "already-sent",
    );
    state.setNow(INPUT.runAtMs);
    assert.deepEqual(await state.deliver(INPUT), { status: "sent" });
    assert.equal(reminders, 1);
    assert.equal(state.sends.length, 1);
    assert.equal(state.values.size, 2);
    assert.equal(
      state.values.get(`event:${EVENT_ID}:reminder:v1`)?.status,
      uncertain ? "uncertain" : "sent",
    );
    assert.equal(state.values.get(REQUEST_ID)?.status, "sent");
  }
});

test("safe text retries keep their own payload and require the returned single message ID", async () => {
  const input = reminderInput();
  const state = fixture(input);
  let attempts = 0;
  state.dependencies.sendMessage = async () => {
    attempts++;
    return attempts === 1
      ? {
          ok: false,
          classification: "retryable",
          code: "network-error",
          description: "connect failed",
          httpStatus: null,
          retryAfterSeconds: null,
        }
      : { ok: true, outcome: "sent", messageId: 104, httpStatus: 200 };
  };
  const first = await state.deliver();
  assert.equal(first.status, "retryable");
  const key = `event:${EVENT_ID}:reminder:v1`;
  const payload = structuredClone(state.values.get(key)?.payload);
  state.setNow(first.retryAtMs!);
  assert.equal((await state.deliver()).status, "sent");
  assert.deepEqual(state.values.get(key)?.payload, payload);
  assert.equal(state.values.get(key)?.attemptCount, 2);
  assert.equal(state.sends.length, 0);
  const missingId = fixture(input);
  missingId.dependencies.sendMessage = async () => SUCCESS;
  assert.equal((await missingId.deliver()).status, "uncertain");
  assert.equal((await missingId.deliver()).reason, "previous-send-unresolved");
});

test("old prize payloads retain their exact digest and do not require a kind field", async () => {
  const state = fixture();
  const announcement = buildEventPrizeAnnouncement({ eventId: EVENT_ID });
  const payload = {
    chatId: "community-chat",
    imageUrls: announcement.imageUrls,
    text: announcement.text,
    parseMode: "HTML",
    hasSpoiler: true,
    silent: false,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const payloadDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  state.values.set(REQUEST_ID, {
    eventId: EVENT_ID,
    startAtMs: INPUT.startAtMs,
    runAtMs: INPUT.runAtMs,
    firstQueuedAtMs: INPUT.firstQueuedAtMs,
    status: "retryable",
    createdAtMs: RUN_AT_MS - 1_000,
    updatedAtMs: RUN_AT_MS - 1_000,
    retryAtMs: RUN_AT_MS,
    attemptId: "old-attempt",
    attemptCount: 1,
    payload,
    payloadDigest,
    messageIds: null,
  });
  assert.deepEqual(await state.deliver(), { status: "sent" });
  assert.equal(state.values.get(REQUEST_ID)?.payloadDigest, payloadDigest);
  assert.deepEqual(
    Object.keys(state.values.get(REQUEST_ID)!.payload!),
    Object.keys(payload),
  );
});
