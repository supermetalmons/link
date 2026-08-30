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
import type { EventPrizeWithdrawalStore } from "../src/eventPrizeWithdrawalD1.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import type {
  ProfileOwnershipQuery,
  ProfileOwnershipProfileSnapshot,
  ProfileOwnershipReader,
  ProfileOwnershipSnapshot,
} from "../src/profileOwnership.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

const eventId = "NN3eRzoZo80";
const prizeId = "1092";
const profileId = "profile-1";
const uid = "login-1";
const recipientAddress = "11111111111111111111111111111111";
const adminAddress = "Ay1mgqJr6WmihsSYdMZ1dkHL5r25N7VhCGk7NpCJcPGi";

function ownershipReader({
  canonicalProfileIds = new Map<string, string | null>(),
  loginProfileIds = new Map<string, string | null>(),
}: {
  canonicalProfileIds?: Map<string, string | null>;
  loginProfileIds?: Map<string, string | null>;
} = {}): ProfileOwnershipReader {
  return {
    async readProfileOwnershipSnapshot(
      query: ProfileOwnershipQuery,
    ): Promise<ProfileOwnershipSnapshot> {
      const loginOwnerByUid = new Map(
        query.loginUids.map((loginUid) => {
          const ownedProfileId = loginProfileIds.has(loginUid)
            ? loginProfileIds.get(loginUid) || null
            : profileId;
          return [
            loginUid,
            ownedProfileId ? { profileId: ownedProfileId, revision: 1 } : null,
          ] as const;
        }),
      );
      const canonicalProfileIdByProfileId = new Map(
        query.profileIds.map((candidateProfileId) => [
          candidateProfileId,
          canonicalProfileIds.has(candidateProfileId)
            ? canonicalProfileIds.get(candidateProfileId) || null
            : candidateProfileId,
        ]),
      );
      const resolvedProfileIds = new Set<string>();
      for (const owner of loginOwnerByUid.values()) {
        if (owner) resolvedProfileIds.add(owner.profileId);
      }
      for (const candidateProfileId of canonicalProfileIdByProfileId.values()) {
        if (candidateProfileId) resolvedProfileIds.add(candidateProfileId);
      }
      const loginUidsByProfileId = new Map<string, readonly string[]>();
      const profileById = new Map<string, ProfileOwnershipProfileSnapshot>();
      for (const resolvedProfileId of resolvedProfileIds) {
        loginUidsByProfileId.set(
          resolvedProfileId,
          [...loginOwnerByUid]
            .filter(([, owner]) => owner?.profileId === resolvedProfileId)
            .map(([loginUid]) => loginUid)
            .sort(),
        );
        profileById.set(resolvedProfileId, {
          profile: {
            aura: "",
            emoji: 1,
            eth: "",
            profileId: resolvedProfileId,
            rating: 1500,
            sol: "",
            username: "",
          },
          revision: 1,
        });
      }
      return {
        canonicalProfileIdByProfileId,
        loginOwnerByUid,
        loginUidsByProfileId,
        profileById,
      };
    },
  };
}

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

function canonicalProfileDb(
  mergeTargets = new Map<string, string>(),
): D1Database {
  return {
    ...TELEGRAM_TEST_ENV.PROFILE_DB,
    prepare(query: string) {
      let values: unknown[] = [];
      let statement: D1PreparedStatement;
      statement = {
        all: async () => ({
          success: true,
          results: [],
          meta: {
            changed_db: false,
            changes: 0,
            duration: 0,
            last_row_id: 0,
            rows_read: 0,
            rows_written: 0,
            size_after: 0,
          },
        }),
        bind(...nextValues) {
          values = nextValues;
          return statement;
        },
        async first<T>() {
          if (query.includes("profile_merge_targets")) {
            const sourceProfileId = String(values[0] || "");
            const targetProfileId = mergeTargets.get(sourceProfileId);
            return targetProfileId
              ? ({
                  source_profile_id: sourceProfileId,
                  target_profile_id: targetProfileId,
                  merged_at_ms: 1,
                  op_id: null,
                } as T)
              : null;
          }
          if (query.includes("profile_login_owners")) {
            return {
              login_uid: String(values[0] || uid),
              profile_id: profileId,
              revision: 1,
              created_at_ms: 1,
              updated_at_ms: 1,
            } as T;
          }
          return null;
        },
        raw: TELEGRAM_TEST_ENV.PROFILE_DB.prepare("").raw,
        run: TELEGRAM_TEST_ENV.PROFILE_DB.prepare("").run,
      };
      return statement;
    },
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
    readProfileOwnershipSnapshot:
      ownershipReader().readProfileOwnershipSnapshot,
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

function setRecoverableWithdrawal(
  state: ReturnType<typeof repository>,
  status: "processing" | "submitted",
): void {
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
    status,
    ...(status === "submitted"
      ? {
          blockhash: "blockhash",
          lastValidBlockHeight: 1,
          signedTransactionBase64: "signed-transaction",
          transactionSignature: "signature",
        }
      : {}),
  });
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
    getMissing = false,
    onCreate = () => undefined,
    onDelete = () => undefined,
    onGet = () => undefined,
  }: {
    createExisting?: boolean;
    getMissing?: boolean;
    onCreate?: (
      batch: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[],
    ) => void;
    onDelete?: () => void;
    onGet?: () => void;
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
    get: async () => {
      onGet();
      if (getMissing) throw new Error("workflow-not-found");
      return instance;
    },
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
    withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "frozen"),
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

test("withdrawal storage freeze prevents terminated Workflow recreation", async () => {
  const state = repository();
  let creates = 0;
  let deletes = 0;
  const binding = workflow(() => ({ status: "terminated" }), {
    createExisting: true,
    onCreate: () => {
      creates += 1;
    },
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
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PRIZE_WITHDRAWALS_DB: frozenWithdrawalDb(),
      EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding,
    },
    context,
    {
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );
  assert.equal(response.status, 503);
  assert.equal(creates, 0);
  assert.equal(deletes, 0);
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
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(state.values.get(assignmentPath), assignment);
});

test("fails closed when stored withdrawal ownership cannot be canonicalized", async () => {
  const state = repository();
  state.value.readProfileOwnershipSnapshot = async () => {
    throw new Error("D1 ownership unavailable");
  };
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    eventId,
    prizeId,
    profileId: "retired-profile",
    requesterUid: "retired-login",
    status: "processing",
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    TELEGRAM_TEST_ENV,
    context,
    {
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unavailable",
    message: "profile-ownership-unavailable",
  });
});

test("rejects a matching requester UID with a contradictory stored profile", async () => {
  const state = repository();
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  const withdrawalPath = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
  state.values.set(withdrawalPath, {
    eventId,
    prizeId,
    profileId: "other-profile",
    requesterUid: uid,
    status: "processing",
  });
  const before = structuredClone(state.values.get(withdrawalPath));
  let workflowReads = 0;
  const binding = workflow(() => ({ status: "running" }), {
    onGet: () => {
      workflowReads++;
    },
  });

  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 403);
  assert.equal(workflowReads, 0);
  assert.deepEqual(state.values.get(withdrawalPath), before);
});

test("rejects a contradictory durable processing admission", async () => {
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
    profileId: "other-profile",
    recipientAddress,
    requesterUid: uid,
    status: "processing",
  });

  await assert.rejects(
    resolveEventPrizeWithdrawalExecutionParams(
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
        readProfileOwnershipSnapshot:
          ownershipReader().readProfileOwnershipSnapshot,
        readWithdrawal: async (candidateEventId, candidatePrizeId) =>
          (state.values.get(
            `eventPrizeWithdrawals/${candidateEventId}/${candidatePrizeId}`,
          ) as Record<string, unknown> | undefined) ?? null,
      },
    ),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "permission-denied",
  );
});

test("validates processing ownership through a canonical merge", async () => {
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  const params = {
    schemaVersion: 1,
    kind: "withdrawal",
    eventId,
    operationId,
    prizeId,
    profileId: "retired-profile",
    recipientAddress,
    requesterUid: uid,
  } as const;
  const resolved = await resolveEventPrizeWithdrawalExecutionParams(params, {
    readProfileOwnershipSnapshot: ownershipReader({
      canonicalProfileIds: new Map([["retired-profile", "canonical-profile"]]),
    }).readProfileOwnershipSnapshot,
    readWithdrawal: async () => ({
      assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
      eventId,
      place: 1,
      prizeId,
      profileId: "retired-profile",
      recipientAddress,
      requesterUid: uid,
      status: "processing",
    }),
  });
  assert.equal(resolved.profileId, "canonical-profile");
});

test("lets an alternate canonical login execute an existing processing intent", async () => {
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  const resolved = await resolveEventPrizeWithdrawalExecutionParams(
    {
      schemaVersion: 1,
      kind: "withdrawal",
      eventId,
      operationId,
      prizeId,
      profileId,
      recipientAddress,
      requesterUid: "alternate-login",
    },
    {
      readProfileOwnershipSnapshot:
        ownershipReader().readProfileOwnershipSnapshot,
      readWithdrawal: async () => ({
        assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
        eventId,
        place: 1,
        prizeId,
        profileId,
        recipientAddress,
        requesterUid: "original-login",
        status: "processing",
      }),
    },
  );
  assert.equal(resolved.requesterUid, "alternate-login");
  assert.equal(resolved.profileId, profileId);
});

test("executes a processing capability without rereading the live owner", async () => {
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
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
  const resolved = await resolveEventPrizeWithdrawalExecutionParams(params, {
    readProfileOwnershipSnapshot:
      ownershipReader().readProfileOwnershipSnapshot,
    readWithdrawal: async () => ({
      assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
      eventId,
      place: 1,
      prizeId,
      profileId,
      recipientAddress,
      requesterUid: uid,
      status: "processing",
    }),
  });
  assert.deepEqual(resolved, params);
});

test("fails closed when the admitted profile no longer exists", async () => {
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  await assert.rejects(
    resolveEventPrizeWithdrawalExecutionParams(
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
        readProfileOwnershipSnapshot: ownershipReader({
          canonicalProfileIds: new Map([[profileId, null]]),
        }).readProfileOwnershipSnapshot,
        readWithdrawal: async () => ({
          assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
          eventId,
          place: 1,
          prizeId,
          profileId,
          recipientAddress,
          requesterUid: uid,
          status: "processing",
        }),
      },
    ),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "permission-denied",
  );
});

test("preserves submitted reconciliation after the login is unlinked", async () => {
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
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
  const resolved = await resolveEventPrizeWithdrawalExecutionParams(params, {
    readProfileOwnershipSnapshot:
      ownershipReader().readProfileOwnershipSnapshot,
    readWithdrawal: async () => ({
      assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
      eventId,
      place: 1,
      prizeId,
      profileId,
      recipientAddress,
      requesterUid: uid,
      status: "submitted",
    }),
  });
  assert.deepEqual(resolved, params);
});

test("execution capability synthesizes only the admitted requester profile", async () => {
  const runtime = {
    readProfileByLoginUid: async (loginUid: string) => ({ id: loginUid }),
  };
  const readProfile = createEventPrizeExecutionProfileReader(
    { profileId: "original-profile", requesterUid: uid },
    runtime,
  );

  assert.deepEqual(await readProfile(uid), { id: "original-profile" });
  assert.deepEqual(await readProfile("other-login"), { id: "other-login" });
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
        profileDb: canonicalProfileDb(),
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
      profileDb: canonicalProfileDb(),
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
      profileDb: canonicalProfileDb(),
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
      profileDb: canonicalProfileDb(),
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
      profileDb: canonicalProfileDb(),
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
      profileDb: canonicalProfileDb(),
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

for (const durableStatus of ["processing", "submitted"] as const) {
  test(`status polling recreates a missing ${durableStatus} Workflow`, async () => {
    const state = repository();
    if (durableStatus === "submitted") {
      state.values.delete(`profileEventPrizes/${profileId}/${eventId}`);
    }
    setRecoverableWithdrawal(state, durableStatus);
    const operationId = await buildEventPrizeWithdrawalOperationId(
      eventId,
      prizeId,
    );
    const batches: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[][] =
      [];
    const binding = workflow(() => ({ status: "running" }), {
      getMissing: true,
      onCreate: (batch) => batches.push(batch),
    });

    const response = await handleEventPrizeWithdrawalRoute(
      request("/events/prizes/withdrawals/status", {
        eventId,
        operationId,
        prizeId,
      }),
      { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
      context,
      {
        profileDb: canonicalProfileDb(),
        repository: state.value,
        withdrawalStore: state.withdrawalStore,
        verifyIdentity,
        workflow: binding,
      },
    );

    assert.equal(response.status, 202);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0][0].params, {
      schemaVersion: 1,
      kind: "withdrawal",
      eventId,
      operationId,
      prizeId,
      profileId,
      recipientAddress,
      requesterUid: uid,
    });
    const durable = state.values.get(
      `eventPrizeWithdrawals/${eventId}/${prizeId}`,
    ) as { status: string; transactionSignature?: string };
    assert.equal(durable.status, durableStatus);
    if (durableStatus === "submitted") {
      assert.equal(durable.transactionSignature, "signature");
    }
  });
}

test("alternate canonical login recreates a missing processing Workflow", async () => {
  const state = repository();
  setRecoverableWithdrawal(state, "processing");
  const withdrawalPath = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
  state.values.set(withdrawalPath, {
    ...(state.values.get(withdrawalPath) as Record<string, unknown>),
    requesterUid: "original-login",
  });
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  const batches: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[][] =
    [];
  const binding = workflow(() => ({ status: "running" }), {
    getMissing: true,
    onCreate: (batch) => batches.push(batch),
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity: async () => ({ uid: "alternate-login" }),
      workflow: binding,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(batches.length, 1);
  assert.equal(
    (batches[0][0].params as { requesterUid: string }).requesterUid,
    "original-login",
  );
});

test("status polling retries missing Workflow creation without losing durable state", async () => {
  const state = repository();
  setRecoverableWithdrawal(state, "processing");
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  let createAttempts = 0;
  const binding = workflow(() => ({ status: "running" }), {
    getMissing: true,
    onCreate: () => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("workflow-create-failed");
    },
  });
  const dependencies = {
    profileDb: canonicalProfileDb(),
    repository: state.value,
    withdrawalStore: state.withdrawalStore,
    verifyIdentity,
    workflow: binding,
  };

  const first = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    dependencies,
  );
  assert.equal(first.status, 503);
  assert.deepEqual(
    state.values.get(`eventPrizeWithdrawals/${eventId}/${prizeId}`),
    {
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
    },
  );

  const second = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    dependencies,
  );
  assert.equal(second.status, 202);
  assert.equal(createAttempts, 2);
});

test("missing Workflow without durable state is terminal", async () => {
  const state = repository();
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  let creates = 0;
  const binding = workflow(() => ({ status: "running" }), {
    getMissing: true,
    onCreate: () => {
      creates += 1;
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
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
  assert.equal(creates, 0);
});

test("missing Workflow with an invalid durable place is terminal", async () => {
  const state = repository();
  setRecoverableWithdrawal(state, "submitted");
  const withdrawalPath = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
  state.values.set(withdrawalPath, {
    ...(state.values.get(withdrawalPath) as Record<string, unknown>),
    place: 4,
  });
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  let creates = 0;
  const binding = workflow(() => ({ status: "running" }), {
    getMissing: true,
    onCreate: () => {
      creates += 1;
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
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
  assert.equal(creates, 0);
});

test("Workflow status failures do not recreate durable processing work", async () => {
  const state = repository();
  setRecoverableWithdrawal(state, "processing");
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  let creates = 0;
  const binding = workflow(
    () => {
      throw new Error("workflow-status-failed");
    },
    {
      onCreate: () => {
        creates += 1;
      },
    },
  );
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 503);
  assert.equal(creates, 0);
  assert.equal(
    (
      state.values.get(`eventPrizeWithdrawals/${eventId}/${prizeId}`) as {
        leaseId: string;
      }
    ).leaseId,
    "workflow-lease",
  );
});

test("transient Workflow lookup failure preserves a submitted lease", async () => {
  const state = repository();
  setRecoverableWithdrawal(state, "submitted");
  const withdrawalPath = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
  const before = structuredClone(state.values.get(withdrawalPath));
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  let gets = 0;
  let creates = 0;
  const binding = workflow(() => ({ status: "running" }), {
    createExisting: true,
    onCreate: () => {
      creates += 1;
    },
    onGet: () => {
      gets += 1;
      if (gets === 1) throw new Error("workflow-get-failed");
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(creates, 1);
  assert.equal(gets, 2);
  assert.deepEqual(state.values.get(withdrawalPath), before);
});

test("transient Workflow lookup failure does not replace an errored instance", async () => {
  const state = repository();
  setRecoverableWithdrawal(state, "processing");
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  let gets = 0;
  let deletes = 0;
  const batches: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[][] =
    [];
  const binding = workflow(() => ({ status: "errored" }), {
    createExisting: true,
    onCreate: (batch) => batches.push(batch),
    onDelete: () => {
      deletes += 1;
    },
    onGet: () => {
      gets += 1;
      if (gets === 1) throw new Error("workflow-get-failed");
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
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
  assert.equal(batches.length, 1);
  assert.equal(deletes, 0);
});

test("transient Workflow lookup failure preserves a completed failure", async () => {
  const state = repository();
  setRecoverableWithdrawal(state, "processing");
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  let gets = 0;
  let deletes = 0;
  const batches: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[][] =
    [];
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
      onCreate: (batch) => batches.push(batch),
      onDelete: () => {
        deletes += 1;
      },
      onGet: () => {
        gets += 1;
        if (gets === 1) throw new Error("workflow-get-failed");
      },
    },
  );
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 412);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "failed-precondition",
    message: "Simulation failed.",
  });
  assert.equal(batches.length, 1);
  assert.equal(deletes, 0);
});

test("withdrawal storage freeze prevents missing Workflow recreation", async () => {
  const state = repository();
  setRecoverableWithdrawal(state, "processing");
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  let gets = 0;
  let creates = 0;
  const binding = workflow(() => ({ status: "running" }), {
    getMissing: true,
    onCreate: () => {
      creates += 1;
    },
    onGet: () => {
      gets += 1;
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    {
      ...TELEGRAM_TEST_ENV,
      EVENT_PRIZE_WITHDRAWALS_DB: frozenWithdrawalDb(),
      EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding,
    },
    context,
    {
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 503);
  assert.equal(gets, 0);
  assert.equal(creates, 0);
});

test("status polling recreates a terminated processing Workflow", async () => {
  const state = repository();
  const readOwnership = ownershipReader({
    canonicalProfileIds: new Map([["retired-profile", profileId]]),
  }).readProfileOwnershipSnapshot;
  let ownershipReads = 0;
  state.value.readProfileOwnershipSnapshot = async (query) => {
    ownershipReads += 1;
    return readOwnership(query);
  };
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    eventId,
    leaseExpiresAtMs: 2_000,
    leaseId: "workflow-lease",
    place: 1,
    prizeId,
    profileId: "retired-profile",
    recipientAddress,
    requesterUid: uid,
    status: "processing",
  });
  let deletes = 0;
  const batches: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[][] =
    [];
  const binding = workflow(() => ({ status: "terminated" }), {
    createExisting: true,
    onCreate: (batch) => batches.push(batch),
    onDelete: () => {
      deletes += 1;
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(ownershipReads, 1);
  assert.equal(deletes, 1);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0][0].params, {
    schemaVersion: 1,
    kind: "withdrawal",
    eventId,
    operationId,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: uid,
  });
});

test("status polling recreates a terminated submitted Workflow", async () => {
  const state = repository();
  const operationId = await buildEventPrizeWithdrawalOperationId(
    eventId,
    prizeId,
  );
  state.values.delete(`profileEventPrizes/${profileId}/${eventId}`);
  state.values.set(`eventPrizeWithdrawals/${eventId}/${prizeId}`, {
    assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
    blockhash: "blockhash",
    eventId,
    lastValidBlockHeight: 1,
    leaseExpiresAtMs: 2_000,
    leaseId: "workflow-lease",
    place: 1,
    prizeId,
    profileId,
    recipientAddress,
    requesterUid: uid,
    signedTransactionBase64: "signed-transaction",
    status: "submitted",
    transactionSignature: "signature",
  });
  let deletes = 0;
  const batches: WorkflowInstanceCreateOptions<EventPrizeWithdrawalWorkflowInput>[][] =
    [];
  const binding = workflow(() => ({ status: "terminated" }), {
    createExisting: true,
    onCreate: (batch) => batches.push(batch),
    onDelete: () => {
      deletes += 1;
    },
  });
  const response = await handleEventPrizeWithdrawalRoute(
    request("/events/prizes/withdrawals/status", {
      eventId,
      operationId,
      prizeId,
    }),
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(deletes, 1);
  assert.equal(batches.length, 1);
  const submitted = state.values.get(
    `eventPrizeWithdrawals/${eventId}/${prizeId}`,
  ) as { status: string; transactionSignature: string };
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.transactionSignature, "signature");
});

test("keeps a terminated Workflow terminal without a processing record", async () => {
  const state = repository();
  let creates = 0;
  let deletes = 0;
  const binding = workflow(() => ({ status: "terminated" }), {
    createExisting: true,
    onCreate: () => {
      creates += 1;
    },
    onDelete: () => {
      deletes += 1;
    },
  });
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
    { ...TELEGRAM_TEST_ENV, EVENT_PRIZE_WITHDRAWAL_WORKFLOW: binding },
    context,
    {
      profileDb: canonicalProfileDb(),
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
  assert.equal(creates, 0);
  assert.equal(deletes, 0);
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
    profileDb: canonicalProfileDb(),
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
    withProfileControl(env, "frozen"),
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
      profileDb: canonicalProfileDb(),
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
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );
  assert.equal(response.status, 202);
  assert.equal(deletes, 1);
});

test("recreates a retained terminated Workflow after storage resumes", async () => {
  const state = repository();
  let creates = 0;
  let deletes = 0;
  const binding = workflow(() => ({ status: "terminated" }), {
    createExisting: true,
    onCreate: () => {
      creates += 1;
    },
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
      profileDb: canonicalProfileDb(),
      repository: state.value,
      withdrawalStore: state.withdrawalStore,
      verifyIdentity,
      workflow: binding,
    },
  );
  assert.equal(response.status, 202);
  assert.equal(deletes, 1);
  assert.equal(creates, 2);
});

test("keeps paused Workflows paused", async () => {
  for (const status of ["paused", "waitingForPause"] as const) {
    const state = repository();
    let deletes = 0;
    const binding = workflow(() => ({ status }), {
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
        profileDb: canonicalProfileDb(),
        repository: state.value,
        withdrawalStore: state.withdrawalStore,
        verifyIdentity,
        workflow: binding,
      },
    );
    assert.equal(response.status, 412);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "failed-precondition",
      message: "Prize withdrawal is paused by an operator.",
    });
    assert.equal(deletes, 0);
  }
});
