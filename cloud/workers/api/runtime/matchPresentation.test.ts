import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_SOCKET_PROTOCOL,
  REACTION_SOCKET_PROTOCOL_V2,
  isInviteRoomMessage,
} from "@mons/shared/reactions";
import {
  PRESENTATION_MAX_MESSAGE_BYTES,
  isMatchPresentationSnapshot,
  type UpdateMatchPresentationRequest,
} from "@mons/shared/match-presentation";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { handleRequest } from "../src/router.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

beforeAll(async () => {
  const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
  await applyRetiredProfileMigrations(
    env.PROFILE_DB,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
});

const sockets: WebSocket[] = [];
const matchId = "invite-one";
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
const room = () =>
  env.INVITE_REACTIONS.getByName(`presentation-${crypto.randomUUID()}`);

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
  version = 2,
  selectedMatchId = matchId,
) {
  return acceptSocket(
    await stub.fetch("https://reactions.internal/socket", {
      headers: {
        Upgrade: "websocket",
        "X-Mons-Reaction-IP": crypto.randomUUID(),
        "Sec-WebSocket-Protocol":
          version === 2
            ? REACTION_SOCKET_PROTOCOL_V2
            : REACTION_SOCKET_PROTOCOL,
        ...(version === 2
          ? { "X-Mons-Presentation-Match": encodeURIComponent(selectedMatchId) }
          : {}),
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
  it("seeds once, enforces two canonical actors and persists after eviction", async () => {
    const stub = room();
    const first = await stub.ensurePresentations(matchId, seeds);
    expect(isMatchPresentationSnapshot(first)).toBe(true);
    expect(first.players["host-login"]).toEqual({
      matchId,
      actorUid: "host-login",
      ...seeds["host-login"],
      revision: 0,
    });
    expect(
      await stub.ensurePresentations(matchId, {
        "host-login": { emojiId: -55, aura: "legacy" },
      }),
    ).toEqual(first);
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.ensurePresentations(matchId, {
          "third-login": { emojiId: 2, aura: "" },
        }),
      ).rejects.toThrow("presentation-participant-limit");
      await expect(
        instance.ensurePresentations(matchId, {
          "invalid/uid": { emojiId: 2, aura: "" },
        }),
      ).rejects.toThrow("invalid-presentation-seeds");
    });
    await evictDurableObject(stub);
    expect(await stub.getPresentationSnapshot(matchId)).toEqual(first);
  });

  it("commits CAS operations once and rejects modified or stale operation retries", async () => {
    const stub = room();
    await stub.ensurePresentations(matchId, seeds);
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
      (await stub.getPresentationSnapshot(matchId)).players["host-login"],
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
    await stub.ensurePresentations(matchId, seeds);
    await stub.ensurePresentations(`${matchId}1`, seeds);
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
      (await stub.getPresentationSnapshot(`${matchId}1`)).players["host-login"]
        .revision,
    ).toBe(0);
    expect(
      (await stub.getPresentationSnapshot(matchId)).players["guest-login"]
        .revision,
    ).toBe(0);
  });

  it("freezes each archived actor once while live finished-match appearance can continue", async () => {
    const stub = room();
    await stub.ensurePresentations(matchId, seeds);
    const first = await stub.updatePresentation(
      "host-login",
      matchId,
      update(),
    );
    const frozen = await stub.freezePresentations(matchId, {
      "host-login": seeds["host-login"],
    });
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
    const completed = await stub.freezePresentations(matchId, seeds);
    expect(completed.players).toEqual({
      "host-login": first.presentation,
      "guest-login": guest.presentation,
    });
    await evictDurableObject(stub);
    expect(await stub.freezePresentations(matchId, seeds)).toEqual(completed);
    expect(
      (await stub.getPresentationSnapshot(matchId)).players["host-login"],
    ).toEqual(latest.presentation);
  });

  it("sends v2 initial state and appearance only to matching sockets, preserving v1 reactions and heartbeat", async () => {
    const stub = room();
    const snapshot = await stub.ensurePresentations(matchId, seeds);
    await stub.ensurePresentations(`${matchId}1`, seeds);
    const [legacy, current, other] = await Promise.all([
      connect(stub, 1),
      connect(stub),
      connect(stub, 2, `${matchId}1`),
    ]);
    expect(JSON.parse(await legacy.read())).toEqual({
      schemaVersion: 1,
      type: "snapshot",
      reactions: {},
    });
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
    expect(JSON.parse(await legacy.read())).toEqual({
      schemaVersion: 1,
      type: "reaction",
      senderUid: "host-login",
      reaction,
    });
    for (const client of [current, other])
      expect(JSON.parse(await client.read())).toEqual({
        schemaVersion: 2,
        type: "reaction",
        senderUid: "host-login",
        reaction,
      });
    expect(legacy.messages).toEqual([]);
    expect(other.messages).toEqual([]);
    current.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await current.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    const reconnect = await connect(stub);
    expect(
      JSON.parse(await reconnect.read()).presentation.players["host-login"],
    ).toEqual(result.presentation);
  });

  it("treats old hibernated sockets without attachments as v1", async () => {
    const stub = room();
    const legacy = await connect(stub, 1);
    await legacy.read();
    await runInDurableObject(stub, (_instance, state) => {
      for (const socket of state.getWebSockets())
        socket.serializeAttachment(null);
    });
    await evictDurableObject(stub);
    const reaction = {
      uuid: crypto.randomUUID(),
      kind: "gg",
      variation: 2,
      matchId,
    };
    await stub.publish("host-login", reaction);
    expect(JSON.parse(await legacy.read()).schemaVersion).toBe(1);
  });

  it("integrates participant updates and anonymous v2 hydration through the public router", async () => {
    const inviteId = `route-${crypto.randomUUID()}`;
    const repository = createGameplayRepository(env, {
      rtdbClient: {
        getPath: async (path) =>
          path === `invites/${inviteId}`
            ? { hostId: "host-login", guestId: "guest-login" }
            : path.startsWith("players/")
              ? {
                  color: path.includes("host-login") ? "white" : "black",
                  emojiId: 1,
                  aura: "",
                  fen: "position",
                }
              : null,
        patchRoot: async () => {
          throw new Error("unexpected-firebase-write");
        },
        transactPath: async () => {
          throw new Error("unexpected-firebase-write");
        },
      },
    });
    const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
    const dependencies = {
      repository,
      verifyIdentity: async () => ({ uid: "host-login" }),
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
              ? `${REACTION_SOCKET_PROTOCOL_V2}, ${REACTION_AUTH_PROTOCOL_PREFIX}host-login.payload.signature`
              : REACTION_SOCKET_PROTOCOL_V2,
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
      REACTION_SOCKET_PROTOCOL_V2,
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
      const repository = createGameplayRepository(env, {
        rtdbClient: {
          getPath: async (path) =>
            path === `invites/${inviteId}`
              ? { hostId: actors[0], guestId: actors[1] }
              : {
                  color: "white",
                  emojiId: 1,
                  aura: '"\\'.repeat(16),
                  fen: "position",
                },
          patchRoot: async () => {
            throw new Error("unexpected-firebase-write");
          },
          transactPath: async () => {
            throw new Error("unexpected-firebase-write");
          },
        },
      });
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
              "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL_V2,
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
