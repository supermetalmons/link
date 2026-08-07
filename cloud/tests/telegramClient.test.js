"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  deleteTelegramMessage,
  editTelegramMessage,
  sendTelegramMessage,
} = require("../functions/telegramClient");

const jsonResponse = (status, data) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() {
    return data;
  },
});

test("sends the exact Telegram payload and returns the message ID", async () => {
  let request;
  const result = await sendTelegramMessage({
    chatId: "chat-1",
    text: "<b>hello</b>",
    parseMode: "HTML",
    silent: true,
    token: "secret-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(200, {
        ok: true,
        result: { message_id: 42 },
      });
    },
  });

  assert.deepEqual(result, {
    ok: true,
    outcome: "sent",
    messageId: 42,
    httpStatus: 200,
  });
  assert.equal(request.url.endsWith("/botsecret-token/sendMessage"), true);
  assert.deepEqual(JSON.parse(request.options.body), {
    chat_id: "chat-1",
    text: "<b>hello</b>",
    disable_web_page_preview: true,
    disable_notification: true,
    parse_mode: "HTML",
  });
  assert.equal(request.options.signal instanceof AbortSignal, true);
});

test("omits parse mode for plain text sends", async () => {
  let body;
  await sendTelegramMessage({
    chatId: "chat-1",
    text: "hello",
    token: "token",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return jsonResponse(200, { ok: true, result: { message_id: 1 } });
    },
  });
  assert.equal(Object.hasOwn(body, "parse_mode"), false);
  assert.equal(body.disable_notification, false);
});

test("classifies explicit rate limits as safe retries", async () => {
  const result = await sendTelegramMessage({
    chatId: "chat",
    text: "hello",
    token: "token",
    fetchImpl: async () =>
      jsonResponse(429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 7 },
      }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.classification, "retryable");
  assert.equal(result.code, "rate-limited");
  assert.equal(result.retryAfterSeconds, 7);

  const malformed = await sendTelegramMessage({
    chatId: "chat",
    text: "hello",
    token: "token",
    fetchImpl: async () => ({
      status: 429,
      ok: false,
      async json() {
        throw new Error("invalid json");
      },
    }),
  });
  assert.equal(malformed.classification, "retryable");
  assert.equal(malformed.code, "rate-limited");
});

test("retries only known-safe send transport rejections", async () => {
  for (const code of [
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    const result = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "token",
      fetchImpl: async () => {
        const error = new Error(code);
        error.cause = { code };
        throw error;
      },
    });
    assert.equal(result.classification, "retryable", code);
    assert.equal(result.code, "network-error", code);
  }

  const ambiguous = await sendTelegramMessage({
    chatId: "chat",
    text: "hello",
    token: "token",
    fetchImpl: async () => {
      const error = new Error("connection reset");
      error.code = "ECONNRESET";
      throw error;
    },
  });
  assert.equal(ambiguous.classification, "uncertain");
});

test("classifies ambiguous send failures as uncertain", async (t) => {
  await t.test("network error", async () => {
    const result = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "sensitive-token",
      fetchImpl: async () => {
        throw new Error("request sensitive-token failed");
      },
    });
    assert.equal(result.classification, "uncertain");
    assert.equal(result.code, "network-error");
    assert.equal(result.description.includes("sensitive-token"), false);
  });

  await t.test("timeout", async () => {
    const result = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "token",
      timeoutMs: 5,
      fetchImpl: (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    assert.equal(result.classification, "uncertain");
    assert.equal(result.code, "timeout");

    const codedAbort = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "token",
      fetchImpl: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
        throw error;
      },
    });
    assert.equal(codedAbort.classification, "uncertain");
  });

  await t.test("server timeout", async () => {
    const result = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "token",
      fetchImpl: async () =>
        jsonResponse(408, { ok: false, description: "timeout" }),
    });
    assert.equal(result.classification, "uncertain");
    assert.equal(result.code, "http-408");
  });

  await t.test("server failure", async () => {
    const result = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "token",
      fetchImpl: async () =>
        jsonResponse(503, { ok: false, description: "unavailable" }),
    });
    assert.equal(result.classification, "uncertain");
  });

  await t.test("malformed response", async () => {
    const result = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "token",
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        async json() {
          throw new Error("invalid json");
        },
      }),
    });
    assert.equal(result.classification, "uncertain");
    assert.equal(result.code, "malformed-response");

    const invalidShape = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "token",
      fetchImpl: async () => jsonResponse(200, {}),
    });
    assert.equal(invalidShape.classification, "uncertain");
    assert.equal(invalidShape.code, "malformed-response");
  });

  await t.test("acknowledgement without an ID", async () => {
    const result = await sendTelegramMessage({
      chatId: "chat",
      text: "hello",
      token: "token",
      fetchImpl: async () => jsonResponse(200, { ok: true, result: {} }),
    });
    assert.equal(result.classification, "uncertain");
    assert.equal(result.code, "missing-message-id");
  });
});

test("classifies transient edit and delete failures as retryable", async () => {
  for (const request of [
    () =>
      editTelegramMessage({
        chatId: "chat",
        messageId: 1,
        text: "next",
        token: "token",
        fetchImpl: async () =>
          jsonResponse(408, { ok: false, description: "timeout" }),
      }),
    () =>
      deleteTelegramMessage({
        chatId: "chat",
        messageId: 1,
        token: "token",
        fetchImpl: async () => {
          throw new Error("network failed");
        },
      }),
  ]) {
    const result = await request();
    assert.equal(result.classification, "retryable");
  }
});

test("classifies Telegram body 408 and 500 errors as transient", async () => {
  const send = await sendTelegramMessage({
    chatId: "chat",
    text: "hello",
    token: "token",
    fetchImpl: async () =>
      jsonResponse(200, {
        ok: false,
        error_code: 500,
        description: "internal failure",
      }),
  });
  assert.equal(send.classification, "uncertain");
  assert.equal(send.code, "telegram-500");

  for (const request of [
    () =>
      editTelegramMessage({
        chatId: "chat",
        messageId: 1,
        text: "next",
        token: "token",
        fetchImpl: async () =>
          jsonResponse(200, {
            ok: false,
            error_code: 408,
            description: "request timeout",
          }),
      }),
    () =>
      deleteTelegramMessage({
        chatId: "chat",
        messageId: 1,
        token: "token",
        fetchImpl: async () =>
          jsonResponse(200, {
            ok: false,
            error_code: 500,
            description: "internal failure",
          }),
      }),
  ]) {
    const result = await request();
    assert.equal(result.classification, "retryable");
  }
});

test("does not normalize semantic phrases from HTTP 5xx responses", async () => {
  const edit = await editTelegramMessage({
    chatId: "chat",
    messageId: 1,
    text: "same",
    token: "token",
    fetchImpl: async () =>
      jsonResponse(503, {
        ok: false,
        error_code: 500,
        description: "message is not modified",
      }),
  });
  const deletion = await deleteTelegramMessage({
    chatId: "chat",
    messageId: 1,
    token: "token",
    fetchImpl: async () =>
      jsonResponse(503, {
        ok: false,
        error_code: 500,
        description: "message to delete not found",
      }),
  });
  assert.equal(edit.classification, "retryable");
  assert.equal(deletion.classification, "retryable");
});

test("normalizes idempotent edit and delete outcomes", async () => {
  const notModified = await editTelegramMessage({
    chatId: "chat",
    messageId: 1,
    text: "same",
    token: "token",
    fetchImpl: async () =>
      jsonResponse(400, {
        ok: false,
        description: "Bad Request: message is not modified",
      }),
  });
  assert.deepEqual(notModified, {
    ok: true,
    outcome: "not-modified",
    httpStatus: 400,
  });

  const missingEdit = await editTelegramMessage({
    chatId: "chat",
    messageId: 1,
    text: "same",
    token: "token",
    fetchImpl: async () =>
      jsonResponse(400, {
        ok: false,
        description: "Bad Request: message to edit not found",
      }),
  });
  assert.equal(missingEdit.classification, "missing");

  const missingDelete = await deleteTelegramMessage({
    chatId: "chat",
    messageId: 1,
    token: "token",
    fetchImpl: async () =>
      jsonResponse(400, {
        ok: false,
        description: "Bad Request: message to delete not found",
      }),
  });
  assert.deepEqual(missingDelete, {
    ok: true,
    outcome: "not-found",
    httpStatus: 400,
  });
});

test("classifies rejected requests as terminal without exposing the token", async () => {
  const result = await sendTelegramMessage({
    chatId: "chat",
    text: "hello",
    token: "sensitive-token",
    fetchImpl: async () =>
      jsonResponse(401, {
        ok: false,
        error_code: 401,
        description: "token sensitive-token rejected",
      }),
  });
  assert.equal(result.classification, "terminal");
  assert.equal(result.code, "telegram-401");
  assert.equal(result.description.includes("sensitive-token"), false);
});

test("redacts a token before truncating diagnostics", async () => {
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  const result = await sendTelegramMessage({
    chatId: "chat",
    text: "hello",
    token,
    fetchImpl: async () => {
      throw new Error(`${"x".repeat(500 - token.length + 1)}${token}`);
    },
  });
  assert.equal(result.description.includes(token), false);
  assert.equal(result.description.includes(token.slice(0, -1)), false);
  assert.equal(result.description.includes("[redacted]"), true);
  assert.equal(result.description.length <= 500, true);
});
