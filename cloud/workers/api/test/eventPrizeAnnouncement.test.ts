import assert from "node:assert/strict";
import test from "node:test";
import { buildEventPrizeAnnouncement } from "../../../functions/telegram/eventPrizeAnnouncement.js";
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

function fixture() {
  let nowMs = RUN_AT_MS;
  let retryNotBeforeMs = 0;
  let eventData: unknown = {
    status: "scheduled",
    startAtMs: INPUT.startAtMs,
    isSundayMons: true,
    telegramAnnouncements: { invite: false, matches: false, results: false },
  };
  const locks = new Map<string, unknown>();
  const { values, repository } = memoryAnnouncementRepository();
  const sends: Record<string, unknown>[] = [];
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
    log: (record) => logs.push(record),
  };
  return {
    dependencies,
    values,
    sends,
    locks,
    logs,
    setNow: (value: number) => void (nowMs = value),
    setEvent: (value: unknown) => void (eventData = value),
    retryNotBefore: () => retryNotBeforeMs,
    deliver: (input = INPUT) =>
      deliverEventPrizeAnnouncement(env, input, dependencies),
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
