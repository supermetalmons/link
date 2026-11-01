import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  initializeApplicationObjectControl,
  fenceApplicationObjectStorage,
} from "../src/applicationObjectStorage.ts";
import { applicationWriteFenceSql } from "../src/applicationDataControl.ts";
import { ensureInviteRoomSchema } from "../src/inviteRoomSchema.ts";
import { MatchStateStore } from "../src/matchStateStore.ts";
import { MatchWriterStore } from "../src/matchWriterStore.ts";
import { hashMatchWriter } from "../src/matchWriterRecords.ts";
import { matchDocumentFixture } from "../test/matchRecordFixture.ts";

const now = 2_000_000_000_000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  work: (f: {
    raw: DurableObjectStorage;
    business: DurableObjectStorage;
    writer: MatchWriterStore;
    store: MatchStateStore;
    objectId: string;
    input: {
      inviteId: string;
      matchId: string;
      playerId: string;
      opponentId: string;
      epoch: number;
    };
    setTime: (value: number) => void;
  }) => Promise<void>,
) {
  const inviteId = `writer-${crypto.randomUUID()}`;
  await runInDurableObject(
    env.INVITE_REACTIONS.getByName(inviteId),
    async (_instance, ctx) => {
      await initializeApplicationObjectControl(ctx.storage, {
        kind: "business",
        generation: 3,
        dataEpoch: 1,
        operationId: "writer-fixture",
      });
      ensureInviteRoomSchema(ctx.storage, { fresh: true });
      const business = fenceApplicationObjectStorage(ctx.storage, () => ({
        kind: "business",
        generation: 3,
        dataEpoch: 1,
        operationId: "writer-business",
      }));
      const objectId = ctx.id.toString();
      const writer = new MatchWriterStore(ctx.storage, business);
      writer.initializeFreshLocalLayout();
      for (const table of [
        "match_state_records_canonical",
        "match_state_timer_starts_canonical",
      ])
        ctx.storage.sql.exec(applicationWriteFenceSql(table));
      let clock = now;
      const store = new MatchStateStore(writer.guardStorage(), {
        now: () => clock,
        assertTimerWriter: () => writer.assertWriter(),
        recordTimerWriterOutcome: (result) =>
          writer.recordCommittedOutcome(result),
        resolveGame: () => ({
          activeColor: "black",
          historyValid: true,
          turnNumber: 7,
          winner: undefined,
        }),
      });
      const input = {
        inviteId,
        matchId: inviteId,
        playerId: "host-login",
        opponentId: "guest-login",
        epoch: 1,
      };
      const request = {
        inviteId,
        epoch: 1,
        records: [input.playerId, input.opponentId].map((playerId, index) => ({
          matchId: inviteId,
          playerId,
          marker: `${playerId}-created`,
          value: matchDocumentFixture({
            color: index === 0 ? "white" : "black",
          }),
        })),
      };
      await writer.runWriter({ kind: "create", request }, () =>
        store.createRecords(request),
      );
      await work({
        raw: ctx.storage,
        business,
        writer,
        store,
        objectId,
        input,
        setTime: (value) => {
          clock = value;
        },
      });
    },
  );
}

function localState(storage: DurableObjectStorage) {
  return Object.fromEntries(
    [
      "records",
      "revisions",
      "claims",
      "timer_cohorts",
      "timer_starts",
      "effects",
    ].map((name) => [
      name,
      storage.sql.exec(`SELECT * FROM match_state_${name}_canonical`).toArray(),
    ]),
  );
}

function pendingWriters(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{
      writerId: string;
      incarnation: string;
      controlIncarnation: string;
      outcome: string;
    }>(
      "SELECT w.writer_id AS writerId, w.incarnation, c.incarnation AS controlIncarnation, COALESCE(o.status, 'unknown') AS outcome FROM timer_handoff_writers w JOIN timer_handoff_control c ON c.singleton = 1 LEFT JOIN timer_handoff_writer_outcomes o ON o.writer_id = w.writer_id ORDER BY w.writer_id",
    )
    .toArray()
    .map((row) => ({
      ...row,
      currentIncarnation: row.incarnation === row.controlIncarnation,
    }));
}

describe("permanent strict-local writer fence", () => {
  it("records a typed committed mutation and preserves local data across incarnation replacement", async () => {
    await fixture(async (f) => {
      await f.writer.runWriter({ kind: "start-timer", request: f.input }, () =>
        f.store.startTimer(f.input),
      );
      const before = localState(f.raw);
      const replacement = new MatchWriterStore(f.raw, f.business);
      replacement.initialize();
      expect(localState(f.raw)).toEqual(before);
      expect(f.raw.kv.get("invite-room:timer-layout-version")).toBe(2);
      expect(f.raw.kv.get("invite-room:writer-fence-version")).toBe(2);
      expect(
        f.raw.sql
          .exec(
            "SELECT status,input_digest,result_json FROM timer_handoff_writer_outcomes WHERE mutation_id LIKE 'start-timer:%'",
          )
          .toArray(),
      ).toEqual([
        expect.objectContaining({
          status: "committed",
          input_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
      expect(
        f.raw.sql.exec("SELECT * FROM application_write_context").toArray(),
      ).toEqual([]);
      expect(
        f.raw.sql.exec("SELECT * FROM timer_handoff_write_context").toArray(),
      ).toEqual([]);
    });
  });

  it("rejects a detached completed writer and uninstrumented SQL", async () => {
    await fixture(async (f) => {
      const release = deferred<void>();
      let late: Promise<unknown> | undefined;
      await f.writer.runWriter(
        { kind: "start-timer", request: f.input },
        () => {
          late = release.promise.then(() =>
            f.writer
              .guardStorage()
              .sql.exec(
                "UPDATE match_state_revisions_canonical SET revision = revision + 1",
              ),
          );
        },
      );
      const before = localState(f.raw);
      release.resolve();
      await expect(late).rejects.toThrow("timer-handoff-writer-fenced");
      expect(() =>
        f.raw.sql.exec(
          "UPDATE match_state_revisions_canonical SET revision = revision + 1",
        ),
      ).toThrow("timer-handoff-writer-fenced");
      expect(localState(f.raw)).toEqual(before);
    });
  });

  it("retains an interrupted committed outcome and rejects its late old-incarnation write", async () => {
    await fixture(async (f) => {
      const committed = deferred<void>(),
        release = deferred<void>();
      const operation = f.writer.runWriter(
        { kind: "start-timer", request: f.input },
        async () => {
          const result = await f.store.startTimer(f.input);
          committed.resolve();
          await release.promise;
          f.writer
            .guardStorage()
            .sql.exec(
              "UPDATE match_state_revisions_canonical SET revision = revision + 1",
            );
          return result;
        },
      );
      await committed.promise;
      const original = pendingWriters(f.raw)[0]!;
      expect(original.currentIncarnation).toBe(true);
      expect(original.outcome).toBe("committed");
      const replacement = new MatchWriterStore(f.raw, f.business);
      replacement.initialize();
      const before = localState(f.raw);
      const retained = pendingWriters(f.raw)[0]!;
      expect(retained.writerId).toBe(original.writerId);
      expect(retained.currentIncarnation).toBe(false);
      release.resolve();
      await expect(operation).rejects.toThrow("timer-handoff-writer-fenced");
      expect(localState(f.raw)).toEqual(before);
      expect(
        f.raw.sql
          .exec(
            "SELECT status FROM timer_handoff_writer_outcomes WHERE writer_id = ?",
            original.writerId,
          )
          .one().status,
      ).toBe("committed");
      expect(() =>
        f.raw.sql.exec(
          "DELETE FROM timer_handoff_writer_outcomes WHERE writer_id = ?",
          original.writerId,
        ),
      ).toThrow("timer-writer-outcome-immutable");
    });
  });

  it("does not clear an unknown writer merely because its incarnation is obsolete", async () => {
    await fixture(async (f) => {
      const entered = deferred<void>(),
        release = deferred<void>();
      const operation = f.writer.runWriter(
        { kind: "start-timer", request: f.input },
        async () => {
          entered.resolve();
          await release.promise;
          f.writer.assertWriter();
        },
      );
      await entered.promise;
      const replacement = new MatchWriterStore(f.raw, f.business);
      replacement.initialize();
      const original = pendingWriters(f.raw);
      expect(original).toHaveLength(1);
      expect(original[0]?.outcome).toBe("unknown");
      expect(pendingWriters(f.raw)).toEqual(original);
      expect("inspect" in new MatchWriterStore(f.raw)).toBe(false);
      expect(pendingWriters(f.raw)).toEqual(original);
      release.resolve();
      await expect(operation).rejects.toThrow("timer-handoff-writer-fenced");
      expect(pendingWriters(f.raw)).toEqual([]);
    });
  });

  it("rejects an unverified existing layout before changing incarnation or data", async () => {
    await fixture(async (f) => {
      f.raw.kv.delete("invite-room:timer-layout-version");
      const before = f.raw.sql
        .exec("SELECT * FROM timer_handoff_control")
        .toArray();
      expect(() => new MatchWriterStore(f.raw).initialize()).toThrow(
        "invite-room-timer-layout-unverified",
      );
      expect(
        f.raw.sql.exec("SELECT * FROM timer_handoff_control").toArray(),
      ).toEqual(before);
    });
  });

  it("never reopens a leftover closed gate during strict boot", async () => {
    await fixture(async (f) => {
      f.raw.sql.exec("UPDATE timer_handoff_control SET phase = 'copied'");
      const before = f.raw.sql
        .exec("SELECT * FROM timer_handoff_control")
        .toArray();
      expect(() => new MatchWriterStore(f.raw).initialize()).toThrow(
        "invite-writer-layout-unavailable",
      );
      expect(
        f.raw.sql.exec("SELECT * FROM timer_handoff_control").toArray(),
      ).toEqual(before);
    });
  });

  it("has no copy-context write bypass and forbids returning a cohort to D1", async () => {
    await fixture(async (f) => {
      const control = f.raw.sql
        .exec<{ revision: number; incarnation: string }>(
          "SELECT revision,incarnation FROM timer_handoff_control",
        )
        .one();
      f.raw.sql.exec(
        "INSERT INTO timer_handoff_write_context(singleton,revision,incarnation,handoff_id,mode) VALUES(1,?,?,'obsolete','copy')",
        control.revision,
        control.incarnation,
      );
      expect(() =>
        f.raw.sql.exec(
          "UPDATE match_state_revisions_canonical SET revision = revision + 1",
        ),
      ).toThrow("timer-handoff-writer-fenced");
      f.raw.sql.exec("DELETE FROM timer_handoff_write_context");
      await expect(
        f.writer.runWriter({ kind: "start-timer", request: f.input }, () =>
          f.writer
            .guardStorage()
            .sql.exec(
              "UPDATE match_state_timer_cohorts_canonical SET mode = 'd1'",
            ),
        ),
      ).rejects.toThrow("match-timer-storage-local-required");
      expect(
        f.raw.sql
          .exec("SELECT mode FROM match_state_timer_cohorts_canonical")
          .one().mode,
      ).toBe("local");
    });
  });

  it("preserves historical layout evidence without exposing handoff mutations", async () => {
    await fixture(async (f) => {
      const payload = {
        schemaVersion: 1 as const,
        cleanupId: "historical-cleanup",
        handoffId: crypto.randomUUID(),
        objectId: f.objectId,
        kind: "empty-local-layout" as const,
        revision: 1,
        routingDigest: "a".repeat(64),
      };
      const proof = {
        ...payload,
        receiptDigest: await hashMatchWriter(payload),
      };
      f.raw.sql.exec(
        "UPDATE timer_handoff_control SET revision = 1, handoff_id = ?, empty_seal_json = ?",
        payload.handoffId,
        JSON.stringify(proof),
      );
      const cleanupReceipt = {
        schemaVersion: 1,
        cleanupId: payload.cleanupId,
        objectId: f.objectId,
        schemaDigest: "b".repeat(64),
        sourceDigest: "c".repeat(64),
        removedTables: ["match_state_records", "match_state_timer_starts"],
        timerLayoutVersion: 2,
      };
      f.raw.sql.exec(
        "CREATE TABLE canonical_cleanup_receipts(singleton INTEGER PRIMARY KEY CHECK(singleton=1),receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))) STRICT",
      );
      const cleanupJson = JSON.stringify(cleanupReceipt);
      f.raw.sql.exec(
        "INSERT INTO canonical_cleanup_receipts(singleton,receipt_json) VALUES(1,?)",
        cleanupJson,
      );
      f.raw.sql.exec(
        "CREATE TRIGGER canonical_cleanup_receipt_no_delete BEFORE DELETE ON canonical_cleanup_receipts BEGIN SELECT RAISE(ABORT,'canonical-cleanup-receipt-immutable'); END;",
      );
      const replacement = new MatchWriterStore(f.raw, f.business);
      replacement.initialize();
      expect(
        f.raw.sql
          .exec(
            "SELECT empty_seal_json,copy_receipt_json,acknowledgement_json FROM timer_handoff_control",
          )
          .one(),
      ).toEqual({
        empty_seal_json: JSON.stringify(proof),
        copy_receipt_json: null,
        acknowledgement_json: null,
      });
      expect(
        f.raw.sql
          .exec("SELECT receipt_json FROM canonical_cleanup_receipts")
          .one().receipt_json,
      ).toBe(cleanupJson);
      expect(() =>
        f.raw.sql.exec("DELETE FROM canonical_cleanup_receipts"),
      ).toThrow("canonical-cleanup-receipt-immutable");
      expect(
        f.raw.sql
          .exec(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('match_state_records', 'match_state_timer_starts')",
          )
          .toArray(),
      ).toEqual([]);
      for (const method of ["inspect", "begin", "copy", "finish", "sealEmpty"])
        expect(method in replacement).toBe(false);
    });
  });

  it("commits a local claim, effect and outcome atomically through the guarded async transaction", async () => {
    await fixture(async (f) => {
      await f.writer.runWriter({ kind: "start-timer", request: f.input }, () =>
        f.store.startTimer(f.input),
      );
      f.setTime(now + 100_000);
      const request = { ...f.input, eventId: "strict-event" };
      await expect(
        f.writer.runWriter({ kind: "claim-timer", request }, () =>
          f.store.claimTimer(request),
        ),
      ).resolves.toEqual({ ok: true });
      const before = localState(f.raw);
      await expect(
        f.writer.runWriter({ kind: "claim-timer", request }, () =>
          f.store.claimTimer(request),
        ),
      ).resolves.toEqual({ ok: true });
      expect(localState(f.raw)).toEqual(before);
      expect(f.store.effects.listDueEffects()).toHaveLength(1);
      expect(
        f.raw.sql
          .exec(
            "SELECT status FROM timer_handoff_writer_outcomes WHERE mutation_id LIKE 'claim-timer:%'",
          )
          .toArray(),
      ).toEqual([{ status: "committed" }, { status: "committed" }]);
      await f.raw.deleteAlarm();
    });
  });
});
