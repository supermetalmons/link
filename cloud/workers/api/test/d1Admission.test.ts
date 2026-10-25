import assert from "node:assert/strict";
import test from "node:test";
import {
  runD1AdmissionAcquire,
  runD1AdmissionRelease,
} from "../src/d1Admission.ts";

for (const value of [false, 0, "", undefined]) {
  for (const stage of ["written", "confirmed"] as const) {
    test(`${stage} accepts ${String(value)} as an admission without retrying`, async () => {
      const calls: string[] = [];
      const result = await runD1AdmissionAcquire({
        write: async () => {
          calls.push("write");
          return null;
        },
        written: (result) => {
          calls.push("written");
          assert.equal(result, null);
          return stage === "written" ? value : null;
        },
        readback: async () => {
          calls.push("readback");
          return null;
        },
        confirmed: (result, writeFailed) => {
          calls.push("confirmed");
          assert.equal(result, null);
          assert.equal(writeFailed, false);
          return value;
        },
        unconfirmed: () => assert.fail("unexpected-exhaustion"),
      });
      assert.equal(result, value);
      assert.deepEqual(
        calls,
        stage === "written"
          ? ["write", "written"]
          : ["write", "written", "readback", "confirmed"],
      );
    });
  }
}

test("a failed write can be confirmed without writing again", async () => {
  const admission = { admissionId: "same-id" };
  const calls: string[] = [];
  const result = await runD1AdmissionAcquire({
    write: async () => {
      calls.push("write");
      throw new Error("response-lost-after-commit");
    },
    written: () => assert.fail("unexpected-write-decoding"),
    readback: async () => {
      calls.push("readback");
      return admission;
    },
    confirmed: (result, writeFailed) => {
      calls.push("confirmed");
      assert.equal(result, admission);
      assert.equal(writeFailed, true);
      return result;
    },
    unconfirmed: () => assert.fail("unexpected-exhaustion"),
  });
  assert.equal(result, admission);
  assert.deepEqual(calls, ["write", "readback", "confirmed"]);
});

test("confirmation distinguishes an uncertain write from a completed absent write", async () => {
  const calls: string[] = [];
  let writes = 0;
  const failure = new Error("writes-frozen");
  await assert.rejects(
    runD1AdmissionAcquire({
      write: async () => {
        calls.push("write");
        if (++writes === 1) throw new Error("write-unavailable");
        return null;
      },
      written: () => {
        calls.push("written");
        return null;
      },
      readback: async () => {
        calls.push("readback");
        return null;
      },
      confirmed: (_result, writeFailed) => {
        calls.push(`confirmed-${writeFailed}`);
        if (!writeFailed) throw failure;
        return null;
      },
      unconfirmed: () => assert.fail("unexpected-exhaustion"),
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    "write",
    "readback",
    "confirmed-true",
    "write",
    "written",
    "readback",
    "confirmed-false",
  ]);
});

for (const stage of ["written", "confirmed"] as const) {
  for (const mode of ["throw", "reject", "cleanup"] as const) {
    test(`${stage} ${mode} failure never retries acquisition`, async () => {
      const calls: string[] = [];
      const failure = new Error(`${stage}-${mode}-failed`);
      const rejectAdmission = (): Promise<never> => {
        calls.push(stage);
        if (mode === "throw") throw failure;
        if (mode === "reject") return Promise.reject(failure);
        return runD1AdmissionRelease(async () => {
          calls.push("release");
          throw failure;
        }).then(() => assert.fail("unexpected-release-success"));
      };
      await assert.rejects(
        runD1AdmissionAcquire({
          write: async () => {
            calls.push("write");
            return {};
          },
          written: () => (stage === "written" ? rejectAdmission() : null),
          readback: async () => {
            calls.push("readback");
            return {};
          },
          confirmed: () => rejectAdmission(),
          unconfirmed: () => assert.fail("unexpected-exhaustion"),
        }),
        (error) => error === failure,
      );
      assert.deepEqual(calls, [
        "write",
        ...(stage === "confirmed" ? ["readback"] : []),
        stage,
        ...(mode === "cleanup" ? ["release", "release", "release"] : []),
      ]);
    });
  }
}

test("successful transport calls do not erase the latest failure before exhaustion", async () => {
  let writes = 0;
  let readbacks = 0;
  let exhaustions = 0;
  await assert.rejects(
    runD1AdmissionAcquire({
      write: async () => {
        if (++writes === 1) throw new Error("first-write-failed");
        return null;
      },
      written: () => null,
      readback: async () => {
        readbacks++;
        if (readbacks === 1) throw new Error("first-readback-failed");
        if (readbacks === 2) throw 0;
        return null;
      },
      confirmed: () => null,
      unconfirmed: (cause) => {
        exhaustions++;
        assert.equal(cause, 0);
        return new Error("admission-unconfirmed", { cause });
      },
    }),
    (error) => error instanceof Error && error.cause === 0,
  );
  assert.equal(writes, 3);
  assert.equal(readbacks, 3);
  assert.equal(exhaustions, 1);
});

for (const finalReadbackFails of [false, true]) {
  test(`exhaustion preserves the final ${finalReadbackFails ? "readback" : "write"} failure`, async () => {
    let writes = 0;
    let readbacks = 0;
    const writeFailure = new Error("write-failed");
    const expectedCause = finalReadbackFails ? undefined : writeFailure;
    await assert.rejects(
      runD1AdmissionAcquire({
        write: async () => {
          writes++;
          throw writeFailure;
        },
        written: () => assert.fail("unexpected-write-decoding"),
        readback: async () => {
          readbacks++;
          if (finalReadbackFails) throw undefined;
          return null;
        },
        confirmed: () => null,
        unconfirmed: (cause) => {
          assert.equal(cause, expectedCause);
          return new Error("admission-unconfirmed", { cause });
        },
      }),
      (error) => error instanceof Error && error.cause === expectedCause,
    );
    assert.equal(writes, 3);
    assert.equal(readbacks, 3);
  });
}

test("three absent results exhaust without inventing a transport failure", async () => {
  let writes = 0;
  let readbacks = 0;
  const failure = new Error("absent");
  await assert.rejects(
    runD1AdmissionAcquire({
      write: async () => ++writes,
      written: () => null,
      readback: async () => ++readbacks,
      confirmed: () => null,
      unconfirmed: (cause) => {
        assert.equal(cause, undefined);
        return failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(writes, 3);
  assert.equal(readbacks, 3);
});

test("release stops at the first confirmed completion", async () => {
  let releases = 0;
  await runD1AdmissionRelease(async () => {
    if (++releases === 1) throw new Error("delete-response-lost");
    return undefined;
  });
  assert.equal(releases, 2);
});

for (const failure of [new Error("delete-unavailable"), 0, undefined]) {
  test(`release exhaustion preserves ${String(failure)} after three attempts`, async () => {
    let releases = 0;
    await assert.rejects(
      runD1AdmissionRelease(async () => {
        if (++releases < 3) throw new Error("earlier-delete-failure");
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(releases, 3);
  });
}
