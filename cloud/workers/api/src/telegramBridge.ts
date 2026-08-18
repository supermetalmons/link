import { readBoundedBody } from "./http.ts";
import {
  normalizeTaskPayload,
  type TelegramTaskPayload,
} from "../../../functions/telegram/taskIdentity.js";

const MAX_BRIDGE_BODY_BYTES = 8 * 1024;
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;
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

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return null;
  }
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    return Uint8Array.from(atob(normalized), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

export async function createTelegramBridgeSignature(
  body: string,
  secret: string,
  timestamp: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function hasValidSignature(
  body: string,
  secret: string,
  timestamp: string,
  signature: string,
  nowMs: number,
): Promise<boolean> {
  if (!/^\d{10}$/.test(timestamp)) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS
  ) {
    return false;
  }
  const provided = decodeBase64Url(signature);
  if (!provided) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    exactArrayBuffer(provided),
    new TextEncoder().encode(`${timestamp}.${body}`),
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
    !(await hasValidSignature(body, secret, timestamp, signature, now()))
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
    await env.TELEGRAM_DELIVERY_QUEUE.send(payload);
  } catch {
    console.error(JSON.stringify({ event: "telegram_bridge_enqueue_failed" }));
    return bridgeResponse(503, "unavailable");
  }
  return bridgeResponse(202);
}

export { MAX_BRIDGE_BODY_BYTES, MAX_TIMESTAMP_SKEW_SECONDS, parseInitialTask };
