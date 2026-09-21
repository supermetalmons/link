import assert from "node:assert/strict";
import test from "node:test";
import type { EventMutation } from "../../../runtime/eventCommands.js";
import { commitEventMutationsInternal } from "../src/eventD1/commit.ts";
import {
  EventD1Failure,
  type EventD1Connection,
  type EventMutationOptions,
} from "../src/eventD1/types.ts";

const db: EventD1Connection = {
  prepare() {
    throw new Error("unexpected-database-read");
  },
  batch() {
    throw new Error("unexpected-database-write");
  },
};

const admission = {
  admissionId: "admission-one",
  expiresAtMs: 1_000,
  freezeGeneration: 0,
};

const cases: Array<{
  name: string;
  options: EventMutationOptions;
  valid: EventMutation;
  wrongId: EventMutation;
  wrongKind: EventMutation;
  error: string;
}> = [
  {
    name: "progress outbox",
    options: {
      admission,
      progressOutboxSnapshot: { outboxId: "outbox-one", recordJson: null },
    },
    valid: { kind: "progress-outbox", outboxId: "outbox-one", value: null },
    wrongId: { kind: "progress-outbox", outboxId: "outbox-two", value: null },
    wrongKind: { kind: "progress-dead", outboxId: "outbox-one", value: null },
    error: "invalid-progress-outbox-snapshot-scope",
  },
  {
    name: "Telegram projection",
    options: {
      admission,
      telegramProjectionSnapshot: { eventId: "event-one", current: null },
    },
    valid: { kind: "telegram-state", eventId: "event-one", value: {} },
    wrongId: { kind: "telegram-generation", eventId: "event-two", value: 1 },
    wrongKind: { kind: "telegram-outbox", eventId: "event-one", value: null },
    error: "invalid-telegram-projection-snapshot-scope",
  },
];

for (const scenario of cases) {
  for (const [reason, changes] of [
    ["wrong record ID", [scenario.wrongId]],
    ["wrong mutation kind", [scenario.wrongKind]],
    ["multiple mutations", [scenario.valid, scenario.valid]],
    ["no mutations", []],
  ] as const) {
    test(`${scenario.name} snapshot rejects ${reason} before database access`, async () => {
      await assert.rejects(
        commitEventMutationsInternal(db, changes, scenario.options),
        (error: unknown) =>
          error instanceof EventD1Failure && error.message === scenario.error,
      );
    });
  }
}
