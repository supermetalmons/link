import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { type SessionCreateRequest } from "@mons/shared/session-auth";
import { AuthApiFailure } from "../src/authErrors.ts";
import { sweepExpiredAuthState } from "../src/authStateD1.ts";
import {
  createSessionRepository,
  hashSessionSecret,
} from "../src/sessionD1.ts";
import {
  issueSessionAccessToken,
  verifySessionRequest,
} from "../src/sessionAuth.ts";

const testEnv = env as Env & { TEST_AUTH_STATE_D1_MIGRATIONS: D1Migration[] };
const NOW_MS = 1_700_000_000_000;
const input: SessionCreateRequest = {
  sessionId: "00112233-4455-4677-8899-aabbccddeeff",
  refreshSecret: "A".repeat(43),
  revokeSecret: `${"B".repeat(42)}A`,
};
const refresh = { sessionId: input.sessionId, secret: input.refreshSecret };
const revoke = { sessionId: input.sessionId, secret: input.revokeSecret };
const environment: Env = {
  ...env,
  SESSION_JWT_KEYS: JSON.stringify({
    activeKid: "test",
    keys: { test: "A".repeat(43) },
  }),
};

describe("persistent anonymous sessions in D1", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.AUTH_STATE_DB,
      testEnv.TEST_AUTH_STATE_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.AUTH_STATE_DB.prepare("DELETE FROM anonymous_sessions").run();
  });

  it("replays concurrent creation without changing identity and stores only purpose-bound hashes", async () => {
    const repository = createSessionRepository(testEnv.AUTH_STATE_DB);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.create(input, NOW_MS)),
    );
    expect(new Set(results.map(({ uid }) => uid)).size).toBe(1);
    expect(results[0].uid).toMatch(/^[A-Za-z0-9]{28}$/);
    expect(await repository.refresh(refresh)).toEqual(results[0]);
    const row = await testEnv.AUTH_STATE_DB.prepare(
      "SELECT * FROM anonymous_sessions WHERE session_id = ?",
    )
      .bind(input.sessionId)
      .first();
    expect(row?.refresh_hash).toBe(
      await hashSessionSecret("refresh", input.sessionId, input.refreshSecret),
    );
    expect(row?.revoke_hash).toBe(
      await hashSessionSecret("revoke", input.sessionId, input.revokeSecret),
    );
    expect(JSON.stringify(row)).not.toContain(input.refreshSecret);
    expect(JSON.stringify(row)).not.toContain(input.revokeSecret);
    expect(
      await hashSessionSecret("refresh", input.sessionId, input.refreshSecret),
    ).not.toBe(
      await hashSessionSecret("revoke", input.sessionId, input.refreshSecret),
    );
  });

  it("never expires idle sessions or resurrects revoked sessions through retries or cleanup", async () => {
    const repository = createSessionRepository(testEnv.AUTH_STATE_DB);
    const created = await repository.create(input, NOW_MS);
    await sweepExpiredAuthState(
      testEnv.AUTH_STATE_DB,
      NOW_MS + 20 * 365 * 24 * 60 * 60 * 1000,
    );
    expect(await repository.refresh(refresh)).toEqual(created);
    await repository.revoke(revoke, NOW_MS + 1000);
    await repository.revoke(revoke, NOW_MS + 2000);
    await sweepExpiredAuthState(
      testEnv.AUTH_STATE_DB,
      NOW_MS + 20 * 365 * 24 * 60 * 60 * 1000,
    );
    await expect(repository.refresh(refresh)).rejects.toMatchObject({
      status: 401,
      message: "session-revoked",
    });
    await expect(repository.create(input, NOW_MS + 3000)).rejects.toMatchObject(
      { status: 401, message: "session-revoked" },
    );
    const row = await testEnv.AUTH_STATE_DB.prepare(
      "SELECT uid, revoked_at_ms FROM anonymous_sessions WHERE session_id = ?",
    )
      .bind(input.sessionId)
      .first();
    expect(row).toEqual({ uid: created.uid, revoked_at_ms: NOW_MS + 1000 });
  });

  it("logout before first creation permanently consumes the session ID without granting refresh authority", async () => {
    const repository = createSessionRepository(testEnv.AUTH_STATE_DB);
    await repository.revoke(revoke, NOW_MS);
    await repository.revoke(revoke, NOW_MS + 1);
    await expect(repository.create(input, NOW_MS + 2)).rejects.toMatchObject({
      status: 401,
      message: "session-revoked",
    });
    await expect(repository.refresh(refresh)).rejects.toMatchObject({
      status: 401,
    });
    const row = await testEnv.AUTH_STATE_DB.prepare(
      "SELECT uid, refresh_hash, revoked_at_ms FROM anonymous_sessions WHERE session_id = ?",
    )
      .bind(input.sessionId)
      .first();
    expect(row).toEqual({
      uid: null,
      refresh_hash: null,
      revoked_at_ms: NOW_MS,
    });
  });

  it("rejects mismatched creation and revocation secrets without affecting the live identity", async () => {
    const repository = createSessionRepository(testEnv.AUTH_STATE_DB);
    const original = await repository.create(input, NOW_MS);
    await expect(
      repository.create(
        { ...input, refreshSecret: `${"C".repeat(42)}A` },
        NOW_MS + 1,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      repository.create(
        { ...input, revokeSecret: `${"D".repeat(42)}A` },
        NOW_MS + 1,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      repository.revoke({ ...revoke, secret: input.refreshSecret }, NOW_MS + 1),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      repository.refresh({ ...refresh, secret: input.revokeSecret }),
    ).rejects.toMatchObject({ status: 401 });
    expect(await repository.refresh(refresh)).toEqual(original);
  });

  it("serializes creation/logout races and preserves bounded existing access tokens", async () => {
    const repository = createSessionRepository(testEnv.AUTH_STATE_DB);
    const created = await repository.create(input, NOW_MS);
    const issued = await issueSessionAccessToken(created, environment, NOW_MS);
    await repository.revoke(revoke, NOW_MS + 1000);
    await expect(repository.refresh(refresh)).rejects.toMatchObject({
      status: 401,
    });
    const request = new Request("https://api.mons.link/auth/methods", {
      headers: { Authorization: `Bearer ${issued.accessToken}` },
    });
    expect(
      (
        await verifySessionRequest(request, environment, undefined, {
          now: () => NOW_MS + 299_999,
        })
      ).uid,
    ).toBe(created.uid);
    await expect(
      verifySessionRequest(request, environment, undefined, {
        now: () => NOW_MS + 300_000,
      }),
    ).rejects.toMatchObject({ status: 401 });

    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = { ...input, sessionId: crypto.randomUUID() };
      const outcomes = await Promise.allSettled([
        repository.create(candidate, NOW_MS),
        repository.revoke(
          { sessionId: candidate.sessionId, secret: candidate.revokeSecret },
          NOW_MS,
        ),
      ]);
      expect(outcomes[1].status).toBe("fulfilled");
      if (outcomes[0].status === "rejected")
        expect(outcomes[0].reason).toBeInstanceOf(AuthApiFailure);
      await expect(
        repository.refresh({
          sessionId: candidate.sessionId,
          secret: candidate.refreshSecret,
        }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        repository.create(candidate, NOW_MS + 1),
      ).rejects.toMatchObject({ status: 401 });
    }
  });
});
