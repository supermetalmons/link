import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildEventProgressPlan,
  ensureEventProgressWorkflow,
  sweepEventProgress,
  type EventProgressPlan,
  type EventProgressSweepRepository,
} from "../src/eventProgress.ts";
import { readEventOwnedPath } from "../src/eventD1.ts";
import { createEventStateRepository } from "../src/eventRepository.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & {
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_D1_MIGRATIONS: D1Migration[];
};
const eventId = "dispatch-admission-event";

async function freezeEventGate(): Promise<boolean> {
  const result = await testEnv.EVENT_DB.prepare(
    `UPDATE event_runtime_control
     SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1
     WHERE singleton = 1 AND storage_mode = 'd1'
       AND NOT EXISTS (SELECT 1 FROM event_write_admissions)
       AND NOT EXISTS (SELECT 1 FROM event_transition_intents)
       AND NOT EXISTS (SELECT 1 FROM event_leases)
     RETURNING singleton`,
  ).all();
  return result.results.length === 1;
}

async function admissionCount(): Promise<number | null> {
  return testEnv.EVENT_DB.prepare(
    "SELECT COUNT(*) AS count FROM event_write_admissions",
  ).first<number>("count");
}

function environment(
  status: "waiting" | "complete" | "errored" = "waiting",
  beforeProvider: (operation: string) => Promise<void> = async () => {},
) {
  const operations: string[] = [];
  const call = async (operation: string) => {
    operations.push(operation);
    await beforeProvider(operation);
  };
  const instance: WorkflowInstance = {
    id: "dispatch-workflow",
    delete: () => call("delete"),
    pause: async () => {},
    restart: async () => {},
    resume: async () => {},
    sendEvent: async () => {},
    status: async () => {
      await call("status");
      return { status };
    },
    terminate: async () => {},
  };
  const value: Env = {
    ...testEnv,
    EVENT_PROGRESS_WORKFLOW: {
      create: async () => {
        await call("create");
        return instance;
      },
      createBatch: async () => {
        await call("createBatch");
        return [instance];
      },
      deleteBatch: async () => ({ deleted: [], errors: [] }),
      get: async () => {
        await call("get");
        return instance;
      },
    },
  };
  return { value, operations };
}

async function seedOutbox(): Promise<{
  plan: EventProgressPlan;
  repository: EventProgressSweepRepository;
}> {
  const plan = await buildEventProgressPlan(
    { eventId, sourceKey: "timer:test", reason: "timer-claimed" },
    100,
  );
  const client = createEventStateRepository(testEnv);
  await client.patchRoot({
    [`events/${eventId}`]: {
      schemaVersion: 2,
      eventId,
      status: "active",
      createdAtMs: 100,
      updatedAtMs: 100,
      startAtMs: 100,
      createdByProfileId: "profile-one",
      createdByLoginUid: "host",
      createdByUsername: "ivan",
      participants: {},
      rounds: {},
    },
    [`eventProgressOutbox/${plan.outboxId}`]: plan.outbox,
  });
  return {
    plan,
    repository: {
      getStatePath: client.getPath,
      patchStateRoot: client.patchRoot,
    },
  };
}

describe("event-progress Workflow dispatch admissions", () => {
  beforeAll(async () => {
    await applyStrictMatchStateTestMigrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_transition_intents"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_progress_outboxes"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_leases"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
      testEnv.EVENT_DB.prepare(
        "UPDATE event_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
      ),
    ]);
  });

  it("retains frozen outboxes without creating or recreating Workflows through either production entry point", async () => {
    const { plan, repository } = await seedOutbox();
    const f = environment("errored");
    expect(await freezeEventGate()).toBe(true);
    await sweepEventProgress(f.value, { repository, ratingRepository: null });
    await ensureEventProgressWorkflow(f.value, plan);
    expect(f.operations).toEqual([]);
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventProgressOutbox/${plan.outboxId}`,
      ),
    ).toEqual(plan.outbox);
    expect(await admissionCount()).toBe(0);
  });

  for (const status of ["waiting", "complete", "errored"] as const) {
    it(`prevents the gate from closing during ${status} dispatch and outbox publication`, async () => {
      const { plan, repository } = await seedOutbox();
      const blocked: string[] = [];
      const assertBlocked = async (phase: string) => {
        expect(await admissionCount()).toBeGreaterThan(0);
        expect(await freezeEventGate()).toBe(false);
        blocked.push(phase);
      };
      const f = environment(status, assertBlocked);
      await sweepEventProgress(f.value, {
        repository: {
          ...repository,
          async patchStateRoot(updates) {
            await assertBlocked("before-outbox");
            await repository.patchStateRoot(updates);
            await assertBlocked("after-outbox");
          },
        },
        now: () => 200,
        ratingRepository: null,
      });
      expect(blocked).toContain("createBatch");
      if (status === "errored") {
        expect(blocked).toContain("delete");
        expect(
          f.operations.filter((value) => value === "createBatch"),
        ).toHaveLength(2);
      } else {
        expect(blocked).toContain("after-outbox");
        const outbox = await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutbox/${plan.outboxId}`,
        );
        if (status === "complete") expect(outbox).toBeNull();
        else expect(outbox).toMatchObject({ lastQueuedAtMs: 200 });
      }
      expect(await admissionCount()).toBe(0);
      expect(await freezeEventGate()).toBe(true);
    });
  }

  it("holds an admission for delayed direct dispatch and releases it after completion", async () => {
    const { plan } = await seedOutbox();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const f = environment("waiting", async (operation) => {
      if (operation !== "createBatch") return;
      started.resolve();
      await finish.promise;
    });
    const dispatch = ensureEventProgressWorkflow(f.value, plan);
    await started.promise;
    expect(await admissionCount()).toBe(1);
    expect(await freezeEventGate()).toBe(false);
    finish.resolve();
    await dispatch;
    expect(await admissionCount()).toBe(0);
    expect(await freezeEventGate()).toBe(true);
  });

  it("retains the outbox and releases the admission when provider dispatch fails", async () => {
    const { plan, repository } = await seedOutbox();
    const f = environment("waiting", async () => {
      throw new Error("workflow-dispatch-failed");
    });
    await expect(
      sweepEventProgress(f.value, { repository, ratingRepository: null }),
    ).rejects.toThrow("workflow-dispatch-failed");
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventProgressOutbox/${plan.outboxId}`,
      ),
    ).toEqual(plan.outbox);
    expect(await admissionCount()).toBe(0);
  });
});
