import { AsyncLocalStorage } from "node:async_hooks";
import { AuthApiFailure } from "./authErrors.ts";
import { isApplicationReadSql } from "./applicationD1.ts";
import { assertLocalInviteRoomLayout } from "./inviteRoomSchema.ts";
import {
  hashMatchWriter,
  matchWriterJson,
  type MatchWriterMutation,
} from "./matchWriterRecords.ts";
import {
  MATCH_WRITER_SCHEMA,
  matchWriterGuardDrops,
  matchWriterWriteGuards,
} from "./matchWriterSql.ts";

type ControlRow = {
  revision: number;
  phase: string;
  incarnation: string;
  handoff_id: string | null;
  invite_id: string | null;
  ownership_json: string | null;
  copy_receipt_json: string | null;
  acknowledgement_json: string | null;
  empty_seal_json: string | null;
};

type Writer = {
  store: MatchWriterStore;
  writerId: string;
  revision: number;
  incarnation: string;
  kind: MatchWriterMutation["kind"];
  mutationId: string;
  inputDigest: string;
  matchIds: string[];
};

type OutcomeRow = {
  writer_id: string;
  mutation_id: string;
  input_digest: string;
  revision: number;
  incarnation: string;
  status: "committed" | "completed" | "failed";
  business_outcome: "committed" | "unknown";
  result_json: string;
  evidence_json: string;
};

const writers = new AsyncLocalStorage<Writer>();

function unavailable(message: string): never {
  throw new AuthApiFailure(503, "unavailable", message);
}

function conflict(message: string): never {
  throw new AuthApiFailure(409, "failed-precondition", message);
}

function bufferCursor<Row extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<Row>,
): SqlStorageCursor<Row> {
  const columns = [...cursor.columnNames];
  const rows = Array.from(cursor.raw<SqlStorageValue[]>());
  let offset = 0;
  const next = (): IteratorResult<Row> => {
    const row = rows[offset++];
    if (!row) return { done: true, value: undefined };
    return {
      done: false,
      value: Object.fromEntries(
        columns.map((column, index) => [column, row[index]]),
      ) as Row,
    };
  };
  const iterator = function* () {
    while (offset < rows.length) {
      const item = next();
      if (!item.done) yield item.value;
    }
  };
  return new Proxy(cursor, {
    get(target, property) {
      if (property === "next") return next;
      if (property === Symbol.iterator) return iterator;
      if (property === "toArray") return () => Array.from(iterator());
      if (property === "one")
        return () => {
          if (rows.length - offset !== 1)
            throw new Error("expected-one-sql-row");
          const item = next();
          if (item.done) throw new Error("expected-one-sql-row");
          return item.value;
        };
      if (property === "raw")
        return function* () {
          while (offset < rows.length) yield rows[offset++];
        };
      return Reflect.get(target, property, target);
    },
  });
}

export class MatchWriterStore {
  private readonly incarnation = crypto.randomUUID();
  private initialized = false;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly businessStorage: DurableObjectStorage = storage,
  ) {}

  private active(): void {
    const [row] = this.storage.sql
      .exec<{ generation: number; data_epoch: number; phase: string }>(
        "SELECT generation, data_epoch, phase FROM application_data_control WHERE singleton = 1",
      )
      .toArray();
    if (
      !row ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1 ||
      row.data_epoch !== 1 ||
      row.phase !== "active"
    )
      unavailable("timer-handoff-application-not-active");
  }

  initialize(options: { fresh?: boolean } = {}): void {
    if (this.initialized) return;
    this.active();
    this.storage.transactionSync(() => {
      this.active();
      if (!options.fresh) {
        assertLocalInviteRoomLayout(this.storage);
        const tables = [
          "timer_handoff_control",
          "timer_handoff_writers",
          "timer_handoff_writer_outcomes",
          "timer_handoff_writer_reconciliations",
          "timer_handoff_write_context",
        ];
        const count = this.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN (${tables.map(() => "?").join(",")})`,
            ...tables,
          )
          .one().count;
        if (count !== tables.length || this.control().phase !== "open")
          unavailable("invite-writer-layout-unavailable");
      }
      this.storage.sql.exec(MATCH_WRITER_SCHEMA);
      this.storage.sql.exec(
        "INSERT INTO timer_handoff_control(singleton, revision, phase, incarnation) VALUES (1, 0, 'open', ?) ON CONFLICT(singleton) DO UPDATE SET incarnation = excluded.incarnation",
        this.incarnation,
      );
      if (this.storage.kv.get("invite-room:writer-fence-version") !== 2) {
        this.storage.sql.exec(matchWriterGuardDrops());
        this.storage.sql.exec(matchWriterWriteGuards());
        this.storage.kv.put("invite-room:writer-fence-version", 2);
      }
    });
    this.initialized = true;
  }

  initializeFreshLocalLayout(): void {
    this.initialize({ fresh: true });
    this.storage.transactionSync(() => {
      this.active();
      const control = this.control();
      if (
        control.phase !== "open" ||
        control.revision !== 0 ||
        control.handoff_id !== null ||
        control.copy_receipt_json !== null ||
        control.acknowledgement_json !== null ||
        control.empty_seal_json !== null ||
        control.incarnation !== this.incarnation ||
        this.storage.sql
          .exec("SELECT 1 FROM timer_handoff_writers LIMIT 1")
          .toArray().length
      )
        conflict("timer-handoff-fresh-layout-not-empty");
      this.assertEmptyTimerData();
      this.storage.sql.exec(matchWriterWriteGuards());
      this.storage.sql.exec(
        "UPDATE timer_handoff_control SET fresh_local_layout = 1 WHERE singleton = 1",
      );
      this.storage.kv.put("invite-room:timer-layout-version", 2);
    });
  }

  private control(): ControlRow {
    return this.storage.sql
      .exec<ControlRow>(
        "SELECT revision, phase, incarnation, handoff_id, invite_id, ownership_json, copy_receipt_json, acknowledgement_json, empty_seal_json FROM timer_handoff_control WHERE singleton = 1",
      )
      .one();
  }

  assertWriter(): void {
    const writer = writers.getStore();
    if (!writer || writer.store !== this)
      unavailable("timer-handoff-writer-missing");
    this.active();
    const row = this.control();
    const admitted =
      this.storage.sql
        .exec(
          "SELECT 1 FROM timer_handoff_writers WHERE writer_id = ? AND revision = ? AND incarnation = ?",
          writer.writerId,
          writer.revision,
          writer.incarnation,
        )
        .toArray().length !== 0;
    if (
      !admitted ||
      row.incarnation !== writer.incarnation ||
      row.phase !== "open" ||
      row.revision !== writer.revision
    )
      unavailable("timer-handoff-writer-fenced");
  }

  private outcome(writerId: string): OutcomeRow | null {
    return (
      this.storage.sql
        .exec<OutcomeRow>(
          "SELECT * FROM timer_handoff_writer_outcomes WHERE writer_id = ?",
          writerId,
        )
        .toArray()[0] ?? null
    );
  }

  private mutationMatches(mutation: MatchWriterMutation): string[] {
    const matches =
      mutation.kind === "create"
        ? mutation.request.records.map((row) => row.matchId)
        : mutation.kind === "event-effects"
          ? [
              ...mutation.request.creations.map((row) => row.matchId),
              ...mutation.request.terminalTimers.map((row) => row.matchId),
              ...mutation.request.claims.map((row) => row.matchId),
            ]
          : mutation.kind === "alarm"
            ? this.storage.sql
                .exec<{ match_id: string }>(
                  "SELECT match_id FROM match_state_timer_cohorts_canonical ORDER BY match_id",
                )
                .toArray()
                .map((row) => row.match_id)
            : [mutation.request.matchId];
    return [...new Set(matches)].sort();
  }

  private evidence(matchIds: string[]) {
    const source = this.storage.sql
      .exec(
        "SELECT invite_id, active_epoch, import_id, digest FROM match_state_source_canonical WHERE singleton = 1",
      )
      .toArray();
    const revisions = matchIds.flatMap((matchId) =>
      this.storage.sql
        .exec<{ match_id: string; revision: number }>(
          "SELECT match_id, revision FROM match_state_revisions_canonical WHERE match_id = ?",
          matchId,
        )
        .toArray(),
    );
    return { source, revisions };
  }

  recordCommittedOutcome(result: unknown): void {
    this.assertWriter();
    const writer = writers.getStore()!;
    const existing = this.outcome(writer.writerId);
    if (
      existing &&
      (existing.status !== "committed" ||
        existing.result_json !== matchWriterJson(result))
    )
      conflict("timer-handoff-writer-outcome-conflict");
    this.recordOutcome(writer, "committed", result);
  }

  private recordOutcome(
    writer: Writer,
    status: OutcomeRow["status"],
    result: unknown,
  ): void {
    if (this.outcome(writer.writerId)) return;
    this.storage.sql.exec(
      "INSERT INTO timer_handoff_writer_outcomes(writer_id, mutation_id, input_digest, revision, incarnation, status, business_outcome, result_json, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      writer.writerId,
      writer.mutationId,
      writer.inputDigest,
      writer.revision,
      writer.incarnation,
      status,
      status === "failed" ? "unknown" : "committed",
      matchWriterJson(result === undefined ? null : result),
      matchWriterJson(this.evidence(writer.matchIds)),
    );
  }

  private settleWriter(writer: Writer, failed: boolean): void {
    const removed = this.storage.sql
      .exec(
        "DELETE FROM timer_handoff_writers WHERE writer_id = ? AND revision = ? AND incarnation = ? RETURNING writer_id",
        writer.writerId,
        writer.revision,
        writer.incarnation,
      )
      .toArray();
    if (removed.length)
      this.storage.sql.exec(
        "UPDATE timer_handoff_control SET completed_writers = completed_writers + 1, failed_writers = failed_writers + ? WHERE singleton = 1",
        failed ? 1 : 0,
      );
  }

  async runWriter<T>(
    mutation: MatchWriterMutation,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const inherited = writers.getStore();
    if (inherited?.store === this) {
      this.assertWriter();
      return work();
    }
    this.initialize();
    const normalized: unknown = JSON.parse(JSON.stringify(mutation));
    const inputJson = matchWriterJson(normalized);
    const inputDigest = await hashMatchWriter(normalized);
    const writer = this.storage.transactionSync(() => {
      this.active();
      const row = this.control();
      if (row.phase !== "open" || row.incarnation !== this.incarnation)
        unavailable("timer-handoff-in-progress");
      const writer: Writer = {
        store: this,
        writerId: crypto.randomUUID(),
        revision: row.revision,
        incarnation: this.incarnation,
        kind: mutation.kind,
        mutationId:
          mutation.kind === "event-effects"
            ? mutation.request.operationId
            : `${mutation.kind}:${inputDigest}`,
        inputDigest,
        matchIds: this.mutationMatches(mutation),
      };
      this.storage.sql.exec(
        "INSERT INTO timer_handoff_writers(writer_id, revision, incarnation, kind, mutation_id, input_digest, input_json, match_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        writer.writerId,
        writer.revision,
        writer.incarnation,
        mutation.kind,
        writer.mutationId,
        writer.inputDigest,
        inputJson,
        matchWriterJson(writer.matchIds),
      );
      return writer;
    });
    try {
      return await writers.run(writer, async () => {
        this.assertWriter();
        const result = await work();
        this.assertWriter();
        this.storage.transactionSync(() => {
          this.recordOutcome(writer, "completed", result);
          this.settleWriter(writer, false);
        });
        return result;
      });
    } catch (error) {
      this.storage.transactionSync(() => {
        this.recordOutcome(writer, "failed", {
          errorName: error instanceof Error ? error.name : "unknown",
          businessOutcome: "unknown",
        });
        this.settleWriter(writer, true);
      });
      throw error;
    }
  }

  guardStorage(storage = this.businessStorage): DurableObjectStorage {
    const guard = this;
    const sql = new Proxy(storage.sql, {
      get(target, property) {
        if (property === "exec")
          return (query: string, ...bindings: SqlStorageValue[]) => {
            if (isApplicationReadSql(query))
              return target.exec(query, ...bindings);
            return guard.storage.transactionSync(() => {
              guard.assertWriter();
              const writer = writers.getStore()!;
              guard.storage.sql.exec(
                "INSERT INTO timer_handoff_write_context(singleton, writer_id, revision, incarnation, mode) VALUES (1, ?, ?, ?, 'writer')",
                writer.writerId,
                writer.revision,
                writer.incarnation,
              );
              const result = bufferCursor(target.exec(query, ...bindings));
              guard.storage.sql.exec(
                "DELETE FROM timer_handoff_write_context WHERE singleton = 1",
              );
              return result;
            });
          };
        return Reflect.get(target, property, target);
      },
    });
    return new Proxy(storage, {
      get(target, property) {
        if (property === "sql") return sql;
        const method: unknown = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        if (property === "transactionSync")
          return <T>(work: () => T): T => {
            guard.assertWriter();
            return target.transactionSync(work);
          };
        if (property === "transaction")
          return <T>(work: (txn: DurableObjectTransaction) => Promise<T>) => {
            guard.assertWriter();
            return target.transaction(async (transaction) => {
              guard.assertWriter();
              const wrapped = new Proxy(transaction, {
                get(native, key) {
                  const value: unknown = Reflect.get(native, key, native);
                  if (typeof value !== "function") return value;
                  return (...args: unknown[]) => {
                    guard.assertWriter();
                    return Reflect.apply(value, native, args);
                  };
                },
              });
              const result = await work(wrapped);
              guard.assertWriter();
              return result;
            });
          };
        return (...args: unknown[]) => Reflect.apply(method, target, args);
      },
    });
  }

  private assertEmptyTimerData(): void {
    for (const table of [
      "match_state_source_canonical",
      "match_state_records_canonical",
      "match_state_claims_canonical",
      "match_state_revisions_canonical",
      "match_state_timer_cohorts_canonical",
      "match_state_timer_starts_canonical",
      "match_state_effects_canonical",
      "match_state_event_receipts_canonical",
    ])
      if (
        this.storage.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length
      )
        conflict("timer-handoff-empty-layout-has-data");
  }
}
