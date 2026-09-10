import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVITE_METADATA_SOCKET_PROTOCOL } from "@mons/shared/invite-metadata";
import { INVITE_WAGERS_SOCKET_PROTOCOL } from "@mons/shared/invite-wagers";
import { MATCH_SYNC_SOCKET_PROTOCOL } from "@mons/shared/match-sync";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_SOCKET_PROTOCOL,
  REACTION_SOCKET_PROTOCOL_V2,
} from "@mons/shared/reactions";
import type { InviteReactions } from "../src/inviteReactions.ts";
import { SOCKET_TEST_SESSION_ID } from "../test/socketTestSession.ts";

type Channel = "reactions" | "presentation" | "metadata" | "wagers" | "matches";
type Room = DurableObjectStub<InviteReactions>;
const channels: Channel[] = [
  "reactions",
  "presentation",
  "metadata",
  "wagers",
  "matches",
];
const rooms: Room[] = [];
const sockets: WebSocket[] = [];

async function fixture() {
  const inviteId = `session-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  rooms.push(room);
  await runInDurableObject(room, (instance) => {
    const mutable = instance as unknown as {
      inviteReader: () => Promise<unknown>;
      matchSync: { readMatch: (playerId: string) => Promise<unknown> };
    };
    mutable.inviteReader = async () => ({
      hostId: "host-login",
      guestId: "guest-login",
      hostColor: "white",
    });
    mutable.matchSync.readMatch = async (playerId) => ({
      version: 2,
      color: playerId === "host-login" ? "white" : "black",
      emojiId: 1,
      aura: "",
      gameVariant: "standard",
      fen: "initial",
      status: "",
      flatMovesString: "",
      timer: "",
    });
  });
  await room.ensurePresentations(inviteId, {
    "host-login": { emojiId: 1, aura: "" },
    "guest-login": { emojiId: 2, aura: "" },
  });
  return { room, inviteId };
}

function request(
  channel: Channel,
  inviteId: string,
  authExpiresAtMs: number | null,
  overrides: Record<string, string | null> = {},
) {
  const authenticated = authExpiresAtMs !== null;
  const role = authenticated ? "host" : "spectator";
  const headers = new Headers({ Upgrade: "websocket" });
  let path = "/socket";
  if (channel === "reactions" || channel === "presentation") {
    headers.set("X-Mons-Reaction-Role", role);
    headers.set(
      "Sec-WebSocket-Protocol",
      channel === "presentation"
        ? REACTION_SOCKET_PROTOCOL_V2
        : REACTION_SOCKET_PROTOCOL,
    );
    if (channel === "presentation")
      headers.set("X-Mons-Presentation-Match", inviteId);
  } else {
    const name =
      channel === "metadata"
        ? "Metadata"
        : channel === "wagers"
          ? "Wagers"
          : "Match";
    path = `/${channel}/socket`;
    headers.set(
      "Sec-WebSocket-Protocol",
      channel === "metadata"
        ? INVITE_METADATA_SOCKET_PROTOCOL
        : channel === "wagers"
          ? INVITE_WAGERS_SOCKET_PROTOCOL
          : MATCH_SYNC_SOCKET_PROTOCOL,
    );
    headers.set(`X-Mons-${name}-Invite`, inviteId);
    headers.set(`X-Mons-${name}-Role`, role);
    headers.set(`X-Mons-${name}-Revision`, "1");
    headers.set(`X-Mons-${name}-Protected`, "0");
    headers.set(`X-Mons-${name}-Authenticated`, authenticated ? "1" : "0");
    if (authenticated) headers.set(`X-Mons-${name}-Actor`, "host-login");
    if (channel === "matches") headers.set("X-Mons-Match-Match", inviteId);
  }
  if (authenticated) {
    headers.set("X-Mons-Session-Id", SOCKET_TEST_SESSION_ID);
    headers.set("X-Mons-Session-Expires-At", String(authExpiresAtMs));
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request(`https://room.internal${path}`, { headers });
}

async function connect(
  room: Room,
  channel: Channel,
  inviteId: string,
  authExpiresAtMs: number | null,
) {
  const response = await room.fetch(
    request(channel, inviteId, authExpiresAtMs),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  const readers: ((value: string) => void)[] = [];
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    });
  });
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
  await read();
  return { socket, messages, read, closed };
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
  await Promise.all(
    sockets.splice(0).map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close(1000, "Test complete");
        if (socket.readyState === WebSocket.CLOSED) resolve();
      });
    }),
  );
  vi.restoreAllMocks();
});

describe("socket session lifetime", () => {
  for (const channel of channels) {
    it(`${channel} admission requires a valid unexpired trusted session`, async () => {
      const { room, inviteId } = await fixture();
      const expiry = Date.now() + 300_000;
      const invalid: Record<string, string | null>[] = [
        { "X-Mons-Session-Id": null },
        { "X-Mons-Session-Id": "firebase-uid" },
        { "X-Mons-Session-Expires-At": null },
        { "X-Mons-Session-Expires-At": String(Date.now()) },
        { "X-Mons-Session-Expires-At": "1.5" },
        { "X-Mons-Session-Expires-At": String(Number.MAX_SAFE_INTEGER + 1) },
      ];
      for (const overrides of invalid) {
        const response = await room.fetch(
          request(channel, inviteId, expiry, overrides),
        );
        expect(response.status).toBe(401);
      }
      const client = await connect(room, channel, inviteId, expiry);
      expect(
        await runInDurableObject(room, (_instance, state) => {
          const attachment = state.getWebSockets()[0].deserializeAttachment();
          return {
            sid: attachment.sid,
            authExpiresAtMs: attachment.authExpiresAtMs,
          };
        }),
      ).toEqual({ sid: SOCKET_TEST_SESSION_ID, authExpiresAtMs: expiry });
      client.socket.send(REACTION_HEARTBEAT_REQUEST);
      expect(await client.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    });

    it(`${channel} expires before a heartbeat after hibernation while public spectators stay connected`, async () => {
      const { room, inviteId } = await fixture();
      const expiry = Date.now() + 300_000;
      const participant = await connect(room, channel, inviteId, expiry);
      const spectator = await connect(room, channel, inviteId, null);
      await evictDurableObject(room);
      vi.spyOn(Date, "now").mockReturnValue(expiry);
      participant.socket.send(REACTION_HEARTBEAT_REQUEST);
      expect(await participant.closed).toBe(4001);
      expect(participant.messages).toEqual([]);
      spectator.socket.send(REACTION_HEARTBEAT_REQUEST);
      expect(await spectator.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
    });

    it(`${channel} rejects legacy authenticated attachments on hibernation resume`, async () => {
      const { room, inviteId } = await fixture();
      const participant = await connect(
        room,
        channel,
        inviteId,
        Date.now() + 300_000,
      );
      const spectator = await connect(room, channel, inviteId, null);
      await runInDurableObject(room, (_instance, state) => {
        for (const socket of state.getWebSockets()) {
          const attachment = socket.deserializeAttachment();
          if (!attachment.authenticated) continue;
          delete attachment.sid;
          delete attachment.authExpiresAtMs;
          if (!attachment.channel) delete attachment.authenticated;
          socket.serializeAttachment(attachment);
        }
      });
      await evictDurableObject(room);
      spectator.socket.send(REACTION_HEARTBEAT_REQUEST);
      expect(await spectator.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
      expect(await participant.closed).toBe(4001);
      expect(participant.messages).toEqual([]);
    });
  }

  for (const channel of ["metadata", "wagers", "matches"] as const) {
    it(`${channel} admission rechecks expiry after the source read`, async () => {
      const { room, inviteId } = await fixture();
      const expiry = Date.now() + 300_000;
      const clock = vi.spyOn(Date, "now");
      const result = await runInDurableObject(room, async (instance, state) => {
        const mutable = instance as unknown as {
          inviteReader: () => Promise<unknown>;
        };
        mutable.inviteReader = async () => {
          clock.mockReturnValue(expiry);
          return {
            hostId: "host-login",
            guestId: "guest-login",
            hostColor: "white",
          };
        };
        const response = await instance.fetch(
          request(channel, inviteId, expiry),
        );
        return {
          status: response.status,
          sockets: state.getWebSockets().length,
        };
      });
      expect(result).toEqual({ status: 401, sockets: 0 });
    });
  }

  it("the shared alarm closes idle reaction sessions at their own deadlines", async () => {
    const { room, inviteId } = await fixture();
    const expiry = Date.now() + 300_000;
    const first = await connect(room, "reactions", inviteId, expiry);
    const second = await connect(
      room,
      "presentation",
      inviteId,
      expiry + 1_000,
    );
    const spectator = await connect(room, "reactions", inviteId, null);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(expiry);
    vi.spyOn(Date, "now").mockReturnValue(expiry);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await first.closed).toBe(4001);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(expiry + 1_000);
    vi.spyOn(Date, "now").mockReturnValue(expiry + 1_000);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await second.closed).toBe(4001);
    spectator.socket.send(REACTION_HEARTBEAT_REQUEST);
    expect(await spectator.read()).toBe(REACTION_HEARTBEAT_RESPONSE);
  });

  it("expired participants receive no reaction or presentation broadcasts", async () => {
    const { room, inviteId } = await fixture();
    const expiry = Date.now() + 300_000;
    const reaction = await connect(room, "reactions", inviteId, expiry);
    const presentation = await connect(room, "presentation", inviteId, expiry);
    const spectator = await connect(room, "presentation", inviteId, null);
    vi.spyOn(Date, "now").mockReturnValue(expiry);
    await room.publish("host-login", {
      uuid: crypto.randomUUID(),
      kind: "yo",
      variation: 1,
      matchId: inviteId,
    });
    expect(await reaction.closed).toBe(4001);
    expect(await presentation.closed).toBe(4001);
    expect(JSON.parse(await spectator.read()).type).toBe("reaction");
    await room.updatePresentation("host-login", inviteId, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      emojiId: 2,
      aura: "",
    });
    expect(JSON.parse(await spectator.read()).type).toBe("presentation");
    expect(reaction.messages).toEqual([]);
    expect(presentation.messages).toEqual([]);
  });
});
