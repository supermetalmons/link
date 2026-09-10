import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REACTION_SOCKET_PROTOCOL_V2,
  isInviteRoomMessage,
} from "@mons/shared/reactions";
import type { MatchPresentationSnapshot } from "@mons/shared/match-presentation";
import { InviteReactions } from "../src/inviteReactions.ts";
import {
  handleInviteReactionRoute,
  type InviteReactionRouteDependencies,
} from "../src/inviteReactionRoute.ts";
import { handleMatchPresentationRoute } from "../src/matchPresentationRoute.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import {
  buildMatchPresentationRegistrationStatements,
  prepareCreatedMatchPresentations,
  readRegisteredMatchPresentations,
} from "../src/matchPresentationRegistry.ts";
import { socketTestIdentity } from "../test/socketTestSession.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const hostId = "presentation-admission-host";
const guestId = "presentation-admission-guest";
const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const sockets: WebSocket[] = [];

beforeAll(async () => {
  await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
});

beforeEach(async () => {
  await resetMatchPresentationTestState(
    db,
    testEnv.TEST_D1_MIGRATIONS,
    "durable",
  );
});

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(closeSocket));
});

async function closeSocket(socket: WebSocket): Promise<void> {
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

async function initialSnapshot(
  response: Response,
  closeAfterRead = false,
): Promise<MatchPresentationSnapshot> {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  if (!closeAfterRead) sockets.push(socket);
  const message = new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    });
  });
  socket.accept();
  try {
    const value: unknown = JSON.parse(await message);
    if (
      !isInviteRoomMessage(value) ||
      value.schemaVersion !== 2 ||
      value.type !== "snapshot"
    ) {
      throw new Error("invalid-initial-presentation");
    }
    return value.presentation;
  } finally {
    if (closeAfterRead) await closeSocket(socket);
  }
}

async function fixture() {
  const inviteId = `presentation-admission-${crypto.randomUUID()}`;
  const matchId = `${inviteId}1`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  const invite = {
    hostId,
    guestId,
    hostRematches: "1",
    guestRematches: "",
    hostColor: "white",
  };
  const creation = (actorUid: string, emojiId: number) => ({
    inviteId,
    matchId,
    actorUid,
    emojiId,
    aura: "",
    sourceId: `${actorUid}-proposal`,
  });
  const host = await prepareCreatedMatchPresentations(env, [
    creation(hostId, 1),
  ]);
  await db.batch([
    ...buildMatchPresentationRegistrationStatements(db, host, 1),
    db
      .prepare(
        "INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms) VALUES (?, ?, 1, 1)",
      )
      .bind(inviteId, JSON.stringify(invite)),
  ]);
  const repository = {
    async getRtdbPath(path: string) {
      expect(path).toBe(`invites/${inviteId}`);
      const row = await db
        .prepare("SELECT source_json FROM invite_sources WHERE invite_id = ?")
        .bind(inviteId)
        .first<{ source_json: string }>();
      if (!row) return null;
      return JSON.parse(row.source_json) as unknown;
    },
  } as GameplayRepository;
  const prepareGuest = (workerEnv = env) =>
    prepareCreatedMatchPresentations(workerEnv, [creation(guestId, 2)]);
  const commitGuest = async (workerEnv = env) => {
    const guest = await prepareGuest(workerEnv);
    await db.batch([
      ...buildMatchPresentationRegistrationStatements(db, guest, 4),
      db
        .prepare(
          "UPDATE invite_sources SET source_json = ?, revision = revision + 1 WHERE invite_id = ?",
        )
        .bind(JSON.stringify({ ...invite, guestRematches: "1" }), inviteId),
    ]);
  };
  const updateGuest = async (workerEnv = env) => {
    const response = await handleMatchPresentationRoute(
      new Request(
        `https://api.mons.link/invites/${inviteId}/matches/${matchId}/presentation`,
        {
          method: "POST",
          headers: {
            Origin: "https://mons.link",
            Authorization: "Bearer fixture-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            expectedRevision: 0,
            emojiId: 1000,
            aura: "rainbow",
          }),
        },
      ),
      workerEnv,
      ctx,
      {
        repository,
        verifyIdentity: async () => socketTestIdentity(guestId),
        logFailure: () => undefined,
      },
    );
    expect(response.status).toBe(200);
  };
  const connect = (
    fetchRoom: (request: Request) => Promise<Response>,
    workerEnv = env,
  ) => {
    const routeRoom: NonNullable<InviteReactionRouteDependencies["room"]> = {
      fetch: fetchRoom,
      publish: async () => {
        throw new Error("unexpected-reaction-publish");
      },
    };
    return handleInviteReactionRoute(
      new Request(
        `https://api.mons.link/invites/${inviteId}/reactions/socket?matchId=${matchId}`,
        {
          headers: {
            Origin: "https://mons.link",
            Upgrade: "websocket",
            "CF-Connecting-IP": "192.0.2.45",
            "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL_V2,
          },
        },
      ),
      workerEnv,
      ctx,
      { repository, room: routeRoom, logFailure: () => undefined },
    );
  };
  return {
    inviteId,
    matchId,
    room,
    connect,
    prepareGuest,
    commitGuest,
    updateGuest,
  };
}

function interceptFirstRegistryRead(
  db: D1Database,
  afterRead: () => Promise<void>,
) {
  let calls = 0;
  const statement = (
    target: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement =>
    new Proxy(target, {
      get(current, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            statement(current.bind(...values), query);
        if (
          property === "all" &&
          query.includes("FROM match_presentation_registrations")
        ) {
          return async <T>() => {
            const result = await current.all<T>();
            calls++;
            if (calls === 1) await afterRead();
            return result;
          };
        }
        const value = Reflect.get(current, property, current);
        return typeof value === "function" ? value.bind(current) : value;
      },
    });
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => statement(target.prepare(query), query);
      if (property === "withSession")
        return (...args: Parameters<D1Database["withSession"]>) => {
          const session = target.withSession(...args);
          return new Proxy(session, {
            get(current, key) {
              if (key === "prepare")
                return (query: string) =>
                  statement(current.prepare(query), query);
              const value = Reflect.get(current, key, current);
              return typeof value === "function" ? value.bind(current) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, calls: () => calls };
}

describe("canonical presentation socket admission", () => {
  it("includes a guest update completed after the route actor lookup but before DO admission", async () => {
    const f = await fixture();
    expect(
      Object.keys(
        (await readRegisteredMatchPresentations(env, f.inviteId, f.matchId))
          .players,
      ),
    ).toEqual([hostId]);
    const response = await f.connect(async (request) => {
      expect(
        JSON.parse(
          decodeURIComponent(
            request.headers.get("X-Mons-Presentation-Actors")!,
          ),
        ),
      ).toEqual([hostId, guestId]);
      await f.commitGuest();
      await f.updateGuest();
      return f.room.fetch(request);
    });
    const snapshot = await initialSnapshot(response);
    expect(Object.keys(snapshot.players).sort()).toEqual(
      [guestId, hostId].sort(),
    );
    expect(snapshot.players[guestId]).toMatchObject({
      emojiId: 1000,
      aura: "rainbow",
      revision: 1,
    });
  });

  it("rechecks registration when a guest update completes while the fresh D1 lookup awaits", async () => {
    const f = await fixture();
    await runInDurableObject(f.room, async (_original, state) => {
      let instance: InviteReactions;
      const localEnv = new Proxy(env, {
        get(target, property, receiver) {
          return property === "INVITE_REACTIONS"
            ? { getByName: () => instance }
            : Reflect.get(target, property, receiver);
        },
      });
      const intercepted = interceptFirstRegistryRead(db, async () => {
        await f.commitGuest(localEnv);
        await f.updateGuest(localEnv);
      });
      const queryEnv = new Proxy(localEnv, {
        get(target, property, receiver) {
          return property === "PROFILE_GAMES_DB"
            ? intercepted.db
            : Reflect.get(target, property, receiver);
        },
      });
      instance = new InviteReactions(state, queryEnv);
      const response = await f.connect(
        (request) => instance.fetch(request),
        localEnv,
      );
      const snapshot = await initialSnapshot(response, true);
      expect(intercepted.calls()).toBe(2);
      expect(snapshot.players[guestId]).toMatchObject({
        emojiId: 1000,
        aura: "rainbow",
        revision: 1,
      });
      expect(Object.keys(snapshot.players).sort()).toEqual(
        [guestId, hostId].sort(),
      );
    });
  });

  it("keeps a revision-zero prepared guest hidden when seeding overlaps the D1 lookup", async () => {
    const f = await fixture();
    await runInDurableObject(f.room, async (_original, state) => {
      let instance: InviteReactions;
      const localEnv = new Proxy(env, {
        get(target, property, receiver) {
          return property === "INVITE_REACTIONS"
            ? { getByName: () => instance }
            : Reflect.get(target, property, receiver);
        },
      });
      const intercepted = interceptFirstRegistryRead(db, async () => {
        await f.prepareGuest(localEnv);
      });
      const queryEnv = new Proxy(localEnv, {
        get(target, property, receiver) {
          return property === "PROFILE_GAMES_DB"
            ? intercepted.db
            : Reflect.get(target, property, receiver);
        },
      });
      instance = new InviteReactions(state, queryEnv);
      const response = await f.connect(
        (request) => instance.fetch(request),
        localEnv,
      );
      const snapshot = await initialSnapshot(response, true);
      expect(intercepted.calls()).toBe(1);
      expect(Object.keys(snapshot.players)).toEqual([hostId]);
      expect(
        (await instance.getPresentationSnapshot(f.matchId)).players[guestId]
          .revision,
      ).toBe(0);
    });
  });

  it("fails closed if an unregistered legacy actor changes during lookup without a commit proof", async () => {
    const f = await fixture();
    await runInDurableObject(f.room, async (_original, state) => {
      let instance: InviteReactions;
      const localEnv = new Proxy(env, {
        get(target, property, receiver) {
          return property === "INVITE_REACTIONS"
            ? { getByName: () => instance }
            : Reflect.get(target, property, receiver);
        },
      });
      const intercepted = interceptFirstRegistryRead(db, async () => {
        await f.prepareGuest(localEnv);
        await instance.updatePresentation(guestId, f.matchId, {
          operationId: crypto.randomUUID(),
          expectedRevision: 0,
          emojiId: 1000,
          aura: "rainbow",
        });
      });
      const queryEnv = new Proxy(localEnv, {
        get(target, property, receiver) {
          return property === "PROFILE_GAMES_DB"
            ? intercepted.db
            : Reflect.get(target, property, receiver);
        },
      });
      instance = new InviteReactions(state, queryEnv);
      const response = await f.connect(
        (request) => instance.fetch(request),
        localEnv,
      );
      expect(response.status).toBe(503);
      expect(intercepted.calls()).toBe(2);
      expect(state.getWebSockets()).toHaveLength(0);
    });
  });
});
