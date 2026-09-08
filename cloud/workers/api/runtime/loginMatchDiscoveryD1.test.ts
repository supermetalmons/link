import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildLoginMatchDiscoveryStatements,
  captureLoginMatchDiscovery,
  listLoginMatchDiscoveryPage,
  readLoginMatchDiscoveryBackend,
  type LoginMatchDiscoveryInput,
} from "../src/loginMatchDiscoveryD1.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const LOGIN = "anonymous-login";

function resolved(
  matchId: string,
  inviteId = "invite",
): LoginMatchDiscoveryInput {
  return {
    loginUid: LOGIN,
    matchId,
    inviteId,
    resolution: "resolved",
    provenance: "backfill",
  };
}

describe("login match discovery D1", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM login_match_discovery"),
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare(
        "UPDATE login_match_discovery_control SET discovery_backend = 'rtdb', capture_enforced = 0, capture_version_id = NULL, capture_started_at_ms = NULL, verified_at_ms = NULL, activated_at_ms = NULL WHERE singleton = 1",
      ),
    ]);
  });

  it("indexes unlinked logins and pages in existing cursor order", async () => {
    const ids = ["invite2", "invite10", "2", "10", "a😀", "a\ue000", "a", "a1"];
    await db.batch(
      buildLoginMatchDiscoveryStatements(
        db,
        ids.map((id) => resolved(id)),
        1,
      ),
    );
    const found: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await listLoginMatchDiscoveryPage(db, LOGIN, cursor, 3);
      expect(page.entries.length).toBeLessThanOrEqual(3);
      found.push(...page.entries.map((entry) => entry.matchId));
      if (!page.hasMore) break;
      cursor = page.entries.at(-1)!.matchId;
    }
    expect(found).toEqual([...ids].sort());
    expect(
      await listLoginMatchDiscoveryPage(db, "other-login", null, 20),
    ).toEqual({
      entries: [],
      hasMore: false,
    });
  });

  it("keeps unresolved keys in cursor pages and never invents an invite", async () => {
    await db.batch(
      buildLoginMatchDiscoveryStatements(
        db,
        [
          { ...resolved("a"), inviteId: null, resolution: "missing" },
          { ...resolved("b"), inviteId: null, resolution: "ambiguous" },
          resolved("c"),
        ],
        1,
      ),
    );
    expect(await listLoginMatchDiscoveryPage(db, LOGIN, null, 1)).toEqual({
      entries: [{ matchId: "a", inviteId: null, resolution: "missing" }],
      hasMore: true,
    });
    expect(await listLoginMatchDiscoveryPage(db, LOGIN, "b", 1)).toEqual({
      entries: [{ matchId: "c", inviteId: "invite", resolution: "resolved" }],
      hasMore: false,
    });
  });

  it("captures idempotently, upgrades unresolved rows, and protects resolved mappings", async () => {
    await db.batch(
      buildLoginMatchDiscoveryStatements(
        db,
        [{ ...resolved("invite2"), inviteId: null, resolution: "missing" }],
        1,
      ),
    );
    const capture = [
      { loginUid: LOGIN, matchId: "invite2", inviteId: "invite" },
    ];
    await captureLoginMatchDiscovery(db, capture, 2);
    await captureLoginMatchDiscovery(db, capture, 3);
    const row = await db.prepare("SELECT * FROM login_match_discovery").first();
    expect(row).toMatchObject({
      login_uid: LOGIN,
      match_id: "invite2",
      invite_id: "invite",
      resolution: "resolved",
      provenance: "capture",
      indexed_at_ms: 1,
    });
    await db.batch(
      buildLoginMatchDiscoveryStatements(
        db,
        [{ ...resolved("invite2"), inviteId: null, resolution: "missing" }],
        4,
      ),
    );
    await expect(
      captureLoginMatchDiscovery(db, [{ ...capture[0], inviteId: "other" }]),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT * FROM login_match_discovery").first(),
    ).toEqual(row);
  });

  it("rolls back the whole capture batch on a conflicting mapping", async () => {
    await captureLoginMatchDiscovery(db, [
      { loginUid: LOGIN, matchId: "existing", inviteId: "original" },
    ]);
    await expect(
      captureLoginMatchDiscovery(db, [
        { loginUid: LOGIN, matchId: "new", inviteId: "new" },
        { loginUid: LOGIN, matchId: "existing", inviteId: "conflict" },
      ]),
    ).rejects.toThrow();
    expect(
      (await listLoginMatchDiscoveryPage(db, LOGIN, null, 20)).entries.map(
        (row) => row.matchId,
      ),
    ).toEqual(["existing"]);
  });

  it("fails on a corrupted sort key and unsupported page limits", async () => {
    await captureLoginMatchDiscovery(db, [
      { loginUid: LOGIN, matchId: "invite", inviteId: "invite" },
    ]);
    await db
      .prepare("UPDATE login_match_discovery SET match_sort_key = 'ffff'")
      .run();
    await expect(
      listLoginMatchDiscoveryPage(db, LOGIN, null, 20),
    ).rejects.toThrow("corrupt-page");
    await expect(
      listLoginMatchDiscoveryPage(db, LOGIN, null, 21),
    ).rejects.toThrow("invalid-login-match-discovery-page");
  });

  it("reads explicit migration state and fails when control is missing", async () => {
    expect(await readLoginMatchDiscoveryBackend(db)).toBe("rtdb");
    await db
      .prepare(
        "UPDATE login_match_discovery_control SET discovery_backend = 'd1', capture_enforced = 1, capture_version_id = '11111111-1111-4111-8111-111111111111', capture_started_at_ms = 1, verified_at_ms = 2, activated_at_ms = 3 WHERE singleton = 1",
      )
      .run();
    expect(await readLoginMatchDiscoveryBackend(db)).toBe("d1");
    await db.prepare("DELETE FROM login_match_discovery_control").run();
    await expect(readLoginMatchDiscoveryBackend(db)).rejects.toThrow(
      "control-unavailable",
    );
    await db
      .prepare(
        "INSERT INTO login_match_discovery_control (singleton, discovery_backend, capture_enforced) VALUES (1, 'rtdb', 0)",
      )
      .run();
  });

  it.each([LOGIN, "matches"])(
    "requires capture before completing for UID %s",
    async (loginUid) => {
      const payload = {
        creations: [{ path: `players/${loginUid}/matches/invite2` }],
      };
      await db
        .prepare(
          `INSERT INTO game_session_transitions
      (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
      VALUES ('legacy', 'invite', ?, 'pending', 1, 1)`,
        )
        .bind(JSON.stringify(payload))
        .run();
      await db
        .prepare(
          "UPDATE login_match_discovery_control SET capture_enforced = 1, capture_version_id = '11111111-1111-4111-8111-111111111111', capture_started_at_ms = 1 WHERE singleton = 1",
        )
        .run();
      await expect(
        db
          .prepare(
            "UPDATE game_session_transitions SET status = 'completed' WHERE transition_id = 'legacy'",
          )
          .run(),
      ).rejects.toThrow("capture-required");
      await captureLoginMatchDiscovery(db, [
        { loginUid, matchId: "invite2", inviteId: "invite" },
      ]);
      await db
        .prepare(
          "UPDATE game_session_transitions SET status = 'completed' WHERE transition_id = 'legacy'",
        )
        .run();
      expect(
        await db
          .prepare(
            "SELECT status FROM game_session_transitions WHERE transition_id = 'legacy'",
          )
          .first("status"),
      ).toBe("completed");
    },
  );
});
