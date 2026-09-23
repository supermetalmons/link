import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  acquireWagerReservationAdmission,
  releaseWagerReservationAdmission,
  wagerReservationAdmissionGuards,
} from "../src/wagerReservationControl.ts";
import {
  assertWagerStateActivated,
  createWagerStateD1Store,
  type WagerStateValue,
} from "../src/wagerStateD1.ts";
import {
  createWagerStateReader,
  createWagerStateRepository,
  type WagerKey,
} from "../src/wagerStateRepository.ts";
import {
  readStoredSettlement,
  type SendWagerProposalCommand,
} from "../src/wagerStateCommands.ts";
import { composeInviteWagerSource } from "../src/inviteWagerSource.ts";
import { notifyInviteRooms } from "../src/inviteRoomNotifications.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { classifyD1Failure } from "../src/d1Failure.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
const migrations = (env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] })
  .TEST_PROFILE_D1_MIGRATIONS;
const db = env.PROFILE_DB;
const now = () => 2_000_000;
const key = (inviteId: string): WagerKey => ({ inviteId, matchId: inviteId });
function proposal(
  playerUid = "host",
  material: SendWagerProposalCommand["material"] = "dust",
): SendWagerProposalCommand {
  return {
    playerUid,
    opponentUid: playerUid === "host" ? "guest" : "host",
    material,
    now: now(),
    operationId: playerUid === "host" ? "a".repeat(64) : "b".repeat(64),
    reservationOperationId: "c".repeat(64),
    selfAdjustmentOperationId: "d".repeat(64),
    opponentAdjustmentOperationId: "e".repeat(64),
    opponentProposal: null,
    reservedCount: 2,
  };
}
const claim = {
  resolution: {
    winnerUid: "host",
    loserUid: "guest",
    winnerProfileId: "profile-host",
    loserProfileId: "profile-guest",
  },
  operationId: "f".repeat(64),
  now: now(),
  acceptReservationOperationIdByUid: {
    host: "a".repeat(64),
    guest: "b".repeat(64),
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
function responseLost(
  database: D1Database,
  failure = new Error("response-lost-after-commit"),
): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await target.batch(statements);
          throw failure;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
describe("canonical wager state", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(db, migrations, "a".repeat(64));
  });
  it("commits completion and its marker atomically, preserves extensions, and retains deletion revisions", async () => {
    await withWriter(async (writeGuards) => {
      const notices: boolean[] = [];
      const writer = createWagerStateRepository(db, {
        writeGuards,
        now,
        notify: async (_id, committed) => {
          notices.push(committed);
        },
      });
      const store = createWagerStateD1Store(db, { writeGuards, now });
      const id = key("atomic");
      const initial = await store.read(id);
      await store.commit([
        {
          current: initial,
          value: {
            wager: { retained: { ids: ["first", "second"] } },
            resolutionMarker: null,
          },
        },
      ]);
      const claimed = await writer.claimSettlement(id, claim);
      expect(claimed.committed).toBe(true);
      const pending = await store.read(id);
      const wager = pending.wager as Record<string, unknown>;
      await store.commit([
        {
          current: pending,
          value: {
            wager: {
              ...wager,
              settlement: {
                ...(wager.settlement as Record<string, unknown>),
                extension: { retained: null },
              },
            },
            resolutionMarker: null,
          },
        },
      ]);
      const settlement = readStoredSettlement(claimed.value)!;
      const completed = await writer.completeSettlement(id, {
        settlement,
        completedAtMs: now() + 1,
        insufficientMaterials: false,
      });
      expect(completed.committed).toBe(true);
      expect(await writer.readResolutionMarker(id)).toBe(true);
      expect(await writer.readWager(id)).toMatchObject({
        retained: { ids: ["first", "second"] },
        settlement: {
          state: "completed",
          completedAtMs: now() + 1,
          extension: { retained: null },
        },
      });
      const row = await db
        .prepare(
          "SELECT revision,resolution_marker,wager_json FROM invite_wager_states WHERE invite_id='atomic'",
        )
        .first<{
          revision: number;
          resolution_marker: number;
          wager_json: string;
        }>();
      expect(row?.revision).toBe(4);
      expect(row?.resolution_marker).toBe(1);
      expect(JSON.parse(row!.wager_json).settlement.state).toBe("completed");
      expect(
        await writer.completeSettlement(id, {
          settlement,
          completedAtMs: now() + 2,
          insufficientMaterials: false,
        }),
      ).toMatchObject({ committed: false, decision: "completed" });
      const beforeDelete = await store.read(id);
      expect(
        await store.commit([
          {
            current: beforeDelete,
            value: { wager: null, resolutionMarker: null },
          },
        ]),
      ).toBe(true);
      expect(await writer.readWager(id)).toBeNull();
      expect((await store.read(id)).revision).toBe(5);
      expect(
        await store.commit([
          {
            current: beforeDelete,
            value: { wager: { stale: true }, resolutionMarker: true },
          },
        ]),
      ).toBe(false);
      expect(notices).toEqual([true, true]);
    });
  });
  it("reads canonical invite wager data without a fallback and masks retained source values when composing", async () => {
    await withWriter(async (writeGuards) => {
      const writer = createWagerStateRepository(db, { writeGuards, now });
      await writer.sendProposal(key("composed"), proposal());
      const states = await writer.readInviteWagerState("composed");
      const composed = composeInviteWagerSource(
        {
          hostId: "host",
          guestId: "guest",
          wagers: { legacy: { agreed: { count: 99 } } },
          matchesWagerResolutions: { legacy: true },
        },
        states,
        false,
      );
      expect(composed).toEqual({
        hostId: "host",
        guestId: "guest",
        wagers: { composed: await writer.readWager(key("composed")) },
      });
      expect(composeInviteWagerSource(null, states, false)).toBeNull();
      expect(await writer.readInviteWagerState("missing")).toEqual([]);
      expect(await writer.readWager(key("missing"))).toBeNull();
    });
  });
  it("reads only field presence for large histories without parsing retained payloads", async () => {
    await withWriter(async (writeGuards) => {
      const history = "x".repeat(100_000);
      const store = createWagerStateD1Store(db, { writeGuards, now });
      for (const [matchId, value] of Object.entries({
        first: { wager: { history }, resolutionMarker: false },
        second: { wager: { history }, resolutionMarker: null },
        deleted: { wager: null, resolutionMarker: null },
        marker: { wager: null, resolutionMarker: true },
      })) {
        const current = await store.read({
          inviteId: "shallow-history",
          matchId,
        });
        await store.commit([{ current, value: value as WagerStateValue }]);
      }
      const reader = createWagerStateReader(db);
      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(await reader.readInviteWagerPresence("shallow-history")).toEqual(
          {
            wagerMatchIds: ["first", "second"],
            resolutionMatchIds: ["first", "marker"],
          },
        );
        expect(
          parse.mock.calls.reduce((bytes, [json]) => bytes + json.length, 0),
        ).toBeLessThan(history.length);
      } finally {
        parse.mockRestore();
      }
      expect(
        await reader.readWager({
          inviteId: "shallow-history",
          matchId: "first",
        }),
      ).toEqual({ history });
    });
  });
  it("retries concurrent proposals and rolls back every row for a stale CAS snapshot", async () => {
    await withWriter(async (writeGuards) => {
      const writer = createWagerStateRepository(db, { writeGuards, now });
      const id = key("concurrent");
      const results = await Promise.all([
        writer.sendProposal(id, proposal("host", "dust")),
        writer.sendProposal(id, proposal("guest", "slime")),
      ]);
      expect(results.every((result) => result.committed)).toBe(true);
      expect(
        Object.keys((await writer.readWager(id))!.proposals as object).sort(),
      ).toEqual(["guest", "host"]);
      const observed = observeD1FailureDatabase(db);
      const store = createWagerStateD1Store(observed.database, {
        writeGuards,
        now,
      });
      const stale = await store.read(id);
      const missing = await store.read(key("other"));
      await writer.removeProposal(id, {
        proposalUid: "host",
        operationId: "remove",
        expectedReservationOperationId: proposal().reservationOperationId,
      });
      expect(
        await store.commit([
          {
            current: missing,
            value: { wager: { created: true }, resolutionMarker: true },
          },
          {
            current: stale,
            value: { wager: { overwritten: true }, resolutionMarker: true },
          },
        ]),
      ).toBe(false);
      expect(observed.errors).toHaveLength(1);
      expect(classifyD1Failure(observed.errors[0])).toBe(
        "wager-state-conflict",
      );
      expect((await store.read(key("other"))).revision).toBe(0);
      expect((await writer.readWager(id))?.overwritten).toBeUndefined();
    });
  });
  it.each(["host", "guest"])(
    "recomputes a conflicted proposal after a %s write and only notifies a confirmed change",
    async (competingPlayer) => {
      await withWriter(async (writeGuards) => {
        const id = key(`retry-${competingPlayer}`);
        const live = createWagerStateRepository(db, { writeGuards, now });
        const observed = observeD1FailureDatabase(db, {
          beforeBatch: async (attempt) => {
            if (attempt === 1)
              await live.sendProposal(
                id,
                proposal(
                  competingPlayer,
                  competingPlayer === "guest" ? "slime" : "dust",
                ),
              );
          },
        });
        const notices: boolean[] = [];
        const writer = createWagerStateRepository(observed.database, {
          writeGuards,
          now,
          notify: async (_id, committed) => {
            notices.push(committed);
          },
        });
        const result = await writer.sendProposal(id, proposal());
        const changed = competingPlayer === "guest";
        expect(result.committed).toBe(changed);
        expect(result.value).toEqual(await live.readWager(id));
        expect(observed.sessions).toHaveLength(2);
        expect(observed.batches).toHaveLength(changed ? 2 : 1);
        expect(observed.errors.map(classifyD1Failure)).toEqual([
          "wager-state-conflict",
        ]);
        expect(notices).toEqual(changed ? [true] : []);
      });
    },
  );
  it("stops after 25 wager-state conflicts without notifying or changing state", async () => {
    await withWriter(async (writeGuards) => {
      const observed = observeD1FailureDatabase(db);
      const notices: boolean[] = [];
      const writer = createWagerStateRepository(observed.database, {
        writeGuards: () => [
          ...writeGuards(),
          db.prepare(
            "INSERT INTO wager_state_revision_guards (singleton) VALUES (0)",
          ),
        ],
        now,
        notify: async (_id, committed) => {
          notices.push(committed);
        },
      });
      const id = key("retry-exhaustion");
      await expect(writer.sendProposal(id, proposal())).rejects.toThrow(
        "wager-state-conflict",
      );
      expect(observed.sessions).toHaveLength(25);
      expect(observed.batches).toHaveLength(25);
      expect(observed.errors.map(classifyD1Failure)).toEqual(
        Array(25).fill("wager-state-conflict"),
      );
      expect(notices).toEqual([]);
      expect((await createWagerStateD1Store(db).read(id)).revision).toBe(0);
    });
  });
  it("stops cancelled conflict retries before another read or notification", async () => {
    await withWriter(async (writeGuards) => {
      const id = key("retry-cancelled");
      const controller = new AbortController();
      const reason = new Error("cancelled-after-conflict");
      const live = createWagerStateRepository(db, { writeGuards, now });
      const observed = observeD1FailureDatabase(db, {
        beforeBatch: async () => {
          await live.sendProposal(id, proposal("guest"));
          controller.abort(reason);
        },
      });
      const notices: boolean[] = [];
      const writer = createWagerStateRepository(observed.database, {
        writeGuards,
        now,
        notify: async (_id, committed) => {
          notices.push(committed);
        },
      });
      await expect(
        writer.sendProposal(id, proposal(), controller.signal),
      ).rejects.toBe(reason);
      expect(observed.sessions).toHaveLength(1);
      expect(observed.batches).toHaveLength(1);
      expect(notices).toEqual([]);
      expect(
        Object.keys((await live.readWager(id))!.proposals as object),
      ).toEqual(["guest"]);
    });
  });
  it("keeps admission guards in completion and invalidates uncertain commits", async () => {
    await withWriter(async (writeGuards) => {
      const writer = createWagerStateRepository(db, { writeGuards, now });
      const id = key("rejected");
      await writer.sendProposal(id, proposal());
      const claimed = await writer.claimSettlement(id, claim);
      const settlement = readStoredSettlement(claimed.value)!;
      const observed = observeD1FailureDatabase(db);
      const rejected = createWagerStateRepository(observed.database, {
        writeGuards: () => [
          ...writeGuards(),
          db.prepare(
            "INSERT INTO wager_state_write_guards (singleton) VALUES (0)",
          ),
        ],
        now,
      });
      await expect(
        rejected.completeSettlement(id, {
          settlement,
          completedAtMs: now(),
          insufficientMaterials: false,
        }),
      ).rejects.toThrow();
      expect(observed.batches).toHaveLength(1);
      expect(observed.errors).toHaveLength(1);
      expect(classifyD1Failure(observed.errors[0])).toBe("guard");
      expect(await writer.readResolutionMarker(id)).toBeNull();
      expect((await writer.readWager(id))!.settlement).toMatchObject({
        state: "pending",
      });
      const notices: boolean[] = [];
      const uncertain = createWagerStateRepository(responseLost(db), {
        writeGuards,
        now,
        notify: async (_id, committed) => {
          notices.push(committed);
        },
      });
      await expect(
        uncertain.completeSettlement(id, {
          settlement,
          completedAtMs: now() + 1,
          insufficientMaterials: false,
        }),
      ).rejects.toThrow("response-lost-after-commit");
      expect(await writer.readResolutionMarker(id)).toBe(true);
      expect((await writer.readWager(id))!.settlement).toMatchObject({
        state: "completed",
      });
      expect(notices).toEqual([false]);
      expect(
        await writer.completeSettlement(id, {
          settlement,
          completedAtMs: now() + 2,
          insufficientMaterials: false,
        }),
      ).toMatchObject({ committed: false });
    });
  });
  it("does not treat a frozen-balance conflict as a wager-state conflict", async () => {
    await withWriter(async (writeGuards) => {
      const observed = observeD1FailureDatabase(db);
      const notices: boolean[] = [];
      const writer = createWagerStateRepository(observed.database, {
        writeGuards: () => [
          ...writeGuards(),
          db.prepare(
            `INSERT INTO wager_frozen_balances
             (player_uid, frozen_json, revision, updated_at_ms)
             VALUES ('foreign-conflict', '{"dust":0,"slime":0,"gum":0,"metal":0,"ice":0}', 0, 0)`,
          ),
        ],
        now,
        notify: async (_id, committed) => {
          notices.push(committed);
        },
      });
      await expect(
        writer.sendProposal(key("foreign-conflict"), proposal()),
      ).rejects.toThrow("wager_frozen_revision_guard");
      expect(observed.batches).toHaveLength(1);
      expect(observed.errors).toHaveLength(1);
      expect(classifyD1Failure(observed.errors[0])).toBe(
        "wager-frozen-conflict",
      );
      expect(notices).toEqual([false]);
      expect(
        (await createWagerStateD1Store(db).read(key("foreign-conflict")))
          .revision,
      ).toBe(0);
    });
  });
  it("fences settlement completion by operation and fingerprint without changing either record", async () => {
    await withWriter(async (writeGuards) => {
      const writer = createWagerStateRepository(db, { writeGuards, now });
      const id = key("fenced");
      await writer.sendProposal(id, proposal());
      const claimed = await writer.claimSettlement(id, claim);
      const settlement = readStoredSettlement(claimed.value)!;
      for (const wrong of [
        { ...settlement, operationId: "wrong" },
        { ...settlement, fingerprint: "wrong" },
      ])
        await expect(
          writer.completeSettlement(id, {
            settlement: wrong,
            completedAtMs: now(),
            insufficientMaterials: false,
          }),
        ).rejects.toThrow("wager-settlement-unavailable");
      expect(await writer.readWager(id)).toEqual(claimed.value);
      expect(await writer.readResolutionMarker(id)).toBeNull();
    });
  });
  it("notifies rooms on confirmed and ambiguous writes while reads and no-ops remain quiet", async () => {
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
      const notify = (inviteId: string) =>
        notifyInviteRooms(
          notifyingEnv,
          [inviteId],
          "notifyWagersChanged",
          "invite_wagers_notify_failed",
        );
      const id = key("notified");
      const writer = createWagerStateRepository(db, {
        writeGuards,
        now,
        notify,
      });
      await writer.sendProposal(id, proposal());
      expect(notices.splice(0)).toEqual([id.inviteId]);
      await writer.readWager(id);
      await writer.sendProposal(id, proposal());
      expect(notices).toEqual([]);
      const uncertain = createWagerStateRepository(responseLost(db), {
        writeGuards,
        now,
        notify,
      });
      await expect(
        uncertain.removeProposal(id, {
          proposalUid: "host",
          operationId: "remove",
          expectedReservationOperationId: proposal().reservationOperationId,
        }),
      ).rejects.toThrow("response-lost-after-commit");
      expect(notices.splice(0)).toEqual([id.inviteId]);
      expect(
        (await writer.readWager(id))!.proposalRemovalOperations,
      ).toHaveProperty("remove");
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
        createWagerStateRepository(unreadableDb, {
          writeGuards,
          now,
          notify,
        }).sendProposal(key("unreadable"), proposal()),
      ).rejects.toThrow("read-unavailable");
      expect(notices).toEqual([]);
    });
  });
  it("preserves confirmed writes and original errors when cancellation or notification failure follows a commit", async () => {
    await withWriter(async (writeGuards) => {
      const controller = new AbortController();
      const notices: boolean[] = [];
      const notify = async (_id: string, committed: boolean) => {
        notices.push(committed);
        throw new Error("notification-unavailable");
      };
      const connection = new Proxy(db, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              controller.abort(new Error("cancelled-after-commit"));
              return result;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const id = key("notification-failure");
      const writer = createWagerStateRepository(connection, {
        writeGuards,
        now,
        notify,
      });
      await expect(
        writer.sendProposal(id, proposal(), controller.signal),
      ).resolves.toMatchObject({ committed: true });
      const failure = new Error("response-lost-after-commit");
      const uncertain = createWagerStateRepository(responseLost(db, failure), {
        writeGuards,
        now,
        notify,
      });
      await expect(
        uncertain.removeProposal(id, {
          proposalUid: "host",
          operationId: "remove",
          expectedReservationOperationId: proposal().reservationOperationId,
        }),
      ).rejects.toBe(failure);
      expect(notices).toEqual([true, false]);
      expect(
        (await writer.readWager(id))!.proposalRemovalOperations,
      ).toHaveProperty("remove");
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
