import assert from "node:assert/strict";
import test from "node:test";
import { createEventBracketRuntime } from "../../../functions/events/bracket.js";
import { authDocumentName } from "../src/authFirestore.ts";
import { createProfileEventPrizeOwnerResolver } from "../src/profileEventPrizeOwner.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function snapshot(value: unknown) {
  return { exists: () => value !== null, val: () => value };
}

function createAdmin(
  values: Map<string, unknown>,
  beforeTransaction?: (path: string, values: Map<string, unknown>) => void,
) {
  return {
    database: () => ({
      ref: (path = "") => ({
        once: async () => snapshot(values.get(path) ?? null),
        transaction: async (updater: (current: unknown) => unknown) => {
          beforeTransaction?.(path, values);
          const current = values.get(path) ?? null;
          const next = updater(current);
          if (next === undefined) {
            return { committed: false, snapshot: snapshot(current) };
          }
          values.set(path, next);
          return { committed: true, snapshot: snapshot(next) };
        },
      }),
    }),
  };
}

test("resolves direct and multi-hop profile prize owners", async () => {
  const documents = new Map([
    [
      authDocumentName("profileMergeTargets", "source-profile"),
      {
        id: "source-profile",
        name: authDocumentName("profileMergeTargets", "source-profile"),
        fields: { targetProfileId: "middle-profile" },
        rawFields: {},
        updateTime: "update",
      },
    ],
    [
      authDocumentName("profileMergeTargets", "middle-profile"),
      {
        id: "middle-profile",
        name: authDocumentName("profileMergeTargets", "middle-profile"),
        fields: { targetProfileId: "target-profile" },
        rawFields: {},
        updateTime: "update",
      },
    ],
  ]);
  const resolve = createProfileEventPrizeOwnerResolver(TELEGRAM_TEST_ENV, {
    firestore: {
      get: async (name) => documents.get(name) || null,
      query: async () => [],
    },
    rtdb: { getRtdbPath: async () => null },
  });
  assert.equal(
    await resolve({ eventId: "event-1", profileId: "source-profile" }),
    "target-profile",
  );
});

test("resolves a participant login to its current profile", async () => {
  const signal = AbortSignal.timeout(1_000);
  let observedSignal: AbortSignal | undefined;
  const resolve = createProfileEventPrizeOwnerResolver(TELEGRAM_TEST_ENV, {
    firestore: {
      get: async () => null,
      query: async () => [
        {
          id: "current-profile",
          name: authDocumentName("users", "current-profile"),
          fields: {},
          rawFields: {},
          updateTime: "update",
        },
      ],
    },
    rtdb: {
      getRtdbPath: async (_path, _query, requestSignal) => {
        observedSignal = requestSignal;
        return { loginUid: "login-1" };
      },
    },
    signal,
  });
  assert.equal(
    await resolve({ eventId: "event-1", profileId: "source-profile" }),
    "current-profile",
  );
  assert.equal(observedSignal, signal);
});

test("reconciles canonical prize projections without changing event history", async () => {
  const values = new Map<string, unknown>();
  const runtime = createEventBracketRuntime({
    admin: createAdmin(values),
    resolveProfileEventPrizeOwnerId: async () => "target-profile",
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
    eventId: assignment.eventId,
  });
  assert.deepEqual(firstResult, { didChange: true, settled: true });
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
      eventId: assignment.eventId,
    }),
    { didChange: false, settled: true },
  );
});

test("uses injected canonical withdrawals when filtering prize projections", async () => {
  const eventId = "NN3eRzoZo80";
  const prizeId = "1092";
  const values = new Map<string, unknown>();
  const runtime = createEventBracketRuntime({
    admin: createAdmin(values),
    readEventPrizeWithdrawals: async () => ({
      [prizeId]: {
        assetAddress: "JEGmxy88eGv9vD4rWRtN5so9fMfMU6WA5djgrysDWKrU",
        eventId,
        prizeId,
        status: "completed",
      },
    }),
    resolveProfileEventPrizeOwnerId: async () => "target-profile",
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
      eventId,
    }),
    { didChange: false, settled: true },
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
    admin: createAdmin(values, (path, currentValues) => {
      if (path === targetPath && !inserted) {
        currentValues.set(path, conflictingAssignment);
        inserted = true;
      }
    }),
    resolveProfileEventPrizeOwnerId: async () => "target-profile",
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
      eventId,
    }),
    /profile-event-prize-conflict/,
  );
  assert.deepEqual(values.get(targetPath), conflictingAssignment);
});

test("rejects two awards that collapse to one canonical profile", async () => {
  const eventId = "NN3eRzoZo80";
  const runtime = createEventBracketRuntime({
    admin: createAdmin(new Map()),
    resolveProfileEventPrizeOwnerId: async () => "canonical-profile",
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
      eventId,
    }),
    /profile-event-prize-conflict/,
  );
});
