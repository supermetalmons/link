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
import { INVITE_WAGERS_SOCKET_PROTOCOL } from "@mons/shared/invite-wagers";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
} from "@mons/shared/reactions";
import type { InviteReactions } from "../src/inviteReactions.ts";
import type { MatchSyncMetadata } from "../src/matchSync.ts";
import type {
  MatchStatePair,
  MatchStateRecord,
} from "../src/matchStateTypes.ts";
import { MATCH_SYNC_REPAIR_MS } from "../src/matchSyncRoom.ts";
import { GameSessionTransitionFailure } from "../src/gameSessionCodec.ts";

type Room = DurableObjectStub<InviteReactions>;
type Source = {
  invite: Record<string, unknown>;
  matches: Map<string, MatchStateRecord>;
  revisions: Map<string, number>;
  reads: string[];
  metadataReads: number;
  wagerReads: number;
  epoch: number;
  read?: (
    playerId: string,
    matchId: string,
  ) => Promise<MatchStateRecord | null>;
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

function setMatch(source: Source, key: string, value: MatchStateRecord) {
  source.matches.set(key, value);
  const matchId = key.slice(key.indexOf("/") + 1);
  source.revisions.set(matchId, (source.revisions.get(matchId) ?? 0) + 1);
}

function trackSnapshotSerialization(matchId: string) {
  const stringify = vi.spyOn(JSON, "stringify");
  return () =>
    stringify.mock.calls.filter(
      ([value]) =>
        value?.type === "snapshot" && value?.snapshot?.matchId === matchId,
    ).length;
}

async function install(room: Room, source: Source) {
  await runInDurableObject(room, (instance) => {
    const mutable = instance as unknown as {
      inviteReader: () => Promise<unknown>;
      wagerReader: () => Promise<never>;
      matchSync: {
        readPair: (
          metadata: MatchSyncMetadata,
          matchId: string,
        ) => Promise<MatchStatePair>;
        dependencies: { sourceEpoch: () => number };
      };
    };
    mutable.inviteReader = async () => {
      source.metadataReads++;
      return structuredClone(source.invite);
    };
    mutable.wagerReader = async () => {
      source.wagerReads++;
      throw new Error("unexpected-wager-read");
    };
    mutable.matchSync.dependencies.sourceEpoch = () => source.epoch;
    const readMatch = async (playerId: string, matchId: string) => {
      source.reads.push(`${playerId}/${matchId}`);
      return source.read
        ? source.read(playerId, matchId)
        : structuredClone(source.matches.get(`${playerId}/${matchId}`) ?? null);
    };
    mutable.matchSync.readPair = async (metadata, matchId) => {
      const epoch = source.epoch;
      const revision = source.revisions.get(matchId) ?? 0;
      const [playerMatch, opponentMatch] = await Promise.all([
        readMatch(metadata.snapshot.hostId, matchId),
        metadata.snapshot.guestId === null
          ? null
          : readMatch(metadata.snapshot.guestId, matchId),
      ]);
      return {
        inviteId: metadata.snapshot.inviteId,
        matchId,
        playerId: metadata.snapshot.hostId,
        opponentId: metadata.snapshot.guestId,
        epoch,
        revision,
        playerMatch,
        opponentMatch,
        claim: null,
      };
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
              MatchStateRecord,
            ],
          ]
        : []),
    ]),
    revisions: new Map(),
    reads: [],
    metadataReads: 0,
    wagerReads: 0,
    epoch: 1,
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
  it.each(["forced", "notification", "alarm"] as const)(
    "reuses an unchanged projection during a %s refresh while reading canonical state",
    async (refresh) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      const { room, inviteId, source } = await fixture();
      const channel = await connect(room, inviteId);
      const initial = await channel.snapshot();
      const serializations = trackSnapshotSerialization(inviteId);
      const reads = source.reads.length;
      if (refresh === "forced") {
        expect(
          await room.readMatches(inviteId, inviteId, { fresh: true }),
        ).toMatchObject({ snapshot: initial });
      } else {
        if (refresh === "notification")
          await room.notifyMatchesChanged(inviteId, [inviteId]);
        await runNextAlarm(room);
      }
      expect(source.reads).toHaveLength(reads + 2);
      expect(serializations()).toBe(0);
      expect(channel.messages).toHaveLength(0);
      expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
        snapshot: initial,
      });
      expect(
        await runInDurableObject(room, (_instance, state) =>
          state.storage.getAlarm(),
        ),
      ).not.toBeNull();
    },
  );

  it.each(["match", "metadata", "epoch"] as const)(
    "rebuilds after a %s version change while preserving an unchanged public revision",
    async (changed) => {
      const { room, inviteId, source } = await fixture();
      const initial = await room.readMatches(inviteId, inviteId);
      const serializations = trackSnapshotSerialization(inviteId);
      if (changed === "match") {
        setMatch(source, `host-login/${inviteId}`, {
          ...match,
          sessionCreation: { private: "changed" },
        });
      } else if (changed === "metadata") {
        source.invite.hostRematches = "1";
      } else {
        source.epoch++;
      }
      const refreshed = await room.readMatches(inviteId, inviteId, {
        fresh: true,
      });
      expect(refreshed.status).toBe("ok");
      if (refreshed.status !== "ok" || initial.status !== "ok")
        throw new Error("fixture-match-missing");
      expect(refreshed.snapshot).toEqual(initial.snapshot);
      expect(serializations()).toBeGreaterThan(0);
      const rebuilt = serializations();
      const reads = source.reads.length;
      await room.readMatches(inviteId, inviteId, { fresh: true });
      expect(source.reads).toHaveLength(reads + 2);
      expect(serializations()).toBe(rebuilt);
    },
  );

  it("revalidates password-only access changes without rebuilding the projection", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const { room, inviteId, source } = await fixture(false);
    const channel = await connect(room, inviteId, inviteId, {
      "X-Mons-Match-Role": "spectator",
      "X-Mons-Match-Actor": "",
    });
    await channel.snapshot();
    const initial = await room.readMatches(inviteId, inviteId);
    if (initial.status !== "ok") throw new Error("fixture-match-missing");
    const serializations = trackSnapshotSerialization(inviteId);
    const closed = new Promise<CloseEvent>((resolve) =>
      channel.socket.addEventListener("close", resolve, { once: true }),
    );
    source.invite.password = "private";
    await room.notifyMetadataChanged(inviteId);
    await runNextAlarm(room);
    expect((await closed).code).toBe(1008);
    expect(channel.messages).toHaveLength(0);
    expect(serializations()).toBe(0);
    expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
      snapshot: initial.snapshot,
      metadata: {
        passwordProtected: true,
        snapshot: { revision: initial.metadata.snapshot.revision },
      },
    });
  });

  it("publishes committed metadata and matches inline while wager work is blocked", async () => {
    const { room, inviteId, source } = await fixture(false);
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
            "X-Mons-Metadata-Role": "host",
            "X-Mons-Metadata-Actor": "host-login",
            "X-Mons-Metadata-IP": "192.0.2.1",
            "X-Mons-Metadata-Revision": String(metadata.snapshot.revision),
            "X-Mons-Metadata-Protected": "0",
            "X-Mons-Metadata-Authenticated": "1",
            ...socketTestSessionHeaders(),
          },
        }),
      ),
    );
    await metadataChannel.read();
    await runInDurableObject(room, async (instance) => {
      let began!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (began = resolve));
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const mutable = instance as unknown as {
        wagerReader: () => Promise<[]>;
      };
      mutable.wagerReader = async () => {
        began();
        await blocked;
        return [];
      };
      const wagers = instance.readWagers(inviteId);
      await entered;
      try {
        source.invite.guestId = "guest-login";
        setMatch(source, `guest-login/${inviteId}`, {
          ...match,
          color: "black",
        });
        const reads = source.metadataReads;
        await instance.notifySessionCommitted(inviteId);
        expect(source.metadataReads).toBe(reads + 1);
      } finally {
        release();
        await wagers;
      }
    });
    expect(JSON.parse(await metadataChannel.read()).snapshot).toMatchObject({
      guestId: "guest-login",
      revision: 2,
    });
    expect(await channel.snapshot()).toMatchObject({
      guestPlayerId: "guest-login",
      guestMatch: { color: "black" },
      revision: 2,
    });
  });

  it("discards metadata read before a consolidated commit notification", async () => {
    const { room, inviteId, source } = await fixture(false);
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    const results = await runInDurableObject(room, async (instance) => {
      let began!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (began = resolve));
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const mutable = instance as unknown as {
        inviteReader: () => Promise<unknown>;
      };
      let first = true;
      mutable.inviteReader = async () => {
        const captured = structuredClone(source.invite);
        if (first) {
          first = false;
          began();
          await blocked;
        }
        return captured;
      };
      const older = instance.readMetadata(inviteId);
      await entered;
      try {
        source.invite.guestId = "guest-login";
        const notification = instance.notifySessionCommitted(inviteId);
        release();
        await notification;
      } finally {
        release();
      }
      return [await older, await instance.readMetadata(inviteId)];
    });
    for (const result of results) {
      expect(result).toMatchObject({
        status: "ok",
        snapshot: { guestId: "guest-login", revision: 2 },
      });
    }
  });

  it("invalidates an unsubscribed room without an unnecessary source read", async () => {
    const { room, inviteId, source } = await fixture(false);
    await room.readMatches(inviteId, inviteId);
    const reads = source.metadataReads;
    source.invite.guestId = "guest-login";
    await room.notifySessionCommitted(inviteId);
    expect(source.metadataReads).toBe(reads);
    expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
      status: "ok",
      snapshot: { guestPlayerId: "guest-login" },
    });
    expect(source.metadataReads).toBe(reads + 1);
  });

  it("repairs a failed inline commit refresh with the persisted alarm", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const { room, inviteId, source } = await fixture(false);
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    source.invite.guestId = "guest-login";
    setMatch(source, `guest-login/${inviteId}`, { ...match, color: "black" });
    await runInDurableObject(room, (instance) => {
      const mutable = instance as unknown as {
        inviteReader: () => Promise<unknown>;
      };
      mutable.inviteReader = async () => {
        throw new Error("source-offline");
      };
    });
    const failure = await runInDurableObject(room, async (instance) => {
      try {
        await instance.notifySessionCommitted(inviteId);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "unknown";
      }
    });
    expect(failure).toBe("source-offline");
    expect(channel.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(Date.now());
    await install(room, source);
    expect(await runNextAlarm(room)).toBe(true);
    expect(await channel.snapshot()).toMatchObject({
      guestPlayerId: "guest-login",
      guestMatch: { color: "black" },
      revision: 2,
    });
  });

  it("refreshes match metadata without reading wagers", async () => {
    const { room, inviteId, source } = await fixture();
    expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
      status: "ok",
    });
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    const reads = source.metadataReads;
    await room.notifyMetadataChanged(inviteId);
    await runNextAlarm(room);
    expect(source.metadataReads).toBeGreaterThan(reads);
    await evictDurableObject(room);
    await install(room, source);
    await runNextAlarm(room);
    expect(source.wagerReads).toBe(0);
  });

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
    setMatch(source, `host-login/${inviteId}`, {
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
    setMatch(source, `guest-login/${inviteId}`, { ...match, color: "black" });
    await room.notifyMetadataChanged(inviteId);
    await runNextAlarm(room);
    expect(await channel.snapshot()).toMatchObject({
      guestPlayerId: "guest-login",
      guestMatch: { color: "black" },
      revision: 2,
    });
    setMatch(source, `guest-login/${inviteId}`, {
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

  it("repairs lost notifications after five seconds and stops after the last subscriber", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { room, inviteId, source } = await fixture();
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    const due = await runInDurableObject(room, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(due).toBe(now + MATCH_SYNC_REPAIR_MS);
    setMatch(source, `guest-login/${inviteId}`, {
      ...match,
      color: "black",
      fen: "changed",
      flatMovesString: "x",
    });
    const initialReads = source.reads.length;
    clock.mockReturnValue(now + MATCH_SYNC_REFRESH_MS);
    await runDurableObjectAlarm(room);
    expect(source.reads).toHaveLength(initialReads);
    expect(channel.messages).toHaveLength(0);
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

  it("shares one metadata read when match and metadata repairs are due together", async () => {
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
    const matchReads = source.reads.length;
    source.invite.hostRematches = "1";
    await runNextAlarm(room);
    expect(
      JSON.parse(await metadataChannel.read()).snapshot.hostRematches,
    ).toBe("1");
    expect(source.metadataReads).toBe(reads + 1);
    expect(source.reads).toHaveLength(matchReads + 2);
    await close(channel.socket);
    await runNextAlarm(room);
    const next = await runInDurableObject(room, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(next).not.toBeNull();
  });

  it.each(["reader", "digest"] as const)(
    "refreshes cached metadata and matches during the same alarm while the wager %s is blocked",
    async (blockedWork) => {
      const now = Date.now() + 60_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const { room, inviteId, source } = await fixture(false);
      const channel = await connect(room, inviteId);
      await channel.snapshot();
      await runInDurableObject(room, (instance) => {
        const mutable = instance as unknown as {
          wagerReader: () => Promise<[]>;
        };
        mutable.wagerReader = async () => [];
      });
      const inviteChannels = await Promise.all(
        (["Metadata", "Wagers"] as const).map(async (name) => {
          const client = accept(
            await room.fetch(
              new Request(
                `https://room.internal/${name.toLowerCase()}/socket`,
                {
                  headers: {
                    Upgrade: "websocket",
                    "Sec-WebSocket-Protocol":
                      name === "Metadata"
                        ? INVITE_METADATA_SOCKET_PROTOCOL
                        : INVITE_WAGERS_SOCKET_PROTOCOL,
                    [`X-Mons-${name}-Invite`]: inviteId,
                    [`X-Mons-${name}-Role`]: "host",
                    [`X-Mons-${name}-Actor`]: "host-login",
                    [`X-Mons-${name}-IP`]: "192.0.2.1",
                    [`X-Mons-${name}-Revision`]: "1",
                    [`X-Mons-${name}-Protected`]: "0",
                    [`X-Mons-${name}-Authenticated`]: "1",
                    ...socketTestSessionHeaders(),
                  },
                },
              ),
            ),
          );
          await client.read();
          return client;
        }),
      );
      const metadataChannel = inviteChannels[0];
      clock.mockReturnValue(now + MATCH_SYNC_REPAIR_MS);
      expect(await room.readMetadata(inviteId)).toMatchObject({
        status: "ok",
        snapshot: { guestId: null, revision: 1 },
      });
      source.invite.guestId = "guest-login";
      setMatch(source, `guest-login/${inviteId}`, {
        ...match,
        color: "black",
      });
      await runInDurableObject(room, async (instance, state) => {
        let began!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => (began = resolve));
        const blocked = new Promise<void>((resolve) => (release = resolve));
        const metadataSend = vi.spyOn(
          state.getWebSockets("channel:metadata")[0],
          "send",
        );
        const matchSend = vi.spyOn(
          state.getWebSockets("channel:matches")[0],
          "send",
        );
        let restoreDigest: (() => void) | undefined;
        if (blockedWork === "reader") {
          const mutable = instance as unknown as {
            wagerReader: () => Promise<[]>;
          };
          mutable.wagerReader = async () => {
            began();
            await blocked;
            return [];
          };
        } else {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          const digestSpy = vi
            .spyOn(crypto.subtle, "digest")
            .mockImplementation(async (...args) => {
              began();
              await blocked;
              return digest(...args);
            });
          restoreDigest = () => digestSpy.mockRestore();
        }
        let settled = false;
        const alarm = instance.alarm().finally(() => {
          settled = true;
        });
        try {
          await Promise.race([
            entered,
            alarm.then(() => {
              throw new Error("alarm-completed-before-wager-work");
            }),
          ]);
          await expect
            .poll(() => [
              metadataSend.mock.calls.length,
              matchSend.mock.calls.length,
            ])
            .toEqual([1, 1]);
          expect(settled).toBe(false);
        } finally {
          release();
          await alarm;
          metadataSend.mockRestore();
          matchSend.mockRestore();
          restoreDigest?.();
        }
      });
      expect(JSON.parse(await metadataChannel.read()).snapshot).toMatchObject({
        guestId: "guest-login",
        revision: 2,
      });
      expect(await channel.snapshot()).toMatchObject({
        guestPlayerId: "guest-login",
        guestMatch: { color: "black" },
        revision: 2,
      });
    },
  );

  it("rechecks access at the repair deadline with only match subscribers", async () => {
    const { room, inviteId, source } = await fixture();
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    const closed = new Promise<CloseEvent>((resolve) =>
      channel.socket.addEventListener("close", resolve, { once: true }),
    );
    source.invite.hostId = "replacement-login";
    await runNextAlarm(room);
    expect((await closed).code).toBe(1008);
    expect(channel.messages).toHaveLength(0);
    expect(source.metadataReads).toBe(2);
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
      setMatch(source, `host-login/${inviteId}`, {
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

  for (const failure of ["metadata", "pair"] as const) {
    it(`retries a transient ${failure} read without closing its active socket`, async () => {
      const { room, inviteId, source } = await fixture();
      const channel = await connect(room, inviteId);
      await channel.snapshot();
      setMatch(source, `host-login/${inviteId}`, {
        ...match,
        fen: "recovered",
        flatMovesString: "a",
      });
      let attempts = 0;
      await runInDurableObject(room, async (instance) => {
        const mutable = instance as unknown as {
          matchSync: {
            dependencies: {
              readMetadata: (inviteId: string) => Promise<unknown>;
            };
            readPair: (
              metadata: MatchSyncMetadata,
              matchId: string,
            ) => Promise<MatchStatePair>;
          };
        };
        if (failure === "metadata") {
          const metadata = await instance.readMetadata(inviteId);
          mutable.matchSync.dependencies.readMetadata = async () => {
            if (++attempts === 1) throw new Error("temporary-invite-read");
            return metadata;
          };
        } else {
          const readPair = mutable.matchSync.readPair;
          mutable.matchSync.readPair = async (metadata, matchId) => {
            if (++attempts === 1) throw new Error("temporary-pair-read");
            return readPair(metadata, matchId);
          };
        }
        await instance.notifyMatchesChanged(inviteId, [inviteId]);
        expect(await instance.readMatches(inviteId, inviteId)).toMatchObject({
          status: "ok",
          snapshot: { revision: 2, hostMatch: { fen: "recovered" } },
        });
      });
      expect(attempts).toBe(2);
      expect(await channel.snapshot()).toMatchObject({
        revision: 2,
        hostMatch: { fen: "recovered" },
      });
      expect(channel.socket.readyState).toBe(WebSocket.OPEN);
    });
  }

  it.each(["notification", "alarm"] as const)(
    "keeps healthy sockets through a pending transition and recovers by %s",
    async (recovery) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      const { room, inviteId, source } = await fixture(false);
      const channel = await connect(room, inviteId);
      const initial = await channel.snapshot();
      let fenced = true;
      let attempts = 0;
      await runInDurableObject(room, (instance) => {
        const mutable = instance as unknown as {
          matchSync: {
            dependencies: {
              readMetadata: (inviteId: string) => Promise<unknown>;
            };
          };
        };
        const readMetadata = mutable.matchSync.dependencies.readMetadata;
        mutable.matchSync.dependencies.readMetadata = async (id) => {
          if (fenced) {
            attempts++;
            throw new GameSessionTransitionFailure("resource-pending");
          }
          return readMetadata(id);
        };
      });
      source.invite.guestId = "guest-login";
      setMatch(source, `guest-login/${inviteId}`, {
        ...match,
        color: "black",
      });
      await room.notifyMetadataChanged(inviteId);
      await runNextAlarm(room);
      expect(attempts).toBe(3);
      expect(channel.messages).toHaveLength(0);
      expect(channel.socket.readyState).toBe(WebSocket.OPEN);
      await runInDurableObject(room, async (instance, state) => {
        const saved = state.storage.sql
          .exec<{ snapshot_json: string; next_at_ms: number }>(
            "SELECT snapshot_json, next_at_ms FROM match_sync_snapshots WHERE match_id = ?",
            inviteId,
          )
          .one();
        expect(JSON.parse(saved.snapshot_json)).toEqual(initial);
        expect(saved.next_at_ms).toBe(Date.now() + MATCH_SYNC_REPAIR_MS);
        expect(await state.storage.getAlarm()).toBe(saved.next_at_ms);
        await expect(instance.readMatches(inviteId, inviteId)).rejects.toThrow(
          "game-session-transition-resource-pending",
        );
      });
      expect(attempts).toBe(6);
      await runDurableObjectAlarm(room);
      expect(attempts).toBe(6);
      expect(channel.messages).toHaveLength(0);
      expect(channel.socket.readyState).toBe(WebSocket.OPEN);
      fenced = false;
      if (recovery === "notification")
        await room.notifyMetadataChanged(inviteId);
      await runNextAlarm(room);
      expect(await channel.snapshot()).toMatchObject({
        revision: 2,
        guestPlayerId: "guest-login",
        guestMatch: { color: "black" },
      });
      expect(channel.socket.readyState).toBe(WebSocket.OPEN);
    },
  );

  it("does not retry malformed match snapshots as a transient source failure", async () => {
    const { room, inviteId, source } = await fixture();
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    setMatch(source, `host-login/${inviteId}`, { ...match, fen: null });
    const before = source.reads.length;
    const closed = new Promise<CloseEvent>((resolve) =>
      channel.socket.addEventListener("close", resolve, { once: true }),
    );
    await room.notifyMatchesChanged(inviteId, [inviteId]);
    await runNextAlarm(room);
    expect((await closed).code).toBe(1011);
    expect(source.reads.length - before).toBe(2);
    expect(channel.messages).toHaveLength(0);
  });

  it("preserves valid state on upstream failure and closes the socket for HTTP recovery", async () => {
    const { room, inviteId, source } = await fixture();
    const channel = await connect(room, inviteId);
    await channel.snapshot();
    const serializations = trackSnapshotSerialization(inviteId);
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
    expect(serializations()).toBe(0);
    source.read = undefined;
    expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
      status: "ok",
      snapshot: { revision: 1 },
    });
    expect(serializations()).toBeGreaterThan(0);
  });

  for (const completion of ["success", "failure"] as const) {
    it(`discards a legacy ${completion} after source activation without closing live sockets`, async () => {
      const { room, inviteId, source } = await fixture();
      const channel = await connect(room, inviteId);
      expect(await channel.snapshot()).toMatchObject({ revision: 1 });
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
          const value = structuredClone(
            source.matches.get(`${playerId}/${matchId}`) ?? null,
          );
          if (!paused && playerId === "host-login") {
            paused = true;
            started();
            await gate;
            if (completion === "failure") throw new Error("retired-source");
          }
          return value;
        };
        await instance.notifyMatchesChanged(inviteId, [inviteId]);
        const pending = instance.readMatches(inviteId, inviteId);
        await began;
        setMatch(source, `host-login/${inviteId}`, {
          ...match,
          fen: "canonical",
          flatMovesString: "canonical-move",
        });
        source.epoch++;
        release();
        expect(await pending).toMatchObject({
          status: "ok",
          snapshot: { revision: 2, hostMatch: { fen: "canonical" } },
        });
      });
      expect(await channel.snapshot()).toMatchObject({
        revision: 2,
        hostMatch: { fen: "canonical" },
      });
      expect(channel.socket.readyState).toBe(WebSocket.OPEN);
    });
  }

  it("invalidates a recent cached snapshot when the source epoch changes", async () => {
    const { room, inviteId, source } = await fixture();
    expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
      status: "ok",
      snapshot: { revision: 1 },
    });
    setMatch(source, `host-login/${inviteId}`, {
      ...match,
      fen: "activated",
      flatMovesString: "latest",
    });
    source.epoch++;
    expect(await room.readMatches(inviteId, inviteId)).toMatchObject({
      status: "ok",
      snapshot: { revision: 2, hostMatch: { fen: "activated" } },
    });
  });

  it("keeps registered rematches independent and rejects unknown matches before source reads", async () => {
    const { room, inviteId, source } = await fixture();
    source.invite.hostRematches = "1";
    const nextMatchId = `${inviteId}1`;
    setMatch(source, `host-login/${nextMatchId}`, match);
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
    setMatch(source, `guest-login/${nextMatchId}`, {
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
    setMatch(source, `guest-login/${inviteId}`, {
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
