import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyMaterials } from "@mons/shared/mining";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import type { StateRepository } from "../src/stateRepositoryTypes.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { createInviteSourceReader } from "../src/inviteSource.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { createWagerReservationRuntime } from "../src/wagerReservationRuntime.ts";
import {
  acceptWagerProposal,
  removeWagerProposal,
  sendWagerProposal,
} from "../src/wagerProposal.ts";
import {
  classifyWagerSettlementRetry,
  resolveWagerOutcome,
  resumeWagerSettlement,
  type WagerSettlementRetryTask,
} from "../src/wagerOutcome.ts";
import { createMemoryGameplayCoordinationStores } from "../test/gameplayCoordinationTestUtils.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & {
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_D1_MIGRATIONS: D1Migration[];
};
const now = () => 3_000_000;

async function insertProfile(loginUid: string) {
  const profile: CompletePlayerProfile = {
    id: `profile-${loginUid}`,
    nonce: 1,
    rating: 1500,
    totalManaPoints: 0,
    win: false,
    emoji: 2,
    username: null,
    eth: null,
    sol: null,
    feb2026UniqueOpponentsCount: 0,
    mining: {
      lastRockDate: "2026-09-07",
      materials: { ...createEmptyMaterials(), dust: 10 },
    },
  };
  await commitCanonicalPlan(env.PROFILE_DB, {
    expectations: [
      { kind: "profile-absent", profileId: profile.id },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          profile,
          createdAtMs: now(),
          updatedAtMs: now(),
        }),
      },
      {
        kind: "insert-login-owner",
        value: {
          loginUid,
          profileId: profile.id,
          createdAtMs: now(),
          updatedAtMs: now(),
        },
      },
    ],
  });
  return profile.id;
}

async function fixture(failCompletedWrite = false) {
  const inviteId = `wager_${crypto.randomUUID().replaceAll("-", "")}`;
  const host = `${inviteId}-host`;
  const guest = `${inviteId}-guest`;
  const [hostProfile, guestProfile] = await Promise.all([
    insertProfile(host),
    insertProfile(guest),
  ]);
  let sourceWrites = 0;
  let failureInjected = false;
  const staleWager = {
    proposals: { [host]: { material: "dust", count: 999 } },
  };
  const memoryState: StateRepository = {
    async getPath(path) {
      if (path === `invites/${inviteId}`)
        return {
          hostId: host,
          guestId: guest,
          hostColor: "white",
          wagers: { [inviteId]: staleWager },
          matchesWagerResolutions: { [inviteId]: true },
        };
      if (path === `players/${host}/matches/${inviteId}`)
        return { color: "white", fen: "fixture", flatMovesString: "" };
      if (path === `players/${guest}/matches/${inviteId}`)
        return {
          color: "black",
          fen: "fixture",
          flatMovesString: "",
          status: "surrendered",
        };
      throw new Error(`unexpected-source-read:${path}`);
    },
    async patchRoot() {
      sourceWrites++;
      throw new Error("unexpected-source-write");
    },
    async transactPath() {
      sourceWrites++;
      throw new Error("unexpected-source-transaction");
    },
  };
  const profileDb = new Proxy(env.PROFILE_DB, {
    get(target, property) {
      if (property === "batch")
        return async <T>(statements: D1PreparedStatement[]) => {
          const result = await target.batch<T>(statements);
          if (failCompletedWrite && !failureInjected) {
            const row = await target
              .prepare(
                "SELECT json_extract(wager_json, '$.settlement.state') AS state FROM invite_wager_states WHERE invite_id = ? AND match_id = ?",
              )
              .bind(inviteId, inviteId)
              .first<{ state: string }>();
            if (row?.state === "completed") {
              failureInjected = true;
              throw new Error("ambiguous-completed-wager-write");
            }
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtimeEnv = { ...env, PROFILE_DB: profileDb };
  await env.PROFILE_GAMES_DB.prepare(
    `INSERT INTO invite_sources (invite_id, source_json, revision, updated_at_ms)
       VALUES (?, ?, 1, ?)`,
  )
    .bind(
      inviteId,
      JSON.stringify({ hostId: host, guestId: guest, hostColor: "white" }),
      now(),
    )
    .run();
  const repository = createGameplayRepository(runtimeEnv, {
    stateClient: memoryState,
    now,
  });
  const runtime = createWagerReservationRuntime(runtimeEnv, repository, {
    now,
  });
  const readSource = createInviteSourceReader(runtimeEnv);
  const { mutationLocks } = createMemoryGameplayCoordinationStores();
  const request = {
    inviteId,
    matchId: inviteId,
    material: "dust" as const,
    count: 2,
  };
  const send = (uid = host) =>
    runtime.run("send", (admitted, guard) =>
      sendWagerProposal({ uid }, request, admitted, {
        now,
        mutationLocks,
        assertMutationAllowed: guard,
      }),
    );
  const accept = () =>
    runtime.run("accept", (admitted, guard) =>
      acceptWagerProposal({ uid: guest }, request, admitted, {
        now,
        mutationLocks,
        assertMutationAllowed: guard,
      }),
    );
  return {
    inviteId,
    host,
    guest,
    hostProfile,
    guestProfile,
    request,
    repository,
    runtime,
    readSource,
    send,
    accept,
    mutationLocks,
    sourceWrites: () => sourceWrites,
    failureInjected: () => failureInjected,
  };
}

describe("D1 wager gameplay integration", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.PROFILE_GAMES_DB, testEnv.TEST_D1_MIGRATIONS);
    await applyRetiredProfileMigrations(
      env.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
    await env.PROFILE_GAMES_DB.batch([
      env.PROFILE_GAMES_DB.prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active' WHERE singleton = 1",
      ),
      env.PROFILE_GAMES_DB.prepare(
        `UPDATE invite_source_control SET backend = 'd1', state = 'active',
         epoch = 1, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1`,
      ),
    ]);
  });

  it("ignores retained Firebase wagers and safely cancels and declines D1 proposals", async () => {
    for (const action of ["cancel", "decline"] as const) {
      const state = await fixture();
      expect(
        await state.repository.getStatePath(
          `invites/${state.inviteId}/wagers/${state.inviteId}`,
        ),
      ).toBeNull();
      expect(await state.send()).toEqual({ ok: true, count: 2 });
      expect(await state.send()).toEqual({ ok: true, count: 2 });
      expect((await state.runtime.readBalance(state.host)).frozen.dust).toBe(2);
      const remove = () =>
        state.runtime.run(action, (admitted, guard) =>
          removeWagerProposal(
            { uid: action === "cancel" ? state.host : state.guest },
            state.request,
            action,
            admitted,
            {
              now,
              mutationLocks: state.mutationLocks,
              assertMutationAllowed: guard,
            },
          ),
        );
      expect((await remove()).ok).toBe(true);
      await remove();
      expect((await state.runtime.readBalance(state.host)).frozen.dust).toBe(0);
      expect(
        (await state.repository.getMiningMaterials(state.hostProfile)).dust,
      ).toBe(10);
      expect(state.sourceWrites()).toBe(0);
    }
  });

  it("settles once after an ambiguous final commit and replays queued work without changing balances", async () => {
    const state = await fixture(true);
    expect((await state.send()).ok).toBe(true);
    expect((await state.accept()).ok).toBe(true);
    expect((await state.runtime.readBalance(state.host)).frozen.dust).toBe(2);
    expect((await state.runtime.readBalance(state.guest)).frozen.dust).toBe(2);
    const queued: WagerSettlementRetryTask[] = [];
    const resolve = () =>
      state.runtime.run("resolve", (admitted, guard) =>
        resolveWagerOutcome({ uid: state.host }, state.request, admitted, {
          now,
          assertMutationAllowed: guard,
          scheduleRetry: async (task) => {
            queued.push(task);
          },
        }),
      );
    await expect(resolve()).rejects.toThrow("ambiguous-completed-wager-write");
    expect(state.failureInjected()).toBe(true);
    expect(queued).toHaveLength(1);
    expect(
      await classifyWagerSettlementRetry(queued[0], state.repository),
    ).toBe("completed");
    await state.runtime.run("retry", (admitted, guard) =>
      resumeWagerSettlement(queued[0], admitted, now, guard),
    );
    expect((await resolve()).ok).toBe(true);
    expect(
      (await state.repository.getMiningMaterials(state.hostProfile)).dust,
    ).toBe(12);
    expect(
      (await state.repository.getMiningMaterials(state.guestProfile)).dust,
    ).toBe(8);
    expect((await state.runtime.readBalance(state.host)).frozen.dust).toBe(0);
    expect((await state.runtime.readBalance(state.guest)).frozen.dust).toBe(0);
    expect(
      await state.repository.getStatePath(
        `invites/${state.inviteId}/matchesWagerResolutions/${state.inviteId}`,
      ),
    ).toBe(true);
    const stored = await state.repository.getStatePath(
      `invites/${state.inviteId}`,
    );
    expect(stored).toMatchObject({
      wagers: {
        [state.inviteId]: {
          resolved: { count: 2 },
          settlement: { state: "completed" },
        },
      },
    });
    expect(await state.readSource(state.inviteId)).toEqual(stored);
    expect(state.sourceWrites()).toBe(0);
  });
});
