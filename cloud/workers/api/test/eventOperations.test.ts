import assert from "node:assert/strict";
import test from "node:test";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import {
  createEvent,
  disqualifyEventMatchWinners,
  EVENT_CONTROL_TIMEOUT_MS,
  postponeEventStart,
  syncEventState,
} from "../src/eventOperations.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const identity = {
  uid: "creator-login",
  idToken: "firebase-token",
  profileId: "creator-profile",
};

function getPath(root: Record<string, unknown>, path: string): unknown {
  if (!path) {
    return root;
  }
  let value: unknown = root;
  for (const segment of path.split("/")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value ?? null;
}

function setPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split("/").filter(Boolean);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    const current = parent[segment];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      parent[segment] = {};
    }
    parent = parent[segment] as Record<string, unknown>;
  }
  const key = segments.at(-1);
  if (!key) {
    return;
  }
  if (value === null) {
    delete parent[key];
  } else {
    parent[key] = value;
  }
}

function createRepository(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(initial)) {
    setPath(values, path, value);
  }
  const patches: Record<string, unknown>[] = [];
  const repository: GameplayRepository = {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => identity.profileId,
    getGameplayProfile: async () => ({
      aura: "rainbow",
      emoji: 7,
      eth: "",
      profileId: identity.profileId,
      rating: 1500,
      sol: "",
      username: "ivan",
    }),
    getMiningMaterials: async () => ({
      dust: 0,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    }),
    getMiningSnapshot: async () => null,
    getNavigationGame: async () => null,
    getRtdbPath: async (path) => getPath(values, path),
    patchRtdbRoot: async (updates) => {
      patches.push(updates);
      for (const [path, value] of Object.entries(updates)) {
        setPath(values, path, value);
      }
    },
    transactRtdbPath: async (path, updater) => {
      const current = getPath(values, path);
      const output = updater(current);
      if (
        output &&
        typeof output === "object" &&
        "commit" in output &&
        output.commit === false
      ) {
        return {
          committed: false,
          decision:
            "decision" in output && typeof output.decision === "string"
              ? output.decision
              : undefined,
          value: current,
        };
      }
      const value =
        output && typeof output === "object" && "value" in output
          ? output.value
          : output;
      setPath(values, path, value);
      return {
        committed: true,
        decision:
          output &&
          typeof output === "object" &&
          "decision" in output &&
          typeof output.decision === "string"
            ? output.decision
            : undefined,
        value,
      };
    },
  };
  return { patches, repository, values };
}

function participant(profileId: string, joinedAtMs: number) {
  return {
    profileId,
    loginUid:
      profileId === identity.profileId ? identity.uid : `${profileId}-login`,
    username: profileId,
    displayName: profileId.toUpperCase(),
    emojiId: joinedAtMs,
    aura: null,
    joinedAtMs,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
}

function match(
  matchKey: string,
  hostProfileId: string | null,
  guestProfileId: string | null,
) {
  return {
    matchKey,
    inviteId: null,
    status: "upcoming",
    resolvedAtMs: null,
    winnerDisqualified: false,
    winnerProfileId: null,
    loserProfileId: null,
    hostSlotBlocked: false,
    hostProfileId,
    hostLoginUid: hostProfileId ? participant(hostProfileId, 1).loginUid : null,
    hostDisplayName: hostProfileId?.toUpperCase() || null,
    hostEmojiId: hostProfileId ? 1 : null,
    hostAura: null,
    guestSlotBlocked: false,
    guestProfileId,
    guestLoginUid: guestProfileId
      ? participant(guestProfileId, 1).loginUid
      : null,
    guestDisplayName: guestProfileId?.toUpperCase() || null,
    guestEmojiId: guestProfileId ? 1 : null,
    guestAura: null,
  };
}

function workflowEnvironment(
  onCreate: () => void,
  onGet?: () => WorkflowInstance,
): Env {
  const instance = {
    id: "event-progress-test",
    delete: async () => undefined,
    pause: async () => undefined,
    restart: async () => undefined,
    resume: async () => undefined,
    sendEvent: async () => undefined,
    status: async () => ({ status: "waiting" as const }),
    terminate: async () => undefined,
  } satisfies WorkflowInstance;
  return {
    ...TELEGRAM_TEST_ENV,
    EVENT_PROGRESS_WORKFLOW: {
      create: async () => instance,
      createBatch: async () => {
        onCreate();
        return [instance];
      },
      deleteBatch: async () => ({ deleted: [], errors: [] }),
      get: async () => (onGet ? onGet() : instance),
    },
  };
}

function withCanonicalMergeTarget(
  env: Env,
  sourceProfileId: string,
  targetProfileId: string,
): Env {
  const baseDb = env.PROFILE_DB;
  return {
    ...env,
    PROFILE_DB: {
      batch: baseDb.batch.bind(baseDb),
      dump: baseDb.dump.bind(baseDb),
      exec: baseDb.exec.bind(baseDb),
      prepare(query: string) {
        const base = baseDb.prepare(query);
        let values: unknown[] = [];
        let statement: D1PreparedStatement;
        statement = {
          all: base.all,
          bind(...nextValues) {
            values = nextValues;
            return statement;
          },
          async first<T>(column?: string) {
            if (
              query.includes("profile_merge_targets") &&
              values[0] === sourceProfileId
            ) {
              return {
                source_profile_id: sourceProfileId,
                target_profile_id: targetProfileId,
                merged_at_ms: 1,
                op_id: null,
              } as T;
            }
            return column === undefined
              ? base.first<T>()
              : base.first<T>(column);
          },
          raw: base.raw,
          run: base.run,
        };
        return statement;
      },
      withSession: baseDb.withSession.bind(baseDb),
    },
  };
}

test("creates a scheduled event only after its Workflow exists", async () => {
  const order: string[] = [];
  const repository = createRepository();
  const originalPatch = repository.repository.patchRtdbRoot;
  repository.repository.patchRtdbRoot = async (updates, signal) => {
    order.push("patch");
    await originalPatch(updates, signal);
  };
  const response = await createEvent(
    workflowEnvironment(() => order.push("workflow")),
    identity,
    { startsInMinutes: 5, announceOnTelegram: true },
    {
      repository: repository.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(order, ["workflow", "patch"]);
  assert.equal(response.eventId, "aaaaaaaaaaa");
  assert.equal(response.event.status, "scheduled");
  const update = repository.patches[0];
  assert.deepEqual(update["events/aaaaaaaaaaa"], response.event);
  const outboxEntry = Object.entries(update).find(([path]) =>
    path.startsWith("eventProgressOutbox/ep_"),
  );
  assert.ok(outboxEntry);
  assert.equal(
    (outboxEntry[1] as Record<string, unknown>).sourceKey,
    "start:aaaaaaaaaaa:301000",
  );
});

test("does not persist event creation when Workflow creation fails", async () => {
  const repository = createRepository();
  const env = workflowEnvironment(
    () => {
      throw new Error("workflow-unavailable");
    },
    () => {
      throw new Error("workflow-unavailable");
    },
  );
  await assert.rejects(
    createEvent(
      env,
      identity,
      { startsInMinutes: 5 },
      {
        repository: repository.repository,
        now: () => 1_000,
        random: () => 0,
        sleep: async () => undefined,
      },
    ),
    (error: unknown) =>
      error instanceof Error && error.message.includes("Could not schedule"),
  );
  assert.deepEqual(repository.patches, []);
});

test("postpones through a new Workflow and persists its outbox atomically", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: identity.uid,
    createdByProfileId: identity.profileId,
  };
  const repository = createRepository({ "events/event-1": event });
  let workflowCreates = 0;
  const response = await postponeEventStart(
    workflowEnvironment(() => workflowCreates++),
    identity,
    { eventId: "event-1", postponeByMinutes: 5 },
    {
      repository: repository.repository,
      now: () => 200_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(workflowCreates, 1);
  assert.equal(response.startAtMs, 900_000);
  const update = repository.patches.find(
    (patch) => patch["events/event-1/startAtMs"] === 900_000,
  );
  assert.ok(update);
  assert.equal(
    Object.keys(update).some((path) => path.startsWith("eventProgressOutbox/")),
    true,
  );
});

test("synchronizes a future scheduled event through the portable runtime", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: identity.uid,
    createdByProfileId: identity.profileId,
    participants: {},
  };
  const repository = createRepository({ "events/event-1": event });
  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    identity,
    { eventId: "event-1" },
    {
      repository: repository.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(response, {
    ok: true,
    eventId: "event-1",
    didChange: false,
    event,
  });
});

test("disqualifies an active match and synchronizes the terminal state", async () => {
  const activeMatch = {
    ...match("0_0", identity.profileId, "opponent"),
    inviteId: "invite-1",
    status: "pending",
  };
  const event = {
    eventId: "event-1",
    status: "active",
    startAtMs: 1,
    updatedAtMs: 100,
    createdByLoginUid: identity.uid,
    createdByProfileId: identity.profileId,
    currentRoundIndex: 0,
    supportsThirdPlaceMatch: false,
    participants: {
      [identity.profileId]: participant(identity.profileId, 1),
      opponent: participant("opponent", 2),
    },
    rounds: {
      0: {
        status: "active",
        completedAtMs: null,
        matches: { "0_0": activeMatch },
      },
    },
  };
  const state = createRepository({ "events/event-1": event });
  const response = await disqualifyEventMatchWinners(
    workflowEnvironment(() => undefined),
    identity,
    { eventId: "event-1", matchKey: "0_0" },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(response.didDisqualify, true);
  assert.equal(response.matchKey, "0_0");
  assert.ok("didChange" in response);
  assert.equal(response.event.status, "ended");
  assert.equal(
    getPath(
      state.values,
      "events/event-1/rounds/0/matches/0_0/winnerDisqualified",
    ),
    true,
  );
});

test("progresses resolved semifinal winners into an active final", async () => {
  const first = {
    ...match("0_0", identity.profileId, "p2"),
    inviteId: "semifinal-1",
    status: "host",
    resolvedAtMs: 100,
    winnerProfileId: identity.profileId,
    loserProfileId: "p2",
  };
  const second = {
    ...match("0_1", "p3", "p4"),
    inviteId: "semifinal-2",
    status: "host",
    resolvedAtMs: 100,
    winnerProfileId: "p3",
    loserProfileId: "p4",
  };
  const event = {
    eventId: "event-1",
    status: "active",
    startAtMs: 1,
    updatedAtMs: 100,
    createdByLoginUid: identity.uid,
    createdByProfileId: identity.profileId,
    currentRoundIndex: 0,
    supportsThirdPlaceMatch: false,
    participants: Object.fromEntries(
      [identity.profileId, "p2", "p3", "p4"].map((profileId, index) => [
        profileId,
        participant(profileId, index + 1),
      ]),
    ),
    rounds: {
      0: {
        status: "active",
        completedAtMs: null,
        matches: { "0_0": first, "0_1": second },
      },
      1: {
        status: "upcoming",
        completedAtMs: null,
        matches: { "1_0": match("1_0", null, null) },
      },
    },
  };
  const state = createRepository({ "events/event-1": event });
  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    identity,
    { eventId: "event-1" },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.ok("didChange" in response);
  assert.equal(response.didChange, true);
  assert.equal(response.event.status, "active");
  assert.equal(response.event.currentRoundIndex, 1);
  const final = getPath(
    state.values,
    "events/event-1/rounds/1/matches/1_0",
  ) as Record<string, unknown>;
  assert.equal(final.hostProfileId, identity.profileId);
  assert.equal(final.guestProfileId, "p3");
  assert.equal(final.status, "pending");
  assert.equal(typeof final.inviteId, "string");
});

test("repairs terminal prizes and rechecks ownership after commit", async () => {
  const eventId = "NN3eRzoZo80";
  const assignedAtMs = 500;
  const final = {
    ...match("0_0", identity.profileId, "runner-up"),
    inviteId: "final-invite",
    status: "host",
    resolvedAtMs: assignedAtMs,
    winnerProfileId: identity.profileId,
    loserProfileId: "runner-up",
  };
  const assignments = {
    1: {
      eventId,
      profileId: identity.profileId,
      place: 1,
      prizeId: "1092",
      assignedAtMs,
    },
    2: {
      eventId,
      profileId: "runner-up",
      place: 2,
      prizeId: "1111",
      assignedAtMs,
    },
  };
  const event = {
    eventId,
    status: "ended",
    startAtMs: 1,
    endedAtMs: assignedAtMs,
    updatedAtMs: assignedAtMs,
    createdByLoginUid: identity.uid,
    createdByProfileId: identity.profileId,
    currentRoundIndex: 0,
    winnerProfileId: identity.profileId,
    winnerDisplayName: identity.profileId.toUpperCase(),
    prizeSelectionsLockedAtMs: assignedAtMs,
    prizeAssignments: assignments,
    supportsThirdPlaceMatch: false,
    participants: {
      [identity.profileId]: participant(identity.profileId, 1),
      "runner-up": participant("runner-up", 2),
    },
    rounds: {
      0: {
        status: "completed",
        completedAtMs: assignedAtMs,
        matches: { "0_0": final },
      },
    },
  };
  const state = createRepository({ [`events/${eventId}`]: event });
  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    identity,
    { eventId },
    {
      repository: state.repository,
      resolveProfileEventPrizeOwnerId: async ({ profileId }) =>
        profileId === identity.profileId &&
        getPath(
          state.values,
          `profileEventPrizes/${identity.profileId}/${eventId}`,
        )
          ? "canonical-profile"
          : profileId,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.ok("didChange" in response);
  assert.equal(response.didChange, true);
  assert.deepEqual(
    getPath(
      state.values,
      `profileEventPrizes/${identity.profileId}/${eventId}`,
    ),
    assignments[1],
  );
  assert.deepEqual(
    getPath(state.values, `profileEventPrizes/runner-up/${eventId}`),
    assignments[2],
  );
  assert.deepEqual(
    getPath(state.values, `profileEventPrizes/canonical-profile/${eventId}`),
    { ...assignments[1], profileId: "canonical-profile" },
  );
});

test("uses canonical prize ownership with an injected repository", async () => {
  const eventId = "NN3eRzoZo80";
  const assignedAtMs = 500;
  const assignment = {
    eventId,
    profileId: identity.profileId,
    place: 1,
    prizeId: "1092",
    assignedAtMs,
  };
  const final = {
    ...match("0_0", identity.profileId, null),
    inviteId: "final-invite",
    status: "host",
    resolvedAtMs: assignedAtMs,
    winnerProfileId: identity.profileId,
  };
  const event = {
    eventId,
    status: "ended",
    startAtMs: 1,
    endedAtMs: assignedAtMs,
    updatedAtMs: assignedAtMs,
    createdByLoginUid: identity.uid,
    createdByProfileId: identity.profileId,
    currentRoundIndex: 0,
    winnerProfileId: identity.profileId,
    winnerDisplayName: identity.profileId.toUpperCase(),
    prizeSelectionsLockedAtMs: assignedAtMs,
    prizeAssignments: { 1: assignment },
    supportsThirdPlaceMatch: false,
    participants: {
      [identity.profileId]: participant(identity.profileId, 1),
    },
    rounds: {
      0: {
        status: "completed",
        completedAtMs: assignedAtMs,
        matches: { "0_0": final },
      },
    },
  };
  const state = createRepository({ [`events/${eventId}`]: event });
  await syncEventState(
    withCanonicalMergeTarget(
      workflowEnvironment(() => undefined),
      identity.profileId,
      "canonical-profile",
    ),
    identity,
    { eventId },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );

  assert.equal(
    getPath(
      state.values,
      `profileEventPrizes/${identity.profileId}/${eventId}`,
    ),
    null,
  );
  assert.deepEqual(
    getPath(state.values, `profileEventPrizes/canonical-profile/${eventId}`),
    { ...assignment, profileId: "canonical-profile" },
  );
});

test("uses a 30-second event-control deadline", () => {
  assert.equal(EVENT_CONTROL_TIMEOUT_MS, 30_000);
});
