import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_PRIZE_ANNOUNCEMENT_PATH,
  handleEventPrizeAnnouncement,
} from "../src/eventPrizeAnnouncement.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";
import { handleFetch } from "../src/workerHandler.ts";
import { createTelegramBridgeSignature } from "../src/telegramBridgeAuth.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const NOW_MS = Date.UTC(2026, 7, 20, 12);
const EVENT_ID = "FRkdorMWaYW";
const ANNOUNCEMENT = "Win compressed NFTs";
const EVENT_URL = `https://mons.link/event/${EVENT_ID}`;
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECRET = TELEGRAM_TEST_ENV.TELEGRAM_ANNOUNCEMENT_BRIDGE_SECRET;
const DATA = {
  requestId: REQUEST_ID,
  eventId: EVENT_ID,
  announcement: ANNOUNCEMENT,
};
const env = {
  ...TELEGRAM_TEST_ENV,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

function memoryRtdbClient(): FirebaseRtdbClient {
  const values = new Map<string, unknown>();
  return {
    getPath: async (path) => values.get(path) ?? null,
    patchRoot: async () => {},
    transactPath: async (path, updater) => {
      const current = values.get(path) ?? null;
      const output = updater(current) as {
        commit?: boolean;
        decision?: string;
        value?: unknown;
      };
      if (output.commit === false) {
        return {
          committed: false,
          decision: output.decision,
          value: current,
        };
      }
      values.set(path, output.value);
      return {
        committed: true,
        decision: output.decision,
        value: output.value,
      };
    },
  };
}

async function signedRequest(
  payload: unknown,
  {
    timestamp = String(Math.floor(NOW_MS / 1_000)),
    signatureBody,
  }: { timestamp?: string; signatureBody?: string } = {},
): Promise<Request> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = await createTelegramBridgeSignature(
    signatureBody ?? body,
    SECRET,
    timestamp,
  );
  return new Request(`https://api.mons.link${EVENT_PRIZE_ANNOUNCEMENT_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mons-Telegram-Signature": signature,
      "X-Mons-Telegram-Timestamp": timestamp,
    },
    body,
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("sends the exact album with normalized configuration and stores the receipt", async () => {
  let sent: Record<string, unknown> | undefined;
  const successLogs: Record<string, unknown>[] = [];
  const response = await handleEventPrizeAnnouncement(
    await signedRequest(DATA),
    {
      ...env,
      TELEGRAM_BOT_TOKEN: " token\n",
      TELEGRAM_EXTRA_CHAT_ID: " community-chat\n",
    },
    {
      now: () => NOW_MS,
      rtdbClient: memoryRtdbClient(),
      send: async (input) => {
        sent = input;
        return {
          ok: true,
          outcome: "sent",
          messageIds: [101, 102, 103],
          httpStatus: 200,
        };
      },
      logSuccess: (record) => successLogs.push(record),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(sent, {
    chatId: "community-chat",
    imageUrls: [
      "https://cdn.lil.org/nft/card_nft/1866.webp",
      "https://cdn.lil.org/nft/card_nft/1682.webp",
      "https://cdn.lil.org/nft/card_nft/6793.webp",
    ],
    text: `${ANNOUNCEMENT}\n\n${EVENT_URL}`,
    silent: false,
    token: "token",
  });
  assert.deepEqual(await json(response), {
    ok: true,
    eventId: EVENT_ID,
    eventUrl: EVENT_URL,
    messageIds: [101, 102, 103],
  });
  assert.deepEqual(successLogs, [
    {
      event: "event_prize_announcement_sent",
      eventId: EVENT_ID,
      requestId: REQUEST_ID,
      messageCount: 3,
    },
  ]);
});

test("rejects missing, stale, and tampered announcement signatures", async () => {
  const body = JSON.stringify(DATA);
  const unsigned = await handleEventPrizeAnnouncement(
    new Request(`https://api.mons.link${EVENT_PRIZE_ANNOUNCEMENT_PATH}`, {
      method: "POST",
      body,
    }),
    env,
    { now: () => NOW_MS },
  );
  const stale = await handleEventPrizeAnnouncement(
    await signedRequest(body, {
      timestamp: String(Math.floor(NOW_MS / 1_000) - 301),
    }),
    env,
    { now: () => NOW_MS },
  );
  const tampered = await handleEventPrizeAnnouncement(
    await signedRequest(body, { signatureBody: `${body} ` }),
    env,
    { now: () => NOW_MS },
  );
  assert.deepEqual(
    [unsigned.status, stale.status, tampered.status],
    [401, 401, 401],
  );
});

test("strictly validates request IDs and announcement bodies", async () => {
  for (const payload of [
    { eventId: EVENT_ID, announcement: ANNOUNCEMENT },
    { ...DATA, requestId: "invalid" },
    { ...DATA, announcement: "line one\nline two" },
    { ...DATA, eventId: "unknown" },
    { ...DATA, extra: true },
    "{",
  ]) {
    const response = await handleEventPrizeAnnouncement(
      await signedRequest(payload),
      env,
      { now: () => NOW_MS },
    );
    assert.equal(response.status, 400);
  }
  const oversized = await handleEventPrizeAnnouncement(
    await signedRequest({ ...DATA, announcement: "x".repeat(9_000) }),
    env,
    { now: () => NOW_MS },
  );
  assert.equal(oversized.status, 400);
});

test("maps Telegram failures and rejects incomplete success receipts", async () => {
  const cases = [
    {
      result: {
        ok: false as const,
        classification: "uncertain" as const,
        code: "timeout",
        description: "request timed out",
        httpStatus: null,
        retryAfterSeconds: null,
      },
      status: 409,
    },
    {
      result: {
        ok: false as const,
        classification: "retryable" as const,
        code: "rate-limited",
        description: "retry later",
        httpStatus: 429,
        retryAfterSeconds: 12,
      },
      status: 503,
    },
    {
      result: {
        ok: false as const,
        classification: "terminal" as const,
        code: "telegram-400",
        description: "bad request",
        httpStatus: 400,
        retryAfterSeconds: null,
      },
      status: 502,
    },
    {
      result: {
        ok: true as const,
        outcome: "sent" as const,
        httpStatus: 200,
        messageIds: [1],
      },
      status: 409,
    },
  ];
  for (const candidate of cases) {
    const response = await handleEventPrizeAnnouncement(
      await signedRequest(DATA),
      env,
      {
        now: () => NOW_MS,
        rtdbClient: memoryRtdbClient(),
        send: async () => candidate.result,
        logError: () => {},
      },
    );
    assert.equal(response.status, candidate.status);
  }
});

test("replays a completed request without sending twice", async () => {
  const rtdbClient = memoryRtdbClient();
  let sends = 0;
  const dependencies = {
    now: () => NOW_MS,
    rtdbClient,
    send: async () => {
      sends += 1;
      return {
        ok: true as const,
        outcome: "sent" as const,
        messageIds: [101, 102, 103],
        httpStatus: 200,
      };
    },
    logSuccess: () => {},
  };
  const first = await handleEventPrizeAnnouncement(
    await signedRequest(DATA),
    env,
    dependencies,
  );
  const replay = await handleEventPrizeAnnouncement(
    await signedRequest(DATA),
    env,
    dependencies,
  );
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(sends, 1);
});

test("fails closed before sending when configuration or persistence is unavailable", async () => {
  let sends = 0;
  const missingConfig = await handleEventPrizeAnnouncement(
    await signedRequest(DATA),
    { ...env, TELEGRAM_BOT_TOKEN: "" },
    { now: () => NOW_MS, logError: () => {} },
  );
  const unavailableRepository = await handleEventPrizeAnnouncement(
    await signedRequest(DATA),
    env,
    {
      now: () => NOW_MS,
      rtdbClient: {
        ...memoryRtdbClient(),
        transactPath: async () => {
          throw new Error("unavailable");
        },
      },
      send: async () => {
        sends += 1;
        throw new Error("unexpected send");
      },
      logError: () => {},
    },
  );
  assert.equal(missingConfig.status, 503);
  assert.equal(unavailableRepository.status, 503);
  assert.equal(sends, 0);
});

test("treats thrown sends as uncertain and does not permit replay", async () => {
  const rtdbClient = memoryRtdbClient();
  let sends = 0;
  const first = await handleEventPrizeAnnouncement(
    await signedRequest(DATA),
    env,
    {
      now: () => NOW_MS,
      rtdbClient,
      send: async () => {
        sends += 1;
        throw new Error("ambiguous transport");
      },
      logError: () => {},
    },
  );
  const replay = await handleEventPrizeAnnouncement(
    await signedRequest(DATA),
    env,
    { now: () => NOW_MS, rtdbClient, logError: () => {} },
  );
  assert.equal(first.status, 409);
  assert.equal(replay.status, 409);
  assert.equal(sends, 1);
});

test("the Worker entrypoint routes the internal announcement path", async () => {
  const response = await handleFetch(
    new Request(`https://api.mons.link${EVENT_PRIZE_ANNOUNCEMENT_PATH}`, {
      method: "POST",
      body: "{}",
    }),
    env,
    {} as ExecutionContext,
  );
  assert.equal(response.status, 401);
});
