import assert from "node:assert/strict";
import test from "node:test";
import { classifyD1Failure } from "../src/d1Failure.ts";

const revisionConflicts = [
  ["automatch_revision_guard", "automatch-conflict"],
  ["invite_source_revision_guard", "invite-source-conflict"],
  ["wager_state_revision_guard", "wager-state-conflict"],
  ["wager_frozen_revision_guard", "wager-frozen-conflict"],
] as const;

test("only explicit guard signatures and username ownership are conflicts", () => {
  const cases = [
    [
      "UNIQUE constraint failed: event_transaction_guards.singleton",
      "event-conflict",
    ],
    [
      "NOT NULL constraint failed: profile_transaction_guards.singleton",
      "profile-conflict",
    ],
    [
      "UNIQUE constraint failed: profile_records.username_key",
      "username-conflict",
    ],
    ...revisionConflicts.map(
      ([guard, kind]) => [`CHECK constraint failed: ${guard}`, kind] as const,
    ),
    ["CHECK constraint failed: singleton = 1", "guard"],
    ["CHECK constraint failed: singleton=1", "guard"],
    ["UNIQUE constraint failed: profile_records.profile_id", "integrity"],
    ["UNIQUE constraint failed: event_records.event_id", "integrity"],
    ["FOREIGN KEY constraint failed", "integrity"],
    ["CHECK constraint failed: revision > 0", "integrity"],
    [
      "NOT NULL constraint failed: profile_transaction_guards.other",
      "integrity",
    ],
  ] as const;
  for (const [message, expected] of cases) {
    for (const suffix of [
      "",
      ": SQLITE_CONSTRAINT",
      ": SQLITE_CONSTRAINT_CHECK",
      ": SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
      ": SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
    ]) {
      for (const prefix of ["", "D1_ERROR: "]) {
        const failure = new Error(`${prefix}${message}${suffix}`);
        assert.equal(classifyD1Failure(failure), expected);
        assert.equal(
          classifyD1Failure(
            new Error("database unavailable", { cause: failure }),
          ),
          expected,
        );
      }
    }
  }
});

test("named revision guards require an exact CHECK failure", () => {
  for (const [guard] of revisionConflicts) {
    for (const message of [
      guard,
      `query failed while using ${guard}`,
      `message containing CHECK constraint failed: ${guard}`,
    ]) {
      assert.equal(classifyD1Failure(new Error(message)), "unknown");
    }
    for (const message of [
      `CHECK constraint failed: ${guard}_other`,
      `CHECK constraint failed: other_${guard}`,
      `CHECK constraint failed: ${guard}, other_guard`,
      `UNIQUE constraint failed: ${guard}`,
      `NOT NULL constraint failed: ${guard}`,
    ]) {
      assert.equal(classifyD1Failure(new Error(message)), "integrity");
    }
  }
  for (const guard of [
    "automatch_write_guard",
    "invite_source_control_guard",
    "wager_state_write_guard",
  ]) {
    assert.equal(
      classifyD1Failure(new Error(`CHECK constraint failed: ${guard}`)),
      "integrity",
    );
  }
});

test("explicit conflicts preserve first-match precedence across causes", () => {
  for (const [guard, expected] of revisionConflicts) {
    const message = `CHECK constraint failed: ${guard}`;
    for (const wrapper of [
      "database unavailable",
      "CHECK constraint failed: singleton = 1",
      "FOREIGN KEY constraint failed",
    ]) {
      assert.equal(
        classifyD1Failure(new Error(wrapper, { cause: new Error(message) })),
        expected,
      );
    }
    assert.equal(
      classifyD1Failure(
        new Error(message, {
          cause: new Error(
            "NOT NULL constraint failed: profile_transaction_guards.singleton",
          ),
        }),
      ),
      expected,
    );
    assert.equal(
      classifyD1Failure(
        new Error(
          "UNIQUE constraint failed: event_transaction_guards.singleton",
          { cause: new Error(message) },
        ),
      ),
      "event-conflict",
    );
  }
});

test("trigger failures are integrity failures and unrelated errors stay unknown", () => {
  assert.equal(
    classifyD1Failure(
      new Error(
        "D1_ERROR: profile merge depth exceeded: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
      ),
    ),
    "integrity",
  );
  for (const error of [
    null,
    "constraint",
    new Error("Network connection lost."),
    new Error(
      "message containing UNIQUE constraint failed: event_transaction_guards.singleton",
    ),
  ]) {
    assert.equal(classifyD1Failure(error), "unknown");
  }
  assert.equal(
    classifyD1Failure(
      new Error(
        "UNIQUE constraint failed: event_transaction_guards.singleton, other.column",
      ),
    ),
    "integrity",
  );
});

test("cause inspection terminates on cycles and excessive depth", () => {
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  assert.equal(classifyD1Failure(cycle), "unknown");
  const cases = [
    [
      "UNIQUE constraint failed: event_transaction_guards.singleton",
      "event-conflict",
    ],
    ...revisionConflicts.map(
      ([guard, kind]) => [`CHECK constraint failed: ${guard}`, kind] as const,
    ),
  ] as const;
  for (const [message, expected] of cases) {
    const failure = new Error(message);
    failure.cause = failure;
    assert.equal(classifyD1Failure(failure), expected);
    let error = new Error(message);
    for (let index = 0; index < 7; index++) {
      error = new Error("wrapper", { cause: error });
    }
    assert.equal(classifyD1Failure(error), expected);
    assert.equal(
      classifyD1Failure(new Error("wrapper", { cause: error })),
      "unknown",
    );
  }
});
