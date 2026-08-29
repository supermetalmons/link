import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import * as entrypoint from "../src/index.ts";
import {
  createEventProgressWorkflowDependencies,
  EventProgressWorkflow,
} from "../src/eventProgressWorkflow.ts";
import { EventPrizeWithdrawalWorkflow } from "../src/eventPrizeWithdrawalWorkflow.ts";
import { AUTH_RECOVERY_QUEUE_NAME } from "../src/authRecovery.ts";
import { PROFILE_READ_PROJECTION_QUEUE_NAME } from "../src/profileReadProjectionTasks.ts";
import worker from "../src/workerHandler.ts";

const testEnv = env as Env & {
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

function queueMessage(body: unknown) {
  const retries: QueueRetryOptions[] = [];
  const message = {
    id: crypto.randomUUID(),
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack: () => undefined,
    retry: (options?: QueueRetryOptions) => retries.push(options || {}),
  } satisfies Message<unknown>;
  return { message, retries };
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

describe("Worker entrypoint", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
    );
  });

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

  it("blocks event progress after import begins", async () => {
    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'importing'
       WHERE singleton = 1 AND state = 'firestore'`,
    ).run();
    const dependencies = createEventProgressWorkflowDependencies(testEnv);
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

  it("keeps old profile background work blocked after import", async () => {
    const runtimeEnv = testEnv;
    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'importing'
       WHERE singleton = 1 AND state = 'firestore'`,
    ).run();
    const recovery = queueMessage({ kind: "recovery" });
    await worker.queue(
      queueBatch(AUTH_RECOVERY_QUEUE_NAME, [recovery.message]),
      runtimeEnv,
    );
    expect(recovery.retries).toEqual([{ delaySeconds: 300 }]);

    const wager = queueMessage({
      kind: "wager-settlement",
      inviteId: "invite-1",
      matchId: "match-1",
      operationId: "operation-1",
    });
    await worker.queue(
      queueBatch("mons-link-telegram-delivery", [wager.message]),
      runtimeEnv,
    );
    expect(wager.retries).toEqual([{ delaySeconds: 300 }]);

    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET import_digest = ?, import_plan_version = 1
       WHERE singleton = 1 AND state = 'importing'`,
    )
      .bind("0".repeat(64))
      .run();
    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'frozen', imported_at_ms = 1
       WHERE singleton = 1 AND state = 'importing'`,
    ).run();
    const frozenProjection = queueMessage({ kind: "projection" });
    await worker.queue(
      queueBatch(PROFILE_READ_PROJECTION_QUEUE_NAME, [
        frozenProjection.message,
      ]),
      runtimeEnv,
    );
    expect(frozenProjection.retries).toEqual([{ delaySeconds: 300 }]);

    await testEnv.PROFILE_DB.prepare(
      `UPDATE profile_canonical_control
       SET state = 'active'
       WHERE singleton = 1 AND state = 'frozen'`,
    ).run();
    const cutoverRecovery = queueMessage({ kind: "recovery" });
    await worker.queue(
      queueBatch(AUTH_RECOVERY_QUEUE_NAME, [cutoverRecovery.message]),
      runtimeEnv,
    );
    expect(cutoverRecovery.retries).toEqual([{ delaySeconds: 300 }]);
  });
});
