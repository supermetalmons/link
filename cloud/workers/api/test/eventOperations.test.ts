import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_CORE_PRIZES_EVENT_ID } from "@mons/shared/event-prizes";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import type { ProfileOwnershipSnapshot } from "../src/profileOwnership.ts";
import {
  createEvent,
  disqualifyEventMatchWinners,
  EVENT_CONTROL_TIMEOUT_MS,
  postponeEventStart,
  syncEventState,
} from "../src/eventOperations.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const profileId = "creator-profile";
const identity = { uid: "creator-login" };

type TestGameplayRepository = GameplayRepository & {
  findProfileId(uid: string): Promise<string | null>;
  getGameplayProfile(
    uid: string,
    signal?: AbortSignal,
  ): Promise<{
    aura: string;
    emoji: number | string;
    eth: string;
    profileId: string;
    rating: number;
    sol: string;
    username: string;
  } | null>;
  getGameplayProfileOwnership(
    uid: string,
    signal?: AbortSignal,
  ): Promise<{
    loginUids: string[];
    profile: {
      aura: string;
      emoji: number | string;
      eth: string;
      profileId: string;
      rating: number;
      sol: string;
      username: string;
    };
  } | null>;
  listProfileLoginUids(profileId: string): Promise<string[]>;
  resolveCanonicalProfileId(profileId: string): Promise<string | null>;
  resolveCanonicalProfileIds(
    profileIds: string[],
  ): Promise<Array<string | null>>;
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
  let repository: TestGameplayRepository;
  repository = {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => profileId,
    listProfileLoginUids: async (candidateProfileId) =>
      candidateProfileId === profileId
        ? [identity.uid]
        : [`${candidateProfileId}-login`],
    getGameplayProfile: async (uid) => ({
      aura: "rainbow",
      emoji: 7,
      eth: "",
      profileId:
        uid === identity.uid
          ? profileId
          : uid.endsWith("-login")
            ? uid.slice(0, -"-login".length)
            : profileId,
      rating: 1500,
      sol: "",
      username: "ivan",
    }),
    getGameplayProfileOwnership: async (uid, signal) => {
      const profile = await repository.getGameplayProfile(uid, signal);
      return profile
        ? {
            loginUids: await repository.listProfileLoginUids(profile.profileId),
            profile,
          }
        : null;
    },
    getMiningMaterials: async () => ({
      dust: 0,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    }),
    getMiningSnapshot: async () => null,
    getNavigationGame: async () => null,
    resolveCanonicalProfileId: async (candidateProfileId) => candidateProfileId,
    resolveCanonicalProfileIds: async (candidateProfileIds) =>
      Promise.all(
        candidateProfileIds.map((candidateProfileId) =>
          repository.resolveCanonicalProfileId!(candidateProfileId),
        ),
      ),
    async readProfileOwnershipSnapshot(query) {
      const loginOwnerByUid = new Map<
        string,
        { profileId: string; revision: number } | null
      >();
      const profileById = new Map<
        string,
        {
          profile: Awaited<
            ReturnType<TestGameplayRepository["getGameplayProfile"]>
          >;
          revision: number;
        }
      >();
      const loginUidsByProfileId = new Map<string, string[]>();
      for (const uid of query.loginUids) {
        const ownership = await repository.getGameplayProfileOwnership(uid);
        if (!ownership) {
          loginOwnerByUid.set(uid, null);
          continue;
        }
        const ownerProfileId = ownership.profile.profileId;
        loginOwnerByUid.set(uid, { profileId: ownerProfileId, revision: 1 });
        profileById.set(ownerProfileId, {
          profile: ownership.profile,
          revision: 1,
        });
        loginUidsByProfileId.set(
          ownerProfileId,
          Array.from(
            new Set([
              ...(loginUidsByProfileId.get(ownerProfileId) || []),
              ...ownership.loginUids,
              uid,
            ]),
          ).sort(),
        );
      }
      const resolved = await repository.resolveCanonicalProfileIds([
        ...query.profileIds,
      ]);
      const canonicalProfileIdByProfileId = new Map<string, string | null>();
      for (let index = 0; index < query.profileIds.length; index += 1) {
        const sourceProfileId = query.profileIds[index];
        const canonicalProfileId = resolved[index] || null;
        canonicalProfileIdByProfileId.set(sourceProfileId, canonicalProfileId);
        if (!canonicalProfileId) continue;
        if (!profileById.has(canonicalProfileId)) {
          profileById.set(canonicalProfileId, {
            profile: {
              aura: "",
              emoji: 0,
              eth: "",
              profileId: canonicalProfileId,
              rating: 1500,
              sol: "",
              username: canonicalProfileId,
            },
            revision: 1,
          });
        }
        if (!loginUidsByProfileId.has(canonicalProfileId)) {
          const uids =
            await repository.listProfileLoginUids(canonicalProfileId);
          loginUidsByProfileId.set(
            canonicalProfileId,
            [...new Set(uids)].sort(),
          );
        }
      }
      return {
        canonicalProfileIdByProfileId,
        loginOwnerByUid,
        loginUidsByProfileId,
        profileById,
      } as ProfileOwnershipSnapshot;
    },
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

function participant(candidateProfileId: string, joinedAtMs: number) {
  return {
    profileId: candidateProfileId,
    loginUid:
      candidateProfileId === profileId
        ? identity.uid
        : `${candidateProfileId}-login`,
    username: candidateProfileId,
    displayName: candidateProfileId.toUpperCase(),
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

test("ignores stale Firebase profile claims when creating an event", async () => {
  const state = createRepository();
  const staleClaimIdentity = {
    uid: identity.uid,
    profileId: "forged-profile",
  };
  const response = await createEvent(
    workflowEnvironment(() => undefined),
    staleClaimIdentity,
    { startsInMinutes: 5 },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(response.event.createdByProfileId, profileId);
  const participants = response.event.participants as Record<string, unknown>;
  assert.ok(participants[profileId]);
  assert.equal(participants["forged-profile"], undefined);
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
    createdByProfileId: profileId,
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

test("overdue postpone migrates prize selections in its transition update", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const event = {
    eventId,
    status: "scheduled",
    startAtMs: 100,
    updatedAtMs: 1,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    participants: {
      "retired-profile": {
        ...participant("retired-profile", 1),
        loginUid: identity.uid,
      },
      opponent: participant("opponent", 2),
    },
  };
  const state = createRepository({
    [`events/${eventId}`]: event,
    [`eventPrizeSelections/${eventId}/retired-profile`]: "1092",
  });
  state.repository.resolveCanonicalProfileId = async (candidateProfileId) =>
    candidateProfileId === "retired-profile" ? profileId : candidateProfileId;

  await assert.rejects(
    postponeEventStart(
      workflowEnvironment(() => undefined),
      identity,
      { eventId, postponeByMinutes: 5 },
      {
        repository: state.repository,
        now: () => 100,
        random: () => 0,
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.message === "This event can no longer be postponed.",
  );
  const transition = state.patches.find(
    (patch) => patch[`events/${eventId}/status`] === "active",
  );
  assert.ok(transition);
  assert.deepEqual(transition[`eventPrizeSelections/${eventId}`], {
    [profileId]: "1092",
  });
  assert.ok(transition[`events/${eventId}/participants`]);
});

test("direct overdue postpone dismisses a one-player prize event without D1", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const event = {
    eventId,
    status: "scheduled",
    startAtMs: 100,
    updatedAtMs: 1,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    participants: { [profileId]: participant(profileId, 1) },
  };
  const state = createRepository({
    [`events/${eventId}`]: event,
    [`eventPrizeSelections/${eventId}/${profileId}`]: "1092",
  });
  let ownershipReads = 0;
  state.repository.readProfileOwnershipSnapshot = async () => {
    ownershipReads += 1;
    throw new Error("d1-unavailable");
  };

  await assert.rejects(
    postponeEventStart(
      workflowEnvironment(() => undefined),
      identity,
      { eventId, postponeByMinutes: 5 },
      {
        repository: state.repository,
        now: () => 100,
        random: () => 0,
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 409 &&
      error.message === "This event can no longer be postponed.",
  );
  const transition = state.patches.find(
    (patch) => patch[`events/${eventId}/status`] === "dismissed",
  );
  assert.ok(transition);
  assert.equal(transition[`eventPrizeSelections/${eventId}`], null);
  assert.equal(ownershipReads, 0);
});

test("direct creator UID postpones without reading D1 ownership", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
  };
  const state = createRepository({ "events/event-1": event });
  state.repository.getGameplayProfile = async () => {
    throw new Error("d1-unavailable");
  };
  state.repository.getGameplayProfileOwnership = async () => {
    throw new Error("d1-unavailable");
  };
  state.repository.resolveCanonicalProfileId = async () => {
    throw new Error("d1-unavailable");
  };
  const response = await postponeEventStart(
    workflowEnvironment(() => undefined),
    identity,
    { eventId: "event-1", postponeByMinutes: 5 },
    {
      repository: state.repository,
      now: () => 200_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(response.startAtMs, 900_000);
});

test("alternate creator ownership fails from the snapshot under the event lock", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "original-login",
    createdByProfileId: profileId,
  };
  const state = createRepository({ "events/event-1": event });
  state.repository.getGameplayProfileOwnership = async () => {
    throw new Error("d1-unavailable");
  };
  let transactions = 0;
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (...args) => {
    transactions += 1;
    return transact(...args);
  };
  await assert.rejects(
    postponeEventStart(
      workflowEnvironment(() => undefined),
      { uid: "alternate-login" },
      { eventId: "event-1", postponeByMinutes: 5 },
      {
        repository: state.repository,
        now: () => 200_000,
        random: () => 0,
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "profile-ownership-unavailable",
  );
  assert.ok(transactions > 0);
  assert.deepEqual(state.patches, []);
});

test("authorizes an alternate creator through a canonical stored profile", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "original-login",
    createdByProfileId: "retired-profile",
  };
  const state = createRepository({ "events/event-1": event });
  state.repository.getGameplayProfileOwnership = async () => ({
    loginUids: ["alternate-login", "original-login"],
    profile: {
      aura: "rainbow",
      emoji: 7,
      eth: "",
      profileId: "canonical-profile",
      rating: 1500,
      sol: "",
      username: "ivan",
    },
  });
  state.repository.resolveCanonicalProfileId = async (candidateProfileId) =>
    candidateProfileId === "retired-profile"
      ? "canonical-profile"
      : candidateProfileId;
  const response = await postponeEventStart(
    workflowEnvironment(() => undefined),
    { uid: "alternate-login" },
    { eventId: "event-1", postponeByMinutes: 5 },
    {
      repository: state.repository,
      now: () => 200_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(response.startAtMs, 900_000);
});

test("checks alternate ownership before the final event lock and write", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "original-login",
    createdByProfileId: "retired-profile",
  };
  const state = createRepository({ "events/event-1": event });
  const order: string[] = [];
  state.repository.getGameplayProfileOwnership = async () => {
    order.push("ownership");
    return {
      loginUids: ["alternate-login", "original-login"],
      profile: {
        aura: "rainbow",
        emoji: 7,
        eth: "",
        profileId: "canonical-profile",
        rating: 1500,
        sol: "",
        username: "ivan",
      },
    };
  };
  state.repository.resolveCanonicalProfileId = async (candidateProfileId) =>
    candidateProfileId === "retired-profile"
      ? "canonical-profile"
      : candidateProfileId;
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (path, updater, signal) => {
    const result = await transact(path, updater, signal);
    if (path === "eventLocks/event-1" && result.decision === "refreshed") {
      order.push("lock");
    }
    return result;
  };
  const patch = state.repository.patchRtdbRoot;
  state.repository.patchRtdbRoot = async (...args) => {
    order.push("write");
    return patch(...args);
  };
  const response = await postponeEventStart(
    workflowEnvironment(() => undefined),
    { uid: "alternate-login" },
    { eventId: "event-1", postponeByMinutes: 5 },
    {
      repository: state.repository,
      now: () => 200_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(response.startAtMs, 900_000);
  assert.deepEqual(order.slice(-3), ["ownership", "lock", "write"]);
});

test("rejects alternate creator access when login and profile disagree", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "original-login",
    createdByProfileId: "retired-profile",
  };
  const state = createRepository({ "events/event-1": event });
  state.repository.getGameplayProfileOwnership = async () => ({
    loginUids: ["alternate-login", "original-login"],
    profile: {
      aura: "rainbow",
      emoji: 7,
      eth: "",
      profileId: "canonical-profile",
      rating: 1500,
      sol: "",
      username: "ivan",
    },
  });
  let transactions = 0;
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (...args) => {
    transactions += 1;
    return transact(...args);
  };
  await assert.rejects(
    postponeEventStart(
      workflowEnvironment(() => undefined),
      { uid: "alternate-login" },
      { eventId: "event-1", postponeByMinutes: 5 },
      {
        repository: state.repository,
        now: () => 200_000,
        random: () => 0,
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 403 &&
      error.message === "Only the event creator can postpone this event.",
  );
  assert.ok(transactions > 0);
  assert.deepEqual(state.patches, []);
});

test("rate limits public event sync before runtime I/O", async () => {
  const keys: string[] = [];
  const environment = {
    ...workflowEnvironment(() => undefined),
    AUTH_RATE_LIMITER: {
      limit: async ({ key }: RateLimitOptions) => {
        keys.push(key);
        return { success: false };
      },
    },
  } as Env;
  const state = createRepository();
  let runtimeIo = 0;
  state.repository.getRtdbPath = async () => {
    runtimeIo += 1;
    throw new Error("unexpected-rtdb-read");
  };
  state.repository.readProfileOwnershipSnapshot = async () => {
    runtimeIo += 1;
    throw new Error("unexpected-d1-read");
  };
  state.repository.transactRtdbPath = async () => {
    runtimeIo += 1;
    throw new Error("unexpected-lock");
  };

  await assert.rejects(
    syncEventState(
      environment,
      identity,
      { eventId: "event-1" },
      {
        repository: state.repository,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 429 &&
      error.code === "resource-exhausted" &&
      error.message === "Too many event sync attempts.",
  );
  assert.deepEqual(keys, ["event-sync:creator-login:event-1"]);
  assert.equal(runtimeIo, 0);
});

test("normalizes event IDs before applying the public sync limit", async () => {
  const keys: string[] = [];
  const environment = {
    ...workflowEnvironment(() => undefined),
    AUTH_RATE_LIMITER: {
      limit: async ({ key }: RateLimitOptions) => {
        keys.push(key);
        return { success: false };
      },
    },
  } as Env;

  for (const eventId of ["event-1", "  event-1  "]) {
    await assert.rejects(
      syncEventState(environment, identity, { eventId }),
      (error) =>
        error instanceof AuthApiFailure &&
        error.status === 429 &&
        error.code === "resource-exhausted",
    );
  }
  assert.deepEqual(keys, [
    "event-sync:creator-login:event-1",
    "event-sync:creator-login:event-1",
  ]);
});

test("fails closed before event sync runtime creation when limiting fails", async () => {
  const environment = {
    ...workflowEnvironment(() => undefined),
    AUTH_RATE_LIMITER: {
      limit: async () => {
        throw new Error("limiter-unavailable");
      },
    },
  } as Env;
  const state = createRepository();
  let runtimeIo = 0;
  state.repository.getRtdbPath = async () => {
    runtimeIo += 1;
    throw new Error("unexpected-rtdb-read");
  };
  state.repository.readProfileOwnershipSnapshot = async () => {
    runtimeIo += 1;
    throw new Error("unexpected-d1-read");
  };
  state.repository.transactRtdbPath = async () => {
    runtimeIo += 1;
    throw new Error("unexpected-lock");
  };

  await assert.rejects(
    syncEventState(
      environment,
      identity,
      { eventId: "event-1" },
      {
        repository: state.repository,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.code === "unavailable" &&
      error.message === "rate-limit-unavailable",
  );
  assert.equal(runtimeIo, 0);
});

test("synchronizes a future scheduled event through the portable runtime", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
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

test("due public sync migrates prize selections with its start update", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const event = {
    eventId,
    status: "scheduled",
    startAtMs: 100,
    updatedAtMs: 1,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    participants: {
      "retired-profile": {
        ...participant("retired-profile", 1),
        loginUid: identity.uid,
      },
      opponent: participant("opponent", 2),
    },
  };
  const state = createRepository({
    [`events/${eventId}`]: event,
    [`eventPrizeSelections/${eventId}/retired-profile`]: "1092",
  });
  let ownershipReads = 0;
  state.repository.resolveCanonicalProfileIds = async (profileIds) => {
    ownershipReads += 1;
    return profileIds.map((candidateProfileId) =>
      candidateProfileId === "retired-profile" ? profileId : candidateProfileId,
    );
  };

  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    identity,
    { eventId },
    {
      repository: state.repository,
      now: () => 100,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.ok("didChange" in response && response.didChange);
  const transition = state.patches.find(
    (patch) => patch[`events/${eventId}/status`] === "active",
  );
  assert.ok(transition);
  assert.deepEqual(transition[`eventPrizeSelections/${eventId}`], {
    [profileId]: "1092",
  });
  assert.ok(transition[`events/${eventId}/participants`]);
  assert.equal(ownershipReads, 1);
});

test("direct public sync dismisses a one-player prize event without D1", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const event = {
    eventId,
    status: "scheduled",
    startAtMs: 100,
    updatedAtMs: 1,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    participants: { [profileId]: participant(profileId, 1) },
  };
  const state = createRepository({
    [`events/${eventId}`]: event,
    [`eventPrizeSelections/${eventId}/${profileId}`]: "1092",
  });
  let ownershipReads = 0;
  state.repository.readProfileOwnershipSnapshot = async () => {
    ownershipReads += 1;
    throw new Error("d1-unavailable");
  };

  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    identity,
    { eventId },
    {
      repository: state.repository,
      now: () => 100,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.ok("didChange" in response && response.didChange);
  assert.equal(response.event.status, "dismissed");
  const transition = state.patches.find(
    (patch) => patch[`events/${eventId}/status`] === "dismissed",
  );
  assert.ok(transition);
  assert.equal(transition[`eventPrizeSelections/${eventId}`], null);
  assert.equal(ownershipReads, 0);
});

test("rejects duplicate canonical participants before starting an event", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 100,
    updatedAtMs: 1,
    createdByLoginUid: identity.uid,
    createdByProfileId: "canonical-profile",
    participants: {
      "source-profile-1": {
        ...participant("source-profile-1", 1),
        loginUid: "merged-login",
      },
      "source-profile-2": {
        ...participant("source-profile-2", 2),
        loginUid: "merged-login",
      },
      "other-profile": participant("other-profile", 3),
    },
  };
  const state = createRepository({ "events/event-1": event });
  state.repository.resolveCanonicalProfileId = async (candidateProfileId) =>
    candidateProfileId === "source-profile-1" ||
    candidateProfileId === "source-profile-2"
      ? "canonical-profile"
      : candidateProfileId;
  await assert.rejects(
    syncEventState(
      workflowEnvironment(() => undefined),
      identity,
      { eventId: "event-1" },
      {
        repository: state.repository,
        now: () => 100,
        random: () => 0,
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.message === "profile-ownership-unavailable",
  );
  assert.deepEqual(state.patches, []);
});

test("rejects contradictory stored login and profile during synchronization", async () => {
  const canonicalProfileId = "canonical-profile";
  const storedProfileId = "retired-profile";
  const storedLoginUid = "retired-profile-login";
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "unrelated-creator",
    createdByProfileId: "unrelated-profile",
    participants: {
      [storedProfileId]: participant(storedProfileId, 1),
    },
  };
  const state = createRepository({ "events/event-1": event });
  const lookups: string[] = [];
  state.repository.getGameplayProfile = async (uid) => {
    lookups.push(uid);
    if (uid !== "alternate-login" && uid !== storedLoginUid) {
      return null;
    }
    return {
      aura: "rainbow",
      emoji: 7,
      eth: "",
      profileId: canonicalProfileId,
      rating: 1500,
      sol: "",
      username: "ivan",
    };
  };
  state.repository.listProfileLoginUids = async (candidateProfileId) =>
    candidateProfileId === canonicalProfileId
      ? ["alternate-login", storedLoginUid]
      : [];
  const staleClaimIdentity = {
    uid: "alternate-login",
    profileId: "forged-profile",
  };
  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    staleClaimIdentity,
    { eventId: "event-1" },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(response, {
    ok: true,
    eventId: "event-1",
    skipped: true,
    reason: "not-participant",
  });
  assert.deepEqual(lookups, [
    "alternate-login",
    "unrelated-creator",
    storedLoginUid,
  ]);
});

test("uses a canonical stored source ID without a participant login", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "unrelated-creator",
    createdByProfileId: "unrelated-profile",
    participants: {
      "retired-profile": {
        ...participant("retired-profile", 1),
        loginUid: "",
      },
    },
  };
  const state = createRepository({ "events/event-1": event });
  state.repository.getGameplayProfileOwnership = async () => ({
    loginUids: ["alternate-login"],
    profile: {
      aura: "rainbow",
      emoji: 7,
      eth: "",
      profileId: "canonical-profile",
      rating: 1500,
      sol: "",
      username: "ivan",
    },
  });
  state.repository.resolveCanonicalProfileId = async (candidateProfileId) =>
    candidateProfileId === "retired-profile"
      ? "canonical-profile"
      : candidateProfileId;
  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    { uid: "alternate-login" },
    { eventId: "event-1" },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.ok("didChange" in response);
  assert.equal(response.didChange, false);
});

test("bulk-resolves a maximum event participant set", async () => {
  const participants = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `profile-${index}`,
      participant(`profile-${index}`, index),
    ]),
  );
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "unrelated-creator",
    createdByProfileId: "unrelated-profile",
    participants,
  };
  const state = createRepository({ "events/event-1": event });
  state.repository.getGameplayProfileOwnership = async (uid) => {
    if (uid === "alternate-login") {
      return {
        loginUids: ["alternate-login"],
        profile: {
          aura: "",
          emoji: 0,
          eth: "",
          profileId: "alternate-profile",
          rating: 1500,
          sol: "",
          username: "alternate",
        },
      };
    }
    if (uid.endsWith("-login")) {
      const ownerProfileId = uid.slice(0, -"-login".length);
      return {
        loginUids: [uid],
        profile: {
          aura: "",
          emoji: 0,
          eth: "",
          profileId: ownerProfileId,
          rating: 1500,
          sol: "",
          username: ownerProfileId,
        },
      };
    }
    return null;
  };
  state.repository.resolveCanonicalProfileId = async () => {
    throw new Error("single-profile-resolution-must-not-run");
  };
  const batches: string[][] = [];
  state.repository.resolveCanonicalProfileIds = async (profileIds) => {
    batches.push(profileIds);
    return profileIds;
  };
  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    { uid: "alternate-login" },
    { eventId: "event-1" },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(response, {
    ok: true,
    eventId: "event-1",
    skipped: true,
    reason: "not-participant",
  });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 33);
});

test("reads alternate ownership once after acquiring the event lock", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "unrelated-creator",
    createdByProfileId: "unrelated-profile",
    participants: {
      "retired-profile": {
        ...participant("retired-profile", 1),
        loginUid: "",
      },
    },
  };
  const state = createRepository({ "events/event-1": event });
  let lockAcquired = false;
  let ownershipReads = 0;
  state.repository.getGameplayProfileOwnership = async () => {
    ownershipReads += 1;
    return {
      loginUids: ["alternate-login"],
      profile: {
        aura: "rainbow",
        emoji: 7,
        eth: "",
        profileId: lockAcquired ? "new-profile" : "canonical-profile",
        rating: 1500,
        sol: "",
        username: "ivan",
      },
    };
  };
  state.repository.resolveCanonicalProfileId = async (candidateProfileId) =>
    candidateProfileId === "retired-profile"
      ? "canonical-profile"
      : candidateProfileId;
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (path, updater, signal) => {
    const result = await transact(path, updater, signal);
    if (path === "eventLocks/event-1" && result.committed) {
      lockAcquired = true;
    }
    return result;
  };
  const response = await syncEventState(
    workflowEnvironment(() => undefined),
    { uid: "alternate-login" },
    { eventId: "event-1" },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(response, {
    ok: true,
    eventId: "event-1",
    skipped: true,
    reason: "not-participant",
  });
  assert.equal(ownershipReads, 2);
  assert.deepEqual(state.patches, []);
});

test("preserves direct participant UID synchronization without a D1 lookup", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "unrelated-creator",
    createdByProfileId: "unrelated-profile",
    participants: { [profileId]: participant(profileId, 1) },
  };
  const state = createRepository({ "events/event-1": event });
  let lookups = 0;
  state.repository.getGameplayProfile = async () => {
    lookups += 1;
    throw new Error("d1-unavailable");
  };
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
  assert.equal(response.didChange, false);
  assert.equal(lookups, 0);
});

test("fails closed under the event lock when D1 ownership is unavailable", async () => {
  const event = {
    eventId: "event-1",
    status: "scheduled",
    startAtMs: 600_000,
    updatedAtMs: 100,
    createdByLoginUid: "unrelated-creator",
    createdByProfileId: "unrelated-profile",
    participants: {
      "retired-profile": participant("retired-profile", 1),
    },
  };
  const state = createRepository({ "events/event-1": event });
  let transactions = 0;
  state.repository.getGameplayProfile = async () => {
    throw new Error("d1-unavailable");
  };
  const transact = state.repository.transactRtdbPath;
  state.repository.transactRtdbPath = async (...args) => {
    transactions += 1;
    return transact(...args);
  };
  await assert.rejects(
    syncEventState(
      workflowEnvironment(() => undefined),
      { uid: "alternate-login" },
      { eventId: "event-1" },
      {
        repository: state.repository,
        now: () => 1_000,
        random: () => 0,
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "profile-ownership-unavailable",
  );
  assert.ok(transactions > 0);
  assert.deepEqual(state.patches, []);
});

test("disqualifies an active match and synchronizes the terminal state", async () => {
  const activeMatch = {
    ...match("0_0", profileId, "opponent"),
    inviteId: "invite-1",
    status: "pending",
  };
  const event = {
    eventId: "event-1",
    status: "active",
    startAtMs: 1,
    updatedAtMs: 100,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    currentRoundIndex: 0,
    supportsThirdPlaceMatch: false,
    participants: {
      [profileId]: participant(profileId, 1),
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
    ...match("0_0", profileId, "p2"),
    inviteId: "semifinal-1",
    status: "host",
    resolvedAtMs: 100,
    winnerProfileId: profileId,
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
    createdByProfileId: profileId,
    currentRoundIndex: 0,
    supportsThirdPlaceMatch: false,
    participants: Object.fromEntries(
      [profileId, "p2", "p3", "p4"].map((profileId, index) => [
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
  assert.equal(final.hostProfileId, profileId);
  assert.equal(final.guestProfileId, "p3");
  assert.equal(final.status, "pending");
  assert.equal(typeof final.inviteId, "string");
});

test("uses one ownership snapshot for every later-round invite", async () => {
  const participants = Object.fromEntries(
    [profileId, "p2", "p3", "p4"].map((candidateProfileId, index) => [
      candidateProfileId,
      participant(candidateProfileId, index + 1),
    ]),
  );
  const event = {
    eventId: "event-1",
    status: "active",
    startAtMs: 1,
    updatedAtMs: 100,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    currentRoundIndex: 1,
    supportsThirdPlaceMatch: false,
    participants,
    rounds: {
      1: {
        status: "active",
        completedAtMs: null,
        matches: {
          "1_0": match("1_0", profileId, "p2"),
          "1_1": match("1_1", "p3", "p4"),
        },
      },
    },
  };
  const state = createRepository({ "events/event-1": event });
  let ownershipReads = 0;
  state.repository.resolveCanonicalProfileIds = async (profileIds) => {
    ownershipReads += 1;
    return ownershipReads < 3
      ? profileIds
      : profileIds.map((candidateProfileId) =>
          candidateProfileId === profileId ? "p2" : candidateProfileId,
        );
  };

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
  assert.ok("didChange" in response && response.didChange);
  assert.equal(ownershipReads, 1);
  assert.ok(getPath(state.values, "invites"));
});

test("preserves queried legacy selections for active and ended prize events", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  for (const status of ["active", "ended"] as const) {
    const final = {
      ...match("0_0", profileId, "runner-up"),
      inviteId: "final-invite",
      status: "host",
      resolvedAtMs: 500,
      winnerProfileId: profileId,
      loserProfileId: "runner-up",
    };
    const event = {
      eventId,
      status,
      startAtMs: 1,
      endedAtMs: status === "ended" ? 500 : null,
      updatedAtMs: 500,
      createdByLoginUid: identity.uid,
      createdByProfileId: profileId,
      currentRoundIndex: 0,
      winnerProfileId: status === "ended" ? profileId : null,
      winnerDisplayName: status === "ended" ? profileId.toUpperCase() : null,
      prizeSelectionsLockedAtMs: status === "ended" ? 500 : null,
      supportsThirdPlaceMatch: false,
      participants: {
        [profileId]: participant(profileId, 1),
        "runner-up": participant("runner-up", 2),
      },
      rounds: {
        0: {
          status: status === "ended" ? "completed" : "active",
          completedAtMs: status === "ended" ? 500 : null,
          matches: { "0_0": final },
        },
      },
    };
    const state = createRepository({
      [`events/${eventId}`]: event,
      [`eventPrizeSelections/${eventId}/legacy-selection-profile`]: "1514",
    });
    let queriedProfileIds: string[] = [];
    let ownershipReads = 0;
    state.repository.resolveCanonicalProfileIds = async (profileIds) => {
      ownershipReads += 1;
      queriedProfileIds = profileIds;
      return profileIds.map((candidateProfileId) =>
        candidateProfileId === "legacy-selection-profile"
          ? profileId
          : candidateProfileId,
      );
    };

    await syncEventState(
      workflowEnvironment(() => undefined),
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
      getPath(state.values, `events/${eventId}/prizeAssignments/1/prizeId`),
      "1514",
    );
    assert.ok(queriedProfileIds.includes("legacy-selection-profile"));
    assert.equal(ownershipReads, 1);
  }
});

test("does not lock active prize selections when D1 ownership fails", async () => {
  const eventId = "NN3eRzoZo80";
  const final = {
    ...match("0_0", profileId, "runner-up"),
    inviteId: "final-invite",
    status: "host",
    resolvedAtMs: 500,
    winnerProfileId: profileId,
    loserProfileId: "runner-up",
  };
  const event = {
    eventId,
    status: "active",
    startAtMs: 1,
    updatedAtMs: 500,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    currentRoundIndex: 0,
    supportsThirdPlaceMatch: false,
    participants: {
      [profileId]: participant(profileId, 1),
      "runner-up": participant("runner-up", 2),
    },
    rounds: {
      0: {
        status: "active",
        completedAtMs: null,
        matches: { "0_0": final },
      },
    },
  };
  const state = createRepository({ [`events/${eventId}`]: event });
  state.repository.resolveCanonicalProfileIds = async () => {
    throw new Error("d1-unavailable");
  };

  await assert.rejects(
    syncEventState(
      workflowEnvironment(() => undefined),
      identity,
      { eventId },
      {
        repository: state.repository,
        now: () => 1_000,
        random: () => 0,
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error instanceof AuthApiFailure &&
      error.status === 503 &&
      error.message === "profile-ownership-unavailable",
  );
  assert.deepEqual(state.patches, []);
  assert.equal(
    getPath(state.values, `events/${eventId}/prizeSelectionsLockedAtMs`),
    null,
  );
  assert.equal(getPath(state.values, `events/${eventId}/status`), "active");
});

test("projects terminal prizes from the locked ownership snapshot", async () => {
  const eventId = "NN3eRzoZo80";
  const assignedAtMs = 500;
  const final = {
    ...match("0_0", profileId, "runner-up"),
    inviteId: "final-invite",
    status: "host",
    resolvedAtMs: assignedAtMs,
    winnerProfileId: profileId,
    loserProfileId: "runner-up",
  };
  const assignments = {
    1: {
      eventId,
      profileId: profileId,
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
    createdByProfileId: profileId,
    currentRoundIndex: 0,
    winnerProfileId: profileId,
    winnerDisplayName: profileId.toUpperCase(),
    prizeSelectionsLockedAtMs: assignedAtMs,
    prizeAssignments: assignments,
    supportsThirdPlaceMatch: false,
    participants: {
      [profileId]: participant(profileId, 1),
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
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.ok("didChange" in response);
  assert.equal(response.didChange, true);
  assert.deepEqual(
    getPath(state.values, `profileEventPrizes/${profileId}/${eventId}`),
    assignments[1],
  );
  assert.deepEqual(
    getPath(state.values, `profileEventPrizes/runner-up/${eventId}`),
    assignments[2],
  );
  assert.equal(
    getPath(state.values, `profileEventPrizes/canonical-profile/${eventId}`),
    null,
  );
});

test("uses one ownership snapshot while creating prize assignments", async () => {
  const eventId = "NN3eRzoZo80";
  const assignedAtMs = 500;
  const final = {
    ...match("0_0", profileId, "runner-up"),
    inviteId: "final-invite",
    status: "host",
    resolvedAtMs: assignedAtMs,
    winnerProfileId: profileId,
    loserProfileId: "runner-up",
  };
  const event = {
    eventId,
    status: "ended",
    startAtMs: 1,
    endedAtMs: assignedAtMs,
    updatedAtMs: assignedAtMs,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    currentRoundIndex: 0,
    winnerProfileId: profileId,
    winnerDisplayName: profileId.toUpperCase(),
    prizeSelectionsLockedAtMs: assignedAtMs,
    supportsThirdPlaceMatch: false,
    participants: {
      [profileId]: participant(profileId, 1),
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
  let ownershipReads = 0;
  state.repository.resolveCanonicalProfileIds = async (profileIds) => {
    ownershipReads += 1;
    return ownershipReads === 1 ? profileIds : profileIds.map(() => profileId);
  };

  await syncEventState(
    workflowEnvironment(() => undefined),
    identity,
    { eventId },
    {
      repository: state.repository,
      now: () => 1_000,
      random: () => 0,
      sleep: async () => undefined,
    },
  );
  assert.equal(ownershipReads, 1);
  assert.ok(getPath(state.values, `events/${eventId}/prizeAssignments`));
});

test("uses canonical prize ownership with an injected repository", async () => {
  const eventId = "NN3eRzoZo80";
  const assignedAtMs = 500;
  const assignment = {
    eventId,
    profileId: profileId,
    place: 1,
    prizeId: "1092",
    assignedAtMs,
  };
  const final = {
    ...match("0_0", profileId, null),
    inviteId: "final-invite",
    status: "host",
    resolvedAtMs: assignedAtMs,
    winnerProfileId: profileId,
  };
  const event = {
    eventId,
    status: "ended",
    startAtMs: 1,
    endedAtMs: assignedAtMs,
    updatedAtMs: assignedAtMs,
    createdByLoginUid: identity.uid,
    createdByProfileId: profileId,
    currentRoundIndex: 0,
    winnerProfileId: profileId,
    winnerDisplayName: profileId.toUpperCase(),
    prizeSelectionsLockedAtMs: assignedAtMs,
    prizeAssignments: { 1: assignment },
    supportsThirdPlaceMatch: false,
    participants: {
      [profileId]: participant(profileId, 1),
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
  state.repository.getGameplayProfileOwnership = async () => ({
    loginUids: [identity.uid],
    profile: {
      aura: "",
      emoji: 0,
      eth: "",
      profileId: "canonical-profile",
      rating: 1500,
      sol: "",
      username: "creator",
    },
  });
  state.repository.resolveCanonicalProfileId = async (candidateProfileId) =>
    candidateProfileId === profileId ? "canonical-profile" : candidateProfileId;
  await syncEventState(
    workflowEnvironment(() => undefined),
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
    getPath(state.values, `profileEventPrizes/${profileId}/${eventId}`),
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
