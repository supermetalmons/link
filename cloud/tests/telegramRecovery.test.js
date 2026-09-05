"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseArgs: parseRecoveryArgs,
  recoverTelegramDelivery,
} = require("../admin/recoverTelegramDelivery");
const {
  parseBridgeSecretFile,
  readBridgeSecret,
} = require("../admin/telegramQueueCli");

test("Telegram admin bridge arguments require a bounded secret file", () => {
  assert.deepEqual(
    parseBridgeSecretFile(["--bridge-secret-file", "/secure/bridge", "15"]),
    {
      bridgeSecretFile: "/secure/bridge",
      remainingArgs: ["15"],
    },
  );
  assert.equal(
    readBridgeSecret("/secure/bridge", {
      readFile: () => Buffer.from(" bridge-secret\n"),
    }),
    "bridge-secret",
  );
  assert.throws(() => parseBridgeSecretFile([]), TypeError);
  assert.throws(
    () =>
      readBridgeSecret("/secure/bridge", {
        readFile: () => Buffer.alloc(8 * 1024 + 1),
      }),
    /too large/,
  );
});

test("bridge secret file failures do not expose file diagnostics or contents", () => {
  for (const [readFile, message] of [
    [
      () => {
        throw new Error("private path and diagnostic");
      },
      "Could not read the Telegram bridge secret file.",
    ],
    [() => Buffer.from("  "), "Telegram bridge secret file is empty."],
    [() => Buffer.alloc(8193), "Telegram bridge secret file is too large."],
  ]) {
    assert.throws(
      () => readBridgeSecret("/private/secret", { readFile }),
      (error) => {
        assert.equal(error.message, message);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test("manual recovery arguments default to dry-run and reject Firebase flags", () => {
  assert.deepEqual(
    parseRecoveryArgs([
      "--message-key",
      "key",
      "--action",
      "confirm-send-applied",
      "--message-id",
      "77",
      "--bridge-secret-file",
      "/secure/bridge",
    ]),
    {
      action: "confirm-send-applied",
      bridgeSecretFile: "/secure/bridge",
      dryRun: true,
      messageId: 77,
      messageKey: "key",
    },
  );
  assert.throws(
    () =>
      parseRecoveryArgs([
        "--message-key",
        "key",
        "--action",
        "abandon",
        "--project",
        "mons-link",
        "--bridge-secret-file",
        "/secure/bridge",
      ]),
    TypeError,
  );
});

test("manual recovery dry-run delegates to the signed command endpoint", async () => {
  const commands = [];
  const result = await recoverTelegramDelivery(
    {
      action: "confirm-send-absent",
      dryRun: true,
      messageKey: "key",
    },
    {
      sendCommand: async (command) => {
        commands.push(command);
        return { ok: true, dryRun: true, ...command };
      },
    },
  );
  assert.deepEqual(commands, [
    {
      kind: "recovery-preview",
      messageKey: "key",
      action: "confirm-send-absent",
    },
  ]);
  assert.equal(result.dryRun, true);
});

test("manual recovery requests and polls the exact accepted result", async () => {
  const commands = [];
  const requestId = "18ea8b32-ca88-4492-8ecb-42f87670a901";
  const result = await recoverTelegramDelivery(
    {
      action: "confirm-send-absent",
      dryRun: false,
      messageKey: "key",
    },
    {
      randomId: () => requestId,
      now: () => 1_000,
      sleepImpl: async () => undefined,
      sendCommand: async (command) => {
        commands.push(command);
        return command.kind === "recovery-request"
          ? { ok: true, requestId }
          : {
              ok: true,
              requestId,
              status: "accepted",
              deliveryStatus: "pending",
            };
      },
    },
  );
  assert.deepEqual(commands, [
    {
      kind: "recovery-request",
      requestId,
      messageKey: "key",
      action: "confirm-send-absent",
    },
    { kind: "recovery-status", messageKey: "key", requestId },
  ]);
  assert.deepEqual(result, {
    ok: true,
    dryRun: false,
    messageKey: "key",
    requestId,
    action: "confirm-send-absent",
    status: "accepted",
    deliveryStatus: "pending",
  });
});

test("manual recovery reports a possibly pending request after bridge failure", async () => {
  const requestId = "18ea8b32-ca88-4492-8ecb-42f87670a901";
  await assert.rejects(
    () =>
      recoverTelegramDelivery(
        { action: "abandon", dryRun: false, messageKey: "key" },
        {
          randomId: () => requestId,
          sendCommand: async () => {
            throw new Error("bridge-unavailable");
          },
        },
      ),
    /may remain pending/,
  );
});

test("manual recovery resumes the request ID returned by the server", async () => {
  const proposed = "18ea8b32-ca88-4492-8ecb-42f87670a901";
  const existing = "28ea8b32-ca88-4492-8ecb-42f87670a902";
  const commands = [];
  await recoverTelegramDelivery(
    { action: "abandon", dryRun: false, messageKey: "key" },
    {
      randomId: () => proposed,
      now: () => 1_000,
      sleepImpl: async () => undefined,
      sendCommand: async (command) => {
        commands.push(command);
        return command.kind === "recovery-request"
          ? { requestId: existing }
          : { requestId: existing, status: "accepted" };
      },
    },
  );
  assert.deepEqual(commands[1], {
    kind: "recovery-status",
    messageKey: "key",
    requestId: existing,
  });
});
