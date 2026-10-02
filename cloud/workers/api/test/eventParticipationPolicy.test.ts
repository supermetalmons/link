import assert from "node:assert/strict";
import test from "node:test";
import type { EventParticipantSnapshot } from "@mons/shared/events";
import { eventField, getEventField } from "../../../runtime/eventCommands.js";
import type { EventOwnershipSnapshot } from "../../../runtime/events/ownership.js";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  assertRemovalAllowed,
  buildRemovalPlan,
  finalizeJoin,
  inspectJoin,
  planJoin,
  resolveRemovalContext,
  type EventDueTransition,
  type EventRecord,
  type JoinDraft,
} from "../src/eventParticipationPolicy.ts";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function participant(
  profileId: string,
  loginUid: string,
): EventParticipantSnapshot {
  return {
    profileId,
    loginUid,
    username: profileId,
    displayName: profileId,
    emojiId: 1,
    aura: "",
    joinedAtMs: 10,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
}

function event(overrides: EventRecord = {}): EventRecord {
  return {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 100,
    updatedAtMs: 1,
    createdByLoginUid: "creator-login",
    createdByProfileId: "creator",
    participants: {
      creator: participant("creator", "creator-login"),
      guest: participant("guest", "guest-login"),
    },
    ...overrides,
  };
}

function ownershipSnapshot(
  owners: Record<string, string | null> = {
    "creator-login": "creator",
    "guest-login": "guest",
  },
  canonicalIds: Record<string, string> = {},
): EventOwnershipSnapshot {
  const profileIds = [...new Set(Object.values(owners).filter(Boolean))];
  return {
    canonicalProfileIdByProfileId: new Map(Object.entries(canonicalIds)),
    loginOwnerByUid: new Map(
      Object.entries(owners).map(([uid, profileId]) => [
        uid,
        profileId ? { profileId, revision: 1 } : null,
      ]),
    ),
    loginUidsByProfileId: new Map(
      profileIds.map((profileId) => [
        profileId!,
        Object.keys(owners).filter((uid) => owners[uid] === profileId),
      ]),
    ),
    profileById: new Map(
      profileIds.map((profileId) => [
        profileId!,
        {
          revision: 1,
          profile: {
            profileId: profileId!,
            username: profileId!,
            emoji: 1,
            aura: "",
            eth: "",
            sol: "",
            rating: 1500,
          },
        },
      ]),
    ),
  };
}

function joinDraft(
  source: EventRecord,
  loginUid = "creator-login",
  snapshot: EventOwnershipSnapshot | null = null,
): JoinDraft {
  const inspection = inspectJoin(source, loginUid, 50);
  assert.equal(inspection.kind, "resolve-participant");
  const draft = planJoin({
    eventId: "event-1",
    event: source,
    loginUid,
    nowMs: 50,
    inspection,
    ownershipSnapshot: snapshot,
  });
  assert.equal(draft.kind, "join");
  return draft;
}

function apiFailure(status: number, message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AuthApiFailure);
    assert.equal(error.status, status);
    assert.equal(error.message, message);
    return true;
  };
}

test("join inspection keeps overdue dismissal ahead of ownership and preserves direct rejoin bypass", () => {
  const overdue = freeze(event({ participants: {}, startAtMs: 50 }));
  assert.deepEqual(inspectJoin(overdue, "unknown-login", 50), {
    kind: "settle-due",
  });
  const source = freeze(event());
  assert.deepEqual(inspectJoin(source, "creator-login", 50), {
    kind: "resolve-participant",
    directParticipation: { isParticipant: true, profileId: "creator" },
    needsOwnership: false,
  });
  assert.deepEqual(inspectJoin(source, "creator-login", 100), {
    kind: "resolve-participant",
    directParticipation: { isParticipant: true, profileId: "creator" },
    needsOwnership: true,
  });
});

test("join drafts preserve the source roster and isolate the settlement copy from commands", () => {
  const source = freeze(event());
  const original = structuredClone(source);
  const draft = joinDraft(source);
  assert.equal(draft.participant.joinedAtMs, 10);
  assert.deepEqual(draft.updates, [
    {
      kind: "event-participant",
      eventId: "event-1",
      profileId: "creator",
      value: draft.participant,
    },
    eventField("event-1", "updatedAtMs", 50),
  ]);
  const settlementParticipants = draft.eventForSettlement
    .participants as Record<string, EventParticipantSnapshot>;
  settlementParticipants.creator.displayName = "mutated-by-due-builder";
  delete settlementParticipants.guest;
  assert.equal(draft.participant.displayName, "creator");
  assert.deepEqual(source, original);
});

test("join planning keeps missing profile errors ahead of closed-event errors", () => {
  const source = freeze(event({ status: "active", participants: {} }));
  const inspection = inspectJoin(source, "new-login", 50);
  assert.equal(inspection.kind, "resolve-participant");
  const input = {
    eventId: "event-1",
    event: source,
    loginUid: "new-login",
    nowMs: 50,
    inspection,
  };
  assert.throws(
    () =>
      planJoin({
        ...input,
        ownershipSnapshot: ownershipSnapshot({ "new-login": null }),
      }),
    apiFailure(409, "Please sign in to join this event."),
  );
  assert.throws(
    () =>
      planJoin({
        ...input,
        ownershipSnapshot: ownershipSnapshot({ "new-login": "new-profile" }),
      }),
    apiFailure(409, "This event has already started."),
  );
});

test("join finalization replaces the retired child with the canonical parent without mutating either plan", () => {
  const draft = freeze(
    joinDraft(
      event({
        participants: {
          retired: participant("retired", "creator-login"),
          guest: participant("guest", "guest-login"),
        },
      }),
    ),
  );
  const canonical = participant("canonical", "creator-login");
  const transition = freeze<EventDueTransition>({
    didChange: true,
    updates: [
      eventField("event-1", "participants", {
        canonical,
        guest: participant("guest", "guest-login"),
      }),
      eventField("event-1", "status", "active"),
      eventField("event-1", "updatedAtMs", 100),
    ],
  });
  const originalDraft = structuredClone(draft);
  const originalTransition = structuredClone(transition);
  const commit = finalizeJoin("event-1", draft, transition);
  assert.deepEqual(commit.participant, canonical);
  assert.equal(commit.expectedTransitionStatus, "active");
  assert.equal(getEventField(commit.updates, "event-1", "updatedAtMs"), 100);
  assert.equal(
    commit.updates.some((command) => command.kind === "event-participant"),
    false,
  );
  assert.deepEqual(draft, originalDraft);
  assert.deepEqual(transition, originalTransition);
});

test("join finalization rejects invalid transitions and ambiguous canonical participants", () => {
  const draft = freeze(joinDraft(event()));
  const transitions: EventDueTransition[] = [
    { didChange: true, updates: [] },
    {
      didChange: true,
      updates: [eventField("event-1", "status", "ended")],
    },
    {
      didChange: true,
      updates: [
        eventField("event-1", "status", "active"),
        eventField("event-1", "participants", {
          first: participant("first", "creator-login"),
          second: participant("second", "creator-login"),
        }),
      ],
    },
  ];
  for (const transition of transitions) {
    assert.throws(
      () => finalizeJoin("event-1", draft, freeze(transition)),
      apiFailure(503, "event-participation-service-unavailable"),
    );
  }
});

test("removal resolves the stored participant key and deletes participant and preference together", () => {
  const source = freeze(
    event({
      participants: {
        creator: participant("creator", "creator-login"),
        retired: participant("retired", "original-login"),
      },
    }),
  );
  const snapshot = ownershipSnapshot(
    {
      "creator-login": "creator",
      "original-login": "canonical",
      "alternate-login": "canonical",
    },
    { retired: "canonical" },
  );
  const originalSource = structuredClone(source);
  const originalSnapshot = structuredClone(snapshot);
  const context = resolveRemovalContext({
    event: source,
    loginUid: "alternate-login",
    participantProfileId: null,
    ownershipSnapshot: snapshot,
  });
  assert.equal(context.participantProfileId, "retired");
  assertRemovalAllowed(context);
  assert.deepEqual(
    buildRemovalPlan("event-1", context.participantProfileId, 60),
    [
      {
        kind: "event-participant",
        eventId: "event-1",
        profileId: "retired",
        value: null,
      },
      {
        kind: "prize-selection",
        eventId: "event-1",
        profileId: "retired",
        value: null,
      },
      eventField("event-1", "updatedAtMs", 60),
    ],
  );
  assert.deepEqual(source, originalSource);
  assert.deepEqual(snapshot, originalSnapshot);
});

test("removal authorization precedes status errors and target rejection stays in the later phase", () => {
  assert.throws(
    () =>
      resolveRemovalContext({
        event: freeze(event({ status: "active" })),
        loginUid: "guest-login",
        participantProfileId: "missing",
        ownershipSnapshot: ownershipSnapshot(),
      }),
    apiFailure(403, "Only the event creator can remove participants."),
  );
  const missing = resolveRemovalContext({
    event: freeze(event()),
    loginUid: "creator-login",
    participantProfileId: "missing",
    ownershipSnapshot: null,
  });
  assert.equal(missing.targetParticipant, null);
  assert.throws(
    () => assertRemovalAllowed(missing),
    apiFailure(409, "Selected participant was not found."),
  );
  const creator = resolveRemovalContext({
    event: freeze(event({ participants: {} })),
    loginUid: "creator-login",
    participantProfileId: null,
    ownershipSnapshot: null,
  });
  assert.throws(
    () => assertRemovalAllowed(creator),
    apiFailure(409, "Event creator cannot leave."),
  );
});
