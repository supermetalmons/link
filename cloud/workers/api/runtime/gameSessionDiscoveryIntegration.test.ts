import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { createSeededRandom } from "@mons/shared/ids";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startAutomatch,
  type AutomatchDependencies,
} from "../src/automatch.ts";
import {
  createAutomatchD1Store,
  parseAutomatchPath,
} from "../src/automatchD1.ts";
import { createEventGameplayRepository } from "../src/eventRepository.ts";
import type { StateRepository } from "../src/stateRepositoryTypes.ts";
import { createGameSessionMutationLockStore } from "../src/gameplayCoordinationD1.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import {
  createManualInvite,
  ensureParticipantMatch,
  joinInvite,
  proposeRematch,
} from "../src/gameSessionMutations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
const db = env.PROFILE_GAMES_DB;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class MemoryStateRepository implements StateRepository {
  readonly data: Record<string, unknown> = {};
  readonly writes: string[] = [];

  async getPath(
    path: string,
    query?: Parameters<StateRepository["getPath"]>[1],
  ): Promise<unknown> {
    if (parseAutomatchPath(path) || path.startsWith("invites/"))
      throw new Error("retired-source-read");
    let value: unknown = this.data;
    for (const key of path.split("/")) {
      if (!record(value) || !Object.hasOwn(value, key)) return null;
      value = value[key];
    }
    return query?.shallow && record(value)
      ? Object.fromEntries(Object.keys(value).map((key) => [key, true]))
      : structuredClone(value ?? null);
  }

  async patchRoot(updates: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(updates)) {
      if (parseAutomatchPath(path) || path.startsWith("invites/"))
        throw new Error("retired-source-write");
      const parts = path.split("/");
      let parent = this.data;
      for (const key of parts.slice(0, -1)) {
        if (!record(parent[key])) parent[key] = {};
        parent = parent[key] as Record<string, unknown>;
      }
      const key = parts.at(-1)!;
      if (value === null) delete parent[key];
      else parent[key] = structuredClone(value);
      this.writes.push(path);
    }
  }

  async transactPath(path: string, updater: (current: unknown) => unknown) {
    const current = await this.getPath(path);
    const decision = updater(current);
    if (!record(decision)) throw new Error("invalid-test-transaction");
    if (decision.commit !== false)
      await this.patchRoot({ [path]: decision.value });
    return {
      committed: decision.commit !== false,
      decision: String(decision.decision),
      value: decision.commit === false ? current : decision.value,
    };
  }
}

function client(memoryState: MemoryStateRepository, uid: string) {
  const repository = createEventGameplayRepository(
    env,
    createGameplayRepository(env, { stateClient: memoryState }),
  );
  const persistence = repository.automatchPersistence!;
  const dependencies: AutomatchDependencies = {
    mutationLocks: persistence.decorateLocks(
      createGameSessionMutationLockStore(db),
    ),
    random: createSeededRandom(uid),
    enqueueProfileGameProjection: async () => {},
    enqueueTelegramProjection: async () => {},
  };
  return { repository, dependencies, persistence, identity: { uid } };
}

function operation() {
  return { operationId: crypto.randomUUID(), emojiId: 1, aura: "" };
}

function request(inviteId: string) {
  return { inviteId, ...operation() };
}

async function captured() {
  const result = await db
    .prepare(
      "SELECT login_uid, match_id, invite_id, resolution, provenance FROM login_match_discovery ORDER BY login_uid, match_id",
    )
    .all();
  return result.results;
}

function mapping(loginUid: string, matchId: string, inviteId = matchId) {
  return {
    login_uid: loginUid,
    match_id: matchId,
    invite_id: inviteId,
    resolution: "resolved",
    provenance: "capture",
  };
}

async function assertPublished(inviteId: string, operationId: string) {
  const store = createAutomatchD1Store(db);
  expect(
    await store.getPath(`gameplayMutationReceipts/${operationId}`),
  ).toMatchObject({
    operationId,
  });
  expect(
    await store.getPath(`profileGameProjectionOutbox/automatch/${inviteId}`),
  ).toMatchObject({ requestId: expect.any(String) });
  expect(
    await db
      .prepare(
        "SELECT count(*) AS count FROM game_session_transitions WHERE status = 'pending'",
      )
      .first("count"),
  ).toBe(0);
}

describe("game discovery through the production gameplay repositories", () => {
  beforeAll(async () => {
    await applyStrictMatchStateTestMigrations(db, testEnv.TEST_D1_MIGRATIONS);
    await applyRetiredProfileMigrations(
      env.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  beforeEach(async () => {
    await resetMatchPresentationTestState(
      db,
      testEnv.TEST_D1_MIGRATIONS,
      "durable",
    );
    await db.batch([
      db.prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, freeze_generation = 0, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE login_match_discovery_control SET capture_enforced = 1, capture_version_id = '11111111-1111-4111-8111-111111111111', capture_started_at_ms = 1 WHERE singleton = 1",
      ),
      ...[
        "login_match_discovery",
        "invite_sources",
        "invite_source_write_admissions",
        "game_session_transition_resources",
        "game_session_transitions",
        "game_session_mutation_locks",
        "automatch_write_admissions",
        "automatch_entries",
        "automatch_telegram_sources",
        "automatch_telegram_projection_outbox",
        "game_session_projection_outbox",
        "game_session_mutation_receipts",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    ]);
  });

  it("captures anonymous manual creation, guest joining, and both rematch participants", async () => {
    const memoryState = new MemoryStateRepository();
    const host = client(memoryState, "host");
    const guest = client(memoryState, "guest");
    const creation = request("manual-discovery");
    const created = await createManualInvite(
      host.identity,
      creation,
      host.repository,
      host.dependencies,
    );
    expect(created).toMatchObject({ ok: true, hostId: "host" });
    expect(await captured()).toEqual([mapping("host", creation.inviteId)]);
    await assertPublished(creation.inviteId, creation.operationId);
    const writes = memoryState.writes.length;
    expect(
      await createManualInvite(
        host.identity,
        creation,
        host.repository,
        host.dependencies,
      ),
    ).toEqual(created);
    expect(memoryState.writes).toHaveLength(writes);

    const joining = request(creation.inviteId);
    expect(
      await joinInvite(
        guest.identity,
        joining,
        guest.repository,
        guest.dependencies,
      ),
    ).toMatchObject({ joined: true, guestId: "guest" });
    await assertPublished(creation.inviteId, joining.operationId);

    const proposing = request(creation.inviteId);
    const proposed = await proposeRematch(
      host.identity,
      proposing,
      host.repository,
      host.dependencies,
    );
    expect(proposed.matchId).toBe(`${creation.inviteId}1`);
    const ensuring = {
      ...request(creation.inviteId),
      matchId: proposed.matchId,
    };
    expect(
      await ensureParticipantMatch(
        guest.identity,
        ensuring,
        guest.repository,
        guest.dependencies,
      ),
    ).toMatchObject({ actorUid: "guest", created: true });
    await assertPublished(creation.inviteId, proposing.operationId);
    await assertPublished(creation.inviteId, ensuring.operationId);
    expect(await captured()).toEqual([
      mapping("guest", creation.inviteId),
      mapping("guest", proposed.matchId, creation.inviteId),
      mapping("host", creation.inviteId),
      mapping("host", proposed.matchId, creation.inviteId),
    ]);
  });

  it("captures automatic matchmaking for both anonymous logins", async () => {
    const memoryState = new MemoryStateRepository();
    const host = client(memoryState, "host");
    const guest = client(memoryState, "guest");
    const hostRequest = operation();
    const pending = await startAutomatch(
      host.identity,
      hostRequest,
      host.repository,
      host.dependencies,
    );
    expect(pending).toMatchObject({ ok: true, mode: "pending" });
    if (!pending.ok) throw new Error("expected-pending-invite");
    await assertPublished(pending.inviteId, hostRequest.operationId);
    const guestRequest = operation();
    expect(
      await startAutomatch(
        guest.identity,
        guestRequest,
        guest.repository,
        guest.dependencies,
      ),
    ).toMatchObject({ ok: true, mode: "matched", inviteId: pending.inviteId });
    await assertPublished(pending.inviteId, guestRequest.operationId);
    expect(await captured()).toEqual([
      mapping("guest", pending.inviteId),
      mapping("host", pending.inviteId),
    ]);
  });

  it("retains a failed capture in the journal and recovers without rewriting the live match", async () => {
    const memoryState = new MemoryStateRepository();
    const host = client(memoryState, "host");
    const creation = request("capture-recovery");
    await db.exec(
      "CREATE TRIGGER test_capture_failure BEFORE INSERT ON login_match_discovery BEGIN SELECT RAISE(ABORT, 'test-discovery-unavailable'); END;",
    );
    try {
      await expect(
        createManualInvite(
          host.identity,
          creation,
          host.repository,
          host.dependencies,
        ),
      ).rejects.toThrow("test-discovery-unavailable");
      expect(await captured()).toEqual([]);
      expect(
        await db
          .prepare("SELECT status FROM game_session_transitions")
          .first("status"),
      ).toBe("pending");
      const store = createAutomatchD1Store(db);
      expect(
        await store.getPath(`gameplayMutationReceipts/${creation.operationId}`),
      ).toBeNull();
      expect(
        await store.getPath(
          `profileGameProjectionOutbox/automatch/${creation.inviteId}`,
        ),
      ).toBeNull();
    } finally {
      await db.exec("DROP TRIGGER test_capture_failure");
    }
    expect(await host.persistence.sweep()).toEqual({ recovered: 1, failed: 0 });
    expect(await captured()).toEqual([mapping("host", creation.inviteId)]);
    expect(
      memoryState.writes.filter(
        (path) => path === `players/host/matches/${creation.inviteId}`,
      ),
    ).toHaveLength(1);
    await assertPublished(creation.inviteId, creation.operationId);
  });
});
