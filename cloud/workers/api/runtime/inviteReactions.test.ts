import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_SOCKET_PROTOCOL,
  REACTION_AUTH_PROTOCOL_PREFIX,
  isInviteReactionMessage,
  type InviteReaction,
} from "@mons/shared/reactions";
import {
  MAX_INVITE_REACTION_SOCKETS,
  MAX_INVITE_REACTION_SPECTATORS,
  MAX_INVITE_REACTION_SPECTATORS_PER_IP,
  MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT,
} from "../src/inviteReactions.ts";
import { AuthApiFailure } from "../src/authErrors.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { handleRequest } from "../src/router.ts";

const sockets: WebSocket[] = [];

function room() {
  return env.INVITE_REACTIONS.getByName(`runtime-${crypto.randomUUID()}`);
}

function reaction(overrides: Partial<InviteReaction> = {}): InviteReaction {
  return {
    uuid: crypto.randomUUID(),
    kind: "yo",
    variation: 1,
    matchId: "invite-one",
    ...overrides,
  };
}

async function connect(
  stub: ReturnType<typeof room>,
  headers: Record<string, string> = {},
) {
  const response = await stub.fetch("https://reactions.internal/socket", {
    headers: { Upgrade: "websocket", ...headers },
  });
  return acceptSocket(response);
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

describe("invite reaction rooms", () => {
  it("routes authenticated participant posts to real room sockets and reconnect snapshots", async () => {
    const inviteId = `integration-${crypto.randomUUID()}`;
    const otherInviteId = `integration-${crypto.randomUUID()}`;
    const repository = createGameplayRepository(env, {
      rtdbClient: {
        getPath: async (path) =>
          path === `invites/${inviteId}` || path === `invites/${otherInviteId}`
            ? { hostId: "host-login", guestId: "guest-login" }
            : null,
        patchRoot: async () => {
          throw new Error("unexpected-firebase-write");
        },
        transactPath: async () => {
          throw new Error("unexpected-firebase-write");
        },
      },
    });
    repository.readProfileOwnershipSnapshot = async (query) => ({
      canonicalProfileIdByProfileId: new Map(),
      loginOwnerByUid: new Map(query.loginUids.map((uid) => [uid, null])),
      loginUidsByProfileId: new Map(),
      profileById: new Map(),
    });
    const route = (id: string, uid?: string, payload?: InviteReaction) => {
      const request = new Request(
        `https://api.mons.link/invites/${id}/reactions${payload ? "" : "/socket"}`,
        {
          method: payload ? "POST" : "GET",
          headers: {
            Origin: "https://mons.link",
            "CF-Connecting-IP": "198.51.100.18",
            ...(payload
              ? {
                  Authorization: `Bearer ${uid}`,
                  "Content-Type": "application/json",
                }
              : {
                  Upgrade: "websocket",
                  ...(uid
                    ? {
                        "Sec-WebSocket-Protocol": `${REACTION_SOCKET_PROTOCOL}, ${REACTION_AUTH_PROTOCOL_PREFIX}${uid}.payload.signature`,
                      }
                    : {}),
                }),
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        },
      );
      return handleRequest(
        request,
        env,
        {
          reactions: {
            repository,
            verifyIdentity: async (incoming) => {
              const uid = incoming.headers
                .get("Authorization")
                ?.match(
                  /^Bearer (host-login|guest-login|spectator)(?:\.payload\.signature)?$/,
                )?.[1];
              if (!uid)
                throw new AuthApiFailure(
                  401,
                  "unauthenticated",
                  "authentication-required",
                );
              return { uid };
            },
          },
        },
        { waitUntil: (_promise) => undefined },
      );
    };
    const [host, guest, spectator, other] = await Promise.all([
      route(inviteId, "host-login").then((response) => {
        expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
          REACTION_SOCKET_PROTOCOL,
        );
        return acceptSocket(response);
      }),
      route(inviteId, "guest-login").then(acceptSocket),
      route(inviteId).then(acceptSocket),
      route(otherInviteId).then(acceptSocket),
    ]);
    for (const client of [host, guest, spectator, other]) {
      expect(JSON.parse(await client.read())).toEqual({
        schemaVersion: 1,
        type: "snapshot",
        reactions: {},
      });
    }
    const voice = reaction({ matchId: inviteId });
    const voiceResponse = await route(inviteId, "host-login", voice);
    expect(voiceResponse.status).toBe(200);
    expect(await voiceResponse.json()).toEqual({ ok: true });
    for (const client of [host, guest, spectator]) {
      expect(JSON.parse(await client.read())).toEqual({
        schemaVersion: 1,
        type: "reaction",
        senderUid: "host-login",
        reaction: voice,
      });
    }
    expect(
      (await route(inviteId, "spectator", reaction({ matchId: inviteId })))
        .status,
    ).toBe(403);
    const sticker = reaction({
      matchId: inviteId,
      kind: "sticker",
      variation: 900316,
    });
    expect((await route(inviteId, "guest-login", sticker)).status).toBe(200);
    for (const client of [host, guest, spectator]) {
      expect(JSON.parse(await client.read())).toEqual({
        schemaVersion: 1,
        type: "reaction",
        senderUid: "guest-login",
        reaction: sticker,
      });
    }
    const otherVoice = reaction({ matchId: otherInviteId });
    expect((await route(otherInviteId, "host-login", otherVoice)).status).toBe(
      200,
    );
    expect(JSON.parse(await other.read()).reaction).toEqual(otherVoice);
    spectator.socket.close(1000, "Reconnect");
    const reconnected = acceptSocket(await route(inviteId));
    expect(JSON.parse(await reconnected.read())).toEqual({
      schemaVersion: 1,
      type: "snapshot",
      reactions: { "host-login": voice, "guest-login": sticker },
    });
  });

  it("sends a baseline, then broadcasts live events and keeps only the latest per sender", async () => {
    const stub = room();
    const first = reaction();
    await stub.publish("host-login", first);
    const client = await connect(stub);
    const snapshot = JSON.parse(await client.read());
    expect(snapshot).toEqual({
      schemaVersion: 1,
      type: "snapshot",
      reactions: { "host-login": first },
    });
    expect(isInviteReactionMessage(snapshot)).toBe(true);
    const guest = reaction({ kind: "gg", variation: 2 });
    expect(await stub.publish("guest-login", guest)).toBe("published");
    expect(JSON.parse(await client.read())).toEqual({
      schemaVersion: 1,
      type: "reaction",
      senderUid: "guest-login",
      reaction: guest,
    });
    const latest = reaction({
      kind: "sticker",
      variation: 900316,
      matchId: "invite-one1",
    });
    await stub.publish("host-login", latest);
    expect(JSON.parse(await client.read()).reaction).toEqual(latest);
    const reconnected = await connect(stub);
    expect(JSON.parse(await reconnected.read()).reactions).toEqual({
      "host-login": latest,
      "guest-login": guest,
    });
    expect(await stub.publish("third-login", reaction())).toBe(
      "participant-limit",
    );
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM latest_reactions",
            )
            .one().count,
      ),
    ).toBe(2);
  });

  it("deduplicates only the current UUID and rejects conflicting content without broadcasting", async () => {
    const stub = room();
    const client = await connect(stub);
    await client.read();
    const first = reaction();
    await stub.publish("host-login", first);
    await client.read();
    expect(await stub.publish("host-login", first)).toBe("duplicate");
    expect(await stub.publish("host-login", { ...first, variation: 2 })).toBe(
      "conflict",
    );
    const second = reaction();
    await stub.publish("host-login", second);
    expect(JSON.parse(await client.read()).reaction).toEqual(second);
    expect(await stub.publish("host-login", first)).toBe("published");
    expect(JSON.parse(await client.read()).reaction).toEqual(first);
  });

  it("registers snapshots and publication without a missed event or duplicate replay", async () => {
    const stub = room();
    const first = reaction();
    const [client] = await Promise.all([
      connect(stub),
      stub.publish("host-login", first),
    ]);
    const snapshot = JSON.parse(await client.read());
    expect(snapshot.type).toBe("snapshot");
    if (!snapshot.reactions["host-login"]) {
      expect(JSON.parse(await client.read()).reaction).toEqual(first);
    } else {
      expect(snapshot.reactions["host-login"]).toEqual(first);
    }
    const next = reaction();
    await stub.publish("host-login", next);
    expect(JSON.parse(await client.read()).reaction).toEqual(next);
  });

  it("persists the baseline and resumes broadcasting to hibernated sockets", async () => {
    const stub = room();
    const client = await connect(stub);
    await client.read();
    const first = reaction();
    await stub.publish("host-login", first);
    await client.read();
    await evictDurableObject(stub);
    const second = reaction();
    await stub.publish("guest-login", second);
    expect(JSON.parse(await client.read()).reaction).toEqual(second);
    const afterEviction = await connect(stub);
    expect(JSON.parse(await afterEviction.read()).reactions).toEqual({
      "host-login": first,
      "guest-login": second,
    });
  });

  it("answers heartbeats automatically and rejects client publication frames", async () => {
    const stub = room();
    const client = await connect(stub);
    await client.read();
    await evictDurableObject(stub);
    client.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await client.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    const closed = new Promise<number>((resolve) =>
      client.socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    client.socket.send(JSON.stringify(reaction()));
    expect(await closed).toBe(1008);
    const fresh = await connect(stub);
    expect(JSON.parse(await fresh.read()).reactions).toEqual({});
  });

  it("isolates invite rooms", async () => {
    const first = room();
    const second = room();
    await first.publish("host-login", reaction());
    const other = await connect(second);
    expect(JSON.parse(await other.read()).reactions).toEqual({});
  });

  it("reserves four sockets for each participant after spectator capacity is exhausted", async () => {
    const stub = room();
    expect((await stub.fetch("https://reactions.internal/socket")).status).toBe(
      426,
    );
    const connected = await Promise.all(
      Array.from({ length: MAX_INVITE_REACTION_SPECTATORS }, (_, index) =>
        connect(stub, {
          "X-Mons-Reaction-Role": "spectator",
          "X-Mons-Reaction-IP": `192.0.2.${Math.floor(index / MAX_INVITE_REACTION_SPECTATORS_PER_IP)}`,
        }),
      ),
    );
    await Promise.all(connected.map((client) => client.read()));
    const response = await stub.fetch("https://reactions.internal/socket", {
      headers: { Upgrade: "websocket", "X-Mons-Reaction-IP": "198.51.100.1" },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const participants = await Promise.all(
      ["host", "guest"].flatMap((role) =>
        Array.from(
          { length: MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT },
          () => connect(stub, { "X-Mons-Reaction-Role": role }),
        ),
      ),
    );
    await Promise.all(participants.map((client) => client.read()));
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) => state.getWebSockets().length,
      ),
    ).toBe(MAX_INVITE_REACTION_SOCKETS);
  });

  it("keeps closing spectators within their concurrency budget", async () => {
    const stub = room();
    const connected = await Promise.all(
      Array.from({ length: MAX_INVITE_REACTION_SPECTATORS_PER_IP }, () =>
        connect(stub, { "X-Mons-Reaction-IP": "192.0.2.1" }),
      ),
    );
    await Promise.all(connected.map((client) => client.read()));
    const result = await runInDurableObject(stub, async (instance, state) => {
      const spectators = state.getWebSockets("spectator-ip:192.0.2.1");
      for (const socket of spectators) socket.close(1000, "Close pending");
      const closing = spectators.every((socket) => socket.readyState === 2);
      const response = await instance.fetch(
        new Request("https://reactions.internal/socket", {
          headers: { Upgrade: "websocket", "X-Mons-Reaction-IP": "192.0.2.1" },
        }),
      );
      return { closing, status: response.status };
    });
    expect(result).toEqual({ closing: true, status: 429 });
  });

  it("enforces per-IP and participant limits across hibernation and frees slots after close", async () => {
    const stub = room();
    const spectatorHeaders = {
      "X-Mons-Reaction-Role": "spectator",
      "X-Mons-Reaction-IP": "192.0.2.1",
    };
    const spectators = await Promise.all(
      Array.from({ length: MAX_INVITE_REACTION_SPECTATORS_PER_IP }, () =>
        connect(stub, spectatorHeaders),
      ),
    );
    const hostHeaders = { "X-Mons-Reaction-Role": "host" };
    const guestHeaders = { "X-Mons-Reaction-Role": "guest" };
    const hosts = await Promise.all(
      Array.from({ length: MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT }, () =>
        connect(stub, hostHeaders),
      ),
    );
    const guests = await Promise.all(
      Array.from({ length: MAX_INVITE_REACTION_SOCKETS_PER_PARTICIPANT }, () =>
        connect(stub, guestHeaders),
      ),
    );
    await Promise.all(
      [...spectators, ...hosts, ...guests].map((client) => client.read()),
    );
    const expectFull = async (headers: Record<string, string>) => {
      const response = await stub.fetch("https://reactions.internal/socket", {
        headers: { Upgrade: "websocket", ...headers },
      });
      expect(response.status).toBe(429);
      await response.text();
    };
    const counts = () =>
      runInDurableObject(stub, (_instance, state) => ({
        spectators: state.getWebSockets("role:spectator").length,
        sameIp: state.getWebSockets("spectator-ip:192.0.2.1").length,
        host: state.getWebSockets("role:host").length,
        guest: state.getWebSockets("role:guest").length,
      }));
    for (const headers of [spectatorHeaders, hostHeaders, guestHeaders]) {
      await expectFull(headers);
    }
    await evictDurableObject(stub);
    expect(await counts()).toEqual({
      spectators: 8,
      sameIp: 8,
      host: 4,
      guest: 4,
    });
    for (const headers of [spectatorHeaders, hostHeaders, guestHeaders]) {
      await expectFull(headers);
    }
    await Promise.all(
      [spectators[0], hosts[0], guests[0]].map(
        ({ socket }) =>
          new Promise<void>((resolve) => {
            socket.addEventListener("close", () => resolve(), { once: true });
            socket.close(1000, "Free capacity");
          }),
      ),
    );
    for (const { socket } of [spectators[0], hosts[0], guests[0]]) {
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    }
    expect(await counts()).toEqual({
      spectators: 7,
      sameIp: 7,
      host: 3,
      guest: 3,
    });
    for (const headers of [spectatorHeaders, hostHeaders, guestHeaders]) {
      const replacement = await connect(stub, headers);
      expect(JSON.parse(await replacement.read()).type).toBe("snapshot");
      await expectFull(headers);
    }
  });
});
