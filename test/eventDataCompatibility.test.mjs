import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { isEventSnapshotResponse } from "@mons/shared/events";
import {
  eventCompatibilityCases,
  eventId,
} from "./fixtures/eventDataCompatibility.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { mapDatabaseEventRecord } =
  await import("../src/connection/eventMappers.ts");
const { validateEventAggregate } =
  await import("../cloud/workers/api/src/eventD1/validation.ts");

for (const scenario of eventCompatibilityCases) {
  test(`event data compatibility: ${scenario.name}`, () => {
    const originalJson = JSON.stringify(scenario.stored);
    const stored = validateEventAggregate(eventId, scenario.stored);
    assert.notStrictEqual(stored, scenario.stored);
    assert.notStrictEqual(stored.participants, scenario.stored.participants);
    assert.equal(JSON.stringify(stored), originalJson);

    const response = {
      ok: true,
      eventId,
      revision: 1,
      event: stored,
      prizeSelections: {},
    };
    const wireJson = JSON.stringify(response);
    assert.equal(isEventSnapshotResponse(response), true);
    assert.deepEqual(
      mapDatabaseEventRecord(response.event, eventId),
      scenario.view,
    );
    assert.equal(JSON.stringify(response), wireJson);
    assert.equal(JSON.stringify(scenario.stored), originalJson);
  });
}

test("event views retain fallback IDs, skip non-object children, and normalize unknown statuses", () => {
  const view = mapDatabaseEventRecord(
    {
      status: "legacy-event-state",
      participants: {
        missing: null,
        scalar: "profile",
        present: { displayName: "Player" },
      },
      rounds: {
        missing: null,
        scalar: 2,
        3: { matches: { missing: null, scalar: true, present: {} } },
      },
      prizeAssignments: {
        1: {
          profileId: "present",
          place: 1,
          prizeId: "unknown-prize",
          assignedAtMs: 10,
        },
      },
    },
    eventId,
  );
  assert.equal(view.eventId, eventId);
  assert.equal(view.status, "scheduled");
  assert.deepEqual(Object.keys(view.participants), ["present"]);
  assert.equal(view.participants.present.profileId, "present");
  assert.deepEqual(Object.keys(view.rounds), ["3"]);
  assert.equal(view.rounds["3"].roundIndex, 3);
  assert.deepEqual(Object.keys(view.rounds["3"].matches), ["present"]);
  assert.equal(view.rounds["3"].matches.present.matchKey, "present");
  assert.deepEqual(view.prizeAssignments, {});
});
