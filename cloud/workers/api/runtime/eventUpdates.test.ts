import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EVENT_UPDATES_SOCKET_PROTOCOL,
  isEventUpdateMessage,
  type EventUpdateMessage,
} from "@mons/shared/events";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
} from "@mons/shared/reactions";
import type { EventUpdates } from "../src/eventUpdates.ts";
import { MAX_EVENT_UPDATE_SOCKETS_PER_USER } from "../src/eventUpdatesRoom.ts";
import { commitEventMutations } from "../src/eventD1.ts";
import { withEventWriteAdmission } from "../src/eventWriteAdmission.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import { socketTestSessionHeaders } from "../test/socketTestSession.ts";
import {
  activateCanonicalApplicationFixture,
  admittedApplicationRoom,
  rawApplicationRoom,
  runInAdmittedEventRoom,
} from "./applicationRoomFixture.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

type Room = DurableObjectStub<EventUpdates>;
const rooms: Room[] = [];
const sockets: WebSocket[] = [];
const epoch = env.EVENT_DB_BOOKMARK_EPOCH;

async function fixture() {
  const eventId = `event-updates-${crypto.randomUUID()}`;
  const room = admittedApplicationRoom(
    env.EVENT_UPDATES.getByName(eventId),
    "EVENT_UPDATES",
  );
  rooms.push(room);
  await room.notifyEventChanged(eventId, epoch, 0);
  return { eventId, room };
}

function socketRequest(
  eventId: string,
  uid = "viewer-one",
  overrides: Record<string, string> = {},
) {
  return new Request("https://room.internal/events/socket", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": EVENT_UPDATES_SOCKET_PROTOCOL,
      "X-Mons-Event-Id": encodeURIComponent(eventId),
      "X-Mons-Event-User": encodeURIComponent(uid),
      "X-Mons-Event-IP": "192.0.2.1",
      ...socketTestSessionHeaders(),
      ...overrides,
    },
  });
}

function accept(response: Response) {
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
    EVENT_UPDATES_SOCKET_PROTOCOL,
  );
  const socket = response.webSocket!;
  const messages: string[] = [];
  const readers: Array<(message: string) => void> = [];
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
    async hint(): Promise<EventUpdateMessage> {
      const message: unknown = JSON.parse(await read());
      if (!isEventUpdateMessage(message)) throw new Error("invalid-event-hint");
      return message;
    },
  };
}

async function connect(room: Room, eventId: string, uid = "viewer-one") {
  return accept(await room.fetch(socketRequest(eventId, uid)));
}

async function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.close(1000, "Test complete");
    if (socket.readyState === WebSocket.CLOSED) resolve();
  });
}

beforeAll(async () => {
  await activateCanonicalApplicationFixture();
  const fixtureEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
  await applyEventTestMigrations(
    env.EVENT_DB,
    fixtureEnv.TEST_EVENT_D1_MIGRATIONS,
  );
});

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(close));
  await Promise.all(
    rooms
      .splice(0)
      .map((room) =>
        runInDurableObject(rawApplicationRoom(room), (_instance, state) =>
          state.storage.deleteAlarm(),
        ),
      ),
  );
  vi.restoreAllMocks();
});

describe("event update rooms", () => {
  it("fans out committed revisions to all viewers and ignores duplicate, older and retired-epoch hints", async () => {
    const { room, eventId } = await fixture();
    const viewers = await Promise.all(
      ["current-player", "waiting-player", "event-spectator"].map((uid) =>
        connect(room, eventId, uid),
      ),
    );
    for (const viewer of viewers)
      expect(await viewer.hint()).toEqual({
        schemaVersion: 1,
        type: "event-changed",
        eventId,
        epoch,
        revision: 0,
      });
    await room.notifyEventChanged(eventId, epoch, 7);
    for (const viewer of viewers)
      expect((await viewer.hint()).revision).toBe(7);
    await room.notifyEventChanged(eventId, epoch, 7);
    await room.notifyEventChanged(eventId, epoch, 6);
    await room.notifyEventChanged(
      eventId,
      "11111111-1111-4111-8111-111111111111",
      99,
    );
    await room.notifyEventChanged(eventId, epoch, 8);
    for (const viewer of viewers)
      expect((await viewer.hint()).revision).toBe(8);
  });

  it("subscribes with a primary revision even when a notification was missed", async () => {
    const { room, eventId } = await fixture();
    await withEventWriteAdmission(
      env.EVENT_DB,
      { kind: "mutation", context: "event-root-patch" },
      (admission) =>
        commitEventMutations(
          env.EVENT_DB,
          [
            {
              kind: "event",
              eventId,
              value: eventDocumentFixture({
                eventId,
                status: "scheduled",
                createdAtMs: 1,
                updatedAtMs: 1,
                startAtMs: 2,
                participants: {},
              }),
            },
          ],
          { admission },
        ),
    );
    expect((await (await connect(room, eventId)).hint()).revision).toBe(1);
  });

  it("does not lose a notification delivered during the initial primary read", async () => {
    const { room, eventId } = await fixture();
    await runInAdmittedEventRoom(room, async (instance) => {
      const started = Promise.withResolvers<void>();
      const read = Promise.withResolvers<number>();
      const mutable = instance as unknown as {
        room: { dependencies: { readRevision: () => Promise<number> } };
      };
      mutable.room.dependencies.readRevision = async () => {
        started.resolve();
        return read.promise;
      };
      const opening = instance.fetch(socketRequest(eventId));
      await started.promise;
      await instance.notifyEventChanged(eventId, epoch, 4);
      read.resolve(3);
      const viewer = accept(await opening);
      try {
        expect((await viewer.hint()).revision).toBe(4);
        await instance.notifyEventChanged(eventId, epoch, 5);
        expect((await viewer.hint()).revision).toBe(5);
      } finally {
        await close(viewer.socket);
        sockets.splice(sockets.indexOf(viewer.socket), 1);
      }
    });
  });

  it("decodes escaped safe event and user identifiers without conflating room keys", async () => {
    const eventId = `event-👾-${crypto.randomUUID()}`;
    const room = admittedApplicationRoom(
      env.EVENT_UPDATES.getByName(eventId),
      "EVENT_UPDATES",
    );
    rooms.push(room);
    const viewer = await connect(room, eventId, "viewer-👾");
    expect((await viewer.hint()).eventId).toBe(eventId);
    await room.notifyEventChanged(eventId, epoch, 1);
    expect(await viewer.hint()).toMatchObject({ eventId, revision: 1 });
  });

  it("retains its revision and socket session attachments after hibernation", async () => {
    const { room, eventId } = await fixture();
    const viewer = await connect(room, eventId);
    await viewer.hint();
    await room.notifyEventChanged(eventId, epoch, 9);
    await viewer.hint();
    await evictDurableObject(rawApplicationRoom(room));
    viewer.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await viewer.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    await room.notifyEventChanged(eventId, epoch, 10);
    expect((await viewer.hint()).revision).toBe(10);
    const returning = await connect(room, eventId, "returning-viewer");
    expect((await returning.hint()).revision).toBe(10);
  });

  it("fails closed for missing, invalid and expired sessions", async () => {
    const { room, eventId } = await fixture();
    for (const headers of [
      { "X-Mons-Session-Id": "" },
      { "X-Mons-Session-Id": "invalid" },
      { "X-Mons-Session-Expires-At": String(Date.now() - 1) },
    ]) {
      const response = await room.fetch(
        socketRequest(eventId, "viewer", headers),
      );
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    await expect(
      rawApplicationRoom(room).fetch(socketRequest(eventId)),
    ).rejects.toThrow();
  });

  it("expires subscribed sessions and rejects writes on the receive-only channel", async () => {
    const { room, eventId } = await fixture();
    const expiresAt = Date.now() + 60_000;
    const viewer = accept(
      await room.fetch(
        socketRequest(eventId, "viewer", {
          "X-Mons-Session-Expires-At": String(expiresAt),
        }),
      ),
    );
    await viewer.hint();
    const expired = new Promise<CloseEvent>((resolve) =>
      viewer.socket.addEventListener("close", resolve, { once: true }),
    );
    vi.spyOn(Date, "now").mockReturnValue(expiresAt);
    await runDurableObjectAlarm(rawApplicationRoom(room));
    expect((await expired).code).toBe(4001);
    vi.restoreAllMocks();
    const sender = await connect(room, eventId, "sender");
    await sender.hint();
    const rejected = new Promise<CloseEvent>((resolve) =>
      sender.socket.addEventListener("close", resolve, { once: true }),
    );
    sender.socket.send(JSON.stringify({ revision: 999 }));
    expect((await rejected).code).toBe(1008);
  });

  it("bounds per-user sockets without blocking other viewers", async () => {
    const { room, eventId } = await fixture();
    for (let index = 0; index < MAX_EVENT_UPDATE_SOCKETS_PER_USER; index++)
      await (await connect(room, eventId)).hint();
    const rejected = await room.fetch(socketRequest(eventId));
    expect(rejected.status).toBe(429);
    await rejected.arrayBuffer();
    expect(
      (await (await connect(room, eventId, "other-viewer")).hint()).revision,
    ).toBe(0);
  });

  it("isolates event rooms and rejects invalid revision notifications", async () => {
    const { room, eventId } = await fixture();
    await expect(
      room.notifyEventChanged("other-event", epoch, 1),
    ).rejects.toThrow("event-updates-target-conflict");
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        room.notifyEventChanged(eventId, epoch, revision),
      ).rejects.toThrow("event-updates-notification-invalid");
    expect((await (await connect(room, eventId)).hint()).revision).toBe(0);
  });
});
