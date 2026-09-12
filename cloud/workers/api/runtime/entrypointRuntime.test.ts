import { describe, expect, it } from "vitest";
import * as entrypoint from "../src/index.ts";
import {
  createEventProgressWorkflowDependencies,
  EventProgressWorkflow,
} from "../src/eventProgressWorkflow.ts";
import { EventPrizeWithdrawalWorkflow } from "../src/eventPrizeWithdrawalWorkflow.ts";
import { AUTH_RECOVERY_QUEUE_NAME } from "../src/authRecovery.ts";
import { PROFILE_GAME_PROJECTION_QUEUE_NAME } from "../src/profileGameProjectionTasks.ts";
import { TELEGRAM_PROJECTION_QUEUE_NAME } from "../src/telegramProjectionTasks.ts";
import { WAGER_SETTLEMENT_QUEUE_NAME } from "../src/wagerSettlementQueue.ts";
import worker, { handleScheduled } from "../src/workerHandler.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "../test/testEnv.ts";

function queueMessage(body: unknown) {
  let acknowledgements = 0;
  const retries: QueueRetryOptions[] = [];
  const message = {
    id: crypto.randomUUID(),
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack: () => acknowledgements++,
    retry: (options?: QueueRetryOptions) => retries.push(options || {}),
  } satisfies Message<unknown>;
  return { acknowledgements: () => acknowledgements, message, retries };
}

function queueBatch(queue: string, messages: Message<unknown>[]) {
  return {
    queue,
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => undefined,
    ackAll: () => undefined,
  } satisfies MessageBatch<unknown>;
}

const controller = {
  cron: "* * * * *",
  noRetry: () => undefined,
  scheduledTime: 1_000,
} satisfies ScheduledController;

describe("Worker entrypoint", () => {
  it("exports the Worker handler and Workflows", () => {
    expect(entrypoint.default).toBe(worker);
    expect(entrypoint.EventProgressWorkflow).toBe(EventProgressWorkflow);
    expect(entrypoint.EventPrizeWithdrawalWorkflow).toBe(
      EventPrizeWithdrawalWorkflow,
    );
    expect(typeof entrypoint.default.fetch).toBe("function");
    expect(typeof entrypoint.default.queue).toBe("function");
    expect(typeof entrypoint.default.scheduled).toBe("function");
  });

  it("returns the normal 404 for retired migration commands without accessing bindings", async () => {
    const bindingsRead: PropertyKey[] = [];
    const environment = new Proxy({} as Env, {
      get(_target, property) {
        bindingsRead.push(property);
        throw new Error(`unexpected-binding-access:${String(property)}`);
      },
    });
    const response = await worker.fetch(
      new Request("https://api.mons.link/internal/d1-migration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          kind: "d1-migration",
          runId: "retired-migration",
          operation: "fence",
          expectedVersionId: "11111111-1111-4111-8111-111111111111",
          binding: "PROFILE_DB",
          schemaDigest: "a".repeat(64),
        }),
      }),
      environment,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "not-found" });
    expect(bindingsRead).toEqual([]);
  });

  it("rechecks active control inside mutating Workflow work", async () => {
    const frozen = withProfileControl(
      TELEGRAM_TEST_ENV as unknown as Env,
      "frozen",
    );
    const dependencies = createEventProgressWorkflowDependencies(frozen);
    await expect(dependencies.acknowledge("outbox-1")).rejects.toThrow(
      "profile-writes-disabled",
    );
    await expect(
      dependencies.synchronize({
        instanceId: "workflow-1",
        params: {
          schemaVersion: 1,
          eventId: "event-1",
          outboxId: "outbox-1",
          reason: "rating-completed",
          runAtMs: null,
          sourceKey: "rating:invite:match",
        },
      }),
    ).rejects.toThrow("profile-writes-disabled");
  });

  it("retries profile Queue messages without acknowledgement while frozen", async () => {
    const frozen = withProfileControl(
      TELEGRAM_TEST_ENV as unknown as Env,
      "frozen",
    );
    for (const queue of [
      AUTH_RECOVERY_QUEUE_NAME,
      PROFILE_GAME_PROJECTION_QUEUE_NAME,
      TELEGRAM_PROJECTION_QUEUE_NAME,
    ]) {
      const tracked = queueMessage({ kind: "task" });
      await worker.queue(queueBatch(queue, [tracked.message]), frozen);
      expect(tracked.acknowledgements(), queue).toBe(0);
      expect(tracked.retries, queue).toEqual([{ delaySeconds: 300 }]);
    }
  });

  it("fails unreadable Queue control closed", async () => {
    const tracked = queueMessage({ kind: "task" });
    const unavailable = {
      ...TELEGRAM_TEST_ENV,
      PROFILE_DB: {
        ...TELEGRAM_TEST_ENV.PROFILE_DB,
        prepare() {
          throw new Error("profile-control-unavailable");
        },
      } as unknown as D1Database,
    } as unknown as Env;
    await worker.queue(
      queueBatch(AUTH_RECOVERY_QUEUE_NAME, [tracked.message]),
      unavailable,
    );
    expect(tracked.acknowledgements()).toBe(0);
    expect(tracked.retries).toEqual([{ delaySeconds: 300 }]);
  });

  it("forwards legacy wagers while frozen without blocking Telegram work", async () => {
    const deferred: Array<{ body: unknown; options?: QueueSendOptions }> = [];
    const settlement = queueMessage({
      kind: "wager-settlement",
      inviteId: "invite-1",
      matchId: "invite-1",
      operationId: "a".repeat(64),
    });
    const unrelated = queueMessage({ kind: "invalid-telegram-task" });
    await worker.queue(
      queueBatch("mons-link-telegram-delivery", [
        settlement.message,
        unrelated.message,
      ]),
      {
        ...withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "frozen"),
        WAGER_SETTLEMENT_QUEUE: {
          ...TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE,
          send: async (body, options) => {
            deferred.push({ body, options });
            return {
              metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
            };
          },
        },
      },
    );
    expect(settlement.acknowledgements()).toBe(1);
    expect(settlement.retries).toEqual([]);
    expect(deferred).toEqual([
      { body: settlement.message.body, options: undefined },
    ]);
    expect(unrelated.acknowledgements()).toBe(1);
    expect(unrelated.retries).toEqual([]);
  });

  it("routes completed and stale wagers past frozen or unreadable global profile gates", async () => {
    for (const control of ["frozen", "unreadable"] as const) {
      for (const status of ["completed", "stale"] as const) {
        let stateReads = 0;
        const environment = withProfileControl(
          TELEGRAM_TEST_ENV as unknown as Env,
          "frozen",
        );
        const base = environment.PROFILE_DB;
        const state = {
          activation_epoch: 1,
          verified_at_ms: 1,
          activated_at_ms: 1,
          invite_id: "invite-1",
          match_id: "invite-1",
          wager_json: JSON.stringify({
            settlement: {
              version: 2,
              kind: "proposals",
              state: "completed",
              operationId: (status === "completed" ? "a" : "b").repeat(64),
              fingerprint: "settlement-fingerprint",
              claimedAtMs: 1,
              completedAtMs: 2,
              releases: [],
            },
          }),
          resolution_marker: null,
          revision: 1,
        };
        const database: D1Database = {
          batch: base.batch.bind(base),
          dump: base.dump.bind(base),
          exec: base.exec.bind(base),
          prepare(query) {
            if (
              query.includes("profile_canonical_control") &&
              control === "unreadable"
            ) {
              throw new Error("profile-control-unavailable");
            }
            if (!query.includes("wager_state_activation")) {
              return base.prepare(query);
            }
            const fallback = base.prepare(query);
            const statement: D1PreparedStatement = {
              all: fallback.all.bind(fallback),
              raw: fallback.raw.bind(fallback),
              run: fallback.run.bind(fallback),
              bind: () => statement,
              first: async <T>() => {
                stateReads += 1;
                return state as T;
              },
            };
            return statement;
          },
          withSession: () => ({
            prepare: (query) => database.prepare(query),
            batch: base.batch.bind(base),
            getBookmark: () => null,
          }),
        };
        const tracked = queueMessage({
          kind: "wager-settlement",
          inviteId: "invite-1",
          matchId: "invite-1",
          operationId: "a".repeat(64),
        });
        await worker.queue(
          queueBatch(WAGER_SETTLEMENT_QUEUE_NAME, [tracked.message]),
          {
            ...environment,
            PROFILE_DB: database,
            WAGER_SETTLEMENT_QUEUE: {
              ...TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE,
              send: async () => {
                throw new Error("unexpected-wager-deferral");
              },
            },
            get TELEGRAM_DB(): D1Database {
              throw new Error("unexpected-telegram-db");
            },
            get TELEGRAM_DELIVERY_QUEUE(): Queue {
              throw new Error("unexpected-telegram-queue");
            },
            get TELEGRAM_BOT_TOKEN(): string {
              throw new Error("unexpected-telegram-token");
            },
          },
        );
        expect(stateReads).toBeGreaterThan(0);
        expect(tracked.acknowledgements()).toBe(1);
        expect(tracked.retries).toEqual([]);
      }
    }
  });

  it("pauses profile Cron work while independent sweeps continue", async () => {
    const calls: string[] = [];
    const tasks = {
      authRecovery: async () => calls.push("authRecovery"),
      authState: async () => calls.push("authState"),
      eventProgress: async () => calls.push("eventProgress"),
      eventTransitions: async () => calls.push("eventTransitions"),
      gameSessionLocks: async () => calls.push("gameSessionLocks"),
      gameSessionReceipts: async () => calls.push("gameSessionReceipts"),
      matchTimerStarts: async () => calls.push("matchTimerStarts"),
      profileGameProjection: async () => calls.push("profileGameProjection"),
      telegramProjection: async () => calls.push("telegramProjection"),
    };
    await handleScheduled(
      controller,
      withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "frozen"),
      tasks,
    );
    expect(new Set(calls)).toEqual(
      new Set(["authState", "gameSessionLocks", "gameSessionReceipts"]),
    );

    calls.length = 0;
    await handleScheduled(
      controller,
      withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "active"),
      tasks,
    );
    expect(new Set(calls)).toEqual(
      new Set([
        "authRecovery",
        "authState",
        "eventProgress",
        "eventTransitions",
        "gameSessionLocks",
        "gameSessionReceipts",
        "matchTimerStarts",
        "profileGameProjection",
        "telegramProjection",
      ]),
    );
  });

  it("runs all scheduled work and reports the first failure", async () => {
    const calls: string[] = [];
    const progressFailure = new Error("event-progress-failed");
    const transitionFailure = new Error("poison-transition");
    let thrown: unknown;
    try {
      await handleScheduled(
        controller,
        withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "active"),
        {
          authRecovery: async () => undefined,
          authState: async () => undefined,
          eventProgress: async () => {
            calls.push("eventProgress");
            throw progressFailure;
          },
          eventTransitions: async () => {
            calls.push("eventTransitions");
            throw transitionFailure;
          },
          gameSessionLocks: async () => undefined,
          gameSessionReceipts: async () => undefined,
          matchTimerStarts: async () => undefined,
          profileGameProjection: async () => undefined,
          telegramProjection: async () => undefined,
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(new Set(calls)).toEqual(
      new Set(["eventProgress", "eventTransitions"]),
    );
    expect(thrown).toBe(progressFailure);
  });
});
