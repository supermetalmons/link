import assert from "node:assert/strict";
import test from "node:test";
import { createEventBracketRuntime } from "../../../runtime/events/bracket.js";
import type { EventOwnershipSnapshot } from "../../../runtime/events/ownership.js";

function createState(
  values: Map<string, unknown>,
  beforeTransaction?: (path: string, values: Map<string, unknown>) => void,
) {
  return {
    async read(path: string) {
      return values.get(path) ?? null;
    },
    async set(path: string, value: unknown) {
      values.set(path, value);
    },
    async remove(path: string) {
      values.delete(path);
    },
    async update(path: string, updates: Record<string, unknown>) {
      values.set(path, {
        ...((values.get(path) as Record<string, unknown>) || {}),
        ...updates,
      });
    },
    async transaction(path: string, updater: (current: unknown) => unknown) {
      beforeTransaction?.(path, values);
      const current = values.get(path) ?? null;
      const next = updater(current);
      if (next === undefined) return { committed: false, value: current };
      if (next === null) values.delete(path);
      else values.set(path, next);
      return { committed: true, value: next };
    },
  };
}

function prizeOwnership(
  entries: Array<[string, string]>,
): EventOwnershipSnapshot {
  const profileIds = Array.from(
    new Set(entries.map(([, profileId]) => profileId)),
  );
  return {
    canonicalProfileIdByProfileId: new Map(entries),
    loginOwnerByUid: new Map(),
    loginUidsByProfileId: new Map(
      profileIds.map((profileId) => [profileId, []]),
    ),
    profileById: new Map(
      profileIds.map((profileId) => [
        profileId,
        {
          profile: {
            aura: "",
            emoji: 1,
            eth: "",
            profileId,
            rating: 1500,
            sol: "",
            username: "",
          },
          revision: 1,
        },
      ]),
    ),
  };
}

const emptyEvent = { participants: {} };
const mergedPrizeOwnership = prizeOwnership([
  ["source-profile", "target-profile"],
]);

test("reconciles canonical prize projections without changing event history", async () => {
  const values = new Map<string, unknown>();
  const runtime = createEventBracketRuntime({
    state: createState(values),
    readEventPrizeWithdrawals: async () => ({}),
  });
  const assignment = {
    eventId: "NN3eRzoZo80",
    profileId: "source-profile",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 100,
  };
  const updates: Record<string, unknown> = {};
  await runtime.addEventPrizeAssignmentUpdates({
    assignments: { 1: assignment },
    eventId: assignment.eventId,
    includeEventAssignments: true,
    updates,
  });
  assert.deepEqual(updates[`events/${assignment.eventId}/prizeAssignments`], {
    1: assignment,
  });
  assert.equal(
    updates[`profileEventPrizes/target-profile/${assignment.eventId}`],
    undefined,
  );
  const firstResult = await runtime.reconcileProfileEventPrizeAssignments({
    assignments: { 1: assignment },
    event: emptyEvent,
    eventId: assignment.eventId,
    ownershipSnapshot: mergedPrizeOwnership,
  });
  assert.deepEqual(firstResult, { didChange: true });
  assert.deepEqual(
    values.get(`profileEventPrizes/target-profile/${assignment.eventId}`),
    { ...assignment, profileId: "target-profile" },
  );
  assert.equal(
    values.get(`profileEventPrizes/source-profile/${assignment.eventId}`),
    undefined,
  );
  assert.deepEqual(
    await runtime.reconcileProfileEventPrizeAssignments({
      assignments: { 1: assignment },
      event: emptyEvent,
      eventId: assignment.eventId,
      ownershipSnapshot: mergedPrizeOwnership,
    }),
    { didChange: false },
  );
});

test("uses injected canonical withdrawals when filtering prize projections", async () => {
  const eventId = "NN3eRzoZo80";
  const prizeId = "1092";
  const values = new Map<string, unknown>();
  const runtime = createEventBracketRuntime({
    state: createState(values),
    readEventPrizeWithdrawals: async () => ({
      [prizeId]: {
        assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
        eventId,
        prizeId,
        status: "completed",
      },
    }),
  });

  assert.deepEqual(
    await runtime.reconcileProfileEventPrizeAssignments({
      assignments: {
        1: {
          eventId,
          profileId: "source-profile",
          place: 1,
          prizeId,
          assignedAtMs: 100,
        },
      },
      event: emptyEvent,
      eventId,
      ownershipSnapshot: mergedPrizeOwnership,
    }),
    { didChange: false },
  );
  assert.equal(values.size, 0);
});

test("does not overwrite a canonical prize assignment inserted concurrently", async () => {
  const eventId = "NN3eRzoZo80";
  const targetPath = `profileEventPrizes/target-profile/${eventId}`;
  const conflictingAssignment = {
    eventId,
    profileId: "target-profile",
    place: 2,
    prizeId: "1111",
    assignedAtMs: 50,
  };
  const values = new Map<string, unknown>();
  let inserted = false;
  const runtime = createEventBracketRuntime({
    state: createState(values, (path, currentValues) => {
      if (path === targetPath && !inserted) {
        currentValues.set(path, conflictingAssignment);
        inserted = true;
      }
    }),
    readEventPrizeWithdrawals: async () => ({}),
  });
  await assert.rejects(
    runtime.reconcileProfileEventPrizeAssignments({
      assignments: {
        1: {
          eventId,
          profileId: "source-profile",
          place: 1,
          prizeId: "1092",
          assignedAtMs: 100,
        },
      },
      event: emptyEvent,
      eventId,
      ownershipSnapshot: mergedPrizeOwnership,
    }),
    /profile-event-prize-conflict/,
  );
  assert.deepEqual(values.get(targetPath), conflictingAssignment);
});

test("rejects two awards that collapse to one canonical profile", async () => {
  const eventId = "NN3eRzoZo80";
  const runtime = createEventBracketRuntime({
    state: createState(new Map()),
    readEventPrizeWithdrawals: async () => ({}),
  });
  await assert.rejects(
    runtime.reconcileProfileEventPrizeAssignments({
      assignments: {
        1: {
          eventId,
          profileId: "source-a",
          place: 1,
          prizeId: "1092",
          assignedAtMs: 100,
        },
        2: {
          eventId,
          profileId: "source-b",
          place: 2,
          prizeId: "1111",
          assignedAtMs: 100,
        },
      },
      event: emptyEvent,
      eventId,
      ownershipSnapshot: prizeOwnership([
        ["source-a", "canonical-profile"],
        ["source-b", "canonical-profile"],
      ]),
    }),
    /profile-event-prize-conflict/,
  );
});
