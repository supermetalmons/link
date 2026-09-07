import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INVITE_METADATA_REFRESH_MS,
  INVITE_METADATA_SOCKET_PROTOCOL,
  isInviteMetadataMessage,
} from "@mons/shared/invite-metadata";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_SOCKET_PROTOCOL,
} from "@mons/shared/reactions";

type Room = DurableObjectStub<
  import("../src/inviteReactions.ts").InviteReactions
>;
type Source = {
  value: unknown;
  reads: number;
  read?: () => Promise<unknown>;
};

const rooms: Room[] = [];
const sockets: WebSocket[] = [];
const invite = {
  hostId: "host-login",
  hostColor: "white",
  guestId: "guest-login",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function installSource(room: Room, source: Source) {
  await runInDurableObject(room, (instance) => {
    const target = instance as unknown as {
      inviteReader: (inviteId: string) => Promise<unknown>;
    };
    target.inviteReader = async () => {
      source.reads++;
      return source.read ? await source.read() : source.value;
    };
  });
}

async function fixture(value: unknown = invite) {
  const inviteId = `metadata-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  const source: Source = { value, reads: 0 };
  rooms.push(room);
  await installSource(room, source);
  return { inviteId, room, source };
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

function metadataRequest(
  inviteId: string,
  overrides: Record<string, string> = {},
) {
  return new Request("https://room.internal/metadata/socket", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": INVITE_METADATA_SOCKET_PROTOCOL,
      "X-Mons-Metadata-Invite": encodeURIComponent(inviteId),
      "X-Mons-Metadata-Role": "spectator",
      "X-Mons-Metadata-IP": "192.0.2.1",
      "X-Mons-Metadata-Revision": "1",
      "X-Mons-Metadata-Protected": "0",
      "X-Mons-Metadata-Authenticated": "0",
      ...overrides,
    },
  });
}

async function metadataResponse(
  room: Room,
  inviteId: string,
  overrides: Record<string, string> = {},
) {
  return room.fetch(metadataRequest(inviteId, overrides));
}

async function closeSocket(socket: WebSocket) {
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
}

afterEach(async () => {
  await Promise.all(
    rooms
      .splice(0)
      .map((room) =>
        runInDurableObject(room, (_instance, state) =>
          state.storage.deleteAlarm(),
        ),
      ),
  );
  await Promise.all(sockets.splice(0).map(closeSocket));
  vi.restoreAllMocks();
});

describe("durable invite metadata", () => {
  it("persists monotonic sanitized snapshots while private-only changes leave the public revision unchanged", async () => {
    const { room, inviteId, source } = await fixture({
      ...invite,
      password: "do-not-publish",
      automatchOperationIds: { "host-login": crypto.randomUUID() },
      wagers: { secret: true },
    });
    const first = await room.readMetadata(inviteId);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.snapshot.revision).toBe(1);
    expect(first.snapshot).not.toHaveProperty("password");
    expect(first.snapshot).not.toHaveProperty("wagers");
    expect(first.snapshot).not.toHaveProperty("automatchOperationIds");
    source.value = { ...invite, wagers: { other: true } };
    const unchanged = await room.readMetadata(inviteId);
    expect(unchanged.status).toBe("ok");
    if (unchanged.status !== "ok") return;
    expect(unchanged.snapshot).toEqual(first.snapshot);
    expect(unchanged.passwordProtected).toBe(false);
    source.value = { ...invite, hostRematches: "1", guestRematches: "1" };
    await evictDurableObject(room);
    await installSource(room, source);
    const changed = await room.readMetadata(inviteId);
    expect(changed.status).toBe("ok");
    if (changed.status !== "ok") return;
    expect(changed.snapshot).toMatchObject({
      revision: 2,
      hostRematches: "1",
      guestRematches: "1",
    });
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeNull();
  });

  it("coalesces concurrent reads and rejects stale admission instead of sending an old welcome snapshot", async () => {
    const { room, inviteId, source } = await fixture();
    const result = await runInDurableObject(room, async (instance) => {
      const began = deferred();
      const release = deferred();
      source.read = async () => {
        const captured = source.value;
        began.resolve();
        await release.promise;
        return captured;
      };
      const reads = Promise.all([
        instance.readMetadata(inviteId),
        instance.readMetadata(inviteId),
        instance.readMetadata(inviteId),
      ]);
      await began.promise;
      const admission = instance.fetch(metadataRequest(inviteId));
      source.value = { ...invite, hostRematches: "1", guestRematches: "1" };
      source.read = undefined;
      release.resolve();
      return { results: await reads, status: (await admission).status };
    });
    expect(result.results.every((value) => value.status === "ok")).toBe(true);
    expect(result.results[0]).toEqual(result.results[1]);
    expect(result.results[1]).toEqual(result.results[2]);
    expect(result.status).toBe(409);
    expect(source.reads).toBe(2);
    const client = acceptSocket(
      await metadataResponse(room, inviteId, {
        "X-Mons-Metadata-Revision": "2",
      }),
    );
    expect(JSON.parse(await client.read()).snapshot).toMatchObject({
      revision: 2,
      hostRematches: "1",
      guestRematches: "1",
    });
  });

  it("shares a fresh canonical read across simultaneous socket admissions", async () => {
    const { room, inviteId, source } = await fixture();
    const result = await runInDurableObject(room, async (instance) => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          instance.fetch(metadataRequest(inviteId)),
        ),
      );
      const clients = responses.flatMap((response) =>
        response.webSocket ? [response.webSocket] : [],
      );
      for (const socket of clients) socket.accept();
      await Promise.all(clients.map(closeSocket));
      return {
        statuses: responses.map((response) => response.status),
        reads: source.reads,
      };
    });
    expect(result).toEqual({ statuses: Array(8).fill(101), reads: 1 });
  });

  it("arms recovery before admission and catches up cumulative rematch state after a missed notification and eviction", async () => {
    const { room, inviteId, source } = await fixture();
    await runInDurableObject(room, (instance, state) => {
      const target = instance as unknown as {
        inviteReader: (id: string) => Promise<unknown>;
      };
      target.inviteReader = async () => {
        source.reads++;
        expect(await state.storage.getAlarm()).not.toBeNull();
        return source.value;
      };
    });
    const client = acceptSocket(await metadataResponse(room, inviteId));
    await installSource(room, source);
    expect(isInviteMetadataMessage(JSON.parse(await client.read()))).toBe(true);
    const before = source.reads;
    source.value = { ...invite, hostRematches: "1;2x", guestRematches: "1;2" };
    await evictDurableObject(room);
    await installSource(room, source);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(source.reads).toBe(before + 1);
    expect(JSON.parse(await client.read()).snapshot).toMatchObject({
      revision: 2,
      hostRematches: "1;2x",
      guestRematches: "1;2",
    });
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
  });

  it("returns notifications while a source read is pending and preserves their immediate successor alarm", async () => {
    const { room, inviteId, source } = await fixture();
    const client = acceptSocket(await metadataResponse(room, inviteId));
    await client.read();
    const nextAlarm = await runInDurableObject(
      room,
      async (instance, state) => {
        const began = deferred();
        const release = deferred();
        source.read = async () => {
          const captured = source.value;
          began.resolve();
          await release.promise;
          return captured;
        };
        const reading = instance.alarm();
        await began.promise;
        source.value = { ...invite, hostRematches: "1" };
        await instance.notifyMetadataChanged(inviteId);
        const scheduled = await state.storage.getAlarm();
        source.read = undefined;
        release.resolve();
        await reading;
        return scheduled;
      },
    );
    expect(nextAlarm).not.toBeNull();
    expect(nextAlarm!).toBeLessThanOrEqual(Date.now());
    expect(JSON.parse(await client.read()).snapshot.hostRematches).toBe("1");
    await room.readMetadata(inviteId);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
  });

  it("keeps recovery scheduled across upstream failures, then stops after the final metadata subscriber closes", async () => {
    const { room, inviteId, source } = await fixture();
    const client = acceptSocket(await metadataResponse(room, inviteId));
    await client.read();
    const reaction = acceptSocket(
      await room.fetch("https://room.internal/socket", {
        headers: { Upgrade: "websocket" },
      }),
    );
    await reaction.read();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    source.read = async () => {
      throw new Error("offline");
    };
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(errors).toHaveBeenCalledOnce();
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
    source.read = undefined;
    source.value = { ...invite, guestRematches: "1" };
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(JSON.parse(await client.read()).snapshot.guestRematches).toBe("1");
    await closeSocket(client.socket);
    const reads = source.reads;
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(source.reads).toBe(reads);
    expect(await runDurableObjectAlarm(room)).toBe(false);
    await room.notifyMetadataChanged(inviteId);
    expect(await runDurableObjectAlarm(room)).toBe(false);
    expect(reaction.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("checks authorization state again at admission and closes viewers whose access is revoked", async () => {
    const { room, inviteId, source } = await fixture();
    const watcher = acceptSocket(await metadataResponse(room, inviteId));
    await watcher.read();
    const host = acceptSocket(
      await metadataResponse(room, inviteId, {
        "X-Mons-Metadata-Role": "host",
        "X-Mons-Metadata-Actor": "host-login",
        "X-Mons-Metadata-Authenticated": "1",
      }),
    );
    await host.read();
    source.value = { ...invite, password: "private" };
    expect((await metadataResponse(room, inviteId)).status).toBe(409);
    const closed = new Promise<number>((resolve) =>
      watcher.socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    source.value = { ...invite, guestId: null, password: "private" };
    await runDurableObjectAlarm(room);
    expect(await closed).toBe(1008);
    expect(JSON.parse(await host.read()).snapshot.guestId).toBeNull();
    expect(host.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      (
        await metadataResponse(room, inviteId, {
          "X-Mons-Metadata-Revision": "2",
          "X-Mons-Metadata-Protected": "1",
          "X-Mons-Metadata-Authenticated": "1",
        })
      ).status,
    ).toBe(403);
  });

  it("keeps reactions and presentations out of metadata sockets and answers their receive-only heartbeat", async () => {
    const { room, inviteId, source } = await fixture();
    const metadata = acceptSocket(await metadataResponse(room, inviteId));
    await metadata.read();
    const reactions = acceptSocket(
      await room.fetch("https://room.internal/socket", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL,
        },
      }),
    );
    await reactions.read();
    await room.publish("host-login", {
      uuid: crypto.randomUUID(),
      kind: "yo",
      variation: 1,
      matchId: inviteId,
    });
    expect(JSON.parse(await reactions.read()).type).toBe("reaction");
    source.value = { ...invite, hostRematches: "1" };
    await runDurableObjectAlarm(room);
    expect(JSON.parse(await metadata.read()).type).toBe("snapshot");
    expect(metadata.messages).toEqual([]);
    expect(reactions.messages).toEqual([]);
    await evictDurableObject(room);
    metadata.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await metadata.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    const closed = new Promise<number>((resolve) =>
      metadata.socket.addEventListener(
        "close",
        (event) => resolve(event.code),
        {
          once: true,
        },
      ),
    );
    metadata.socket.send("publish");
    expect(await closed).toBe(1008);
  });

  it("reserves participant capacity even when only legacy channels are connected", async () => {
    const { room, inviteId } = await fixture();
    const metadata = await Promise.all(
      Array.from({ length: 248 }, async (_, index) =>
        acceptSocket(
          await metadataResponse(room, inviteId, {
            "X-Mons-Metadata-IP": `192.0.2.${Math.floor(index / 8)}`,
          }),
        ),
      ),
    );
    const reactions = await Promise.all(
      Array.from({ length: 240 }, async (_, index) =>
        acceptSocket(
          await room.fetch("https://room.internal/socket", {
            headers: {
              Upgrade: "websocket",
              "X-Mons-Reaction-IP": `192.0.2.${Math.floor(index / 8)}`,
            },
          }),
        ),
      ),
    );
    expect(
      (
        await metadataResponse(room, inviteId, {
          "X-Mons-Metadata-IP": "other",
        })
      ).status,
    ).toBe(429);
    const participants = await Promise.all(
      ["host", "guest"].flatMap((role) =>
        Array.from({ length: 4 }, async () => [
          acceptSocket(
            await metadataResponse(room, inviteId, {
              "X-Mons-Metadata-Role": role,
              "X-Mons-Metadata-Actor": `${role}-login`,
              "X-Mons-Metadata-Authenticated": "1",
            }),
          ),
          acceptSocket(
            await room.fetch("https://room.internal/socket", {
              headers: { Upgrade: "websocket", "X-Mons-Reaction-Role": role },
            }),
          ),
        ]),
      ),
    );
    await Promise.all(
      [...metadata, ...reactions, ...participants.flat()].map((client) =>
        client.read(),
      ),
    );
    expect(
      await runInDurableObject(
        room,
        (_instance, state) => state.getWebSockets().length,
      ),
    ).toBe(504);
    expect(
      (
        await room.fetch("https://room.internal/socket", {
          headers: { Upgrade: "websocket" },
        })
      ).status,
    ).toBe(429);
    expect((await metadataResponse(room, inviteId)).status).toBe(429);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeLessThanOrEqual(Date.now() + INVITE_METADATA_REFRESH_MS);
  });
});
