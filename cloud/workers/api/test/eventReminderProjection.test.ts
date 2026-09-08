import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramRepository } from "../../../functions/telegram/repositoryCore.js";
import { buildSundayMonsReminder } from "../../../functions/telegram/sundayMonsReminder.js";
import {
  adoptSundayMonsReminderMessage,
  refreshSundayMonsReminder,
  type SundayMonsReminderRefreshDependencies,
} from "../src/eventReminderProjection.ts";
import type { TelegramAnnouncementRecord } from "../src/telegramD1.ts";
import type { EventTelegramProjectionTask } from "../src/telegramProjectionTasks.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const EVENT_ID = "z3oj52Iiime";
const MESSAGE_KEY = `event:${EVENT_ID}:reminder`;
const NOW_MS = 20_000_000;
const env = {
  ...TELEGRAM_TEST_ENV,
  TELEGRAM_EXTRA_CHAT_ID: " community-chat\n",
} as Env;
const event = {
  status: "scheduled",
  startAtMs: NOW_MS + 1_000,
  isSundayMons: true,
  telegramDeliveryVersion: 2,
  telegramAnnouncements: { invite: false, matches: false, results: false },
};

function sentReceipt(
  leadMs: 10800000 | 14400000 = 14_400_000,
): TelegramAnnouncementRecord {
  return {
    eventId: EVENT_ID,
    kind: "reminder",
    status: "sent",
    createdAtMs: NOW_MS - 5_000,
    updatedAtMs: NOW_MS - 4_000,
    payloadDigest: "original-digest",
    messageIds: [23001],
    payload: {
      chatId: "community-chat",
      text: buildSundayMonsReminder({ eventId: EVENT_ID, leadMs }).text,
      parseMode: "HTML",
      silent: false,
    },
  };
}

function telegramStore(initial: unknown = null) {
  let message = initial;
  let transactions = 0;
  const telegram = createTelegramRepository({
    getPath: async () => message,
    transactPath: async (path, updater) => {
      assert.equal(path, `telegramMessages/${MESSAGE_KEY}`);
      transactions++;
      const result = updater(message) as {
        commit?: false;
        decision?: string;
        value?: unknown;
      };
      if (result.commit === false) {
        return { committed: false, decision: result.decision, value: message };
      }
      message = result.value;
      return { committed: true, decision: result.decision, value: message };
    },
  });
  return { telegram, read: () => message, transactions: () => transactions };
}

function fixture() {
  let eventData: unknown = event;
  let receipt: TelegramAnnouncementRecord | null = sentReceipt();
  const writes: Record<string, unknown>[] = [];
  const queued: EventTelegramProjectionTask[] = [];
  const logs: string[] = [];
  const dependencies: SundayMonsReminderRefreshDependencies = {
    controlsEnabled: async () => true,
    now: () => NOW_MS,
    createRequestId: () => "refresh-request",
    eventRepository: {
      getRtdbPath: async (path) => {
        assert.equal(path, `events/${EVENT_ID}`);
        return eventData;
      },
      patchRtdbRoot: async (updates) => void writes.push(updates),
    },
    announcementRepository: {
      get: async (requestId) => {
        assert.equal(requestId, `event:${EVENT_ID}:reminder:v1`);
        return receipt;
      },
    },
    enqueue: async (task) => {
      assert.equal(writes.length, 1);
      queued.push(task);
    },
    logger: { error: (value: string) => void logs.push(value) },
  };
  return {
    dependencies,
    writes,
    queued,
    logs,
    setEvent: (value: unknown) => void (eventData = value),
    setReceipt: (value: TelegramAnnouncementRecord | null) =>
      void (receipt = value),
    refresh: () => refreshSundayMonsReminder(env, EVENT_ID, dependencies),
  };
}

test("adopts the original sent reminder as a complete edit-only delivery without changing its receipt", async () => {
  const receipt = sentReceipt();
  const original = structuredClone(receipt);
  const state = telegramStore();
  const message = (await adoptSundayMonsReminderMessage({
    eventId: EVENT_ID,
    receipt,
    telegram: state.telegram,
    chatId: env.TELEGRAM_EXTRA_CHAT_ID,
  })) as Record<string, Record<string, unknown>>;
  assert.equal(message.desired.operation, "edit");
  assert.equal(message.desired.ifMissing, "skip");
  assert.equal(message.desired.destination, "community");
  assert.equal(message.desired.instanceKey, `${MESSAGE_KEY}:v2`);
  assert.equal(message.desired.text, receipt.payload!.text);
  assert.equal(message.desired.parseMode, "HTML");
  assert.equal(message.desired.silent, false);
  assert.equal(message.desired.disableWebPagePreview, true);
  assert.equal(typeof message.desired.contentHash, "string");
  assert.equal(typeof message.desired.revision, "string");
  assert.deepEqual(message.applied, {
    destination: "community",
    chatId: "community-chat",
    messageId: 23001,
    instanceKey: `${MESSAGE_KEY}:v2`,
    revision: message.desired.revision,
    contentHash: message.desired.contentHash,
    appliedAtMs: receipt.updatedAtMs,
  });
  assert.deepEqual(message.delivery, {
    status: "delivered",
    revision: message.desired.revision,
    deliveredAtMs: receipt.updatedAtMs,
  });
  assert.deepEqual(receipt, original);
});

test("adoption preserves every existing record, including missing or abandoned delivery state", async () => {
  for (const existing of [
    {},
    { applied: { messageId: 999 }, desired: { text: "newer" } },
    {
      delivery: {
        status: "terminal",
        lastError: { code: "manually-abandoned" },
      },
    },
    { applied: null, delivery: { status: "delivered" } },
  ]) {
    const state = telegramStore(existing);
    const result = await adoptSundayMonsReminderMessage({
      eventId: EVENT_ID,
      receipt: sentReceipt(),
      telegram: state.telegram,
      chatId: "community-chat",
    });
    assert.deepEqual(result, existing);
    assert.deepEqual(state.read(), existing);
  }
});

test("only a valid confirmed reminder for the exact event and destination can be adopted", async () => {
  const receipt = sentReceipt();
  for (const invalid of [
    null,
    ...["sending", "uncertain", "retryable", "terminal"].map((status) => ({
      ...receipt,
      status,
    })),
    { ...receipt, kind: "prizes" as const },
    { ...receipt, kind: undefined },
    { ...receipt, eventId: "another-event" },
    { ...receipt, messageIds: null },
    { ...receipt, messageIds: [] },
    { ...receipt, messageIds: [23001, 23002] },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((messageId) => ({
      ...receipt,
      messageIds: [messageId],
    })),
    { ...receipt, updatedAtMs: 0 },
    { ...receipt, payload: null },
    ...[
      { chatId: "another-chat" },
      { text: "unrelated message" },
      { text: buildSundayMonsReminder({ eventId: "another-event" }).text },
      { parseMode: null },
      { silent: true },
      { imageUrls: [] },
      { hasSpoiler: true },
    ].map((payload) => ({
      ...receipt,
      payload: { ...receipt.payload, ...payload },
    })),
  ]) {
    const state = telegramStore();
    assert.equal(
      await adoptSundayMonsReminderMessage({
        eventId: EVENT_ID,
        receipt: invalid,
        telegram: state.telegram,
        chatId: "community-chat",
      }),
      null,
    );
    assert.equal(state.transactions(), 0);
  }
});

test("adopts reminders already containing participants from their actual sent text", async () => {
  for (const leadMs of [10_800_000, 14_400_000] as const) {
    for (const suffix of ["", "\n\n1. ivan"]) {
      const receipt = sentReceipt(leadMs);
      receipt.payload!.text += suffix;
      const state = telegramStore();
      const result = (await adoptSundayMonsReminderMessage({
        eventId: EVENT_ID,
        receipt,
        telegram: state.telegram,
        chatId: "community-chat",
      })) as Record<string, Record<string, unknown>>;
      assert.equal(result.desired.text, receipt.payload!.text);
    }
  }
});

test("refresh accepts a confirmed legacy three-hour reminder receipt", async () => {
  const state = fixture();
  state.setReceipt(sentReceipt(10_800_000));
  assert.equal((await state.refresh()).status, "queued");
  assert.equal(state.writes.length, 1);
  assert.equal(state.queued.length, 1);
});

test("refresh persists one atomic generation and outbox update before dispatch, even after the send grace", async () => {
  const state = fixture();
  assert.deepEqual(await state.refresh(), {
    status: "queued",
    requestId: "refresh-request",
    messageKey: MESSAGE_KEY,
  });
  assert.deepEqual(state.writes, [
    {
      [`telegramProjectionOutbox/event/${EVENT_ID}`]: {
        schemaVersion: 1,
        status: "pending",
        requestId: "refresh-request",
        firstQueuedAtMs: NOW_MS,
        updatedAtMs: NOW_MS,
      },
      [`eventTelegramProjectionGenerations/${EVENT_ID}`]: {
        ".sv": { increment: 1 },
      },
    },
  ]);
  assert.deepEqual(state.queued, [
    {
      kind: "event-telegram-projection",
      eventId: EVENT_ID,
      requestId: "refresh-request",
    },
  ]);
});

test("refresh ignores events outside strict scheduled Sunday v2 eligibility and unsent reminders", async () => {
  for (const candidate of [
    null,
    ...["active", "ended", "dismissed"].map((status) => ({ ...event, status })),
    { ...event, isSundayMons: "true" },
    { ...event, isSundayMons: false },
    { ...event, telegramDeliveryVersion: 1 },
    { ...event, startAtMs: 0 },
  ]) {
    const state = fixture();
    state.setEvent(candidate);
    assert.deepEqual(await state.refresh(), {
      status: "skipped",
      reason: "reminder-not-eligible",
    });
    assert.equal(state.writes.length, 0);
  }
  const state = fixture();
  state.setReceipt(null);
  assert.deepEqual(await state.refresh(), {
    status: "skipped",
    reason: "reminder-not-confirmed",
  });
  assert.equal(state.writes.length, 0);
  assert.equal(state.queued.length, 0);
});

test("disabled controls and failed marker persistence retry without dispatching", async () => {
  const state = fixture();
  state.dependencies.controlsEnabled = async () => false;
  await assert.rejects(state.refresh(), /writes-disabled/);
  assert.equal(state.writes.length, 0);
  state.dependencies.controlsEnabled = async () => true;
  state.dependencies.eventRepository!.patchRtdbRoot = async () => {
    throw new Error("persist-failed");
  };
  await assert.rejects(state.refresh(), /persist-failed/);
  assert.equal(state.queued.length, 0);
});

test("a failed queue dispatch retains the pending marker for scheduled recovery", async () => {
  const state = fixture();
  state.dependencies.enqueue = async () => {
    throw new Error("queue-unavailable");
  };
  assert.deepEqual(await state.refresh(), {
    status: "queued",
    reason: "dispatch-deferred",
    requestId: "refresh-request",
    messageKey: MESSAGE_KEY,
  });
  assert.equal(state.writes.length, 1);
  assert.equal(state.logs.length, 1);
});
