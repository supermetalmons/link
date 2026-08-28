import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateInviteRequest,
  EndRematchRequest,
  EnsureMatchRequest,
  JoinInviteRequest,
  ProposeRematchRequest,
  ResolveInviteRoleRequest,
} from "@mons/shared/game-sessions";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { FirebaseIdentity } from "../src/firebaseAuth.ts";
import {
  GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT,
  acquireGameSessionMutationLease,
  createManualInvite,
  endRematchSeries,
  ensureParticipantMatch,
  joinInvite,
  proposeRematch,
  refreshGameSessionMutationLease,
  releaseGameSessionMutationLease,
  resolveInviteRole,
  sweepGameSessionMutationReceipts,
} from "../src/gameSessionMutations.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const identity: FirebaseIdentity = {
  idToken: "firebase-token",
  profileId: "profile-1",
  rawProfileIdClaim: "profile-1",
  uid: "login-1",
};

const ids = {
  create: "00000000-0000-4000-8000-000000000001",
  join: "00000000-0000-4000-8000-000000000002",
  propose: "00000000-0000-4000-8000-000000000003",
  end: "00000000-0000-4000-8000-000000000004",
  ensure: "00000000-0000-4000-8000-000000000005",
};

const match = (color: "black" | "white" = "white") => ({
  version: 2,
  color,
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen: "0,0",
  status: "",
  flatMovesString: "",
  timer: "",
});

function resolveServerValues(value: unknown, nowMs: number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveServerValues(entry, nowMs));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record[".sv"] === "timestamp") {
    return nowMs;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      resolveServerValues(entry, nowMs),
    ]),
  );
}

function repository(initial: Record<string, unknown> = {}, nowMs = 1_000) {
  const values = new Map(Object.entries(initial));
  const patches: Record<string, unknown>[] = [];
  const result: GameplayRepository = {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => null,
    getGameplayProfile: async () => ({
      aura: "",
      emoji: 1,
      eth: "",
      profileId: "profile-1",
      rating: 1500,
      sol: "",
      username: "Alice",
    }),
    getNavigationGame: async () => null,
    getMiningMaterials: async () => ({
      dust: 0,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    }),
    getMiningSnapshot: async () => null,
    getRtdbPath: async (path) => values.get(path) ?? null,
    patchRtdbRoot: async (updates) => {
      patches.push(updates);
      for (const [path, raw] of Object.entries(updates)) {
        const value = resolveServerValues(raw, nowMs);
        if (value === null) {
          values.delete(path);
        } else {
          values.set(path, value);
        }
      }
    },
    transactRtdbPath: async (path, updater) => {
      const current = values.get(path) ?? null;
      const decision = updater(current) as {
        commit?: boolean;
        decision?: string;
        value?: unknown;
      };
      if (decision.commit === false) {
        return {
          committed: false,
          decision: decision.decision,
          value: current,
        };
      }
      values.set(path, decision.value);
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    },
  };
  return { patches, repository: result, values };
}

function presentation() {
  return { emojiId: 1, aura: "" };
}

test("resolves invite roles from authoritative participant links", async () => {
  const request: ResolveInviteRoleRequest = { inviteId: "abcdefghijk" };
  const base = {
    "invites/abcdefghijk": {
      hostId: "host-login",
      guestId: "guest-login",
    },
    "players/host-login/profile": "profile-host",
    "players/guest-login/profile": "profile-1",
    "players/login-1/profile": "profile-1",
  };

  assert.deepEqual(
    await resolveInviteRole(
      { ...identity, uid: "host-login" },
      request,
      repository(base).repository,
    ),
    {
      ok: true,
      inviteId: request.inviteId,
      hostId: "host-login",
      guestId: "guest-login",
      actorUid: "host-login",
      role: "host",
    },
  );
  assert.equal(
    (await resolveInviteRole(identity, request, repository(base).repository))
      .role,
    "guest",
  );
  const alternateHost = repository({
    ...base,
    "players/login-1/profile": "profile-host",
  });
  assert.equal(
    (await resolveInviteRole(identity, request, alternateHost.repository)).role,
    "host",
  );
  const sharedProfile = repository({
    ...base,
    "players/host-login/profile": "profile-1",
  });
  assert.equal(
    (await resolveInviteRole(identity, request, sharedProfile.repository)).role,
    "host",
  );
  const recoveringIdentity = repository({
    ...base,
    "players/login-1/profile": "profile-stale",
    "players/host-login/profile": "profile-1",
  });
  assert.equal(
    (await resolveInviteRole(identity, request, recoveringIdentity.repository))
      .role,
    "host",
  );
  const unrelatedIdentity = repository({
    ...base,
    "players/login-1/profile": "profile-other",
  });
  assert.equal(
    (
      await resolveInviteRole(
        {
          ...identity,
          profileId: "profile-other",
          rawProfileIdClaim: "profile-other",
        },
        request,
        unrelatedIdentity.repository,
      )
    ).role,
    "watch",
  );
});

test("resolves pending and anonymous invite roles without masking participants", async () => {
  const request: ResolveInviteRoleRequest = { inviteId: "abcdefghijk" };
  const pending = repository({
    "invites/abcdefghijk": { hostId: "host-login", guestId: null },
    "players/host-login/profile": "profile-host",
    "players/login-1/profile": "profile-host",
  });
  assert.equal(
    (
      await resolveInviteRole(
        { ...identity, profileId: "profile-host" },
        request,
        pending.repository,
      )
    ).role,
    "host",
  );

  const anonymousHost = repository({
    "invites/abcdefghijk": {
      hostId: "anonymous-host",
      guestId: "guest-login",
    },
    "players/guest-login/profile": "profile-1",
    "players/login-1/profile": "profile-1",
  });
  const guest = await resolveInviteRole(
    identity,
    request,
    anonymousHost.repository,
  );
  assert.equal(guest.role, "guest");
  assert.equal(guest.actorUid, "guest-login");
});

test("uses only Firebase-rule-visible evidence for alternate invite roles", async () => {
  const request: ResolveInviteRoleRequest = { inviteId: "abcdefghijk" };
  const base = {
    "invites/abcdefghijk": {
      hostId: "host-login",
      guestId: "guest-login",
    },
    "players/host-login/profile": "profile-host",
    "players/guest-login/profile": "profile-guest",
  };
  const canonicalOnly = repository(base).repository;
  canonicalOnly.findProfileId = async () => "profile-host";
  assert.equal(
    (
      await resolveInviteRole(
        { ...identity, profileId: "", uid: "alternate-login" },
        request,
        canonicalOnly,
      )
    ).role,
    "watch",
  );

  assert.equal(
    (
      await resolveInviteRole(
        {
          ...identity,
          profileId: "profile-host",
          rawProfileIdClaim: "profile-host",
          uid: "alternate-login",
        },
        request,
        canonicalOnly,
      )
    ).role,
    "host",
  );

  assert.equal(
    (
      await resolveInviteRole(
        {
          ...identity,
          profileId: "profile-host",
          rawProfileIdClaim: " profile-host ",
          uid: "alternate-login",
        },
        request,
        canonicalOnly,
      )
    ).role,
    "watch",
  );

  const paddedMismatch = repository({
    ...base,
    "players/alternate-login/profile": " profile-host ",
  }).repository;
  assert.equal(
    (
      await resolveInviteRole(
        { ...identity, profileId: "", uid: "alternate-login" },
        request,
        paddedMismatch,
      )
    ).role,
    "watch",
  );

  const exactPaddedMatch = repository({
    ...base,
    "players/host-login/profile": " profile-host ",
    "players/alternate-login/profile": " profile-host ",
  }).repository;
  assert.equal(
    (
      await resolveInviteRole(
        { ...identity, profileId: "", uid: "alternate-login" },
        request,
        exactPaddedMatch,
      )
    ).role,
    "host",
  );

  const guestUnavailable = repository(base).repository;
  guestUnavailable.getRtdbPath = async (path) => {
    if (path === "invites/abcdefghijk") return base["invites/abcdefghijk"];
    if (path === "players/alternate-login/profile") return "profile-host";
    if (path === "players/host-login/profile") return "profile-host";
    if (path === "players/guest-login/profile") {
      throw new Error("guest-profile-unavailable");
    }
    return null;
  };
  assert.equal(
    (
      await resolveInviteRole(
        { ...identity, profileId: "", uid: "alternate-login" },
        request,
        guestUnavailable,
      )
    ).role,
    "host",
  );
});

test("preserves password-protected invite read access", async () => {
  const request: ResolveInviteRoleRequest = { inviteId: "abcdefghijk" };
  const pending = {
    "invites/abcdefghijk": {
      hostId: "host-login",
      guestId: null,
      password: "secret",
    },
    "players/host-login/profile": "profile-host",
  };
  await assert.rejects(
    () =>
      resolveInviteRole(
        { ...identity, profileId: "profile-other" },
        request,
        repository(pending).repository,
      ),
    (error: unknown) => error instanceof AuthApiFailure && error.status === 403,
  );
  const hostAccess = repository({
    ...pending,
    "players/login-1/profile": "profile-host",
  });
  assert.equal(
    (await resolveInviteRole(identity, request, hostAccess.repository)).role,
    "host",
  );

  const completed = repository({
    ...pending,
    "invites/abcdefghijk": {
      ...pending["invites/abcdefghijk"],
      guestId: "guest-login",
    },
    "players/guest-login/profile": "profile-guest",
  });
  assert.equal(
    (
      await resolveInviteRole(
        { ...identity, profileId: "profile-other" },
        request,
        completed.repository,
      )
    ).role,
    "watch",
  );
});

test("rejects missing, malformed, and unavailable invite role state", async () => {
  const request: ResolveInviteRoleRequest = { inviteId: "abcdefghijk" };
  await assert.rejects(
    () => resolveInviteRole(identity, request, repository().repository),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.message === "invite-not-found",
  );
  await assert.rejects(
    () =>
      resolveInviteRole(
        identity,
        request,
        repository({
          "invites/abcdefghijk": {
            hostId: "unsafe/host",
            guestId: null,
          },
        }).repository,
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.message === "invite-invalid",
  );
  for (const malformedInvite of [
    "corrupt",
    { hostId: "host-login", guestId: { corrupt: true } },
  ]) {
    await assert.rejects(
      () =>
        resolveInviteRole(
          identity,
          request,
          repository({
            "invites/abcdefghijk": malformedInvite,
          }).repository,
        ),
      (error: unknown) =>
        error instanceof AuthApiFailure &&
        error.status === 409 &&
        error.message === "invite-invalid",
    );
  }
  const unavailable = repository({
    "invites/abcdefghijk": {
      hostId: "host-login",
      guestId: "guest-login",
    },
  }).repository;
  unavailable.getRtdbPath = async () => {
    throw new Error("rtdb-unavailable");
  };
  await assert.rejects(
    () => resolveInviteRole(identity, request, unavailable),
    /rtdb-unavailable/,
  );

  const ownershipUnavailable = repository({
    "invites/abcdefghijk": {
      hostId: "host-login",
      guestId: "guest-login",
    },
  }).repository;
  ownershipUnavailable.getRtdbPath = async (path) => {
    if (path === "invites/abcdefghijk") {
      return { hostId: "host-login", guestId: "guest-login" };
    }
    if (path === "players/alternate-login/profile") {
      throw new Error("rtdb-unavailable");
    }
    return null;
  };
  ownershipUnavailable.findProfileId = async () => {
    throw new Error("firestore-unavailable");
  };
  await assert.rejects(
    () =>
      resolveInviteRole(
        { ...identity, profileId: "", uid: "alternate-login" },
        request,
        ownershipUnavailable,
      ),
    /profile-ownership-unavailable/,
  );
});

test("serializes invite mutations with expiring owner-fenced leases", async () => {
  const state = repository();
  await acquireGameSessionMutationLease(
    "abcdefghijk",
    ids.create,
    "owner-1",
    state.repository,
    100,
  );
  await assert.rejects(
    () =>
      acquireGameSessionMutationLease(
        "abcdefghijk",
        ids.join,
        "owner-2",
        state.repository,
        101,
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.message === "invite-busy",
  );
  await releaseGameSessionMutationLease(
    "abcdefghijk",
    "wrong-owner",
    state.repository,
  );
  await acquireGameSessionMutationLease(
    "abcdefghijk",
    ids.join,
    "owner-2",
    state.repository,
    60_101,
  );
  await assert.rejects(
    () =>
      refreshGameSessionMutationLease(
        "abcdefghijk",
        ids.create,
        "owner-1",
        state.repository,
        60_102,
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.message === "invite-lease-lost",
  );
});

test("creates and replays one atomic manual invite mutation", async () => {
  const state = repository();
  const tasks: unknown[] = [];
  const request: CreateInviteRequest = {
    operationId: ids.create,
    inviteId: "abcdefghijk",
    ...presentation(),
  };
  const dependencies = {
    createOwnerId: () => crypto.randomUUID(),
    enqueueProfileGameProjection: async (task: unknown) => {
      tasks.push(task);
    },
    now: () => 1_000,
    random: () => 0,
  };
  const first = await createManualInvite(
    identity,
    request,
    state.repository,
    dependencies,
  );
  const replay = await createManualInvite(
    identity,
    request,
    state.repository,
    dependencies,
  );
  assert.deepEqual(replay, first);
  assert.equal(state.patches.length, 1);
  const patch = state.patches[0];
  assert.equal(
    (patch["invites/abcdefghijk"] as Record<string, unknown>).hostId,
    identity.uid,
  );
  assert.ok(patch["players/login-1/matches/abcdefghijk"]);
  assert.equal(
    (patch[`gameplayMutationReceipts/${ids.create}`] as Record<string, unknown>)
      .requesterUid,
    identity.uid,
  );
  assert.ok(patch[`gameplayMutationReceiptExpirations/${ids.create}`]);
  assert.deepEqual(patch["profileGameProjectionOutbox/automatch/abcdefghijk"], {
    schemaVersion: 1,
    status: "pending",
    requestId: ids.create,
    reason: "manual-invite-created",
    sourceUpdatedAtMs: { ".sv": "timestamp" },
    lastQueuedAtMs: { ".sv": "timestamp" },
  });
  assert.equal(tasks.length, 2);
  await assert.rejects(
    () =>
      createManualInvite(
        { ...identity, uid: "other-login" },
        request,
        state.repository,
        dependencies,
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.message === "operation-conflict",
  );
  await assert.rejects(
    () =>
      createManualInvite(
        identity,
        { ...request, emojiId: 2 },
        state.repository,
        dependencies,
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.message === "operation-conflict",
  );
});

test("joins a manual invite and persists the mirrored guest match", async () => {
  const state = repository({
    "invites/abcdefghijk": {
      version: 2,
      hostId: "host-login",
      hostColor: "white",
      guestId: null,
    },
    "players/host-login/profile": "profile-host",
    "players/host-login/matches/abcdefghijk": match("white"),
  });
  const request: JoinInviteRequest = {
    operationId: ids.join,
    inviteId: "abcdefghijk",
    ...presentation(),
  };
  const response = await joinInvite(identity, request, state.repository, {
    createOwnerId: () => "owner",
    now: () => 1_000,
  });
  assert.deepEqual(response, {
    ok: true,
    inviteId: "abcdefghijk",
    guestId: identity.uid,
    joined: true,
    matchId: "abcdefghijk",
  });
  const patch = state.patches[0];
  assert.equal(patch["invites/abcdefghijk/guestId"], identity.uid);
  assert.equal(
    (patch["players/login-1/matches/abcdefghijk"] as Record<string, unknown>)
      .color,
    "black",
  );
});

test("does not join a host through the same canonical merged profile", async () => {
  const state = repository({
    "invites/abcdefghijk": {
      version: 2,
      hostId: "host-login",
      hostColor: "white",
      guestId: null,
    },
    "players/host-login/profile": "source-profile",
    "players/login-1/profile": "target-profile",
    "players/host-login/matches/abcdefghijk": match("white"),
  });
  state.repository.findProfileId = async (uid) =>
    uid === "host-login" || uid === identity.uid ? "target-profile" : null;

  const response = await joinInvite(
    identity,
    {
      operationId: ids.join,
      inviteId: "abcdefghijk",
      ...presentation(),
    },
    state.repository,
    { createOwnerId: () => "owner", now: () => 1_000 },
  );

  assert.deepEqual(response, {
    ok: true,
    inviteId: "abcdefghijk",
    guestId: null,
    joined: false,
    matchId: null,
  });
  assert.equal(state.values.get("invites/abcdefghijk/guestId"), undefined);
});

test("preserves pending automatch link joining and Telegram projection", async () => {
  const state = repository({
    "invites/auto_abcdefghi": {
      version: 2,
      hostId: "host-login",
      hostColor: "white",
      guestId: null,
    },
    "players/host-login/profile": "profile-host",
    "players/host-login/matches/auto_abcdefghi": match("white"),
    "automatch/auto_abcdefghi": {
      uid: "host-login",
      username: "Bob",
      rating: 1400,
      emojiId: 2,
      telegramDeliveryVersion: 2,
    },
  });
  await joinInvite(
    identity,
    {
      operationId: ids.join,
      inviteId: "auto_abcdefghi",
      ...presentation(),
    },
    state.repository,
    { createOwnerId: () => "owner", now: () => 1_000 },
  );
  const patch = state.patches[0];
  assert.equal(patch["automatch/auto_abcdefghi"], null);
  assert.equal(
    patch["telegramAutomatches/auto_abcdefghi/lifecycle"],
    "matched",
  );
  assert.ok(patch["telegramProjectionOutbox/automatch/auto_abcdefghi"]);
});

test("does not join an auto invite after its pending queue is gone", async () => {
  const state = repository({
    "invites/auto_abcdefghi": {
      version: 2,
      hostId: "host-login",
      hostColor: "white",
      guestId: null,
      automatchStateHint: "canceled",
    },
    "players/host-login/profile": "profile-host",
  });
  await assert.rejects(
    () =>
      joinInvite(
        identity,
        {
          operationId: ids.join,
          inviteId: "auto_abcdefghi",
          ...presentation(),
        },
        state.repository,
        { createOwnerId: () => "owner", now: () => 1_000 },
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure &&
      error.message === "automatch-not-pending",
  );
  assert.equal(state.patches.length, 0);
});

test("proposes and ends rematches through participant-owned writes", async () => {
  const baseInvite = {
    version: 2,
    hostId: identity.uid,
    hostColor: "white",
    guestId: "guest-login",
  };
  const proposed = repository({ "invites/abcdefghijk": baseInvite });
  const proposeRequest: ProposeRematchRequest = {
    operationId: ids.propose,
    inviteId: "abcdefghijk",
    ...presentation(),
  };
  const proposal = await proposeRematch(
    identity,
    proposeRequest,
    proposed.repository,
    { createOwnerId: () => "owner", now: () => 1_000 },
  );
  assert.equal(proposal.matchId, "abcdefghijk1");
  assert.equal(proposal.rematches, "1");
  assert.ok(proposed.patches[0]["players/login-1/matches/abcdefghijk1"]);

  const ended = repository({ "invites/abcdefghijk": baseInvite });
  const endRequest: EndRematchRequest = {
    operationId: ids.end,
    inviteId: "abcdefghijk",
  };
  const end = await endRematchSeries(identity, endRequest, ended.repository, {
    createOwnerId: () => "owner",
    now: () => 1_000,
  });
  assert.equal(end.rematches, "x");
  assert.equal(ended.patches[0]["invites/abcdefghijk/hostRematches"], "x");

  const endedByGuest = repository({
    "invites/abcdefghijk": { ...baseInvite, guestRematches: "1x" },
  });
  const hostEnd = await endRematchSeries(
    identity,
    endRequest,
    endedByGuest.repository,
    { createOwnerId: () => "owner", now: () => 1_000 },
  );
  assert.equal(hostEnd.rematches, "x");
  assert.equal(
    endedByGuest.patches[0]["invites/abcdefghijk/hostRematches"],
    "x",
  );
});

test("ensures a missing match for an alternate login on the same profile", async () => {
  const alternate: FirebaseIdentity = {
    idToken: "alternate-token",
    profileId: "profile-host",
    uid: "alternate-login",
  };
  const state = repository({
    "invites/abcdefghijk": {
      hostId: "host-login",
      hostColor: "white",
      guestId: "guest-login",
    },
    "players/host-login/profile": "profile-host",
    "players/guest-login/profile": "profile-guest",
    "players/guest-login/matches/abcdefghijk": match("black"),
  });
  const request: EnsureMatchRequest = {
    operationId: ids.ensure,
    inviteId: "abcdefghijk",
    matchId: "abcdefghijk",
    ...presentation(),
  };
  const response = await ensureParticipantMatch(
    alternate,
    request,
    state.repository,
    { createOwnerId: () => "owner", now: () => 1_000 },
  );
  assert.equal(response.actorUid, "host-login");
  assert.equal(response.created, true);
  assert.ok(state.patches[0]["players/host-login/matches/abcdefghijk"]);
});

test("rejects structural mutations for event-owned invites", async () => {
  const state = repository({
    "invites/abcdefghijk": {
      hostId: identity.uid,
      guestId: "guest-login",
      eventId: "event-1",
    },
  });
  await assert.rejects(
    () =>
      endRematchSeries(
        identity,
        { operationId: ids.end, inviteId: "abcdefghijk" },
        state.repository,
        { createOwnerId: () => "owner", now: () => 1_000 },
      ),
    (error: unknown) =>
      error instanceof AuthApiFailure && error.message === "event-owned-invite",
  );
});

test("removes only expired mutation receipts in bounded sweeps", async () => {
  assert.equal(GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT, 1000);
  const state = repository({
    gameplayMutationReceiptExpirations: {
      [ids.create]: { completedAtMs: 1 },
      [ids.join]: { completedAtMs: 900_000_000 },
    },
  });
  const count = await sweepGameSessionMutationReceipts(
    TELEGRAM_TEST_ENV as Env,
    {
      now: () => 7 * 24 * 60 * 60 * 1_000 + 100,
      repository: state.repository,
    },
  );
  assert.equal(count, 1);
  assert.deepEqual(state.patches[0], {
    [`gameplayMutationReceipts/${ids.create}`]: null,
    [`gameplayMutationReceiptExpirations/${ids.create}`]: null,
  });
});
