import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env as runtimeEnv, exports } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  FirebaseRtdbFailure,
  readPublicFirebaseMatch,
} from "../test/legacyFirebaseRtdb.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "../src/matchStateRpc.ts";

const env = {
  ...runtimeEnv,
  FIREBASE_RTDB_URL: "https://mons-link-default-rtdb.firebaseio.com",
};
const testEnv = runtimeEnv as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

const target = { playerId: "player-1", matchId: "match-1" };
const snapshot = { color: "white", fen: "current-fen" };

describe("public match snapshot Worker runtime", () => {
  it("constructs the upstream request with native runtime fetch options", async () => {
    let reads = 0;
    const value = await readPublicFirebaseMatch(env, target, {
      fetcher: async (input, init) => {
        const upstream = new Request(input, init);
        reads++;
        expect(upstream.method).toBe("GET");
        expect(upstream.url).toBe(
          `${env.FIREBASE_RTDB_URL}/players/player-1/matches/match-1.json`,
        );
        expect(upstream.redirect).toBe("manual");
        expect(upstream.headers.get("Authorization")).toBeNull();
        expect(upstream.signal.aborted).toBe(false);
        return Response.json(snapshot);
      },
    });
    expect(value).toEqual(snapshot);
    expect(reads).toBe(1);
  });

  it("rejects redirects without following the public match request", async () => {
    let reads = 0;
    await expect(
      readPublicFirebaseMatch(env, target, {
        fetcher: async (input, init) => {
          const upstream = new Request(input, init);
          expect(upstream.redirect).toBe("manual");
          reads++;
          return new Response(null, {
            status: 302,
            headers: { Location: "https://example.com/other-record" },
          });
        },
      }),
    ).rejects.toBeInstanceOf(FirebaseRtdbFailure);
    expect(reads).toBe(1);
  });

  it("propagates caller cancellation to the native upstream request", async () => {
    const controller = new AbortController();
    const request = new Request("https://api.mons.link/matches/snapshot", {
      signal: controller.signal,
    });
    let upstreamAborted = false;
    await expect(
      readPublicFirebaseMatch(env, target, {
        signal: request.signal,
        fetcher: async (input, init) => {
          const upstream = new Request(input, init);
          return new Promise<Response>((_resolve, reject) => {
            upstream.signal.addEventListener(
              "abort",
              () => {
                upstreamAborted = true;
                reject(upstream.signal.reason);
              },
              { once: true },
            );
            controller.abort();
          });
        },
      }),
    ).rejects.toBeInstanceOf(FirebaseRtdbFailure);
    expect(upstreamAborted).toBe(true);
  });

  it("dispatches public preflight and validation through the Worker entrypoint", async () => {
    const preflight = await exports.default.fetch(
      new Request("https://api.mons.link/matches/snapshot", {
        method: "OPTIONS",
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const invalid = await exports.default.fetch(
      new Request("https://api.mons.link/matches/snapshot?playerId=player-1"),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      ok: false,
      error: "invalid-argument",
      message: "invalid-request",
    });
  });
});

describe("public canonical match routing", () => {
  beforeAll(async () => {
    const migration = testEnv.TEST_D1_MIGRATIONS.find((entry) =>
      entry.name.includes("0024_match_state"),
    );
    if (!migration) throw new Error("missing-match-state-migration");
    await applyD1Migrations(env.PROFILE_GAMES_DB, [migration]);
    await env.PROFILE_GAMES_DB.prepare(
      `UPDATE match_state_control SET backend = 'durable', epoch = 2,
       candidate_version_id = 'candidate', import_id = 'import',
       source_digest = ?, verified_digest = ?, fence_digest = ?,
       source_record_count = 0, source_claim_count = 0, source_bundle_count = 0,
       verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1`,
    )
      .bind("a".repeat(64), "a".repeat(64), "b".repeat(64))
      .run();
  });

  afterEach(() => vi.restoreAllMocks());

  const read = (playerId: string, matchId: string) =>
    exports.default.fetch(
      new Request(
        `https://api.mons.link/matches/snapshot?${new URLSearchParams({ playerId, matchId })}`,
      ),
    );

  it("serves an exact player route from its local canonical room without Firebase", async () => {
    const inviteId = `routed-${crypto.randomUUID()}`;
    const playerId = "routed-player";
    const rpc = getMatchStateRpc(env, inviteId);
    const external = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-network"));
    unwrapMatchStateRpc(
      await rpc.createCanonicalMatch({
        inviteId,
        epoch: 2,
        records: [
          {
            matchId: inviteId,
            playerId,
            marker: "creation-one",
            value: { ...snapshot, sessionCreation: "private" },
          },
        ],
      }),
    );
    await env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO match_state_routes(actor_uid, match_id, kind, invite_id, epoch) VALUES (?, ?, 'durable', ?, 2)",
    )
      .bind(playerId, inviteId, inviteId)
      .run();
    const response = await read(playerId, inviteId);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<{ match: unknown }>();
    expect(body).toMatchObject({
      ok: true,
      playerId,
      matchId: inviteId,
      match: snapshot,
    });
    expect(body.match).not.toHaveProperty("sessionCreation");
    expect(external).not.toHaveBeenCalled();
  });

  it("preserves archived orphan reads and returns null for an absent exact route", async () => {
    const matchId = `orphan-${crypto.randomUUID()}`;
    const playerId = "orphan-player";
    const external = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-network"));
    await env.PROFILE_GAMES_DB.batch([
      env.PROFILE_GAMES_DB.prepare(
        "INSERT INTO match_state_routes(actor_uid, match_id, kind, invite_id, epoch) VALUES (?, ?, 'legacy', NULL, 2)",
      ).bind(playerId, matchId),
      env.PROFILE_GAMES_DB.prepare(
        "INSERT INTO match_state_legacy_records(actor_uid, match_id, record_json, source_digest, import_id, disposition) VALUES (?, ?, ?, ?, 'import', 'missing-invite')",
      ).bind(playerId, matchId, JSON.stringify(snapshot), "a".repeat(64)),
    ]);
    expect(await (await read(playerId, matchId)).json()).toMatchObject({
      ok: true,
      playerId,
      matchId,
      match: snapshot,
    });
    expect(await (await read("other-player", matchId)).json()).toEqual({
      ok: true,
      playerId: "other-player",
      matchId,
      match: null,
    });
    expect(external).not.toHaveBeenCalled();
  });

  it("rejects a missing routed record in an initialized canonical room", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inviteId = `partial-${crypto.randomUUID()}`;
    const playerId = "missing-player";
    const external = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-network"));
    unwrapMatchStateRpc(
      await getMatchStateRpc(env, inviteId).createCanonicalMatch({
        inviteId,
        epoch: 2,
        records: [
          {
            matchId: inviteId,
            playerId: "retained-player",
            marker: "creation-one",
            value: snapshot,
          },
        ],
      }),
    );
    await env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO match_state_routes(actor_uid, match_id, kind, invite_id, epoch) VALUES (?, ?, 'durable', ?, 2)",
    )
      .bind(playerId, inviteId, inviteId)
      .run();

    const response = await read(playerId, inviteId);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unavailable",
      message: "match-snapshot-unavailable",
    });
    expect(await (await read("unrouted-player", inviteId)).json()).toEqual({
      ok: true,
      playerId: "unrouted-player",
      matchId: inviteId,
      match: null,
    });
    expect(external).not.toHaveBeenCalled();
  });

  it("keeps malformed archives and unavailable canonical rooms distinct from absent records", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const matchId = `invalid-${crypto.randomUUID()}`;
    const playerId = "invalid-player";
    const external = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-network"));
    await env.PROFILE_GAMES_DB.batch([
      env.PROFILE_GAMES_DB.prepare(
        "INSERT INTO match_state_routes(actor_uid, match_id, kind, invite_id, epoch) VALUES (?, ?, 'legacy', NULL, 2)",
      ).bind(playerId, matchId),
      env.PROFILE_GAMES_DB.prepare(
        "INSERT INTO match_state_legacy_records(actor_uid, match_id, record_json, source_digest, import_id, disposition) VALUES (?, ?, '{}', ?, 'import', 'malformed')",
      ).bind(playerId, matchId, "a".repeat(64)),
      env.PROFILE_GAMES_DB.prepare(
        "INSERT INTO match_state_routes(actor_uid, match_id, kind, invite_id, epoch) VALUES (?, ?, 'durable', ?, 2)",
      ).bind("unavailable-player", matchId, matchId),
    ]);
    for (const actor of [playerId, "unavailable-player"]) {
      const response = await read(actor, matchId);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "unavailable",
        message: "match-snapshot-unavailable",
      });
    }
    expect(external).not.toHaveBeenCalled();
  });
});
