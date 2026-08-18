"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildTelegramDeleteDesired,
  buildTelegramDeleteUpdates,
  buildTelegramEditDesired,
  buildTelegramEditUpdates,
  buildTelegramSendDesired,
  buildTelegramSendUpdates,
  createFirebaseTelegramRepository,
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
  queueTelegramSend,
  resolveTelegramDestination,
  validateTelegramMessageKey,
} = require("../functions/telegramDelivery");
const {
  buildTelegramDeliveryTaskId,
  createTelegramDeliveryDispatcher,
  createTelegramManualRecoveryDispatcher,
  dispatchTelegramDelivery,
  dispatchTelegramManualRecovery,
  enqueueTelegramDeliveryTask,
  signTelegramBridgeRequest,
} = require("../functions/telegramDeliveryFunctions");

const clone = (value) =>
  value === undefined ? undefined : structuredClone(value);

const enabled = (value) => (typeof value === "function" ? value() : value);

const createRepository = (initial = {}, options = {}) => {
  const state = new Map(
    Object.entries(initial).map(([key, value]) => [key, clone(value)]),
  );
  const control = {
    retryNotBeforeMs:
      Number.isFinite(options.retryNotBeforeMs) && options.retryNotBeforeMs > 0
        ? Math.floor(options.retryNotBeforeMs)
        : 0,
    ...(options.apiGate ? { apiGate: clone(options.apiGate) } : {}),
  };
  const localRetryBarrier = createTelegramLocalRetryBarrier();
  let transactionCount = 0;
  return {
    state,
    control,
    localRetryBarrier,
    async getMessage(messageKey) {
      return clone(state.get(messageKey) || null);
    },
    async transactMessage(messageKey, updater) {
      transactionCount += 1;
      const current = clone(state.get(messageKey) || null);
      const output = updater(current);
      if (
        output?.commit === false ||
        options.rejectCommit?.({
          messageKey,
          current,
          output,
          transactionCount,
        })
      ) {
        return {
          committed: false,
          value: current,
          decision: output?.decision,
        };
      }
      state.set(messageKey, clone(output?.value));
      return {
        committed: true,
        value: clone(output?.value),
        decision: output?.decision,
      };
    },
    async getRetryNotBeforeMs() {
      if (enabled(options.rejectBarrierRead)) {
        const error = new Error("retry-barrier-read-failed");
        error.code = "retry-barrier-read-failed";
        throw error;
      }
      return control.retryNotBeforeMs;
    },
    async extendRetryNotBeforeMs(candidateMs) {
      if (enabled(options.rejectBarrierWrite)) {
        const error = new Error("retry-barrier-write-failed");
        error.code = "retry-barrier-write-failed";
        throw error;
      }
      control.retryNotBeforeMs = Math.max(
        control.retryNotBeforeMs,
        Math.floor(candidateMs),
      );
      return control.retryNotBeforeMs;
    },
    async acquireApiGate(input) {
      if (enabled(options.rejectApiGateWrite)) {
        const error = new Error("api-gate-write-failed");
        error.code = "api-gate-write-failed";
        throw error;
      }
      if (control.retryNotBeforeMs > input.acquiredAtMs) {
        return {
          acquired: false,
          reason: "retry-after",
          retryNotBeforeMs: control.retryNotBeforeMs,
          gate: clone(control.apiGate || {}),
        };
      }
      if (
        control.apiGate?.owner &&
        (control.apiGate.owner !== input.owner ||
          input.reclaimOwner !== input.owner)
      ) {
        return {
          acquired: false,
          reason: "gate-held",
          retryNotBeforeMs: control.retryNotBeforeMs,
          gate: clone(control.apiGate),
        };
      }
      if (control.apiGate?.owner === input.owner) {
        return {
          acquired: true,
          reason: "acquired",
          retryNotBeforeMs: control.retryNotBeforeMs,
          gate: clone(control.apiGate),
        };
      }
      control.apiGate = clone(input);
      return {
        acquired: true,
        reason: "acquired",
        retryNotBeforeMs: control.retryNotBeforeMs,
        gate: clone(control.apiGate),
      };
    },
    async releaseApiGate(owner) {
      if (enabled(options.rejectApiGateRelease)) {
        const error = new Error("api-gate-release-failed");
        error.code = "api-gate-release-failed";
        throw error;
      }
      if (control.apiGate?.owner !== owner) {
        return false;
      }
      delete control.apiGate;
      return true;
    },
    async extendRetryBarrierAndReleaseApiGate({ owner, retryNotBeforeMs }) {
      if (
        enabled(options.rejectBarrierProofWrite) ||
        enabled(options.rejectBarrierWrite)
      ) {
        const error = new Error("retry-barrier-write-failed");
        error.code = "retry-barrier-write-failed";
        throw error;
      }
      if (control.apiGate?.owner && control.apiGate.owner !== owner) {
        return {
          applied: false,
          retryNotBeforeMs: control.retryNotBeforeMs,
          gate: clone(control.apiGate),
        };
      }
      if (!control.apiGate && control.retryNotBeforeMs < retryNotBeforeMs) {
        return {
          applied: false,
          retryNotBeforeMs: control.retryNotBeforeMs,
          gate: {},
        };
      }
      control.retryNotBeforeMs = Math.max(
        control.retryNotBeforeMs,
        Math.floor(retryNotBeforeMs),
      );
      delete control.apiGate;
      return {
        applied: true,
        retryNotBeforeMs: control.retryNotBeforeMs,
        gate: {},
      };
    },
  };
};

const createClient = (overrides = {}) => ({
  async sendTelegramMessage() {
    return { ok: true, outcome: "sent", messageId: 101 };
  },
  async editTelegramMessage() {
    return { ok: true, outcome: "edited" };
  },
  async deleteTelegramMessage() {
    return { ok: true, outcome: "deleted" };
  },
  ...overrides,
});

const createEngine = ({
  repository,
  client,
  now = () => 10_000,
  scheduleRetry,
  createAttemptId,
  createOwnerToken,
}) =>
  createTelegramDeliveryEngine({
    repository,
    client: client || createClient(),
    now,
    createOwnerToken: createOwnerToken || (() => "owner-1"),
    createAttemptId: createAttemptId || (() => "attempt-1"),
    scheduleRetry: scheduleRetry || (async () => ({ scheduled: true })),
    resolveDestination: (destination) =>
      destination === "community" ? "community-chat" : "events-chat",
    logger: { error() {}, info() {} },
    localRetryBarrier: repository.localRetryBarrier,
  });

test("delivery engine requires an explicit complete client", () => {
  const repository = createRepository();
  assert.throws(
    () =>
      createTelegramDeliveryEngine({
        repository,
        scheduleRetry: async () => ({ scheduled: true }),
        localRetryBarrier: repository.localRetryBarrier,
      }),
    /complete Telegram client is required/,
  );
});

const reconcileScheduledTask = (engine, task) =>
  engine.reconcile({
    messageKey: task.messageKey,
    requestedRevision: task.revision,
    requestedGeneration: task.generation,
    taskKind: task.taskKind,
    retrySequence: task.retrySequence,
    retryStartedAtMs: task.retryStartedAtMs,
    retryDeadlineAtMs: task.retryDeadlineAtMs,
    retryAtMs: task.retryAtMs,
    safeRejectedAttemptId: task.safeRejectedAttemptId,
    pendingDeleteId: task.pendingDeleteId,
    retryProofLeaseOwner: task.retryProofLeaseOwner,
    proofTaskKind: task.proofTaskKind,
    barrierProofOwner: task.barrierProofOwner,
    barrierRetryNotBeforeMs: task.barrierRetryNotBeforeMs,
    apiGateReclaimOwner: task.apiGateReclaimOwner,
    apiGateSettleOwner: task.apiGateSettleOwner,
  });

const sendDesired = (overrides = {}) =>
  buildTelegramSendDesired({
    destination: "community",
    instanceKey: "waiting:invite-1",
    text: "looking",
    parseMode: "HTML",
    silent: false,
    sourceRevision: "source-1",
    ...overrides,
  });

const editDesired = (overrides = {}) =>
  buildTelegramEditDesired({
    destination: "community",
    instanceKey: "waiting:invite-1",
    text: "changed",
    parseMode: "HTML",
    silent: false,
    ifMissing: "skip",
    sourceRevision: "source-2",
    ...overrides,
  });

test("builds deterministic desired state and Firebase multipath updates", () => {
  const input = {
    messageKey: "automatch:invite-1",
    destination: "community",
    instanceKey: "waiting:invite-1",
    text: "hello",
    parseMode: "HTML",
    silent: true,
    sourceRevision: 3,
  };
  const first = buildTelegramSendUpdates(input);
  const second = buildTelegramSendUpdates(input);
  assert.deepEqual(first, second);
  const desired = first["telegramMessages/automatch:invite-1/desired"];
  assert.equal(desired.schemaVersion, 2);
  assert.equal(desired.operation, "send");
  assert.equal(desired.sourceRevision, "3");
  assert.equal(desired.revision.length, 64);
  assert.equal(desired.contentHash.length, 64);
  assert.equal(JSON.stringify(desired).includes("chat_id"), false);

  const changedMode = buildTelegramSendDesired({
    ...input,
    parseMode: null,
  });
  const changedDestination = buildTelegramSendDesired({
    ...input,
    destination: "events",
  });
  assert.notEqual(desired.contentHash, changedMode.contentHash);
  assert.notEqual(desired.contentHash, changedDestination.contentHash);

  const edit = buildTelegramEditUpdates({
    ...input,
    ifMissing: "send",
  })["telegramMessages/automatch:invite-1/desired"];
  assert.equal(edit.operation, "edit");
  assert.equal(edit.ifMissing, "send");

  const deletion = buildTelegramDeleteUpdates({
    messageKey: "automatch:invite-1",
    destination: "community",
    sourceRevision: "deleted",
  })["telegramMessages/automatch:invite-1/desired"];
  assert.deepEqual(
    deletion,
    buildTelegramDeleteDesired({
      destination: "community",
      sourceRevision: "deleted",
    }),
  );
});

test("community and legacy events destinations resolve to the community chat", () => {
  const environment = {
    TELEGRAM_EXTRA_CHAT_ID: "community-chat",
    TELEGRAM_CHAT_ID_IVAN: "legacy-events-chat",
  };
  assert.equal(
    resolveTelegramDestination("community", environment),
    "community-chat",
  );
  assert.equal(
    resolveTelegramDestination("events", environment),
    "community-chat",
  );
});

test("validates Firebase-safe logical message keys", () => {
  assert.equal(
    validateTelegramMessageKey("event:abc:upcoming"),
    "event:abc:upcoming",
  );
  for (const key of ["", " spaced", "a.b", "a#b", "a$b", "a/b", "a[b", "a]b"]) {
    assert.throws(() => validateTelegramMessageKey(key), TypeError);
  }
});

test("queue APIs await only durable desired persistence", async () => {
  let updates;
  const database = {
    ref() {
      return {
        async update(value) {
          updates = value;
        },
      };
    },
  };
  const result = await queueTelegramSend(
    {
      messageKey: "admin:test:1",
      destination: "community",
      instanceKey: "admin:test:1",
      text: "notice",
      sourceRevision: "1",
    },
    { database },
  );
  assert.equal(result.messageKey, "admin:test:1");
  assert.equal(result.revision, result.desired.revision);
  assert.deepEqual(updates, {
    "telegramMessages/admin:test:1/desired": result.desired,
  });
});

test("delivers a new send and persists its receipt", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  let request;
  const client = createClient({
    async sendTelegramMessage(value) {
      request = value;
      return { ok: true, outcome: "sent", messageId: 55 };
    },
  });
  const result = await createEngine({ repository, client }).reconcile({
    messageKey: "key",
    requestedRevision: "stale-revision",
  });
  assert.equal(result.status, "delivered");
  assert.deepEqual(request, {
    chatId: "community-chat",
    text: "looking",
    parseMode: "HTML",
    silent: false,
    disableWebPagePreview: true,
  });
  const state = repository.state.get("key");
  assert.equal(state.applied.messageId, 55);
  assert.equal(state.applied.chatId, "community-chat");
  assert.equal(state.applied.contentHash, desired.contentHash);
  assert.equal(state.delivery.status, "delivered");
  assert.equal(state.delivery.attempts, 1);
  assert.equal(Object.hasOwn(state.delivery, "leaseOwner"), false);
});

test("settles a delete-only smoke record without calling Telegram", async () => {
  const desired = buildTelegramDeleteDesired({
    destination: "community",
    sourceRevision: "migration-smoke",
  });
  const repository = createRepository({ key: { desired } });
  const engine = createEngine({
    repository,
    client: createClient({
      async deleteTelegramMessage() {
        throw new Error("unexpected Telegram delete");
      },
    }),
  });
  const result = await engine.reconcile({ messageKey: "key" });
  assert.equal(result.status, "delivered");
  assert.equal(repository.state.get("key").applied, undefined);
});

test("always reconciles the latest desired revision from storage", async () => {
  const desired = sendDesired({ text: "latest", sourceRevision: "latest" });
  const repository = createRepository({ key: { desired } });
  let sentText;
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage({ text }) {
        sentText = text;
        return { ok: true, messageId: 1 };
      },
    }),
  });
  await engine.reconcile({ messageKey: "key", requestedRevision: "old" });
  assert.equal(sentText, "latest");
});

test("leaves a newer desired revision pending when state changes during delivery", async () => {
  const initial = sendDesired({ text: "initial", sourceRevision: "initial" });
  const latest = editDesired({
    text: "latest",
    sourceRevision: "latest",
    ifMissing: "send",
  });
  const repository = createRepository({ key: { desired: initial } });
  const calls = [];
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        calls.push("send-initial");
        repository.state.set("key", {
          ...repository.state.get("key"),
          desired: latest,
        });
        return { ok: true, messageId: 1 };
      },
      async editTelegramMessage({ text }) {
        calls.push(`edit-${text}`);
        return { ok: true };
      },
    }),
  });
  await engine.reconcile({ messageKey: "key" });
  assert.equal(repository.state.get("key").delivery.status, "pending");
  assert.equal(repository.state.get("key").delivery.revision, latest.revision);
  assert.equal(repository.state.get("key").delivery.attempts, 0);
  await engine.reconcile({ messageKey: "key" });
  assert.deepEqual(calls, ["send-initial", "edit-latest"]);
  assert.equal(repository.state.get("key").delivery.status, "delivered");
});

test("never retries an abandoned send-in-flight marker", async () => {
  const desired = sendDesired();
  let sends = 0;
  const repository = createRepository({
    key: {
      desired,
      delivery: {
        status: "processing",
        revision: desired.revision,
        leaseOwner: "old-owner",
        leaseExpiresAtMs: 1,
        attempts: 1,
        sendInFlight: {
          revision: desired.revision,
          instanceKey: desired.instanceKey,
          startedAtMs: 1,
        },
      },
    },
  });
  const result = await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return { ok: true, messageId: 1 };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.equal(result.status, "uncertain");
  assert.equal(sends, 0);
  assert.equal(repository.state.get("key").delivery.status, "uncertain");
});

test("an abandoned send releases the global gate without retrying it", async () => {
  const firstDesired = sendDesired({ text: "first", sourceRevision: "first" });
  const secondDesired = sendDesired({
    text: "second",
    sourceRevision: "second",
  });
  let rejectRelease = true;
  let sends = 0;
  const apiGateOwner = "send:abandoned-attempt";
  const repository = createRepository(
    {
      first: {
        desired: firstDesired,
        delivery: {
          status: "processing",
          revision: firstDesired.revision,
          leaseOwner: "dead-worker",
          leaseExpiresAtMs: 1,
          attempts: 1,
          sendInFlight: {
            attemptId: "abandoned-attempt",
            apiGateOwner,
            revision: firstDesired.revision,
            destination: "community",
            chatId: "community-chat",
            instanceKey: firstDesired.instanceKey,
            contentHash: firstDesired.contentHash,
            startedAtMs: 1,
          },
        },
      },
      second: { desired: secondDesired },
    },
    {
      apiGate: {
        owner: apiGateOwner,
        messageKey: "first",
        revision: firstDesired.revision,
        operation: "send",
        acquiredAtMs: 1,
      },
      rejectApiGateRelease: () => rejectRelease,
    },
  );
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage({ text }) {
        sends += 1;
        assert.equal(text, "second");
        return { ok: true, outcome: "sent", messageId: 88 };
      },
    }),
  });

  await assert.rejects(() => engine.reconcile({ messageKey: "first" }), {
    code: "api-gate-release-failed",
  });
  assert.equal(repository.state.get("first").delivery.status, "uncertain");
  assert.equal(
    repository.state.get("first").delivery.apiGateSettleOwner,
    apiGateOwner,
  );
  assert.equal(repository.control.apiGate.owner, apiGateOwner);

  rejectRelease = false;
  assert.equal(
    (await engine.reconcile({ messageKey: "first" })).status,
    "uncertain",
  );
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(
    (await engine.reconcile({ messageKey: "second" })).status,
    "delivered",
  );
  assert.equal(sends, 1);
});

test("respects active leases and persisted retry-after timestamps", async (t) => {
  const desired = sendDesired();
  await t.test("active lease", async () => {
    const repository = createRepository({
      key: {
        desired,
        delivery: {
          status: "processing",
          revision: desired.revision,
          leaseOwner: "another-owner",
          leaseExpiresAtMs: 20_000,
        },
      },
    });
    const result = await createEngine({ repository }).reconcile({
      messageKey: "key",
    });
    assert.equal(result.status, "retryable");
    assert.equal(result.reason, "locked");
  });

  await t.test("retry after", async () => {
    const repository = createRepository({
      key: {
        desired,
        delivery: {
          status: "retryable",
          revision: desired.revision,
          retryAtMs: 20_000,
        },
      },
    });
    const result = await createEngine({ repository }).reconcile({
      messageKey: "key",
    });
    assert.deepEqual(result, {
      status: "retryable",
      reason: "retry-after",
      retryAtMs: 20_000,
      scheduled: true,
    });
  });
});

test("persists Telegram retry-after without marking the send uncertain", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  const result = await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        return {
          ok: false,
          classification: "retryable",
          code: "rate-limited",
          retryAfterSeconds: 8,
        };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.deepEqual(result, {
    status: "retryable",
    retryAtMs: 18_000,
    scheduled: true,
  });
  const delivery = repository.state.get("key").delivery;
  assert.equal(delivery.status, "retryable");
  assert.equal(delivery.retryAtMs, 18_000);
  assert.equal(Object.hasOwn(delivery, "sendInFlight"), false);
});

test("persists the global retry barrier before finalizing a rate limit", async () => {
  const desired = sendDesired();
  const order = [];
  const repository = createRepository(
    { key: { desired } },
    {
      rejectCommit: ({ output }) => {
        if (output?.value?.delivery?.status === "retryable") {
          order.push("finalize");
        }
        return false;
      },
    },
  );
  const extendRetryBarrierAndReleaseApiGate =
    repository.extendRetryBarrierAndReleaseApiGate;
  repository.extendRetryBarrierAndReleaseApiGate = async (proof) => {
    order.push("barrier");
    return extendRetryBarrierAndReleaseApiGate(proof);
  };
  await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        order.push("telegram");
        return {
          ok: false,
          classification: "retryable",
          code: "rate-limited",
          retryAfterSeconds: 8,
        };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.deepEqual(order, ["telegram", "barrier", "finalize"]);
});

test("starts retry-after when the Telegram response is classified", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  let nowMs = 10_000;
  const result = await createEngine({
    repository,
    now: () => nowMs,
    client: createClient({
      async sendTelegramMessage() {
        nowMs = 25_000;
        return {
          ok: false,
          classification: "retryable",
          code: "rate-limited",
          retryAfterSeconds: 8,
        };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.deepEqual(result, {
    status: "retryable",
    retryAtMs: 33_000,
    scheduled: true,
  });
  const delivery = repository.state.get("key").delivery;
  assert.equal(delivery.retryAtMs, 33_000);
  assert.equal(delivery.lastError.atMs, 25_000);
});

test("keeps a full bot-wide retry-after beyond the message retry deadline", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  const scheduled = [];
  let nowMs = 10_000;
  let sends = 0;
  const engine = createEngine({
    repository,
    now: () => nowMs,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return {
          ok: false,
          classification: "retryable",
          code: "rate-limited",
          retryAfterSeconds: 15 * 60,
        };
      },
    }),
  });

  const result = await engine.reconcile({
    messageKey: "key",
    requestedGeneration: "rate-limited-task",
  });
  assert.equal(result.retryAtMs, 610_000);
  assert.equal(repository.control.retryNotBeforeMs, 910_000);
  assert.equal(repository.state.get("key").delivery.retryDeadlineAtMs, 610_000);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].taskKind, "rate-limit-proof");
  assert.equal(scheduled[0].proofTaskKind, "desired");
  assert.equal(scheduled[0].barrierRetryNotBeforeMs, 910_000);
  assert.equal(scheduled[0].scheduleTimeMs, 10_000);

  nowMs = 610_000;
  const exhausted = await engine.reconcile({ messageKey: "key" });
  assert.deepEqual(exhausted, {
    status: "terminal",
    reason: "safe-retry-window-exhausted",
  });
  assert.equal(repository.control.retryNotBeforeMs, 910_000);
  assert.equal(sends, 1);
});

test("duplicate tasks defer until retry-after and resume at the deadline", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  let nowMs = 10_000;
  let sends = 0;
  const engine = createEngine({
    repository,
    now: () => nowMs,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        if (sends === 1) {
          return {
            ok: false,
            classification: "retryable",
            code: "rate-limited",
            retryAfterSeconds: 8,
          };
        }
        return { ok: true, messageId: 5 };
      },
    }),
  });
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "retryable",
  );
  nowMs = 17_999;
  assert.deepEqual(await engine.reconcile({ messageKey: "key" }), {
    status: "retryable",
    reason: "retry-after",
    retryAtMs: 18_000,
    scheduled: true,
  });
  assert.equal(sends, 1);
  nowMs = 18_000;
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "delivered",
  );
  assert.equal(sends, 2);
  assert.equal(repository.state.get("key").delivery.attempts, 2);
});

test("a bot-wide retry barrier blocks other keys and new revisions", async () => {
  const desiredA = sendDesired({
    instanceKey: "message-a",
    text: "A",
    sourceRevision: "A-1",
  });
  const desiredA2 = sendDesired({
    instanceKey: "message-a",
    text: "A2",
    sourceRevision: "A-2",
  });
  const desiredB = sendDesired({
    instanceKey: "message-b",
    text: "B",
    sourceRevision: "B-1",
  });
  const repository = createRepository({
    a: { desired: desiredA },
    b: { desired: desiredB },
  });
  let nowMs = 10_000;
  let sends = 0;
  const engine = createEngine({
    repository,
    now: () => nowMs,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        if (sends === 1) {
          return {
            ok: false,
            classification: "retryable",
            code: "rate-limited",
            retryAfterSeconds: 8,
          };
        }
        return { ok: true, messageId: 20 + sends };
      },
    }),
  });

  assert.equal(
    (await engine.reconcile({ messageKey: "a" })).status,
    "retryable",
  );
  assert.equal(repository.control.retryNotBeforeMs, 18_000);
  nowMs = 17_000;
  assert.deepEqual(await engine.reconcile({ messageKey: "b" }), {
    status: "retryable",
    reason: "global-retry-after",
    retryAtMs: 18_000,
    scheduled: true,
  });
  repository.state.set("a", {
    ...repository.state.get("a"),
    desired: desiredA2,
  });
  assert.deepEqual(await engine.reconcile({ messageKey: "a" }), {
    status: "retryable",
    reason: "global-retry-after",
    retryAtMs: 18_000,
    scheduled: true,
  });
  assert.equal(sends, 1);

  nowMs = 18_000;
  assert.equal(
    (await engine.reconcile({ messageKey: "b" })).status,
    "delivered",
  );
  assert.equal(sends, 2);
});

test("durable retry barrier extension never shortens its deadline", async () => {
  let retryNotBeforeMs = 0;
  const snapshot = () => ({
    exists: () => retryNotBeforeMs > 0,
    val: () => retryNotBeforeMs,
  });
  const database = {
    ref(path) {
      assert.equal(path, "telegramDeliveryControl/retryNotBeforeMs");
      return {
        async once() {
          return snapshot();
        },
        async transaction(updater) {
          retryNotBeforeMs = updater(retryNotBeforeMs);
          return { committed: true, snapshot: snapshot() };
        },
      };
    },
  };
  const repository = createFirebaseTelegramRepository(database);
  assert.equal(await repository.extendRetryNotBeforeMs(50_000), 50_000);
  assert.equal(await repository.extendRetryNotBeforeMs(30_000), 50_000);
  assert.equal(await repository.getRetryNotBeforeMs(), 50_000);
});

test("durable API gate blocks cold workers when barrier persistence fails", async () => {
  const desired = sendDesired();
  const desiredB = sendDesired({
    instanceKey: "message-b",
    text: "B",
    sourceRevision: "B",
  });
  const repository = createRepository(
    { key: { desired }, b: { desired: desiredB } },
    { rejectBarrierWrite: true },
  );
  const resultA = await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        return {
          ok: false,
          classification: "retryable",
          code: "rate-limited",
          retryAfterSeconds: 8,
        };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.equal(resultA.status, "retryable");
  assert.equal(resultA.scheduled, true);
  const delivery = repository.state.get("key").delivery;
  assert.equal(delivery.status, "processing");
  assert.equal(delivery.leaseOwner, "owner-1");
  assert.equal(delivery.sendInFlight.revision, desired.revision);
  assert.equal(delivery.safeRejectionAtMs, undefined);
  assert.equal(repository.control.retryNotBeforeMs, 0);
  assert.equal(repository.localRetryBarrier.getRetryNotBeforeMs(), 18_000);
  assert.equal(repository.control.apiGate.messageKey, "key");

  repository.localRetryBarrier = createTelegramLocalRetryBarrier();

  let bSends = 0;
  const resultB = await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        bSends += 1;
        return { ok: true, messageId: 2 };
      },
    }),
  }).reconcile({ messageKey: "b" });
  assert.equal(resultB.status, "retryable");
  assert.equal(resultB.scheduled, true);
  assert.equal(bSends, 0);
  assert.equal(repository.control.apiGate.messageKey, "key");
});

test("exact rate-limit proof repairs a failed barrier write after a cold start", async () => {
  const desiredA = sendDesired({
    instanceKey: "message-a",
    sourceRevision: "A",
  });
  const desiredB = sendDesired({
    instanceKey: "message-b",
    sourceRevision: "B",
  });
  let rejectBarrierProofWrite = true;
  const repository = createRepository(
    { a: { desired: desiredA }, b: { desired: desiredB } },
    { rejectBarrierProofWrite: () => rejectBarrierProofWrite },
  );
  const scheduled = [];
  const firstEngine = createEngine({
    repository,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async sendTelegramMessage() {
        return {
          ok: false,
          classification: "retryable",
          code: "rate-limited",
          retryAfterSeconds: 15 * 60,
        };
      },
    }),
  });
  const first = await firstEngine.reconcile({
    messageKey: "a",
    requestedGeneration: "task-a",
  });
  assert.equal(first.status, "retryable");
  assert.equal(repository.control.retryNotBeforeMs, 0);
  assert.equal(repository.control.apiGate.messageKey, "a");
  assert.equal(scheduled[0].barrierRetryNotBeforeMs, 910_000);

  repository.localRetryBarrier = createTelegramLocalRetryBarrier();
  let bSends = 0;
  const coldEngine = createEngine({
    repository,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async sendTelegramMessage() {
        bSends += 1;
        return { ok: true, messageId: 2 };
      },
    }),
  });
  assert.equal(
    (await coldEngine.reconcile({ messageKey: "b" })).status,
    "retryable",
  );
  assert.equal(bSends, 0);

  rejectBarrierProofWrite = false;
  repository.localRetryBarrier = createTelegramLocalRetryBarrier();
  const repaired = await reconcileScheduledTask(coldEngine, scheduled[0]);
  assert.equal(repaired.status, "retryable");
  assert.equal(repository.control.retryNotBeforeMs, 910_000);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(repository.state.get("a").delivery.status, "retryable");
  assert.equal(bSends, 0);
});

test("an immediate rate proof cannot leave a late proof-required marker", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  const scheduled = [];
  let engine;
  let ranImmediateProof = false;
  let sends = 0;
  engine = createEngine({
    repository,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      if (task.taskKind === "rate-limit-proof" && !ranImmediateProof) {
        ranImmediateProof = true;
        await reconcileScheduledTask(engine, task);
      }
      return { scheduled: true };
    },
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return {
          ok: false,
          classification: "retryable",
          code: "rate-limited",
          retryAfterSeconds: 8,
        };
      },
    }),
  });

  const result = await engine.reconcile({
    messageKey: "key",
    requestedGeneration: "initial-rate-task",
  });
  assert.equal(result.status, "retryable");
  assert.equal(sends, 1);
  assert.equal(repository.control.retryNotBeforeMs, 18_000);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(
    repository.state.get("key").delivery.apiGateProofRequired,
    undefined,
  );
  assert.equal(repository.state.get("key").delivery.status, "retryable");
});

test("a cold native retry reconstructs a rate proof after enqueue failure", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  let rejectEnqueue = true;
  let nowMs = 10_000;
  let sends = 0;
  const scheduled = [];
  const scheduleRetry = async (task) => {
    if (task.taskKind === "rate-limit-proof" && rejectEnqueue) {
      throw Object.assign(new Error("queue-unavailable"), {
        code: "queue-unavailable",
      });
    }
    scheduled.push(task);
    return { scheduled: true };
  };
  const client = createClient({
    async sendTelegramMessage() {
      sends += 1;
      return {
        ok: false,
        classification: "retryable",
        code: "rate-limited",
        retryAfterSeconds: 8,
      };
    },
  });

  await assert.rejects(
    () =>
      createEngine({
        repository,
        client,
        now: () => nowMs,
        scheduleRetry,
      }).reconcile({ messageKey: "key", requestedGeneration: "initial" }),
    { code: "queue-unavailable" },
  );
  assert.equal(repository.control.retryNotBeforeMs, 0);
  assert.equal(repository.control.apiGate.messageKey, "key");
  assert.equal(
    repository.state.get("key").delivery.apiGateProofRequired.proofTaskKind,
    "desired",
  );

  rejectEnqueue = false;
  nowMs = 71_000;
  repository.localRetryBarrier = createTelegramLocalRetryBarrier();
  const recovered = await createEngine({
    repository,
    client,
    now: () => nowMs,
    scheduleRetry,
  }).reconcile({ messageKey: "key", requestedGeneration: "native-retry" });
  assert.equal(recovered.status, "retryable");
  assert.equal(recovered.reason, "rate-limit-proof-pending");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].taskKind, "rate-limit-proof");
  assert.equal(scheduled[0].safeRejectedAttemptId, "attempt-1");
  assert.equal(repository.control.retryNotBeforeMs, 18_000);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(sends, 1);
});

test("a cold deadline wake cannot bypass an unresolved full rate barrier", async () => {
  const desired = sendDesired();
  let rejectBarrierProofWrite = true;
  let nowMs = 10_000;
  let sends = 0;
  const scheduled = [];
  const repository = createRepository(
    { key: { desired } },
    { rejectBarrierProofWrite: () => rejectBarrierProofWrite },
  );
  const client = createClient({
    async sendTelegramMessage() {
      sends += 1;
      return {
        ok: false,
        classification: "retryable",
        code: "rate-limited",
        retryAfterSeconds: 15 * 60,
      };
    },
  });
  const scheduleRetry = async (task) => {
    scheduled.push(task);
    return { scheduled: true };
  };
  await createEngine({
    repository,
    client,
    now: () => nowMs,
    scheduleRetry,
  }).reconcile({ messageKey: "key", requestedGeneration: "rate-task" });
  const exactProof = scheduled[0];

  nowMs = 610_000;
  repository.localRetryBarrier = createTelegramLocalRetryBarrier();
  const coldEngine = createEngine({
    repository,
    client,
    now: () => nowMs,
    scheduleRetry,
  });
  const blocked = await coldEngine.reconcile({
    messageKey: "key",
    requestedGeneration: "native-after-deadline",
  });
  assert.equal(blocked.status, "retryable");
  assert.equal(blocked.reason, "rate-limit-proof-pending");
  assert.equal(sends, 1);
  assert.equal(repository.control.retryNotBeforeMs, 0);
  assert.equal(repository.control.apiGate.messageKey, "key");
  assert.equal(repository.state.get("key").delivery.status, "processing");

  rejectBarrierProofWrite = false;
  const repaired = await reconcileScheduledTask(coldEngine, exactProof);
  assert.equal(repaired.status, "terminal");
  assert.equal(repaired.reason, "safe-retry-window-exhausted");
  assert.equal(repository.control.retryNotBeforeMs, 910_000);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(sends, 1);
});

test("a pending cleanup rate proof fences a newer desired wake", async () => {
  const desiredA = sendDesired({ text: "A", sourceRevision: "A" });
  const desiredB = editDesired({ text: "B", sourceRevision: "B" });
  let rejectBarrierProofWrite = true;
  let nowMs = 10_000;
  let edits = 0;
  let deletes = 0;
  const scheduled = [];
  const repository = createRepository(
    {
      key: {
        desired: desiredA,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 20,
          instanceKey: desiredA.instanceKey,
          revision: desiredA.revision,
          contentHash: desiredA.contentHash,
        },
        delivery: {
          status: "delivered",
          revision: desiredA.revision,
          pendingDelete: {
            pendingDeleteId: "rate-cleanup",
            chatId: "community-chat",
            messageId: 19,
            status: "pending",
            attempts: 0,
          },
        },
      },
    },
    { rejectBarrierProofWrite: () => rejectBarrierProofWrite },
  );
  const client = createClient({
    async editTelegramMessage() {
      edits += 1;
      return { ok: true, outcome: "edited" };
    },
    async deleteTelegramMessage() {
      deletes += 1;
      return {
        ok: false,
        classification: "retryable",
        code: "rate-limited",
        retryAfterSeconds: 15 * 60,
      };
    },
  });
  const scheduleRetry = async (task) => {
    scheduled.push(task);
    return { scheduled: true };
  };
  await createEngine({
    repository,
    client,
    now: () => nowMs,
    scheduleRetry,
  }).reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId: "rate-cleanup",
    requestedGeneration: "cleanup-rate-task",
  });
  const exactProof = scheduled.find(
    (task) => task.taskKind === "rate-limit-proof",
  );
  assert.ok(exactProof);
  assert.equal(deletes, 1);

  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: desiredB,
  });
  repository.localRetryBarrier = createTelegramLocalRetryBarrier();
  nowMs = 71_000;
  const coldEngine = createEngine({
    repository,
    client,
    now: () => nowMs,
    scheduleRetry,
  });
  const blocked = await coldEngine.reconcile({
    messageKey: "key",
    requestedGeneration: "new-desired-task",
  });
  assert.equal(blocked.status, "retryable");
  assert.equal(blocked.reason, "pending-rate-limit-proof-pending");
  assert.equal(edits, 0);
  assert.equal(repository.control.apiGate.messageKey, "key");

  rejectBarrierProofWrite = false;
  await reconcileScheduledTask(coldEngine, exactProof);
  assert.equal(repository.control.retryNotBeforeMs, 910_000);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(edits, 0);
});

test("durable barrier survives retryable finalization failure", async () => {
  const desiredA = sendDesired();
  const desiredB = sendDesired({
    instanceKey: "message-b",
    text: "B",
    sourceRevision: "B",
  });
  const repository = createRepository(
    { a: { desired: desiredA }, b: { desired: desiredB } },
    {
      rejectCommit: ({ output }) =>
        Number.isFinite(output?.value?.delivery?.safeRejectionAtMs),
    },
  );
  await assert.rejects(
    () =>
      createEngine({
        repository,
        client: createClient({
          async sendTelegramMessage() {
            return {
              ok: false,
              classification: "retryable",
              code: "rate-limited",
              retryAfterSeconds: 8,
            };
          },
        }),
      }).reconcile({ messageKey: "a" }),
    { code: "retryable-finalization-failed" },
  );
  assert.equal(repository.localRetryBarrier.getRetryNotBeforeMs(), 18_000);
  assert.equal(repository.control.retryNotBeforeMs, 18_000);
  repository.localRetryBarrier = createTelegramLocalRetryBarrier();

  let bSends = 0;
  assert.deepEqual(
    await createEngine({
      repository,
      client: createClient({
        async sendTelegramMessage() {
          bSends += 1;
          return { ok: true, messageId: 2 };
        },
      }),
    }).reconcile({ messageKey: "b" }),
    {
      status: "retryable",
      reason: "global-retry-after",
      retryAtMs: 18_000,
      scheduled: true,
    },
  );
  assert.equal(bSends, 0);
});

test("retries when retryable state cannot be persisted", async () => {
  const desired = editDesired();
  const repository = createRepository(
    {
      key: {
        desired,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 3,
          instanceKey: desired.instanceKey,
          contentHash: "old",
        },
      },
    },
    {
      rejectCommit: ({ output }) =>
        output?.value?.delivery?.status === "retryable",
    },
  );
  await assert.rejects(
    () =>
      createEngine({
        repository,
        client: createClient({
          async editTelegramMessage() {
            return {
              ok: false,
              classification: "retryable",
              code: "network-error",
            };
          },
        }),
      }).reconcile({ messageKey: "key" }),
    { code: "retryable-finalization-failed" },
  );
});

test("marks ambiguous sends uncertain and does not call Telegram again", async () => {
  const desired = sendDesired();
  let sends = 0;
  const repository = createRepository({ key: { desired } });
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return {
          ok: false,
          classification: "uncertain",
          code: "timeout",
        };
      },
    }),
  });
  const first = await engine.reconcile({ messageKey: "key" });
  const second = await engine.reconcile({ messageKey: "key" });
  assert.equal(first.status, "uncertain");
  assert.equal(second.status, "uncertain");
  assert.equal(sends, 1);
});

test("uncertain waiting send blocks a fresh matched instance", async () => {
  const waiting = sendDesired();
  const matched = sendDesired({
    instanceKey: "matched:invite-1",
    text: "Alice vs Bob",
    sourceRevision: "matched",
  });
  let sends = 0;
  const repository = createRepository({ key: { desired: waiting } });
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        if (sends === 1) {
          return {
            ok: false,
            classification: "uncertain",
            code: "timeout",
          };
        }
        return { ok: true, messageId: 2 };
      },
    }),
  });
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "uncertain",
  );
  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: matched,
  });
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "uncertain",
  );
  assert.equal(sends, 1);
  const state = repository.state.get("key");
  assert.equal(state.applied, undefined);
  assert.equal(state.delivery.sendInFlight.instanceKey, "waiting:invite-1");
  assert.equal(state.delivery.revision, matched.revision);
});

test("same-instance desired changes remain blocked after an uncertain send", async () => {
  const waiting = sendDesired();
  const changedWaiting = sendDesired({
    text: "still looking",
    sourceRevision: "waiting-updated",
  });
  let sends = 0;
  const repository = createRepository({ key: { desired: waiting } });
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return {
          ok: false,
          classification: "uncertain",
          code: "timeout",
        };
      },
    }),
  });
  await engine.reconcile({ messageKey: "key" });
  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: changedWaiting,
  });
  const result = await engine.reconcile({ messageKey: "key" });
  assert.deepEqual(result, {
    status: "uncertain",
    reason: "abandoned-send-in-flight",
  });
  assert.equal(sends, 1);
  const delivery = repository.state.get("key").delivery;
  assert.equal(delivery.revision, changedWaiting.revision);
  assert.equal(delivery.sendInFlight.instanceKey, "waiting:invite-1");
  assert.equal(delivery.unmanagedSend, undefined);
});

test("uncertain replacement send blocks deleting a known applied message", async () => {
  const matched = sendDesired({
    instanceKey: "matched:invite-1",
    text: "Alice vs Bob",
    sourceRevision: "matched",
  });
  const deletion = buildTelegramDeleteDesired({
    destination: "community",
    sourceRevision: "delete",
  });
  const repository = createRepository({
    key: {
      desired: matched,
      applied: {
        destination: "community",
        chatId: "community-chat",
        messageId: 1,
        instanceKey: "waiting:invite-1",
        revision: "waiting",
        contentHash: "waiting",
      },
    },
  });
  let deletes = 0;
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        return {
          ok: false,
          classification: "uncertain",
          code: "timeout",
        };
      },
      async deleteTelegramMessage({ messageId }) {
        deletes += 1;
        assert.equal(messageId, 1);
        return { ok: true, outcome: "deleted" };
      },
    }),
  });
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "uncertain",
  );
  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: deletion,
  });
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "uncertain",
  );
  assert.equal(deletes, 0);
  const state = repository.state.get("key");
  assert.equal(state.applied.messageId, 1);
  assert.equal(state.delivery.sendInFlight.instanceKey, "matched:invite-1");
});

test("lets Telegram classify raw HTML longer than 4096 characters", async () => {
  let sends = 0;
  const text = `<b>${"x".repeat(4090)}</b>`;
  const desired = sendDesired({ text });
  const repository = createRepository({ key: { desired } });
  const result = await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage(input) {
        sends += 1;
        assert.equal(input.text, text);
        return { ok: true, outcome: "sent", messageId: 1 };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.equal(text.length > 4096, true);
  assert.equal(result.status, "delivered");
  assert.equal(sends, 1);
});

test("persists Telegram's terminal oversized-text rejection", async () => {
  const desired = sendDesired({ text: "x".repeat(4097) });
  const repository = createRepository({ key: { desired } });
  const result = await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        return {
          ok: false,
          classification: "terminal",
          code: "telegram-400",
          description: "message is too long",
          httpStatus: 400,
        };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.equal(result.status, "terminal");
  assert.equal(result.reason, "telegram-400");
  assert.equal(repository.state.get("key").delivery.status, "terminal");
});

test("replaces a changed instance before independently deleting the old message", async () => {
  const desired = sendDesired({
    instanceKey: "matched:invite-1",
    text: "Alice vs Bob",
    sourceRevision: "matched",
  });
  const oldApplied = {
    destination: "community",
    chatId: "community-chat",
    messageId: 10,
    instanceKey: "waiting:invite-1",
    revision: "old",
    contentHash: "old",
  };
  const repository = createRepository({
    key: { desired, applied: oldApplied },
  });
  const order = [];
  const client = createClient({
    async sendTelegramMessage() {
      order.push("send");
      assert.equal(
        repository.state.get("key").delivery.sendInFlight.revision,
        desired.revision,
      );
      return { ok: true, messageId: 20 };
    },
    async deleteTelegramMessage({ messageId }) {
      order.push("delete");
      assert.equal(messageId, 10);
      assert.equal(repository.state.get("key").applied.messageId, 20);
      return { ok: true, outcome: "deleted" };
    },
  });
  const scheduled = [];
  const engine = createEngine({
    repository,
    client,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
  });
  const result = await engine.reconcile({
    messageKey: "key",
  });
  assert.equal(result.status, "delivered");
  assert.equal(result.cleanupScheduled, true);
  assert.deepEqual(order, ["send"]);
  let state = repository.state.get("key");
  assert.equal(state.applied.messageId, 20);
  assert.equal(state.delivery.status, "delivered");
  assert.equal(state.delivery.pendingDelete.messageId, 10);
  assert.equal(scheduled.at(-1).taskKind, "pending-delete");

  await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId: state.delivery.pendingDelete.pendingDeleteId,
  });
  assert.deepEqual(order, ["send", "delete"]);
  state = repository.state.get("key");
  assert.equal(state.delivery.pendingDelete, undefined);
  assert.equal(state.delivery.status, "delivered");
});

test("does not delete the prior post when a send receipt cannot be persisted", async () => {
  const desired = sendDesired({ instanceKey: "matched" });
  const repository = createRepository(
    {
      key: {
        desired,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 10,
          instanceKey: "waiting",
          revision: "old",
          contentHash: "old",
        },
      },
    },
    {
      rejectCommit: ({ output }) => output?.value?.applied?.messageId === 20,
    },
  );
  let deletes = 0;
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        return { ok: true, messageId: 20 };
      },
      async deleteTelegramMessage() {
        deletes += 1;
        return { ok: true };
      },
    }),
  });
  await assert.rejects(() => engine.reconcile({ messageKey: "key" }), {
    code: "send-receipt-not-persisted",
  });
  assert.equal(deletes, 0);
  const state = repository.state.get("key");
  assert.equal(state.applied.messageId, 10);
  assert.equal(state.delivery.sendInFlight.revision, desired.revision);
});

test("retries replacement cleanup when its success cannot be persisted", async () => {
  const desired = sendDesired({ instanceKey: "matched" });
  const repository = createRepository(
    {
      key: {
        desired,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 10,
          instanceKey: "waiting",
          revision: "old",
          contentHash: "old",
        },
      },
    },
    {
      rejectCommit: ({ current, output }) =>
        current?.delivery?.pendingDelete &&
        !output?.value?.delivery?.pendingDelete,
    },
  );
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        return { ok: true, messageId: 20 };
      },
      async deleteTelegramMessage() {
        return { ok: true, outcome: "deleted" };
      },
    }),
  });
  await engine.reconcile({ messageKey: "key" });
  const pendingDeleteId =
    repository.state.get("key").delivery.pendingDelete.pendingDeleteId;
  await assert.rejects(
    () =>
      engine.reconcile({
        messageKey: "key",
        taskKind: "pending-delete",
        pendingDeleteId,
      }),
    { code: "pending-delete-finalization-failed" },
  );
  assert.equal(
    repository.state.get("key").delivery.pendingDelete.messageId,
    10,
  );
});

test("terminal replacement cleanup settles once and does not block newer desired state", async () => {
  const desired = sendDesired({
    instanceKey: "matched",
    text: "matched",
    sourceRevision: "matched",
  });
  const repository = createRepository({
    key: {
      desired,
      applied: {
        destination: "community",
        chatId: "community-chat",
        messageId: 10,
        instanceKey: "waiting",
        revision: "old",
        contentHash: "old",
      },
    },
  });
  let sends = 0;
  let deletes = 0;
  let edits = 0;
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return { ok: true, messageId: 20 };
      },
      async deleteTelegramMessage() {
        deletes += 1;
        return {
          ok: false,
          classification: "terminal",
          code: "telegram-403",
        };
      },
      async editTelegramMessage() {
        edits += 1;
        return { ok: true, outcome: "edited" };
      },
    }),
  });
  const delivered = await engine.reconcile({ messageKey: "key" });
  assert.equal(delivered.status, "delivered");
  const pendingDeleteId =
    repository.state.get("key").delivery.pendingDelete.pendingDeleteId;
  const terminalCleanup = await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId,
  });
  assert.equal(terminalCleanup.status, "settled");
  assert.equal(terminalCleanup.cleanup.cleanup, "orphaned");
  assert.equal(repository.state.get("key").delivery.status, "delivered");
  assert.equal(repository.state.get("key").delivery.pendingDelete, undefined);
  assert.equal(
    Object.values(repository.state.get("key").delivery.orphanedDeletes)[0]
      .lastError.code,
    "telegram-403",
  );
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "settled",
  );
  assert.equal(deletes, 1);

  const latest = editDesired({
    instanceKey: "matched",
    text: "result",
    sourceRevision: "result",
    ifMissing: "send",
  });
  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: latest,
  });
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "delivered",
  );
  assert.equal(sends, 1);
  assert.equal(edits, 1);
});

test("edits an existing instance and treats not-modified as success", async () => {
  const desired = editDesired();
  const repository = createRepository({
    key: {
      desired,
      applied: {
        destination: "community",
        chatId: "community-chat",
        messageId: 3,
        instanceKey: desired.instanceKey,
        revision: "before",
        contentHash: "before",
      },
    },
  });
  let editRequest;
  const result = await createEngine({
    repository,
    client: createClient({
      async editTelegramMessage(value) {
        editRequest = value;
        return { ok: true, outcome: "not-modified" };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.equal(result.status, "delivered");
  assert.equal(editRequest.messageId, 3);
  assert.equal(
    repository.state.get("key").applied.contentHash,
    desired.contentHash,
  );
});

test("handles missing edit targets according to ifMissing", async (t) => {
  const applied = {
    destination: "community",
    chatId: "community-chat",
    messageId: 3,
    instanceKey: "waiting:invite-1",
    revision: "before",
    contentHash: "before",
  };
  await t.test("skip", async () => {
    const desired = editDesired({ ifMissing: "skip" });
    const repository = createRepository({ key: { desired, applied } });
    let sends = 0;
    const result = await createEngine({
      repository,
      client: createClient({
        async editTelegramMessage() {
          return {
            ok: false,
            classification: "missing",
            code: "message-not-found",
          };
        },
        async sendTelegramMessage() {
          sends += 1;
          return { ok: true, messageId: 5 };
        },
      }),
    }).reconcile({ messageKey: "key" });
    assert.equal(result.reason, "missing-skipped");
    assert.equal(sends, 0);
    assert.equal(repository.state.get("key").applied, undefined);
  });

  await t.test("send", async () => {
    const desired = editDesired({ ifMissing: "send" });
    const repository = createRepository({ key: { desired, applied } });
    let sends = 0;
    const result = await createEngine({
      repository,
      client: createClient({
        async editTelegramMessage() {
          return {
            ok: false,
            classification: "missing",
            code: "message-not-found",
          };
        },
        async sendTelegramMessage() {
          sends += 1;
          return { ok: true, messageId: 5 };
        },
      }),
    }).reconcile({ messageKey: "key" });
    assert.equal(result.status, "delivered");
    assert.equal(sends, 1);
    assert.equal(repository.state.get("key").applied.messageId, 5);
  });
});

test("stale cancellation preserves a different matched message", async () => {
  const desired = editDesired({
    instanceKey: "waiting:invite-1",
    text: "Alice canceled an automatch",
    ifMissing: "skip",
    sourceRevision: "canceled",
  });
  const matchedApplied = {
    destination: "community",
    chatId: "community-chat",
    messageId: 9,
    instanceKey: "matched:invite-1",
    revision: "matched",
    contentHash: "matched-content",
  };
  const repository = createRepository({
    key: { desired, applied: matchedApplied },
  });
  let sends = 0;
  let edits = 0;
  let deletes = 0;
  const result = await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return { ok: true, messageId: 10 };
      },
      async editTelegramMessage() {
        edits += 1;
        return { ok: true };
      },
      async deleteTelegramMessage() {
        deletes += 1;
        return { ok: true };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.deepEqual(result, {
    status: "delivered",
    reason: "missing-skipped",
  });
  assert.deepEqual(repository.state.get("key").applied, matchedApplied);
  assert.equal(repository.state.get("key").delivery.status, "delivered");
  assert.deepEqual(
    { sends, edits, deletes },
    { sends: 0, edits: 0, deletes: 0 },
  );
});

test("retries transient edits and deletes idempotently", async (t) => {
  await t.test("edit", async () => {
    const desired = editDesired();
    const repository = createRepository({
      key: {
        desired,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 3,
          instanceKey: desired.instanceKey,
          contentHash: "old",
        },
      },
    });
    const result = await createEngine({
      repository,
      client: createClient({
        async editTelegramMessage() {
          return {
            ok: false,
            classification: "retryable",
            code: "network-error",
          };
        },
      }),
    }).reconcile({ messageKey: "key" });
    assert.equal(result.status, "retryable");
    assert.equal(repository.state.get("key").delivery.status, "retryable");
  });

  await t.test("delete", async () => {
    const desired = buildTelegramDeleteDesired({
      destination: "community",
      sourceRevision: "delete",
    });
    const repository = createRepository({
      key: {
        desired,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 3,
          instanceKey: "waiting",
        },
      },
    });
    const result = await createEngine({
      repository,
      client: createClient({
        async deleteTelegramMessage() {
          return {
            ok: false,
            classification: "retryable",
            code: "network-error",
          };
        },
      }),
    }).reconcile({ messageKey: "key" });
    assert.equal(result.status, "retryable");
    assert.equal(repository.state.get("key").applied.messageId, 3);
  });
});

test("does not report acknowledged edit/delete as delivered after lease loss", async (t) => {
  await t.test("edit", async () => {
    const desired = editDesired();
    const repository = createRepository(
      {
        key: {
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 3,
            instanceKey: desired.instanceKey,
            contentHash: "old",
          },
        },
      },
      {
        rejectCommit: ({ output }) =>
          output?.value?.applied?.contentHash === desired.contentHash,
      },
    );
    await assert.rejects(
      () => createEngine({ repository }).reconcile({ messageKey: "key" }),
      { code: "delivered-finalization-failed" },
    );
  });

  await t.test("delete", async () => {
    const desired = buildTelegramDeleteDesired({
      destination: "community",
      sourceRevision: "delete",
    });
    const repository = createRepository(
      {
        key: {
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 3,
            instanceKey: "waiting",
          },
        },
      },
      {
        rejectCommit: ({ current, output }) =>
          current?.applied && !output?.value?.applied,
      },
    );
    await assert.rejects(
      () => createEngine({ repository }).reconcile({ messageKey: "key" }),
      { code: "delivered-finalization-failed" },
    );
  });
});

test("safe send rejection schedules proof without reading the record again", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  repository.getMessage = async () => {
    throw new Error("unexpected record read");
  };
  const scheduled = [];
  const result = await createEngine({
    repository,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async sendTelegramMessage() {
        return {
          ok: false,
          classification: "retryable",
          code: "network-error",
        };
      },
    }),
  }).reconcile({ messageKey: "key" });

  assert.equal(result.status, "retryable");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].safeRejectedAttemptId, "attempt-1");
  assert.equal(scheduled[0].retryProofLeaseOwner, undefined);
  assert.equal(scheduled[0].retryStartedAtMs, 10_000);
  assert.equal(scheduled[0].retryDeadlineAtMs, 610_000);
  assert.equal(scheduled[0].retryAtMs, 11_000);
  assert.equal(repository.state.get("key").delivery.sendInFlight, undefined);
});

test("send outcomes become durable before their API gate is released", async (t) => {
  await t.test(
    "persisted success settles cold without a duplicate send",
    async () => {
      const desired = sendDesired();
      let rejectRelease = true;
      let sends = 0;
      const repository = createRepository(
        { key: { desired } },
        { rejectApiGateRelease: () => rejectRelease },
      );
      const client = createClient({
        async sendTelegramMessage() {
          sends += 1;
          return { ok: true, outcome: "sent", messageId: 71 };
        },
      });
      await assert.rejects(
        () =>
          createEngine({ repository, client }).reconcile({ messageKey: "key" }),
        { code: "api-gate-release-failed" },
      );
      const persisted = repository.state.get("key");
      assert.equal(persisted.applied.messageId, 71);
      assert.equal(persisted.delivery.status, "delivered");
      assert.equal(persisted.delivery.sendInFlight, undefined);
      assert.equal(
        persisted.delivery.apiGateSettleOwner,
        repository.control.apiGate.owner,
      );

      rejectRelease = false;
      const recovered = await createEngine({ repository, client }).reconcile({
        messageKey: "key",
      });
      assert.equal(recovered.status, "settled");
      assert.equal(sends, 1);
      assert.equal(repository.control.apiGate, undefined);
      assert.equal(
        repository.state.get("key").delivery.apiGateSettleOwner,
        undefined,
      );
    },
  );

  await t.test(
    "receipt failure retains ambiguity and never resends",
    async () => {
      const desired = sendDesired();
      let rejectReceipt = true;
      let sends = 0;
      let nowMs = 10_000;
      const repository = createRepository(
        { key: { desired } },
        {
          rejectCommit: ({ output }) =>
            rejectReceipt &&
            output?.value?.applied?.messageId === 72 &&
            output?.value?.delivery?.apiGateSettleOwner,
        },
      );
      const client = createClient({
        async sendTelegramMessage() {
          sends += 1;
          return { ok: true, outcome: "sent", messageId: 72 };
        },
      });
      await assert.rejects(
        () =>
          createEngine({ repository, client, now: () => nowMs }).reconcile({
            messageKey: "key",
          }),
        { code: "send-receipt-not-persisted" },
      );
      assert.equal(repository.state.get("key").applied, undefined);
      assert.equal(
        repository.state.get("key").delivery.sendInFlight.attemptId,
        "attempt-1",
      );
      assert.equal(repository.control.apiGate.messageKey, "key");

      rejectReceipt = false;
      nowMs = 71_000;
      const recovered = await createEngine({
        repository,
        client,
        now: () => nowMs,
      }).reconcile({ messageKey: "key" });
      assert.equal(recovered.status, "uncertain");
      assert.equal(sends, 1);
      assert.equal(repository.control.apiGate, undefined);
      assert.equal(
        repository.state.get("key").delivery.apiGateSettleOwner,
        undefined,
      );
    },
  );

  await t.test("deadline finalization survives a release failure", async () => {
    const desired = sendDesired();
    let rejectRelease = true;
    let nowMs = 9_999;
    let sends = 0;
    const repository = createRepository(
      {
        key: {
          desired,
          delivery: {
            status: "retryable",
            revision: desired.revision,
            attempts: 1,
            retryStartedAtMs: 1,
            retryDeadlineAtMs: 10_000,
            retryAtMs: 9_000,
            retrySequence: 1,
          },
        },
      },
      { rejectApiGateRelease: () => rejectRelease },
    );
    const acquireApiGate = repository.acquireApiGate;
    repository.acquireApiGate = async (input) => {
      const result = await acquireApiGate(input);
      nowMs = 10_000;
      return result;
    };
    const client = createClient({
      async sendTelegramMessage() {
        sends += 1;
        return { ok: true, messageId: 73 };
      },
    });
    await assert.rejects(
      () =>
        createEngine({ repository, client, now: () => nowMs }).reconcile({
          messageKey: "key",
        }),
      { code: "api-gate-release-failed" },
    );
    const terminal = repository.state.get("key").delivery;
    assert.equal(terminal.status, "terminal");
    assert.equal(terminal.sendInFlight, undefined);
    assert.equal(terminal.lastError.code, "safe-retry-window-exhausted");
    assert.equal(terminal.apiGateSettleOwner, repository.control.apiGate.owner);
    assert.equal(sends, 0);

    rejectRelease = false;
    const recovered = await createEngine({
      repository,
      client,
      now: () => nowMs,
    }).reconcile({ messageKey: "key" });
    assert.equal(recovered.status, "settled");
    assert.equal(repository.control.apiGate, undefined);
    assert.equal(sends, 0);
  });
});

test("acknowledged idempotent outcomes settle without repeating the API", async (t) => {
  for (const operation of ["edit", "delete"]) {
    await t.test(operation, async () => {
      const desired =
        operation === "edit"
          ? editDesired({ sourceRevision: "crash-edit" })
          : buildTelegramDeleteDesired({
              destination: "community",
              sourceRevision: "crash-delete",
            });
      let rejectRelease = true;
      let calls = 0;
      let nowMs = 10_000;
      const repository = createRepository(
        {
          key: {
            desired,
            applied: {
              destination: "community",
              chatId: "community-chat",
              messageId: 9,
              instanceKey: desired.instanceKey || "waiting:invite-1",
              contentHash: "old",
            },
          },
        },
        { rejectApiGateRelease: () => rejectRelease },
      );
      const client = createClient({
        async editTelegramMessage() {
          calls += 1;
          return { ok: true, outcome: "edited" };
        },
        async deleteTelegramMessage() {
          calls += 1;
          return { ok: true, outcome: "deleted" };
        },
      });
      await assert.rejects(
        () =>
          createEngine({
            repository,
            client,
            now: () => nowMs,
            createOwnerToken: () => "worker-before-crash",
          }).reconcile({
            messageKey: "key",
            requestedGeneration: `${operation}-lifecycle`,
          }),
        { code: "api-gate-release-failed" },
      );
      const crashedDelivery = repository.state.get("key").delivery;
      assert.equal(crashedDelivery.status, "delivered");
      assert.equal(
        crashedDelivery.apiGateSettleOwner,
        repository.control.apiGate.owner,
      );

      rejectRelease = false;
      nowMs = 71_000;
      const recovered = await createEngine({
        repository,
        client,
        now: () => nowMs,
        createOwnerToken: () => "worker-after-crash",
      }).reconcile({
        messageKey: "key",
        requestedGeneration: `${operation}-lifecycle`,
      });
      assert.equal(recovered.status, "settled");
      assert.equal(calls, 1);
      assert.equal(repository.control.apiGate, undefined);
      assert.equal(
        repository.state.get("key").delivery.apiGateSettleOwner,
        undefined,
      );
    });
  }

  await t.test("pending delete", async () => {
    const desired = sendDesired();
    let rejectRelease = true;
    let calls = 0;
    let nowMs = 10_000;
    const repository = createRepository(
      {
        key: {
          desired,
          delivery: {
            status: "delivered",
            revision: desired.revision,
            pendingDelete: {
              pendingDeleteId: "cleanup-crash",
              chatId: "community-chat",
              messageId: 7,
              status: "pending",
              attempts: 0,
            },
          },
        },
      },
      { rejectApiGateRelease: () => rejectRelease },
    );
    const client = createClient({
      async deleteTelegramMessage() {
        calls += 1;
        return { ok: true, outcome: "deleted" };
      },
    });
    await assert.rejects(
      () =>
        createEngine({
          repository,
          client,
          now: () => nowMs,
          createOwnerToken: () => "cleanup-before-crash",
        }).reconcile({
          messageKey: "key",
          taskKind: "pending-delete",
          pendingDeleteId: "cleanup-crash",
          requestedGeneration: "cleanup-lifecycle",
        }),
      { code: "api-gate-release-failed" },
    );
    const crashedDelivery = repository.state.get("key").delivery;
    assert.equal(crashedDelivery.pendingDelete, undefined);
    assert.equal(
      crashedDelivery.pendingDeleteApiGateSettleOwner,
      repository.control.apiGate.owner,
    );

    rejectRelease = false;
    nowMs = 71_000;
    const recovered = await createEngine({
      repository,
      client,
      now: () => nowMs,
      createOwnerToken: () => "cleanup-after-crash",
    }).reconcile({
      messageKey: "key",
      taskKind: "pending-delete",
      pendingDeleteId: "cleanup-crash",
      requestedGeneration: "cleanup-lifecycle",
    });
    assert.equal(recovered.status, "settled");
    assert.equal(calls, 1);
    assert.equal(repository.control.apiGate, undefined);
    assert.equal(repository.state.get("key").delivery.pendingDelete, undefined);
  });
});

test("exact retry proofs settle gates left by retryable responses", async (t) => {
  await t.test("safe send", async () => {
    const desired = sendDesired();
    let rejectRelease = true;
    let nowMs = 10_000;
    let sends = 0;
    const scheduled = [];
    const repository = createRepository(
      { key: { desired } },
      { rejectApiGateRelease: () => rejectRelease },
    );
    const engine = createEngine({
      repository,
      now: () => nowMs,
      scheduleRetry: async (task) => {
        scheduled.push(task);
        return { scheduled: true };
      },
      client: createClient({
        async sendTelegramMessage() {
          sends += 1;
          return sends === 1
            ? {
                ok: false,
                classification: "retryable",
                code: "network-error",
              }
            : { ok: true, outcome: "sent", messageId: 81 };
        },
      }),
    });
    await assert.rejects(() => engine.reconcile({ messageKey: "key" }), {
      code: "api-gate-release-failed",
    });
    const strandedOwner = repository.control.apiGate.owner;
    assert.equal(scheduled[0].apiGateSettleOwner, strandedOwner);

    rejectRelease = false;
    nowMs = 11_000;
    repository.localRetryBarrier = createTelegramLocalRetryBarrier();
    const recovered = await reconcileScheduledTask(engine, scheduled[0]);
    assert.equal(recovered.status, "delivered");
    assert.equal(sends, 2);
    assert.equal(repository.control.apiGate, undefined);
    assert.equal(repository.state.get("key").applied.messageId, 81);
  });

  await t.test("desired edit", async () => {
    const desired = editDesired();
    let rejectRelease = true;
    let nowMs = 10_000;
    let edits = 0;
    const scheduled = [];
    const repository = createRepository(
      {
        key: {
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 9,
            instanceKey: desired.instanceKey,
            contentHash: "old",
          },
        },
      },
      { rejectApiGateRelease: () => rejectRelease },
    );
    const engine = createEngine({
      repository,
      now: () => nowMs,
      scheduleRetry: async (task) => {
        scheduled.push(task);
        return { scheduled: true };
      },
      client: createClient({
        async editTelegramMessage() {
          edits += 1;
          return edits === 1
            ? {
                ok: false,
                classification: "retryable",
                code: "network-error",
              }
            : { ok: true, outcome: "edited" };
        },
      }),
    });
    await assert.rejects(() => engine.reconcile({ messageKey: "key" }), {
      code: "api-gate-release-failed",
    });
    assert.equal(
      scheduled[0].apiGateSettleOwner,
      repository.control.apiGate.owner,
    );

    rejectRelease = false;
    nowMs = 11_000;
    const recovered = await reconcileScheduledTask(engine, scheduled[0]);
    assert.equal(recovered.status, "delivered");
    assert.equal(edits, 2);
    assert.equal(repository.control.apiGate, undefined);
  });

  await t.test("pending cleanup", async () => {
    const desired = sendDesired();
    let rejectRelease = true;
    let nowMs = 10_000;
    let deletes = 0;
    const scheduled = [];
    const repository = createRepository(
      {
        key: {
          desired,
          delivery: {
            status: "delivered",
            revision: desired.revision,
            pendingDelete: {
              pendingDeleteId: "proof-cleanup",
              chatId: "community-chat",
              messageId: 8,
              status: "pending",
              attempts: 0,
            },
          },
        },
      },
      { rejectApiGateRelease: () => rejectRelease },
    );
    const engine = createEngine({
      repository,
      now: () => nowMs,
      scheduleRetry: async (task) => {
        scheduled.push(task);
        return { scheduled: true };
      },
      client: createClient({
        async deleteTelegramMessage() {
          deletes += 1;
          return deletes === 1
            ? {
                ok: false,
                classification: "retryable",
                code: "network-error",
              }
            : { ok: true, outcome: "deleted" };
        },
      }),
    });
    await assert.rejects(
      () =>
        engine.reconcile({
          messageKey: "key",
          taskKind: "pending-delete",
          pendingDeleteId: "proof-cleanup",
        }),
      { code: "api-gate-release-failed" },
    );
    assert.equal(
      scheduled[0].apiGateSettleOwner,
      repository.control.apiGate.owner,
    );

    rejectRelease = false;
    nowMs = 11_000;
    const recovered = await reconcileScheduledTask(engine, scheduled[0]);
    assert.equal(recovered.cleanup.cleanup, "deleted");
    assert.equal(deletes, 2);
    assert.equal(repository.control.apiGate, undefined);
  });
});

test("a new desired revision durably settles a hard-crashed idempotent gate", async () => {
  const desiredA = editDesired({ text: "A", sourceRevision: "A" });
  const desiredB = editDesired({ text: "B", sourceRevision: "B" });
  let rejectRelease = false;
  let nowMs = 10_000;
  const edits = [];
  const repository = createRepository(
    {
      key: {
        desired: desiredA,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 3,
          instanceKey: desiredA.instanceKey,
          contentHash: desiredB.contentHash,
        },
      },
    },
    { rejectApiGateRelease: () => rejectRelease },
  );
  const crashingEngine = createEngine({
    repository,
    now: () => nowMs,
    createOwnerToken: () => "A-worker",
    client: createClient({
      async editTelegramMessage({ text }) {
        edits.push(text);
        throw Object.assign(new Error("worker-died"), {
          code: "worker-died",
        });
      },
    }),
  });
  await assert.rejects(
    () =>
      crashingEngine.reconcile({
        messageKey: "key",
        requestedGeneration: "A-task",
      }),
    { code: "worker-died" },
  );
  const gateAOwner = repository.control.apiGate.owner;
  assert.equal(
    repository.state.get("key").delivery.appliedStateUnknown.operation,
    "edit",
  );

  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: desiredB,
  });
  nowMs = 71_000;
  rejectRelease = true;
  let bCalls = 0;
  const latestEngine = createEngine({
    repository,
    now: () => nowMs,
    createOwnerToken: () => "B-worker",
    client: createClient({
      async editTelegramMessage({ text }) {
        bCalls += 1;
        edits.push(text);
        return { ok: true, outcome: "edited" };
      },
    }),
  });
  await assert.rejects(
    () =>
      latestEngine.reconcile({
        messageKey: "key",
        requestedGeneration: "B-task",
      }),
    { code: "api-gate-release-failed" },
  );
  assert.equal(bCalls, 0);
  assert.equal(repository.control.apiGate.owner, gateAOwner);
  assert.equal(
    repository.state.get("key").delivery.apiGateSettleOwner,
    gateAOwner,
  );

  rejectRelease = false;
  const recovered = await latestEngine.reconcile({
    messageKey: "key",
    requestedGeneration: "B-task",
  });
  assert.equal(recovered.status, "delivered");
  assert.equal(bCalls, 1);
  assert.deepEqual(edits, ["A", "B"]);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(
    repository.state.get("key").delivery.apiGateSettleOwner,
    undefined,
  );
  assert.equal(
    repository.state.get("key").applied.contentHash,
    desiredB.contentHash,
  );
  assert.equal(
    repository.state.get("key").delivery.appliedStateUnknown,
    undefined,
  );
});

test("an applied-state fence must persist before an edit call", async () => {
  const desired = editDesired();
  let edits = 0;
  const repository = createRepository(
    {
      key: {
        desired,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 3,
          instanceKey: desired.instanceKey,
          contentHash: "old",
        },
      },
    },
    {
      rejectCommit: ({ current, output }) =>
        !current?.delivery?.appliedStateUnknown &&
        Boolean(output?.value?.delivery?.appliedStateUnknown),
    },
  );
  await assert.rejects(
    () =>
      createEngine({
        repository,
        client: createClient({
          async editTelegramMessage() {
            edits += 1;
            return { ok: true, outcome: "edited" };
          },
        }),
      }).reconcile({ messageKey: "key" }),
    { code: "applied-state-unknown-not-persisted" },
  );
  assert.equal(edits, 0);
});

test("a crashed delete cannot make restored content look already delivered", async () => {
  const deletion = buildTelegramDeleteDesired({
    destination: "community",
    sourceRevision: "delete",
  });
  const restored = sendDesired({
    text: "restored",
    sourceRevision: "restored",
  });
  let nowMs = 10_000;
  const calls = [];
  const repository = createRepository({
    key: {
      desired: deletion,
      applied: {
        destination: "community",
        chatId: "community-chat",
        messageId: 3,
        instanceKey: restored.instanceKey,
        contentHash: restored.contentHash,
      },
    },
  });
  await assert.rejects(
    () =>
      createEngine({
        repository,
        now: () => nowMs,
        createOwnerToken: () => "delete-worker",
        client: createClient({
          async deleteTelegramMessage() {
            calls.push("delete");
            throw Object.assign(new Error("worker-died"), {
              code: "worker-died",
            });
          },
        }),
      }).reconcile({
        messageKey: "key",
        requestedGeneration: "delete-task",
      }),
    { code: "worker-died" },
  );
  assert.equal(
    repository.state.get("key").delivery.appliedStateUnknown.operation,
    "delete",
  );

  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: restored,
  });
  nowMs = 71_000;
  const recovered = await createEngine({
    repository,
    now: () => nowMs,
    createOwnerToken: () => "restore-worker",
    client: createClient({
      async editTelegramMessage() {
        calls.push("edit-missing");
        return { ok: false, classification: "missing", code: "not-found" };
      },
      async sendTelegramMessage() {
        calls.push("send");
        return { ok: true, outcome: "sent", messageId: 4 };
      },
    }),
  }).reconcile({
    messageKey: "key",
    requestedGeneration: "restore-task",
  });
  assert.equal(recovered.status, "delivered");
  assert.deepEqual(calls, ["delete", "edit-missing", "send"]);
  assert.equal(repository.state.get("key").applied.messageId, 4);
  assert.equal(
    repository.state.get("key").delivery.appliedStateUnknown,
    undefined,
  );
});

test("a new cleanup wake-up reclaims the current hard-crashed cleanup gate", async () => {
  const desired = sendDesired();
  let nowMs = 10_000;
  let deletes = 0;
  const scheduled = [];
  const repository = createRepository({
    key: {
      desired,
      delivery: {
        status: "delivered",
        revision: desired.revision,
        pendingDelete: {
          pendingDeleteId: "cleanup-hard-crash",
          chatId: "community-chat",
          messageId: 7,
          status: "pending",
          attempts: 0,
        },
      },
    },
  });
  const engine = createEngine({
    repository,
    now: () => nowMs,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async deleteTelegramMessage() {
        deletes += 1;
        if (deletes === 1) {
          throw Object.assign(new Error("worker-died"), {
            code: "worker-died",
          });
        }
        return { ok: true, outcome: "deleted" };
      },
    }),
  });
  await assert.rejects(
    () =>
      engine.reconcile({
        messageKey: "key",
        taskKind: "pending-delete",
        pendingDeleteId: "cleanup-hard-crash",
        requestedGeneration: "cleanup-original",
      }),
    { code: "worker-died" },
  );
  const crashedOwner = repository.control.apiGate.owner;

  nowMs = 71_000;
  const wakeup = await engine.reconcile({
    messageKey: "key",
    requestedGeneration: "different-desired-wakeup",
  });
  assert.equal(wakeup.cleanupScheduled, true);
  const cleanupTask = scheduled.at(-1);
  assert.equal(cleanupTask.taskKind, "pending-delete");
  assert.notEqual(cleanupTask.generation, "cleanup-original");

  const recovered = await reconcileScheduledTask(engine, cleanupTask);
  assert.equal(recovered.cleanup.cleanup, "deleted");
  assert.equal(deletes, 2);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(repository.state.get("key").delivery.pendingDelete, undefined);
  assert.notEqual(crashedOwner, "");
});

test("a newer desired API settles an expired cleanup gate before proceeding", async () => {
  const desiredA = sendDesired({ text: "A", sourceRevision: "A" });
  const desiredB = editDesired({ text: "B", sourceRevision: "B" });
  let nowMs = 10_000;
  let edits = 0;
  let deletes = 0;
  const scheduled = [];
  const repository = createRepository({
    key: {
      desired: desiredA,
      applied: {
        destination: "community",
        chatId: "community-chat",
        messageId: 31,
        instanceKey: desiredA.instanceKey,
        revision: desiredA.revision,
        contentHash: desiredA.contentHash,
      },
      delivery: {
        status: "delivered",
        revision: desiredA.revision,
        pendingDelete: {
          pendingDeleteId: "cleanup-blocking-desired",
          chatId: "community-chat",
          messageId: 30,
          status: "pending",
          attempts: 0,
        },
      },
    },
  });
  const engine = createEngine({
    repository,
    now: () => nowMs,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async editTelegramMessage() {
        edits += 1;
        return { ok: true, outcome: "edited" };
      },
      async deleteTelegramMessage() {
        deletes += 1;
        if (deletes === 1) {
          throw Object.assign(new Error("worker-died"), {
            code: "worker-died",
          });
        }
        return { ok: true, outcome: "deleted" };
      },
    }),
  });
  await assert.rejects(
    () =>
      engine.reconcile({
        messageKey: "key",
        taskKind: "pending-delete",
        pendingDeleteId: "cleanup-blocking-desired",
        requestedGeneration: "cleanup-crash",
      }),
    { code: "worker-died" },
  );

  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: desiredB,
  });
  nowMs = 71_000;
  const latest = await engine.reconcile({
    messageKey: "key",
    requestedGeneration: "desired-B",
  });
  assert.equal(latest.status, "delivered");
  assert.equal(latest.cleanupScheduled, true);
  assert.equal(edits, 1);
  assert.equal(deletes, 1);
  assert.equal(repository.control.apiGate, undefined);

  const cleanupTask = scheduled.at(-1);
  assert.equal(cleanupTask.taskKind, "pending-delete");
  const cleaned = await reconcileScheduledTask(engine, cleanupTask);
  assert.equal(cleaned.cleanup.cleanup, "deleted");
  assert.equal(deletes, 2);
  assert.equal(repository.state.get("key").delivery.pendingDelete, undefined);
});

test("expired hard-crash gates settle without another Telegram call", async (t) => {
  for (const operation of ["edit", "delete"]) {
    await t.test(operation, async () => {
      const desired =
        operation === "edit"
          ? editDesired({ sourceRevision: "expired-edit" })
          : buildTelegramDeleteDesired({
              destination: "community",
              sourceRevision: "expired-delete",
            });
      let nowMs = 10_000;
      let calls = 0;
      const repository = createRepository({
        key: {
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 12,
            instanceKey: desired.instanceKey || "old",
            contentHash: "old",
          },
        },
      });
      const client = createClient({
        async editTelegramMessage() {
          calls += 1;
          throw Object.assign(new Error("worker-died"), {
            code: "worker-died",
          });
        },
        async deleteTelegramMessage() {
          calls += 1;
          throw Object.assign(new Error("worker-died"), {
            code: "worker-died",
          });
        },
      });
      await assert.rejects(
        () =>
          createEngine({
            repository,
            client,
            now: () => nowMs,
            createOwnerToken: () => "crashed-worker",
          }).reconcile({
            messageKey: "key",
            requestedGeneration: `${operation}-hard-crash`,
          }),
        { code: "worker-died" },
      );
      assert.equal(repository.control.apiGate.messageKey, "key");

      nowMs = 610_000;
      const expired = await createEngine({
        repository,
        client,
        now: () => nowMs,
        createOwnerToken: () => "deadline-worker",
      }).reconcile({ messageKey: "key" });
      assert.equal(expired.status, "terminal");
      assert.equal(expired.reason, "safe-retry-window-exhausted");
      assert.equal(calls, 1);
      assert.equal(repository.control.apiGate, undefined);
      assert.equal(
        repository.state.get("key").delivery.apiGateSettleOwner,
        undefined,
      );
    });
  }

  await t.test("pending cleanup", async () => {
    const desired = sendDesired();
    let nowMs = 10_000;
    let deletes = 0;
    const repository = createRepository({
      key: {
        desired,
        delivery: {
          status: "delivered",
          revision: desired.revision,
          pendingDelete: {
            pendingDeleteId: "expired-cleanup",
            chatId: "community-chat",
            messageId: 14,
            status: "pending",
            attempts: 0,
          },
        },
      },
    });
    const client = createClient({
      async deleteTelegramMessage() {
        deletes += 1;
        throw Object.assign(new Error("worker-died"), {
          code: "worker-died",
        });
      },
    });
    await assert.rejects(
      () =>
        createEngine({
          repository,
          client,
          now: () => nowMs,
          createOwnerToken: () => "cleanup-crash",
        }).reconcile({
          messageKey: "key",
          taskKind: "pending-delete",
          pendingDeleteId: "expired-cleanup",
          requestedGeneration: "cleanup-hard-crash",
        }),
      { code: "worker-died" },
    );

    nowMs = 610_000;
    const expired = await createEngine({
      repository,
      client,
      now: () => nowMs,
      createOwnerToken: () => "cleanup-deadline",
    }).reconcile({
      messageKey: "key",
      taskKind: "pending-delete",
      pendingDeleteId: "expired-cleanup",
    });
    assert.equal(expired.cleanup.cleanup, "exhausted");
    assert.equal(deletes, 1);
    assert.equal(repository.control.apiGate, undefined);
    assert.equal(
      repository.state.get("key").delivery.orphanedDeletes["expired-cleanup"]
        .lastError.code,
      "safe-retry-window-exhausted",
    );
  });
});

test("proof payload bounds an idempotent retry when RTDB finalization failed", async () => {
  const desired = editDesired();
  let rejectFinalization = true;
  const repository = createRepository(
    {
      key: {
        desired,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 3,
          instanceKey: desired.instanceKey,
          contentHash: "old",
        },
      },
    },
    {
      rejectCommit: ({ output }) => {
        if (
          rejectFinalization &&
          output?.value?.delivery?.status === "retryable"
        ) {
          rejectFinalization = false;
          return true;
        }
        return false;
      },
    },
  );
  const scheduled = [];
  let nowMs = 10_000;
  let edits = 0;
  const engine = createEngine({
    repository,
    now: () => nowMs,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async editTelegramMessage() {
        edits += 1;
        return {
          ok: false,
          classification: "retryable",
          code: "network-error",
        };
      },
    }),
  });

  await assert.rejects(() => engine.reconcile({ messageKey: "key" }), {
    code: "retryable-finalization-failed",
  });
  assert.equal(repository.state.get("key").delivery.status, "processing");
  assert.equal(scheduled[0].retrySequence, 1);

  nowMs = scheduled[0].retryDeadlineAtMs;
  const result = await engine.reconcile({
    messageKey: "key",
    requestedRevision: scheduled[0].revision,
    requestedGeneration: scheduled[0].generation,
    taskKind: scheduled[0].taskKind,
    retrySequence: scheduled[0].retrySequence,
    retryStartedAtMs: scheduled[0].retryStartedAtMs,
    retryDeadlineAtMs: scheduled[0].retryDeadlineAtMs,
    retryAtMs: scheduled[0].retryAtMs,
    retryProofLeaseOwner: scheduled[0].retryProofLeaseOwner,
  });
  assert.equal(result.status, "terminal");
  assert.equal(result.reason, "safe-retry-window-exhausted");
  assert.equal(edits, 1);
  assert.equal(repository.state.get("key").delivery.deadLetterAtMs, nowMs);
});

test("proof payload bounds pending cleanup when RTDB finalization failed", async () => {
  const desired = sendDesired();
  let rejectFinalization = true;
  const repository = createRepository(
    {
      key: {
        desired,
        delivery: {
          status: "delivered",
          revision: desired.revision,
          pendingDelete: {
            pendingDeleteId: "cleanup-1",
            chatId: "community-chat",
            messageId: 8,
            instanceKey: "old",
            status: "pending",
            attempts: 0,
          },
        },
      },
    },
    {
      rejectCommit: ({ output }) => {
        if (
          rejectFinalization &&
          output?.value?.delivery?.pendingDelete?.status === "retryable"
        ) {
          rejectFinalization = false;
          return true;
        }
        return false;
      },
    },
  );
  const scheduled = [];
  let nowMs = 10_000;
  let deletes = 0;
  const engine = createEngine({
    repository,
    now: () => nowMs,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async deleteTelegramMessage() {
        deletes += 1;
        return {
          ok: false,
          classification: "retryable",
          code: "network-error",
        };
      },
    }),
  });

  await assert.rejects(
    () =>
      engine.reconcile({
        messageKey: "key",
        taskKind: "pending-delete",
        pendingDeleteId: "cleanup-1",
      }),
    { code: "pending-delete-retryable-finalization-failed" },
  );
  assert.equal(
    repository.state.get("key").delivery.pendingDelete.status,
    "processing",
  );

  nowMs = scheduled[0].retryDeadlineAtMs;
  await engine.reconcile({
    messageKey: "key",
    requestedRevision: scheduled[0].revision,
    requestedGeneration: scheduled[0].generation,
    taskKind: "pending-delete",
    pendingDeleteId: scheduled[0].pendingDeleteId,
    retrySequence: scheduled[0].retrySequence,
    retryStartedAtMs: scheduled[0].retryStartedAtMs,
    retryDeadlineAtMs: scheduled[0].retryDeadlineAtMs,
    retryAtMs: scheduled[0].retryAtMs,
    retryProofLeaseOwner: scheduled[0].retryProofLeaseOwner,
  });
  const delivery = repository.state.get("key").delivery;
  assert.equal(deletes, 1);
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.pendingDelete, undefined);
  assert.equal(
    delivery.orphanedDeletes["cleanup-1"].lastError.code,
    "safe-retry-window-exhausted",
  );
});

test("global deferral persists a bounded retry window", async () => {
  const desired = sendDesired();
  const repository = createRepository(
    { key: { desired } },
    { retryNotBeforeMs: 3_610_000 },
  );
  const scheduled = [];
  let nowMs = 10_000;
  let sends = 0;
  const engine = createEngine({
    repository,
    now: () => nowMs,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return { ok: true, messageId: 1 };
      },
    }),
  });

  const deferred = await engine.reconcile({ messageKey: "key" });
  assert.deepEqual(deferred, {
    status: "retryable",
    reason: "global-retry-after",
    retryAtMs: 610_000,
    scheduled: true,
  });
  const retrying = repository.state.get("key").delivery;
  assert.equal(retrying.retryStartedAtMs, 10_000);
  assert.equal(retrying.retryDeadlineAtMs, 610_000);
  assert.equal(scheduled[0].scheduleTimeMs, 610_000);

  nowMs = 610_000;
  const exhausted = await engine.reconcile({ messageKey: "key" });
  assert.equal(exhausted.status, "terminal");
  assert.equal(exhausted.reason, "safe-retry-window-exhausted");
  assert.equal(sends, 0);
});

test("pre-call enqueue failures cannot reset retry windows", async (t) => {
  await t.test("desired global barrier", async () => {
    const desired = sendDesired();
    const repository = createRepository(
      { key: { desired } },
      { retryNotBeforeMs: 3_610_000 },
    );
    let nowMs = 10_000;
    let sends = 0;
    const client = createClient({
      async sendTelegramMessage() {
        sends += 1;
        return { ok: true, messageId: 1 };
      },
    });
    const failingEngine = createEngine({
      repository,
      now: () => nowMs,
      scheduleRetry: async () => {
        const delivery = repository.state.get("key").delivery;
        assert.equal(delivery.status, "retryable");
        assert.equal(delivery.retryDeadlineAtMs, 610_000);
        throw Object.assign(new Error("enqueue-failed"), {
          code: "enqueue-failed",
        });
      },
      client,
    });
    await assert.rejects(() => failingEngine.reconcile({ messageKey: "key" }), {
      code: "enqueue-failed",
    });
    nowMs = 100_000;
    await assert.rejects(() => failingEngine.reconcile({ messageKey: "key" }), {
      code: "enqueue-failed",
    });
    assert.equal(
      repository.state.get("key").delivery.retryDeadlineAtMs,
      610_000,
    );

    nowMs = 610_000;
    const exhausted = await createEngine({
      repository,
      now: () => nowMs,
      client,
    }).reconcile({ messageKey: "key" });
    assert.equal(exhausted.status, "terminal");
    assert.equal(sends, 0);
  });

  await t.test("blocked send gate", async () => {
    const desired = sendDesired();
    const repository = createRepository(
      { key: { desired } },
      {
        apiGate: {
          owner: "foreign",
          messageKey: "other",
          revision: "other",
          operation: "edit",
          acquiredAtMs: 1,
        },
      },
    );
    let nowMs = 10_000;
    let sends = 0;
    await assert.rejects(
      () =>
        createEngine({
          repository,
          now: () => nowMs,
          scheduleRetry: async () => {
            const delivery = repository.state.get("key").delivery;
            assert.equal(delivery.status, "retryable");
            assert.equal(delivery.sendInFlight, undefined);
            assert.equal(delivery.retryDeadlineAtMs, 610_000);
            throw Object.assign(new Error("enqueue-failed"), {
              code: "enqueue-failed",
            });
          },
          client: createClient({
            async sendTelegramMessage() {
              sends += 1;
              return { ok: true, messageId: 1 };
            },
          }),
        }).reconcile({ messageKey: "key" }),
      { code: "enqueue-failed" },
    );
    delete repository.control.apiGate;
    nowMs = 11_000;
    const delivered = await createEngine({
      repository,
      now: () => nowMs,
      client: createClient({
        async sendTelegramMessage() {
          sends += 1;
          return { ok: true, messageId: 1 };
        },
      }),
    }).reconcile({ messageKey: "key" });
    assert.equal(delivered.status, "delivered");
    assert.equal(sends, 1);
  });

  await t.test("pending cleanup global barrier", async () => {
    const desired = sendDesired();
    const repository = createRepository(
      {
        key: {
          desired,
          applied: {
            destination: "community",
            chatId: "community-chat",
            messageId: 2,
            instanceKey: desired.instanceKey,
            contentHash: desired.contentHash,
          },
          delivery: {
            status: "delivered",
            revision: desired.revision,
            pendingDelete: {
              pendingDeleteId: "old-message",
              chatId: "community-chat",
              messageId: 1,
              status: "pending",
              attempts: 0,
            },
          },
        },
      },
      { retryNotBeforeMs: 3_610_000 },
    );
    await assert.rejects(
      () =>
        createEngine({
          repository,
          scheduleRetry: async () => {
            const pendingDelete =
              repository.state.get("key").delivery.pendingDelete;
            assert.equal(pendingDelete.status, "retryable");
            assert.equal(pendingDelete.retryDeadlineAtMs, 610_000);
            throw Object.assign(new Error("enqueue-failed"), {
              code: "enqueue-failed",
            });
          },
        }).reconcile({
          messageKey: "key",
          taskKind: "pending-delete",
          pendingDeleteId: "old-message",
        }),
      { code: "enqueue-failed" },
    );
    assert.equal(
      repository.state.get("key").delivery.pendingDelete.retryDeadlineAtMs,
      610_000,
    );
  });
});

test("rechecks retry deadlines immediately before Telegram calls", async (t) => {
  for (const operation of ["send", "edit", "delete"]) {
    await t.test(operation, async () => {
      const desired =
        operation === "send"
          ? sendDesired()
          : operation === "edit"
            ? editDesired()
            : buildTelegramDeleteDesired({
                destination: "community",
                sourceRevision: "delete",
              });
      const record = {
        desired,
        delivery: {
          status: "retryable",
          revision: desired.revision,
          attempts: 1,
          retryStartedAtMs: 1,
          retryDeadlineAtMs: 10_000,
          retryAtMs: 9_000,
          retrySequence: 1,
        },
      };
      if (operation !== "send") {
        record.applied = {
          destination: "community",
          chatId: "community-chat",
          messageId: 4,
          instanceKey: desired.instanceKey || "old",
          contentHash: "old",
        };
      }
      let clockReads = 0;
      let calls = 0;
      const result = await createEngine({
        repository: createRepository({ key: record }),
        now: () => (++clockReads >= 4 ? 10_000 : 9_999),
        client: createClient({
          async sendTelegramMessage() {
            calls += 1;
            return { ok: true, messageId: 1 };
          },
          async editTelegramMessage() {
            calls += 1;
            return { ok: true };
          },
          async deleteTelegramMessage() {
            calls += 1;
            return { ok: true };
          },
        }),
      }).reconcile({ messageKey: "key" });
      assert.equal(result.status, "terminal");
      assert.equal(result.reason, "safe-retry-window-exhausted");
      assert.equal(calls, 0);
    });
  }

  await t.test(
    "held idempotent gate crosses deadline after lease acquire",
    async () => {
      const desired = editDesired({ sourceRevision: "held-deadline" });
      const gateOwner = "held-edit-gate";
      let clockReads = 0;
      let edits = 0;
      const repository = createRepository(
        {
          key: {
            desired,
            applied: {
              destination: "community",
              chatId: "community-chat",
              messageId: 4,
              instanceKey: desired.instanceKey,
              contentHash: "old",
            },
            delivery: {
              status: "processing",
              revision: desired.revision,
              attempts: 1,
              leaseOwner: "expired-worker",
              leaseExpiresAtMs: 9_000,
              retryStartedAtMs: 1,
              retryDeadlineAtMs: 10_000,
              retryAtMs: 9_000,
              retrySequence: 1,
              apiGateOwner: gateOwner,
              apiGateGeneration: "held-generation",
              apiGateStartedAtMs: 1,
            },
          },
        },
        {
          apiGate: {
            owner: gateOwner,
            messageKey: "key",
            revision: desired.revision,
            operation: "edit",
            acquiredAtMs: 1,
          },
        },
      );
      const result = await createEngine({
        repository,
        now: () => (++clockReads === 1 ? 9_999 : 10_000),
        client: createClient({
          async editTelegramMessage() {
            edits += 1;
            return { ok: true };
          },
        }),
      }).reconcile({ messageKey: "key" });
      assert.equal(result.status, "terminal");
      assert.equal(result.reason, "safe-retry-window-exhausted");
      assert.equal(edits, 0);
      assert.equal(repository.control.apiGate, undefined);
    },
  );

  await t.test("pending delete", async () => {
    const desired = sendDesired();
    let clockReads = 0;
    let deletes = 0;
    const repository = createRepository({
      key: {
        desired,
        delivery: {
          status: "delivered",
          revision: desired.revision,
          pendingDelete: {
            pendingDeleteId: "cleanup-deadline",
            chatId: "community-chat",
            messageId: 9,
            status: "retryable",
            retryStartedAtMs: 1,
            retryDeadlineAtMs: 10_000,
            retryAtMs: 9_000,
            retrySequence: 1,
          },
        },
      },
    });
    await createEngine({
      repository,
      now: () => (++clockReads >= 4 ? 10_000 : 9_999),
      client: createClient({
        async deleteTelegramMessage() {
          deletes += 1;
          return { ok: true };
        },
      }),
    }).reconcile({
      messageKey: "key",
      taskKind: "pending-delete",
      pendingDeleteId: "cleanup-deadline",
    });
    assert.equal(deletes, 0);
    const delivery = repository.state.get("key").delivery;
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.pendingDelete, undefined);
    assert.equal(
      delivery.orphanedDeletes["cleanup-deadline"].lastError.code,
      "safe-retry-window-exhausted",
    );
  });

  await t.test("pending delete barrier read crosses the deadline", async () => {
    const desired = sendDesired();
    let nowMs = 9_999;
    let barrierReads = 0;
    let deletes = 0;
    const repository = createRepository({
      key: {
        desired,
        delivery: {
          status: "delivered",
          revision: desired.revision,
          pendingDelete: {
            pendingDeleteId: "cleanup-read-deadline",
            chatId: "community-chat",
            messageId: 11,
            status: "retryable",
            retryStartedAtMs: 1,
            retryDeadlineAtMs: 10_000,
            retryAtMs: 9_000,
            retrySequence: 1,
          },
        },
      },
    });
    repository.getRetryNotBeforeMs = async () => {
      barrierReads += 1;
      if (barrierReads === 2) {
        nowMs = 10_000;
      }
      return 0;
    };
    await createEngine({
      repository,
      now: () => nowMs,
      client: createClient({
        async deleteTelegramMessage() {
          deletes += 1;
          return { ok: true };
        },
      }),
    }).reconcile({
      messageKey: "key",
      taskKind: "pending-delete",
      pendingDeleteId: "cleanup-read-deadline",
    });
    assert.equal(barrierReads, 2);
    assert.equal(deletes, 0);
    const delivery = repository.state.get("key").delivery;
    assert.equal(delivery.pendingDelete, undefined);
    assert.equal(
      delivery.orphanedDeletes["cleanup-read-deadline"].lastError.code,
      "safe-retry-window-exhausted",
    );
  });
});

test("stale retry proofs preserve newer desired and cleanup leases", async (t) => {
  await t.test("desired A proof cannot clear a recreated A lease", async () => {
    const desired = editDesired({ text: "A", sourceRevision: "A" });
    const interveningDesired = editDesired({ text: "B", sourceRevision: "B" });
    assert.notEqual(desired.revision, interveningDesired.revision);
    const scheduled = [];
    const repository = createRepository({
      key: {
        desired,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 3,
          instanceKey: desired.instanceKey,
          contentHash: "old",
        },
        delivery: {
          status: "processing",
          revision: desired.revision,
          leaseOwner: "newer-worker",
          leaseExpiresAtMs: 20_000,
          retryStartedAtMs: 1_000,
          retryDeadlineAtMs: 30_000,
          retryAtMs: 9_000,
          retrySequence: 2,
        },
      },
    });
    const result = await createEngine({
      repository,
      scheduleRetry: async (task) => {
        scheduled.push(task);
        return { scheduled: true };
      },
    }).reconcile({
      messageKey: "key",
      requestedRevision: desired.revision,
      requestedGeneration: "running-task",
      taskKind: "desired",
      retryStartedAtMs: 1_000,
      retryDeadlineAtMs: 30_000,
      retryAtMs: 9_000,
      retrySequence: 3,
      retryProofLeaseOwner: "first-a-worker",
    });
    assert.equal(result.reason, "locked");
    assert.equal(
      repository.state.get("key").delivery.leaseOwner,
      "newer-worker",
    );
    assert.equal(scheduled[0].retryStartedAtMs, 1_000);
    assert.equal(scheduled[0].retryDeadlineAtMs, 30_000);
    assert.equal(scheduled[0].retryProofLeaseOwner, undefined);
    assert.notEqual(scheduled[0].generation, "running-task");
    assert.notEqual(
      buildTelegramDeliveryTaskId({
        messageKey: "key",
        revision: desired.revision,
        taskKind: "desired",
        retrySequence: 2,
        generation: "running-task",
      }),
      buildTelegramDeliveryTaskId(scheduled[0]),
    );
  });

  await t.test(
    "cleanup proof cannot clear a recreated cleanup lease",
    async () => {
      const desired = sendDesired();
      const scheduled = [];
      const repository = createRepository({
        key: {
          desired,
          delivery: {
            status: "delivered",
            revision: desired.revision,
            pendingDelete: {
              pendingDeleteId: "cleanup-newer",
              chatId: "community-chat",
              messageId: 7,
              status: "processing",
              leaseOwner: "newer-cleanup",
              leaseExpiresAtMs: 20_000,
              retryStartedAtMs: 1_000,
              retryDeadlineAtMs: 30_000,
              retryAtMs: 9_000,
              retrySequence: 2,
            },
          },
        },
      });
      const result = await createEngine({
        repository,
        scheduleRetry: async (task) => {
          scheduled.push(task);
          return { scheduled: true };
        },
      }).reconcile({
        messageKey: "key",
        requestedRevision: desired.revision,
        requestedGeneration: "running-cleanup",
        taskKind: "pending-delete",
        pendingDeleteId: "cleanup-newer",
        retryStartedAtMs: 1_000,
        retryDeadlineAtMs: 30_000,
        retryAtMs: 9_000,
        retrySequence: 3,
        retryProofLeaseOwner: "first-cleanup-worker",
      });
      assert.equal(result.cleanup.status, "retryable");
      assert.equal(
        repository.state.get("key").delivery.pendingDelete.leaseOwner,
        "newer-cleanup",
      );
      assert.equal(scheduled[0].retryStartedAtMs, 1_000);
      assert.equal(scheduled[0].retryDeadlineAtMs, 30_000);
      assert.equal(scheduled[0].retryProofLeaseOwner, undefined);
      assert.notEqual(scheduled[0].generation, "running-cleanup");
    },
  );
});

test("pending cleanup proof cannot clear a top-level desired lease", async () => {
  const desired = editDesired();
  const repository = createRepository({
    key: {
      desired,
      delivery: {
        status: "processing",
        revision: desired.revision,
        leaseOwner: "desired-worker",
        leaseExpiresAtMs: 20_000,
        retrySequence: 0,
        pendingDelete: {
          pendingDeleteId: "cleanup-isolated",
          chatId: "community-chat",
          messageId: 4,
          status: "processing",
        },
      },
    },
  });
  const result = await createEngine({ repository }).reconcile({
    messageKey: "key",
    requestedRevision: desired.revision,
    requestedGeneration: "cleanup-task",
    taskKind: "pending-delete",
    pendingDeleteId: "cleanup-isolated",
    retryStartedAtMs: 1_000,
    retryDeadlineAtMs: 30_000,
    retryAtMs: 11_000,
    retrySequence: 1,
  });
  assert.equal(result.reason, "locked");
  assert.equal(
    repository.state.get("key").delivery.leaseOwner,
    "desired-worker",
  );
});

test("a delayed A barrier proof cannot release B's revision-scoped gate", async () => {
  const desiredA = editDesired({ text: "A", sourceRevision: "A" });
  const desiredB = editDesired({ text: "B", sourceRevision: "B" });
  let rejectBarrierProofWrite = true;
  let nowMs = 10_000;
  let edits = 0;
  const scheduled = [];
  const repository = createRepository(
    {
      key: {
        desired: desiredA,
        applied: {
          destination: "community",
          chatId: "community-chat",
          messageId: 3,
          instanceKey: desiredA.instanceKey,
          contentHash: "old",
        },
      },
    },
    { rejectBarrierProofWrite: () => rejectBarrierProofWrite },
  );
  const engine = createEngine({
    repository,
    now: () => nowMs,
    scheduleRetry: async (task) => {
      scheduled.push(task);
      return { scheduled: true };
    },
    client: createClient({
      async editTelegramMessage() {
        edits += 1;
        return {
          ok: false,
          classification: "retryable",
          code: "rate-limited",
          retryAfterSeconds: 8,
        };
      },
    }),
  });
  await engine.reconcile({
    messageKey: "key",
    requestedGeneration: "A-task",
  });
  const proofA = scheduled[0];
  const gateAOwner = repository.control.apiGate.owner;

  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: desiredB,
  });
  nowMs = 71_000;
  const blockedB = await engine.reconcile({
    messageKey: "key",
    requestedGeneration: "B-task",
  });
  assert.deepEqual(blockedB, {
    status: "retryable",
    reason: "rate-limit-proof-pending",
    retryAtMs: 18_000,
    scheduled: true,
  });
  assert.equal(edits, 1);
  const gateBOwner = "api-gate-B";
  const deliveryB = {
    ...repository.state.get("key").delivery,
    status: "processing",
    revision: desiredB.revision,
    apiGateOwner: gateBOwner,
    apiGateGeneration: "B-task",
  };
  repository.state.set("key", {
    ...repository.state.get("key"),
    delivery: deliveryB,
  });

  repository.control.apiGate = {
    owner: gateBOwner,
    messageKey: "key",
    revision: desiredB.revision,
    operation: "edit",
    acquiredAtMs: nowMs,
  };
  rejectBarrierProofWrite = false;
  const stale = await reconcileScheduledTask(engine, proofA);
  assert.deepEqual(stale, {
    status: "settled",
    reason: "stale-rate-limit-proof",
  });
  assert.equal(repository.control.apiGate.owner, gateBOwner);
  assert.equal(repository.state.get("key").delivery.apiGateOwner, gateBOwner);
});

test("manual recovery rejects an active send lease", async () => {
  const desired = sendDesired();
  const repository = createRepository({
    key: {
      desired,
      manualRecovery: {
        requestId: "recovery-active",
        action: "confirm-send-absent",
      },
      delivery: {
        status: "processing",
        revision: desired.revision,
        leaseOwner: "active-worker",
        leaseExpiresAtMs: 20_000,
        sendInFlight: {
          attemptId: "active-attempt",
          revision: desired.revision,
          destination: desired.destination,
          chatId: "community-chat",
          instanceKey: desired.instanceKey,
          contentHash: desired.contentHash,
          startedAtMs: 9_000,
        },
      },
    },
  });
  const engine = createEngine({ repository });
  const first = await engine.reconcile({ messageKey: "key" });
  assert.equal(first.reason, "locked");
  const state = repository.state.get("key");
  assert.equal(state.delivery.sendInFlight.attemptId, "active-attempt");
  assert.equal(state.delivery.lastRecoveryRequestId, "recovery-active");
  assert.equal(state.manualRecoveryResult.status, "rejected");
  assert.equal(state.manualRecoveryResult.code, "recovery-not-uncertain");
  const processedAtMs = state.manualRecoveryResult.processedAtMs;
  await engine.reconcile({ messageKey: "key" });
  assert.equal(
    repository.state.get("key").manualRecoveryResult.processedAtMs,
    processedAtMs,
  );
});

test("an ambiguous send remains visible when desired changes during the call", async () => {
  const firstDesired = sendDesired();
  const latestDesired = sendDesired({
    instanceKey: "matched:invite-1",
    text: "matched",
    sourceRevision: "matched",
  });
  const repository = createRepository({ key: { desired: firstDesired } });
  const result = await createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        repository.state.set("key", {
          ...repository.state.get("key"),
          desired: latestDesired,
        });
        return {
          ok: false,
          classification: "uncertain",
          code: "timeout",
        };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.equal(result.status, "uncertain");
  const delivery = repository.state.get("key").delivery;
  assert.equal(delivery.status, "uncertain");
  assert.equal(delivery.revision, latestDesired.revision);
  assert.equal(delivery.sendInFlight.revision, firstDesired.revision);
  assert.equal(delivery.lastError.code, "timeout");
});

test("manual abandon clears ambiguity and permits a later revision", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  let sends = 0;
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        if (sends === 1) {
          return {
            ok: false,
            classification: "uncertain",
            code: "timeout",
          };
        }
        return { ok: true, messageId: 12 };
      },
    }),
  });
  await engine.reconcile({ messageKey: "key" });
  repository.state.set("key", {
    ...repository.state.get("key"),
    delivery: {
      ...repository.state.get("key").delivery,
      appliedStateUnknown: {
        revision: "older-edit",
        operation: "edit",
        markedAtMs: 1,
      },
    },
    manualRecovery: { requestId: "abandon-1", action: "abandon" },
  });
  const abandoned = await engine.reconcile({ messageKey: "key" });
  assert.equal(abandoned.status, "terminal");
  let delivery = repository.state.get("key").delivery;
  assert.equal(delivery.sendInFlight, undefined);
  assert.equal(delivery.abandonedSend.attemptId, "attempt-1");
  assert.equal(delivery.appliedStateUnknown.operation, "edit");

  const latest = sendDesired({ text: "next", sourceRevision: "next" });
  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: latest,
  });
  const delivered = await engine.reconcile({ messageKey: "key" });
  assert.equal(delivered.status, "delivered");
  assert.equal(sends, 2);
  delivery = repository.state.get("key").delivery;
  assert.equal(delivery.status, "delivered");
});

test("manual confirmation reconstructs an acknowledged ambiguous send", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  let sends = 0;
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return {
          ok: false,
          classification: "uncertain",
          code: "timeout",
        };
      },
    }),
  });
  await engine.reconcile({ messageKey: "key" });
  repository.state.set("key", {
    ...repository.state.get("key"),
    delivery: {
      ...repository.state.get("key").delivery,
      appliedStateUnknown: {
        revision: "older-edit",
        operation: "edit",
        markedAtMs: 1,
      },
    },
    manualRecovery: {
      requestId: "applied-1",
      action: "confirm-send-applied",
      messageId: 77,
    },
  });
  const recovered = await engine.reconcile({ messageKey: "key" });
  assert.equal(recovered.status, "delivered");
  assert.equal(repository.state.get("key").applied.messageId, 77);
  assert.equal(
    repository.state.get("key").manualRecoveryResult.status,
    "accepted",
  );
  assert.equal(
    repository.state.get("key").delivery.appliedStateUnknown,
    undefined,
  );
  assert.equal(sends, 1);
});

test("manual recovery releases the matching send gate after a worker crash", async () => {
  const desired = sendDesired();
  let rejectRelease = true;
  let nowMs = 10_000;
  let sends = 0;
  const repository = createRepository(
    { key: { desired } },
    { rejectApiGateRelease: () => rejectRelease },
  );
  const engine = createEngine({
    repository,
    now: () => nowMs,
    createAttemptId: () => `attempt-${sends + 1}`,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        if (sends === 1) {
          return {
            ok: false,
            classification: "uncertain",
            code: "timeout",
          };
        }
        return { ok: true, messageId: 91 };
      },
    }),
  });
  await assert.rejects(() => engine.reconcile({ messageKey: "key" }), {
    code: "api-gate-release-failed",
  });
  const crashedGateOwner = repository.control.apiGate.owner;
  assert.equal(
    repository.state.get("key").delivery.sendInFlight.apiGateOwner,
    crashedGateOwner,
  );

  rejectRelease = false;
  nowMs = 71_000;
  assert.equal(
    (await engine.reconcile({ messageKey: "key" })).status,
    "uncertain",
  );
  repository.state.set("key", {
    ...repository.state.get("key"),
    manualRecovery: {
      requestId: "crashed-send-absent",
      action: "confirm-send-absent",
    },
  });
  const recovered = await engine.reconcile({ messageKey: "key" });
  assert.equal(recovered.status, "delivered");
  assert.equal(sends, 2);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(
    repository.state.get("key").delivery.apiGateReleaseOwner,
    undefined,
  );
});

test("manual confirmation of an ambiguous replacement preserves old cleanup", async () => {
  const desired = sendDesired({
    instanceKey: "replacement-b",
    text: "replacement",
    sourceRevision: "replacement-b",
  });
  const repository = createRepository({
    key: {
      desired,
      applied: {
        destination: "community",
        chatId: "community-chat",
        messageId: 10,
        instanceKey: "replacement-a",
        contentHash: "old-content",
      },
    },
  });
  let sends = 0;
  const deleted = [];
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        return {
          ok: false,
          classification: "uncertain",
          code: "timeout",
        };
      },
      async deleteTelegramMessage({ messageId }) {
        deleted.push(messageId);
        return { ok: true, outcome: "deleted" };
      },
    }),
  });

  const ambiguous = await engine.reconcile({ messageKey: "key" });
  assert.equal(ambiguous.status, "uncertain");
  repository.state.set("key", {
    ...repository.state.get("key"),
    manualRecovery: {
      requestId: "replacement-applied",
      action: "confirm-send-applied",
      messageId: 77,
    },
  });

  const recovered = await engine.reconcile({ messageKey: "key" });
  assert.equal(recovered.status, "delivered");
  assert.equal(recovered.cleanupScheduled, true);
  let record = repository.state.get("key");
  assert.equal(record.applied.messageId, 77);
  assert.equal(record.delivery.pendingDelete.messageId, 10);
  assert.equal(sends, 1);

  const pendingDeleteId = record.delivery.pendingDelete.pendingDeleteId;
  await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId,
  });
  record = repository.state.get("key");
  assert.equal(record.applied.messageId, 77);
  assert.equal(record.delivery.pendingDelete, undefined);
  assert.deepEqual(deleted, [10]);
});

test("manual absent confirmation safely retries the ambiguous send", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  let sends = 0;
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        sends += 1;
        if (sends === 1) {
          return {
            ok: false,
            classification: "uncertain",
            code: "timeout",
          };
        }
        return { ok: true, messageId: 88 };
      },
    }),
  });
  await engine.reconcile({ messageKey: "key" });
  repository.state.set("key", {
    ...repository.state.get("key"),
    manualRecovery: {
      requestId: "absent-1",
      action: "confirm-send-absent",
    },
  });
  const recovered = await engine.reconcile({ messageKey: "key" });
  assert.equal(recovered.status, "delivered");
  assert.equal(repository.state.get("key").applied.messageId, 88);
  assert.equal(
    repository.state.get("key").manualRecoveryResult.status,
    "accepted",
  );
  assert.equal(sends, 2);
});

test("pending cleanup runs after reconciling the latest desired revision", async () => {
  const desired = editDesired({
    instanceKey: "matched",
    text: "latest",
    sourceRevision: "latest",
    ifMissing: "send",
  });
  const repository = createRepository({
    key: {
      desired,
      applied: {
        destination: "community",
        chatId: "community-chat",
        messageId: 20,
        instanceKey: "matched",
        contentHash: "previous",
      },
      delivery: {
        status: "delivered",
        revision: "previous-revision",
        pendingDelete: {
          pendingDeleteId: "cleanup-old",
          chatId: "community-chat",
          messageId: 10,
          status: "pending",
        },
      },
    },
  });
  const order = [];
  await createEngine({
    repository,
    client: createClient({
      async editTelegramMessage() {
        order.push("edit");
        return { ok: true, outcome: "edited" };
      },
      async deleteTelegramMessage() {
        order.push("delete");
        assert.equal(
          repository.state.get("key").delivery.revision,
          desired.revision,
        );
        return { ok: true, outcome: "deleted" };
      },
    }),
  }).reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId: "cleanup-old",
  });
  assert.deepEqual(order, ["edit", "delete"]);
  const delivery = repository.state.get("key").delivery;
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.revision, desired.revision);
});

test("consecutive replacements preserve and drain every pending cleanup", async () => {
  const firstReplacement = sendDesired({
    instanceKey: "replacement-b",
    text: "B",
    sourceRevision: "B",
  });
  const secondReplacement = sendDesired({
    instanceKey: "replacement-c",
    text: "C",
    sourceRevision: "C",
  });
  const repository = createRepository({
    key: {
      desired: firstReplacement,
      applied: {
        destination: "community",
        chatId: "community-chat",
        messageId: 10,
        instanceKey: "replacement-a",
        contentHash: "A",
      },
    },
  });
  const order = [];
  let nextMessageId = 20;
  const engine = createEngine({
    repository,
    client: createClient({
      async sendTelegramMessage() {
        const messageId = nextMessageId;
        nextMessageId += 10;
        order.push(`send:${messageId}`);
        return { ok: true, messageId };
      },
      async deleteTelegramMessage({ messageId }) {
        order.push(`delete:${messageId}`);
        return { ok: true, outcome: "deleted" };
      },
    }),
  });

  await engine.reconcile({ messageKey: "key" });
  const firstPendingDeleteId =
    repository.state.get("key").delivery.pendingDelete.pendingDeleteId;
  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: secondReplacement,
  });
  await engine.reconcile({ messageKey: "key" });

  let delivery = repository.state.get("key").delivery;
  assert.equal(delivery.pendingDelete.messageId, 10);
  assert.deepEqual(
    Object.values(delivery.pendingDeleteQueue).map(
      ({ messageId }) => messageId,
    ),
    [20],
  );

  const firstCleanup = await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId: firstPendingDeleteId,
  });
  assert.equal(firstCleanup.cleanupScheduled, true);
  delivery = repository.state.get("key").delivery;
  assert.equal(delivery.pendingDelete.messageId, 20);
  const secondPendingDeleteId = delivery.pendingDelete.pendingDeleteId;

  await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId: secondPendingDeleteId,
  });
  delivery = repository.state.get("key").delivery;
  assert.equal(delivery.pendingDelete, undefined);
  assert.equal(delivery.pendingDeleteQueue, undefined);
  assert.equal(repository.state.get("key").applied.messageId, 30);
  assert.deepEqual(order, ["send:20", "send:30", "delete:10", "delete:20"]);
});

test("dispatcher enqueues every valid revision as a wake-up task", async () => {
  const desired = sendDesired();
  const enqueued = [];
  const dispatcher = createTelegramDeliveryDispatcher({
    enqueueTask: async (payload) => {
      enqueued.push(payload);
      return { enqueued: true };
    },
  });
  await dispatcher({
    messageKey: "key",
    revision: "old",
    generation: "generation-old",
  });
  await dispatcher({
    messageKey: "key",
    revision: desired.revision,
    generation: "generation-1",
  });
  assert.deepEqual(enqueued, [
    {
      messageKey: "key",
      revision: "old",
      taskKind: "desired",
      retrySequence: 0,
      generation: "generation-old",
    },
    {
      messageKey: "key",
      revision: desired.revision,
      taskKind: "desired",
      retrySequence: 0,
      generation: "generation-1",
    },
  ]);
  assert.equal(
    buildTelegramDeliveryTaskId("key", desired.revision, "generation-1"),
    buildTelegramDeliveryTaskId("key", desired.revision, "generation-1"),
  );
});

test("dispatcher rejects unsafe keys and skips incomplete identities", async () => {
  let enqueues = 0;
  const dispatcher = createTelegramDeliveryDispatcher({
    enqueueTask: async () => {
      enqueues += 1;
    },
  });
  await assert.rejects(
    () =>
      dispatcher({
        messageKey: "unsafe/key",
        revision: "revision",
        generation: "generation",
      }),
    TypeError,
  );
  assert.deepEqual(
    await dispatcher({
      messageKey: "key",
      revision: " ",
      generation: "generation",
    }),
    { skipped: true, reason: "missing-dispatch-identity" },
  );
  assert.deepEqual(
    await dispatcher({
      messageKey: "key",
      revision: "revision",
      generation: "",
    }),
    { skipped: true, reason: "missing-dispatch-identity" },
  );
  assert.equal(enqueues, 0);
});

test("manual recovery dispatcher creates an isolated recovery task", async () => {
  const enqueued = [];
  const dispatcher = createTelegramManualRecoveryDispatcher({
    enqueueTask: async (payload) => {
      enqueued.push(payload);
      return { enqueued: true };
    },
  });
  await dispatcher({
    messageKey: "key",
    requestId: "request-1",
    generation: "event-1",
  });
  assert.deepEqual(enqueued, [
    {
      messageKey: "key",
      revision: "manual-recovery",
      taskKind: "manual-recovery",
      retrySequence: 0,
      generation: "request-1:event-1",
    },
  ]);
});

test("A to B to A revision changes receive unique durable task generations", async () => {
  const desiredA = sendDesired({ text: "A", sourceRevision: "A" });
  const desiredB = sendDesired({ text: "B", sourceRevision: "B" });
  const enqueued = [];
  const dispatcher = createTelegramDeliveryDispatcher({
    enqueueTask: async (payload) => {
      enqueued.push({
        ...payload,
        taskId: buildTelegramDeliveryTaskId(
          payload.messageKey,
          payload.revision,
          payload.generation,
        ),
      });
      return { enqueued: true };
    },
  });

  await dispatcher({
    messageKey: "key",
    revision: desiredA.revision,
    generation: "event-a-1",
  });
  await dispatcher({
    messageKey: "key",
    revision: desiredB.revision,
    generation: "event-b",
  });
  await dispatcher({
    messageKey: "key",
    revision: desiredA.revision,
    generation: "event-a-2",
  });

  assert.deepEqual(
    enqueued.map(({ revision, generation }) => ({ revision, generation })),
    [
      { revision: desiredA.revision, generation: "event-a-1" },
      { revision: desiredB.revision, generation: "event-b" },
      { revision: desiredA.revision, generation: "event-a-2" },
    ],
  );
  assert.notEqual(enqueued[0].taskId, enqueued[2].taskId);
});

test("task enqueue signs and posts the normalized wake-up payload", async () => {
  const calls = [];
  const nowMs = 1_700_000_000_000;
  const input = {
    messageKey: "key",
    revision: "revision",
    taskKind: "desired",
    retrySequence: 0,
    generation: "generation",
  };
  const result = await enqueueTelegramDeliveryTask(input, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 202 });
    },
    now: () => nowMs,
    secret: "bridge-secret",
  });
  const body = JSON.stringify(input);
  const timestamp = String(Math.floor(nowMs / 1_000));
  assert.equal(
    calls[0].url,
    "https://api.mons.link/internal/telegram/delivery",
  );
  assert.equal(calls[0].init.body, body);
  assert.equal(calls[0].init.headers["X-Mons-Telegram-Timestamp"], timestamp);
  assert.equal(
    calls[0].init.headers["X-Mons-Telegram-Signature"],
    signTelegramBridgeRequest({ body, secret: "bridge-secret", timestamp }),
  );
  assert.equal(result.taskId, buildTelegramDeliveryTaskId(input));
});

test("task enqueue fails closed on bridge rejection and transport failure", async () => {
  const input = {
    messageKey: "key",
    revision: "revision",
    generation: "generation",
  };
  await assert.rejects(
    () =>
      enqueueTelegramDeliveryTask(input, {
        fetchImpl: async () => new Response(null, { status: 503 }),
        secret: "bridge-secret",
      }),
    { code: "telegram-queue-bridge-rejected", status: 503 },
  );
  await assert.rejects(
    () =>
      enqueueTelegramDeliveryTask(input, {
        fetchImpl: async () => {
          throw new Error("network failure");
        },
        secret: "bridge-secret",
      }),
    { code: "telegram-queue-bridge-unavailable" },
  );
});

test("Firebase dispatch exports retain retries and bind only the bridge secret", () => {
  assert.equal(dispatchTelegramDelivery.__endpoint.eventTrigger.retry, true);
  assert.equal(
    dispatchTelegramManualRecovery.__endpoint.eventTrigger.retry,
    true,
  );
  assert.deepEqual(
    dispatchTelegramDelivery.__endpoint.secretEnvironmentVariables.map(
      (secret) => secret.key,
    ),
    ["TELEGRAM_QUEUE_BRIDGE_SECRET"],
  );
  assert.deepEqual(
    dispatchTelegramManualRecovery.__endpoint.secretEnvironmentVariables.map(
      (secret) => secret.key,
    ),
    ["TELEGRAM_QUEUE_BRIDGE_SECRET"],
  );
});
