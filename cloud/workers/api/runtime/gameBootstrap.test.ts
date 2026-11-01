import {
  APPLICATION_DATA_HEADER,
  APPLICATION_DATA_EPOCH,
} from "@mons/shared/data-contract";
import { activateCanonicalApplicationFixture } from "./applicationRoomFixture.ts";
import {
  canonicalMatchEnvironment,
  runInCanonicalMatchRoom,
} from "./canonicalMatchTestFixture.ts";
import {
  retainedInviteSourceFixture,
  inviteDocumentFixture,
} from "../test/inviteDocumentFixture.ts";
import {
  unwrapMatchStateWireFixture,
  publicMatchFixture,
  matchDocumentFixture,
} from "../test/matchRecordFixture.ts";
import { env as rawEnv, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  isReadGameBootstrapResponse,
  type ReadGameBootstrapResponse,
} from "@mons/shared/game-bootstrap";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { handleGameBootstrapRoute } from "../src/gameBootstrapRoute.ts";
import type { InviteReactions } from "../src/inviteReactions.ts";
import { getMatchStateRpc } from "../src/matchStateRpc.ts";
import { socketTestIdentity } from "../test/socketTestSession.ts";

const env = canonicalMatchEnvironment(rawEnv);
beforeAll(activateCanonicalApplicationFixture);

const rooms: DurableObjectStub<InviteReactions>[] = [];
const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const match = publicMatchFixture({
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "none",
  gameVariant: "standard",
  fen: "initial",
  status: "active",
  flatMovesString: "",
  timer: { state: "idle" },
});

async function fixture({
  rematch = false,
  guest = true,
  protectedInvite = false,
} = {}) {
  const inviteId = `bootstrap-room-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  rooms.push(room);
  const invite = inviteDocumentFixture({
    hostId: "host-login",
    guestId: "guest-login",
    hostColor: "white",
    ...(protectedInvite ? { kind: "automatch", password: "secret" } : {}),
    hostRematches: { state: "open", indices: rematch ? [1] : [] },
    guestRematches: { state: "open", indices: rematch ? [1] : [] },
  });
  await runInCanonicalMatchRoom(room, (instance) => {
    Reflect.set(instance, "inviteReader", async () => structuredClone(invite));
  });
  const matchId = rematch ? `${inviteId}1` : inviteId;
  unwrapMatchStateWireFixture(
    await getMatchStateRpc(env, inviteId).createCanonicalMatch({
      inviteId,
      epoch: 2,
      records: [
        {
          matchId,
          playerId: "host-login",
          marker: "host-created",
          value: matchDocumentFixture(match),
        },
        ...(guest
          ? [
              {
                matchId,
                playerId: "guest-login",
                marker: "guest-created",
                value: matchDocumentFixture({ ...match, color: "black" }),
              },
            ]
          : []),
      ],
    }),
  );
  const repository = createGameplayRepository(env);
  repository.readInviteMetadata = async () =>
    retainedInviteSourceFixture({
      hostId: invite.hostId,
      guestId: invite.guestId,
      hostColor: invite.hostColor,
    });
  repository.readMatchRecord = async () => {
    throw new Error("unexpected-record-route-read");
  };
  repository.readProfileOwnershipSnapshot = async (query) => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(query.loginUids.map((uid) => [uid, null])),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  });
  return { inviteId, matchId, room, repository, invite };
}

async function bootstrap(
  state: Awaited<ReturnType<typeof fixture>>,
  caller = "host-login",
) {
  const response = await handleGameBootstrapRoute(
    new Request(`https://api.mons.link/invites/${state.inviteId}/bootstrap`, {
      headers: {
        [APPLICATION_DATA_HEADER]: String(APPLICATION_DATA_EPOCH),
        Origin: "https://mons.link",
        Authorization: "Bearer fixture",
      },
    }),
    env,
    ctx,
    {
      repository: state.repository,
      readAdmission: (id, signal) =>
        state.repository.readInviteMetadata(id, signal),
      room: state.room,
      verifyIdentity: async () => socketTestIdentity(caller),
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json<ReadGameBootstrapResponse>();
  expect(isReadGameBootstrapResponse(body)).toBe(true);
  return body;
}

afterEach(async () => {
  await Promise.all(
    rooms
      .splice(0)
      .map((room) =>
        runInCanonicalMatchRoom(room, (_instance, state) =>
          state.storage.deleteAlarm(),
        ),
      ),
  );
});

describe("game bootstrap Worker and canonical room", () => {
  it("dispatches preflight and requires authentication through the Worker entrypoint", async () => {
    const url = "https://api.mons.link/invites/bootstrap-runtime/bootstrap";
    const preflight = await exports.default.fetch(
      new Request(url, {
        method: "OPTIONS",
        headers: {
          [APPLICATION_DATA_HEADER]: String(APPLICATION_DATA_EPOCH),
          Origin: "https://mons.link",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    const anonymous = await exports.default.fetch(
      new Request(url, {
        headers: {
          [APPLICATION_DATA_HEADER]: String(APPLICATION_DATA_EPOCH),
          Origin: "https://mons.link",
        },
      }),
    );
    expect(anonymous.status).toBe(401);
  });

  it("returns both canonical records with the same revision as the initial sync snapshot", async () => {
    const state = await fixture();
    const body = await bootstrap(state);
    expect(body.match.hostMatch).toEqual(match);
    expect(body.match.guestMatch).toEqual({ ...match, color: "black" });
    const sync = await state.room.readMatches(state.inviteId, state.matchId);
    expect(sync.status).toBe("ok");
    if (sync.status === "ok") expect(body.match).toEqual(sync.snapshot);
  });

  it("selects a rematch from fresh room metadata after an older admission read", async () => {
    const state = await fixture({ rematch: true });
    const body = await bootstrap(state);
    expect(body.match.matchId).toBe(state.matchId);
    expect(body.metadata.hostRematches).toEqual({
      state: "open",
      indices: [1],
    });
    expect(body.metadata.guestRematches).toEqual({
      state: "open",
      indices: [1],
    });
    expect(body.hasPendingProposal).toBe(false);
    expect(body.match.hostMatch).toEqual(match);
  });

  it("keeps a genuinely absent participant null for the existing ensure flow", async () => {
    const state = await fixture({ guest: false });
    const body = await bootstrap(state);
    expect(body.match.hostMatch).toEqual(match);
    expect(body.match.guestMatch).toBeNull();
    expect(body.viewer.role).toBe("host");
  });

  it.each([false, true])(
    "refreshes both room caches when a guest joins a protected=%s invite",
    async (protectedInvite) => {
      const state = await fixture({ protectedInvite });
      state.invite.guestId = null;
      const cached = await state.room.readMatches(
        state.inviteId,
        state.matchId,
      );
      expect(cached.status).toBe("ok");
      if (cached.status !== "ok") throw new Error("invalid-fixture");
      expect(cached.metadata.snapshot.guestId).toBeNull();
      state.invite.guestId = "guest-login";
      state.repository.readInviteMetadata = async () =>
        retainedInviteSourceFixture(structuredClone(state.invite));
      const body = await bootstrap(state, "guest-login");
      expect(body.viewer.role).toBe("guest");
      expect(body.viewer.actorUid).toBe("guest-login");
      expect(body.metadata.guestId).toBe("guest-login");
      expect(body.match.guestMatch).toEqual({ ...match, color: "black" });
      expect(body.metadata.revision).toBeGreaterThan(
        cached.metadata.snapshot.revision,
      );
      expect(body.match.revision).toBeGreaterThan(cached.snapshot.revision);
    },
  );

  it("refreshes an ended rematch even when the selected match does not change", async () => {
    const state = await fixture({ rematch: true });
    const cached = await state.room.readMatches(state.inviteId, state.matchId);
    expect(cached.status).toBe("ok");
    state.invite.hostRematches = { state: "ended", indices: [1] };
    state.repository.readInviteMetadata = async () =>
      retainedInviteSourceFixture(structuredClone(state.invite));
    const body = await bootstrap(state);
    expect(body.match.matchId).toBe(state.matchId);
    expect(body.metadata.hostRematches).toEqual({
      state: "ended",
      indices: [1],
    });
    expect(body.hasPendingProposal).toBe(false);
  });

  it("refreshes an accepted pending rematch before resolving the guest selection", async () => {
    const state = await fixture({ rematch: true });
    state.invite.guestRematches = { state: "open", indices: [] };
    const cached = await state.room.readMatches(state.inviteId, state.matchId);
    expect(cached.status).toBe("ok");
    state.invite.guestRematches = { state: "open", indices: [1] };
    state.repository.readInviteMetadata = async () =>
      retainedInviteSourceFixture(structuredClone(state.invite));
    const body = await bootstrap(state, "guest-login");
    expect(body.viewer.role).toBe("guest");
    expect(body.match.matchId).toBe(state.matchId);
    expect(body.metadata.guestRematches).toEqual({
      state: "open",
      indices: [1],
    });
    expect(body.hasPendingProposal).toBe(false);
  });
});
