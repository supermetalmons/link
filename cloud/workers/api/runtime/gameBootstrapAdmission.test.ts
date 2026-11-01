import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { inviteDocumentFixture } from "../test/inviteDocumentFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readGameBootstrapAdmission } from "../src/gameBootstrapAdmission.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const inviteId = "batched-bootstrap";
const source = inviteDocumentFixture({
  hostId: "host",
  guestId: "guest",
  hostColor: "white",
});
const signal = () => new AbortController().signal;

function observe(afterBatch?: () => void) {
  const sessions: unknown[] = [];
  const batches: number[] = [];
  const queries: string[] = [];
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) => {
          sessions.push(constraint);
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(target, property) {
              if (property === "prepare")
                return (query: string) => {
                  queries.push(query);
                  return target.prepare(query);
                };
              if (property === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  batches.push(statements.length);
                  const result = await target.batch(statements);
                  afterBatch?.();
                  return result;
                };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database, sessions, batches, queries };
}

describe("transactional bootstrap admission", () => {
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

  it("reads source and all admission guards through one first-primary transaction", async () => {
    const observed = observe();
    expect(
      await readGameBootstrapAdmission(observed.database, inviteId, signal()),
    ).toEqual(source);
    expect(observed.sessions).toEqual(["first-primary"]);
    expect(observed.batches).toEqual([4]);
    expect(observed.queries).toHaveLength(4);
    expect(observed.queries.join(" ")).toContain(
      "game_session_transition_resources_canonical",
    );
    expect(
      await createGameplayRepository(env).readInviteMetadata(inviteId),
    ).toEqual(source);
  });

  it("preserves read access during write freezes and genuine missing-invite results", async () => {
    await db.batch([
      db.prepare(
        "UPDATE automatch_runtime_control SET state = 'frozen' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE invite_source_control SET state = 'frozen' WHERE singleton = 1",
      ),
    ]);
    expect(await readGameBootstrapAdmission(db, inviteId, signal())).toEqual(
      source,
    );
    expect(
      await createGameplayRepository(env).readInviteMetadata(inviteId),
    ).toEqual(source);
    expect(
      await readGameBootstrapAdmission(db, "missing", signal()),
    ).toBeNull();
  });

  it("rejects pending resource transitions before publishing the source", async () => {
    await db.batch([
      db
        .prepare(
          "INSERT INTO game_session_transitions_canonical (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms) VALUES ('transition', ?, ?, 'pending', 1, 1)",
        )
        .bind(
          inviteId,
          JSON.stringify({
            version: 3,
            inviteId,
            inviteSourceEpoch: 1,
            inviteMutations: [],
            transitionId: "transition",
            operationDigest: "a".repeat(64),
            resources: [inviteId],
            mutations: [],
            creations: [],
            createdAtMs: 1,
          }),
        ),
      db
        .prepare(
          "INSERT INTO game_session_transition_resources_canonical (resource_key, transition_id) VALUES (?, 'transition')",
        )
        .bind(inviteId),
    ]);
    await expect(
      readGameBootstrapAdmission(db, inviteId, signal()),
    ).rejects.toThrow("game-session-transition-resource-pending");
    await expect(
      createGameplayRepository(env).readInviteMetadata(inviteId),
    ).rejects.toThrow("game-session-transition-resource-pending");
  });

  it("rejects retired or malformed controls and retired source fields", async () => {
    await db.batch([
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        "INSERT INTO automatch_runtime_control (singleton, backend, state, epoch, freeze_generation) VALUES (1, 'rtdb', 'active', 1, 0)",
      ),
    ]);
    await expect(
      readGameBootstrapAdmission(db, inviteId, signal()),
    ).rejects.toThrow("automatch-control-unavailable");
    await db
      .prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1' WHERE singleton = 1",
      )
      .run();
    await db
      .prepare(
        "UPDATE invite_source_control SET backend = 'rtdb', epoch = 0 WHERE singleton = 1",
      )
      .run();
    await expect(
      readGameBootstrapAdmission(db, inviteId, signal()),
    ).rejects.toThrow("invite-source-backend-retired");
    await db
      .prepare(
        "UPDATE invite_source_control SET backend = 'd1', epoch = 1, verified_at_ms = NULL WHERE singleton = 1",
      )
      .run();
    await expect(
      readGameBootstrapAdmission(db, inviteId, signal()),
    ).rejects.toThrow("invite-source-control-unavailable");
    await db
      .prepare(
        "UPDATE invite_source_control SET verified_at_ms = 1 WHERE singleton = 1",
      )
      .run();
    await db
      .prepare(
        "UPDATE invite_sources_canonical SET source_json = ? WHERE invite_id = ?",
      )
      .bind(JSON.stringify({ ...source, wagers: {} }), inviteId)
      .run();
    await expect(
      readGameBootstrapAdmission(db, inviteId, signal()),
    ).rejects.toThrow("invite-source-corrupt");
  });

  it("checks cancellation both before the batch and before returning its rows", async () => {
    const controller = new AbortController();
    const observed = observe(() => controller.abort());
    await expect(
      readGameBootstrapAdmission(
        observed.database,
        inviteId,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(observed.batches).toEqual([4]);
    const canceled = observe();
    await expect(
      readGameBootstrapAdmission(
        canceled.database,
        inviteId,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(canceled.sessions).toEqual([]);
  });
});
