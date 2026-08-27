import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramRepository } from "../../../functions/telegram/repositoryCore.js";
import {
  handleTelegramCommand,
  MAX_TELEGRAM_COMMAND_BODY_BYTES,
} from "../src/telegramCommand.ts";
import { createTelegramBridgeSignature } from "../src/telegramBridgeAuth.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const NOW_MS = Date.UTC(2026, 7, 27, 12);
const SECRET = TELEGRAM_TEST_ENV.TELEGRAM_QUEUE_BRIDGE_SECRET;

function repositoryState(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const repository = createTelegramRepository({
    async getPath(path) {
      return values.get(path) ?? null;
    },
    async transactPath(path, updater) {
      const current = values.get(path) ?? null;
      const output = updater(current) as
        | { commit: false; decision?: string }
        | { value: unknown; decision?: string };
      if ("commit" in output && output.commit === false) {
        return {
          committed: false,
          decision: output.decision,
          value: current,
        };
      }
      if (!("value" in output)) throw new Error("invalid transaction");
      values.set(path, output.value);
      return {
        committed: true,
        decision: output.decision,
        value: output.value,
      };
    },
  });
  return { repository, values };
}

function commandEnv(sent: unknown[]): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    TELEGRAM_DELIVERY_QUEUE: {
      ...TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE,
      async send(value) {
        sent.push(value);
        return {
          metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } },
        };
      },
    },
  } as Env;
}

async function signedRequest(command: unknown, bodyOverride?: string) {
  const body = bodyOverride ?? JSON.stringify(command);
  const timestamp = String(Math.floor(NOW_MS / 1_000));
  const signature = await createTelegramBridgeSignature(
    body,
    SECRET,
    timestamp,
  );
  return new Request("https://api.mons.link/internal/telegram/command", {
    method: "POST",
    headers: {
      "X-Mons-Telegram-Signature": signature,
      "X-Mons-Telegram-Timestamp": timestamp,
    },
    body,
  });
}

test("persists admin desired state before enqueueing", async () => {
  const state = repositoryState();
  const sent: unknown[] = [];
  const response = await handleTelegramCommand(
    await signedRequest({
      kind: "send",
      messageKey: "admin:test:1",
      generation: "generation-1",
      destination: "community",
      instanceKey: "instance-1",
      text: "hello",
      parseMode: "HTML",
      silent: false,
      sourceRevision: "source-1",
    }),
    commandEnv(sent),
    {
      now: () => NOW_MS,
      readStorageMode: async () => "d1",
      repository: state.repository,
    },
  );
  assert.equal(response.status, 202);
  assert.equal(sent.length, 1);
  const message = state.values.get("telegramMessages/admin:test:1") as {
    desired?: { revision?: string };
  };
  assert.ok(message.desired?.revision);
});

test("rejects non-admin and malformed sends before persistence", async () => {
  const state = repositoryState();
  const sent: unknown[] = [];
  const base = {
    kind: "send",
    messageKey: "admin:test:1",
    generation: "generation-1",
    destination: "community",
    instanceKey: "instance-1",
    text: "hello",
    sourceRevision: "source-1",
  };
  for (const candidate of [
    { ...base, messageKey: "event:live:upcoming" },
    { ...base, generation: "" },
    { ...base, silent: "false" },
    { ...base, parseMode: 1 },
  ]) {
    const response = await handleTelegramCommand(
      await signedRequest(candidate),
      commandEnv(sent),
      {
        now: () => NOW_MS,
        readStorageMode: async () => "d1",
        repository: state.repository,
      },
    );
    assert.equal(response.status, 400);
  }
  assert.equal(state.values.size, 0);
  assert.equal(sent.length, 0);
});

test("persists exact recovery requests and exposes metadata-only status", async () => {
  const messageKey = "message-1";
  const state = repositoryState({
    [`telegramMessages/${messageKey}`]: {
      desired: { revision: "revision-1" },
      delivery: {
        status: "uncertain",
        sendInFlight: { attemptId: "attempt-1" },
      },
    },
  });
  const sent: unknown[] = [];
  const env = commandEnv(sent);
  const dependencies = {
    now: () => NOW_MS,
    readStorageMode: async () => "d1" as const,
    repository: state.repository,
  };
  const requestId = "18ea8b32-ca88-4492-8ecb-42f87670a901";
  const preview = await handleTelegramCommand(
    await signedRequest({
      kind: "recovery-preview",
      messageKey,
      action: "confirm-send-absent",
    }),
    env,
    dependencies,
  );
  assert.equal(preview.status, 200);
  const requested = await handleTelegramCommand(
    await signedRequest({
      kind: "recovery-request",
      messageKey,
      requestId,
      action: "confirm-send-absent",
    }),
    env,
    dependencies,
  );
  assert.equal(requested.status, 202);
  assert.equal(sent.length, 1);
  await state.repository.transactMessage(messageKey, (current) => ({
    value: {
      ...(current as Record<string, unknown>),
      manualRecoveryResult: {
        requestId,
        action: "confirm-send-absent",
        status: "accepted",
      },
    },
  }));
  const status = await handleTelegramCommand(
    await signedRequest({ kind: "recovery-status", messageKey, requestId }),
    env,
    dependencies,
  );
  const payload = (await status.json()) as Record<string, unknown>;
  assert.equal(payload.status, "accepted");
  assert.equal("desired" in payload, false);
  assert.equal("sendInFlight" in payload, false);
});

test("freezes commands and rejects invalid or oversized requests", async () => {
  const sent: unknown[] = [];
  const state = repositoryState();
  const frozen = await handleTelegramCommand(
    await signedRequest({
      kind: "smoke",
      requestId: "18ea8b32-ca88-4492-8ecb-42f87670a901",
    }),
    commandEnv(sent),
    {
      now: () => NOW_MS,
      readStorageMode: async () => "frozen",
      repository: state.repository,
    },
  );
  assert.equal(frozen.status, 503);
  const invalid = await handleTelegramCommand(
    new Request("https://api.mons.link/internal/telegram/command", {
      method: "POST",
      body: JSON.stringify({ kind: "smoke", requestId: "bad" }),
    }),
    commandEnv(sent),
  );
  assert.equal(invalid.status, 401);
  const oversizedBody = "x".repeat(MAX_TELEGRAM_COMMAND_BODY_BYTES + 1);
  const oversized = await handleTelegramCommand(
    await signedRequest({}, oversizedBody),
    commandEnv(sent),
    { now: () => NOW_MS },
  );
  assert.equal(oversized.status, 400);
});

test("delete-only smoke persists and queues without accepting arbitrary targets", async () => {
  const state = repositoryState();
  const sent: unknown[] = [];
  const requestId = "18ea8b32-ca88-4492-8ecb-42f87670a901";
  const response = await handleTelegramCommand(
    await signedRequest({ kind: "smoke", requestId }),
    commandEnv(sent),
    {
      now: () => NOW_MS,
      readStorageMode: async () => "d1",
      repository: state.repository,
    },
  );
  assert.equal(response.status, 202);
  const message = state.values.get(
    `telegramMessages/migration-smoke:${requestId}`,
  ) as { desired?: { operation?: string } };
  assert.equal(message.desired?.operation, "delete");
  assert.equal(sent.length, 1);
});
