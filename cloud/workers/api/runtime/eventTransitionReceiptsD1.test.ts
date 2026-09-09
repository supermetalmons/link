import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_RECEIPT_ADMISSION_KIND,
  ensureEventTransitionReceipt,
  eventReceiptControlGuardStatements,
  eventTransitionReceiptGuardStatements,
  normalizeEventTransitionReceiptRow,
  parseEventTransitionReceipt,
  readEventTransitionReceipt,
  serializeEventTransitionReceipt,
  type EventTransitionReceipt,
  type EventTransitionReceiptRow,
} from "../src/eventTransitionReceiptsD1.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.PROFILE_GAMES_DB;
const versionId = "12345678-1234-4234-8234-123456789abc";
const digest = "a".repeat(64);
const legacyReceipt: EventTransitionReceipt = {
  schemaVersion: 1,
  transitionId: "et_legacy",
  eventId: "historical-event",
  expectedRevision: 3,
};
const receipt: EventTransitionReceipt = {
  schemaVersion: 2,
  transitionId: "et_current",
  eventId: "current-event",
  expectedRevision: 4,
  payloadDigest: "b".repeat(64),
};

function insertRow(row: EventTransitionReceiptRow, replace = false) {
  return db
    .prepare(
      `INSERT ${replace ? "OR REPLACE " : ""}INTO event_transition_receipts (
        transition_id, schema_version, event_id, expected_revision,
        payload_digest, receipt_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.transition_id,
      row.schema_version,
      row.event_id,
      row.expected_revision,
      row.payload_digest,
      row.receipt_json,
      row.recorded_at_ms,
    );
}

async function activate(importCount?: number) {
  const count =
    importCount ??
    (await db
      .prepare("SELECT COUNT(*) AS count FROM event_transition_receipts")
      .first<number>("count"));
  return db
    .prepare(
      `UPDATE event_transition_receipt_control SET state = 'active',
        source_count = ?, source_digest = ?, import_count = ?, import_digest = ?,
        candidate_version_id = ?, verified_event_freeze_generation = 3,
        source_exported_at_ms = 10, imported_at_ms = 11,
        verified_at_ms = 12, activated_at_ms = 13 WHERE singleton = 1`,
    )
    .bind(count, digest, count, digest, versionId)
    .run();
}

function insertAdmission(kind: string, id = kind) {
  return db
    .prepare(
      `INSERT INTO invite_source_write_admissions
        (admission_id, backend, epoch, freeze_generation, kind, created_at_ms)
        VALUES (?, 'd1', 1, 1, ?, 1)`,
    )
    .bind(id, kind);
}

function interceptedDatabase(input: {
  batch?: (
    statements: D1PreparedStatement[],
    execute: () => Promise<D1Result[]>,
  ) => Promise<D1Result[]>;
  primaryRead?: (execute: () => D1DatabaseSession) => D1DatabaseSession;
}): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch" && input.batch) {
        const intercept = input.batch;
        return (statements: D1PreparedStatement[]) =>
          intercept(statements, () => target.batch(statements));
      }
      if (property === "withSession") {
        return (constraint: D1SessionConstraint | D1SessionBookmark) => {
          expect(constraint).toBe("first-primary");
          return input.primaryRead
            ? input.primaryRead(() => target.withSession(constraint))
            : target.withSession(constraint);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("D1 event transition receipts", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  });

  beforeEach(async () => {
    const migration = testEnv.TEST_D1_MIGRATIONS.find((value) =>
      value.name.startsWith("0019_"),
    );
    if (!migration) throw new Error("event-receipt-migration-missing");
    await db.batch([
      db.prepare("DROP TRIGGER event_transition_receipt_admission_insert_gate"),
      db.prepare("DROP TRIGGER event_transition_receipt_admission_update_gate"),
      db.prepare("DROP TABLE event_transition_receipts"),
      db.prepare("DROP TABLE event_transition_receipt_control"),
      db.prepare("DROP TABLE event_transition_receipt_guards"),
      db.prepare("DELETE FROM invite_source_write_admissions"),
    ]);
    await db.batch(migration.queries.map((query) => db.prepare(query)));
  });

  it("preserves complete V1 and V2 JSON while canonicalizing object order", () => {
    const original = {
      ...receipt,
      extra: { z: [null, { b: 2, a: "value" }], a: false },
    };
    const parsed = parseEventTransitionReceipt(original, receipt.transitionId);
    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(serializeEventTransitionReceipt(parsed)).toBe(
      serializeEventTransitionReceipt({
        extra: { a: false, z: [null, { a: "value", b: 2 }] },
        ...receipt,
      }),
    );
    expect(
      normalizeEventTransitionReceiptRow(
        legacyReceipt.transitionId,
        legacyReceipt,
        20,
      ).payload_digest,
    ).toBeNull();
  });

  it("rejects invalid identities, schema versions, digests, and non-JSON content", () => {
    for (const value of [
      null,
      { ...receipt, schemaVersion: 3 },
      { ...receipt, transitionId: "invalid/path" },
      { ...receipt, eventId: " padded " },
      { ...receipt, expectedRevision: 0 },
      { ...receipt, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...receipt, payloadDigest: "B".repeat(64) },
      { ...legacyReceipt, payloadDigest: null },
      { ...receipt, extra: undefined },
      { ...receipt, extra: [NaN] },
      { ...receipt, extra: new Date() },
    ]) {
      expect(() => parseEventTransitionReceipt(value)).toThrow(
        "invalid-event-transition-receipt",
      );
    }
    expect(() =>
      parseEventTransitionReceipt(receipt, "different-id"),
    ).toThrow();
    expect(() =>
      normalizeEventTransitionReceiptRow(receipt.transitionId, receipt, -1),
    ).toThrow();
    const circular: Record<string, unknown> = { ...receipt };
    circular.self = circular;
    expect(() => parseEventTransitionReceipt(circular)).toThrow(
      "invalid-event-transition-receipt",
    );
  });

  it("imports historical receipts without an event foreign key and preserves exact content", async () => {
    const archived = { ...legacyReceipt, legacyEvidence: { retained: true } };
    await insertRow(
      normalizeEventTransitionReceiptRow(archived.transitionId, archived, 20),
    ).run();
    expect(await readEventTransitionReceipt(db, archived.transitionId)).toEqual(
      archived,
    );
    expect(await readEventTransitionReceipt(db, "absent")).toBeNull();
    await expect(
      db.batch(eventReceiptControlGuardStatements(db)),
    ).rejects.toThrow();
    await activate();
    await expect(
      db.batch(eventTransitionReceiptGuardStatements(db, archived)),
    ).resolves.toBeDefined();
  });

  it("enforces receipt identity columns against stored JSON", async () => {
    const row = normalizeEventTransitionReceiptRow(
      receipt.transitionId,
      receipt,
      20,
    );
    for (const change of [
      { event_id: "different-event" },
      { transition_id: "different-transition" },
      { schema_version: 1 as const, payload_digest: null },
      { payload_digest: "c".repeat(64) },
      { expected_revision: 1.5 },
      { recorded_at_ms: 1.5 },
    ]) {
      await expect(insertRow({ ...row, ...change }).run()).rejects.toThrow();
    }
    expect(
      await readEventTransitionReceipt(db, receipt.transitionId),
    ).toBeNull();
  });

  it("prevents updates, deletion, and replacement from changing immutable history", async () => {
    const row = normalizeEventTransitionReceiptRow(
      receipt.transitionId,
      receipt,
      20,
    );
    await insertRow(row).run();
    await expect(
      db
        .prepare("UPDATE event_transition_receipts SET recorded_at_ms = 21")
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      db.prepare("DELETE FROM event_transition_receipts").run(),
    ).rejects.toThrow("immutable");
    const conflict = normalizeEventTransitionReceiptRow(
      receipt.transitionId,
      { ...receipt, extra: true },
      21,
    );
    await expect(insertRow(conflict, true).run()).rejects.toThrow(
      "event-transition-receipt-conflict",
    );
    await insertRow({ ...row, recorded_at_ms: 22 }, true).run();
    expect(
      await db
        .prepare("SELECT recorded_at_ms FROM event_transition_receipts")
        .first<number>("recorded_at_ms"),
    ).toBe(20);
    expect(await readEventTransitionReceipt(db, receipt.transitionId)).toEqual(
      receipt,
    );
  });

  it("gates only legacy and new event-effect admission kinds across activation", async () => {
    await insertAdmission("event-effects").run();
    await insertAdmission("unrelated").run();
    await expect(
      insertAdmission(EVENT_RECEIPT_ADMISSION_KIND).run(),
    ).rejects.toThrow("writer is disabled");
    await expect(activate()).rejects.toThrow("writers are active");
    await db
      .prepare(
        "DELETE FROM invite_source_write_admissions WHERE kind = 'event-effects'",
      )
      .run();
    await activate();
    await insertAdmission(EVENT_RECEIPT_ADMISSION_KIND).run();
    await insertAdmission("another-unrelated").run();
    await expect(insertAdmission("event-effects").run()).rejects.toThrow(
      "writer is disabled",
    );
    await expect(
      db
        .prepare(
          "UPDATE invite_source_write_admissions SET kind = 'event-effects' WHERE kind = 'unrelated'",
        )
        .run(),
    ).rejects.toThrow("writer is disabled");
  });

  it("requires complete matching import proof and permanently fixes active authority", async () => {
    await expect(
      db
        .prepare("UPDATE event_transition_receipt_control SET state = 'active'")
        .run(),
    ).rejects.toThrow();
    await expect(activate(1)).rejects.toThrow("import count is unverified");
    await activate();
    await expect(
      db
        .prepare(
          "UPDATE event_transition_receipt_control SET state = 'importing'",
        )
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      db
        .prepare(
          "UPDATE event_transition_receipt_control SET candidate_version_id = candidate_version_id",
        )
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      db.prepare("DELETE FROM event_transition_receipt_control").run(),
    ).rejects.toThrow("immutable");
    await expect(
      db
        .prepare(
          "INSERT OR REPLACE INTO event_transition_receipt_control (singleton, state) VALUES (1, 'importing')",
        )
        .run(),
    ).rejects.toThrow("immutable");
  });

  it("fails closed for both event-effect kinds and receipts if control is missing", async () => {
    await db
      .prepare("DROP TRIGGER event_transition_receipt_control_reject_delete")
      .run();
    await db.prepare("DELETE FROM event_transition_receipt_control").run();
    await expect(insertAdmission("event-effects").run()).rejects.toThrow(
      "writer is disabled",
    );
    await expect(
      insertAdmission(EVENT_RECEIPT_ADMISSION_KIND).run(),
    ).rejects.toThrow("writer is disabled");
    await insertAdmission("unrelated").run();
    await expect(
      insertRow(
        normalizeEventTransitionReceiptRow(receipt.transitionId, receipt, 20),
      ).run(),
    ).rejects.toThrow("control is missing");
    await expect(
      db.batch(eventReceiptControlGuardStatements(db)),
    ).rejects.toThrow();
  });

  it("requires active authority and caller guards before inserting an effect acknowledgment", async () => {
    await expect(
      ensureEventTransitionReceipt(db, receipt, {
        recordedAtMs: 20,
        guards: () => [],
      }),
    ).rejects.toThrow();
    expect(
      await readEventTransitionReceipt(db, receipt.transitionId),
    ).toBeNull();
    await activate();
    await expect(
      ensureEventTransitionReceipt(db, receipt, {
        recordedAtMs: 20,
        guards: () => [
          db.prepare(
            "INSERT INTO event_transition_receipt_guards (singleton) VALUES (0)",
          ),
        ],
      }),
    ).rejects.toThrow();
    expect(
      await readEventTransitionReceipt(db, receipt.transitionId),
    ).toBeNull();
    await ensureEventTransitionReceipt(db, receipt, {
      recordedAtMs: 20,
      guards: () => [],
    });
    await ensureEventTransitionReceipt(db, receipt, {
      recordedAtMs: 21,
      guards: () => [],
    });
    expect(
      await db
        .prepare("SELECT recorded_at_ms FROM event_transition_receipts")
        .first<number>("recorded_at_ms"),
    ).toBe(20);
  });

  it("treats changes to any stored receipt content as conflicts", async () => {
    await activate();
    const original = { ...receipt, evidence: { preserved: true } };
    await ensureEventTransitionReceipt(db, original, {
      recordedAtMs: 20,
      guards: () => [],
    });
    for (const conflict of [
      receipt,
      { ...original, expectedRevision: 5 },
      { ...original, eventId: "another-event" },
      { ...original, payloadDigest: "c".repeat(64) },
      { ...original, evidence: { preserved: false } },
    ]) {
      await expect(
        ensureEventTransitionReceipt(db, conflict, {
          recordedAtMs: 21,
          guards: () => [],
        }),
      ).rejects.toThrow("event-transition-receipt-conflict");
    }
    expect(await readEventTransitionReceipt(db, receipt.transitionId)).toEqual(
      original,
    );
  });

  it("rolls back the final publication batch when its exact acknowledgment is absent or different", async () => {
    await activate();
    const publish = () =>
      db.batch([
        db
          .prepare(
            "INSERT INTO invite_event_effect_receipts VALUES (?, ?, ?, 20)",
          )
          .bind(receipt.transitionId, receipt.eventId, digest),
        ...eventTransitionReceiptGuardStatements(db, receipt),
      ]);
    await expect(publish()).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM invite_event_effect_receipts WHERE transition_id = ?",
        )
        .bind(receipt.transitionId)
        .first<number>("count"),
    ).toBe(0);
    await ensureEventTransitionReceipt(db, receipt, {
      recordedAtMs: 20,
      guards: () => [],
    });
    await expect(
      db.batch(
        eventTransitionReceiptGuardStatements(db, { ...receipt, extra: true }),
      ),
    ).rejects.toThrow();
    await expect(publish()).resolves.toBeDefined();
  });

  it("recovers an ambiguous successful insert through an exact primary readback", async () => {
    await activate();
    let batches = 0;
    let reads = 0;
    const connection = interceptedDatabase({
      async batch(_statements, execute) {
        const result = await execute();
        if (++batches === 1) throw new Error("ambiguous-success");
        return result;
      },
      primaryRead(execute) {
        reads++;
        return execute();
      },
    });
    await ensureEventTransitionReceipt(connection, receipt, {
      recordedAtMs: 20,
      guards: () => [],
    });
    expect(batches).toBe(2);
    expect(reads).toBe(1);
    expect(await readEventTransitionReceipt(db, receipt.transitionId)).toEqual(
      receipt,
    );
  });

  it("does not claim success when an ambiguous insert cannot be read back", async () => {
    await activate();
    const connection = interceptedDatabase({
      async batch(_statements, execute) {
        await execute();
        throw new Error("ambiguous-success");
      },
      primaryRead() {
        throw new Error("primary-unavailable");
      },
    });
    await expect(
      ensureEventTransitionReceipt(connection, receipt, {
        recordedAtMs: 20,
        guards: () => [],
      }),
    ).rejects.toThrow("primary-unavailable");
    expect(await readEventTransitionReceipt(db, receipt.transitionId)).toEqual(
      receipt,
    );
  });

  it("rechecks caller fencing after recovering an ambiguous successful insert", async () => {
    await activate();
    let batches = 0;
    const connection = interceptedDatabase({
      async batch(_statements, execute) {
        const result = await execute();
        if (++batches === 1) throw new Error("ambiguous-success");
        return result;
      },
    });
    let guardReads = 0;
    await expect(
      ensureEventTransitionReceipt(connection, receipt, {
        recordedAtMs: 20,
        guards: () =>
          ++guardReads === 1
            ? []
            : [
                db.prepare(
                  "INSERT INTO event_transition_receipt_guards (singleton) VALUES (0)",
                ),
              ],
      }),
    ).rejects.toThrow();
    expect(await readEventTransitionReceipt(db, receipt.transitionId)).toEqual(
      receipt,
    );
  });

  it("preserves a failed precommit write and obeys cancellation without creating a receipt", async () => {
    await activate();
    const connection = interceptedDatabase({
      async batch() {
        throw new Error("write-unavailable");
      },
    });
    await expect(
      ensureEventTransitionReceipt(connection, receipt, {
        recordedAtMs: 20,
        guards: () => [],
      }),
    ).rejects.toThrow("write-unavailable");
    const controller = new AbortController();
    controller.abort(new Error("request-cancelled"));
    await expect(
      ensureEventTransitionReceipt(db, receipt, {
        recordedAtMs: 20,
        guards: () => [],
        signal: controller.signal,
      }),
    ).rejects.toThrow("request-cancelled");
    expect(
      await readEventTransitionReceipt(db, receipt.transitionId),
    ).toBeNull();
  });
});
