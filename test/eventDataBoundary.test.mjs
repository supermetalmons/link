import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import { isEventSnapshotResponse } from "@mons/shared/events";
import { retiredEventCases, eventId } from "./fixtures/retiredEventRecords.mjs";

registerTypeScriptTestHooks();

const { validateEventAggregate } =
  await import("../cloud/workers/api/src/eventD1/validation.ts");
const { canonicalEvent } = await import("./fixtures/canonicalData.mjs");

for (const scenario of retiredEventCases) {
  test(`canonical event boundary rejects retired shape: ${scenario.name}`, () => {
    const before = JSON.stringify(scenario.stored);
    assert.throws(() => validateEventAggregate(eventId, scenario.stored));
    assert.equal(
      isEventSnapshotResponse({
        ok: true,
        eventId,
        revision: 1,
        event: scenario.stored,
        prizeSelections: {},
      }),
      false,
    );
    assert.equal(JSON.stringify(scenario.stored), before);
  });
}

test("canonical event persistence and HTTP share the same complete record", () => {
  const event = canonicalEvent({ eventId });
  const stored = validateEventAggregate(eventId, event);
  assert.deepEqual(stored, event);
  assert.equal(
    isEventSnapshotResponse({
      ok: true,
      eventId,
      revision: 1,
      event: stored,
      prizeSelections: {},
    }),
    true,
  );
  for (const invalid of [
    { ...event, status: "legacy-event-state" },
    { ...event, createdAtMs: "1" },
    { ...event, participants: { partial: { displayName: "Player" } } },
    { ...event, rounds: { 3: { matches: {} } } },
    { ...event, extra: true },
  ]) {
    assert.throws(() => validateEventAggregate(eventId, invalid));
  }
});
