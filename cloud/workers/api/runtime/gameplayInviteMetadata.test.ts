import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import type { StateRepository } from "../src/stateRepositoryTypes.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
const db = env.PROFILE_GAMES_DB;
const inviteId = "metadata-invite";
const source = {
  hostId: "host-login",
  guestId: "guest-login",
  hostColor: "white",
  customMetadata: { retained: true },
};
const raw: StateRepository = {
  async getPath() {
    throw new Error("unexpected-raw-source-read");
  },
  async patchRoot() {
    throw new Error("unexpected-raw-source-write");
  },
  async transactPath() {
    throw new Error("unexpected-raw-source-write");
  },
};

function repository(database = db, profileDb?: D1Database) {
  return createGameplayRepository(
    {
      ...env,
      PROFILE_DB:
        profileDb ??
        new Proxy(env.PROFILE_DB, {
          get() {
            throw new Error("unexpected-profile-database-access");
          },
        }),
    },
    { d1: database, stateClient: raw },
  );
}

async function insertSource(value: Record<string, unknown> = source) {
  await db
    .prepare(
      `INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms)
       VALUES (?, ?, 1, 1)`,
    )
    .bind(inviteId, JSON.stringify(value))
    .run();
}

async function reserveInvite() {
  await db.batch([
    db
      .prepare(
        `INSERT INTO game_session_transitions
         (transition_id, invite_id, payload_json, status, created_at_ms, updated_at_ms)
         VALUES ('metadata-transition', ?, '{}', 'pending', 1, 1)`,
      )
      .bind(inviteId),
    db
      .prepare(
        `INSERT INTO game_session_transition_resources (resource_key, transition_id)
         VALUES (?, 'metadata-transition')`,
      )
      .bind(inviteId),
  ]);
}

function afterSourceRead(after: () => Promise<void> | void): D1Database {
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values));
        if (property === "first")
          return async (...args: Parameters<D1PreparedStatement["first"]>) => {
            const value = await target.first(...args);
            await after();
            return value;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "withSession")
        return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
          new Proxy(target.withSession(constraint), {
            get(session, key) {
              if (key === "prepare")
                return (query: string) => {
                  const statement = session.prepare(query);
                  return query.includes("FROM invite_sources")
                    ? wrapStatement(statement)
                    : statement;
                };
              const value = Reflect.get(session, key, session);
              return typeof value === "function" ? value.bind(session) : value;
            },
          });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("gameplay invite metadata reads", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
    await applyRetiredProfileMigrations(
      env.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare("DELETE FROM invite_sources"),
      db.prepare("DELETE FROM automatch_runtime_control"),
      db.prepare(
        `INSERT INTO automatch_runtime_control
         (singleton, backend, state, epoch, freeze_generation)
         VALUES (1, 'd1', 'active', 1, 0)`,
      ),
      db.prepare("DELETE FROM invite_source_control"),
      db.prepare(
        `INSERT INTO invite_source_control
         (singleton, backend, state, epoch, freeze_generation, verified_at_ms, activated_at_ms)
         VALUES (1, 'd1', 'active', 1, 0, 1, 1)`,
      ),
    ]);
  });

  it("reads canonical source fields without accessing the profile database", async () => {
    await insertSource();
    const gameplay = repository();
    const value = await gameplay.readInviteMetadata(inviteId);
    expect(value).toEqual(source);
    expect(Object.hasOwn(value!, "password")).toBe(false);
    expect(Object.hasOwn(value!, "wagers")).toBe(false);
    expect(Object.hasOwn(value!, "matchesWagerResolutions")).toBe(false);
    expect(normalizeInviteMetadata(inviteId, value)).toMatchObject({
      status: "ok",
      passwordProtected: false,
    });
    await expect(gameplay.getStatePath(`invites/${inviteId}`)).rejects.toThrow(
      "unexpected-profile-database-access",
    );
  });

  it("returns null for a missing invite without accessing wagers", async () => {
    expect(await repository().readInviteMetadata(inviteId)).toBeNull();
  });

  it("preserves explicit password presence and malformed field values", async () => {
    const value = {
      hostId: 7,
      guestId: ["guest-login"],
      hostColor: { invalid: true },
      hostRematches: false,
      password: null,
      customMetadata: { retained: true },
    };
    await insertSource(value);
    expect(await repository().readInviteMetadata(inviteId)).toEqual(value);
  });

  it("keeps complete invite reads composed with canonical wager state", async () => {
    await insertSource();
    const wager = {
      proposals: { "host-login": { material: "dust", count: 2 } },
    };
    await env.PROFILE_DB.prepare(
      `INSERT INTO invite_wager_states
       (invite_id, match_id, wager_json, resolution_marker, revision, updated_at_ms)
       VALUES (?, ?, ?, 1, 1, 1)`,
    )
      .bind(inviteId, inviteId, JSON.stringify(wager))
      .run();
    const gameplay = repository(db, env.PROFILE_DB);
    expect(await gameplay.readInviteMetadata(inviteId)).toEqual(source);
    expect(await gameplay.getStatePath(`invites/${inviteId}`)).toEqual({
      ...source,
      wagers: { [inviteId]: wager },
      matchesWagerResolutions: { [inviteId]: true },
    });
  });

  it.each(["automatch_runtime_control", "invite_source_control"])(
    "allows reads while %s is frozen",
    async (table) => {
      await insertSource();
      await db.prepare(`UPDATE ${table} SET state = 'frozen'`).run();
      expect(await repository().readInviteMetadata(inviteId)).toEqual(source);
    },
  );

  it.each(["automatch", "invite"])(
    "rejects the retired %s backend without falling back",
    async (backend) => {
      await insertSource();
      if (backend === "automatch") {
        await db.batch([
          db.prepare("DELETE FROM automatch_runtime_control"),
          db.prepare(
            `INSERT INTO automatch_runtime_control
             (singleton, backend, state, epoch, freeze_generation)
             VALUES (1, 'rtdb', 'active', 1, 0)`,
          ),
        ]);
      } else {
        await db
          .prepare(
            `UPDATE invite_source_control SET backend = 'rtdb', epoch = 0,
             verified_at_ms = NULL, activated_at_ms = NULL WHERE singleton = 1`,
          )
          .run();
      }
      await expect(repository().readInviteMetadata(inviteId)).rejects.toThrow(
        "backend-retired",
      );
    },
  );

  it.each(["automatch_runtime_control", "invite_source_control"])(
    "rejects missing %s",
    async (table) => {
      await db.prepare(`DELETE FROM ${table}`).run();
      await expect(repository().readInviteMetadata(inviteId)).rejects.toThrow(
        "control-unavailable",
      );
    },
  );

  it("rejects an invite with a pending transition before reading the source", async () => {
    await insertSource();
    await reserveInvite();
    let reads = 0;
    const gameplay = repository(
      afterSourceRead(() => {
        reads++;
      }),
    );
    await expect(gameplay.readInviteMetadata(inviteId)).rejects.toThrow(
      "resource-pending",
    );
    expect(reads).toBe(0);
  });

  it("rejects a transition that starts while reading the source", async () => {
    await insertSource();
    const gameplay = repository(afterSourceRead(reserveInvite));
    await expect(gameplay.readInviteMetadata(inviteId)).rejects.toThrow(
      "resource-pending",
    );
  });

  it.each(["before", "during"])(
    "honors cancellation %s the read",
    async (when) => {
      await insertSource();
      const controller = new AbortController();
      const reason = new Error("metadata-read-cancelled");
      let reads = 0;
      const observed = afterSourceRead(() => {
        reads++;
        controller.abort(reason);
      });
      if (when === "before") controller.abort(reason);
      await expect(
        repository(observed).readInviteMetadata(inviteId, controller.signal),
      ).rejects.toBe(reason);
      expect(reads).toBe(when === "before" ? 0 : 1);
    },
  );
});
