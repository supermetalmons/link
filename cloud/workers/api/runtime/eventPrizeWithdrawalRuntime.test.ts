import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  buildEventPrizeWithdrawalOperationId,
  type EventPrizeWithdrawalWorkflowInput,
} from "../src/eventPrizeWithdrawal.ts";
import { runEventPrizeWithdrawalWorkflow } from "../src/eventPrizeWithdrawalWorkflow.ts";
import { loadSolanaDependencies } from "../../../functions/eventPrizes/solana.js";

function workflowStep() {
  const calls: Array<{ config: unknown; name: string }> = [];
  const value = {
    do: async (...args: unknown[]) => {
      const name = String(args[0]);
      const config = args.length === 2 ? undefined : args[1];
      const callback = args.length === 2 ? args[1] : args[2];
      if (typeof callback !== "function") throw new Error("missing-callback");
      calls.push({ config, name });
      return callback();
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
});
