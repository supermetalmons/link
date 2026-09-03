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

  it("acks stale wagers while frozen without blocking Telegram work", async () => {
    const deferred: Array<{ body: unknown; options?: QueueSendOptions }> = [];
    const settlement = queueMessage({
      kind: "wager-settlement",
      inviteId: "invite-1",
      matchId: "match-1",
      operationId: "operation-1",
    });
    const unrelated = queueMessage({ kind: "invalid-telegram-task" });
    await worker.queue(
      queueBatch("mons-link-telegram-delivery", [
        settlement.message,
        unrelated.message,
      ]),
      {
        ...withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "frozen"),
        TELEGRAM_DELIVERY_QUEUE: {
          ...TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE,
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
    expect(deferred).toEqual([]);
    expect(unrelated.acknowledgements()).toBe(1);
    expect(unrelated.retries).toEqual([]);
  });

  it("pauses profile Cron work while independent sweeps continue", async () => {
    const calls: string[] = [];
    const tasks = {
      authRecovery: async () => calls.push("authRecovery"),
      authState: async () => calls.push("authState"),
      eventProgress: async () => calls.push("eventProgress"),
      eventTransitions: async () => calls.push("eventTransitions"),
      gameSessionReceipts: async () => calls.push("gameSessionReceipts"),
      profileGameProjection: async () => calls.push("profileGameProjection"),
      telegramProjection: async () => calls.push("telegramProjection"),
    };
    await handleScheduled(
      controller,
      withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "frozen"),
      tasks,
    );
    expect(calls).toEqual(["gameSessionReceipts", "authState"]);

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
        "gameSessionReceipts",
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
          gameSessionReceipts: async () => undefined,
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
