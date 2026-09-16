import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildSessionRefreshToken,
  type SessionCreateRequest,
} from "@mons/shared/session-auth";
import {
  isSessionBootstrapResponse,
  isSessionEventBootstrapResponse,
  type SessionEventBootstrapResponse,
  type SessionBootstrapResponse,
} from "@mons/shared/session-bootstrap";
import type { InviteReactions } from "../src/inviteReactions.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "../src/matchStateRpc.ts";
import { handleRequest } from "../src/router.ts";
import { createSessionRepository } from "../src/sessionD1.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_AUTH_STATE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
};
const environment: Env = {
  ...env,
  SESSION_JWT_KEYS: JSON.stringify({
    activeKid: "test",
    keys: { test: "A".repeat(43) },
  }),
};
const rooms: DurableObjectStub<InviteReactions>[] = [];
const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
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

async function fixture(hostId: string) {
  const inviteId = `composed-runtime-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  rooms.push(room);
  const guestId = "g".repeat(28);
  await env.PROFILE_GAMES_DB.prepare(
    "INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms) VALUES (?, ?, 1, 1)",
  )
    .bind(inviteId, JSON.stringify({ hostId, guestId, hostColor: "white" }))
    .run();
  unwrapMatchStateRpc(
    await getMatchStateRpc(env, inviteId).createCanonicalMatch({
      inviteId,
      epoch: 2,
      records: [
        {
          matchId: inviteId,
          playerId: hostId,
          marker: "host-created",
          value: match,
        },
        {
          matchId: inviteId,
          playerId: guestId,
          marker: "guest-created",
          value: { ...match, color: "black" },
        },
      ],
    }),
  );
  return { inviteId, room };
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
});

describe("composed session Worker with canonical D1 and Durable Object state", () => {
  beforeAll(async () => {
    await Promise.all([
      applyEventTestMigrations(env.EVENT_DB, testEnv.TEST_EVENT_D1_MIGRATIONS),
      applyD1Migrations(env.PROFILE_GAMES_DB, testEnv.TEST_D1_MIGRATIONS),
      applyRetiredProfileMigrations(
        env.PROFILE_DB,
        testEnv.TEST_PROFILE_D1_MIGRATIONS,
        "a".repeat(64),
      ),
      applyD1Migrations(
        env.AUTH_STATE_DB,
        testEnv.TEST_AUTH_STATE_D1_MIGRATIONS,
      ),
    ]);
    await env.PROFILE_GAMES_DB.batch([
      env.PROFILE_GAMES_DB.prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active' WHERE singleton = 1",
      ),
      env.PROFILE_GAMES_DB.prepare(
        "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1",
      ),
    ]);
  });

  it("returns a primary event snapshot with the issued session and reusable conditional headers", async () => {
    const eventId = `session-event-${crypto.randomUUID()}`;
    const event = {
      eventId,
      status: "scheduled",
      startAtMs: 1000,
      updatedAtMs: 1,
      participants: {},
      rounds: {},
    };
    await env.EVENT_DB.prepare(
      "INSERT INTO event_records (event_id, status, start_at_ms, updated_at_ms, revision, record_json) VALUES (?, 'scheduled', 1000, 1, 7, ?)",
    )
      .bind(eventId, JSON.stringify(event))
      .run();
    const input: SessionCreateRequest = {
      sessionId: crypto.randomUUID(),
      refreshSecret: "A".repeat(43),
      revokeSecret: `${"B".repeat(42)}A`,
    };
    const response = await handleRequest(
      new Request(
        `https://api.mons.link/auth/session/anonymous?bootstrapEventId=${eventId}`,
        {
          method: "POST",
          headers: {
            Origin: "https://mons.link",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        },
      ),
      environment,
      {},
      ctx,
    );
    expect(response.status).toBe(200);
    const body = await response.json<SessionEventBootstrapResponse>();
    expect(isSessionEventBootstrapResponse(body)).toBe(true);
    const seed = body.eventBootstrap.result;
    if (!("snapshot" in seed)) throw new Error("event-bootstrap-failed");
    expect(seed.snapshot).toEqual({
      ok: true,
      eventId,
      revision: 7,
      event,
      prizeSelections: {},
    });
    const revalidated = await handleRequest(
      new Request(`https://api.mons.link/events/snapshot?eventId=${eventId}`, {
        headers: {
          Origin: "https://mons.link",
          Authorization: `Bearer ${body.accessToken}`,
          "If-None-Match": seed.etag,
          "X-D1-Bookmark": seed.bookmark,
        },
      }),
      environment,
      {},
      ctx,
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("ETag")).toBe(seed.etag);
    expect(revalidated.headers.get("Server-Timing")).toContain(
      "event_snapshot;dur=",
    );
    expect(revalidated.headers.get("Timing-Allow-Origin")).toBe(
      "https://mons.link",
    );
  });

  it.each(["anonymous", "refresh"])(
    "returns real %s authentication and canonical paired state in one response",
    async (endpoint) => {
      const input: SessionCreateRequest = {
        sessionId: crypto.randomUUID(),
        refreshSecret: "A".repeat(43),
        revokeSecret: `${"B".repeat(42)}A`,
      };
      const sessionRepository = createSessionRepository(env.AUTH_STATE_DB);
      const existing =
        endpoint === "refresh"
          ? await sessionRepository.create(input, Date.now())
          : null;
      const state = await fixture(existing?.uid ?? "h".repeat(28));
      const request = new Request(
        `https://api.mons.link/auth/session/${endpoint}?bootstrapInviteId=${state.inviteId}`,
        {
          method: "POST",
          headers: {
            Origin: "https://mons.link",
            ...(endpoint === "anonymous"
              ? { "Content-Type": "application/json" }
              : {
                  Authorization: `Bearer ${buildSessionRefreshToken(input.sessionId, input.refreshSecret)}`,
                }),
          },
          ...(endpoint === "anonymous" ? { body: JSON.stringify(input) } : {}),
        },
      );
      const response = await handleRequest(request, environment, {}, ctx);
      expect(response.status).toBe(200);
      const body = await response.json<SessionBootstrapResponse>();
      expect(isSessionBootstrapResponse(body)).toBe(true);
      expect(body.gameBootstrap.result.ok).toBe(true);
      if (!body.gameBootstrap.result.ok)
        throw new Error(JSON.stringify(body.gameBootstrap.result));
      expect(body.gameBootstrap.result.viewer.role).toBe(
        existing ? "host" : "watch",
      );
      expect(body.gameBootstrap.result.match.hostMatch).toEqual(match);
      expect(body.gameBootstrap.result.match.guestMatch).toEqual({
        ...match,
        color: "black",
      });
      const synced = await state.room.readMatches(
        state.inviteId,
        state.inviteId,
      );
      expect(synced.status).toBe("ok");
      if (synced.status === "ok")
        expect(synced.snapshot).toEqual(body.gameBootstrap.result.match);
      expect(
        await sessionRepository.refresh({
          sessionId: input.sessionId,
          secret: input.refreshSecret,
        }),
      ).toEqual({ uid: body.uid, sessionId: input.sessionId });
    },
  );

  it("preserves a newly stored session when real admission finds no game", async () => {
    const input: SessionCreateRequest = {
      sessionId: crypto.randomUUID(),
      refreshSecret: "A".repeat(43),
      revokeSecret: `${"B".repeat(42)}A`,
    };
    const response = await handleRequest(
      new Request(
        `https://api.mons.link/auth/session/anonymous?bootstrapInviteId=missing-${crypto.randomUUID()}`,
        {
          method: "POST",
          headers: {
            Origin: "https://mons.link",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        },
      ),
      environment,
      {},
      ctx,
    );
    expect(response.status).toBe(200);
    const body = await response.json<SessionBootstrapResponse>();
    expect(isSessionBootstrapResponse(body)).toBe(true);
    expect(body.gameBootstrap.result).toEqual({ ok: false, status: 404 });
    expect(
      await createSessionRepository(env.AUTH_STATE_DB).refresh({
        sessionId: input.sessionId,
        secret: input.refreshSecret,
      }),
    ).toEqual({ uid: body.uid, sessionId: input.sessionId });
  });
});
