import assert from "node:assert/strict";
import test from "node:test";
import { runConflictRetry } from "../src/conflictRetry.ts";
import { CanonicalProfileConflict } from "../src/profileCanonical/types.ts";

test("returns a successful result without consuming another attempt", async () => {
  const value = { outcome: "updated" };
  let attempts = 0;
  const result = await runConflictRetry({
    maxAttempts: 5,
    attempt: async () => {
      attempts++;
      return { value };
    },
    exhausted: () => assert.fail("unexpected-exhaustion"),
  });
  assert.equal(result, value);
  assert.equal(attempts, 1);
});

test("repeats explicit conflicts and preserves a void success", async () => {
  let attempts = 0;
  const result = await runConflictRetry<void>({
    maxAttempts: 5,
    attempt: async () => {
      attempts++;
      return attempts === 1
        ? { conflict: new CanonicalProfileConflict() }
        : { value: undefined };
    },
    exhausted: () => assert.fail("unexpected-exhaustion"),
  });
  assert.equal(result, undefined);
  assert.equal(attempts, 2);
});

test("exhausts at the supplied limit with the final conflict", async () => {
  const conflicts = [
    new CanonicalProfileConflict(),
    new CanonicalProfileConflict(),
    new CanonicalProfileConflict(),
  ];
  const failure = new Error("domain-exhaustion");
  let attempts = 0;
  let exhaustions = 0;
  await assert.rejects(
    runConflictRetry({
      maxAttempts: conflicts.length,
      attempt: async () => ({ conflict: conflicts[attempts++]! }),
      exhausted: (lastConflict) => {
        exhaustions++;
        assert.equal(lastConflict, conflicts.at(-1));
        return failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(attempts, conflicts.length);
  assert.equal(exhaustions, 1);
});

for (const failure of [
  new Error("read-unavailable"),
  new CanonicalProfileConflict(),
]) {
  test(`propagates a thrown ${failure.message} without retrying`, async () => {
    let attempts = 0;
    await assert.rejects(
      runConflictRetry({
        maxAttempts: 5,
        attempt: async () => {
          attempts++;
          throw failure;
        },
        exhausted: () => assert.fail("unexpected-exhaustion"),
      }),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
  });
}

test("uses the domain exhaustion failure when no attempts are allowed", async () => {
  const failure = new CanonicalProfileConflict();
  await assert.rejects(
    runConflictRetry({
      maxAttempts: 0,
      attempt: async () => assert.fail("unexpected-attempt"),
      exhausted: (lastConflict) => {
        assert.equal(lastConflict, undefined);
        return failure;
      },
    }),
    (error) => error === failure,
  );
});
