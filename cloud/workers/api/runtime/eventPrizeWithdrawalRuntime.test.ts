import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { withdrawalWorkflowInstanceId } from "../src/eventPrizeWithdrawal/contracts.ts";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  buildEventPrizeWithdrawalOperationId,
  type EventPrizeWithdrawalWorkflowInput,
} from "../src/eventPrizeWithdrawal.ts";
import {
  runEventPrizeWithdrawalWorkflow,
  runAdmittedEventPrizeWithdrawalWorkflow,
} from "../src/eventPrizeWithdrawalWorkflow.ts";
import { loadSolanaDependencies } from "../../../runtime/eventPrizes/solana.js";
import { withProfileControl } from "../test/testEnv.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_D1_MIGRATIONS: D1Migration[];
};

function workflowStep(afterStep?: (name: string) => void | Promise<void>) {
  const calls: Array<{ config: unknown; name: string }> = [];
  const value = {
    do: async (...args: unknown[]) => {
      const name = String(args[0]);
      const config = args.length === 2 ? undefined : args[1];
      const callback = args.length === 2 ? args[1] : args[2];
      if (typeof callback !== "function") throw new Error("missing-callback");
      calls.push({ config, name });
      const result = await callback();
      await afterStep?.(name);
      return result;
    },
    sleep: async () => undefined,
    sleepUntil: async () => undefined,
    waitForEvent: async () => {
      throw new Error("unexpected-wait");
    },
  };
  return { calls, value: value as WorkflowStep };
}

describe("event prize withdrawal Workflow", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "0".repeat(64),
    );
  });

  it("loads both prize standards in the Workers runtime", () => {
    expect(typeof loadSolanaDependencies("core").mplCore).toBe("function");
    expect(typeof loadSolanaDependencies("compressed").mplBubblegum).toBe(
      "function",
    );
  });

  it("configures durable execution and preserves terminal business errors", async () => {
    const eventId = "NN3eRzoZo80";
    const prizeId = "1092";
    const operationId = await buildEventPrizeWithdrawalOperationId(
      eventId,
      prizeId,
    );
    const params = {
      schemaVersion: 2,
      dataEpoch: 1,
      kind: "withdrawal",
      eventId,
      operationId,
      prizeId,
      profileId: "profile-1",
      recipientAddress: "11111111111111111111111111111111",
      requesterUid: "login-1",
    } as const;
    const event: Readonly<WorkflowEvent<EventPrizeWithdrawalWorkflowInput>> = {
      instanceId: withdrawalWorkflowInstanceId(operationId),
      payload: params,
      timestamp: new Date(0),
      workflowName: "mons-link-event-prize-withdrawal",
    };
    const step = workflowStep();
    const result = await runEventPrizeWithdrawalWorkflow(
      env,
      event,
      step.value,
      {
        execute: async () => {
          throw Object.assign(new Error("Prize is unavailable."), {
            code: "permission-denied",
          });
        },
        preflight: async () => undefined,
      },
    );
    expect(result).toEqual({
      ok: false,
      status: "failed",
      error: "permission-denied",
      message: "Prize is unavailable.",
    });
    expect(step.calls).toEqual([
      {
        name: "wait for profile writes",
        config: {
          retries: {
            limit: 10_000,
            delay: "1 minute",
            backoff: "constant",
          },
          timeout: "30 seconds",
        },
      },
      {
        name: "execute event prize withdrawal",
        config: {
          retries: {
            limit: 3,
            delay: "5 seconds",
            backoff: "exponential",
          },
          timeout: "2 minutes",
        },
      },
    ]);
  });

  it("keeps failed preconditions retryable", async () => {
    const eventId = "NN3eRzoZo80";
    const prizeId = "1092";
    const operationId = await buildEventPrizeWithdrawalOperationId(
      eventId,
      prizeId,
    );
    const step = workflowStep();
    await expect(
      runEventPrizeWithdrawalWorkflow(
        env,
        {
          instanceId: withdrawalWorkflowInstanceId(operationId),
          payload: {
            schemaVersion: 2,
            dataEpoch: 1,
            kind: "withdrawal",
            eventId,
            operationId,
            prizeId,
            profileId: "profile-1",
            recipientAddress: "11111111111111111111111111111111",
            requesterUid: "login-1",
          },
          timestamp: new Date(0),
          workflowName: "mons-link-event-prize-withdrawal",
        },
        step.value,
        {
          execute: async () => {
            throw Object.assign(new Error("Simulation failed."), {
              code: "failed-precondition",
            });
          },
          preflight: async () => undefined,
        },
      ),
    ).rejects.toThrow("Simulation failed.");
  });

  it("runs the read-only preflight as one bounded step", async () => {
    const step = workflowStep();
    let preflights = 0;
    const result = await runEventPrizeWithdrawalWorkflow(
      env,
      {
        instanceId: "preflight-instance",
        payload: { schemaVersion: 2, dataEpoch: 1, kind: "preflight" },
        timestamp: new Date(0),
        workflowName: "mons-link-event-prize-withdrawal",
      },
      step.value,
      {
        execute: async () => {
          throw new Error("unexpected-execution");
        },
        preflight: async () => {
          preflights += 1;
        },
      },
    );
    expect(result).toEqual({ ok: true, status: "ready" });
    expect(preflights).toBe(1);
    expect(step.calls).toEqual([
      {
        name: "validate event prize runtime",
        config: { timeout: "30 seconds" },
      },
    ]);
  });

  it("waits for active profile writes while keeping preflight usable", async () => {
    let executions = 0;
    let preflights = 0;
    const operationId = await buildEventPrizeWithdrawalOperationId(
      "NN3eRzoZo80",
      "1092",
    );
    const withdrawalEvent = {
      instanceId: withdrawalWorkflowInstanceId(operationId),
      payload: {
        schemaVersion: 2,
        dataEpoch: 1,
        kind: "withdrawal",
        eventId: "NN3eRzoZo80",
        operationId,
        prizeId: "1092",
        profileId: "profile-1",
        recipientAddress: "11111111111111111111111111111111",
        requesterUid: "login-1",
      },
      timestamp: new Date(0),
      workflowName: "mons-link-event-prize-withdrawal",
    } as const;
    for (const blockedEnv of [withProfileControl(env, "frozen")]) {
      const withdrawalStep = workflowStep();
      await expect(
        runEventPrizeWithdrawalWorkflow(
          blockedEnv,
          withdrawalEvent,
          withdrawalStep.value,
          {
            execute: async () => {
              executions++;
              throw new Error("unexpected-execution");
            },
            preflight: async () => {
              preflights++;
            },
          },
        ),
      ).rejects.toThrow("profile-writes-disabled");
      expect(withdrawalStep.calls).toEqual([
        {
          name: "wait for profile writes",
          config: {
            retries: {
              limit: 10_000,
              delay: "1 minute",
              backoff: "constant",
            },
            timeout: "30 seconds",
          },
        },
      ]);
    }

    const preflightStep = workflowStep();
    await expect(
      runEventPrizeWithdrawalWorkflow(
        withProfileControl(env, "frozen"),
        {
          instanceId: "frozen-preflight",
          payload: { schemaVersion: 2, dataEpoch: 1, kind: "preflight" },
          timestamp: new Date(0),
          workflowName: "mons-link-event-prize-withdrawal",
        },
        preflightStep.value,
        {
          execute: async () => {
            executions++;
            throw new Error("unexpected-execution");
          },
          preflight: async () => {
            preflights++;
          },
        },
      ),
    ).resolves.toEqual({ ok: true, status: "ready" });
    expect(executions).toBe(0);
    expect(preflights).toBe(1);
    expect(preflightStep.calls).toEqual([
      {
        name: "validate event prize runtime",
        config: { timeout: "30 seconds" },
      },
    ]);
  });

  it("rechecks the background gate inside the execution attempt", async () => {
    const mutableEnv = env;
    let executions = 0;
    const operationId = await buildEventPrizeWithdrawalOperationId(
      "NN3eRzoZo80",
      "1092",
    );
    const step = workflowStep(async (name) => {
      if (name === "wait for profile writes") {
        await testEnv.PROFILE_DB.prepare(
          `UPDATE profile_canonical_control
           SET state = 'frozen'
           WHERE singleton = 1 AND state = 'active'`,
        ).run();
      }
    });
    await expect(
      runEventPrizeWithdrawalWorkflow(
        mutableEnv,
        {
          instanceId: withdrawalWorkflowInstanceId(operationId),
          payload: {
            schemaVersion: 2,
            dataEpoch: 1,
            kind: "withdrawal",
            eventId: "NN3eRzoZo80",
            operationId,
            prizeId: "1092",
            profileId: "profile-1",
            recipientAddress: "11111111111111111111111111111111",
            requesterUid: "login-1",
          },
          timestamp: new Date(0),
          workflowName: "mons-link-event-prize-withdrawal",
        },
        step.value,
        {
          execute: async () => {
            executions++;
            throw new Error("unexpected-execution");
          },
          preflight: async () => undefined,
        },
      ),
    ).rejects.toThrow("profile-writes-disabled");
    expect(executions).toBe(0);
    expect(step.calls.map(({ name }) => name)).toEqual([
      "wait for profile writes",
      "execute event prize withdrawal",
    ]);
  });
});

it("allows only the exact read-only preflight while the global gate is closed", async () => {
  await applyCanonicalTestMigrations(
    testEnv.PROFILE_GAMES_DB,
    testEnv.TEST_D1_MIGRATIONS,
  );
  await testEnv.PROFILE_GAMES_DB.prepare(
    "UPDATE application_data_control SET phase = 'closed', migration_id = 'preflight-migration'",
  ).run();
  await testEnv.PROFILE_GAMES_DB.prepare(
    "CREATE TABLE preflight_preserved (value INTEGER NOT NULL)",
  ).run();
  await testEnv.PROFILE_GAMES_DB.prepare(
    "INSERT INTO preflight_preserved VALUES (7)",
  ).run();
  const step = workflowStep();
  let checks = 0;
  const result = await runAdmittedEventPrizeWithdrawalWorkflow(
    env,
    {
      instanceId: "closed-preflight",
      payload: { schemaVersion: 2, dataEpoch: 1, kind: "preflight" },
      timestamp: new Date(0),
      workflowName: "mons-link-event-prize-withdrawal-data1",
    },
    step.value,
    {
      execute: async () => {
        throw new Error("unexpected-withdrawal-execution");
      },
      preflight: async (readonlyEnv) => {
        checks++;
        expect(
          await readonlyEnv.PROFILE_GAMES_DB.prepare(
            "SELECT phase FROM application_data_control",
          ).first("phase"),
        ).toBe("closed");
        expect(
          await readonlyEnv.PROFILE_GAMES_DB.withSession("first-primary")
            .prepare("SELECT value FROM preflight_preserved")
            .first("value"),
        ).toBe(7);
        expect(
          (
            await readonlyEnv.PROFILE_GAMES_DB.batch([
              readonlyEnv.PROFILE_GAMES_DB.prepare(
                "SELECT value FROM preflight_preserved",
              ),
            ])
          )[0]?.results,
        ).toEqual([{ value: 7 }]);
        expect(() =>
          readonlyEnv.PROFILE_GAMES_DB.prepare(
            "UPDATE preflight_preserved SET value = 0",
          ),
        ).toThrow("application-read-only-operation");
        expect(() =>
          readonlyEnv.PROFILE_GAMES_DB.exec("DELETE FROM preflight_preserved"),
        ).toThrow("application-read-only-operation");
        expect(() =>
          readonlyEnv.PROFILE_GAMES_DB.batch([
            env.PROFILE_GAMES_DB.prepare("DELETE FROM preflight_preserved"),
          ]),
        ).toThrow("application-read-only-operation");
        expect(() =>
          readonlyEnv.INVITE_REACTIONS.getByName("preflight"),
        ).toThrow("application-read-only-operation");
        expect(() => readonlyEnv.TELEGRAM_DELIVERY_QUEUE.send({})).toThrow(
          "application-read-only-operation",
        );
        expect(() =>
          readonlyEnv.EVENT_PROGRESS_WORKFLOW.get("preflight"),
        ).toThrow("application-read-only-operation");
      },
    },
  );
  expect(result).toEqual({ ok: true, status: "ready" });
  expect(checks).toBe(1);
  expect(step.calls).toEqual([
    { name: "validate event prize runtime", config: { timeout: "30 seconds" } },
  ]);
  expect(
    await testEnv.PROFILE_GAMES_DB.prepare(
      "SELECT value FROM preflight_preserved",
    ).first("value"),
  ).toBe(7);
  expect(
    await testEnv.PROFILE_GAMES_DB.prepare(
      "SELECT COUNT(*) AS count FROM application_data_admissions",
    ).first("count"),
  ).toBe(0);
});

it("rejects preflight lookalikes before invoking read or mutation dependencies", async () => {
  for (const payload of [
    { schemaVersion: 1, kind: "preflight" },
    { schemaVersion: 2, dataEpoch: 0, kind: "preflight" },
    { schemaVersion: 2, dataEpoch: 1, kind: "preflight", extra: true },
  ]) {
    const step = workflowStep();
    await expect(
      runAdmittedEventPrizeWithdrawalWorkflow(
        env,
        {
          instanceId: "invalid-preflight",
          payload: JSON.parse(JSON.stringify(payload)),
          timestamp: new Date(0),
          workflowName: "mons-link-event-prize-withdrawal-data1",
        },
        step.value,
        {
          execute: async () => {
            throw new Error("unexpected-execution");
          },
          preflight: async () => {
            throw new Error("unexpected-preflight");
          },
        },
      ),
    ).rejects.toThrow("invalid-event-prize-withdrawal-payload");
    expect(step.calls).toEqual([]);
  }
});
