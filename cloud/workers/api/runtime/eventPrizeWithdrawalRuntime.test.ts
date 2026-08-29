import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  buildEventPrizeWithdrawalOperationId,
  type EventPrizeWithdrawalWorkflowInput,
} from "../src/eventPrizeWithdrawal.ts";
import { runEventPrizeWithdrawalWorkflow } from "../src/eventPrizeWithdrawalWorkflow.ts";
import { loadSolanaDependencies } from "../../../functions/eventPrizes/solana.js";
import { withProfileControl } from "../test/testEnv.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };

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
    await applyD1Migrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
    );
    await testEnv.PROFILE_DB.batch([
      testEnv.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'importing'
         WHERE singleton = 1 AND state = 'firestore'`,
      ),
      testEnv.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET import_digest = ?, import_plan_version = 1
         WHERE singleton = 1 AND state = 'importing'`,
      ).bind("0".repeat(64)),
      testEnv.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'frozen', imported_at_ms = 1
         WHERE singleton = 1 AND state = 'importing'`,
      ),
      testEnv.PROFILE_DB.prepare(
        `UPDATE profile_canonical_control
         SET state = 'active'
         WHERE singleton = 1 AND state = 'frozen'`,
      ),
    ]);
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
      schemaVersion: 1,
      kind: "withdrawal",
      eventId,
      operationId,
      prizeId,
      profileId: "profile-1",
      recipientAddress: "11111111111111111111111111111111",
      requesterUid: "login-1",
    } as const;
    const event: Readonly<WorkflowEvent<EventPrizeWithdrawalWorkflowInput>> = {
      instanceId: operationId,
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
          instanceId: operationId,
          payload: {
            schemaVersion: 1,
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
        payload: { schemaVersion: 1, kind: "preflight" },
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
      instanceId: operationId,
      payload: {
        schemaVersion: 1,
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
    for (const blockedEnv of ["firestore", "importing", "frozen"].map((state) =>
      withProfileControl(env, state as "firestore" | "importing" | "frozen"),
    )) {
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
          payload: { schemaVersion: 1, kind: "preflight" },
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
          instanceId: operationId,
          payload: {
            schemaVersion: 1,
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
