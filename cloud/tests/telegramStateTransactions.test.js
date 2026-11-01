"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isDeepStrictEqual } = require("node:util");
const {
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
} = require("../runtime/telegram/desiredStateCore");
const {
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
} = require("../runtime/telegram/deliveryEngine");
const {
  createTelegramRepository,
} = require("../runtime/telegram/repositoryCore");
const { runStateDecisionTransaction } = require("./legacyStateFixture");
const {
  readTelegramMessageDocument,
  readTelegramControlDocument,
} = require("../runtime/telegram/recordCodec");
/**
 * @template Document
 * @param {unknown} value
 * @param {(value: unknown) => Document | null} parse
 * @returns {Document | null}
 */
function storedDocument(value, parse) {
  if (value == null) return null;
  const document = parse(value);
  assert.ok(document);
  return document;
}
/** @param {ReturnType<typeof createColdDatabase>} database */
function storedMessage(database) {
  const document = storedDocument(
    database.read("telegramMessages/key"),
    readTelegramMessageDocument,
  );
  assert.ok(document);
  return document;
}

/** @template Value @param {Value} value @returns {Value} */
const clone = (value) => (value === undefined ? value : structuredClone(value));

/** @param {ReturnType<typeof createColdDatabase>} database */
const createMemoryRepository = (database) =>
  createTelegramRepository({
    async readMessage(messageKey) {
      /** @param {unknown} value */
      const snapshot = await database
        .ref(`telegramMessages/${messageKey}`)
        .once("value");
      return storedDocument(
        snapshot.exists() ? snapshot.val() : null,
        readTelegramMessageDocument,
      );
    },
    async transactMessage(messageKey, updater) {
      const result = await runStateDecisionTransaction(
        database.ref(`telegramMessages/${messageKey}`),
        (current) =>
          updater(storedDocument(current, readTelegramMessageDocument)),
      );
      return {
        committed: result.committed,
        value: storedDocument(result.value, readTelegramMessageDocument),
        ...(result.decision === undefined ? {} : { decision: result.decision }),
      };
    },
    async readControl() {
      /** @param {unknown} value */
      const snapshot = await database
        .ref("telegramDeliveryControl")
        .once("value");
      return storedDocument(
        snapshot.exists() ? snapshot.val() : null,
        readTelegramControlDocument,
      );
    },
    async transactControl(updater) {
      const result = await runStateDecisionTransaction(
        database.ref("telegramDeliveryControl"),
        (current) =>
          updater(storedDocument(current, readTelegramControlDocument)),
      );
      return {
        committed: result.committed,
        value: storedDocument(result.value, readTelegramControlDocument),
        ...(result.decision === undefined ? {} : { decision: result.decision }),
      };
    },
  });

/** @param {Record<string, unknown>} [initial] */
const createColdDatabase = (initial = {}) => {
  /** @type {unknown} */
  let root = clone(initial);
  /** @type {{path: string, argumentCount: number, inputs: unknown[]}[]} */
  const transactionCalls = [];

  /** @param {string} path @returns {unknown} */
  const readPath = (path) => {
    if (!path) {
      return clone(root);
    }
    let current = root;
    for (const segment of path.split("/")) {
      if (
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, segment)
      ) {
        return null;
      }
      current = /** @type {Record<string, unknown>} */ (current)[segment];
    }
    return clone(current);
  };

  /** @param {string} path @param {unknown} value */
  const writePath = (path, value) => {
    const segments = path ? path.split("/") : [];
    if (segments.length === 0) {
      root = value === null ? {} : clone(value);
      return;
    }
    let parent = /** @type {Record<string, unknown>} */ (root);
    for (const segment of segments.slice(0, -1)) {
      if (
        !parent[segment] ||
        typeof parent[segment] !== "object" ||
        Array.isArray(parent[segment])
      ) {
        parent[segment] = {};
      }
      parent = /** @type {Record<string, unknown>} */ (parent[segment]);
    }
    const key = segments.at(-1);
    assert.ok(key !== undefined);
    if (value === null) {
      delete parent[key];
    } else {
      parent[key] = clone(value);
    }
  };

  /** @param {unknown} value */
  const snapshot = (value) => ({
    exists: () => value !== null && value !== undefined,
    val: () => (value === undefined ? null : clone(value)),
  });

  const database = {
    ref(path = "") {
      return {
        /** @param {string} eventType */
        async once(eventType) {
          assert.equal(eventType, "value");
          return snapshot(readPath(path));
        },
        /** @param {(current: unknown) => unknown} updater @param {unknown[]} extra */
        async transaction(updater, ...extra) {
          /** @type {{path: string, argumentCount: number, inputs: unknown[]}} */
          const call = { path, argumentCount: 1 + extra.length, inputs: [] };
          transactionCalls.push(call);
          /** @param {unknown} value */
          const invoke = (value) => {
            call.inputs.push(clone(value));
            return updater(clone(value));
          };
          let output = invoke(undefined);
          if (output === undefined) {
            return { committed: false, value: clone(null) };
          }
          const authoritative = readPath(path);
          if (!isDeepStrictEqual(authoritative, null)) {
            output = invoke(authoritative);
            if (output === undefined) {
              return {
                committed: false,
                value: clone(authoritative),
              };
            }
          }
          writePath(path, output);
          return { committed: true, value: clone(output) };
        },
      };
    },
    /** @param {string} path */
    read(path) {
      return readPath(path);
    },
    transactionCalls,
  };
  return database;
};

const sendDesired = () =>
  buildTelegramSendDesired({
    destination: "community",
    instanceKey: "waiting:invite-1",
    text: "looking",
    parseMode: "HTML",
    sourceRevision: "waiting-1",
  });

/** @param {{database: ReturnType<typeof createColdDatabase>, client: import("../runtime/telegram/client").TelegramClient, now?: () => number}} input */
const createEngine = ({ database, client, now = () => 10_000 }) => {
  const repository = createMemoryRepository(database);
  return createTelegramDeliveryEngine({
    repository,
    client,
    now,
    createOwnerToken: () => "owner-1",
    resolveDestination: () => "community-chat",
    logger: { error() {}, info() {} },
    localRetryBarrier: createTelegramLocalRetryBarrier(),
  });
};

test("decision transactions rerun logical aborts against authoritative state", async () => {
  const database = createColdDatabase({ record: { value: 1 } });
  /** @type {unknown[]} */
  const inputs = [];
  const result = await runStateDecisionTransaction(
    database.ref("record"),
    (current) => {
      inputs.push(clone(current));
      return { commit: false, decision: "unchanged" };
    },
  );
  assert.deepEqual(inputs, [null, { value: 1 }]);
  assert.deepEqual(result, {
    committed: false,
    storageCommitted: true,
    decision: "unchanged",
    value: { value: 1 },
  });
  assert.deepEqual(database.read("record"), { value: 1 });
  assert.ok(database.transactionCalls[0]);
  assert.equal(database.transactionCalls[0].argumentCount, 1);
});

test("decision transactions validate writes and allow null deletion", async () => {
  for (const output of [
    null,
    {},
    { value: undefined },
    { commit: true, value: 1 },
    { commit: false, value: 1 },
  ]) {
    const database = createColdDatabase({ record: { value: 1 } });
    await assert.rejects(
      () => runStateDecisionTransaction(database.ref("record"), () => output),
      TypeError,
    );
  }

  const database = createColdDatabase({ record: { value: 1 } });
  const result = await runStateDecisionTransaction(
    database.ref("record"),
    () => ({ value: null, decision: "deleted" }),
  );
  assert.equal(result.committed, true);
  assert.equal(result.storageCommitted, true);
  assert.equal(result.value, null);
  assert.equal(database.read("record"), null);
});

test("cold transactions complete send marker, receipt, and finalization once", async () => {
  const desired = sendDesired();
  const database = createColdDatabase({
    telegramMessages: { key: { schemaVersion: 1, desired } },
  });
  let sends = 0;
  const engine = createEngine({
    database,
    client: {
      async sendTelegramMessage() {
        sends += 1;
        return { ok: true, outcome: "sent", messageId: 7, httpStatus: 200 };
      },
      async editTelegramMessage() {
        throw new Error("unexpected edit");
      },
      async deleteTelegramMessage() {
        throw new Error("unexpected delete");
      },
    },
  });
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "delivered",
  );
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "settled",
  );
  assert.equal(sends, 1);
  const record = storedMessage(database);
  assert.ok(record.applied && record.delivery);
  assert.equal(record.applied.messageId, 7);
  assert.equal(record.delivery.status, "delivered");
  assert.equal(record.delivery.sendInFlight, undefined);
  assert.equal(
    database.transactionCalls.every((call) => call.argumentCount === 1),
    true,
  );
  assert.equal(
    database.transactionCalls.every((call) => call.inputs[0] === undefined),
    true,
  );
});

test("cold transactions finalize idempotent edit and delete operations", async (t) => {
  await t.test("edit", async () => {
    const desired = buildTelegramEditDesired({
      destination: "community",
      instanceKey: "waiting:invite-1",
      text: "updated",
      parseMode: "HTML",
      ifMissing: "skip",
      sourceRevision: "edit-1",
    });
    const database = createColdDatabase({
      telegramMessages: {
        key: {
          schemaVersion: 1,
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 8,
            instanceKey: desired.instanceKey,
            revision: "old",
            contentHash: "old",
            appliedAtMs: 1,
          },
        },
      },
    });
    let edits = 0;
    const engine = createEngine({
      database,
      client: {
        async sendTelegramMessage() {
          throw new Error("unexpected send");
        },
        async editTelegramMessage() {
          edits += 1;
          return { ok: true, outcome: "edited", httpStatus: 200 };
        },
        async deleteTelegramMessage() {
          throw new Error("unexpected delete");
        },
      },
    });
    assert.equal(
      (await engine.reconcile({ messageKey: "key" })).status,
      "delivered",
    );
    assert.equal(
      (await engine.reconcile({ messageKey: "key" })).status,
      "settled",
    );
    assert.equal(edits, 1);
    assert.equal(
      storedMessage(database).applied?.contentHash,
      desired.contentHash,
    );
  });

  await t.test("delete", async () => {
    const desired = buildTelegramDeleteDesired({
      destination: "community",
      sourceRevision: "delete-1",
    });
    const database = createColdDatabase({
      telegramMessages: {
        key: {
          schemaVersion: 1,
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 9,
            instanceKey: "waiting:invite-1",
            revision: "old",
            contentHash: "old",
            appliedAtMs: 1,
          },
        },
      },
    });
    let deletes = 0;
    const engine = createEngine({
      database,
      client: {
        async sendTelegramMessage() {
          throw new Error("unexpected send");
        },
        async editTelegramMessage() {
          throw new Error("unexpected edit");
        },
        async deleteTelegramMessage() {
          deletes += 1;
          return { ok: true, outcome: "deleted", httpStatus: 200 };
        },
      },
    });
    assert.equal(
      (await engine.reconcile({ messageKey: "key" })).status,
      "delivered",
    );
    assert.equal(
      (await engine.reconcile({ messageKey: "key" })).status,
      "settled",
    );
    assert.equal(deletes, 1);
    assert.equal(storedMessage(database).applied, undefined);
  });
});

test("cold logical no-ops preserve active leases", async () => {
  const desired = sendDesired();
  const initialRecord = {
    schemaVersion: 1,
    desired,
    delivery: {
      status: "processing",
      revision: desired.revision,
      attempts: 1,
      leaseOwner: "other-owner",
      leaseExpiresAtMs: 20_000,
    },
  };
  const database = createColdDatabase({
    telegramMessages: { key: initialRecord },
  });
  const engine = createEngine({
    database,
    client: {
      async sendTelegramMessage() {
        throw new Error("unexpected send");
      },
      async editTelegramMessage() {
        throw new Error("unexpected edit");
      },
      async deleteTelegramMessage() {
        throw new Error("unexpected delete");
      },
    },
  });
  assert.deepEqual(await engine.reconcile({ messageKey: "key" }), {
    status: "retryable",
    reason: "locked",
    retryAtMs: 20_000,
    scheduled: true,
  });
  assert.deepEqual(database.read("telegramMessages/key"), initialRecord);
  const messageTransaction = database.transactionCalls.find(
    (call) => call.path === "telegramMessages/key",
  );
  assert.ok(messageTransaction);
  assert.deepEqual(messageTransaction.inputs, [undefined, initialRecord]);
});

test("cold delivery-control transactions rerun owner fences authoritatively", async () => {
  const matchingDatabase = createColdDatabase({
    telegramDeliveryControl: {
      schemaVersion: 1,
      retryNotBeforeMs: 5_000,
      apiGate: {
        owner: "gate-a",
        messageKey: "key",
        revision: "revision-a",
        operation: "edit",
        acquiredAtMs: 1_000,
      },
    },
  });
  const matchingRepository = createMemoryRepository(matchingDatabase);
  assert.equal(await matchingRepository.releaseApiGate("gate-a"), true);
  assert.equal(matchingDatabase.read("telegramDeliveryControl/apiGate"), null);

  const proofDatabase = createColdDatabase({
    telegramDeliveryControl: {
      schemaVersion: 1,
      retryNotBeforeMs: 5_000,
      apiGate: {
        owner: "gate-a",
        messageKey: "key",
        revision: "revision-a",
        operation: "edit",
        acquiredAtMs: 1_000,
      },
    },
  });
  const proofRepository = createMemoryRepository(proofDatabase);
  assert.deepEqual(
    await proofRepository.extendRetryBarrierAndReleaseApiGate({
      owner: "gate-a",
      retryNotBeforeMs: 20_000,
    }),
    {
      applied: true,
      retryNotBeforeMs: 20_000,
      gate: null,
    },
  );
  assert.deepEqual(proofDatabase.read("telegramDeliveryControl"), {
    schemaVersion: 1,
    retryNotBeforeMs: 20_000,
  });

  const staleDatabase = createColdDatabase({
    telegramDeliveryControl: {
      schemaVersion: 1,
      apiGate: {
        owner: "gate-b",
        messageKey: "key",
        revision: "revision-b",
        operation: "delete",
        acquiredAtMs: 2_000,
      },
    },
  });
  const staleRepository = createMemoryRepository(staleDatabase);
  assert.equal(await staleRepository.releaseApiGate("gate-a"), false);
  const staleProof = await staleRepository.extendRetryBarrierAndReleaseApiGate({
    owner: "gate-a",
    retryNotBeforeMs: 20_000,
  });
  assert.equal(staleProof.applied, false);
  assert.ok(staleProof.gate);
  assert.equal(staleProof.gate.owner, "gate-b");
  const staleGate = staleDatabase.read("telegramDeliveryControl/apiGate");
  assert.ok(
    staleGate !== null && typeof staleGate === "object" && "owner" in staleGate,
  );
  assert.equal(staleGate.owner, "gate-b");
  assert.equal(
    staleDatabase.transactionCalls.every(
      (call) => call.inputs[0] === undefined,
    ),
    true,
  );
});
