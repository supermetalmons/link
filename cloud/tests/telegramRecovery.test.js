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
    parseBridgeSecretFile([
      "--project",
      "mons-link",
      "--bridge-secret-file",
      "/secure/bridge",
      "15",
    ]),
    {
      bridgeSecretFile: "/secure/bridge",
      remainingArgs: ["--project", "mons-link", "15"],
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

test("manual recovery arguments default to dry-run and validate actions", () => {
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
      "--project",
      "mons-link",
    ]),
    {
      action: "confirm-send-applied",
      adminArgs: ["--project", "mons-link"],
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
        "--message-id",
        "77",
        "--bridge-secret-file",
        "/secure/bridge",
      ]),
    TypeError,
  );
});

const recoveryDatabase = () => {
  const record = {
    delivery: {
      status: "uncertain",
      sendInFlight: { attemptId: "attempt-1" },
    },
  };
  const snapshot = (value) => ({ val: () => value });
  return {
    record,
    database: {
      ref(path) {
        assert.equal(path, "telegramMessages/key");
        return {
          once: async () => snapshot(record),
          async transaction(updater) {
            const next = updater(structuredClone(record));
            if (next === undefined) {
              return { committed: false, snapshot: snapshot(record) };
            }
            for (const key of Object.keys(record)) {
              delete record[key];
            }
            Object.assign(record, next);
            return { committed: true, snapshot: snapshot(record) };
          },
          child(childPath) {
            return {
              async set(value) {
                record[childPath] = value;
              },
              async once() {
                if (childPath === "delivery/status") {
                  return snapshot(record.delivery.status);
                }
                return snapshot(record[childPath] || null);
              },
            };
          },
        };
      },
    },
  };
};

test("manual recovery writes, dispatches, and returns the matching result", async () => {
  const state = recoveryDatabase();
  const dispatched = [];
  const result = await recoverTelegramDelivery(
    {
      action: "confirm-send-absent",
      dryRun: false,
      messageKey: "key",
    },
    {
      database: state.database,
      randomId: () => "request-1",
      dispatchManualRecovery: async (input) => {
        dispatched.push(input);
        state.record.manualRecoveryResult = {
          requestId: "request-1",
          action: "confirm-send-absent",
          status: "accepted",
        };
      },
      now: () => 1_000,
      sleepImpl: async () => undefined,
    },
  );
  assert.deepEqual(state.record.manualRecovery, {
    requestId: "request-1",
    action: "confirm-send-absent",
  });
  assert.deepEqual(dispatched, [
    { messageKey: "key", requestId: "request-1", generation: "operator" },
  ]);
  assert.deepEqual(result, {
    ok: true,
    dryRun: false,
    messageKey: "key",
    requestId: "request-1",
    action: "confirm-send-absent",
    status: "accepted",
    deliveryStatus: "uncertain",
  });
});

test("manual recovery leaves the durable request pending when dispatch fails", async () => {
  const state = recoveryDatabase();
  await assert.rejects(
    () =>
      recoverTelegramDelivery(
        { action: "abandon", dryRun: false, messageKey: "key" },
        {
          database: state.database,
          randomId: () => "request-2",
          dispatchManualRecovery: async () => {
            throw new Error("bridge-unavailable");
          },
        },
      ),
    /remains pending/,
  );
  assert.deepEqual(state.record.manualRecovery, {
    requestId: "request-2",
    action: "abandon",
  });
});

test("manual recovery resumes the same pending request without replacing it", async () => {
  const state = recoveryDatabase();
  state.record.manualRecovery = {
    requestId: "existing-request",
    action: "abandon",
  };
  const dispatched = [];
  await recoverTelegramDelivery(
    { action: "abandon", dryRun: false, messageKey: "key" },
    {
      database: state.database,
      randomId: () => "replacement-request",
      dispatchManualRecovery: async (input) => {
        dispatched.push(input);
        state.record.manualRecoveryResult = {
          requestId: "existing-request",
          action: "abandon",
          status: "accepted",
        };
      },
      now: () => 1_000,
      sleepImpl: async () => undefined,
    },
  );
  assert.equal(state.record.manualRecovery.requestId, "existing-request");
  assert.deepEqual(dispatched, [
    {
      messageKey: "key",
      requestId: "existing-request",
      generation: "operator",
    },
  ]);
});

test("manual recovery refuses to overwrite a conflicting pending request", async () => {
  const state = recoveryDatabase();
  state.record.manualRecovery = {
    requestId: "existing-request",
    action: "abandon",
  };
  let dispatches = 0;
  await assert.rejects(
    () =>
      recoverTelegramDelivery(
        {
          action: "confirm-send-absent",
          dryRun: false,
          messageKey: "key",
        },
        {
          database: state.database,
          dispatchManualRecovery: async () => {
            dispatches += 1;
          },
        },
      ),
    /already pending/,
  );
  assert.equal(state.record.manualRecovery.requestId, "existing-request");
  assert.equal(dispatches, 0);
});
