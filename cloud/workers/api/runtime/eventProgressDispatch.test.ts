import { commitEventCompatibilityFixture } from "../test/eventCompatibilityFixture.ts";
import type { D1Migration } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import { buildEventAnnouncementPlan } from "../src/eventPrizeAnnouncementSchedule.ts";
import { runEventAnnouncementWorkflow } from "../src/eventPrizeAnnouncementWorkflow.ts";
import {
  buildEventProgressPlan,
  ensureEventProgressWorkflow,
  parseEventProgressOutbox,
  sweepEventProgress,
  type EventProgressPlan,
  type EventProgressSweepRepository,
} from "../src/eventProgress.ts";
import { createEventStateRepository } from "../src/eventRepository.ts";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import { createEventProgressRecoveryStore } from "../src/eventProgressRecoveryD1.ts";
import {
  dispatchOutboxSnapshot,
  withEventProgressDispatchAdmission,
} from "../src/eventProgressDispatch.ts";
import { readEventOwnedPath } from "./eventD1Fixture.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { recoveryCandidates } from "../test/recoveryScanTestFixtures.ts";

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
  existingIds: string[] = [],
) {
  const operations: string[] = [];
  const call = async (operation: string) => {
    operations.push(operation);
    await beforeProvider(operation);
  };
  const instances = new Map<string, WorkflowInstance>();
  const addInstance = (id: string): WorkflowInstance => {
    const instance: WorkflowInstance = {
      id,
      delete: async () => {
        await call("delete");
        instances.delete(id);
      },
      pause: async () => {},
      restart: async () => {},
      resume: async () => {},
      sendEvent: async () => {},
      status: async () => {
        await call("status");
        if (!instances.has(id)) throw new Error("instance-missing");
        return { status };
      },
      terminate: async () => {},
    };
    instances.set(id, instance);
    return instance;
  };
  for (const id of existingIds) addInstance(id);
  const value: Env = {
    ...testEnv,
    EVENT_PROGRESS_WORKFLOW: {
      create: async (options) => {
        await call("create");
        return addInstance(options?.id || crypto.randomUUID());
      },
      createBatch: async (items) => {
        await call("createBatch");
        return items.map(({ id }) => {
          const instanceId = id || crypto.randomUUID();
          if (instances.has(instanceId)) throw new Error("instance-exists");
          return addInstance(instanceId);
        });
      },
      deleteBatch: async () => ({ deleted: [], errors: [] }),
      get: async (id) => {
        await call("get");
        const instance = instances.get(id);
        if (!instance) throw new Error("instance-missing");
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
  await commitEventCompatibilityFixture(
    client,
    decodeEventUpdates({
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
    }),
  );
  return {
    plan,
    repository: {
      readEvent: client.readEvent,
      listDueEventProgressOutboxes: client.listDueEventProgressOutboxes,
      readEventProgressOutbox: client.readEventProgressOutbox,
      commitEventPlan: client.commitEventPlan,
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

  it("dispatches a supplied snapshot using the instance returned by creation", async () => {
    const { plan } = await seedOutbox();
    const f = environment();
    await withEventProgressDispatchAdmission(
      testEnv.EVENT_DB,
      async (admission) => {
        const recovery = createEventProgressRecoveryStore(
          testEnv.EVENT_DB,
          admission,
        );
        const current = (await recovery.read(plan.outboxId))!;
        const read = vi.spyOn(recovery, "read");
        await dispatchOutboxSnapshot(f.value, recovery, current, () => 200);
        expect(read).not.toHaveBeenCalled();
        expect(f.operations).toEqual(["get", "createBatch", "status"]);
        expect(await recovery.read(plan.outboxId)).toEqual({
          ...current,
          nextReconcileAtMs: 300_000,
        });
      },
    );
    expect(await admissionCount()).toBe(0);
  });

  it("accepts an empty direct creation result without looking up the existing instance", async () => {
    const { plan } = await seedOutbox();
    const f = environment();
    f.value.EVENT_PROGRESS_WORKFLOW.createBatch = async () => {
      f.operations.push("createBatch");
      return [];
    };
    f.value.EVENT_PROGRESS_WORKFLOW.get = async () => {
      f.operations.push("get");
      throw new Error("unexpected-direct-dispatch-lookup");
    };
    await expect(
      ensureEventProgressWorkflow(f.value, plan),
    ).resolves.toBeUndefined();
    expect(f.operations).toEqual(["createBatch"]);
    expect(await admissionCount()).toBe(0);
  });

  it.each(["empty", "throws"] as const)(
    "reads an existing instance when a racing batch creation %s",
    async (creation) => {
      const { plan } = await seedOutbox();
      const f = environment("waiting", undefined, [plan.workflowId]);
      const get = f.value.EVENT_PROGRESS_WORKFLOW.get;
      let firstRead = true;
      f.value.EVENT_PROGRESS_WORKFLOW.get = async (id) => {
        if (firstRead) {
          firstRead = false;
          f.operations.push("get");
          throw new Error("workflow-not-found-before-concurrent-create");
        }
        return get(id);
      };
      f.value.EVENT_PROGRESS_WORKFLOW.createBatch = async () => {
        f.operations.push("createBatch");
        if (creation === "throws") throw new Error("workflow-already-exists");
        return [];
      };
      await withEventProgressDispatchAdmission(
        testEnv.EVENT_DB,
        async (admission) => {
          const recovery = createEventProgressRecoveryStore(
            testEnv.EVENT_DB,
            admission,
          );
          const current = (await recovery.read(plan.outboxId))!;
          await dispatchOutboxSnapshot(f.value, recovery, current, () => 200);
          expect(f.operations).toEqual(["get", "createBatch", "get", "status"]);
          expect(await recovery.read(plan.outboxId)).toEqual({
            ...current,
            nextReconcileAtMs: 300_000,
          });
        },
      );
    },
  );

  it("preserves the creation failure when the fallback lookup also fails", async () => {
    const { plan } = await seedOutbox();
    const f = environment();
    const creationFailure = new Error("workflow-create-failed");
    const lookupFailure = new Error("workflow-lookup-failed");
    f.value.EVENT_PROGRESS_WORKFLOW.createBatch = async () => {
      throw creationFailure;
    };
    f.value.EVENT_PROGRESS_WORKFLOW.get = async () => {
      throw lookupFailure;
    };
    await withEventProgressDispatchAdmission(
      testEnv.EVENT_DB,
      async (admission) => {
        const recovery = createEventProgressRecoveryStore(
          testEnv.EVENT_DB,
          admission,
        );
        const current = (await recovery.read(plan.outboxId))!;
        await expect(
          dispatchOutboxSnapshot(f.value, recovery, current, () => 200),
        ).rejects.toBe(creationFailure);
        expect(await recovery.read(plan.outboxId)).toEqual({
          ...current,
          nextReconcileAtMs: 300_000,
        });
      },
    );
    expect(await admissionCount()).toBe(0);
  });

  it("keeps a concurrent replacement when checkpointing a supplied snapshot", async () => {
    const { plan, repository } = await seedOutbox();
    const f = environment("waiting", undefined, [plan.workflowId]);
    await withEventProgressDispatchAdmission(
      testEnv.EVENT_DB,
      async (admission) => {
        const recovery = createEventProgressRecoveryStore(
          testEnv.EVENT_DB,
          admission,
        );
        const current = (await recovery.read(plan.outboxId))!;
        const replacement = { ...plan.outbox, lastQueuedAtMs: 300 };
        await commitEventCompatibilityFixture(repository, [
          {
            kind: "progress-outbox",
            outboxId: plan.outboxId,
            value: replacement,
          },
        ]);
        await dispatchOutboxSnapshot(f.value, recovery, current, () => 400);
        expect(await recovery.read(plan.outboxId)).toEqual({
          ...current,
          record: replacement,
          recordJson: JSON.stringify(replacement),
        });
      },
    );
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

  for (const providerFails of [false, true]) {
    it.each(["unconfirmed", "throws"] as const)(
      `preserves ${providerFails ? "failed" : "successful"} direct dispatch when admission release %s`,
      async (release) => {
        const { plan } = await seedOutbox();
        const failure = new Error("provider-dispatch-failed");
        const f = environment();
        if (providerFails) {
          f.value.EVENT_PROGRESS_WORKFLOW.createBatch = async () => {
            throw failure;
          };
          f.value.EVENT_PROGRESS_WORKFLOW.get = async () => {
            throw new Error("workflow-not-found");
          };
        }
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        await testEnv.EVENT_DB.prepare(
          `CREATE TRIGGER fail_dispatch_admission_release BEFORE DELETE ON event_write_admissions
           BEGIN SELECT ${release === "unconfirmed" ? "RAISE(IGNORE)" : "RAISE(ABORT, 'dispatch-admission-release-failed')"}; END`,
        ).run();
        try {
          const operation = ensureEventProgressWorkflow(f.value, plan);
          if (providerFails) await expect(operation).rejects.toBe(failure);
          else await expect(operation).resolves.toBeUndefined();
          expect(await admissionCount()).toBe(1);
          expect(
            await readEventOwnedPath(
              testEnv.EVENT_DB,
              `eventProgressOutbox/${plan.outboxId}`,
            ),
          ).toEqual(plan.outbox);
          expect(
            errors.mock.calls.map(([entry]) => JSON.parse(String(entry))),
          ).toEqual([
            {
              event: "event_progress_dispatch_admission_release_failed",
              kind: release === "unconfirmed" ? "unconfirmed" : "Error",
            },
          ]);
        } finally {
          errors.mockRestore();
          await testEnv.EVENT_DB.batch([
            testEnv.EVENT_DB.prepare(
              "DROP TRIGGER fail_dispatch_admission_release",
            ),
            testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
          ]);
        }
      },
    );
  }

  it("isolates BLOB outbox IDs so healthy dispatch and scheduled recovery continue", async () => {
    const { plan, repository } = await seedOutbox();
    const recordJson = JSON.stringify(plan.outbox);
    await testEnv.EVENT_DB.prepare(
      `INSERT INTO event_progress_outboxes (
         outbox_id, event_id, status, run_at_ms, last_queued_at_ms, record_json
       ) VALUES (CAST(? AS BLOB), ?, 'pending', NULL, 50, ?)`,
    )
      .bind("bad", eventId, recordJson)
      .run();
    const cursorRevision = await testEnv.EVENT_DB.prepare(
      "SELECT revision FROM event_scheduled_recovery_cursor WHERE singleton = 1",
    ).first<number>("revision");
    const f = environment();

    await sweepEventProgress(f.value, {
      repository,
      now: () => 200,
      ratingRepository: null,
    });

    expect(f.operations).toContain("createBatch");
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventProgressOutbox/${plan.outboxId}`,
      ),
    ).toEqual(plan.outbox);
    expect(
      await testEnv.EVENT_DB.prepare(
        "SELECT revision FROM event_scheduled_recovery_cursor WHERE singleton = 1",
      ).first<number>("revision"),
    ).toBe(cursorRevision! + 1);
    expect(
      await testEnv.EVENT_DB.prepare(
        `SELECT hex(outbox_id) AS outbox_id_hex, status, last_queued_at_ms,
           record_json FROM event_progress_outboxes
         WHERE typeof(outbox_id) = 'blob'`,
      ).all(),
    ).toMatchObject({
      results: [
        {
          outbox_id_hex: "626164",
          status: "pending",
          last_queued_at_ms: 50,
          record_json: recordJson,
        },
      ],
    });
    expect(await admissionCount()).toBe(0);
    expect(
      (
        await testEnv.EVENT_DB.prepare(
          "SELECT outbox_id FROM event_progress_outboxes WHERE status = 'dead'",
        ).all()
      ).results,
    ).toEqual([]);
  });

  it.each(
    (["publication-first", "cleanup-first"] as const).flatMap((order) => [
      {
        lane: "announcement" as const,
        field: "firstQueuedAtMs" as const,
        order,
      },
      ...(["schemaVersion", "sourceKey", "reason"] as const).flatMap((field) =>
        (["announcement", "rating"] as const).map((lane) => ({
          lane,
          field,
          order,
        })),
      ),
    ]),
  )(
    "retains malformed $field audit for $lane with $order recovery",
    async ({ lane, field, order }) => {
      const { repository } = await seedOutbox();
      const nowMs = 1_000_000;
      const event = {
        eventId,
        status: "scheduled" as const,
        isSundayMons: true,
        startAtMs: nowMs + 14_400_000 + 30_000,
      };
      const plan =
        lane === "announcement"
          ? await buildEventAnnouncementPlan(eventId, event, nowMs, "reminder")
          : await buildEventProgressPlan(
              {
                eventId,
                sourceKey: "rating:rating-invite:match-1",
                reason: "match-rating-updated",
              },
              nowMs,
            );
      if (!plan) throw new Error("missing-recovery-plan");
      await commitEventCompatibilityFixture(repository, [
        { kind: "event-field", eventId, field: "status", value: event.status },
        {
          kind: "event-field",
          eventId,
          field: "startAtMs",
          value: event.startAtMs,
        },
        { kind: "event-field", eventId, field: "isSundayMons", value: true },
        {
          kind: "progress-outbox",
          outboxId: plan.outboxId,
          value: plan.outbox,
        },
      ]);
      const malformed: Record<string, unknown> = { ...plan.outbox };
      if (field === "firstQueuedAtMs") delete malformed.firstQueuedAtMs;
      else
        malformed[field] =
          field === "schemaVersion"
            ? 2
            : field === "sourceKey"
              ? "mismatched-source"
              : { invalid: true };
      await testEnv.EVENT_DB.prepare(
        "UPDATE event_progress_outboxes SET record_json = ? WHERE status = 'pending' AND outbox_id = ?",
      )
        .bind(JSON.stringify(malformed), plan.outboxId)
        .run();
      const published = Promise.withResolvers<void>();
      const cleaned = Promise.withResolvers<void>();
      const f = environment();
      const ratingOutcomes: string[] = [];
      const recoveryAdmission = await acquireEventWriteAdmission(
        testEnv.EVENT_DB,
      );
      const outboxRecovery = createEventProgressRecoveryStore(
        testEnv.EVENT_DB,
        recoveryAdmission,
      );
      try {
        await sweepEventProgress(f.value, {
          now: () => nowMs,
          outboxRecovery: {
            ...outboxRecovery,
            async listDue(beforeMs, limit) {
              const rows = await outboxRecovery.listDue(beforeMs, limit);
              if (order === "publication-first") await published.promise;
              return rows.filter((row) => row.outboxId === plan.outboxId);
            },
            async deadLetter(snapshot, deadAtMs) {
              const removed = await outboxRecovery.deadLetter(
                snapshot,
                deadAtMs,
              );
              if (removed && snapshot.outboxId === plan.outboxId)
                cleaned.resolve();
              return removed;
            },
          },
          ratingRepository:
            lane === "rating"
              ? {
                  quarantineRatingRecoveryEntry: async () => null,
                  scanDueRatingEventProgress: async () => {
                    if (order === "cleanup-first") await cleaned.promise;
                    return recoveryCandidates([
                      {
                        eventId,
                        inviteId: "rating-invite",
                        matchId: "match-1",
                        operationId: "rating-invite__match-1",
                        revision: 1,
                        version: 1,
                      },
                    ]);
                  },
                  claimRatingEventProgress: async () => true,
                  markRatingEventProgress: async (operationId, state) => {
                    expect(operationId).toBe("rating-invite__match-1");
                    ratingOutcomes.push(state);
                  },
                }
              : null,
          repository: {
            ...repository,
            async commitEventPlan(commands) {
              await commitEventCompatibilityFixture(repository, commands);
              for (const command of commands) {
                if (
                  command.kind !== "progress-outbox" ||
                  command.outboxId !== plan.outboxId
                )
                  continue;
                if (command.value !== null) published.resolve();
              }
            },
          },
          scheduledRecovery: {
            readCursor: async () => ({ cursor: null, revision: 0 }),
            listPage: async () => [],
            listUrgent: async () => {
              if (lane === "rating") return [];
              if (order === "cleanup-first") await cleaned.promise;
              return [
                { cursor: { eventId, startAtMs: event.startAtMs }, event },
              ];
            },
            checkpoint: async () => true,
          },
        });
      } finally {
        await releaseEventWriteAdmission(testEnv.EVENT_DB, recoveryAdmission);
      }
      expect(await repository.readEventProgressOutbox(plan.outboxId)).toEqual(
        plan.outbox,
      );
      expect(
        await parseEventProgressOutbox(
          plan.outboxId,
          await repository.readEventProgressOutbox(plan.outboxId),
        ),
      ).toEqual(plan);
      expect(
        await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutboxDead/${plan.outboxId}`,
        ),
      ).toMatchObject({
        reason: "invalid-event-progress-outbox",
        originalRecord: malformed,
      });
      expect(await admissionCount()).toBe(0);
      if (lane === "rating") {
        expect(ratingOutcomes).toEqual(["done"]);
        return;
      }

      const step = Object.create(null) as WorkflowStep;
      step.sleepUntil = async () => {};
      step.do = (async (
        _name: string,
        _options: unknown,
        work: () => Promise<unknown>,
      ) => work()) as WorkflowStep["do"];
      let deliveries = 0;
      const result = await runEventAnnouncementWorkflow(
        {
          payload: plan.params,
          instanceId: plan.workflowId,
          timestamp: new Date(nowMs),
          workflowName: "mons-link-event-progress",
        },
        step,
        {
          now: () => plan.params.runAtMs!,
          readOutbox: repository.readEventProgressOutbox,
          acknowledge: (outboxId) =>
            commitEventCompatibilityFixture(repository, [
              { kind: "progress-outbox", outboxId, value: null },
            ]),
          deliver: async () => {
            deliveries++;
            return { status: "sent" };
          },
          refreshReminder: async () => ({ status: "skipped" }),
        },
      );
      expect(result).toEqual({ status: "sent" });
      expect(deliveries).toBe(1);
    },
  );

  for (const [status, exists] of (
    ["waiting", "complete", "errored"] as const
  ).flatMap((status) =>
    [false, true].map((exists) => [status, exists] as const),
  )) {
    it(`prevents the gate from closing during ${exists ? "existing" : "missing"} ${status} dispatch and outbox publication`, async () => {
      const { plan, repository } = await seedOutbox();
      const blocked: string[] = [];
      let providerStarted = false;
      const assertBlocked = async (phase: string) => {
        expect(await admissionCount()).toBeGreaterThan(0);
        expect(await freezeEventGate()).toBe(false);
        blocked.push(phase);
      };
      const f = environment(
        status,
        async (phase) => {
          providerStarted = true;
          await assertBlocked(phase);
        },
        exists ? [plan.workflowId] : [],
      );
      const db = f.value.EVENT_DB;
      f.value.EVENT_DB = new Proxy(db, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (providerStarted) await assertBlocked("before-outbox");
              const result = await target.batch(statements);
              if (providerStarted) await assertBlocked("after-outbox");
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await sweepEventProgress(f.value, {
        repository,
        now: () => 200,
        ratingRepository: null,
      });
      expect(blocked).toContain("get");
      expect(blocked).toContain("status");
      expect(
        f.operations.filter((value) => value === "createBatch"),
      ).toHaveLength((exists ? 0 : 1) + (status === "errored" ? 1 : 0));
      if (status === "errored") {
        expect(blocked).toContain("delete");
      } else {
        expect(blocked).toContain("after-outbox");
        const outbox = await readEventOwnedPath(
          testEnv.EVENT_DB,
          `eventProgressOutbox/${plan.outboxId}`,
        );
        if (status === "complete") expect(outbox).toBeNull();
        else expect(outbox).toEqual(plan.outbox);
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

  it("shares confirmed deadlines across persisted, scheduled-start, and announcement recovery", async () => {
    const { plan, repository } = await seedOutbox();
    let nowMs = 1_000_000;
    await commitEventCompatibilityFixture(repository, [
      { kind: "progress-outbox", outboxId: plan.outboxId, value: null },
      { kind: "event-field", eventId, field: "status", value: "scheduled" },
      {
        kind: "event-field",
        eventId,
        field: "startAtMs",
        value: nowMs + 5 * 3_600_000,
      },
      { kind: "event-field", eventId, field: "isSundayMons", value: true },
    ]);
    const f = environment();
    const sweep = () =>
      sweepEventProgress(f.value, {
        repository,
        now: () => nowMs,
        ratingRepository: null,
      });
    await sweep();
    expect(
      f.operations.filter((operation) => operation === "status"),
    ).toHaveLength(2);
    const original = await testEnv.EVENT_DB.prepare(
      "SELECT outbox_id, record_json FROM event_progress_outboxes WHERE status = 'pending' ORDER BY outbox_id",
    ).all();
    expect(original.results).toHaveLength(2);
    nowMs += 300_000;
    await sweep();
    expect(
      f.operations.filter((operation) => operation === "status"),
    ).toHaveLength(2);
    nowMs += 3_300_000;
    await sweep();
    expect(
      f.operations.filter((operation) => operation === "status"),
    ).toHaveLength(4);
    expect(
      (
        await testEnv.EVENT_DB.prepare(
          "SELECT outbox_id, record_json FROM event_progress_outboxes WHERE status = 'pending' ORDER BY outbox_id",
        ).all()
      ).results,
    ).toEqual(original.results);
    expect(await admissionCount()).toBe(0);
  });

  it("keeps the sweep admitted across a failed outbox lane and a delayed scheduled lane", async () => {
    const { plan, repository } = await seedOutbox();
    await commitEventCompatibilityFixture(
      repository,
      decodeEventUpdates({
        [`events/${eventId}/status`]: "scheduled",
        [`events/${eventId}/startAtMs`]: 10_000,
      }),
    );
    const started = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const f = environment();
    const create = f.value.EVENT_PROGRESS_WORKFLOW.createBatch;
    const get = f.value.EVENT_PROGRESS_WORKFLOW.get;
    f.value.EVENT_PROGRESS_WORKFLOW.createBatch = async (items) => {
      if (items[0].id === plan.workflowId)
        throw new Error("outbox-dispatch-failed");
      started.resolve();
      await finish.promise;
      return create(items);
    };
    f.value.EVENT_PROGRESS_WORKFLOW.get = async (id) => {
      if (id === plan.workflowId) {
        failed.resolve();
        throw new Error("outbox-workflow-missing");
      }
      return get(id);
    };
    let completed = false;
    const sweep = sweepEventProgress(f.value, {
      repository,
      now: () => 200,
      ratingRepository: null,
    }).then(
      () => {
        completed = true;
        return null;
      },
      (error: unknown) => {
        completed = true;
        return error;
      },
    );
    await Promise.all([started.promise, failed.promise]);
    expect(completed).toBe(false);
    expect(await admissionCount()).toBeGreaterThan(0);
    expect(await freezeEventGate()).toBe(false);
    finish.resolve();
    expect(await sweep).toMatchObject({ message: "outbox-dispatch-failed" });
    expect(await admissionCount()).toBe(0);
    expect(await freezeEventGate()).toBe(true);
    expect(
      await readEventOwnedPath(
        testEnv.EVENT_DB,
        `eventProgressOutbox/${plan.outboxId}`,
      ),
    ).toEqual(plan.outbox);
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
