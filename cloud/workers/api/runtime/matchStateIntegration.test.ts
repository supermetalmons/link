import {
  matchRecordFixture,
  matchDocumentFixture,
} from "../test/matchRecordFixture.ts";
import { unwrapMatchStateWireFixture } from "../test/matchRecordFixture.ts";
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Game } from "mons-rules";
import {
  formatMatchTimer,
  MATCH_TIMER_DURATION_MS,
  MATCH_TIMER_TERMINAL,
} from "@mons/shared/timers";
import { MATCH_SYNC_SOCKET_PROTOCOL } from "@mons/shared/match-sync";
import type { InviteReactions } from "../src/inviteReactions.ts";
import type {
  MatchStateEffect,
  MatchStateSyncReadRequest,
  MatchStateSyncReadResult,
} from "../src/matchStateTypes.ts";
import { getMatchStateRpc } from "../src/matchStateRpc.ts";
import { resolveMatchTimerGame } from "../src/matchTimer.ts";
import { socketTestSessionHeaders } from "../test/socketTestSession.ts";
import { AuthApiFailure } from "../src/authErrors.ts";
import type { MatchStateStore } from "../src/matchStateStore.ts";
import type { MatchSyncRoom } from "../src/matchSyncRoom.ts";
import type { InviteChannelsRoom } from "../src/inviteChannelsRoom.ts";

type Room = DurableObjectStub<InviteReactions>;
const rooms: Room[] = [];
const sockets: WebSocket[] = [];
const match = matchDocumentFixture({
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "standard",
  fen: new Game().toFen(),
  status: "",
  flatMovesString: "",
  timer: "",
});

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
  return unwrapMatchStateWireFixture(await rpc.createCanonicalMatch(input));
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
  it("preserves mutation notification targets and synchronous ordering", async () => {
    const { room, inviteId, input } = await fixture();
    await runInDurableObject(room, async (instance) => {
      const target = instance as unknown as {
        matchState: MatchStateStore;
        matchSync: MatchSyncRoom;
        inviteChannels: InviteChannelsRoom;
      };
      const events: string[] = [];
      const mutated = <T>(value: T): T => {
        events.push("mutation");
        return value;
      };
      vi.spyOn(target.inviteChannels, "pinInvite").mockImplementation((id) => {
        expect(id).toBe(inviteId);
        events.push("pin");
      });
      const notify = vi
        .spyOn(target.matchSync, "notify")
        .mockImplementation(async () => {
          events.push("notify");
        });
      const creation = {
        records: [],
        changedMatchIds: [inviteId, `${inviteId}1`],
      };
      const surrendered = {
        ok: true as const,
        inviteId,
        matchId: inviteId,
        actorUid: "host-login",
      };
      const moved = { ...surrendered, outcome: "applied" as const };
      const timer = {
        ok: true as const,
        timer: "1;90000",
        duration: MATCH_TIMER_DURATION_MS,
      } as const;
      const claimed = { ok: true as const };
      const applied = { records: [], changedMatchIds: [] };
      vi.spyOn(target.matchState, "createRecords").mockImplementation(() =>
        mutated(creation),
      );
      vi.spyOn(target.matchState, "move").mockImplementation(() =>
        mutated(moved),
      );
      vi.spyOn(target.matchState, "surrender").mockImplementation(() =>
        mutated(surrendered),
      );
      vi.spyOn(target.matchState, "startTimer").mockImplementation(async () =>
        mutated(timer),
      );
      vi.spyOn(target.matchState, "claimTimer").mockImplementation(async () =>
        mutated(claimed),
      );
      vi.spyOn(target.matchState, "applyEventEffects").mockImplementation(() =>
        mutated(applied),
      );
      const request = {
        inviteId,
        epoch: 2,
        matchId: inviteId,
        playerId: "host-login",
        opponentId: "guest-login",
      };
      const cases = [
        {
          run: () => instance.createCanonicalMatch(input),
          value: creation,
          ids: creation.changedMatchIds,
          immediate: true,
        },
        {
          run: () =>
            instance.submitCanonicalMove({
              ...request,
              previousFlatMovesString: "",
              flatMovesString: "",
              fen: match.fen,
            }),
          value: moved,
          ids: [inviteId],
          immediate: true,
        },
        {
          run: () => instance.surrenderCanonicalMatch(request),
          value: surrendered,
          ids: [inviteId],
          immediate: true,
        },
        {
          run: () => instance.startCanonicalMatchTimer(request),
          value: timer,
          ids: [inviteId],
          immediate: false,
        },
        {
          run: () => instance.claimCanonicalMatchTimer(request),
          value: claimed,
          ids: [inviteId],
          immediate: false,
        },
        {
          run: () =>
            instance.applyCanonicalMatchEventEffects({
              inviteId,
              epoch: 2,
              operationId: "effect",
            }),
          value: applied,
          ids: [],
          immediate: false,
        },
      ];
      for (const { run, value, ids, immediate } of cases) {
        events.length = 0;
        notify.mockClear();
        const pending = run();
        expect(events).toEqual(
          immediate ? ["pin", "mutation", "notify"] : ["pin", "mutation"],
        );
        await expect(pending).resolves.toEqual({ ok: true, value });
        expect(events).toEqual(["pin", "mutation", "notify"]);
        expect(notify).toHaveBeenCalledExactlyOnceWith(inviteId, ids);
      }
    });
  });

  it("serializes mutation failures without notifying subscribers", async () => {
    const { room, inviteId, input } = await fixture();
    await runInDurableObject(room, async (instance) => {
      const target = instance as unknown as {
        matchState: MatchStateStore;
        matchSync: MatchSyncRoom;
      };
      const failure = new AuthApiFailure(
        409,
        "failed-precondition",
        "mutation-conflict",
      );
      vi.spyOn(target.matchState, "createRecords").mockImplementation(() => {
        throw failure;
      });
      vi.spyOn(target.matchState, "startTimer").mockRejectedValue(failure);
      const notify = vi.spyOn(target.matchSync, "notify");
      const expected = {
        ok: false,
        status: 409,
        code: "failed-precondition",
        message: "mutation-conflict",
      };
      expect(await instance.createCanonicalMatch(input)).toEqual(expected);
      expect(
        await instance.startCanonicalMatchTimer({
          inviteId,
          epoch: 2,
          matchId: inviteId,
          playerId: "host-login",
          opponentId: "guest-login",
        }),
      ).toEqual(expected);
      expect(notify).not.toHaveBeenCalled();
    });
  });

  it("keeps invalid mutation inputs inside the RPC error boundary", async () => {
    const { room } = await fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runInDurableObject(room, async (instance) => {
      for (const method of [
        instance.createCanonicalMatch,
        instance.submitCanonicalMove,
        instance.surrenderCanonicalMatch,
        instance.startCanonicalMatchTimer,
        instance.claimCanonicalMatchTimer,
        instance.applyCanonicalMatchEventEffects,
      ]) {
        expect(await Reflect.apply(method, instance, [null])).toEqual({
          ok: false,
          status: 503,
          code: "unavailable",
          message: "match-state-unavailable",
        });
      }
    });
  });

  it("returns a committed mutation when subscriber notification fails", async () => {
    const { room, rpc, inviteId, input } = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await runInDurableObject(room, (instance) => {
      const target = instance as unknown as { matchSync: MatchSyncRoom };
      vi.spyOn(target.matchSync, "notify").mockRejectedValue(
        new Error("notification-failed"),
      );
    });
    const result = unwrapMatchStateWireFixture(
      await rpc.createCanonicalMatch(input),
    );
    expect(result.changedMatchIds).toEqual([inviteId]);
    expect(
      unwrapMatchStateWireFixture(
        await rpc.readCanonicalMatchRecord({
          inviteId,
          epoch: 2,
          matchId: inviteId,
          playerId: "host-login",
        }),
      ),
    ).toEqual({ ...match, sessionCreation: "host-created" });
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: "canonical_match_notification_failed",
      inviteId,
      kind: "Error",
    });
  });

  it.each([false, true])(
    "keeps event receipts compatible when deferred notifications are %s",
    async (deferNotifications) => {
      const { room, rpc, inviteId, input } = await fixture();
      await createMatches(input);
      const notify = vi.fn(async () => {});
      await runInDurableObject(room, (instance) => {
        const target = instance as unknown as {
          matchSync: { notify: typeof notify };
        };
        target.matchSync.notify = notify;
      });
      const effect = {
        inviteId,
        epoch: 2,
        operationId: "compatible-event-effect",
        terminalTimers: [{ matchId: inviteId, playerId: "host-login" }],
      };
      const applied = unwrapMatchStateWireFixture(
        await (deferNotifications
          ? rpc.applyCanonicalMatchEventEffects(effect, {
              deferNotifications: true,
            })
          : rpc.applyCanonicalMatchEventEffects(effect)),
      );
      expect(applied.changedMatchIds).toEqual([inviteId]);
      expect(notify).toHaveBeenCalledTimes(deferNotifications ? 0 : 1);
      const receipt = await runInDurableObject(
        room,
        (_instance, state) =>
          state.storage.sql
            .exec<{ payload_json: string }>(
              "SELECT payload_json FROM match_state_event_receipts WHERE operation_id = ?",
              effect.operationId,
            )
            .one().payload_json,
      );
      expect(JSON.parse(receipt)).toEqual(effect);
      expect(
        unwrapMatchStateWireFixture(
          await rpc.applyCanonicalMatchEventEffects(effect, {
            deferNotifications: !deferNotifications,
          }),
        ).changedMatchIds,
      ).toEqual([]);
      expect(
        await runInDurableObject(
          room,
          (_instance, state) =>
            state.storage.sql
              .exec<{ payload_json: string }>(
                "SELECT payload_json FROM match_state_event_receipts WHERE operation_id = ?",
                effect.operationId,
              )
              .one().payload_json,
        ),
      ).toBe(receipt);
      expect(
        matchRecordFixture(
          unwrapMatchStateWireFixture(
            await rpc.readCanonicalMatchPair({
              inviteId,
              epoch: 2,
              matchId: inviteId,
              playerId: "host-login",
              opponentId: "guest-login",
            }),
          ).playerMatch,
        )?.timer,
      ).toBe(MATCH_TIMER_TERMINAL);
    },
  );

  it("replays deployed receipt bytes after eviction and rejects changed payloads", async () => {
    const { room, rpc, inviteId, input } = await fixture({
      ...match,
      timer: MATCH_TIMER_TERMINAL,
    });
    await createMatches(input);
    const operationId = "deployed-event-effect";
    const quotedInviteId = JSON.stringify(inviteId);
    const receipt = `{"epoch":2,"inviteId":${quotedInviteId},"operationId":"deployed-event-effect","terminalTimers":[{"matchId":${quotedInviteId},"playerId":"host-login"}]}`;
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO match_state_event_receipts(operation_id, payload_json) VALUES (?, ?)",
        operationId,
        receipt,
      );
    });
    const pairRequest = {
      inviteId,
      epoch: 2,
      matchId: inviteId,
      playerId: "host-login",
      opponentId: "guest-login",
    };
    const before = unwrapMatchStateWireFixture(
      await rpc.readCanonicalMatchPair(pairRequest),
    );
    await evictDurableObject(room);
    const effect = {
      terminalTimers: [{ playerId: "host-login", matchId: inviteId }],
      operationId,
      inviteId,
      epoch: 2,
    };
    expect(
      unwrapMatchStateWireFixture(
        await rpc.applyCanonicalMatchEventEffects(effect),
      ),
    ).toEqual({ records: [], changedMatchIds: [] });
    expect(
      await rpc.applyCanonicalMatchEventEffects({
        ...effect,
        terminalTimers: [{ playerId: "guest-login", matchId: inviteId }],
      }),
    ).toEqual({
      ok: false,
      status: 409,
      code: "failed-precondition",
      message: "match-state-event-effect-conflict",
    });
    expect(
      unwrapMatchStateWireFixture(
        await rpc.readCanonicalMatchPair(pairRequest),
      ),
    ).toEqual(before);
    expect(
      await runInDurableObject(
        room,
        (_instance, state) =>
          state.storage.sql
            .exec<{ payload_json: string }>(
              "SELECT payload_json FROM match_state_event_receipts WHERE operation_id = ?",
              operationId,
            )
            .one().payload_json,
      ),
    ).toBe(receipt);
  });

  it("repairs deferred event effects when the post-commit notification is lost", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    const { room, rpc, inviteId, input } = await fixture();
    await createMatches(input);
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
    sockets.push(socket);
    const messages: unknown[] = [];
    let received!: (value: unknown) => void;
    const update = new Promise((resolve) => {
      received = resolve;
    });
    socket.addEventListener("message", ({ data }) => {
      const message: unknown = JSON.parse(String(data));
      messages.push(message);
      received(message);
    });
    socket.accept();
    expect(await update).toMatchObject({
      type: "snapshot",
      snapshot: { revision: initial.snapshot.revision },
    });
    messages.length = 0;
    const repaired = new Promise((resolve) => {
      received = resolve;
    });
    unwrapMatchStateWireFixture(
      await rpc.applyCanonicalMatchEventEffects(
        {
          inviteId,
          epoch: 2,
          operationId: "lost-event-notification",
          terminalTimers: [{ matchId: inviteId, playerId: "host-login" }],
        },
        { deferNotifications: true },
      ),
    );
    expect(messages).toEqual([]);
    const alarm = await runInDurableObject(room, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    clock.mockReturnValue(alarm!);
    await runDurableObjectAlarm(room);
    expect(await repaired).toMatchObject({
      type: "snapshot",
      snapshot: {
        revision: initial.snapshot.revision + 1,
        hostMatch: { timer: MATCH_TIMER_TERMINAL },
      },
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("merges transactional effect and room alarms without delaying the earlier work", async () => {
    const { room } = await fixture();
    await runInDurableObject(room, async (instance, state) => {
      const target = instance as unknown as {
        alarmCoordinator: {
          schedule: (
            atMs: number,
            transaction?: DurableObjectTransaction,
          ) => Promise<void>;
        };
      };
      const earlier = Date.now() + 1_000;
      const later = earlier + 60_000;
      await Promise.all([
        target.alarmCoordinator.schedule(later),
        state.storage.transaction((transaction) =>
          target.alarmCoordinator.schedule(earlier, transaction),
        ),
        target.alarmCoordinator.schedule(later + 60_000),
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
      unwrapMatchStateWireFixture(
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
          readSyncState: (
            input: MatchStateSyncReadRequest,
          ) => Promise<MatchStateSyncReadResult>;
        };
      };
      target.matchSync.readSyncState = async (input) =>
        input.knownRevision === 1
          ? { epoch: input.epoch, revision: 1, status: "unchanged" }
          : {
              epoch: input.epoch,
              revision: 1,
              status: "changed",
              playerMatch: match,
              opponentMatch: { ...match, color: "black" },
            };
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
          readSyncState: (
            input: MatchStateSyncReadRequest,
          ) => MatchStateSyncReadResult | Promise<MatchStateSyncReadResult>;
          dependencies: {
            readSyncState: (
              input: MatchStateSyncReadRequest,
            ) => MatchStateSyncReadResult | Promise<MatchStateSyncReadResult>;
          };
        };
      };
      target.matchSync.readSyncState =
        target.matchSync.dependencies.readSyncState;
    });
    expect(await room.readMatches(inviteId, inviteId)).toEqual(initial);
    unwrapMatchStateWireFixture(
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
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
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
    const failDelivery = async () => {
      attempts++;
      throw new Error("temporary-dispatch-failure");
    };
    await runInDurableObject(room, (instance) => {
      const target = instance as unknown as {
        matchEffects: {
          dependencies: {
            deliver: (effect: MatchStateEffect) => Promise<void>;
          };
        };
      };
      target.matchEffects.dependencies.deliver = failDelivery;
    });
    expect(
      unwrapMatchStateWireFixture(
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
    expect(attempts).toBe(0);
    expect(
      await runInDurableObject(room, (_instance, state) =>
        state.storage.sql
          .exec<{ attempts: number; completed_at_ms: number | null }>(
            "SELECT attempts, completed_at_ms FROM match_state_effects",
          )
          .one(),
      ),
    ).toEqual({ attempts: 0, completed_at_ms: null });
    await evictDurableObject(room);
    await runInDurableObject(room, (instance) => {
      const target = instance as unknown as {
        matchEffects: {
          dependencies: {
            deliver: (effect: MatchStateEffect) => Promise<void>;
          };
        };
      };
      target.matchEffects.dependencies.deliver = failDelivery;
    });
    expect(await runDurableObjectAlarm(room)).toBe(true);
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
      unwrapMatchStateWireFixture(
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
        matchEffects: {
          dependencies: {
            deliver: (effect: MatchStateEffect) => Promise<void>;
          };
        };
      };
      target.matchEffects.dependencies.deliver = async (effect) => {
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
    clock.mockReturnValue(saved.effect.next_at_ms);
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
