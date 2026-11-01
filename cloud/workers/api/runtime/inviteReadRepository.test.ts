import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { APPLICATION_DATA_SOCKET_PROTOCOL } from "@mons/shared/data-contract";
import { inviteDocumentFixture } from "../test/inviteDocumentFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REACTION_SOCKET_PROTOCOL } from "@mons/shared/reactions";
import { createInviteReadRepository } from "../src/inviteReadRepository.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import { createMatchSyncSnapshot } from "../src/matchSync.ts";
import { handleInviteMetadataRoute } from "../src/inviteMetadataRoute.ts";
import { handleInviteWagersRoute } from "../src/inviteWagersRoute.ts";
import { handleMatchSyncRoute } from "../src/matchSyncRoute.ts";
import { handleInviteReactionRoute } from "../src/inviteReactionRoute.ts";
import { handleMatchPresentationRoute } from "../src/matchPresentationRoute.ts";
import { socketTestIdentity } from "../test/socketTestSession.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const inviteId = "focused-invite";
const source = inviteDocumentFixture({
  hostId: "host",
  guestId: "guest",
  hostColor: "white",
});
const ctx = { waitUntil() {} };

function observe(
  afterBatch?: () => void,
  rewriteRows?: (query: string, rows: unknown[]) => unknown[],
) {
  const sessions: unknown[] = [];
  const batches: number[] = [];
  const queries: string[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const statementQueries = new WeakMap<D1PreparedStatement, string>();
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        throw new Error(`unexpected-statement-operation:${String(property)}`);
      },
    });
    originals.set(wrapped, statement);
    statementQueries.set(wrapped, query);
    return wrapped;
  };
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "withSession")
        return (constraint?: string) => {
          sessions.push(constraint);
          return new Proxy(target.withSession(constraint), {
            get(target, property) {
              if (property === "prepare")
                return (query: string) => wrap(target.prepare(query), query);
              if (property === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  batches.push(statements.length);
                  const executedQueries = statements.map((statement) =>
                    statementQueries.get(statement)!,
                  );
                  queries.push(...executedQueries);
                  const result = await target.batch(
                    statements.map((statement) => originals.get(statement)!),
                  );
                  afterBatch?.();
                  return result.map((entry, index) => ({
                    ...entry,
                    results:
                      rewriteRows?.(executedQueries[index]!, entry.results) ??
                      entry.results,
                  }));
                };
              throw new Error(
                `unexpected-session-operation:${String(property)}`,
              );
            },
          });
        };
      throw new Error(`unexpected-database-operation:${String(property)}`);
    },
  });
  return { database, sessions, batches, queries };
}

function restrictedEnv(database = db): Env {
  const allowed = new Set(["PROFILE_DB", "PROFILE_GAMES_DB"]);
  return new Proxy(env, {
    get(target, property) {
      if (property === "PROFILE_GAMES_DB") return database;
      if (
        property === "REACTION_RATE_LIMITER" ||
        property === "MATCH_SYNC_RATE_LIMITER"
      )
        return { limit: async () => ({ success: true }) };
      if (typeof property !== "string" || !allowed.has(property))
        throw new Error(`unexpected-binding:${String(property)}`);
      return Reflect.get(target, property, target);
    },
  });
}

async function pendingTransition() {
  await db.batch([
    db
      .prepare(
        "INSERT INTO game_session_transitions_canonical (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms) VALUES ('focused-transition', ?, ?, 'pending', 1, 1)",
      )
      .bind(
        inviteId,
        JSON.stringify({
          version: 3,
          inviteId,
          inviteSourceEpoch: 1,
          inviteMutations: [],
          transitionId: "focused-transition",
          operationDigest: "a".repeat(64),
          resources: [inviteId],
          mutations: [],
          creations: [],
          createdAtMs: 1,
        }),
      ),
    db
      .prepare(
        "INSERT INTO game_session_transition_resources_canonical (resource_key, transition_id) VALUES (?, 'focused-transition')",
      )
      .bind(inviteId),
  ]);
}

function metadata() {
  const value = normalizeInviteMetadata(inviteId, source);
  if (value.status !== "ok") throw new Error("invalid-fixture");
  return { ...value, snapshot: { ...value.snapshot, revision: 1 } };
}

describe("focused invite read repository", () => {
  beforeAll(() => applyCanonicalTestMigrations(db, testEnv.TEST_D1_MIGRATIONS));
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM game_session_transition_resources_canonical"),
      db.prepare("DELETE FROM game_session_transitions_canonical"),
      db.prepare("DELETE FROM invite_sources_canonical"),
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        "INSERT INTO automatch_runtime_control (singleton, backend, state, epoch, freeze_generation) VALUES (1, 'd1', 'active', 1, 0)",
      ),
      db.prepare(
        "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1",
      ),
      db
        .prepare(
          "INSERT INTO invite_sources_canonical (invite_id, source_json, revision, updated_at_ms) VALUES (?, ?, 1, 1)",
        )
        .bind(inviteId, JSON.stringify(source)),
    ]);
  });

  it("keeps the guarded primary read identical in focused and gameplay repositories", async () => {
    const narrow = observe();
    const broad = observe();
    const repository = createInviteReadRepository(
      restrictedEnv(narrow.database),
    );
    expect(Object.keys(repository).sort()).toEqual([
      "readInviteMetadata",
      "readProfileOwnershipSnapshot",
    ]);
    expect(await repository.readInviteMetadata(inviteId)).toEqual(source);
    expect(
      await createGameplayRepository({
        ...env,
        PROFILE_GAMES_DB: broad.database,
      }).readInviteMetadata(inviteId),
    ).toEqual(source);
    expect(narrow.sessions).toEqual(["first-primary"]);
    expect(narrow.batches).toEqual([4]);
    expect(narrow.queries).toEqual(broad.queries);
    expect(narrow.queries).toHaveLength(4);
    for (const [index, table] of [
      "automatch_runtime_control",
      "game_session_transition_resources_canonical",
      "invite_sources_canonical",
      "invite_source_control",
    ].entries())
      expect(narrow.queries[index]).toContain(`FROM ${table}`);
  });

  it("reads frozen D1 metadata and returns null only for genuinely missing sources", async () => {
    await db.batch([
      db.prepare("UPDATE automatch_runtime_control SET state = 'frozen'"),
      db.prepare("UPDATE invite_source_control SET state = 'frozen'"),
    ]);
    const repository = createInviteReadRepository(restrictedEnv());
    expect(await repository.readInviteMetadata(inviteId)).toEqual(source);
    expect(await repository.readInviteMetadata("missing-invite")).toBeNull();
  });

  it("retains pending transitions and checks them before decoding a corrupt source", async () => {
    await pendingTransition();
    await db
      .prepare("UPDATE invite_sources_canonical SET source_json = ?")
      .bind(JSON.stringify({ ...source, wagers: {} }))
      .run();
    const observed = observe();
    await expect(
      createInviteReadRepository(
        restrictedEnv(observed.database),
      ).readInviteMetadata(inviteId),
    ).rejects.toThrow("game-session-transition-resource-pending");
    expect(observed.batches).toEqual([4]);
    expect(
      await db
        .prepare("SELECT status FROM game_session_transitions_canonical")
        .first<string>("status"),
    ).toBe("pending");
    await db
      .prepare("DELETE FROM game_session_transition_resources_canonical")
      .run();
    await expect(
      createInviteReadRepository(restrictedEnv()).readInviteMetadata(inviteId),
    ).rejects.toThrow("invite-source-corrupt");
  });

  it("retains backend validation order ahead of pending transitions", async () => {
    await pendingTransition();
    let retiredAutomatch = true;
    const observed = observe(undefined, (query, rows) =>
      rows.map((row) =>
        query.includes("FROM automatch_runtime_control") && retiredAutomatch
          ? { ...(row as object), backend: "rtdb" }
          : query.includes("FROM invite_source_control")
            ? { ...(row as object), backend: "rtdb", epoch: 0 }
            : row,
      ),
    );
    const repository = createInviteReadRepository(
      restrictedEnv(observed.database),
    );
    await expect(repository.readInviteMetadata(inviteId)).rejects.toThrow(
      "automatch-control-unavailable",
    );
    retiredAutomatch = false;
    await expect(repository.readInviteMetadata(inviteId)).rejects.toThrow(
      "invite-source-backend-retired",
    );
  });

  it("preserves key validation and cancellation before and after the batch", async () => {
    const failure = new Error("read-cancelled");
    const cancelled = observe();
    const repository = createInviteReadRepository(
      restrictedEnv(cancelled.database),
    );
    await expect(
      repository.readInviteMetadata("invalid/key", AbortSignal.abort(failure)),
    ).rejects.toThrow("invalid-automatch-record-key");
    await expect(
      repository.readInviteMetadata(inviteId, AbortSignal.abort(failure)),
    ).rejects.toBe(failure);
    expect(cancelled.sessions).toEqual([]);
    const controller = new AbortController();
    const interrupted = observe(() => controller.abort(failure));
    await expect(
      createInviteReadRepository(
        restrictedEnv(interrupted.database),
      ).readInviteMetadata(inviteId, controller.signal),
    ).rejects.toBe(failure);
    expect(interrupted.batches).toEqual([4]);
  });

  it.each(["metadata", "wagers", "matches"] as const)(
    "%s defaults use only read bindings and the supplied room",
    async (channel) => {
      const current = metadata();
      const fetch = async () => new Response("upgrade");
      const verifyIdentity = async () => socketTestIdentity(source.hostId);
      const request = new Request(
        `https://api.mons.link/invites/${inviteId}/${
          channel === "matches" ? `matches/${inviteId}/snapshot` : channel
        }`,
        { headers: { Authorization: "Bearer fixture" } },
      );
      const response =
        channel === "metadata"
          ? await handleInviteMetadataRoute(request, restrictedEnv(), ctx, {
              verifyIdentity,
              room: { fetch, readMetadata: async () => current },
            })
          : channel === "wagers"
            ? await handleInviteWagersRoute(request, restrictedEnv(), ctx, {
                verifyIdentity,
                room: {
                  fetch,
                  readWagers: async () => ({
                    status: "ok",
                    metadata: current,
                    snapshot: { inviteId, revision: 1, wagers: {} },
                  }),
                },
              })
            : await handleMatchSyncRoute(request, restrictedEnv(), ctx, {
                verifyIdentity,
                room: {
                  fetch,
                  readMatches: async () => ({
                    status: "ok",
                    metadata: current,
                    snapshot: {
                      ...createMatchSyncSnapshot(current, inviteId, null, null),
                      revision: 1,
                    },
                  }),
                },
              });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    },
  );

  it("reaction defaults retain socket authorization and publish only through the supplied room", async () => {
    const published: unknown[] = [];
    const upgrades: Request[] = [];
    const dependencies = {
      verifyIdentity: async () => socketTestIdentity(source.hostId),
      readPresentationControl: async () => ({ phase: "durable" as const }),
      readRegisteredPresentations: async () => ({
        matchId: inviteId,
        players: {
          host: {
            matchId: inviteId,
            actorUid: "host",
            emojiId: 1,
            aura: "none" as const,
            revision: 0,
          },
        },
      }),
      room: {
        fetch: async (request: Request) => {
          upgrades.push(request);
          return new Response("upgrade");
        },
        publish: async (actorUid: string, reaction: unknown) => {
          published.push({ actorUid, reaction });
          return "published" as const;
        },
      },
    };
    const reaction = {
      uuid: "00000000-0000-4000-8000-000000000001",
      kind: "yo",
      variation: 1,
      matchId: inviteId,
    };
    const response = await handleInviteReactionRoute(
      new Request(`https://api.mons.link/invites/${inviteId}/reactions`, {
        method: "POST",
        headers: { Authorization: "Bearer fixture" },
        body: JSON.stringify(reaction),
      }),
      restrictedEnv(),
      ctx,
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(published).toEqual([{ actorUid: "host", reaction }]);
    const socket = await handleInviteReactionRoute(
      new Request(
        `https://api.mons.link/invites/${inviteId}/reactions/socket?matchId=${inviteId}`,
        {
          headers: {
            Origin: "https://mons.link",
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": `${REACTION_SOCKET_PROTOCOL}, ${APPLICATION_DATA_SOCKET_PROTOCOL}`,
          },
        },
      ),
      restrictedEnv(),
      ctx,
      dependencies,
    );
    expect(socket.status).toBe(200);
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]!.headers.get("X-Mons-Reaction-Role")).toBe("spectator");
    expect(published).toHaveLength(1);
  });

  it.each(["GET", "POST"])(
    "presentation %s defaults retain room read/write boundaries",
    async (method) => {
      const writes: unknown[] = [];
      const presentation = {
        matchId: inviteId,
        actorUid: "host",
        emojiId: 1,
        aura: "none" as const,
        revision: 0,
      };
      const update = {
        operationId: "00000000-0000-4000-8000-000000000001",
        expectedRevision: 0,
        emojiId: 1,
        aura: "none" as const,
      };
      const response = await handleMatchPresentationRoute(
        new Request(
          `https://api.mons.link/invites/${inviteId}/matches/${inviteId}/presentation`,
          {
            method,
            headers: { Authorization: "Bearer fixture" },
            ...(method === "POST" ? { body: JSON.stringify(update) } : {}),
          },
        ),
        restrictedEnv(),
        ctx,
        {
          verifyIdentity: async () => socketTestIdentity(source.hostId),
          readPresentationControl: async () => ({ phase: "durable" }),
          readRegisteredPresentations: async () => ({
            matchId: inviteId,
            players: { host: presentation },
          }),
          room: {
            updatePresentation: async (...args) => {
              writes.push(args);
              return {
                status: "updated",
                presentation: { ...presentation, revision: 1 },
              };
            },
          },
        },
      );
      expect(response.status).toBe(200);
      expect(writes).toEqual(
        method === "POST" ? [["host", inviteId, update]] : [],
      );
    },
  );
});
