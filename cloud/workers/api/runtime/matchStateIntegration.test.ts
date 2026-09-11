import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Game } from "mons-rules";
import { formatMatchTimer, MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import { MATCH_SYNC_SOCKET_PROTOCOL } from "@mons/shared/match-sync";
import type { InviteReactions } from "../src/inviteReactions.ts";
import type { MatchSyncMetadata } from "../src/matchSync.ts";
import type { MatchStateEffect } from "../src/matchStateTypes.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "../src/matchStateRpc.ts";
import { resolveMatchTimerGame } from "../src/matchTimer.ts";
import { socketTestSessionHeaders } from "../test/socketTestSession.ts";

type Room = DurableObjectStub<InviteReactions>;
const rooms: Room[] = [];
const sockets: WebSocket[] = [];
const match = {
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "standard",
  fen: new Game().toFen(),
  status: "",
  flatMovesString: "",
  timer: "",
};

async function installMetadata(room: Room) {
  await runInDurableObject(room, (instance) => {
    const target = instance as unknown as {
      inviteReader: () => Promise<unknown>;
    };
    target.inviteReader = async () => ({
      hostId: "host-login",
      guestId: "guest-login",
      hostColor: "white",
    });
  });
}

async function fixture(host = match, guest = { ...match, color: "black" }) {
  const inviteId = `canonical-room-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  rooms.push(room);
  await installMetadata(room);
  const input = {
    inviteId,
    epoch: 2,
    records: [
      {
        matchId: inviteId,
        playerId: "host-login",
        marker: "host-created",
        value: host,
      },
      {
        matchId: inviteId,
        playerId: "guest-login",
        marker: "guest-created",
        value: guest,
      },
    ],
  };
  return { room, rpc: getMatchStateRpc(env, inviteId), inviteId, input };
}

async function createMatches(
  input: Awaited<ReturnType<typeof fixture>>["input"],
) {
  const rpc = getMatchStateRpc(env, input.inviteId);
  return unwrapMatchStateRpc(await rpc.createCanonicalMatch(input));
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

describe("canonical match room integration", () => {
  it("merges transactional effect and room alarms without delaying the earlier work", async () => {
    const { room } = await fixture();
    await runInDurableObject(room, async (instance, state) => {
      const target = instance as unknown as {
        scheduleInviteAlarm: (
          atMs: number,
          transaction?: DurableObjectTransaction,
        ) => Promise<void>;
      };
      const earlier = Date.now() + 1_000;
      const later = earlier + 60_000;
      await Promise.all([
        target.scheduleInviteAlarm(later),
        state.storage.transaction((transaction) =>
          target.scheduleInviteAlarm(earlier, transaction),
        ),
        target.scheduleInviteAlarm(later + 60_000),
      ]);
      expect(await state.storage.getAlarm()).toBe(earlier);
    });
  });

  it("keeps empty rooms unavailable and serializes typed failures across RPC", async () => {
    const { rpc, inviteId, input } = await fixture();
    expect(
      await rpc.readCanonicalMatchRecord({
        inviteId,
        epoch: 2,
        matchId: inviteId,
        playerId: "host-login",
      }),
    ).toEqual({
      ok: false,
      status: 503,
      code: "unavailable",
      message: "match-state-authority-unavailable",
    });
    await createMatches(input);
    expect(
      unwrapMatchStateRpc(
        await rpc.readCanonicalMatchPair({
          inviteId,
          epoch: 2,
          matchId: inviteId,
          playerId: "host-login",
          opponentId: "guest-login",
        }),
      ),
    ).toMatchObject({ playerMatch: match, opponentMatch: { color: "black" } });
    expect(
      await rpc.readCanonicalMatchRecord({
        inviteId,
        epoch: 1,
        matchId: inviteId,
        playerId: "host-login",
      }),
    ).toMatchObject({ ok: false, status: 503, code: "unavailable" });
  });

  it("preserves live snapshot revisions and sockets when canonical records are initialized", async () => {
    const { room, rpc, inviteId, input } = await fixture();
    await runInDurableObject(room, (instance) => {
      const target = instance as unknown as {
        matchSync: {
          readPair: (
            metadata: MatchSyncMetadata,
            matchId: string,
          ) => Promise<[unknown, unknown]>;
        };
      };
      target.matchSync.readPair = async () => [
        match,
        { ...match, color: "black" },
      ];
    });
    const initial = await room.readMatches(inviteId, inviteId);
    if (initial.status !== "ok") throw new Error("missing-fixture");
    const response = await room.fetch(
      new Request("https://room.internal/matches/socket", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": MATCH_SYNC_SOCKET_PROTOCOL,
          "X-Mons-Match-Invite": inviteId,
          "X-Mons-Match-Match": inviteId,
          "X-Mons-Match-Role": "host",
          "X-Mons-Match-Actor": "host-login",
          "X-Mons-Match-IP": "192.0.2.1",
          "X-Mons-Match-Revision": String(initial.snapshot.revision),
          "X-Mons-Match-Protected": "0",
          "X-Mons-Match-Authenticated": "1",
          ...socketTestSessionHeaders(),
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    sockets.push(socket);
    await createMatches(input);
    await runInDurableObject(room, (instance) => {
      const target = instance as unknown as {
        matchSync: {
          readPair: (
            metadata: MatchSyncMetadata,
            matchId: string,
          ) => Promise<[unknown, unknown]>;
          dependencies: {
            readPair: (
              metadata: MatchSyncMetadata,
              matchId: string,
            ) => Promise<[unknown, unknown]>;
          };
        };
      };
      target.matchSync.readPair = target.matchSync.dependencies.readPair;
    });
    expect(await room.readMatches(inviteId, inviteId)).toEqual(initial);
    unwrapMatchStateRpc(
      await rpc.surrenderCanonicalMatch({
        inviteId,
        matchId: inviteId,
        playerId: "host-login",
        epoch: 2,
      }),
    );
    const changed = await room.readMatches(inviteId, inviteId);
    expect(changed).toMatchObject({
      status: "ok",
      snapshot: {
        revision: initial.snapshot.revision + 1,
        hostMatch: { status: "surrendered" },
      },
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await evictDurableObject(room);
    await installMetadata(room);
    expect(await room.readMatches(inviteId, inviteId)).toEqual(changed);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("delivers durable timeout effects after eviction with no connected sockets", async () => {
    const host = { ...match, color: "black" };
    const guest = { ...match, color: "white" };
    const game = resolveMatchTimerGame(
      { ...host, color: "black" },
      { ...guest, color: "white" },
    );
    host.timer = formatMatchTimer(game.turnNumber, Date.now() - 1_000);
    const { room, rpc, inviteId, input } = await fixture(host, guest);
    await createMatches(input);
    let attempts = 0;
    await runInDurableObject(room, (instance) => {
      const target = instance as unknown as {
        deliverMatchEffect: (effect: MatchStateEffect) => Promise<void>;
      };
      target.deliverMatchEffect = async () => {
        attempts++;
        throw new Error("temporary-dispatch-failure");
      };
    });
    expect(
      unwrapMatchStateRpc(
        await rpc.claimCanonicalMatchTimer({
          inviteId,
          epoch: 2,
          matchId: inviteId,
          playerId: "host-login",
          opponentId: "guest-login",
          eventId: "event-one",
        }),
      ),
    ).toEqual({ ok: true });
    expect(attempts).toBe(1);
    const saved = await runInDurableObject(room, (_instance, state) => ({
      effect: state.storage.sql
        .exec<{
          next_at_ms: number;
          attempts: number;
          completed_at_ms: number | null;
        }>(
          "SELECT next_at_ms, attempts, completed_at_ms FROM match_state_effects",
        )
        .one(),
      sockets: state.getWebSockets().length,
    }));
    expect(saved.sockets).toBe(0);
    expect(saved.effect).toMatchObject({ attempts: 1, completed_at_ms: null });
    expect(
      unwrapMatchStateRpc(
        await rpc.readCanonicalMatchRecord({
          inviteId,
          epoch: 2,
          matchId: inviteId,
          playerId: "host-login",
        }),
      ),
    ).toMatchObject({ timer: MATCH_TIMER_TERMINAL });
    await evictDurableObject(room);
    await runInDurableObject(room, (instance) => {
      const target = instance as unknown as {
        deliverMatchEffect: (effect: MatchStateEffect) => Promise<void>;
      };
      target.deliverMatchEffect = async (effect) => {
        attempts++;
        expect(effect).toMatchObject({
          inviteId,
          matchId: inviteId,
          eventId: "event-one",
          reason: "timer-claimed",
          sourceKey: `timer:${inviteId}:${inviteId}`,
        });
      };
    });
    vi.spyOn(Date, "now").mockReturnValue(saved.effect.next_at_ms);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(attempts).toBe(2);
    expect(
      await runInDurableObject(room, async (_instance, state) => ({
        effect: state.storage.sql
          .exec<{ next_at_ms: number | null; completed_at_ms: number | null }>(
            "SELECT next_at_ms, completed_at_ms FROM match_state_effects",
          )
          .one(),
        alarm: await state.storage.getAlarm(),
      })),
    ).toMatchObject({
      effect: { next_at_ms: null, completed_at_ms: expect.any(Number) },
      alarm: null,
    });
  });
});
