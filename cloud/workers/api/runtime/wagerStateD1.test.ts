import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { StateRepository } from "../src/stateRepositoryTypes.ts";
import {
  acquireWagerReservationAdmission,
  releaseWagerReservationAdmission,
  wagerReservationAdmissionGuards,
} from "../src/wagerReservationControl.ts";
import {
  assertWagerStateActivated,
  createWagerStateD1Store,
} from "../src/wagerStateD1.ts";
import { createWagerStateRepository } from "../src/wagerStateRepository.ts";
import { notifyInviteSourceChanged } from "../src/inviteWagersNotifications.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const migrations = (env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] })
  .TEST_PROFILE_D1_MIGRATIONS;
const db = env.PROFILE_DB;
const now = () => 2_000_000;

const unexpectedSource: StateRepository = {
  async getPath() {
    throw new Error("unexpected-source-read");
  },
  async patchRoot() {
    throw new Error("unexpected-source-write");
  },
  async transactPath() {
    throw new Error("unexpected-source-transaction");
  },
};

async function withWriter<T>(
  work: (writeGuards: () => readonly D1PreparedStatement[]) => Promise<T>,
): Promise<T> {
  const admission = await acquireWagerReservationAdmission(
    db,
    "state-test",
    now(),
  );
  try {
    return await work(() =>
      wagerReservationAdmissionGuards(db, admission, now()),
    );
  } finally {
    await releaseWagerReservationAdmission(db, admission);
  }
}

describe("canonical wager state", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(db, migrations, "a".repeat(64));
  });

  it("commits wager completion and its marker atomically and retains deletion revisions", async () => {
    await withWriter(async (writeGuards) => {
      const notifications: boolean[] = [];
      const client = createWagerStateRepository(db, unexpectedSource, {
        writeGuards,
        now,
        notify: async (_updates, committed) => {
          notifications.push(committed);
        },
      });
      const path = "invites/atomic/wagers/atomic";
      const initial = await client.transactPath(path, () => ({
        value: {
          proposals: { host: { count: 2 } },
          agreementOperation: { ids: ["first", "second"] },
        },
        decision: "created",
      }));
      expect(initial.committed).toBe(true);
      expect(initial.decision).toBe("created");
      await client.patchRoot({
        [`${path}/settlement/state`]: "completed",
        [`${path}/proposals`]: null,
        "invites/atomic/matchesWagerResolutions/atomic": true,
      });
      expect(await client.getPath(path)).toEqual({
        agreementOperation: { ids: ["first", "second"] },
        settlement: { state: "completed" },
      });
      expect(
        await client.getPath("invites/atomic/matchesWagerResolutions/atomic"),
      ).toBe(true);
      const row = await db
        .prepare(
          "SELECT revision, resolution_marker, wager_json FROM invite_wager_states WHERE invite_id = 'atomic'",
        )
        .first<{
          revision: number;
          resolution_marker: number;
          wager_json: string;
        }>();
      expect(row?.revision).toBe(2);
      expect(row?.resolution_marker).toBe(1);
      expect(JSON.parse(row!.wager_json).settlement.state).toBe("completed");
      const aborted = await client.transactPath(path, () => ({
        commit: false,
        decision: "already-completed",
      }));
      expect(aborted).toEqual({
        committed: false,
        decision: "already-completed",
        value: await client.getPath(path),
      });
      await client.patchRoot({
        [path]: null,
        "invites/atomic/matchesWagerResolutions/atomic": null,
      });
      expect(await client.getPath(path)).toBeNull();
      expect(
        await db
          .prepare(
            "SELECT revision FROM invite_wager_states WHERE invite_id = 'atomic'",
          )
          .first("revision"),
      ).toBe(3);
      expect(notifications).toEqual([true, true, true]);
    });
  });

  it("merges canonical wagers into full invite reads and masks retained Firebase values", async () => {
    await withWriter(async (writeGuards) => {
      const base: StateRepository = {
        ...unexpectedSource,
        async getPath(path, query) {
          if (path === "invites/missing") return null;
          return query?.shallow
            ? { hostId: true, wagers: true, matchesWagerResolutions: true }
            : {
                hostId: "host",
                guestId: "guest",
                wagers: { legacy: { agreed: { count: 99 } } },
                matchesWagerResolutions: { legacy: true },
              };
        },
      };
      const client = createWagerStateRepository(db, base, { writeGuards, now });
      await client.patchRoot({
        "invites/composed/wagers/composed": {
          agreed: { count: 2 },
          proposals: null,
        },
        "invites/composed/matchesWagerResolutions/composed": false,
      });
      expect(await client.getPath("invites/composed")).toEqual({
        hostId: "host",
        guestId: "guest",
        wagers: { composed: { agreed: { count: 2 } } },
        matchesWagerResolutions: { composed: false },
      });
      expect(await client.getPath("invites/empty")).toEqual({
        hostId: "host",
        guestId: "guest",
      });
      expect(await client.getPath("invites/empty", { shallow: true })).toEqual({
        hostId: true,
      });
      expect(
        await client.getPath("invites/composed/wagers", { shallow: true }),
      ).toEqual({ composed: true });
      expect(await client.getPath("invites/missing")).toBeNull();
    });
  });

  it("projects only field presence for shallow reads of large wager histories", async () => {
    await withWriter(async (writeGuards) => {
      const history = "x".repeat(100_000);
      const client = createWagerStateRepository(
        db,
        {
          ...unexpectedSource,
          async getPath(path, query) {
            expect(query).toEqual({ shallow: true });
            return path === "invites/shallow-missing" ? null : { hostId: true };
          },
        },
        { writeGuards, now },
      );
      await client.patchRoot({
        "invites/shallow-history/wagers/first": { history },
        "invites/shallow-history/wagers/second": { history },
        "invites/shallow-history/wagers/deleted": { history },
        "invites/shallow-history/matchesWagerResolutions/first": false,
        "invites/shallow-history/matchesWagerResolutions/marker": true,
      });
      await client.patchRoot({
        "invites/shallow-history/wagers/deleted": null,
      });
      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(
          await client.getPath("invites/shallow-history", { shallow: true }),
        ).toEqual({
          hostId: true,
          wagers: true,
          matchesWagerResolutions: true,
        });
        expect(
          await client.getPath("invites/shallow-history/wagers", {
            shallow: true,
          }),
        ).toEqual({ first: true, second: true });
        expect(
          await client.getPath(
            "invites/shallow-history/matchesWagerResolutions",
            { shallow: true },
          ),
        ).toEqual({ first: true, marker: true });
        expect(
          await client.getPath("invites/shallow-missing", { shallow: true }),
        ).toBeNull();
        expect(
          parse.mock.calls.reduce((bytes, [json]) => bytes + json.length, 0),
        ).toBeLessThan(history.length);
      } finally {
        parse.mockRestore();
      }
      expect(
        await client.getPath("invites/shallow-history/wagers/first"),
      ).toEqual({ history });
    });
  });

  it("retries concurrent state changes and rolls back every row when a CAS snapshot is stale", async () => {
    await withWriter(async (writeGuards) => {
      const client = createWagerStateRepository(db, unexpectedSource, {
        writeGuards,
        now,
      });
      await Promise.all(
        [1, 2].map(() =>
          client.transactPath(
            "invites/concurrent/wagers/concurrent",
            (value) => ({
              value: {
                count:
                  Number((value as { count?: number } | null)?.count || 0) + 1,
              },
            }),
          ),
        ),
      );
      expect(
        await client.getPath("invites/concurrent/wagers/concurrent/count"),
      ).toBe(2);
      const store = createWagerStateD1Store(db, { writeGuards, now });
      const stale = await store.read({
        inviteId: "concurrent",
        matchId: "concurrent",
      });
      const missing = await store.read({ inviteId: "other", matchId: "other" });
      await client.patchRoot({
        "invites/concurrent/matchesWagerResolutions/concurrent": true,
      });
      expect(
        await store.commit([
          {
            current: missing,
            value: { wager: { count: 3 }, resolutionMarker: true },
          },
          {
            current: stale,
            value: { wager: { count: 4 }, resolutionMarker: null },
          },
        ]),
      ).toBe(false);
      expect(
        (await store.read({ inviteId: "other", matchId: "other" })).revision,
      ).toBe(0);
      expect(
        await client.getPath("invites/concurrent/wagers/concurrent/count"),
      ).toBe(2);
      expect(
        await client.getPath(
          "invites/concurrent/matchesWagerResolutions/concurrent",
        ),
      ).toBe(true);
    });
  });

  it("keeps admission guards in the state transaction and invalidates uncertain commits", async () => {
    await withWriter(async (writeGuards) => {
      const rejected = createWagerStateRepository(db, unexpectedSource, {
        writeGuards: () => [
          ...writeGuards(),
          db.prepare(
            "INSERT INTO wager_state_write_guards (singleton) VALUES (0)",
          ),
        ],
        now,
      });
      await expect(
        rejected.patchRoot({
          "invites/rejected/wagers/rejected": { agreed: { count: 5 } },
          "invites/rejected/matchesWagerResolutions/rejected": true,
        }),
      ).rejects.toThrow();
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) FROM invite_wager_states WHERE invite_id = 'rejected'",
          )
          .first("COUNT(*)"),
      ).toBe(0);
      const notifications: boolean[] = [];
      const uncertainDb = new Proxy(db, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              await target.batch(statements);
              throw new Error("response-lost-after-commit");
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const uncertain = createWagerStateRepository(
        uncertainDb,
        unexpectedSource,
        {
          writeGuards,
          now,
          notify: async (_updates, committed) => {
            notifications.push(committed);
          },
        },
      );
      await expect(
        uncertain.patchRoot({
          "invites/uncertain/wagers/uncertain": { operationId: "once" },
        }),
      ).rejects.toThrow("response-lost-after-commit");
      const reader = createWagerStateRepository(db, unexpectedSource);
      expect(
        await reader.getPath("invites/uncertain/wagers/uncertain"),
      ).toEqual({ operationId: "once" });
      expect(notifications).toEqual([false]);
    });
  });

  it("delivers room invalidations for confirmed and ambiguous D1 writes while leaving reads and no-ops quiet", async () => {
    await withWriter(async (writeGuards) => {
      const notices: string[] = [];
      const notifyingEnv = {
        ...env,
        INVITE_REACTIONS: {
          getByName: (inviteId: string) => ({
            notifyWagersChanged: async () => {
              notices.push(inviteId);
            },
          }),
        },
      } as unknown as Env;
      const notify = (updates: Record<string, unknown>, committed: boolean) =>
        notifyInviteSourceChanged(notifyingEnv, updates, committed);
      for (const operation of ["patch", "transaction"]) {
        const inviteId = `notified-${operation}`;
        const path = `invites/${inviteId}/wagers/${inviteId}`;
        const client = createWagerStateRepository(db, unexpectedSource, {
          writeGuards,
          now,
          notify,
        });
        const write = (repository: StateRepository, value: unknown) =>
          operation === "patch"
            ? repository.patchRoot({ [path]: value })
            : repository.transactPath(path, () => ({ value }));
        await write(client, { phase: "confirmed" });
        expect(notices.splice(0)).toEqual([inviteId]);
        await client.transactPath(path, () => ({
          commit: false,
          decision: "already-applied",
        }));
        expect(notices).toEqual([]);
        const uncertainDb = new Proxy(db, {
          get(target, property) {
            if (property === "batch")
              return async (statements: D1PreparedStatement[]) => {
                await target.batch(statements);
                throw new Error("lost-commit-response");
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        await expect(
          write(
            createWagerStateRepository(uncertainDb, unexpectedSource, {
              writeGuards,
              now,
              notify,
            }),
            { phase: "ambiguous" },
          ),
        ).rejects.toThrow("lost-commit-response");
        expect(await client.getPath(path)).toEqual({ phase: "ambiguous" });
        expect(notices.splice(0)).toEqual([inviteId]);
        const unreadableDb = new Proxy(db, {
          get(target, property) {
            if (property === "withSession")
              return () => {
                throw new Error("read-unavailable");
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        await expect(
          write(
            createWagerStateRepository(unreadableDb, unexpectedSource, {
              writeGuards,
              now,
              notify,
            }),
            { phase: "not-written" },
          ),
        ).rejects.toThrow();
        expect(await client.getPath(path)).toEqual({ phase: "ambiguous" });
        expect(notices).toEqual([]);
      }
    });
  });
});

it("requires verified activation and permanently fences legacy default-epoch writers", async () => {
  const activationDb = env.PROFILE_GAMES_DB;
  await applyRetiredProfileMigrations(
    activationDb,
    migrations,
    "b".repeat(64),
    { activateWagerState: false },
  );
  await expect(assertWagerStateActivated(activationDb)).rejects.toThrow(
    "wager-state-not-activated",
  );
  await activationDb.batch([
    activationDb.prepare(
      "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
    ),
    activationDb.prepare(
      "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
    ),
  ]);
  await expect(
    activationDb
      .prepare(
        "UPDATE wager_state_activation SET activation_epoch = 1 WHERE singleton = 1",
      )
      .run(),
  ).rejects.toThrow("wager state import is not verified");
  await activationDb
    .prepare(
      `UPDATE wager_state_activation SET activation_epoch = 1,
       source_digest = ?, import_digest = ?, baseline_digest = ?, verified_baseline_digest = ?,
       source_wager_count = 0, source_marker_count = 0, source_row_count = 0, imported_row_count = 0,
       verified_freeze_generation = (SELECT freeze_generation FROM wager_reservation_runtime_control WHERE singleton = 1),
       verified_at_ms = 1, activated_at_ms = 2, candidate_version_id = 'final-candidate'
     WHERE singleton = 1`,
    )
    .bind(...Array<string>(4).fill("b".repeat(64)))
    .run();
  await expect(
    assertWagerStateActivated(activationDb),
  ).resolves.toBeUndefined();
  await expect(
    activationDb
      .prepare(
        "UPDATE wager_state_activation SET activation_epoch = 0 WHERE singleton = 1",
      )
      .run(),
  ).rejects.toThrow("wager state activation is immutable");
  await activationDb.batch([
    activationDb.prepare(
      "UPDATE wager_reservation_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
    ),
    activationDb.prepare(
      "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
    ),
  ]);
  await expect(
    activationDb
      .prepare(
        `INSERT INTO wager_reservation_write_admissions
       (admission_id, freeze_generation, kind, created_at_ms, expires_at_ms)
     SELECT 'legacy', freeze_generation, 'legacy-binary', 1, 100
     FROM wager_reservation_runtime_control WHERE singleton = 1`,
      )
      .run(),
  ).rejects.toThrow("wager state writer epoch is unsupported");
  const admission = await acquireWagerReservationAdmission(
    activationDb,
    "new-binary",
    now(),
  );
  expect(
    await activationDb
      .prepare(
        "SELECT writer_epoch FROM wager_reservation_write_admissions WHERE admission_id = ?",
      )
      .bind(admission.admissionId)
      .first("writer_epoch"),
  ).toBe(1);
  await releaseWagerReservationAdmission(activationDb, admission);
});
