import { socketTestSessionHeaders } from "../test/socketTestSession.ts";
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SYNC_REFRESH_MS,
  MATCH_SYNC_SOCKET_PROTOCOL,
  type MatchSyncMessage,
} from "@mons/shared/match-sync";
import { INVITE_METADATA_SOCKET_PROTOCOL } from "@mons/shared/invite-metadata";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
} from "@mons/shared/reactions";
import type { InviteReactions } from "../src/inviteReactions.ts";

type Room = DurableObjectStub<InviteReactions>;
type Source = {
  invite: Record<string, unknown>;
  matches: Map<string, unknown>;
  reads: string[];
  metadataReads: number;
  read?: (playerId: string, matchId: string) => Promise<unknown>;
};

const rooms: Room[] = [];
const sockets: WebSocket[] = [];
const match = {
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "standard",
  fen: "initial",
  status: "",
  flatMovesString: "",
  timer: "",
};

async function install(room: Room, source: Source) {
  await runInDurableObject(room, (instance) => {
    const mutable = instance as unknown as {
      inviteReader: () => Promise<unknown>;
      matchSync: {
        readMatch: (playerId: string, matchId: string) => Promise<unknown>;
      };
    };
    mutable.inviteReader = async () => {
      source.metadataReads++;
      return structuredClone(source.invite);
    };
    mutable.matchSync.readMatch = async (playerId, matchId) => {
      source.reads.push(`${playerId}/${matchId}`);
      return source.read
        ? source.read(playerId, matchId)
        : structuredClone(source.matches.get(`${playerId}/${matchId}`) ?? null);
    };
  });
}

async function fixture(paired = true) {
  const inviteId = `sync-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  const source: Source = {
    invite: {
      hostId: "host-login",
      hostColor: "white",
      ...(paired ? { guestId: "guest-login" } : {}),
    },
    matches: new Map([
      [
        `host-login/${inviteId}`,
        { ...match, sessionCreation: { private: true } },
      ],
      ...(paired
        ? [
            [`guest-login/${inviteId}`, { ...match, color: "black" }] as [
              string,
              unknown,
            ],
          ]
        : []),
    ]),
    reads: [],
    metadataReads: 0,
  };
  rooms.push(room);
  await install(room, source);
  return { inviteId, room, source };
}

function accept(response: Response) {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  const readers: ((value: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const reader = readers.shift();
    if (reader) reader(String(event.data));
    else messages.push(String(event.data));
  });
  socket.accept();
  sockets.push(socket);
  const read = () =>
    messages.length
      ? Promise.resolve(messages.shift()!)
      : new Promise<string>((resolve) => readers.push(resolve));
  return {
    socket,
    messages,
    read,
    snapshot: async () =>
      (JSON.parse(await read()) as MatchSyncMessage).snapshot,
  };
}

async function connect(
  room: Room,
  inviteId: string,
  matchId = inviteId,
  overrides: Record<string, string> = {},
) {
  const value = await room.readMatches(inviteId, matchId);
  if (value.status !== "ok") throw new Error("fixture-match-missing");
  return accept(
    await room.fetch(
      new Request("https://room.internal/matches/socket", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": MATCH_SYNC_SOCKET_PROTOCOL,
          "X-Mons-Match-Invite": inviteId,
          "X-Mons-Match-Match": matchId,
          "X-Mons-Match-Role": "host",
          "X-Mons-Match-Actor": "host-login",
          "X-Mons-Match-IP": "192.0.2.1",
          "X-Mons-Match-Revision": String(value.snapshot.revision),
          "X-Mons-Match-Protected": "0",
          "X-Mons-Match-Authenticated": "1",
          ...socketTestSessionHeaders(),
          ...overrides,
        },
      }),
    ),
  );
}

async function runNextAlarm(room: Room) {
  const next = await runInDurableObject(room, (_instance, state) =>
    state.storage.getAlarm(),
  );
  if (next !== null && next > Date.now())
    vi.spyOn(Date, "now").mockReturnValue(next);
  return runDurableObjectAlarm(room);
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
  vi.restoreAllMocks();
});

describe("live match snapshots", () => {
  it("sanitizes, shares reads and persists revisions across eviction", async () => {
    const { room, inviteId, source } = await fixture();
    const first = await room.readMatches(inviteId, inviteId);
    expect(first).toMatchObject({
      status: "ok",
      snapshot: { revision: 1, hostMatch: match },
    });
    expect(
      first.status === "ok" && first.snapshot.hostMatch,
    ).not.toHaveProperty("sessionCreation");
    const [same, again] = await Promise.all([
      room.readMatches(inviteId, inviteId),
      room.readMatches(inviteId, inviteId),
    ]);
    expect(same).toEqual(first);
    expect(again).toEqual(first);
    expect(source.reads).toHaveLength(2);
    await room.notifyMatchesChanged(inviteId, [inviteId]);
    expect(await room.readMatches(inviteId, inviteId)).toEqual(first);
    source.matches.set(`host-login/${inviteId}`, {
      ...match,
      flatMovesString: "a-b",
      fen: "later",
    });
    await evictDurableObject(room);
    await install(room, source);
    const latest = await room.readMatches(inviteId, inviteId);
    expect(latest).toMatchObject({
      status: "ok",
      snapshot: { revision: 2, hostMatch: { fen: "later" } },
    });
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeNull();
  });

  it("delivers guest creation, moves, timer and status updates and supports read-only heartbeat", async () => {
    const { room, inviteId, source } = await fixture(false);
    const channel = await connect(room, inviteId);
    expect(await channel.snapshot()).toMatchObject({
      guestPlayerId: null,
      guestMatch: null,
    });
    source.invite.guestId = "guest-login";
    source.matches.set(`guest-login/${inviteId}`, { ...match, color: "black" });
    await room.notifyMetadataChanged(inviteId);
    await runNextAlarm(room);
    expect(await channel.snapshot()).toMatchObject({
      guestPlayerId: "guest-login",
      guestMatch: { color: "black" },
      revision: 2,
    });
    source.matches.set(`guest-login/${inviteId}`, {
      ...match,
      color: "black",
      flatMovesString: "a-z-b",
      fen: "later",
      timer: "claimed",
      status: "surrendered",
    });
    await room.notifyMatchesChanged(inviteId, [inviteId]);
    await runNextAlarm(room);
    expect(await channel.snapshot()).toMatchObject({
      guestMatch: {
        flatMovesString: "a-z-b",
        timer: "claimed",
        status: "surrendered",
      },
      revision: 3,
    });
    channel.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await channel.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    const closed = new Promise<CloseEvent>((resolve) =>
      channel.socket.addEventListener("close", resolve, { once: true }),
    );
    channel.socket.send(JSON.stringify({ type: "move" }));
    expect((await closed).code).toBe(1008);
  });

  it("recovers lost notifications after one second and stops polling after the last subscriber", async () => {
    const { room, inviteId, source } = await fixture();
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    const due = await runInDurableObject(room, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(due! - Date.now()).toBeLessThanOrEqual(MATCH_SYNC_REFRESH_MS);
    source.matches.set(`guest-login/${inviteId}`, {
      ...match,
      color: "black",
      fen: "changed",
      flatMovesString: "x",
    });
    await runNextAlarm(room);
    expect(await channel.snapshot()).toMatchObject({
      revision: 2,
      guestMatch: { fen: "changed" },
    });
    await close(channel.socket);
    const reads = source.reads.length;
    await runNextAlarm(room);
    expect(source.reads).toHaveLength(reads);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeNull();
  });

  it("keeps match and metadata polling cadences separate in the shared alarm", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const { room, inviteId, source } = await fixture();
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    const metadata = await room.readMetadata(inviteId);
    if (metadata.status !== "ok") throw new Error("metadata-missing");
    const metadataChannel = accept(
      await room.fetch(
        new Request("https://room.internal/metadata/socket", {
          headers: {
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": INVITE_METADATA_SOCKET_PROTOCOL,
            "X-Mons-Metadata-Invite": inviteId,
            "X-Mons-Metadata-Role": "spectator",
            "X-Mons-Metadata-IP": "192.0.2.2",
            "X-Mons-Metadata-Revision": String(metadata.snapshot.revision),
            "X-Mons-Metadata-Protected": "0",
            "X-Mons-Metadata-Authenticated": "0",
          },
        }),
      ),
    );
    await metadataChannel.read();
    const reads = source.metadataReads;
    source.invite.hostRematches = "1";
    for (let i = 0; i < 4; i++) await runNextAlarm(room);
    expect(source.metadataReads).toBe(reads);
    expect(metadataChannel.messages).toHaveLength(0);
    await runNextAlarm(room);
    expect(
      JSON.parse(await metadataChannel.read()).snapshot.hostRematches,
    ).toBe("1");
    expect(source.metadataReads).toBe(reads + 1);
    await close(channel.socket);
    await runNextAlarm(room);
    const next = await runInDurableObject(room, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(next).not.toBeNull();
  });

  it("replaces in-flight stale source reads before returning a coalesced snapshot", async () => {
    const { room, inviteId, source } = await fixture();
    await runInDurableObject(room, async (instance) => {
      let started!: () => void;
      let release!: () => void;
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      source.read = async (playerId, matchId) => {
        const current = structuredClone(
          source.matches.get(`${playerId}/${matchId}`) ?? null,
        );
        if (!paused && playerId === "host-login") {
          paused = true;
          started();
          await gate;
        }
        return current;
      };
      const first = instance.readMatches(inviteId, inviteId);
      await began;
      source.matches.set(`host-login/${inviteId}`, {
        ...match,
        fen: "newest",
        flatMovesString: "a",
      });
      await instance.notifyMatchesChanged(inviteId, [inviteId]);
      const second = instance.readMatches(inviteId, inviteId);
      release();
      const results = await Promise.all([first, second]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({
        status: "ok",
        snapshot: { revision: 1, hostMatch: { fen: "newest" } },
      });
    });
  });

  it("preserves valid state on upstream failure and closes the socket for HTTP recovery", async () => {
    const { room, inviteId, source } = await fixture();
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    source.read = async () => {
      throw new Error("source-offline");
    };
    const closed = new Promise<CloseEvent>((resolve) =>
      channel.socket.addEventListener("close", resolve, { once: true }),
    );
    await room.notifyMatchesChanged(inviteId, [inviteId]);
    await runNextAlarm(room);
    expect((await closed).code).toBe(1011);
    expect(channel.messages).toHaveLength(0);
    const saved = await runInDurableObject(room, (_instance, state) =>
      state.storage.sql
        .exec<{ snapshot_json: string }>(
          "SELECT snapshot_json FROM match_sync_snapshots WHERE match_id = ?",
          inviteId,
        )
        .one(),
    );
    expect(JSON.parse(saved.snapshot_json)).toMatchObject({
      revision: 1,
      hostMatch: { fen: "initial" },
    });
    await runInDurableObject(room, async (instance) => {
      await expect(instance.readMatches(inviteId, inviteId)).rejects.toThrow(
        "source-offline",
      );
    });
    source.read = undefined;
    expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
      status: "ok",
      snapshot: { revision: 1 },
    });
  });

  it("keeps registered rematches independent and rejects unknown matches before source reads", async () => {
    const { room, inviteId, source } = await fixture();
    source.invite.hostRematches = "1";
    const nextMatchId = `${inviteId}1`;
    source.matches.set(`host-login/${nextMatchId}`, match);
    const channel = await connect(room, inviteId, nextMatchId);
    expect(await channel.snapshot()).toMatchObject({
      matchId: nextMatchId,
      hostMatch: match,
      guestMatch: null,
    });
    const reads = source.reads.length;
    expect(await room.readMatches(inviteId, `${inviteId}2`)).toEqual({
      status: "missing",
    });
    expect(source.reads).toHaveLength(reads);
    source.matches.set(`guest-login/${nextMatchId}`, {
      ...match,
      color: "black",
    });
    await room.notifyMatchesChanged(inviteId, [nextMatchId]);
    await runNextAlarm(room);
    expect(await channel.snapshot()).toMatchObject({
      matchId: nextMatchId,
      revision: 2,
      guestMatch: { color: "black" },
    });
    expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
      status: "ok",
      snapshot: { revision: 1 },
    });
  });

  it("restores subscribed match identity and refreshes canonical data after hibernation", async () => {
    const { room, inviteId, source } = await fixture();
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    await evictDurableObject(room);
    await install(room, source);
    source.matches.set(`guest-login/${inviteId}`, {
      ...match,
      color: "black",
      status: "surrendered",
    });
    await runNextAlarm(room);
    expect(await channel.snapshot()).toMatchObject({
      revision: 2,
      guestMatch: { status: "surrendered" },
    });
  });
});
