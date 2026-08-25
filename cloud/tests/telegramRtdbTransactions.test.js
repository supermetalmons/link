"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isDeepStrictEqual } = require("node:util");
const {
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
} = require("../functions/telegramDelivery");
const {
  createTelegramRepository,
} = require("../functions/telegram/repositoryCore");
const {
  runRtdbDecisionTransaction,
} = require("../functions/rtdbDecisionTransaction");

const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);

const createRtdbRepository = (database) =>
  createTelegramRepository({
    async getPath(path) {
      const snapshot = await database.ref(path).once("value");
      return snapshot.exists() ? snapshot.val() : null;
    },
    transactPath(path, updater) {
      return runRtdbDecisionTransaction(database.ref(path), updater);
    },
  });

const createColdDatabase = (initial = {}) => {
  let root = clone(initial);
  const transactionCalls = [];

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
      current = current[segment];
    }
    return clone(current);
  };

  const writePath = (path, value) => {
    const segments = path ? path.split("/") : [];
    if (segments.length === 0) {
      root = value === null ? {} : clone(value);
      return;
    }
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      if (
        !parent[segment] ||
        typeof parent[segment] !== "object" ||
        Array.isArray(parent[segment])
      ) {
        parent[segment] = {};
      }
      parent = parent[segment];
    }
    const key = segments.at(-1);
    if (value === null) {
      delete parent[key];
    } else {
      parent[key] = clone(value);
    }
  };

  const snapshot = (value) => ({
    exists: () => value !== null && value !== undefined,
    val: () => (value === undefined ? null : clone(value)),
  });

  const database = {
    ref(path = "") {
      return {
        async once(eventType) {
          assert.equal(eventType, "value");
          return snapshot(readPath(path));
        },
        async transaction(updater, _onComplete, applyLocally) {
          const call = { path, applyLocally, inputs: [] };
          transactionCalls.push(call);
          const invoke = (value) => {
            call.inputs.push(clone(value));
            return updater(clone(value));
          };
          let output = invoke(undefined);
          if (output === undefined) {
            return { committed: false, snapshot: snapshot(null) };
          }
          const authoritative = readPath(path);
          if (!isDeepStrictEqual(authoritative, null)) {
            output = invoke(authoritative);
            if (output === undefined) {
              return {
                committed: false,
                snapshot: snapshot(authoritative),
              };
            }
          }
          writePath(path, output);
          return { committed: true, snapshot: snapshot(output) };
        },
      };
    },
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

const createEngine = ({ database, client, now = () => 10_000 }) => {
  const repository = createRtdbRepository(database);
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
  const inputs = [];
  const result = await runRtdbDecisionTransaction(
    database.ref("record"),
    (current) => {
      inputs.push(clone(current));
      return { commit: false, decision: "unchanged" };
    },
  );
  assert.deepEqual(inputs, [null, { value: 1 }]);
  assert.deepEqual(result, {
    committed: false,
    sdkCommitted: true,
    decision: "unchanged",
    value: { value: 1 },
  });
  assert.deepEqual(database.read("record"), { value: 1 });
  assert.equal(database.transactionCalls[0].applyLocally, false);
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
      () => runRtdbDecisionTransaction(database.ref("record"), () => output),
      TypeError,
    );
  }

  const database = createColdDatabase({ record: { value: 1 } });
  const result = await runRtdbDecisionTransaction(
    database.ref("record"),
    () => ({ value: null, decision: "deleted" }),
  );
  assert.equal(result.committed, true);
  assert.equal(result.sdkCommitted, true);
  assert.equal(result.value, null);
  assert.equal(database.read("record"), null);
});

test("cold transactions complete send marker, receipt, and finalization once", async () => {
  const desired = sendDesired();
  const database = createColdDatabase({
    telegramMessages: { key: { desired } },
  });
  let sends = 0;
  const engine = createEngine({
    database,
    client: {
      async sendTelegramMessage() {
        sends += 1;
        return { ok: true, outcome: "sent", messageId: 7 };
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
  const record = database.read("telegramMessages/key");
  assert.equal(record.applied.messageId, 7);
  assert.equal(record.delivery.status, "delivered");
  assert.equal(record.delivery.sendInFlight, undefined);
  assert.equal(
    database.transactionCalls.every((call) => call.applyLocally === false),
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
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 8,
            instanceKey: desired.instanceKey,
            revision: "old",
            contentHash: "old",
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
          return { ok: true, outcome: "edited" };
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
      database.read("telegramMessages/key").applied.contentHash,
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
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 9,
            instanceKey: "waiting:invite-1",
            revision: "old",
            contentHash: "old",
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
          return { ok: true, outcome: "deleted" };
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
    assert.equal(database.read("telegramMessages/key").applied, undefined);
  });
});

test("cold logical no-ops preserve active leases", async () => {
  const desired = sendDesired();
  const initialRecord = {
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
  assert.deepEqual(messageTransaction.inputs, [undefined, initialRecord]);
});

test("cold delivery-control transactions rerun owner fences authoritatively", async () => {
  const matchingDatabase = createColdDatabase({
    telegramDeliveryControl: {
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
  const matchingRepository = createRtdbRepository(matchingDatabase);
  assert.equal(await matchingRepository.releaseApiGate("gate-a"), true);
  assert.equal(matchingDatabase.read("telegramDeliveryControl/apiGate"), null);

  const proofDatabase = createColdDatabase({
    telegramDeliveryControl: {
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
  const proofRepository = createRtdbRepository(proofDatabase);
  assert.deepEqual(
    await proofRepository.extendRetryBarrierAndReleaseApiGate({
      owner: "gate-a",
      retryNotBeforeMs: 20_000,
    }),
    {
      applied: true,
      retryNotBeforeMs: 20_000,
      gate: {},
    },
  );
  assert.deepEqual(proofDatabase.read("telegramDeliveryControl"), {
    retryNotBeforeMs: 20_000,
  });

  const staleDatabase = createColdDatabase({
    telegramDeliveryControl: {
      apiGate: {
        owner: "gate-b",
        messageKey: "key",
        revision: "revision-b",
        operation: "delete",
        acquiredAtMs: 2_000,
      },
    },
  });
  const staleRepository = createRtdbRepository(staleDatabase);
  assert.equal(await staleRepository.releaseApiGate("gate-a"), false);
  const staleProof = await staleRepository.extendRetryBarrierAndReleaseApiGate({
    owner: "gate-a",
    retryNotBeforeMs: 20_000,
  });
  assert.equal(staleProof.applied, false);
  assert.equal(staleProof.gate.owner, "gate-b");
  assert.equal(
    staleDatabase.read("telegramDeliveryControl/apiGate").owner,
    "gate-b",
  );
  assert.equal(
    staleDatabase.transactionCalls.every(
      (call) => call.inputs[0] === undefined,
    ),
    true,
  );
});
