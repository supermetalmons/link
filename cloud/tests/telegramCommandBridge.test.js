"use strict";

const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const test = require("node:test");
const { createDispatchers } = require("../admin/telegramQueueCli.ts");
const { sendTelegramCommand } = require("../runtime/telegram/queueBridge");

test("admin commands sign and post the command body to the current endpoint", async () => {
  /** @type {{url: string, init: RequestInit}[]} */
  const calls = [];
  const nowMs = 1_700_000_000_123;
  /** @type {Parameters<typeof sendTelegramCommand>[0]} */
  const command = {
    kind: "recovery-preview",
    action: "confirm-send-absent",
    messageKey: "event:example:upcoming",
  };
  const result = {
    ok: true,
    dryRun: true,
    messageKey: command.messageKey,
    action: command.action,
  };
  const dispatcher = createDispatchers("bridge-secret", {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(result);
    },
    now: () => nowMs,
  });

  assert.deepEqual(await dispatcher.sendCommand(command), result);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]);
  const { url, init } = calls[0];
  assert.ok(
    init.headers &&
      !(init.headers instanceof Headers) &&
      !Array.isArray(init.headers),
  );
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
      Reflect.apply(sendTelegramCommand, undefined, [
        {},
        {
          secret: " ",
          fetchImpl: async () => {
            calls += 1;
            return Response.json({ ok: true });
          },
        },
      ]),
    /telegram-command-bridge-secret-missing/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () =>
      Reflect.apply(sendTelegramCommand, undefined, [
        {},
        { secret: "secret", fetchImpl: null },
      ]),
    /telegram-command-bridge-fetch-missing/,
  );
});

test("command bridge reports rejected commands and transport failures", async () => {
  await assert.rejects(
    () =>
      Reflect.apply(sendTelegramCommand, undefined, [
        {},
        {
          secret: "secret",
          fetchImpl: async () =>
            Response.json({ error: "unavailable" }, { status: 503 }),
        },
      ]),
    { code: "unavailable", status: 503 },
  );
  const failure = new Error("network failure");
  await assert.rejects(
    () =>
      Reflect.apply(sendTelegramCommand, undefined, [
        {},
        {
          secret: "secret",
          fetchImpl: async () => {
            throw failure;
          },
        },
      ]),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "telegram-command-bridge-unavailable");
      assert.equal(error.cause, failure);
      return true;
    },
  );
});

test("command bridge rejects malformed responses", async () => {
  await assert.rejects(
    () =>
      Reflect.apply(sendTelegramCommand, undefined, [
        {},
        {
          secret: "secret",
          fetchImpl: async () => new Response("not JSON"),
        },
      ]),
    /telegram-command-bridge-invalid-response/,
  );
});

test("admin dispatch rejects incomplete and mismatched command replies", async () => {
  /** @type {Parameters<typeof sendTelegramCommand>[0]} */
  const command = {
    kind: "recovery-preview",
    action: "confirm-send-applied",
    messageId: 77,
    messageKey: "event:example:upcoming",
  };
  const valid = {
    ok: true,
    dryRun: true,
    action: command.action,
    messageId: command.messageId,
    messageKey: command.messageKey,
  };
  for (const reply of [
    null,
    [],
    { ok: true },
    { ...valid, action: "abandon" },
    { ...valid, messageKey: "event:other:upcoming" },
    { ...valid, messageId: "77" },
    { ...valid, pendingRequestId: null },
    { ...valid, extra: true },
  ]) {
    const { sendCommand: dispatch } = createDispatchers("bridge-secret", {
      fetchImpl: async () => Response.json(reply),
    });
    await assert.rejects(
      dispatch(command),
      /telegram-command-bridge-invalid-response/,
    );
  }
});

test("admin dispatch validates each successful command reply shape", async () => {
  /** @type {[Parameters<typeof sendTelegramCommand>[0], unknown][]} */
  const cases = [
    [
      {
        kind: "send",
        destination: "community",
        generation: "generation",
        instanceKey: "instance",
        messageKey: "admin:test",
        sourceRevision: "source",
        text: "message",
      },
      { ok: true, messageKey: "admin:test", revision: "revision" },
    ],
    [
      {
        kind: "recovery-request",
        messageKey: "key",
        requestId: "proposed",
        action: "abandon",
      },
      { ok: true, messageKey: "key", requestId: "existing", action: "abandon" },
    ],
    [
      { kind: "recovery-status", messageKey: "key", requestId: "existing" },
      {
        ok: true,
        messageKey: "key",
        requestId: "existing",
        status: "accepted",
        deliveryStatus: null,
      },
    ],
    [
      { kind: "event-reminder-refresh", eventId: "event" },
      { ok: true, eventId: "event", status: "queued", reason: "refresh" },
    ],
  ];
  for (const [command, reply] of cases) {
    const { sendCommand: dispatch } = createDispatchers("bridge-secret", {
      fetchImpl: async () => Response.json(reply),
    });
    assert.deepEqual(await dispatch(command), reply);
  }
});
