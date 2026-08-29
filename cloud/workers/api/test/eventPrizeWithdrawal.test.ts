import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventPrizeWithdrawalOperationId,
  createEventPrizeRuntimeDependencies,
  createEventPrizeExecutionProfileReader,
  executeEventPrizeWithdrawal,
  handleEventPrizeWithdrawalRoute,
  parseEventPrizeWithdrawalWorkflowParams,
  resolveEventPrizeWithdrawalExecutionParams,
  type EventPrizeWithdrawalWorkflowInput,
} from "../src/eventPrizeWithdrawal.ts";
import type { AuthFirestoreClient } from "../src/authFirestore.ts";
import type { EventPrizeWithdrawalStore } from "../src/eventPrizeWithdrawalD1.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const profileId = "profile-1";
const uid = "login-1";
const recipientAddress = "11111111111111111111111111111111";
const adminAddress = "Ay1mgqJr6WmihsSYdMZ1dkHL5r25N7VhCGk7NpCJcPGi";

function frozenWithdrawalDb(): D1Database {
  return {
    prepare: () =>
      ({
        first: async () => ({
          previous_storage_mode: "d1",
          storage_mode: "frozen",
        }),
      }) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
}

function firestore(): AuthFirestoreClient {
  const profile = {
    fields: {},
    id: profileId,
    name: `projects/mons-link/databases/(default)/documents/users/${profileId}`,
    rawFields: {},
    updateTime: "2026-08-27T00:00:00Z",
  };
  return {
    batchGet: async () => new Map(),
    commitWrites: async () => undefined,
    createDocumentId: () => "document-id",
    get: async () => null,
    listPage: async () => ({ documents: [], nextPageToken: "" }),
    query: async () => [profile],
    runTransaction: async (work) =>
      (
        await work({
          batchGet: async () => new Map(),
          query: async () => [profile],
        })
      ).result,
  };
}

function repository() {
  const values = new Map<string, unknown>([
    [
      `profileEventPrizes/${profileId}/${eventId}`,
      { eventId, place: 1, prizeId, profileId },
    ],
  ]);
  const value: GameplayRepository = {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => profileId,
    getGameplayProfile: async () => null,
    getMiningMaterials: async () => ({
      dust: 0,
      gum: 0,
      ice: 0,
      metal: 0,
      slime: 0,
    }),
    getMiningSnapshot: async () => null,
    getNavigationGame: async () => null,
    getRtdbPath: async (path) => values.get(path) ?? null,
    patchRtdbRoot: async (updates) => {
      for (const [path, next] of Object.entries(updates)) {
        if (next === null) values.delete(path);
        else values.set(path, next);
      }
    },
    transactRtdbPath: async (path, updater) => {
      const current = values.get(path) ?? null;
      const decision = updater(current) as {
        commit?: false;
        decision?: string;
        value?: unknown;
      };
      if (decision.commit === false) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      values.set(path, decision.value);
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
  };
  const withdrawalStore: EventPrizeWithdrawalStore = {
    async get(candidateEventId, candidatePrizeId) {
      return (
        (values.get(
          `eventPrizeWithdrawals/${candidateEventId}/${candidatePrizeId}`,
        ) as Record<string, unknown> | undefined) ?? null
      );
    },
    reference(candidateEventId, candidatePrizeId) {
      const path = `eventPrizeWithdrawals/${candidateEventId}/${candidatePrizeId}`;
      const read = () => values.get(path) ?? null;
      return {
        async once() {
          const current = read();
          return {
            exists: () => current !== null && current !== undefined,
            val: () => current,
          };
        },
        async transaction(updater) {
          const current = read();
          const next = updater(current);
          if (next === undefined) {
            return {
              committed: false,
              snapshot: { exists: () => current !== null, val: () => current },
            };
          }
          if (next === null) values.delete(path);
          else values.set(path, next);
          return {
            committed: true,
            snapshot: { exists: () => next !== null, val: () => next },
          };
        },
        async update(updates) {
          values.set(path, {
            ...((read() as Record<string, unknown> | null) || {}),
            ...updates,
          });
        },
      };
    },
    async replacePaths(updates) {
      for (const [path, next] of Object.entries(updates)) {
        if (next === null) values.delete(path);
        else values.set(path, next);
      }
    },
  };
  return { value, values, withdrawalStore };
}

test("read-only prize runtime preflight can inspect frozen storage", async () => {
  const state = repository();
  const env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PRIZE_WITHDRAWALS_DB: frozenWithdrawalDb(),
  } as unknown as Env;
  await assert.rejects(
    createEventPrizeRuntimeDependencies(env, {
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
    }),
  );
  const runtime = await createEventPrizeRuntimeDependencies(env, {
    allowFrozen: true,
    repository: state.value,
    withdrawalStore: state.withdrawalStore,
  });
  assert.equal(typeof runtime.createEventPrizeUmi, "function");
});

function workflow(
  status: () => InstanceStatus,
  {
    createExisting = false,
    onCreate = () => undefined,
    onDelete = () => undefined,
  }: {
    createExisting?: boolean;
    onCreate?: (
      batch: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[],
    ) => void;
    onDelete?: () => void;
  } = {},
) {
  const instance = {
    id: "workflow-instance",
    delete: async () => onDelete(),
    pause: async () => undefined,
    restart: async () => undefined,
    resume: async () => undefined,
    sendEvent: async () => undefined,
    status: async () => status(),
    terminate: async () => undefined,
  } satisfies WorkflowInstance;
  return {
    create: async () => instance,
    createBatch: async (batch) => {
      onCreate(batch);
      return createExisting ? [] : [instance];
    },
    deleteBatch: async () => ({ deleted: [], errors: [] }),
    get: async () => instance,
  } satisfies Workflow<EventPrizeWithdrawalWorkflowInput>;
}

function request(path: string, body: unknown): Request {
  return new Request(`https://api.mons.link${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer token",
      "Content-Type": "application/json",
      Origin: "https://mons.link",
    },
    body: JSON.stringify(body),
  });
}

const context = { waitUntil: () => undefined };
const verifyIdentity = async () => ({ idToken: "token", uid });

test("builds and validates deterministic withdrawal Workflow identities", async () => {
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  assert.match(operationId, /^epw_[0-9a-f]{64}$/);
  assert.equal(
    operationId,
    await buildEventPrizeWithdrawalOperationId(eventId, prizeId),
  );
  const params = {
    schemaVersion: 1,
    kind: "withdrawal",
    eventId,
    operationId,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: uid,
  } as const;
  assert.deepEqual(
    await parseEventPrizeWithdrawalWorkflowParams(params, operationId),
    params,
  );
  assert.equal(
    await parseEventPrizeWithdrawalWorkflowParams(
      { ...params, operationId: `${operationId}0` },
      operationId,
    ),
    null,
  );
});

test("returns invalid argument for malformed JSON", async () => {
  const response = await handleEventPrizeWithdrawalRoute(
    new Request("https://api.mons.link/events/prizes/withdrawals", {
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
        Origin: "https://mons.link",
      },
      body: "{",
    }),
    TELEGRAM_TEST_ENV,
    context,
    { verifyIdentity },
  );

  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "invalid-argument",
  );
});

test("freezes withdrawal creation before parsing", async () => {
  const requestValue = request("/events/prizes/withdrawals", {});
  const response = await handleEventPrizeWithdrawalRoute(
    requestValue,
    withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "importing"),
    context,
    { verifyIdentity },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unavailable",
    message: "profile-writes-disabled",
  });
  assert.equal(requestValue.bodyUsed, false);
});

test("rejects an invalid completed record before projection cleanup", async () => {
  const state = repository();
  const assignmentPath = `profileEventPrizes/${profileId}/${eventId}`;
  const assignment = state.values.get(assignmentPath);
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    eventId,
    place: 1,
    prizeId,
    profileId,
    recipientAddress: adminAddress,
    requesterUid: uid,
    status: "completed",
    transactionSignature: "signature",
  });

  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals", {
      eventId,
      prizeId,
      solanaAddress: recipientAddress,
    }),
    TELEGRAM_TEST_ENV,
    context,
    {
      firestore: firestore(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(state.values.get(assignmentPath), assignment);
});

test("uses the current processing admission when a Workflow retries", async () => {
  const state = repository();
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  const nextRecipientAddress = "Vote111111111111111111111111111111111111111";
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    eventId,
    place: 1,
    prizeId,
    profileId,
    recipientAddress: nextRecipientAddress,
    requesterUid: uid,
    status: "processing",
  });

  const resolved = await resolveEventPrizeWithdrawalExecutionParams(
    {
      schemaVersion: 1,
      kind: "withdrawal",
      eventId,
      operationId,
      prizeId,
      profileId,
      recipientAddress,
      requesterUid: uid,
    },
    {
      readWithdrawal: async (candidateEventId, candidatePrizeId) =>
        (state.values.get(
          `eventPrizeWithdrawals/${candidateEventId}/${candidatePrizeId}`,
        ) as Record<string, unknown> | undefined) ?? null,
    },
  );

  assert.equal(resolved.recipientAddress, nextRecipientAddress);
});

test("execution profile reads follow merges during transfer", async () => {
  let canonicalProfileId = profileId;
  const readProfile = createEventPrizeExecutionProfileReader(
    { profileId: "original-profile", requesterUid: uid },
    {
      readProfileByLoginUid: async () => null,
      resolveCanonicalProfileId: async () => canonicalProfileId,
    },
  );

  assert.deepEqual(await readProfile(uid), { id: profileId });
  canonicalProfileId = "merged-profile";
  assert.deepEqual(await readProfile(uid), { id: "merged-profile" });
});

test("completed execution retries projection cleanup failures", async () => {
  const state = repository();
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    eventId,
    place: 1,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: uid,
    status: "completed",
    transactionSignature: "signature",
  });
  const transactRtdbPath = state.value.transactRtdbPath;
  const failingRepository = {
    ...state.value,
    transactRtdbPath: async (...args: Parameters<typeof transactRtdbPath>) => {
      if (args[0].startsWith("profileEventPrizes/")) {
        throw new Error("database unavailable");
      }
      return transactRtdbPath(...args);
    },
  };

  await assert.rejects(
    executeEventPrizeWithdrawal(
      TELEGRAM_TEST_ENV,
      {
        schemaVersion: 1,
        kind: "withdrawal",
        eventId,
        operationId,
        prizeId,
        profileId,
        recipientAddress,
        requesterUid: uid,
      },
      {
        firestore: firestore(),
        repository: failingRepository,
        withdrawalStore: state.withdrawalStore,
      },
    ),
    /database unavailable/,
  );
});

test("duplicate starts preserve an active executor lease", async () => {
  const state = repository();
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    eventId,
    leaseExpiresAtMs: 2_000,
    leaseId: "workflow-lease",
    place: 1,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: uid,
    status: "processing",
  });
  const binding = workflow(() => ({ status: "running" }), {
    createExisting: true,
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals", {
      eventId,
      prizeId,
      solanaAddress: recipientAddress,
    }),
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding,
    },
    context,
    {
      firestore: firestore(),
      now: () => 1_000,
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(
    (
      state.values.get(`eventPrizeWithdrawals/${eventId}/${prizeId}`) as {
        leaseId: string;
      }
    ).leaseId,
    "workflow-lease",
  );
});

test("alternate logins preserve the canonical active intent", async () => {
  const state = repository();
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    eventId,
    leaseExpiresAtMs: 2_000,
    leaseId: "old-login-lease",
    place: 1,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: "old-login",
    status: "processing",
  });
  const binding = workflow(() => ({ status: "running" }), {
    createExisting: true,
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals", {
      eventId,
      prizeId,
      solanaAddress: recipientAddress,
    }),
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding,
    },
    context,
    {
      firestore: firestore(),
      now: () => 1_000,
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );
  const withdrawal = state.values.get(
    `eventPrizeWithdrawals/${eventId}/${prizeId}`,
  ) as { leaseId: string; requesterUid: string };

  assert.equal(response.status, 202);
  assert.equal(withdrawal.leaseId, "old-login-lease");
  assert.equal(withdrawal.requesterUid, "old-login");
});

test("processing intent stays locked after its executor lease expires", async () => {
  const state = repository();
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    eventId,
    leaseExpiresAtMs: 2_000,
    leaseId: "workflow-lease",
    place: 1,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: uid,
    status: "processing",
  });
  const binding = workflow(() => ({ status: "running" }), {
    createExisting: true,
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals", {
      eventId,
      prizeId,
      solanaAddress: "Vote111111111111111111111111111111111111111",
    }),
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding,
    },
    context,
    {
      firestore: firestore(),
      now: () => 3_000,
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 412);
  assert.equal(
    (
      state.values.get(`eventPrizeWithdrawals/${eventId}/${prizeId}`) as {
        leaseId: string;
      }
    ).leaseId,
    "workflow-lease",
  );
});

test("keeps polling while a retryable Workflow has released its claim", async () => {
  const state = repository();
  const binding = workflow(() => ({ status: "running" }));
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding,
    },
    context,
    {
      firestore: firestore(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(
    ((await response.json()) as { status: string }).status,
    "processing",
  );
});

test("marks errored Workflows as terminal", async () => {
  const state = repository();
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    eventId,
    place: 1,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: uid,
    status: "processing",
  });
  const binding = workflow(() => ({ status: "errored" }));
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding,
    },
    context,
    {
      firestore: firestore(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(((await response.json()) as { details: unknown }).details, {
    terminal: true,
  });
});

test("starts and polls one authenticated withdrawal Workflow", async () => {
  const state = repository();
  let workflowStatus: InstanceStatus = { status: "running" };
  const binding = workflow(() => workflowStatus);
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding,
  };
  const dependencies = {
    firestore: firestore(),
    repository: state.value,
    withdrawalStore: state.withdrawalStore,
    verifyIdentity,
    workflow: binding,
  };
  const start = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals", {
      eventId,
      prizeId,
      solanaAddress: recipientAddress,
    }),
    env,
    context,
    dependencies,
  );
  assert.equal(start.status, 202);
  const processing = (await start.json()) as {
    operationId: string;
    status: string;
  };
  assert.equal(processing.status, "processing");

  const pending = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId: processing.operationId,
      prizeId,
    }),
    env,
    context,
    dependencies,
  );
  assert.equal(pending.status, 202);

  const frozenPending = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId: processing.operationId,
      prizeId,
    }),
    withProfileControl(env, "active"),
    context,
    dependencies,
  );
  assert.equal(frozenPending.status, 202);

  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    completedAtMs: 1,
    eventId,
    place: 1,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: uid,
    startedAtMs: 1,
    status: "completed",
    submittedAtMs: 1,
    transactionSignature: "signature",
    updatedAtMs: 1,
  });
  workflowStatus = { status: "complete" };
  const complete = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId: processing.operationId,
      prizeId,
    }),
    env,
    context,
    dependencies,
  );
  assert.equal(complete.status, 200);
  assert.equal(
    ((await complete.json()) as { status: string }).status,
    "completed",
  );
});

test("replaces a retained errored Workflow with the current request", async () => {
  const state = repository();
  let deletes = 0;
  const batches: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[][] =
    [];
  const binding = workflow(() => ({ status: "errored" }), {
    createExisting: true,
    onCreate: (batch) => batches.push(batch),
    onDelete: () => {
      deletes += 1;
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals", {
      eventId,
      prizeId,
      solanaAddress: recipientAddress,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      firestore: firestore(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );
  assert.equal(response.status, 202);
  assert.equal(deletes, 1);
  assert.equal(batches.length, 2);
  assert.equal(
    (
      batches[1][0].params as EventPrizeWithdrawalWorkflowInput & {
        recipientAddress: string;
      }
    ).recipientAddress,
    recipientAddress,
  );
});

test("replaces a retained completed failure", async () => {
  const state = repository();
  let deletes = 0;
  const binding = workflow(
    () => ({
      status: "complete",
      output: {
        ok: false,
        status: "failed",
        error: "failed-precondition",
        message: "Simulation failed.",
      },
    }),
    {
      createExisting: true,
      onDelete: () => {
        deletes += 1;
      },
    },
  );
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals", {
      eventId,
      prizeId,
      solanaAddress: recipientAddress,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      firestore: firestore(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );
  assert.equal(response.status, 202);
  assert.equal(deletes, 1);
});

test("replaces a retained terminated Workflow with the current request", async () => {
  const state = repository();
  let deletes = 0;
  const binding = workflow(() => ({ status: "terminated" }), {
    createExisting: true,
    onDelete: () => {
      deletes += 1;
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals", {
      eventId,
      prizeId,
      solanaAddress: recipientAddress,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      firestore: firestore(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );
  assert.equal(response.status, 202);
  assert.equal(deletes, 1);
});
