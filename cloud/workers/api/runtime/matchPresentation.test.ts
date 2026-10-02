import {
  PRESENTATION_MAX_MESSAGE_BYTES,
  isMatchPresentationSnapshot,
  type UpdateMatchPresentationRequest,
} from "@mons/shared/match-presentation";
import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_SOCKET_PROTOCOL,
  isInviteRoomMessage,
} from "@mons/shared/reactions";
import {
  applyD1Migrations,
  evictDurableObject,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import {
  buildMatchPresentationRegistrationStatements,
  prepareCreatedMatchPresentations,
} from "../src/matchPresentationRegistry.ts";
import { handleRequest } from "../src/router.ts";
import { gameplayTestPort } from "../test/gameSessionTestPorts.ts";
import { socketTestIdentity } from "../test/socketTestSession.ts";
import { activateDurableMatchPresentationTestState } from "./matchPresentationTestFixture.ts";
import {
  readStoredPresentations,
  registerTestPresentations,
  reactionSocketTestHeaders,
} from "./presentationStorageFixture.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

beforeAll(async () => {
  const testEnv = env as Env & {
    TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
    TEST_D1_MIGRATIONS: D1Migration[];
  };
  await applyD1Migrations(env.PROFILE_GAMES_DB, testEnv.TEST_D1_MIGRATIONS);
  await env.PROFILE_GAMES_DB.batch([
    env.PROFILE_GAMES_DB.prepare(
      "UPDATE automatch_runtime_control SET backend = 'd1' WHERE singleton = 1",
    ),
    env.PROFILE_GAMES_DB.prepare(
      "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, verified_at_ms = 2, activated_at_ms = 3 WHERE singleton = 1",
    ),
  ]);
  await activateDurableMatchPresentationTestState(env.PROFILE_GAMES_DB);
  await applyRetiredProfileMigrations(
    env.PROFILE_DB,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
});

const sockets: WebSocket[] = [];
let matchId = "invite-one";
beforeEach(() => {
  matchId = `presentation-${crypto.randomUUID()}`;
});
const seeds = {
  "host-login": { emojiId: 1, aura: "" },
  "guest-login": { emojiId: 1000, aura: "rainbow" },
};
const update = (
  overrides: Partial<UpdateMatchPresentationRequest> = {},
): UpdateMatchPresentationRequest => ({
  operationId: crypto.randomUUID(),
  expectedRevision: 0,
  emojiId: 1001,
  aura: "rainbow",
  ...overrides,
});
const room = () => env.INVITE_REACTIONS.get(env.INVITE_REACTIONS.newUniqueId());

async function registeredRepository(
  inviteId: string,
  actorSeeds: Record<string, { emojiId: number; aura: string }>,
) {
  const actors = Object.keys(actorSeeds);
  const registrations = await prepareCreatedMatchPresentations(
    env,
    actors.map((actorUid) => ({
      inviteId,
      matchId: inviteId,
      actorUid,
      ...actorSeeds[actorUid],
      sourceId: "test:router-creation",
    })),
  );
  await env.PROFILE_GAMES_DB.batch([
    ...buildMatchPresentationRegistrationStatements(
      env.PROFILE_GAMES_DB,
      registrations,
      1,
    ),
    env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms) VALUES (?, ?, 1, 1)",
    ).bind(inviteId, JSON.stringify({ hostId: actors[0], guestId: actors[1] })),
  ]);
  return createGameplayRepository(env, {
    stateClient: gameplayTestPort({
      getPath: async () => {
        throw new Error("unexpected-source-read");
      },
      patchRoot: async () => {
        throw new Error("unexpected-source-write");
      },
      transactPath: async () => {
        throw new Error("unexpected-source-write");
      },
    }),
  });
}

function acceptSocket(response: Response) {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  const readers: ((value: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const value = String(event.data);
    const reader = readers.shift();
    if (reader) reader(value);
    else messages.push(value);
  });
  socket.accept();
  sockets.push(socket);
  return {
    socket,
    messages,
    read: () =>
      messages.length
        ? Promise.resolve(messages.shift()!)
        : new Promise<string>((resolve) => readers.push(resolve)),
  };
}

async function connect(
  stub: ReturnType<typeof room>,
  selectedMatchId = matchId,
) {
  return acceptSocket(
    await stub.fetch("https://reactions.internal/socket", {
      headers: {
        Upgrade: "websocket",
        "X-Mons-Reaction-IP": crypto.randomUUID(),
        ...(await reactionSocketTestHeaders(stub, matchId, selectedMatchId)),
      },
    }),
  );
}

afterEach(async () => {
  await Promise.all(
    sockets.splice(0).map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const onClose = () => resolve();
        socket.addEventListener("close", onClose, { once: true });
        socket.close(1000, "Test complete");
        if (socket.readyState === WebSocket.CLOSED) {
          socket.removeEventListener("close", onClose);
          resolve();
        }
      });
    }),
  );
});

describe("durable match presentation", () => {
  const invalidPresentationAdmissions: Record<string, string>[] = [
    {},
    { "X-Mons-Presentation-Canonical": "0" },
    { "X-Mons-Presentation-Canonical": "1" },
    { "X-Mons-Presentation-Canonical": "1", "X-Mons-Presentation-Actors": "%" },
    {
      "X-Mons-Presentation-Canonical": "1",
      "X-Mons-Presentation-Actors": "[]",
    },
  ];
  it.each(invalidPresentationAdmissions)(
    "requires canonical presentation admission for every current socket %j",
    async (headers) => {
      const response = await room().fetch("https://reactions.internal/socket", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL,
          "X-Mons-Presentation-Match": matchId,
          ...headers,
        },
      });
      expect(response.status).toBe(400);
    },
  );

  it("registers immutable seeds once, enforces two actors and persists after eviction", async () => {
    const stub = room();
    const first = await registerTestPresentations(
      stub,
      matchId,
      matchId,
      seeds,
    );
    expect(isMatchPresentationSnapshot(first)).toBe(true);
    expect(
      await registerTestPresentations(stub, matchId, matchId, seeds),
    ).toEqual(first);
    await runInDurableObject(stub, async (instance) => {
      await expect(
        registerTestPresentations(instance, matchId, matchId, {
          "host-login": { emojiId: 2, aura: "" },
        }),
      ).rejects.toThrow();
      await expect(
        registerTestPresentations(instance, matchId, matchId, {
          "third-login": { emojiId: 2, aura: "" },
        }),
      ).rejects.toThrow();
      await expect(
        registerTestPresentations(instance, matchId, matchId, {
          "invalid/uid": { emojiId: 2, aura: "" },
        }),
      ).rejects.toThrow();
    });
    await evictDurableObject(stub);
    expect(await readStoredPresentations(stub, matchId)).toEqual(first);
  });

  it("commits CAS operations once and rejects modified or stale operation retries", async () => {
    const stub = room();
    await registerTestPresentations(stub, matchId, matchId, seeds);
    const request = update();
    const first = await stub.updatePresentation("host-login", matchId, request);
    expect(first.status).toBe("updated");
    expect(first.presentation.revision).toBe(1);
    expect(
      await stub.updatePresentation("host-login", matchId, request),
    ).toEqual({ ...first, status: "duplicate" });
    expect(
      await stub.updatePresentation("host-login", matchId, {
        ...request,
        aura: "",
      }),
    ).toEqual({ ...first, status: "conflict" });
    expect(
      await stub.updatePresentation("host-login", matchId, update()),
    ).toEqual({ ...first, status: "conflict" });
    const second = await stub.updatePresentation(
      "host-login",
      matchId,
      update({ expectedRevision: 1, aura: "" }),
    );
    expect(second.presentation.aura).toBe("");
    expect(second.presentation.revision).toBe(2);
    expect(
      await stub.updatePresentation("host-login", matchId, request),
    ).toEqual({ ...second, status: "conflict" });
    await evictDurableObject(stub);
    expect(
      (await readStoredPresentations(stub, matchId)).players["host-login"],
    ).toEqual(second.presentation);
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.updatePresentation(
          "host-login",
          matchId,
          update({ emojiId: 0 }),
        ),
      ).rejects.toThrow("invalid-presentation-update");
    });
  });

  it("serializes competing writes and keeps rematches independent", async () => {
    const stub = room();
    await registerTestPresentations(stub, matchId, matchId, seeds);
    await registerTestPresentations(stub, matchId, `${matchId}1`, seeds);
    const results = await Promise.all([
      stub.updatePresentation("host-login", matchId, update()),
      stub.updatePresentation("host-login", matchId, update({ emojiId: 1002 })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "conflict",
      "updated",
    ]);
    expect(results[0].presentation).toEqual(results[1].presentation);
    expect(
      (await readStoredPresentations(stub, `${matchId}1`)).players["host-login"]
        .revision,
    ).toBe(0);
    expect(
      (await readStoredPresentations(stub, matchId)).players["guest-login"]
        .revision,
    ).toBe(0);
  });

  it("freezes each archived actor once while live finished-match appearance can continue", async () => {
    const stub = room();
    await registerTestPresentations(stub, matchId, matchId, seeds);
    const first = await stub.updatePresentation(
      "host-login",
      matchId,
      update(),
    );
    const frozen = await stub.freezeRegisteredPresentations(
      matchId,
      Object.keys({
        "host-login": seeds["host-login"],
      }),
    );
    expect(frozen.players["host-login"]).toEqual(first.presentation);
    expect(Object.keys(frozen.players)).toEqual(["host-login"]);
    const latest = await stub.updatePresentation(
      "host-login",
      matchId,
      update({ expectedRevision: 1, aura: "" }),
    );
    const guest = await stub.updatePresentation(
      "guest-login",
      matchId,
      update({ emojiId: 1002 }),
    );
    const completed = await stub.freezeRegisteredPresentations(
      matchId,
      Object.keys(seeds),
    );
    expect(completed.players).toEqual({
      "host-login": first.presentation,
      "guest-login": guest.presentation,
    });
    await evictDurableObject(stub);
    expect(
      await stub.freezeRegisteredPresentations(matchId, Object.keys(seeds)),
    ).toEqual(completed);
    expect(
      (await readStoredPresentations(stub, matchId)).players["host-login"],
    ).toEqual(latest.presentation);
  });

  it("sends current initial state and appearance only to matching sockets and keeps reactions and heartbeat", async () => {
    const stub = room();
    const snapshot = await registerTestPresentations(
      stub,
      matchId,
      matchId,
      seeds,
    );
    await registerTestPresentations(stub, matchId, `${matchId}1`, seeds);
    const [current, other] = await Promise.all([
      connect(stub),
      connect(stub, `${matchId}1`),
    ]);
    const initial = JSON.parse(await current.read());
    expect(initial).toEqual({
      schemaVersion: 2,
      type: "snapshot",
      reactions: {},
      presentation: snapshot,
    });
    expect(isInviteRoomMessage(initial)).toBe(true);
    await other.read();
    await evictDurableObject(stub);
    const result = await stub.updatePresentation(
      "host-login",
      matchId,
      update(),
    );
    expect(JSON.parse(await current.read())).toEqual({
      schemaVersion: 2,
      type: "presentation",
      presentation: result.presentation,
    });
    const reaction = {
      uuid: crypto.randomUUID(),
      kind: "yo",
      variation: 1,
      matchId,
    };
    await stub.publish("host-login", reaction);
    for (const client of [current, other])
      expect(JSON.parse(await client.read())).toEqual({
        schemaVersion: 2,
        type: "reaction",
        senderUid: "host-login",
        reaction,
      });
    expect(other.messages).toEqual([]);
    current.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await current.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    const reconnect = await connect(stub);
    expect(
      JSON.parse(await reconnect.read()).presentation.players["host-login"],
    ).toEqual(result.presentation);
  });

  it.each([null, { schemaVersion: 1, authenticated: false }])(
    "closes retired hibernated reaction attachments %j without changing stored reactions",
    async (attachment) => {
      const stub = room();
      const client = await connect(stub);
      await client.read();
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        client.socket.addEventListener(
          "close",
          (event) => resolve({ code: event.code, reason: event.reason }),
          { once: true },
        ),
      );
      await runInDurableObject(stub, (_instance, state) => {
        for (const socket of state.getWebSockets())
          socket.serializeAttachment(attachment);
      });
      await evictDurableObject(stub);
      const reaction = {
        uuid: crypto.randomUUID(),
        kind: "gg",
        variation: 2,
        matchId,
      };
      await stub.publish("host-login", reaction);
      expect(await closed).toEqual({
        code: 1008,
        reason: "Unsupported reaction protocol",
      });
      const current = await connect(stub);
      expect(JSON.parse(await current.read()).reactions).toEqual({
        "host-login": reaction,
      });
    },
  );

  it("preserves hibernated v2 reactions without a channel marker", async () => {
    const stub = room();
    const client = await connect(stub);
    await client.read();
    await runInDurableObject(stub, (_instance, state) => {
      for (const socket of state.getWebSockets()) {
        const attachment = socket.deserializeAttachment();
        delete attachment.channel;
        socket.serializeAttachment(attachment);
      }
    });
    await evictDurableObject(stub);
    client.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await client.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    const reaction = {
      uuid: crypto.randomUUID(),
      kind: "gg",
      variation: 2,
      matchId,
    };
    await stub.publish("host-login", reaction);
    expect(JSON.parse(await client.read())).toMatchObject({
      schemaVersion: 2,
      reaction,
    });
  });

  it("integrates participant updates and anonymous v2 hydration through the public router", async () => {
    const inviteId = `route-${crypto.randomUUID()}`;
    const repository = await registeredRepository(inviteId, seeds);
    const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
    const dependencies = {
      repository,
      verifyIdentity: async () => socketTestIdentity("host-login"),
    };
    const socketRequest = (authenticated: boolean) =>
      new Request(
        `https://api.mons.link/invites/${inviteId}/reactions/socket?matchId=${inviteId}`,
        {
          headers: {
            Origin: "https://mons.link",
            "CF-Connecting-IP": crypto.randomUUID(),
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": authenticated
              ? `${REACTION_SOCKET_PROTOCOL}, ${REACTION_AUTH_PROTOCOL_PREFIX}host-login.payload.signature`
              : REACTION_SOCKET_PROTOCOL,
          },
        },
      );
    const response = await handleRequest(
      socketRequest(true),
      env,
      { reactions: dependencies },
      ctx,
    );
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
      REACTION_SOCKET_PROTOCOL,
    );
    const host = acceptSocket(response);
    const spectator = acceptSocket(
      await handleRequest(
        socketRequest(false),
        env,
        { reactions: dependencies },
        ctx,
      ),
    );
    for (const client of [host, spectator])
      expect(
        Object.keys(JSON.parse(await client.read()).presentation.players),
      ).toEqual(["guest-login", "host-login"]);
    const written = await handleRequest(
      new Request(
        `https://api.mons.link/invites/${inviteId}/matches/${inviteId}/presentation`,
        {
          method: "POST",
          headers: {
            Origin: "https://mons.link",
            Authorization: "Bearer host-login",
            "CF-Connecting-IP": crypto.randomUUID(),
          },
          body: JSON.stringify(update()),
        },
      ),
      env,
      { presentation: dependencies },
      ctx,
    );
    expect(written.status).toBe(200);
    const body = await written.json<{ presentation: unknown }>();
    for (const client of [host, spectator])
      expect(JSON.parse(await client.read()).presentation).toEqual(
        body.presentation,
      );
    const read = await handleRequest(
      new Request(
        `https://api.mons.link/invites/${inviteId}/matches/${inviteId}/presentation`,
      ),
      env,
      { presentation: dependencies },
      ctx,
    );
    expect(
      (
        await read.json<{
          presentation: { players: Record<string, unknown> };
        }>()
      ).presentation.players["host-login"],
    ).toEqual(body.presentation);
  });

  it("hydrates maximal escaped and Unicode legacy match keys through v2 routing", async () => {
    for (const inviteId of ['"\\'.repeat(384), "🫠".repeat(192)]) {
      const actors = ['"\\'.repeat(63) + "a", '"\\'.repeat(63) + "b"];
      const repository = await registeredRepository(
        inviteId,
        Object.fromEntries(
          actors.map((actorUid) => [
            actorUid,
            { emojiId: 1, aura: '"\\'.repeat(16) },
          ]),
        ),
      );
      const stub = env.INVITE_REACTIONS.getByName(inviteId);
      for (const actorUid of actors)
        await stub.publish(actorUid, {
          uuid: crypto.randomUUID(),
          kind: "yo",
          variation: 1,
          matchId: inviteId,
        });
      const response = await handleRequest(
        new Request(
          `https://api.mons.link/invites/${encodeURIComponent(inviteId)}/reactions/socket?matchId=${encodeURIComponent(inviteId)}`,
          {
            headers: {
              Origin: "https://mons.link",
              "CF-Connecting-IP": crypto.randomUUID(),
              Upgrade: "websocket",
              "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL,
            },
          },
        ),
        env,
        { reactions: { repository } },
        { waitUntil: (_promise) => undefined },
      );
      const socket = acceptSocket(response);
      const message = await socket.read();
      const bytes = new TextEncoder().encode(message).byteLength;
      expect(bytes).toBeGreaterThan(4096);
      expect(bytes).toBeLessThanOrEqual(PRESENTATION_MAX_MESSAGE_BYTES);
      expect(isInviteRoomMessage(JSON.parse(message))).toBe(true);
      expect(JSON.parse(message).presentation.matchId).toBe(inviteId);
    }
  });
});
