import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramBridgeSignature,
  handleTelegramBridge,
} from "../src/telegramBridge.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const NOW_MS = Date.UTC(2026, 7, 18, 12);
const SECRET = TELEGRAM_TEST_ENV.TELEGRAM_QUEUE_BRIDGE_SECRET;
const payload = {
  messageKey: "automatch:invite-1",
  revision: "revision-1",
  taskKind: "desired",
  retrySequence: 0,
  generation: "event-1",
};

function queueEnv(send: Queue["send"]): Env {
  return {
    ...TELEGRAM_TEST_ENV,
    AUTH_DISABLE_X_VERIFY: "false",
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
    FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
    HELIUS_RPC_API_KEY: "test-helius-key",
    NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    TELEGRAM_DELIVERY_QUEUE: {
      ...TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE,
      send,
    },
    X_CLIENT_ID: "test-x-client",
    X_CLIENT_SECRET: "test-x-secret",
  };
}

async function signedRequest(
  body: string,
  timestamp = String(Math.floor(NOW_MS / 1_000)),
  signatureBody = body,
): Promise<Request> {
  const signature = await createTelegramBridgeSignature(
    signatureBody,
    SECRET,
    timestamp,
  );
  return new Request("https://api.mons.link/internal/telegram/delivery", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mons-Telegram-Signature": signature,
      "X-Mons-Telegram-Timestamp": timestamp,
    },
    body,
  });
}

test("accepts a valid signed initial task and awaits the queue binding", async () => {
  const sent: unknown[] = [];
  const env = queueEnv(async (message) => {
    sent.push(message);
    return {
      metadata: { metrics: { backlogCount: 1, backlogBytes: 128 } },
    };
  });
  const response = await handleTelegramBridge(
    await signedRequest(JSON.stringify(payload)),
    env,
    { now: () => NOW_MS },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(sent, [payload]);
});

test("rejects missing, stale, and tampered signatures", async () => {
  const env = queueEnv(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send);
  const body = JSON.stringify(payload);
  const unsigned = await handleTelegramBridge(
    new Request("https://api.mons.link/internal/telegram/delivery", {
      method: "POST",
      body,
    }),
    env,
    { now: () => NOW_MS },
  );
  const staleTimestamp = String(Math.floor(NOW_MS / 1_000) - 301);
  const stale = await handleTelegramBridge(
    await signedRequest(body, staleTimestamp),
    env,
    { now: () => NOW_MS },
  );
  const tampered = await handleTelegramBridge(
    await signedRequest(body, undefined, `${body} `),
    env,
    { now: () => NOW_MS },
  );
  assert.equal(unsigned.status, 401);
  assert.equal(stale.status, 401);
  assert.equal(tampered.status, 401);
});

test("strictly validates initial task payloads after authentication", async () => {
  const env = queueEnv(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send);
  for (const candidate of [
    { ...payload, extra: true },
    { ...payload, retrySequence: 1 },
    { ...payload, taskKind: "pending-delete" },
    { ...payload, taskKind: "manual-recovery", revision: "wrong" },
  ]) {
    const response = await handleTelegramBridge(
      await signedRequest(JSON.stringify(candidate)),
      env,
      { now: () => NOW_MS },
    );
    assert.equal(response.status, 400);
  }
});

test("rejects oversized bodies and reports queue unavailability", async () => {
  const oversized = JSON.stringify({
    ...payload,
    generation: "x".repeat(9000),
  });
  const env = queueEnv(async () => {
    throw new Error("queue unavailable");
  });
  const oversizedResponse = await handleTelegramBridge(
    await signedRequest(oversized),
    env,
    { now: () => NOW_MS },
  );
  const unavailableResponse = await handleTelegramBridge(
    await signedRequest(JSON.stringify(payload)),
    env,
    { now: () => NOW_MS },
  );
  assert.equal(oversizedResponse.status, 400);
  assert.equal(unavailableResponse.status, 503);
});

test("rejects unsupported methods without reading a body", async () => {
  const response = await handleTelegramBridge(
    new Request("https://api.mons.link/internal/telegram/delivery"),
    queueEnv(TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE.send),
  );
  assert.equal(response.status, 405);
});
