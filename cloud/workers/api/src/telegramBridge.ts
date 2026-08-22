import { readBoundedBody } from "./http.ts";
import {
  normalizeTaskPayload,
  type TelegramTaskPayload,
} from "../../../functions/telegram/taskIdentity.js";
import {
  createTelegramBridgeSignature,
  hasValidTelegramBridgeSignature,
  MAX_TIMESTAMP_SKEW_SECONDS,
} from "./telegramBridgeAuth.ts";
import { enqueueTelegramDeliveryTask } from "./telegramDeliveryTasks.ts";

const MAX_BRIDGE_BODY_BYTES = 8 * 1024;
const BRIDGE_KEYS = new Set([
  "generation",
  "messageKey",
  "retrySequence",
  "revision",
  "taskKind",
]);

function bridgeResponse(status: number, error?: string): Response {
  return new Response(
    JSON.stringify(error ? { ok: false, error } : { ok: true }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function parseInitialTask(body: string): TelegramTaskPayload {
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-task");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== BRIDGE_KEYS.size ||
    keys.some((key) => !BRIDGE_KEYS.has(key))
  ) {
    throw new Error("invalid-task");
  }
  const payload = normalizeTaskPayload(value);
  if (
    payload.retrySequence !== 0 ||
    (payload.taskKind !== "desired" &&
      payload.taskKind !== "manual-recovery") ||
    (payload.taskKind === "manual-recovery" &&
      payload.revision !== "manual-recovery")
  ) {
    throw new Error("invalid-task");
  }
  return payload;
}

export async function handleTelegramBridge(
  request: Request,
  env: Env,
  {
    now = Date.now,
  }: {
    now?: () => number;
  } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return bridgeResponse(405, "method-not-allowed");
  }
  let body: string;
  try {
    body = await readBoundedBody(request, MAX_BRIDGE_BODY_BYTES);
  } catch {
    return bridgeResponse(400, "invalid-request");
  }
  const timestamp =
    request.headers.get("X-Mons-Telegram-Timestamp")?.trim() || "";
  const signature =
    request.headers.get("X-Mons-Telegram-Signature")?.trim() || "";
  const secret = env.TELEGRAM_QUEUE_BRIDGE_SECRET.trim();
  if (
    !secret ||
    !(await hasValidTelegramBridgeSignature(
      body,
      secret,
      timestamp,
      signature,
      now(),
    ))
  ) {
    return bridgeResponse(401, "unauthenticated");
  }
  let payload: TelegramTaskPayload;
  try {
    payload = parseInitialTask(body);
  } catch {
    return bridgeResponse(400, "invalid-request");
  }
  try {
    await enqueueTelegramDeliveryTask(env, payload);
  } catch {
    console.error(JSON.stringify({ event: "telegram_bridge_enqueue_failed" }));
    return bridgeResponse(503, "unavailable");
  }
  return bridgeResponse(202);
}

export {
  createTelegramBridgeSignature,
  MAX_BRIDGE_BODY_BYTES,
  MAX_TIMESTAMP_SKEW_SECONDS,
  parseInitialTask,
};
