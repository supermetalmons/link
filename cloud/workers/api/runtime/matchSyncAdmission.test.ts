import { socketTestSessionHeaders } from "../test/socketTestSession.ts";
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MATCH_SYNC_SOCKET_PROTOCOL } from "@mons/shared/match-sync";
import { INVITE_METADATA_SOCKET_PROTOCOL } from "@mons/shared/invite-metadata";
import { INVITE_WAGERS_SOCKET_PROTOCOL } from "@mons/shared/invite-wagers";
import type { InviteReactions } from "../src/inviteReactions.ts";
import type { MatchSyncMetadata } from "../src/matchSync.ts";

type Room = DurableObjectStub<InviteReactions>;
type Source = {
  invite: Record<string, unknown>;
  reads: number;
  fen: string;
};

const rooms: Room[] = [];
const sockets: WebSocket[] = [];
const baselines = new Map<WebSocket, Promise<void>>();

async function install(room: Room, source: Source) {
  await runInDurableObject(room, (instance) => {
    const mutable = instance as unknown as {
      inviteReader: () => Promise<unknown>;
      matchSync: {
        readPair: (
          metadata: MatchSyncMetadata,
          matchId: string,
        ) => Promise<[unknown, unknown]>;
      };
    };
    mutable.inviteReader = async () => structuredClone(source.invite);
    const readMatch = (playerId: string) => {
      source.reads++;
      return {
        version: 2,
        color: playerId === "host-login" ? "white" : "black",
        emojiId: 1,
        aura: "",
        gameVariant: "standard",
        fen: source.fen,
        status: "",
        flatMovesString: "",
        timer: "",
      };
    };
    mutable.matchSync.readPair = async (metadata) => [
      readMatch(metadata.snapshot.hostId),
      metadata.snapshot.guestId === null
        ? null
        : readMatch(metadata.snapshot.guestId),
    ];
  });
}

async function fixture(paired = true) {
  const inviteId = `admission-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  const source: Source = {
    invite: {
      hostId: "host-login",
      hostColor: "white",
      ...(paired ? { guestId: "guest-login" } : {}),
    },
    reads: 0,
    fen: "initial",
  };
  rooms.push(room);
  await install(room, source);
  return { room, inviteId, source };
}

function request(
  inviteId: string,
  overrides: Record<string, string | null> = {},
) {
  const headers = new Headers({
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": MATCH_SYNC_SOCKET_PROTOCOL,
    "X-Mons-Match-Invite": encodeURIComponent(inviteId),
    "X-Mons-Match-Match": encodeURIComponent(inviteId),
    "X-Mons-Match-Role": "host",
    "X-Mons-Match-Actor": "host-login",
    "X-Mons-Match-IP": "192.0.2.1",
    "X-Mons-Match-Revision": "1",
    "X-Mons-Match-Protected": "0",
    "X-Mons-Match-Authenticated": "1",
    ...socketTestSessionHeaders(),
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request("https://room.internal/matches/socket", { headers });
}

function spectator(inviteId: string, ip = "192.0.2.1") {
  return request(inviteId, {
    "X-Mons-Match-Role": "spectator",
    "X-Mons-Match-Actor": null,
    "X-Mons-Match-Authenticated": "0",
    "X-Mons-Match-IP": ip,
  });
}

function accept(response: Response): WebSocket {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  baselines.set(
    socket,
    new Promise<void>((resolve) => {
      socket.addEventListener("message", () => resolve(), { once: true });
    }),
  );
  socket.accept();
  sockets.push(socket);
  return socket;
}

async function close(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.close(1000, "Test complete");
    if (socket.readyState === WebSocket.CLOSED) resolve();
  });
}

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(close));
  await Promise.all(
    rooms
      .splice(0)
      .map((room) =>
        runInDurableObject(room, (_instance, state) =>
          state.storage.deleteAlarm(),
        ),
      ),
  );
  baselines.clear();
  vi.restoreAllMocks();
});

describe("live match socket admission", () => {
  it("rejects invalid internal protocol, identity, revision, and room targets before reading match data", async () => {
    const { room, inviteId, source } = await fixture();
    const invalid: Record<string, string | null>[] = [
      { "Sec-WebSocket-Protocol": null },
      { "Sec-WebSocket-Protocol": "mons-reactions-v1" },
      { "X-Mons-Match-Invite": "%" },
      { "X-Mons-Match-Invite": "another-invite" },
      { "X-Mons-Match-Match": "%2F" },
      { "X-Mons-Match-Match": null },
      { "X-Mons-Match-Role": "watch" },
      { "X-Mons-Match-Actor": null },
      { "X-Mons-Match-Actor": "%2F" },
      { "X-Mons-Match-Role": "spectator" },
      { "X-Mons-Match-IP": "a".repeat(65) },
      { "X-Mons-Match-Revision": "0" },
      { "X-Mons-Match-Revision": "01" },
      { "X-Mons-Match-Revision": String(Number.MAX_SAFE_INTEGER + 1) },
      { "X-Mons-Match-Protected": "true" },
      { "X-Mons-Match-Authenticated": "true" },
    ];
    for (const headers of invalid) {
      const response = await room.fetch(request(inviteId, headers));
      expect(response.status, JSON.stringify(headers)).toBe(400);
    }
    expect(source.reads).toBe(0);
    expect(
      await runInDurableObject(
        room,
        (_instance, state) => state.getWebSockets().length,
      ),
    ).toBe(0);
  });

  it("rejects stale revisions, changed private gates, and unproven participant roles", async () => {
    const { room, inviteId, source } = await fixture();
    expect((await room.readMatches(inviteId, inviteId)).status).toBe("ok");
    source.fen = "new-state";
    await room.notifyMatchesChanged(inviteId, [inviteId]);
    expect((await room.fetch(request(inviteId))).status).toBe(409);
    source.invite.password = "private";
    await room.notifyMetadataChanged(inviteId);
    expect(
      (await room.fetch(request(inviteId, { "X-Mons-Match-Revision": "2" })))
        .status,
    ).toBe(409);
    const denied: Record<string, string>[] = [
      { "X-Mons-Match-Actor": "another-login" },
      { "X-Mons-Match-Authenticated": "0" },
      { "X-Mons-Match-Role": "guest" },
    ];
    for (const headers of denied) {
      expect(
        (
          await room.fetch(
            request(inviteId, {
              "X-Mons-Match-Revision": "2",
              "X-Mons-Match-Protected": "1",
              ...headers,
            }),
          )
        ).status,
      ).toBe(403);
    }
    accept(
      await room.fetch(
        request(inviteId, {
          "X-Mons-Match-Revision": "2",
          "X-Mons-Match-Protected": "1",
        }),
      ),
    );
  });

  it("preserves pending invite privacy while allowing its authenticated host", async () => {
    const { room, inviteId, source } = await fixture(false);
    source.invite.password = "private";
    expect(
      (
        await room.fetch(
          request(inviteId, {
            "X-Mons-Match-Role": "spectator",
            "X-Mons-Match-Actor": null,
            "X-Mons-Match-Protected": "1",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await room.fetch(
          request(inviteId, {
            "X-Mons-Match-Role": "guest",
            "X-Mons-Match-Actor": "guest-login",
            "X-Mons-Match-Protected": "1",
          }),
        )
      ).status,
    ).toBe(403);
    accept(
      await room.fetch(request(inviteId, { "X-Mons-Match-Protected": "1" })),
    );
  });

  it("enforces participant and spectator IP caps through eviction and frees closed slots across rematches", async () => {
    const { room, inviteId, source } = await fixture();
    source.invite.hostRematches = "1";
    const expectFull = async (input: Request) => {
      const response = await room.fetch(input);
      expect(response.status).toBe(429);
      await response.text();
    };
    const hosts = await Promise.all(
      Array.from({ length: 4 }, async () =>
        accept(await room.fetch(request(inviteId))),
      ),
    );
    const viewers = await Promise.all(
      Array.from({ length: 8 }, async () =>
        accept(await room.fetch(spectator(inviteId))),
      ),
    );
    await expectFull(request(inviteId));
    await expectFull(spectator(inviteId));
    await Promise.all(
      [...hosts, ...viewers].map((socket) => baselines.get(socket)),
    );
    await evictDurableObject(room);
    await install(room, source);
    const rematch = request(inviteId, { "X-Mons-Match-Match": `${inviteId}1` });
    await expectFull(rematch);
    await expectFull(spectator(inviteId));
    await close(hosts[0]);
    await close(viewers[0]);
    accept(await room.fetch(rematch));
    accept(await room.fetch(spectator(inviteId)));
    expect(
      await runInDurableObject(room, (_instance, state) => ({
        hosts: state.getWebSockets("match-role:host").length,
        viewers: state.getWebSockets("match-ip:192.0.2.1").length,
      })),
    ).toEqual({ hosts: 4, viewers: 8 });
  });

  it("reserves match participant capacity when all legacy channel spectator and participant slots are occupied", async () => {
    const { room, inviteId } = await fixture();
    const inviteRequest = (
      channel: "metadata" | "wagers",
      role: "host" | "guest" | "spectator",
      ip = "192.0.2.1",
    ) => {
      const name = channel === "metadata" ? "Metadata" : "Wagers";
      return new Request(`https://room.internal/${channel}/socket`, {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol":
            channel === "metadata"
              ? INVITE_METADATA_SOCKET_PROTOCOL
              : INVITE_WAGERS_SOCKET_PROTOCOL,
          [`X-Mons-${name}-Invite`]: inviteId,
          [`X-Mons-${name}-Role`]: role,
          [`X-Mons-${name}-IP`]: ip,
          [`X-Mons-${name}-Revision`]: "1",
          [`X-Mons-${name}-Protected`]: "0",
          [`X-Mons-${name}-Authenticated`]: role === "spectator" ? "0" : "1",
          ...socketTestSessionHeaders(),
          ...(role === "spectator"
            ? {}
            : { [`X-Mons-${name}-Actor`]: `${role}-login` }),
        },
      });
    };
    await Promise.all(
      Array.from({ length: 248 }, async (_, index) =>
        accept(
          await room.fetch("https://room.internal/socket", {
            headers: {
              Upgrade: "websocket",
              "X-Mons-Reaction-IP": `192.0.2.${Math.floor(index / 8)}`,
            },
          }),
        ),
      ),
    );
    await Promise.all(
      Array.from({ length: 232 }, async (_, index) =>
        accept(
          await room.fetch(
            inviteRequest(
              "metadata",
              "spectator",
              `198.51.100.${Math.floor(index / 8)}`,
            ),
          ),
        ),
      ),
    );
    expect((await room.fetch(spectator(inviteId))).status).toBe(429);
    await Promise.all(
      ["host", "guest"].flatMap((role) =>
        Array.from({ length: 4 }, async () => {
          accept(
            await room.fetch("https://room.internal/socket", {
              headers: {
                Upgrade: "websocket",
                "X-Mons-Reaction-Role": role,
                ...socketTestSessionHeaders(),
              },
            }),
          );
          accept(
            await room.fetch(
              inviteRequest("metadata", role as "host" | "guest"),
            ),
          );
          accept(
            await room.fetch(inviteRequest("wagers", role as "host" | "guest")),
          );
        }),
      ),
    );
    expect(
      await runInDurableObject(
        room,
        (_instance, state) => state.getWebSockets().length,
      ),
    ).toBe(504);
    await Promise.all(
      ["host", "guest"].flatMap((role) =>
        Array.from({ length: 4 }, async () =>
          accept(
            await room.fetch(
              request(inviteId, {
                "X-Mons-Match-Role": role,
                "X-Mons-Match-Actor": `${role}-login`,
              }),
            ),
          ),
        ),
      ),
    );
    expect(
      await runInDurableObject(
        room,
        (_instance, state) => state.getWebSockets().length,
      ),
    ).toBe(512);
    expect((await room.fetch(request(inviteId))).status).toBe(429);
  });

  it("leaves no admitted socket or consumed participant slot when alarm scheduling fails", async () => {
    const { room, inviteId } = await fixture();
    await room.readMatches(inviteId, inviteId);
    const result = await runInDurableObject(room, async (instance, state) => {
      const target = instance as unknown as {
        matchSync: {
          dependencies: { scheduleAlarm: (atMs: number) => Promise<void> };
        };
      };
      const schedule = vi
        .spyOn(target.matchSync.dependencies, "scheduleAlarm")
        .mockRejectedValue(new Error("alarm-offline"));
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          expect((await instance.fetch(request(inviteId))).status).toBe(503);
        }
      } finally {
        schedule.mockRestore();
      }
      return {
        open: state
          .getWebSockets("channel:matches")
          .filter((socket) => socket.readyState === WebSocket.OPEN).length,
        registered: state.getWebSockets("channel:matches").length,
        due: state.storage.sql
          .exec<{ next_at_ms: number | null }>(
            "SELECT next_at_ms FROM match_sync_snapshots WHERE match_id = ?",
            inviteId,
          )
          .one().next_at_ms,
      };
    });
    expect(result).toEqual({ open: 0, registered: 0, due: null });
    await Promise.all(
      Array.from({ length: 4 }, async () =>
        accept(await room.fetch(request(inviteId))),
      ),
    );
  });

  it("keeps recovery armed when an unchanged match is invalidated during admission", async () => {
    const { room, inviteId, source } = await fixture();
    await room.readMatches(inviteId, inviteId);
    const reads = source.reads;
    let invalidated = false;
    await runInDurableObject(room, (instance) => {
      const target = instance as unknown as {
        matchSync: {
          dependencies: { scheduleAlarm: (atMs: number) => Promise<void> };
        };
      };
      const schedule = target.matchSync.dependencies.scheduleAlarm;
      vi.spyOn(
        target.matchSync.dependencies,
        "scheduleAlarm",
      ).mockImplementation(async (atMs) => {
        if (!invalidated) {
          invalidated = true;
          await instance.notifyMatchesChanged(inviteId, [inviteId]);
        }
        await schedule(atMs);
      });
    });
    const socket = accept(await room.fetch(request(inviteId)));
    await baselines.get(socket);
    expect(invalidated).toBe(true);
    expect(source.reads).toBe(reads + 2);
    const scheduled = await runInDurableObject(
      room,
      async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        due: state.storage.sql
          .exec<{ next_at_ms: number | null }>(
            "SELECT next_at_ms FROM match_sync_snapshots WHERE match_id = ?",
            inviteId,
          )
          .one().next_at_ms,
      }),
    );
    expect(scheduled.due).not.toBeNull();
    expect(scheduled.alarm).not.toBeNull();
    const changed = new Promise<string>((resolve) =>
      socket.addEventListener(
        "message",
        (event) => resolve(String(event.data)),
        {
          once: true,
        },
      ),
    );
    source.fen = "missed-notification";
    vi.spyOn(Date, "now").mockReturnValue(Math.max(Date.now(), scheduled.due!));
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(JSON.parse(await changed).snapshot).toMatchObject({
      revision: 2,
      hostMatch: { fen: "missed-notification" },
      guestMatch: { fen: "missed-notification" },
    });
  });
});
