import type {
  SessionCapability,
  SessionCreateRequest,
} from "@mons/shared/session-auth";
import { AuthApiFailure } from "./authErrors.ts";
import { secureAlphanumericId } from "./authRandom.ts";

export type StoredSession = { uid: string; sessionId: string };
export type SessionRepository = {
  create(input: SessionCreateRequest, nowMs: number): Promise<StoredSession>;
  refresh(input: SessionCapability): Promise<StoredSession>;
  revoke(input: SessionCapability, nowMs: number): Promise<void>;
};

type SessionRow = {
  uid: string | null;
  revoked_at_ms: number | null;
  refresh_matches: number;
  revoke_matches: number;
};

export async function hashSessionSecret(
  kind: "refresh" | "revoke",
  sessionId: string,
  secret: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `mons-session-${kind}-v1:${sessionId}:${secret}`,
      ),
    ),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function revoked(): AuthApiFailure {
  return new AuthApiFailure(401, "unauthenticated", "session-revoked");
}

export function createSessionRepository(
  db: D1Database,
  dependencies: { createUid?: () => string } = {},
): SessionRepository {
  return {
    async create(input, nowMs) {
      const [refreshHash, revokeHash] = await Promise.all([
        hashSessionSecret("refresh", input.sessionId, input.refreshSecret),
        hashSessionSecret("revoke", input.sessionId, input.revokeSecret),
      ]);
      const uid = (
        dependencies.createUid || (() => secureAlphanumericId(28))
      )();
      const session = db.withSession("first-primary");
      const results = await session.batch([
        session
          .prepare(
            `INSERT INTO anonymous_sessions
           (session_id, uid, refresh_hash, revoke_hash, created_at_ms, revoked_at_ms)
           VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT (session_id) DO NOTHING`,
          )
          .bind(input.sessionId, uid, refreshHash, revokeHash, nowMs),
        session
          .prepare(
            `SELECT uid, revoked_at_ms, refresh_hash = ? AS refresh_matches,
                  revoke_hash = ? AS revoke_matches
           FROM anonymous_sessions WHERE session_id = ?`,
          )
          .bind(refreshHash, revokeHash, input.sessionId),
      ]);
      const row = results[1].results[0] as SessionRow | undefined;
      if (!row) throw new Error("session-create-unavailable");
      if (!row.revoke_matches || (row.uid !== null && !row.refresh_matches)) {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "session-creation-conflict",
        );
      }
      if (row.revoked_at_ms !== null || row.uid === null) throw revoked();
      return { uid: row.uid, sessionId: input.sessionId };
    },
    async refresh(input) {
      const hash = await hashSessionSecret(
        "refresh",
        input.sessionId,
        input.secret,
      );
      const row = await db
        .withSession("first-primary")
        .prepare(
          `SELECT uid FROM anonymous_sessions
         WHERE session_id = ? AND refresh_hash = ? AND revoked_at_ms IS NULL`,
        )
        .bind(input.sessionId, hash)
        .first<{ uid: string }>();
      if (!row) throw revoked();
      return { uid: row.uid, sessionId: input.sessionId };
    },
    async revoke(input, nowMs) {
      const hash = await hashSessionSecret(
        "revoke",
        input.sessionId,
        input.secret,
      );
      const result = await db
        .withSession("first-primary")
        .prepare(
          `INSERT INTO anonymous_sessions
         (session_id, uid, refresh_hash, revoke_hash, created_at_ms, revoked_at_ms)
         VALUES (?, NULL, NULL, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE
         SET revoked_at_ms = COALESCE(anonymous_sessions.revoked_at_ms, excluded.revoked_at_ms)
         WHERE anonymous_sessions.revoke_hash = excluded.revoke_hash
         RETURNING session_id`,
        )
        .bind(input.sessionId, hash, nowMs, nowMs)
        .first<{ session_id: string }>();
      if (!result)
        throw new AuthApiFailure(
          401,
          "unauthenticated",
          "invalid-session-capability",
        );
    },
  };
}
