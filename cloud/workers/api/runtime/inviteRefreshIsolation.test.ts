import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVITE_METADATA_SOCKET_PROTOCOL } from "@mons/shared/invite-metadata";
import { INVITE_WAGERS_SOCKET_PROTOCOL } from "@mons/shared/invite-wagers";
import { socketTestSessionHeaders } from "../test/socketTestSession.ts";
import type { WagerStateSnapshot } from "../src/wagerStateD1.ts";

type Instance = import("../src/inviteReactions.ts").InviteReactions;
type Room = DurableObjectStub<Instance>;
type Source = {
  metadata: Record<string, unknown>;
  count: number;
  wagerReads: number;
  metadataRead?: () => Promise<unknown>;
  wagerRead?: () => Promise<WagerStateSnapshot[]>;
};
type Stage = "reader" | "metadata" | "hash";

const rooms: Room[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("refresh blocked")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function wagerStates(inviteId: string, source: Source): WagerStateSnapshot[] {
  return [
    {
      inviteId,
      matchId: inviteId,
      wager: {
        proposals: {
          "host-login": {
            material: "dust",
            count: source.count,
            createdAt: 1_000,
          },
        },
      },
      resolutionMarker: null,
      revision: source.count,
    },
  ];
}

async function fixture() {
  const inviteId = `refresh-isolation-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  const source: Source = {
    metadata: {
      hostId: "host-login",
      hostColor: "white",
      guestId: "guest-login",
    },
    count: 3,
    wagerReads: 0,
  };
  rooms.push(room);
  await runInDurableObject(room, (instance) => {
    const target = instance as unknown as {
      inviteReader: () => Promise<unknown>;
      wagerReader: () => Promise<WagerStateSnapshot[]>;
    };
    target.inviteReader = async () =>
      source.metadataRead ? source.metadataRead() : source.metadata;
    target.wagerReader = async () => {
      source.wagerReads++;
      return source.wagerRead
        ? source.wagerRead()
        : wagerStates(inviteId, source);
    };
  });
  return { room, inviteId, source };
}

function block(stage: Stage, inviteId: string, source: Source) {
  const began = deferred();
  const release = deferred();
  if (stage === "hash") {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(
      async (...args) => {
        began.resolve();
        await release.promise;
        return digest(...args);
      },
    );
  } else if (stage === "metadata") {
    source.metadataRead = async () => {
      const captured = source.metadata;
      source.metadataRead = undefined;
      began.resolve();
      await release.promise;
      return captured;
    };
  } else {
    source.wagerRead = async () => {
      const captured = wagerStates(inviteId, source);
      source.wagerRead = undefined;
      began.resolve();
      await release.promise;
      return captured;
    };
  }
  return { began: began.promise, release: release.resolve };
}

function request(
  inviteId: string,
  channel: "metadata" | "wagers",
  revision = 1,
  role: "spectator" | "host" | "guest" = "spectator",
) {
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
      [`X-Mons-${name}-IP`]: "192.0.2.1",
      [`X-Mons-${name}-Revision`]: String(revision),
      [`X-Mons-${name}-Protected`]: "0",
      [`X-Mons-${name}-Authenticated`]: role === "spectator" ? "0" : "1",
      ...(role === "spectator"
        ? {}
        : { [`X-Mons-${name}-Actor`]: `${role}-login` }),
      ...socketTestSessionHeaders(),
    },
  });
}

function accept(response: Response) {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  const readers: ((value: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = String(event.data);
    const reader = readers.shift();
    if (reader) reader(message);
    else messages.push(message);
  });
  socket.accept();
  return {
    socket,
    messages,
    read: () =>
      promptly(
        messages.length
          ? Promise.resolve(messages.shift()!)
          : new Promise<string>((resolve) => readers.push(resolve)),
      ),
  };
}

function storedWagers(state: DurableObjectState) {
  return state.storage.sql
    .exec<{
      snapshot_json: string;
      source_fingerprint: string;
    }>(
      "SELECT snapshot_json, source_fingerprint FROM invite_wagers WHERE singleton = 1",
    )
    .one();
}

async function withSockets<T>(
  room: Room,
  work: (
    instance: Instance,
    state: DurableObjectState,
    open: typeof accept,
  ) => Promise<T>,
): Promise<T> {
  return runInDurableObject<Instance, T>(room, async (instance, state) => {
    const sockets: WebSocket[] = [];
    const open = (response: Response) => {
      const client = accept(response);
      sockets.push(client.socket);
      return client;
    };
    try {
      return await work(instance, state, open);
    } finally {
      await Promise.all(
        sockets.map((socket) => {
          if (socket.readyState === WebSocket.CLOSED) return;
          return new Promise<void>((resolve) => {
            socket.addEventListener("close", () => resolve(), { once: true });
            socket.close(1000, "Test complete");
            if (socket.readyState === WebSocket.CLOSED) resolve();
          });
        }),
      );
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
  vi.restoreAllMocks();
});

describe("invite refresh isolation", () => {
  it.each(["metadata", "wagers"] as const)(
    "preserves recovery when the first %s admission outlasts its scheduled alarm",
    async (channel) => {
      const { room, inviteId, source } = await fixture();
      await withSockets(room, async (instance, state, open) => {
        const gate = block(
          channel === "metadata" ? "metadata" : "reader",
          inviteId,
          source,
        );
        const admission = instance.fetch(request(inviteId, channel));
        let client!: ReturnType<typeof accept>;
        try {
          await promptly(gate.began);
          const scheduled = await state.storage.getAlarm();
          expect(scheduled).not.toBeNull();
          vi.spyOn(Date, "now").mockReturnValue(scheduled!);
          await state.storage.deleteAlarm();
          await promptly(instance.alarm());
        } finally {
          gate.release();
          client = open(await admission);
        }
        await client.read();
        const recovery = await state.storage.getAlarm();
        expect(recovery).not.toBeNull();
        expect(recovery!).toBeGreaterThan(Date.now());
        source.metadata = { ...source.metadata, hostRematches: "1" };
        source.count = 5;
        vi.spyOn(Date, "now").mockReturnValue(recovery!);
        await state.storage.deleteAlarm();
        await promptly(instance.alarm());
        expect(JSON.parse(await client.read()).snapshot).toMatchObject(
          channel === "metadata"
            ? { revision: 2, hostRematches: "1" }
            : {
                revision: 2,
                wagers: {
                  [inviteId]: { proposals: { "host-login": { count: 5 } } },
                },
              },
        );
        expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      });
    },
  );

  it.each(["metadata", "wagers"] as const)(
    "stops recovery after a pending %s admission is rejected without subscribers",
    async (channel) => {
      const { room, inviteId, source } = await fixture();
      await withSockets(room, async (instance, state, open) => {
        const gate = block(
          channel === "metadata" ? "metadata" : "reader",
          inviteId,
          source,
        );
        const admission = instance.fetch(request(inviteId, channel, 2));
        try {
          await promptly(gate.began);
          const scheduled = await state.storage.getAlarm();
          expect(scheduled).not.toBeNull();
          vi.spyOn(Date, "now").mockReturnValue(scheduled!);
          await state.storage.deleteAlarm();
          await promptly(instance.alarm());
        } finally {
          gate.release();
          const response = await admission;
          if (response.status === 101) open(response);
        }
        expect((await admission).status).toBe(409);
        expect(state.getWebSockets()).toHaveLength(0);
        const recovery = await state.storage.getAlarm();
        if (recovery !== null) {
          vi.spyOn(Date, "now").mockReturnValue(recovery);
          await state.storage.deleteAlarm();
          await promptly(instance.alarm());
        }
        expect(await state.storage.getAlarm()).toBeNull();
      });
    },
  );

  it.each([
    ["metadata", "metadata"],
    ["wagers", "metadata"],
    ["wagers", "wagers"],
  ] as const)(
    "admits %s sockets while unchanged %s reads continue",
    async (channel, reader) => {
      const { room, inviteId, source } = await fixture();
      await withSockets(room, async (instance, _state, open) => {
        let reading = true;
        let accepted = false;
        const pending: Promise<unknown>[] = [];
        source.metadataRead = async () => {
          if (reading) {
            pending.push(
              reader === "metadata"
                ? instance.readMetadata(inviteId)
                : instance.readWagers(inviteId),
            );
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          return { ...source.metadata };
        };
        const admission = instance.fetch(request(inviteId, channel));
        try {
          const client = open(await promptly(admission));
          accepted = true;
          expect(JSON.parse(await client.read()).snapshot.revision).toBe(1);
          expect(pending.length).toBeGreaterThan(reader === "metadata" ? 1 : 0);
        } finally {
          reading = false;
          source.metadataRead = undefined;
          await Promise.allSettled(pending);
          const response = await admission;
          if (!accepted && response.status === 101) open(response);
        }
      });
    },
  );

  it.each(["reader", "hash"] as const)(
    "completes metadata reads, admissions and committed notifications while the wager %s is blocked",
    async (stage) => {
      const { room, inviteId, source } = await fixture();
      await withSockets(room, async (instance, state, open) => {
        const wager = open(await instance.fetch(request(inviteId, "wagers")));
        await wager.read();
        const stored = storedWagers(state);
        const gate = block(stage, inviteId, source);
        const pending = instance.readWagers(inviteId);
        try {
          await promptly(gate.began);
          source.metadata = { ...source.metadata, hostRematches: "1" };
          expect(await promptly(instance.readMetadata(inviteId))).toMatchObject(
            {
              status: "ok",
              snapshot: { revision: 2, hostRematches: "1" },
            },
          );
          const metadata = open(
            await promptly(instance.fetch(request(inviteId, "metadata", 2))),
          );
          expect(JSON.parse(await metadata.read()).snapshot.hostRematches).toBe(
            "1",
          );
          source.metadata = { ...source.metadata, hostRematches: "2" };
          await promptly(instance.notifySessionCommitted(inviteId));
          expect(JSON.parse(await metadata.read()).snapshot).toMatchObject({
            revision: 3,
            hostRematches: "2",
          });
          expect(storedWagers(state)).toEqual(stored);
          expect(wager.messages).toEqual([]);
        } finally {
          gate.release();
          await pending;
        }
      });
    },
  );

  it.each([
    ["reader", "spectator"],
    ["hash", "spectator"],
    ["reader", "host"],
    ["hash", "host"],
    ["reader", "guest"],
    ["hash", "guest"],
  ] as const)(
    "revokes %s-blocked %s access before releasing wager admission",
    async (stage, role) => {
      const { room, inviteId, source } = await fixture();
      await withSockets(room, async (instance, state, open) => {
        const wager = open(
          await instance.fetch(request(inviteId, "wagers", 1, role)),
        );
        await wager.read();
        const closed = new Promise<number>((resolve) =>
          wager.socket.addEventListener(
            "close",
            (event) => resolve(event.code),
            { once: true },
          ),
        );
        const stored = storedWagers(state);
        const gate = block(stage, inviteId, source);
        const admission = instance.fetch(request(inviteId, "wagers", 1, role));
        try {
          await promptly(gate.began);
          source.metadata = {
            ...source.metadata,
            ...(role === "spectator"
              ? { guestId: null, password: "private" }
              : { [`${role}Id`]: `new-${role}` }),
          };
          expect(await promptly(instance.readMetadata(inviteId))).toMatchObject(
            { status: "ok", snapshot: { revision: 2 } },
          );
          expect(await promptly(closed)).toBe(1008);
          expect(storedWagers(state)).toEqual(stored);
          expect(wager.messages).toEqual([]);
        } finally {
          gate.release();
          const response = await admission;
          if (response.status === 101) open(response);
          expect([403, 409]).toContain(response.status);
        }
      });
    },
  );

  it("retries changed metadata after hashing without publishing or admitting a superseded wager snapshot", async () => {
    const { room, inviteId, source } = await fixture();
    await withSockets(room, async (instance, _state, open) => {
      const wager = open(await instance.fetch(request(inviteId, "wagers")));
      await wager.read();
      source.count = 5;
      const gate = block("hash", inviteId, source);
      const admission = instance.fetch(request(inviteId, "wagers", 2));
      try {
        await promptly(gate.began);
        source.count = 7;
        source.metadata = { ...source.metadata, hostRematches: "1" };
        await promptly(instance.readMetadata(inviteId));
      } finally {
        gate.release();
        const client = open(await admission);
        expect(JSON.parse(await client.read()).snapshot).toMatchObject({
          revision: 2,
          wagers: { [inviteId]: { proposals: { "host-login": { count: 7 } } } },
        });
      }
      expect(JSON.parse(await wager.read()).snapshot).toMatchObject({
        revision: 2,
        wagers: { [inviteId]: { proposals: { "host-login": { count: 7 } } } },
      });
      expect(wager.messages).toEqual([]);
    });
    expect(source.wagerReads).toBe(3);
  });

  it("keeps stable metadata reads from restarting in-flight wager reads or hashing", async () => {
    const { room, inviteId, source } = await fixture();
    await withSockets(room, async (instance, _state, open) => {
      const wager = open(await instance.fetch(request(inviteId, "wagers")));
      await wager.read();
      source.count = 5;
      const gate = block("hash", inviteId, source);
      const pending = instance.readWagers(inviteId);
      try {
        await promptly(gate.began);
        for (let index = 0; index < 3; index++) {
          expect(await promptly(instance.readMetadata(inviteId))).toMatchObject(
            {
              status: "ok",
              passwordProtected: false,
              snapshot: { revision: 1 },
            },
          );
        }
        expect(source.wagerReads).toBe(2);
        expect(crypto.subtle.digest).toHaveBeenCalledTimes(1);
        expect(wager.messages).toEqual([]);
      } finally {
        gate.release();
        await pending;
      }
      expect(await pending).toMatchObject({
        status: "ok",
        snapshot: {
          revision: 2,
          wagers: { [inviteId]: { proposals: { "host-login": { count: 5 } } } },
        },
      });
      expect(JSON.parse(await wager.read()).snapshot.revision).toBe(2);
      expect(wager.messages).toEqual([]);
      expect(source.wagerReads).toBe(2);
      expect(crypto.subtle.digest).toHaveBeenCalledTimes(1);
    });
  });

  it("retries a hash after privacy changes and returns to the same public metadata revision", async () => {
    const { room, inviteId, source } = await fixture();
    await withSockets(room, async (instance, state, open) => {
      const wager = open(await instance.fetch(request(inviteId, "wagers")));
      await wager.read();
      const stored = storedWagers(state);
      source.count = 5;
      const gate = block("hash", inviteId, source);
      const admission = instance.fetch(request(inviteId, "wagers", 2));
      try {
        await promptly(gate.began);
        source.count = 7;
        source.metadata = { ...source.metadata, password: "private" };
        expect(await promptly(instance.readMetadata(inviteId))).toMatchObject({
          status: "ok",
          passwordProtected: true,
          snapshot: { revision: 1 },
        });
        source.metadata = { ...source.metadata };
        delete source.metadata.password;
        expect(await promptly(instance.readMetadata(inviteId))).toMatchObject({
          status: "ok",
          passwordProtected: false,
          snapshot: { revision: 1 },
        });
        expect(storedWagers(state)).toEqual(stored);
        expect(wager.messages).toEqual([]);
      } finally {
        gate.release();
        const client = open(await admission);
        expect(JSON.parse(await client.read()).snapshot).toMatchObject({
          revision: 2,
          wagers: { [inviteId]: { proposals: { "host-login": { count: 7 } } } },
        });
      }
      expect(JSON.parse(await wager.read()).snapshot).toMatchObject({
        revision: 2,
        wagers: { [inviteId]: { proposals: { "host-login": { count: 7 } } } },
      });
      expect(wager.messages).toEqual([]);
      expect(source.wagerReads).toBe(3);
      expect(crypto.subtle.digest).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["reader", "metadata", "hash"] as const)(
    "discards an invalidation during wager %s work and coalesces newer queued readers",
    async (stage) => {
      const { room, inviteId, source } = await fixture();
      await room.readWagers(inviteId);
      source.count = 5;
      const results = await runInDurableObject(room, async (instance) => {
        const gate = block(stage, inviteId, source);
        const pending = [instance.readWagers(inviteId)];
        try {
          await promptly(gate.began);
          source.count = 7;
          await promptly(instance.notifyWagersChanged(inviteId));
          pending.push(
            instance.readWagers(inviteId),
            instance.readWagers(inviteId),
          );
        } finally {
          gate.release();
          await Promise.allSettled(pending);
        }
        return Promise.all(pending);
      });
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
      expect(source.wagerReads).toBe(4);
    },
  );
});
