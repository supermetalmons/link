import assert from "node:assert/strict";
import test from "node:test";
import type { DecodedWager } from "../src/wagerModel.ts";
import { observeProposalWrite } from "../src/wagerProposalWrite.ts";

function wagerFixture(label: string): DecodedWager {
  const raw = { label };
  const absent = { kind: "absent" as const, raw: undefined, value: null };
  return {
    raw,
    record: raw,
    proposals: absent,
    proposedBy: absent,
    agreed: absent,
    agreementOperation: absent,
    proposalRemovalOperations: absent,
    settlement: absent,
    resolved: absent,
  };
}

for (const wager of [wagerFixture("command"), null]) {
  test(`a successful ${wager ? "wager" : "null"} command result skips readback`, async () => {
    const calls: string[] = [];
    const observation = await observeProposalWrite({
      async refreshLease() {
        calls.push("refresh");
      },
      async command() {
        calls.push("command");
        return wager;
      },
      readback: async () => assert.fail("unexpected-readback"),
    });
    assert.deepEqual(observation, { source: "command", wager });
    assert.equal(observation.wager, wager);
    assert.deepEqual(calls, ["refresh", "command"]);
  });
}

test("the command waits for the lease refresh to finish", async () => {
  const refreshing = Promise.withResolvers<void>();
  const calls: string[] = [];
  const result = observeProposalWrite({
    refreshLease() {
      calls.push("refresh");
      return refreshing.promise;
    },
    async command() {
      calls.push("command");
      return null;
    },
    readback: async () => assert.fail("unexpected-readback"),
  });
  assert.deepEqual(calls, ["refresh"]);
  refreshing.resolve();
  assert.deepEqual(await result, { source: "command", wager: null });
  assert.deepEqual(calls, ["refresh", "command"]);
});

for (const mode of ["throw", "reject"] as const) {
  test(`a lease refresh ${mode} prevents both the command and readback`, async () => {
    const failure = new Error("refresh-failed");
    const calls: string[] = [];
    await assert.rejects(
      observeProposalWrite({
        refreshLease() {
          calls.push("refresh");
          if (mode === "throw") throw failure;
          return Promise.reject(failure);
        },
        command: async () => assert.fail("unexpected-command"),
        readback: async () => assert.fail("unexpected-readback"),
      }),
      (error) => error === failure,
    );
    assert.deepEqual(calls, ["refresh"]);
  });
}

for (const failureKind of [
  "throw",
  "reject",
  "validation",
  "result-extraction",
] as const) {
  for (const wager of [wagerFixture("readback"), null]) {
    test(`a command ${failureKind} falls back once to ${wager ? "the stored wager" : "null"}`, async () => {
      const failure = new Error(`command-${failureKind}-failed`);
      const calls: string[] = [];
      const observation = await observeProposalWrite({
        async refreshLease() {
          calls.push("refresh");
        },
        command() {
          calls.push("command");
          if (failureKind === "throw") throw failure;
          if (failureKind === "reject") return Promise.reject(failure);
          if (failureKind === "validation") {
            return Promise.resolve(wager).then(() => {
              calls.push("validate");
              throw failure;
            });
          }
          return Promise.resolve({
            get value(): DecodedWager | null {
              calls.push("extract");
              throw failure;
            },
          }).then((result) => result.value);
        },
        async readback() {
          calls.push("readback");
          return wager;
        },
      });
      assert.deepEqual(observation, { source: "readback", wager });
      assert.equal(observation.wager, wager);
      assert.deepEqual(calls, [
        "refresh",
        "command",
        ...(failureKind === "validation" ? ["validate"] : []),
        ...(failureKind === "result-extraction" ? ["extract"] : []),
        "readback",
      ]);
    });
  }
}

for (const mode of ["throw", "reject"] as const) {
  for (const failure of [new Error("readback-failed"), 0, undefined]) {
    test(`a readback ${mode} preserves ${String(failure)} without another attempt`, async () => {
      const calls: string[] = [];
      await assert.rejects(
        observeProposalWrite({
          async refreshLease() {
            calls.push("refresh");
          },
          async command() {
            calls.push("command");
            throw new Error("command-failed");
          },
          readback() {
            calls.push("readback");
            if (mode === "throw") throw failure;
            return Promise.reject(failure);
          },
        }),
        (error) => error === failure,
      );
      assert.deepEqual(calls, ["refresh", "command", "readback"]);
    });
  }
}
