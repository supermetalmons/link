"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildEventTelegramProjection,
  buildEventTelegramProjectionUpdates,
} = require("./eventProjectionChangesFixture");
const {
  buildTelegramDeleteDesired,
  buildTelegramDeleteUpdates,
  buildTelegramEditDesired,
  buildTelegramEditUpdates,
  buildTelegramSendDesired,
  buildTelegramSendUpdates,
  resolveTelegramDestination,
  validateTelegramMessageKey,
} = require("./telegramDesiredFixture");
const {
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
} = require("../runtime/telegram/deliveryEngine");
const {
  createTelegramDeliveryControl,
} = require("../runtime/telegram/deliveryControl");
const {
  createTelegramDeliveryRecovery,
} = require("../runtime/telegram/deliveryRecovery");
const {
  buildTelegramDeliveryTaskId,
} = require("../runtime/telegram/taskIdentity");

/**
 * @typedef {import("../runtime/telegram/records").TelegramMessageDocument} Message
 * @typedef {import("../runtime/telegram/records").TelegramDeliveryDocument} Delivery
 * @typedef {import("../runtime/telegram/records").TelegramAppliedDocument} Applied
 * @typedef {import("../runtime/telegram/records").TelegramSendEvidence} SendEvidence
 * @typedef {import("../runtime/telegram/records").TelegramCleanupDocument} Cleanup
 * @typedef {Omit<Cleanup, "instanceKey" | "chatId" | "messageId"> & Partial<Pick<Cleanup, "instanceKey" | "chatId" | "messageId">>} CleanupFixture
 * @typedef {Omit<Cleanup, "instanceKey"> & Partial<Pick<Cleanup, "instanceKey">>} QueuedCleanupFixture
 * @typedef {Omit<Delivery, "sendInFlight" | "pendingDelete" | "pendingDeleteQueue"> & {sendInFlight?: Partial<SendEvidence>, pendingDelete?: CleanupFixture, pendingDeleteQueue?: Record<string, QueuedCleanupFixture>}} DeliveryFixture
 * @typedef {Omit<Partial<Message>, "applied" | "delivery"> & {applied?: Omit<Applied, "appliedAtMs" | "revision"> & Partial<Pick<Applied, "appliedAtMs" | "revision">>, delivery?: DeliveryFixture}} MessageFixture
 * @typedef {import("../runtime/telegram/deliveryTypes").TelegramRepository} Repository
 * @typedef {import("../runtime/telegram/records").TelegramApiGateWrite} ApiGate
 * @typedef {import("../runtime/telegram/deliveryTypes").TelegramRetrySchedule} ScheduledTask
 * @typedef {ReturnType<typeof createTelegramDeliveryEngine>} Engine
 * @typedef {boolean | (() => boolean)} FailureSwitch
 * @typedef {{retryNotBeforeMs?: number, apiGate?: ApiGate, rejectCommit?: (input: {messageKey: string, current: Message | null, output: {commit?: false, value?: Message | null, decision?: string}, transactionCount: number}) => unknown, rejectBarrierRead?: FailureSwitch, rejectBarrierWrite?: FailureSwitch, rejectApiGateWrite?: FailureSwitch, rejectApiGateRelease?: FailureSwitch, rejectBarrierProofWrite?: FailureSwitch}} RepositoryOptions
 * @typedef {Repository & {state: Map<string, Message> & {set(key: string, value: MessageFixture | null | undefined): Map<string, Message>}, control: {retryNotBeforeMs: number, apiGate?: ApiGate}, localRetryBarrier: import("../runtime/telegram/deliveryRetryTypes").TelegramLocalRetryBarrier}} TestRepository
 */
/** @template Value @param {Value} value @returns {Value} */
const clone = (value) => (value === undefined ? value : structuredClone(value));
/** @template Value @param {Value} value @returns {NonNullable<Value>} */
function present(value) {
  assert.ok(value !== null && value !== undefined);
  return value;
}
/** @param {import("../runtime/telegram/deliveryTypes").TelegramEngineResult} result */
function cleanupResult(result) {
  const cleanup = result.cleanup;
  assert.ok(cleanup && typeof cleanup === "object");
  return cleanup;
}
/** @param {unknown} value */
function desiredFixture(value) {
  const desired =
    require("../runtime/telegram/recordCodec").readTelegramDesired(value);
  assert.ok(desired);
  return desired;
}
/** @param {FailureSwitch | undefined} value */
const enabled = (value) => (typeof value === "function" ? value() : value);
/** @param {MessageFixture | null | undefined} input @returns {Message} */
const canonicalMessageFixture = (input) => {
  const value = { schemaVersion: /** @type {const} */ (1), ...clone(input) };
  const desired = value.desired;
  /** @type {Pick<Message, "applied" | "delivery">} */
  const completed = {};
  if (value.applied)
    completed.applied = {
      appliedAtMs: 1,
      revision: desired?.revision || "applied-revision",
      ...value.applied,
    };
  if (value.delivery) {
    const { sendInFlight, pendingDelete, pendingDeleteQueue, ...delivery } =
      value.delivery;
    const text =
      desired && desired.operation !== "delete" ? desired : undefined;
    completed.delivery = {
      ...delivery,
      ...(delivery.status === "delivered" &&
      delivery.deliveredAtMs === undefined
        ? { deliveredAtMs: 1 }
        : {}),
      ...(sendInFlight
        ? {
            sendInFlight: {
              attemptId: "fixture-attempt",
              revision: desired?.revision || "revision",
              destination: desired?.destination || "community",
              chatId: "community-chat",
              instanceKey:
                text?.instanceKey || value.applied?.instanceKey || "instance",
              contentHash: text?.contentHash || "content",
              startedAtMs: 1,
              apiGateOwner: "send:fixture-attempt",
              ...sendInFlight,
            },
          }
        : {}),
      ...(pendingDelete
        ? {
            pendingDelete: {
              instanceKey: "",
              chatId: "community-chat",
              messageId: 1,
              ...pendingDelete,
            },
          }
        : {}),
      ...(pendingDeleteQueue
        ? {
            pendingDeleteQueue: Object.fromEntries(
              Object.entries(pendingDeleteQueue).map(([key, item]) => [
                key,
                { instanceKey: "", ...item },
              ]),
            ),
          }
        : {}),
    };
  }
  return Object.assign(value, completed);
};

/** @param {Record<string, MessageFixture>} [initial] @param {RepositoryOptions} [options] @returns {TestRepository} */
const createRepository = (initial = {}, options = {}) => {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [
      key,
      canonicalMessageFixture(value),
    ]),
  );
  const setFixture = values.set.bind(values);
  const state = Object.assign(values, {
    /** @param {string} key @param {MessageFixture | null | undefined} value */
    set(key, value) {
      return setFixture(key, canonicalMessageFixture(value));
    },
  });
  /** @type {TestRepository["control"]} */
  const control = {
    retryNotBeforeMs:
      typeof options.retryNotBeforeMs === "number" &&
      Number.isFinite(options.retryNotBeforeMs) &&
      options.retryNotBeforeMs > 0
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
        "commit" in output ||
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
          ...(output.decision === undefined
            ? {}
            : { decision: output.decision }),
        };
      }
      state.set(messageKey, clone(output.value));
      return {
        committed: true,
        value: clone(output.value),
        ...(output.decision === undefined ? {} : { decision: output.decision }),
      };
    },
    async getRetryNotBeforeMs() {
      if (enabled(options.rejectBarrierRead)) {
        const error = new Error("retry-barrier-read-failed");
        Object.assign(error, { code: "retry-barrier-read-failed" });
        throw error;
      }
      return control.retryNotBeforeMs;
    },
    async extendRetryNotBeforeMs(candidateMs) {
      if (enabled(options.rejectBarrierWrite)) {
        const error = new Error("retry-barrier-write-failed");
        Object.assign(error, { code: "retry-barrier-write-failed" });
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
        Object.assign(error, { code: "api-gate-write-failed" });
        throw error;
      }
      if (control.retryNotBeforeMs > input.acquiredAtMs) {
        return {
          acquired: false,
          reason: "retry-after",
          retryNotBeforeMs: control.retryNotBeforeMs,
          gate: clone(control.apiGate ?? null),
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
        Object.assign(error, { code: "api-gate-release-failed" });
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
        Object.assign(error, { code: "retry-barrier-write-failed" });
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
          gate: null,
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
        gate: null,
      };
    },
  };
};

/**
 * @typedef {import("../runtime/telegram/client").TelegramFailure} Failure
 * @typedef {Pick<Failure, "ok" | "classification" | "code"> & Partial<Omit<Failure, "ok" | "classification" | "code">>} FailureFixture
 * @typedef {import("../runtime/telegram/client").TelegramSendSuccess} SendSuccess
 * @typedef {import("../runtime/telegram/client").TelegramEditSuccess} EditSuccess
 * @typedef {import("../runtime/telegram/client").TelegramDeleteSuccess} DeleteSuccess
 * @typedef {Pick<SendSuccess, "ok" | "messageId"> & Partial<Omit<SendSuccess, "ok" | "messageId">>} SendFixture
 * @typedef {Pick<EditSuccess, "ok"> & Partial<Omit<EditSuccess, "ok">>} EditFixture
 * @typedef {Pick<DeleteSuccess, "ok"> & Partial<Omit<DeleteSuccess, "ok">>} DeleteFixture
 * @typedef {{sendTelegramMessage?: (input: import("../runtime/telegram/client").TelegramSendInput) => Promise<SendFixture | FailureFixture>, editTelegramMessage?: (input: import("../runtime/telegram/client").TelegramEditInput) => Promise<EditFixture | FailureFixture>, deleteTelegramMessage?: (input: import("../runtime/telegram/client").TelegramDeleteInput) => Promise<DeleteFixture | FailureFixture>}} ClientFixture
 */
/** @param {FailureFixture} result @returns {Failure} */
function failureResult(result) {
  return {
    description: "",
    httpStatus: null,
    retryAfterSeconds: null,
    ...result,
  };
}
/** @param {ClientFixture} [overrides] @returns {import("../runtime/telegram/client").TelegramClient} */
const createClient = (overrides = {}) => ({
  async sendTelegramMessage(input) {
    const result = overrides.sendTelegramMessage
      ? await overrides.sendTelegramMessage(input)
      : { ok: /** @type {const} */ (true), messageId: 101 };
    return result.ok
      ? { outcome: "sent", httpStatus: 200, ...result }
      : failureResult(result);
  },
  async editTelegramMessage(input) {
    const result = overrides.editTelegramMessage
      ? await overrides.editTelegramMessage(input)
      : { ok: /** @type {const} */ (true) };
    return result.ok
      ? { outcome: "edited", httpStatus: 200, ...result }
      : failureResult(result);
  },
  async deleteTelegramMessage(input) {
    const result = overrides.deleteTelegramMessage
      ? await overrides.deleteTelegramMessage(input)
      : { ok: /** @type {const} */ (true) };
    return result.ok
      ? { outcome: "deleted", httpStatus: 200, ...result }
      : failureResult(result);
  },
});

/** @param {Omit<import("../runtime/telegram/deliveryTypes").TelegramEngineOptions, "repository" | "client"> & {repository: TestRepository, client?: import("../runtime/telegram/client").TelegramClient}} input */
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
      Reflect.apply(createTelegramDeliveryEngine, undefined, [
        {
          repository,
          scheduleRetry: async () => ({ scheduled: true }),
          localRetryBarrier: repository.localRetryBarrier,
        },
      ]),
    /complete Telegram client is required/,
  );
});

/** @param {Engine} engine @param {ScheduledTask | undefined} task */
const reconcileScheduledTask = (engine, task) => {
  assert.ok(task);
  return engine.reconcile({
    messageKey: task.messageKey,
    requestedRevision: task.revision,
    requestedGeneration: task.generation,
    taskKind: task.taskKind,
    retrySequence: task.retrySequence,
    ...(task.retryStartedAtMs === undefined
      ? {}
      : { retryStartedAtMs: task.retryStartedAtMs }),
    ...(task.retryDeadlineAtMs === undefined
      ? {}
      : { retryDeadlineAtMs: task.retryDeadlineAtMs }),
    ...(task.retryAtMs === undefined ? {} : { retryAtMs: task.retryAtMs }),
    ...(task.safeRejectedAttemptId === undefined
      ? {}
      : { safeRejectedAttemptId: task.safeRejectedAttemptId }),
    ...(task.pendingDeleteId === undefined
      ? {}
      : { pendingDeleteId: task.pendingDeleteId }),
    ...(task.retryProofLeaseOwner === undefined
      ? {}
      : { retryProofLeaseOwner: task.retryProofLeaseOwner }),
    ...(task.proofTaskKind === undefined
      ? {}
      : { proofTaskKind: task.proofTaskKind }),
    ...(task.barrierProofOwner === undefined
      ? {}
      : { barrierProofOwner: task.barrierProofOwner }),
    ...(task.barrierRetryNotBeforeMs === undefined
      ? {}
      : { barrierRetryNotBeforeMs: task.barrierRetryNotBeforeMs }),
    ...(task.apiGateReclaimOwner === undefined
      ? {}
      : { apiGateReclaimOwner: task.apiGateReclaimOwner }),
    ...(task.apiGateSettleOwner === undefined
      ? {}
      : { apiGateSettleOwner: task.apiGateSettleOwner }),
  });
};

/** @param {Partial<import("../runtime/telegram/desiredStateCore").TelegramSendDesiredInput>} [overrides] */
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

/** @param {Partial<import("../runtime/telegram/desiredStateCore").TelegramEditDesiredInput>} [overrides] */
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

test("builds deterministic desired state and multipath state updates", () => {
  /** @type {Parameters<typeof buildTelegramSendUpdates>[0]} */
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
  assert.equal(present(desired).schemaVersion, 2);
  assert.equal(present(desired).operation, "send");
  assert.equal(present(desired).sourceRevision, "3");
  assert.equal(present(desired).revision.length, 64);
  assert.equal(present(desired).contentHash.length, 64);
  assert.equal(JSON.stringify(desired).includes("chat_id"), false);

  const changedMode = buildTelegramSendDesired({
    ...input,
    parseMode: null,
  });
  const changedDestination = buildTelegramSendDesired({
    ...input,
    destination: "events",
  });
  assert.notEqual(present(desired).contentHash, changedMode.contentHash);
  assert.notEqual(present(desired).contentHash, changedDestination.contentHash);

  const edit = buildTelegramEditUpdates({
    ...input,
    ifMissing: "send",
  })["telegramMessages/automatch:invite-1/desired"];
  assert.equal(present(edit).operation, "edit");
  assert.equal(present(edit).ifMissing, "send");

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

test("validates record-safe logical message keys", () => {
  assert.equal(
    validateTelegramMessageKey("event:abc:upcoming"),
    "event:abc:upcoming",
  );
  for (const key of ["", " spaced", "a.b", "a#b", "a$b", "a/b", "a[b", "a]b"]) {
    assert.throws(() => validateTelegramMessageKey(key), TypeError);
  }
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
  assert.equal(present(present(state).applied).messageId, 55);
  assert.equal(present(present(state).applied).chatId, "community-chat");
  assert.equal(
    present(present(state).applied).contentHash,
    desired.contentHash,
  );
  assert.equal(present(present(state).delivery).status, "delivered");
  assert.equal(present(present(state).delivery).attempts, 1);
  assert.equal(
    Object.hasOwn(present(present(state).delivery), "leaseOwner"),
    false,
  );
});

test("settles a delete-only smoke record without calling Telegram", async () => {
  const desired = buildTelegramDeleteDesired({
    destination: "community",
    sourceRevision: "delete-only",
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
  assert.equal(present(repository.state.get("key")).applied, undefined);
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
  /** @type {string[]} */
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
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "pending",
  );
  assert.equal(
    present(present(repository.state.get("key")).delivery).revision,
    latest.revision,
  );
  assert.equal(
    present(present(repository.state.get("key")).delivery).attempts,
    0,
  );
  await engine.reconcile({ messageKey: "key" });
  assert.deepEqual(calls, ["send-initial", "edit-latest"]);
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "delivered",
  );
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
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "uncertain",
  );
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
  assert.equal(
    present(present(repository.state.get("first")).delivery).status,
    "uncertain",
  );
  assert.equal(
    present(present(repository.state.get("first")).delivery).apiGateSettleOwner,
    apiGateOwner,
  );
  assert.equal(present(repository.control.apiGate).owner, apiGateOwner);

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
  const delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).status, "retryable");
  assert.equal(present(delivery).retryAtMs, 18_000);
  assert.equal(Object.hasOwn(present(delivery), "sendInFlight"), false);
});

test("persists the global retry barrier before finalizing a rate limit", async () => {
  const desired = sendDesired();
  /** @type {string[]} */
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
  const delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).retryAtMs, 33_000);
  assert.equal(present(present(delivery).lastError).atMs, 25_000);
});

test("keeps a full bot-wide retry-after beyond the message retry deadline", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  /** @type {ScheduledTask[]} */
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
  assert.equal(
    present(present(repository.state.get("key")).delivery).retryDeadlineAtMs,
    610_000,
  );
  assert.equal(scheduled.length, 1);
  assert.equal(present(scheduled[0]).taskKind, "rate-limit-proof");
  assert.equal(present(scheduled[0]).proofTaskKind, "desired");
  assert.equal(present(scheduled[0]).barrierRetryNotBeforeMs, 910_000);
  assert.equal(present(scheduled[0]).scheduleTimeMs, 10_000);

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
  assert.equal(
    present(present(repository.state.get("key")).delivery).attempts,
    2,
  );
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
  const delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).status, "processing");
  assert.equal(present(delivery).leaseOwner, "owner-1");
  assert.equal(
    present(present(delivery).sendInFlight).revision,
    desired.revision,
  );
  assert.equal(present(delivery).safeRejectionAtMs, undefined);
  assert.equal(repository.control.retryNotBeforeMs, 0);
  assert.equal(repository.localRetryBarrier.getRetryNotBeforeMs(), 18_000);
  assert.equal(present(repository.control.apiGate).messageKey, "key");

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
  assert.equal(present(repository.control.apiGate).messageKey, "key");
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
  /** @type {ScheduledTask[]} */
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
  assert.equal(present(repository.control.apiGate).messageKey, "a");
  assert.equal(present(scheduled[0]).barrierRetryNotBeforeMs, 910_000);

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
  assert.equal(
    present(present(repository.state.get("a")).delivery).status,
    "retryable",
  );
  assert.equal(bSends, 0);
});

test("an immediate rate proof cannot leave a late proof-required marker", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  /** @type {ScheduledTask[]} */
  const scheduled = [];
  /** @type {Engine} */
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
    present(present(repository.state.get("key")).delivery).apiGateProofRequired,
    undefined,
  );
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "retryable",
  );
});

test("a cold native retry reconstructs a rate proof after enqueue failure", async () => {
  const desired = sendDesired();
  const repository = createRepository({ key: { desired } });
  let rejectEnqueue = true;
  let nowMs = 10_000;
  let sends = 0;
  /** @type {ScheduledTask[]} */
  const scheduled = [];
  /** @type {import("../runtime/telegram/deliveryTypes").TelegramRetryScheduler} */
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
  assert.equal(present(repository.control.apiGate).messageKey, "key");
  assert.equal(
    present(
      present(present(repository.state.get("key")).delivery)
        .apiGateProofRequired,
    ).proofTaskKind,
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
  assert.equal(present(scheduled[0]).taskKind, "rate-limit-proof");
  assert.equal(present(scheduled[0]).safeRejectedAttemptId, "attempt-1");
  assert.equal(repository.control.retryNotBeforeMs, 18_000);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(sends, 1);
});

test("a cold deadline wake cannot bypass an unresolved full rate barrier", async () => {
  const desired = sendDesired();
  let rejectBarrierProofWrite = true;
  let nowMs = 10_000;
  let sends = 0;
  /** @type {ScheduledTask[]} */
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
  /** @type {import("../runtime/telegram/deliveryTypes").TelegramRetryScheduler} */
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
  assert.equal(present(repository.control.apiGate).messageKey, "key");
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "processing",
  );

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
  /** @type {ScheduledTask[]} */
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
  /** @type {import("../runtime/telegram/deliveryTypes").TelegramRetryScheduler} */
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
  assert.equal(present(repository.control.apiGate).messageKey, "key");

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
  assert.equal(present(state).applied, undefined);
  assert.equal(
    present(present(present(state).delivery).sendInFlight).instanceKey,
    "waiting:invite-1",
  );
  assert.equal(present(present(state).delivery).revision, matched.revision);
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
  const delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).revision, changedWaiting.revision);
  assert.equal(
    present(present(delivery).sendInFlight).instanceKey,
    "waiting:invite-1",
  );
  assert.equal(Reflect.get(present(delivery), "unmanagedSend"), undefined);
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
  assert.equal(present(present(state).applied).messageId, 1);
  assert.equal(
    present(present(present(state).delivery).sendInFlight).instanceKey,
    "matched:invite-1",
  );
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
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "terminal",
  );
});

test("replaces a changed instance before independently deleting the old message", async () => {
  const desired = sendDesired({
    instanceKey: "matched:invite-1",
    text: "Alice vs Bob",
    sourceRevision: "matched",
  });
  /** @type {NonNullable<MessageFixture["applied"]>} */
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
  /** @type {string[]} */
  const order = [];
  const client = createClient({
    async sendTelegramMessage() {
      order.push("send");
      assert.equal(
        present(
          present(present(repository.state.get("key")).delivery).sendInFlight,
        ).revision,
        desired.revision,
      );
      return { ok: true, messageId: 20 };
    },
    async deleteTelegramMessage({ messageId }) {
      order.push("delete");
      assert.equal(messageId, 10);
      assert.equal(
        present(present(repository.state.get("key")).applied).messageId,
        20,
      );
      return { ok: true, outcome: "deleted" };
    },
  });
  /** @type {ScheduledTask[]} */
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
  assert.equal(present(present(state).applied).messageId, 20);
  assert.equal(present(present(state).delivery).status, "delivered");
  assert.equal(
    present(present(present(state).delivery).pendingDelete).messageId,
    10,
  );
  assert.equal(present(scheduled.at(-1)).taskKind, "pending-delete");

  await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId: present(present(present(state).delivery).pendingDelete)
      .pendingDeleteId,
  });
  assert.deepEqual(order, ["send", "delete"]);
  state = repository.state.get("key");
  assert.equal(present(present(state).delivery).pendingDelete, undefined);
  assert.equal(present(present(state).delivery).status, "delivered");
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
  assert.equal(present(present(state).applied).messageId, 10);
  assert.equal(
    present(present(present(state).delivery).sendInFlight).revision,
    desired.revision,
  );
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
  const pendingDeleteId = present(
    present(present(repository.state.get("key")).delivery).pendingDelete,
  ).pendingDeleteId;
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
    present(
      present(present(repository.state.get("key")).delivery).pendingDelete,
    ).messageId,
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
  const pendingDeleteId = present(
    present(present(repository.state.get("key")).delivery).pendingDelete,
  ).pendingDeleteId;
  const terminalCleanup = await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId,
  });
  assert.equal(terminalCleanup.status, "settled");
  assert.equal(cleanupResult(terminalCleanup).cleanup, "orphaned");
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "delivered",
  );
  assert.equal(
    present(present(repository.state.get("key")).delivery).pendingDelete,
    undefined,
  );
  assert.equal(
    present(
      Object.values(
        present(
          present(present(repository.state.get("key")).delivery)
            .orphanedDeletes,
        ),
      )[0],
    ).lastError.code,
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
  /** @type {{request?: import("../runtime/telegram/client").TelegramEditInput}} */
  const observedEdit = {};
  const result = await createEngine({
    repository,
    client: createClient({
      async editTelegramMessage(value) {
        observedEdit.request = value;
        return { ok: true, outcome: "not-modified" };
      },
    }),
  }).reconcile({ messageKey: "key" });
  assert.equal(result.status, "delivered");
  assert.equal(present(observedEdit.request).messageId, 3);
  assert.equal(
    present(present(repository.state.get("key")).applied).contentHash,
    desired.contentHash,
  );
});

test("handles missing edit targets according to ifMissing", async (t) => {
  /** @type {NonNullable<MessageFixture["applied"]>} */
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
    assert.equal(present(repository.state.get("key")).applied, undefined);
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
    assert.equal(
      present(present(repository.state.get("key")).applied).messageId,
      5,
    );
  });
});

test("manual event invite updates never resend a missing or deleted message", async (t) => {
  const eventId = "manual-event";
  const messageKey = `event:${eventId}:upcoming`;
  /** @type {NonNullable<MessageFixture["applied"]>} */
  const applied = {
    destination: "community",
    chatId: "community-chat",
    instanceKey: `${messageKey}:v2`,
    messageId: 42,
  };
  const projection = buildEventTelegramProjection({
    eventId,
    eventData: require("./fixtures/canonicalEvents").event({
      telegramDeliveryVersion: 2,
      telegramAnnouncements: { invite: false, matches: true, results: true },
      status: "scheduled",
      startAtMs: Date.UTC(2026, 7, 26, 17),
      participants: {},
      rounds: {},
    }),
    upcomingMessage: canonicalMessageFixture({ applied }),
    nowMs: Date.UTC(2026, 7, 25, 12),
  });
  const desired = desiredFixture(
    buildEventTelegramProjectionUpdates({ eventId, projection })[
      `telegramMessages/${messageKey}/desired`
    ],
  );
  for (const deleted of [false, true]) {
    await t.test(
      deleted ? "deleted at Telegram" : "receipt disappeared",
      async () => {
        const repository = createRepository({
          [messageKey]: { desired, ...(deleted ? { applied } : {}) },
        });
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
              sends++;
              return { ok: true, messageId: 43 };
            },
          }),
        }).reconcile({ messageKey });
        assert.equal(result.reason, "missing-skipped");
        assert.equal(sends, 0);
      },
    );
  }
});

test("stale cancellation preserves a different matched message", async () => {
  const desired = editDesired({
    instanceKey: "waiting:invite-1",
    text: "Alice canceled an automatch",
    ifMissing: "skip",
    sourceRevision: "canceled",
  });
  /** @type {NonNullable<MessageFixture["applied"]>} */
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
  assert.deepEqual(present(repository.state.get("key")).applied, {
    appliedAtMs: 1,
    ...matchedApplied,
  });
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "delivered",
  );
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
    assert.equal(
      present(present(repository.state.get("key")).delivery).status,
      "retryable",
    );
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
    assert.equal(
      present(present(repository.state.get("key")).applied).messageId,
      3,
    );
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
  /** @type {ScheduledTask[]} */
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
  assert.equal(present(scheduled[0]).safeRejectedAttemptId, "attempt-1");
  assert.equal(present(scheduled[0]).retryProofLeaseOwner, undefined);
  assert.equal(present(scheduled[0]).retryStartedAtMs, 10_000);
  assert.equal(present(scheduled[0]).retryDeadlineAtMs, 610_000);
  assert.equal(present(scheduled[0]).retryAtMs, 11_000);
  assert.equal(
    present(present(repository.state.get("key")).delivery).sendInFlight,
    undefined,
  );
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
      assert.equal(present(present(persisted).applied).messageId, 71);
      assert.equal(present(present(persisted).delivery).status, "delivered");
      assert.equal(
        present(present(persisted).delivery).sendInFlight,
        undefined,
      );
      assert.equal(
        present(present(persisted).delivery).apiGateSettleOwner,
        present(repository.control.apiGate).owner,
      );

      rejectRelease = false;
      const recovered = await createEngine({ repository, client }).reconcile({
        messageKey: "key",
      });
      assert.equal(recovered.status, "settled");
      assert.equal(sends, 1);
      assert.equal(repository.control.apiGate, undefined);
      assert.equal(
        present(present(repository.state.get("key")).delivery)
          .apiGateSettleOwner,
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
      assert.equal(present(repository.state.get("key")).applied, undefined);
      assert.equal(
        present(
          present(present(repository.state.get("key")).delivery).sendInFlight,
        ).attemptId,
        "attempt-1",
      );
      assert.equal(present(repository.control.apiGate).messageKey, "key");

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
        present(present(repository.state.get("key")).delivery)
          .apiGateSettleOwner,
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
    const terminal = present(repository.state.get("key")).delivery;
    assert.equal(present(terminal).status, "terminal");
    assert.equal(present(terminal).sendInFlight, undefined);
    assert.equal(
      present(present(terminal).lastError).code,
      "safe-retry-window-exhausted",
    );
    assert.equal(
      present(terminal).apiGateSettleOwner,
      present(repository.control.apiGate).owner,
    );
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
              instanceKey:
                ("instanceKey" in desired ? desired.instanceKey : undefined) ||
                "waiting:invite-1",
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
      const crashedDelivery = present(repository.state.get("key")).delivery;
      assert.equal(present(crashedDelivery).status, "delivered");
      assert.equal(
        present(crashedDelivery).apiGateSettleOwner,
        present(repository.control.apiGate).owner,
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
        present(present(repository.state.get("key")).delivery)
          .apiGateSettleOwner,
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
    const crashedDelivery = present(repository.state.get("key")).delivery;
    assert.equal(present(crashedDelivery).pendingDelete, undefined);
    assert.equal(
      present(crashedDelivery).pendingDeleteApiGateSettleOwner,
      present(repository.control.apiGate).owner,
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
    assert.equal(
      present(present(repository.state.get("key")).delivery).pendingDelete,
      undefined,
    );
  });
});

test("exact retry proofs settle gates left by retryable responses", async (t) => {
  await t.test("safe send", async () => {
    const desired = sendDesired();
    let rejectRelease = true;
    let nowMs = 10_000;
    let sends = 0;
    /** @type {ScheduledTask[]} */
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
    const strandedOwner = present(repository.control.apiGate).owner;
    assert.equal(present(scheduled[0]).apiGateSettleOwner, strandedOwner);

    rejectRelease = false;
    nowMs = 11_000;
    repository.localRetryBarrier = createTelegramLocalRetryBarrier();
    const recovered = await reconcileScheduledTask(engine, scheduled[0]);
    assert.equal(recovered.status, "delivered");
    assert.equal(sends, 2);
    assert.equal(repository.control.apiGate, undefined);
    assert.equal(
      present(present(repository.state.get("key")).applied).messageId,
      81,
    );
  });

  await t.test("desired edit", async () => {
    const desired = editDesired();
    let rejectRelease = true;
    let nowMs = 10_000;
    let edits = 0;
    /** @type {ScheduledTask[]} */
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
      present(scheduled[0]).apiGateSettleOwner,
      present(repository.control.apiGate).owner,
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
    /** @type {ScheduledTask[]} */
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
      present(scheduled[0]).apiGateSettleOwner,
      present(repository.control.apiGate).owner,
    );

    rejectRelease = false;
    nowMs = 11_000;
    const recovered = await reconcileScheduledTask(engine, scheduled[0]);
    assert.equal(cleanupResult(recovered).cleanup, "deleted");
    assert.equal(deletes, 2);
    assert.equal(repository.control.apiGate, undefined);
  });
});

test("a new desired revision durably settles a hard-crashed idempotent gate", async () => {
  const desiredA = editDesired({ text: "A", sourceRevision: "A" });
  const desiredB = editDesired({ text: "B", sourceRevision: "B" });
  let rejectRelease = false;
  let nowMs = 10_000;
  /** @type {string[]} */
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

  const gateAOwner = present(repository.control.apiGate).owner;
  assert.equal(
    present(
      present(present(repository.state.get("key")).delivery)
        .appliedStateUnknown,
    ).operation,
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
  assert.equal(present(repository.control.apiGate).owner, gateAOwner);
  assert.equal(
    present(present(repository.state.get("key")).delivery).apiGateSettleOwner,
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
    present(present(repository.state.get("key")).delivery).apiGateSettleOwner,
    undefined,
  );
  assert.equal(
    present(present(repository.state.get("key")).applied).contentHash,
    desiredB.contentHash,
  );
  assert.equal(
    present(present(repository.state.get("key")).delivery).appliedStateUnknown,
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
  /** @type {string[]} */
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
    present(
      present(present(repository.state.get("key")).delivery)
        .appliedStateUnknown,
    ).operation,
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
  assert.equal(
    present(present(repository.state.get("key")).applied).messageId,
    4,
  );
  assert.equal(
    present(present(repository.state.get("key")).delivery).appliedStateUnknown,
    undefined,
  );
});

test("a new cleanup wake-up reclaims the current hard-crashed cleanup gate", async () => {
  const desired = sendDesired();
  let nowMs = 10_000;
  let deletes = 0;
  /** @type {ScheduledTask[]} */
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
  const crashedOwner = present(repository.control.apiGate).owner;

  nowMs = 71_000;
  const wakeup = await engine.reconcile({
    messageKey: "key",
    requestedGeneration: "different-desired-wakeup",
  });
  assert.equal(wakeup.cleanupScheduled, true);
  const cleanupTask = scheduled.at(-1);
  assert.equal(present(cleanupTask).taskKind, "pending-delete");
  assert.notEqual(present(cleanupTask).generation, "cleanup-original");

  const recovered = await reconcileScheduledTask(engine, cleanupTask);
  assert.equal(cleanupResult(recovered).cleanup, "deleted");
  assert.equal(deletes, 2);
  assert.equal(repository.control.apiGate, undefined);
  assert.equal(
    present(present(repository.state.get("key")).delivery).pendingDelete,
    undefined,
  );
  assert.notEqual(crashedOwner, "");
});

test("a newer desired API settles an expired cleanup gate before proceeding", async () => {
  const desiredA = sendDesired({ text: "A", sourceRevision: "A" });
  const desiredB = editDesired({ text: "B", sourceRevision: "B" });
  let nowMs = 10_000;
  let edits = 0;
  let deletes = 0;
  /** @type {ScheduledTask[]} */
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
  assert.equal(present(cleanupTask).taskKind, "pending-delete");
  const cleaned = await reconcileScheduledTask(engine, cleanupTask);
  assert.equal(cleanupResult(cleaned).cleanup, "deleted");
  assert.equal(deletes, 2);
  assert.equal(
    present(present(repository.state.get("key")).delivery).pendingDelete,
    undefined,
  );
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
            instanceKey:
              ("instanceKey" in desired ? desired.instanceKey : undefined) ||
              "old",
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
      assert.equal(present(repository.control.apiGate).messageKey, "key");

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
        present(present(repository.state.get("key")).delivery)
          .apiGateSettleOwner,
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
    assert.equal(cleanupResult(expired).cleanup, "exhausted");
    assert.equal(deletes, 1);
    assert.equal(repository.control.apiGate, undefined);
    assert.equal(
      present(
        present(
          present(present(repository.state.get("key")).delivery)
            .orphanedDeletes,
        )["expired-cleanup"],
      ).lastError.code,
      "safe-retry-window-exhausted",
    );
  });
});

test("proof payload bounds an idempotent retry when state finalization failed", async () => {
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
  /** @type {ScheduledTask[]} */
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
  assert.equal(
    present(present(repository.state.get("key")).delivery).status,
    "processing",
  );
  assert.equal(present(scheduled[0]).retrySequence, 1);

  nowMs = present(present(scheduled[0]).retryDeadlineAtMs);
  const result = await engine.reconcile({
    messageKey: "key",
    requestedRevision: present(scheduled[0]).revision,
    requestedGeneration: present(scheduled[0]).generation,
    taskKind: present(scheduled[0]).taskKind,
    retrySequence: present(scheduled[0]).retrySequence,
    retryStartedAtMs: present(present(scheduled[0]).retryStartedAtMs),
    retryDeadlineAtMs: present(present(scheduled[0]).retryDeadlineAtMs),
    retryAtMs: present(present(scheduled[0]).retryAtMs),
    retryProofLeaseOwner: present(present(scheduled[0]).retryProofLeaseOwner),
  });
  assert.equal(result.status, "terminal");
  assert.equal(result.reason, "safe-retry-window-exhausted");
  assert.equal(edits, 1);
  assert.equal(
    present(present(repository.state.get("key")).delivery).deadLetterAtMs,
    nowMs,
  );
});

test("proof payload bounds pending cleanup when state finalization failed", async () => {
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
  /** @type {ScheduledTask[]} */
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
    present(
      present(present(repository.state.get("key")).delivery).pendingDelete,
    ).status,
    "processing",
  );

  nowMs = present(present(scheduled[0]).retryDeadlineAtMs);
  await engine.reconcile({
    messageKey: "key",
    requestedRevision: present(scheduled[0]).revision,
    requestedGeneration: present(scheduled[0]).generation,
    taskKind: "pending-delete",
    pendingDeleteId: present(present(scheduled[0]).pendingDeleteId),
    retrySequence: present(scheduled[0]).retrySequence,
    retryStartedAtMs: present(present(scheduled[0]).retryStartedAtMs),
    retryDeadlineAtMs: present(present(scheduled[0]).retryDeadlineAtMs),
    retryAtMs: present(present(scheduled[0]).retryAtMs),
    retryProofLeaseOwner: present(present(scheduled[0]).retryProofLeaseOwner),
  });
  const delivery = present(repository.state.get("key")).delivery;
  assert.equal(deletes, 1);
  assert.equal(present(delivery).status, "delivered");
  assert.equal(present(delivery).pendingDelete, undefined);
  assert.equal(
    present(present(present(delivery).orphanedDeletes)["cleanup-1"]).lastError
      .code,
    "safe-retry-window-exhausted",
  );
});

test("global deferral persists a bounded retry window", async () => {
  const desired = sendDesired();
  const repository = createRepository(
    { key: { desired } },
    { retryNotBeforeMs: 3_610_000 },
  );
  /** @type {ScheduledTask[]} */
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
  const retrying = present(repository.state.get("key")).delivery;
  assert.equal(present(retrying).retryStartedAtMs, 10_000);
  assert.equal(present(retrying).retryDeadlineAtMs, 610_000);
  assert.equal(present(scheduled[0]).scheduleTimeMs, 610_000);

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
        const delivery = present(repository.state.get("key")).delivery;
        assert.equal(present(delivery).status, "retryable");
        assert.equal(present(delivery).retryDeadlineAtMs, 610_000);
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
      present(present(repository.state.get("key")).delivery).retryDeadlineAtMs,
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
            const delivery = present(repository.state.get("key")).delivery;
            assert.equal(present(delivery).status, "retryable");
            assert.equal(present(delivery).sendInFlight, undefined);
            assert.equal(present(delivery).retryDeadlineAtMs, 610_000);
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
            const pendingDelete = present(
              present(repository.state.get("key")).delivery,
            ).pendingDelete;
            assert.equal(present(pendingDelete).status, "retryable");
            assert.equal(present(pendingDelete).retryDeadlineAtMs, 610_000);
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
      present(
        present(present(repository.state.get("key")).delivery).pendingDelete,
      ).retryDeadlineAtMs,
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
      /** @type {MessageFixture} */
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
          instanceKey:
            ("instanceKey" in desired ? desired.instanceKey : undefined) ||
            "old",
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
    const delivery = present(repository.state.get("key")).delivery;
    assert.equal(present(delivery).status, "delivered");
    assert.equal(present(delivery).pendingDelete, undefined);
    assert.equal(
      present(present(present(delivery).orphanedDeletes)["cleanup-deadline"])
        .lastError.code,
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
    const delivery = present(repository.state.get("key")).delivery;
    assert.equal(present(delivery).pendingDelete, undefined);
    assert.equal(
      present(
        present(present(delivery).orphanedDeletes)["cleanup-read-deadline"],
      ).lastError.code,
      "safe-retry-window-exhausted",
    );
  });
});

test("stale retry proofs preserve newer desired and cleanup leases", async (t) => {
  await t.test("desired A proof cannot clear a recreated A lease", async () => {
    const desired = editDesired({ text: "A", sourceRevision: "A" });
    const interveningDesired = editDesired({ text: "B", sourceRevision: "B" });
    assert.notEqual(desired.revision, interveningDesired.revision);
    /** @type {ScheduledTask[]} */
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
      present(present(repository.state.get("key")).delivery).leaseOwner,
      "newer-worker",
    );
    assert.equal(present(scheduled[0]).retryStartedAtMs, 1_000);
    assert.equal(present(scheduled[0]).retryDeadlineAtMs, 30_000);
    assert.equal(present(scheduled[0]).retryProofLeaseOwner, undefined);
    assert.notEqual(present(scheduled[0]).generation, "running-task");
    assert.notEqual(
      buildTelegramDeliveryTaskId({
        schemaVersion: 1,
        dataEpoch: 1,
        messageKey: "key",
        revision: desired.revision,
        taskKind: "desired",
        retrySequence: 2,
        generation: "running-task",
      }),
      buildTelegramDeliveryTaskId(present(scheduled[0])),
    );
  });

  await t.test(
    "cleanup proof cannot clear a recreated cleanup lease",
    async () => {
      const desired = sendDesired();
      /** @type {ScheduledTask[]} */
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
      assert.equal(cleanupResult(result).status, "retryable");
      assert.equal(
        present(
          present(present(repository.state.get("key")).delivery).pendingDelete,
        ).leaseOwner,
        "newer-cleanup",
      );
      assert.equal(present(scheduled[0]).retryStartedAtMs, 1_000);
      assert.equal(present(scheduled[0]).retryDeadlineAtMs, 30_000);
      assert.equal(present(scheduled[0]).retryProofLeaseOwner, undefined);
      assert.notEqual(present(scheduled[0]).generation, "running-cleanup");
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
    present(present(repository.state.get("key")).delivery).leaseOwner,
    "desired-worker",
  );
});

test("a delayed A barrier proof cannot release B's revision-scoped gate", async () => {
  const desiredA = editDesired({ text: "A", sourceRevision: "A" });
  const desiredB = editDesired({ text: "B", sourceRevision: "B" });
  let rejectBarrierProofWrite = true;
  let nowMs = 10_000;
  let edits = 0;
  /** @type {ScheduledTask[]} */
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
  /** @type {Delivery} */
  const deliveryB = {
    ...present(present(repository.state.get("key")).delivery),
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
  assert.equal(
    present(present(repository.state.get("key")).delivery).apiGateOwner,
    gateBOwner,
  );
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
  assert.equal(
    present(present(present(state).delivery).sendInFlight).attemptId,
    "active-attempt",
  );
  assert.equal(
    present(present(state).delivery).lastRecoveryRequestId,
    "recovery-active",
  );
  assert.equal(present(present(state).manualRecoveryResult).status, "rejected");
  assert.equal(
    present(present(state).manualRecoveryResult).code,
    "recovery-not-uncertain",
  );
  const processedAtMs = present(
    present(state).manualRecoveryResult,
  ).processedAtMs;
  await engine.reconcile({ messageKey: "key" });
  assert.equal(
    present(present(repository.state.get("key")).manualRecoveryResult)
      .processedAtMs,
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
  const delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).status, "uncertain");
  assert.equal(present(delivery).revision, latestDesired.revision);
  assert.equal(
    present(present(delivery).sendInFlight).revision,
    firstDesired.revision,
  );
  assert.equal(present(present(delivery).lastError).code, "timeout");
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
      ...present(present(repository.state.get("key")).delivery),
      appliedStateUnknown: {
        revision: "older-edit",
        operation: "edit",
        apiGateOwner: "older-edit-gate",
        markedAtMs: 1,
      },
    },
    manualRecovery: { requestId: "abandon-1", action: "abandon" },
  });
  const abandoned = await engine.reconcile({ messageKey: "key" });
  assert.equal(abandoned.status, "terminal");
  let delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).sendInFlight, undefined);
  assert.equal(present(present(delivery).abandonedSend).attemptId, "attempt-1");
  assert.equal(
    present(present(delivery).appliedStateUnknown).operation,
    "edit",
  );

  const latest = sendDesired({ text: "next", sourceRevision: "next" });
  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: latest,
  });
  const delivered = await engine.reconcile({ messageKey: "key" });
  assert.equal(delivered.status, "delivered");
  assert.equal(sends, 2);
  delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).status, "delivered");
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
      ...present(present(repository.state.get("key")).delivery),
      appliedStateUnknown: {
        revision: "older-edit",
        operation: "edit",
        apiGateOwner: "older-edit-gate",
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
  assert.equal(
    present(present(repository.state.get("key")).applied).messageId,
    77,
  );
  assert.equal(
    present(present(repository.state.get("key")).manualRecoveryResult).status,
    "accepted",
  );
  assert.equal(
    present(present(repository.state.get("key")).delivery).appliedStateUnknown,
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
  const crashedGateOwner = present(repository.control.apiGate).owner;
  assert.equal(
    present(present(present(repository.state.get("key")).delivery).sendInFlight)
      .apiGateOwner,
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
    present(present(repository.state.get("key")).delivery).apiGateReleaseOwner,
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
  /** @type {number[]} */
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
  assert.equal(present(present(record).applied).messageId, 77);
  assert.equal(
    present(present(present(record).delivery).pendingDelete).messageId,
    10,
  );
  assert.equal(sends, 1);

  const pendingDeleteId = present(
    present(present(record).delivery).pendingDelete,
  ).pendingDeleteId;
  await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId,
  });
  record = repository.state.get("key");
  assert.equal(present(present(record).applied).messageId, 77);
  assert.equal(present(present(record).delivery).pendingDelete, undefined);
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
  assert.equal(
    present(present(repository.state.get("key")).applied).messageId,
    88,
  );
  assert.equal(
    present(present(repository.state.get("key")).manualRecoveryResult).status,
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
  /** @type {string[]} */
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
          present(present(repository.state.get("key")).delivery).revision,
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
  const delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).status, "delivered");
  assert.equal(present(delivery).revision, desired.revision);
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
  /** @type {string[]} */
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
  const firstPendingDeleteId = present(
    present(present(repository.state.get("key")).delivery).pendingDelete,
  ).pendingDeleteId;
  repository.state.set("key", {
    ...repository.state.get("key"),
    desired: secondReplacement,
  });
  await engine.reconcile({ messageKey: "key" });

  let delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(present(delivery).pendingDelete).messageId, 10);
  assert.deepEqual(
    Object.values(present(present(delivery).pendingDeleteQueue)).map(
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
  delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(present(delivery).pendingDelete).messageId, 20);
  const secondPendingDeleteId = present(
    present(delivery).pendingDelete,
  ).pendingDeleteId;

  await engine.reconcile({
    messageKey: "key",
    taskKind: "pending-delete",
    pendingDeleteId: secondPendingDeleteId,
  });
  delivery = present(repository.state.get("key")).delivery;
  assert.equal(present(delivery).pendingDelete, undefined);
  assert.equal(present(delivery).pendingDeleteQueue, undefined);
  assert.equal(
    present(present(repository.state.get("key")).applied).messageId,
    30,
  );
  assert.deepEqual(order, ["send:20", "send:30", "delete:10", "delete:20"]);
});

test("A to B to A revisions retain distinct durable task generations", () => {
  const desiredA = sendDesired({ text: "A", sourceRevision: "A" });
  const desiredB = sendDesired({ text: "B", sourceRevision: "B" });
  const taskIds = /** @type {[string, string][]} */ ([
    [desiredA.revision, "event-a-1"],
    [desiredB.revision, "event-b"],
    [desiredA.revision, "event-a-2"],
  ]).map(([revision, generation]) =>
    buildTelegramDeliveryTaskId({
      schemaVersion: 1,
      dataEpoch: 1,
      messageKey: "key",
      revision,
      generation,
      taskKind: "desired",
      retrySequence: 0,
    }),
  );
  assert.equal(new Set(taskIds).size, 3);
  assert.equal(
    taskIds[0],
    buildTelegramDeliveryTaskId({
      schemaVersion: 1,
      dataEpoch: 1,
      messageKey: "key",
      revision: desiredA.revision,
      generation: "event-a-1",
      taskKind: "desired",
      retrySequence: 0,
    }),
  );
});

test("retry coordination preserves scheduled proof payloads and generations", async (t) => {
  for (const target of /** @type {const} */ (["desired", "pending-delete"])) {
    for (const rateLimited of [false, true]) {
      await t.test(`${target} rateLimited=${rateLimited}`, async () => {
        const desired = sendDesired();
        const pendingDeleteId = "payload-cleanup";
        const repository = createRepository({
          key: {
            desired,
            ...(target === "pending-delete"
              ? {
                  delivery: {
                    status: "delivered",
                    revision: desired.revision,
                    pendingDelete: {
                      pendingDeleteId,
                      chatId: "community-chat",
                      messageId: 8,
                      status: "pending",
                      attempts: 0,
                    },
                  },
                }
              : {}),
          },
        });
        /** @type {ScheduledTask[]} */
        const scheduled = [];
        let gateOwner;
        /** @returns {Promise<FailureFixture>} */
        const reject = async () => {
          gateOwner = present(repository.control.apiGate).owner;
          return {
            ok: false,
            classification: "retryable",
            code: rateLimited ? "rate-limited" : "safe-rejection",
            retryAfterSeconds: 8,
          };
        };
        await createEngine({
          repository,
          scheduleRetry: async (task) => {
            scheduled.push(task);
            return { scheduled: true };
          },
          client: createClient({
            sendTelegramMessage: reject,
            deleteTelegramMessage: reject,
          }),
        }).reconcile({
          messageKey: "key",
          taskKind: target,
          ...(target === "pending-delete" ? { pendingDeleteId } : {}),
        });
        const taskKind = rateLimited ? "rate-limit-proof" : target;
        const retryProofLeaseOwner = target === "desired" ? "" : "owner-1";
        assert.deepEqual(scheduled, [
          {
            schemaVersion: 1,
            dataEpoch: 1,
            messageKey: "key",
            revision: desired.revision,
            taskKind,
            retrySequence: 1,
            generation: [
              taskKind,
              1,
              18_000,
              target === "desired" ? "attempt-1" : pendingDeleteId,
              retryProofLeaseOwner,
              "",
              rateLimited ? target : "",
              rateLimited ? gateOwner : "",
              rateLimited ? 18_000 : 0,
              "",
              rateLimited ? "" : gateOwner,
            ].join(":"),
            retryStartedAtMs: 10_000,
            retryDeadlineAtMs: 610_000,
            retryAtMs: 18_000,
            scheduleTimeMs: rateLimited ? 10_000 : 18_000,
            ...(target === "desired"
              ? { safeRejectedAttemptId: "attempt-1" }
              : { pendingDeleteId, retryProofLeaseOwner }),
            ...(rateLimited
              ? {
                  proofTaskKind: target,
                  barrierProofOwner: gateOwner,
                  barrierRetryNotBeforeMs: 18_000,
                }
              : { apiGateSettleOwner: gateOwner }),
          },
        ]);
      });
    }
  }
});

test("persisted rate proofs retain recovery state when retry delivery fails", async (t) => {
  for (const kind of /** @type {const} */ (["desired", "pending-delete"])) {
    for (const failure of [
      "enqueue",
      "barrier-error",
      "barrier-unapplied",
      "recovery-write",
    ]) {
      await t.test(`${kind} ${failure}`, async () => {
        const desired = sendDesired();
        const proof = {
          owner: "rate-gate",
          revision: desired.revision,
          retryStartedAtMs: 10_000,
          retryDeadlineAtMs: 610_000,
          retryAtMs: 18_000,
          retrySequence: 1,
          retryNotBeforeMs: 18_000,
          retryProofLeaseOwner: "owner-1",
          ...(kind === "desired"
            ? { safeRejectedAttemptId: "attempt-1" }
            : { pendingDeleteId: "cleanup-1" }),
        };
        /** @type {Pick<Delivery, "status" | "revision" | "leaseOwner" | "leaseExpiresAtMs" | "apiGateOwner" | "apiGateProofRequired"> & {status: "processing"}} */
        const processing = {
          status: "processing",
          revision: desired.revision,
          leaseOwner: "owner-1",
          leaseExpiresAtMs: 70_000,
          apiGateOwner: proof.owner,
          apiGateProofRequired: proof,
        };
        /** @type {MessageFixture} */
        const initial = {
          desired,
          delivery:
            kind === "desired"
              ? {
                  ...processing,
                  sendInFlight: {
                    attemptId: "attempt-1",
                    revision: desired.revision,
                  },
                }
              : {
                  status: "delivered",
                  revision: desired.revision,
                  pendingDelete: {
                    ...(({ revision: _revision, ...cleanup }) => cleanup)(
                      processing,
                    ),
                    pendingDeleteId: "cleanup-1",
                  },
                },
        };
        const repository = createRepository(
          { key: initial },
          {
            apiGate: {
              owner:
                failure === "barrier-unapplied" ? "newer-gate" : proof.owner,
              messageKey: "key",
              revision: desired.revision,
              operation: kind === "desired" ? "send" : "pending-delete",
              acquiredAtMs: 1000,
            },
            rejectBarrierProofWrite: failure === "barrier-error",
          },
        );
        if (failure === "recovery-write") {
          repository.transactMessage = async () => {
            throw new Error("recovery-write-failed");
          };
        }
        /** @type {ScheduledTask[]} */
        const scheduled = [];
        const control = createTelegramDeliveryControl({
          repository,
          logger: { error() {}, info() {} },
          now: () => 71_000,
          localRetryBarrier: repository.localRetryBarrier,
          scheduleRetry: async (task) => {
            assert.deepEqual(
              repository.state.get("key"),
              canonicalMessageFixture(initial),
            );
            assert.ok(repository.control.apiGate);
            if (failure === "enqueue") throw new Error("queue-unavailable");
            scheduled.push(task);
            return { scheduled: true };
          },
        });
        const recovery = createTelegramDeliveryRecovery({
          repository,
          now: () => 71_000,
          control,
        });
        const resume = () =>
          recovery.resumeRateLimitProof({
            messageKey: "key",
            proof,
            requestedRevision: desired.revision,
            nowMs: 71_000,
            target: { kind },
          });
        if (failure === "enqueue" || failure === "recovery-write") {
          await assert.rejects(
            resume,
            failure === "enqueue"
              ? /queue-unavailable/
              : /recovery-write-failed/,
          );
        } else {
          await resume();
        }
        assert.deepEqual(
          repository.state.get("key"),
          canonicalMessageFixture(initial),
        );
        assert.equal(scheduled.length, failure === "enqueue" ? 0 : 1);
        if (scheduled.length) {
          assert.equal(present(scheduled[0]).taskKind, "rate-limit-proof");
          assert.equal(present(scheduled[0]).proofTaskKind, kind);
          assert.equal(present(scheduled[0]).scheduleTimeMs, 71_000);
        }
        assert.equal(
          repository.control.retryNotBeforeMs,
          failure === "recovery-write" ? 18_000 : 0,
        );
        assert.equal(
          Boolean(repository.control.apiGate),
          failure !== "recovery-write",
        );
      });
    }
  }
});

test("persisted cleanup proofs use a requested ID only for cleanup wakes", async (t) => {
  for (const scenario of [
    { name: "desired wake", expectedStatus: "processing" },
    {
      name: "cleanup wake fallback",
      requestedPendingDeleteId: " cleanup-1 ",
      expectedScheduledId: "cleanup-1",
      expectedStatus: "retryable",
    },
    {
      name: "stored ID wins",
      requestedPendingDeleteId: "different-cleanup",
      storedPendingDeleteId: "cleanup-1",
      expectedScheduledId: "cleanup-1",
      expectedStatus: "retryable",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const desired = sendDesired();
      const proof = {
        owner: "rate-gate",
        revision: desired.revision,
        retryStartedAtMs: 10_000,
        retryDeadlineAtMs: 610_000,
        retryAtMs: 18_000,
        retrySequence: 1,
        retryNotBeforeMs: 18_000,
        retryProofLeaseOwner: "owner-1",
        ...(scenario.storedPendingDeleteId
          ? { pendingDeleteId: scenario.storedPendingDeleteId }
          : {}),
      };
      const repository = createRepository(
        {
          key: {
            desired,
            delivery: {
              status: "delivered",
              revision: desired.revision,
              pendingDelete: {
                pendingDeleteId: "cleanup-1",
                status: "processing",
                leaseOwner: "owner-1",
                leaseExpiresAtMs: 70_000,
                apiGateOwner: proof.owner,
                apiGateProofRequired: proof,
              },
            },
          },
        },
        {
          apiGate: {
            owner: proof.owner,
            messageKey: "key",
            revision: desired.revision,
            operation: "pending-delete",
            acquiredAtMs: 1000,
          },
        },
      );
      /** @type {ScheduledTask[]} */
      const scheduled = [];
      const control = createTelegramDeliveryControl({
        repository,
        logger: { error() {}, info() {} },
        now: () => 71_000,
        localRetryBarrier: repository.localRetryBarrier,
        scheduleRetry: async (task) => {
          scheduled.push(task);
          return { scheduled: true };
        },
      });
      const recovery = createTelegramDeliveryRecovery({
        repository,
        now: () => 71_000,
        control,
      });
      await recovery.resumeRateLimitProof({
        messageKey: "key",
        proof,
        requestedRevision: desired.revision,
        nowMs: 71_000,
        target: {
          kind: "pending-delete",
          ...(scenario.requestedPendingDeleteId === undefined
            ? {}
            : { requestedPendingDeleteId: scenario.requestedPendingDeleteId }),
        },
      });
      assert.equal(scheduled.length, 1);
      assert.equal(
        present(scheduled[0]).pendingDeleteId,
        scenario.expectedScheduledId,
      );
      const pendingDelete = present(
        present(repository.state.get("key")).delivery,
      ).pendingDelete;
      assert.equal(present(pendingDelete).status, scenario.expectedStatus);
      assert.equal(present(pendingDelete).apiGateProofRequired, undefined);
      assert.equal(repository.control.retryNotBeforeMs, 18_000);
      assert.equal(repository.control.apiGate, undefined);
    });
  }
});
