"use strict";

const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const test = require("node:test");
const { createDispatchers } = require("../admin/telegramQueueCli");
const { sendTelegramCommand } = require("../runtime/telegram/queueBridge");

test("admin commands sign and post the command body to the current endpoint", async () => {
  const calls = [];
  const nowMs = 1_700_000_000_123;
  const command = {
    kind: "recovery-preview",
    action: "confirm-send-absent",
    messageKey: "event:example:upcoming",
  };
  const result = { ok: true, dryRun: true };
  const dispatcher = createDispatchers("bridge-secret", {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(result);
    },
    now: () => nowMs,
  });

  assert.deepEqual(await dispatcher.sendCommand(command), result);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  const body = JSON.stringify(command);
  const timestamp = "1700000000";
  assert.equal(url, "https://api.mons.link/internal/telegram/command");
  assert.equal(init.method, "POST");
  assert.equal(init.body, body);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["X-Mons-Telegram-Timestamp"], timestamp);
  assert.equal(
    init.headers["X-Mons-Telegram-Signature"],
    createHmac("sha256", "bridge-secret")
      .update(`${timestamp}.${body}`)
      .digest("base64url"),
  );
  assert.ok(init.signal instanceof AbortSignal);
});

test("command bridge rejects missing credentials and unavailable transport", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      sendTelegramCommand(
        {},
        {
          secret: " ",
          fetchImpl: async () => {
            calls += 1;
            return Response.json({ ok: true });
          },
        },
      ),
    /telegram-command-bridge-secret-missing/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => sendTelegramCommand({}, { secret: "secret", fetchImpl: null }),
    /telegram-command-bridge-fetch-missing/,
  );
});

test("command bridge reports rejected commands and transport failures", async () => {
  await assert.rejects(
    () =>
      sendTelegramCommand(
        {},
        {
          secret: "secret",
          fetchImpl: async () =>
            Response.json({ error: "unavailable" }, { status: 503 }),
        },
      ),
    { code: "unavailable", status: 503 },
  );
  const failure = new Error("network failure");
  await assert.rejects(
    () =>
      sendTelegramCommand(
        {},
        {
          secret: "secret",
          fetchImpl: async () => {
            throw failure;
          },
        },
      ),
    (error) => {
      assert.equal(error.message, "telegram-command-bridge-unavailable");
      assert.equal(error.cause, failure);
      return true;
    },
  );
});

test("command bridge rejects malformed responses", async () => {
  await assert.rejects(
    () =>
      sendTelegramCommand(
        {},
        {
          secret: "secret",
          fetchImpl: async () => new Response("not JSON"),
        },
      ),
    /telegram-command-bridge-invalid-response/,
  );
});
