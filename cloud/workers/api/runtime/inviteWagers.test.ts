import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INVITE_WAGERS_REFRESH_MS,
  INVITE_WAGERS_SOCKET_PROTOCOL,
  isInviteWagersMessage,
} from "@mons/shared/invite-wagers";
import { INVITE_METADATA_SOCKET_PROTOCOL } from "@mons/shared/invite-metadata";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_SOCKET_PROTOCOL_V2,
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
const proposal = { material: "dust", count: 3, createdAt: 1_000 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function advanceToAlarm(room: Room): Promise<void> {
  const scheduled = await runInDurableObject(room, (_instance, state) =>
    state.storage.getAlarm(),
  );
  if (scheduled !== null)
    vi.spyOn(Date, "now").mockReturnValue(Math.max(Date.now(), scheduled));
}

async function runScheduledAlarm(room: Room): Promise<boolean> {
  await advanceToAlarm(room);
  return runDurableObjectAlarm(room);
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

async function fixture() {
  const inviteId = `wagers-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  const source: Source = {
    value: {
      ...invite,
      wagers: { [inviteId]: { proposals: { "host-login": proposal } } },
    },
    reads: 0,
  };
  rooms.push(room);
  await installSource(room, source);
  return { inviteId, room, source };
}

function request(
  inviteId: string,
  channel: "wagers" | "metadata" = "wagers",
  overrides: Record<string, string> = {},
) {
  const name = channel === "wagers" ? "Wagers" : "Metadata";
  return new Request(`https://room.internal/${channel}/socket`, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol":
        channel === "wagers"
          ? INVITE_WAGERS_SOCKET_PROTOCOL
          : INVITE_METADATA_SOCKET_PROTOCOL,
      [`X-Mons-${name}-Invite`]: encodeURIComponent(inviteId),
      [`X-Mons-${name}-Role`]: "spectator",
      [`X-Mons-${name}-IP`]: "192.0.2.1",
      [`X-Mons-${name}-Revision`]: "1",
      [`X-Mons-${name}-Protected`]: "0",
      [`X-Mons-${name}-Authenticated`]: "0",
      ...overrides,
    },
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

async function storedWagers(room: Room) {
  return runInDurableObject(room, (_instance, state) =>
    state.storage.sql
      .exec<{ snapshot_json: string; source_fingerprint: string }>(
        "SELECT snapshot_json, source_fingerprint FROM invite_wagers WHERE singleton = 1",
      )
      .one(),
  );
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

describe("durable invite wagers", () => {
  it("persists sanitized revisions independently and includes private-only changes without exposing them", async () => {
    const { room, inviteId, source } = await fixture();
    const first = await room.readWagers(inviteId);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.snapshot).toEqual({
      inviteId,
      revision: 1,
      wagers: { [inviteId]: { proposals: { "host-login": proposal } } },
    });
    source.value = {
      ...invite,
      wagers: {
        [inviteId]: {
          proposals: {
            "host-login": { ...proposal, reservationOperationId: "private" },
          },
          settlement: { state: "pending", fingerprint: "private-settlement" },
        },
      },
    };
    const changed = await room.readWagers(inviteId);
    expect(changed.status).toBe("ok");
    if (changed.status !== "ok") return;
    expect(changed.snapshot).toEqual({ ...first.snapshot, revision: 2 });
    expect(changed.metadata.snapshot.revision).toBe(1);
    expect(JSON.stringify(changed)).not.toContain("private");
    await evictDurableObject(room);
    await installSource(room, source);
    expect(await room.readWagers(inviteId)).toEqual(changed);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeNull();
  });

  it("coalesces both channel reads and simultaneous admissions into one canonical read", async () => {
    const { room, inviteId, source } = await fixture();
    const results = await runInDurableObject(room, (instance) =>
      Promise.all([
        instance.readMetadata(inviteId),
        instance.readWagers(inviteId),
        instance.readMetadata(inviteId),
        instance.readWagers(inviteId),
      ]),
    );
    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(source.reads).toBe(1);
    const admissionReads = await runInDurableObject(room, async (instance) => {
      const responses = await Promise.all([
        ...Array.from({ length: 4 }, () => instance.fetch(request(inviteId))),
        ...Array.from({ length: 4 }, () =>
          instance.fetch(request(inviteId, "metadata")),
        ),
      ]);
      expect(responses.every((response) => response.status === 101)).toBe(true);
      const clients = responses.map((response) => response.webSocket!);
      clients.forEach((socket) => socket.accept());
      await Promise.all(clients.map(closeSocket));
      return source.reads;
    });
    expect(admissionReads).toBe(2);
  });

  it("starts a fresh reconciliation read after an in-flight source read even when notification is missed", async () => {
    const { room, inviteId, source } = await fixture();
    source.value = { ...invite, wagers: {} };
    await room.readWagers(inviteId);
    const results = await runInDurableObject(room, async (instance) => {
      const began = deferred();
      const release = deferred();
      source.read = async () => {
        const captured = source.value;
        began.resolve();
        await release.promise;
        return captured;
      };
      const older = instance.readWagers(inviteId);
      await began.promise;
      source.value = {
        ...invite,
        wagers: { [inviteId]: { proposals: { "host-login": proposal } } },
      };
      const newer = instance.readWagers(inviteId);
      const shared = instance.readWagers(inviteId);
      source.read = undefined;
      release.resolve();
      return Promise.all([older, newer, shared]);
    });
    expect(source.reads).toBe(3);
    expect(results[0]).toMatchObject({
      status: "ok",
      snapshot: { revision: 1, wagers: {} },
    });
    for (const result of results.slice(1)) {
      expect(result).toMatchObject({
        status: "ok",
        snapshot: {
          revision: 2,
          wagers: { [inviteId]: { proposals: { "host-login": proposal } } },
        },
      });
    }
  });

  it("discards a read invalidated by a write before serving a newer reader without subscribers", async () => {
    const { room, inviteId, source } = await fixture();
    await room.readWagers(inviteId);
    const results = await runInDurableObject(room, async (instance) => {
      const began = deferred();
      const release = deferred();
      source.read = async () => {
        const captured = source.value;
        began.resolve();
        await release.promise;
        return captured;
      };
      const older = instance.readWagers(inviteId);
      await began.promise;
      source.value = {
        ...invite,
        wagers: {
          [inviteId]: {
            proposals: { "host-login": { ...proposal, count: 7 } },
          },
        },
      };
      await instance.notifyWagersChanged(inviteId);
      const newer = instance.readWagers(inviteId);
      source.read = undefined;
      release.resolve();
      return Promise.all([older, newer]);
    });
    expect(source.reads).toBe(4);
    for (const result of results) {
      expect(result).toMatchObject({
        status: "ok",
        snapshot: {
          revision: 2,
          wagers: {
            [inviteId]: { proposals: { "host-login": { count: 7 } } },
          },
        },
      });
    }
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeNull();
  });

  it("refreshes both active channels with one alarm read and broadcasts only to the matching channel", async () => {
    const { room, inviteId, source } = await fixture();
    const wager = acceptSocket(await room.fetch(request(inviteId)));
    const metadata = acceptSocket(
      await room.fetch(request(inviteId, "metadata")),
    );
    expect(isInviteWagersMessage(JSON.parse(await wager.read()))).toBe(true);
    await metadata.read();
    source.value = {
      ...invite,
      hostRematches: "1",
      wagers: {
        [inviteId]: { proposals: { "host-login": { ...proposal, count: 5 } } },
      },
    };
    const before = source.reads;
    expect(await runScheduledAlarm(room)).toBe(true);
    expect(source.reads).toBe(before + 1);
    expect(JSON.parse(await wager.read()).snapshot).toMatchObject({
      revision: 2,
      wagers: { [inviteId]: { proposals: { "host-login": { count: 5 } } } },
    });
    expect(JSON.parse(await metadata.read()).snapshot).toMatchObject({
      revision: 2,
      hostRematches: "1",
    });
    source.value = {
      ...invite,
      hostRematches: "1",
      wagers: { [inviteId]: { proposedBy: { "host-login": true } } },
    };
    await runScheduledAlarm(room);
    expect(JSON.parse(await wager.read()).snapshot.revision).toBe(3);
    expect(metadata.messages).toEqual([]);
    expect(wager.messages).toEqual([]);
  });

  it("rejects stale wager admission after a private-only change while metadata revision is unchanged", async () => {
    const { room, inviteId, source } = await fixture();
    await room.readWagers(inviteId);
    source.value = {
      ...invite,
      wagers: {
        [inviteId]: {
          proposals: { "host-login": proposal },
          proposalRemovalOperations: {
            internal: { reservationOperationId: "private" },
          },
        },
      },
    };
    expect((await room.fetch(request(inviteId))).status).toBe(409);
    const client = acceptSocket(
      await room.fetch(
        request(inviteId, "wagers", { "X-Mons-Wagers-Revision": "2" }),
      ),
    );
    expect(JSON.parse(await client.read()).snapshot.revision).toBe(2);
    const metadata = await room.readMetadata(inviteId);
    expect(metadata.status === "ok" && metadata.snapshot.revision).toBe(1);
  });

  it("preserves last good wagers during corruption or an outage and keeps metadata updates independent", async () => {
    const { room, inviteId, source } = await fixture();
    const wagers = acceptSocket(await room.fetch(request(inviteId)));
    const metadata = acceptSocket(
      await room.fetch(request(inviteId, "metadata")),
    );
    await wagers.read();
    await metadata.read();
    const stored = await storedWagers(room);
    source.value = { ...invite, hostRematches: "1", wagers: [] };
    expect(await runScheduledAlarm(room)).toBe(true);
    expect(await storedWagers(room)).toEqual(stored);
    expect(wagers.socket.readyState).toBe(WebSocket.OPEN);
    expect(wagers.messages).toEqual([]);
    expect(JSON.parse(await metadata.read()).snapshot.hostRematches).toBe("1");
    expect(await room.readWagers(inviteId)).toEqual({ status: "invalid" });
    source.read = async () => {
      throw new Error("offline");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runScheduledAlarm(room)).toBe(true);
    expect(await storedWagers(room)).toEqual(stored);
    expect(wagers.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
    source.read = undefined;
    source.value = { ...invite, hostRematches: "1" };
    await runScheduledAlarm(room);
    expect(JSON.parse(await wagers.read()).snapshot).toEqual({
      inviteId,
      revision: 2,
      wagers: {},
    });
  });

  it("keeps asynchronous wager projection failures isolated from metadata", async () => {
    const { room, inviteId, source } = await fixture();
    await room.readWagers(inviteId);
    const stored = await storedWagers(room);
    source.value = {
      ...invite,
      hostRematches: "1",
      wagers: { [inviteId]: { proposedBy: { "host-login": true } } },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("projection-offline"));
    const metadata = await room.readMetadata(inviteId);
    expect(metadata).toMatchObject({
      status: "ok",
      snapshot: { revision: 2, hostRematches: "1" },
    });
    expect(await storedWagers(room)).toEqual(stored);
    digest.mockRestore();
    expect(await room.readWagers(inviteId)).toMatchObject({
      status: "ok",
      snapshot: { revision: 2 },
    });
  });

  it("rechecks access before broadcasting and revokes access even while wager data is malformed", async () => {
    const { room, inviteId, source } = await fixture();
    const watcher = acceptSocket(await room.fetch(request(inviteId)));
    const host = acceptSocket(
      await room.fetch(
        request(inviteId, "wagers", {
          "X-Mons-Wagers-Role": "host",
          "X-Mons-Wagers-Actor": "host-login",
          "X-Mons-Wagers-Authenticated": "1",
        }),
      ),
    );
    await watcher.read();
    await host.read();
    const closed = new Promise<number>((resolve) =>
      watcher.socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    source.value = {
      ...invite,
      guestId: null,
      password: "private",
      wagers: [],
    };
    await room.notifyMetadataChanged(inviteId);
    await runScheduledAlarm(room);
    expect(await closed).toBe(1008);
    expect(host.socket.readyState).toBe(WebSocket.OPEN);
    expect(host.messages).toEqual([]);
    source.value = { ...invite, guestId: null, password: "private" };
    await runScheduledAlarm(room);
    expect(JSON.parse(await host.read()).snapshot.revision).toBe(2);
    expect(
      (
        await room.fetch(
          request(inviteId, "wagers", {
            "X-Mons-Wagers-Revision": "2",
            "X-Mons-Wagers-Protected": "1",
            "X-Mons-Wagers-Authenticated": "1",
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("preserves immediate invalidations that arrive during an in-flight source read", async () => {
    const { room, inviteId, source } = await fixture();
    const client = acceptSocket(await room.fetch(request(inviteId)));
    await client.read();
    await advanceToAlarm(room);
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
        source.value = {
          ...invite,
          wagers: { [inviteId]: { proposedBy: { "host-login": true } } },
        };
        await instance.notifyWagersChanged(inviteId);
        const scheduled = await state.storage.getAlarm();
        source.read = undefined;
        release.resolve();
        await reading;
        return scheduled;
      },
    );
    expect(nextAlarm).not.toBeNull();
    expect(nextAlarm!).toBeLessThanOrEqual(Date.now());
    expect(JSON.parse(await client.read()).snapshot).toMatchObject({
      revision: 2,
      wagers: { [inviteId]: { proposedBy: { "host-login": true } } },
    });
  });

  it("recovers after eviction, isolates legacy reactions and presentations, and keeps the heartbeat receive-only", async () => {
    const { room, inviteId, source } = await fixture();
    const wager = acceptSocket(await room.fetch(request(inviteId)));
    const legacy = acceptSocket(
      await room.fetch("https://room.internal/socket", {
        headers: { Upgrade: "websocket" },
      }),
    );
    const modern = acceptSocket(
      await room.fetch("https://room.internal/socket", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL_V2,
          "X-Mons-Presentation-Match": inviteId,
        },
      }),
    );
    await Promise.all([wager.read(), legacy.read(), modern.read()]);
    await room.ensurePresentations(inviteId, {
      "host-login": { emojiId: 1, aura: "" },
    });
    await room.updatePresentation("host-login", inviteId, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      emojiId: 1001,
      aura: "rainbow",
    });
    expect(JSON.parse(await modern.read()).type).toBe("presentation");
    await room.publish("host-login", {
      uuid: crypto.randomUUID(),
      kind: "yo",
      variation: 1,
      matchId: inviteId,
    });
    expect(JSON.parse(await modern.read()).type).toBe("reaction");
    expect(JSON.parse(await legacy.read()).type).toBe("reaction");
    expect(wager.messages).toEqual([]);
    source.value = { ...invite };
    await evictDurableObject(room);
    await installSource(room, source);
    expect(await runScheduledAlarm(room)).toBe(true);
    expect(JSON.parse(await wager.read()).snapshot.wagers).toEqual({});
    expect(legacy.messages).toEqual([]);
    expect(modern.messages).toEqual([]);
    wager.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await wager.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    const closed = new Promise<number>((resolve) =>
      wager.socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      }),
    );
    wager.socket.send("publish");
    expect(await closed).toBe(1008);
  });

  it("keeps recovery while either channel has subscribers and stops after the last one closes", async () => {
    const { room, inviteId, source } = await fixture();
    const wager = acceptSocket(await room.fetch(request(inviteId)));
    const metadata = acceptSocket(
      await room.fetch(request(inviteId, "metadata")),
    );
    await wager.read();
    await metadata.read();
    await closeSocket(metadata.socket);
    source.value = { ...invite };
    const before = source.reads;
    expect(await runScheduledAlarm(room)).toBe(true);
    expect(source.reads).toBe(before + 1);
    await wager.read();
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeLessThanOrEqual(Date.now() + INVITE_WAGERS_REFRESH_MS);
    await closeSocket(wager.socket);
    const after = source.reads;
    expect(await runScheduledAlarm(room)).toBe(true);
    expect(source.reads).toBe(after);
    expect(await runScheduledAlarm(room)).toBe(false);
    await room.notifyWagersChanged(inviteId);
    await room.notifyMetadataChanged(inviteId);
    expect(await runScheduledAlarm(room)).toBe(false);
  });

  it("enforces independent wager spectator and participant caps alongside aggregate capacity", async () => {
    const { room, inviteId } = await fixture();
    const sameIp = await Promise.all(
      Array.from({ length: 8 }, async () =>
        acceptSocket(await room.fetch(request(inviteId))),
      ),
    );
    await Promise.all(sameIp.map((client) => client.read()));
    expect((await room.fetch(request(inviteId))).status).toBe(429);
    const metadata = acceptSocket(
      await room.fetch(request(inviteId, "metadata")),
    );
    await metadata.read();
    const hosts = await Promise.all(
      Array.from({ length: 4 }, async () =>
        acceptSocket(
          await room.fetch(
            request(inviteId, "wagers", {
              "X-Mons-Wagers-Role": "host",
              "X-Mons-Wagers-Actor": "host-login",
              "X-Mons-Wagers-Authenticated": "1",
            }),
          ),
        ),
      ),
    );
    await Promise.all(hosts.map((client) => client.read()));
    expect(
      (
        await room.fetch(
          request(inviteId, "wagers", {
            "X-Mons-Wagers-Role": "host",
            "X-Mons-Wagers-Actor": "host-login",
            "X-Mons-Wagers-Authenticated": "1",
          }),
        )
      ).status,
    ).toBe(429);
    const spectators = await Promise.all(
      Array.from({ length: 240 }, async (_, index) =>
        acceptSocket(
          await room.fetch(
            request(inviteId, "wagers", {
              "X-Mons-Wagers-IP": `198.51.100.${Math.floor(index / 8)}`,
            }),
          ),
        ),
      ),
    );
    await Promise.all(spectators.map((client) => client.read()));
    expect(
      (
        await room.fetch(
          request(inviteId, "wagers", { "X-Mons-Wagers-IP": "other" }),
        )
      ).status,
    ).toBe(429);
    const others = await Promise.all(
      Array.from({ length: 231 }, async (_, index) =>
        acceptSocket(
          await room.fetch("https://room.internal/socket", {
            headers: {
              Upgrade: "websocket",
              "X-Mons-Reaction-IP": `198.51.100.${Math.floor(index / 8)}`,
            },
          }),
        ),
      ),
    );
    await Promise.all(others.map((client) => client.read()));
    expect(
      (
        await room.fetch("https://room.internal/socket", {
          headers: { Upgrade: "websocket", "X-Mons-Reaction-IP": "other" },
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await room.fetch(
          request(inviteId, "metadata", { "X-Mons-Metadata-IP": "other" }),
        )
      ).status,
    ).toBe(429);
    const remainingPlayers = await Promise.all(
      ["host", "guest"].flatMap((role) =>
        ["reaction", "metadata", "wagers"].flatMap((channel) =>
          role === "host" && channel === "wagers"
            ? []
            : Array.from({ length: 4 }, async () => {
                const name = channel === "metadata" ? "Metadata" : "Wagers";
                return acceptSocket(
                  await room.fetch(
                    channel === "reaction"
                      ? new Request("https://room.internal/socket", {
                          headers: {
                            Upgrade: "websocket",
                            "X-Mons-Reaction-Role": role,
                          },
                        })
                      : request(inviteId, channel as "metadata" | "wagers", {
                          [`X-Mons-${name}-Role`]: role,
                          [`X-Mons-${name}-Actor`]: `${role}-login`,
                          [`X-Mons-${name}-Authenticated`]: "1",
                        }),
                  ),
                );
              }),
        ),
      ),
    );
    await Promise.all(remainingPlayers.map((client) => client.read()));
    expect(
      await runInDurableObject(
        room,
        (_instance, state) => state.getWebSockets().length,
      ),
    ).toBe(504);
    expect(
      (
        await room.fetch(
          request(inviteId, "wagers", { "X-Mons-Wagers-IP": "other" }),
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await room.fetch(
          request(inviteId, "metadata", { "X-Mons-Metadata-IP": "other" }),
        )
      ).status,
    ).toBe(429);
  });
});
