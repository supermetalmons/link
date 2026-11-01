import { AsyncLocalStorage } from "node:async_hooks";
import {
  ApplicationDataUnavailable,
  parseApplicationDataControl,
  type ApplicationWriteContext,
} from "./applicationDataControl.ts";
import { isApplicationReadSql } from "./applicationD1.ts";

const transactions = new AsyncLocalStorage<{
  storage: DurableObjectStorage;
  operationId: string;
}>();

export async function initializeApplicationObjectControl(
  storage: DurableObjectStorage,
  context: ApplicationWriteContext,
): Promise<void> {
  const present =
    storage.sql
      .exec(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'application_data_control'",
      )
      .toArray().length !== 0;
  if (present) return;
  if (context.dataEpoch === 1) {
    const tables = storage.sql
      .exec(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'",
      )
      .toArray();
    const keys = Array.from(storage.kv.list({ limit: 1 }));
    if (tables.length || keys.length || (await storage.getAlarm()) !== null)
      throw new ApplicationDataUnavailable();
  }
  storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS application_data_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation > 0),
      data_epoch INTEGER NOT NULL CHECK (data_epoch IN (0, 1)),
      phase TEXT NOT NULL CHECK (phase IN ('active', 'closing', 'closed', 'verifying')),
      migration_id TEXT,
      CHECK (phase = 'active' OR migration_id IS NOT NULL)
    ) STRICT`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS application_write_context (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation > 0),
      data_epoch INTEGER NOT NULL CHECK (data_epoch IN (0, 1)),
      operation_id TEXT NOT NULL,
      migration_id TEXT
    ) STRICT`);
    storage.sql
      .exec(`CREATE TRIGGER IF NOT EXISTS application_data_generation_monotonic
BEFORE UPDATE ON application_data_control
WHEN NEW.generation < OLD.generation
BEGIN SELECT RAISE(ABORT, 'application-generation-regression'); END`);
    storage.sql
      .exec(`CREATE TRIGGER IF NOT EXISTS application_write_context_admission
BEFORE INSERT ON application_write_context
WHEN NOT EXISTS (
  SELECT 1 FROM application_data_control c
  WHERE c.singleton = 1 AND c.generation = NEW.generation AND c.data_epoch = NEW.data_epoch
  AND ((NEW.migration_id IS NULL AND c.phase IN ('active', 'closing'))
    OR (NEW.migration_id = c.migration_id AND c.phase IN ('closed', 'verifying'))))
BEGIN SELECT RAISE(ABORT, 'application-write-fenced'); END`);
    storage.sql.exec(
      "INSERT OR IGNORE INTO application_data_control VALUES (1, ?, ?, 'active', NULL)",
      context.generation,
      context.dataEpoch,
    );
  });
}

export function assertApplicationObjectAdmission(
  storage: DurableObjectStorage,
  context: ApplicationWriteContext,
): void {
  const control = parseApplicationDataControl(
    storage.sql
      .exec(
        "SELECT singleton, generation, data_epoch, phase, migration_id FROM application_data_control WHERE singleton = 1",
      )
      .toArray()[0],
  );
  if (
    control.generation !== context.generation ||
    control.dataEpoch !== context.dataEpoch ||
    (context.kind === "business"
      ? control.phase !== "active" && control.phase !== "closing"
      : (control.phase !== "closed" && control.phase !== "verifying") ||
        control.migrationId !== context.migrationId)
  )
    throw new ApplicationDataUnavailable();
}

function bufferedWriteCursor<Row extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<Row>,
): SqlStorageCursor<Row> {
  const columns = [...cursor.columnNames];
  const rows = Array.from(cursor.raw<SqlStorageValue[]>());
  if (rows.some((row) => row.length !== columns.length))
    throw new ApplicationDataUnavailable();
  let index = 0;
  const next = () => {
    const values = rows[index++];
    if (!values) return { done: true as const };
    return {
      done: false as const,
      value: Object.fromEntries(
        columns.map((column, i) => {
          const value = values[i];
          if (value === undefined) throw new ApplicationDataUnavailable();
          return [column, value];
        }),
      ),
    };
  };
  const iterator = function* () {
    while (index < rows.length) {
      const entry = next();
      if (!entry.done) yield entry.value;
    }
  };
  return new Proxy(cursor, {
    get(target, property) {
      if (property === "next") return next;
      if (property === Symbol.iterator) return iterator;
      if (property === "toArray") return () => Array.from(iterator());
      if (property === "one")
        return () => {
          if (rows.length - index !== 1)
            throw new Error("expected-one-sql-row");
          const entry = next();
          if (entry.done) throw new ApplicationDataUnavailable();
          return entry.value;
        };
      if (property === "raw")
        return function* () {
          while (index < rows.length) {
            const row = rows[index++];
            if (!row) throw new ApplicationDataUnavailable();
            yield row;
          }
        };
      const value: unknown = Reflect.get(target, property, target);
      return value;
    },
  });
}

export function fenceApplicationObjectStorage(
  storage: DurableObjectStorage,
  getContext: () => ApplicationWriteContext,
): DurableObjectStorage {
  const open = (context: ApplicationWriteContext) => {
    assertApplicationObjectAdmission(storage, context);
    storage.sql.exec(
      "INSERT INTO application_write_context VALUES (1, ?, ?, ?, ?)",
      context.generation,
      context.dataEpoch,
      context.operationId,
      context.kind === "migration" ? context.migrationId : null,
    );
  };
  const close = (context: ApplicationWriteContext) => {
    storage.sql.exec(
      "DELETE FROM application_write_context WHERE operation_id = ?",
      context.operationId,
    );
  };
  const sync = <T>(work: () => T): T => {
    const context = getContext();
    const current = transactions.getStore();
    if (
      current?.storage === storage &&
      current.operationId === context.operationId
    ) {
      assertApplicationObjectAdmission(storage, context);
      return work();
    }
    return storage.transactionSync(() =>
      transactions.run({ storage, operationId: context.operationId }, () => {
        open(context);
        const result = work();
        close(context);
        return result;
      }),
    );
  };
  const sql = new Proxy(storage.sql, {
    get(target, property) {
      if (property === "exec")
        return (query: string, ...bindings: SqlStorageValue[]) => {
          if (isApplicationReadSql(query))
            return target.exec(query, ...bindings);
          return sync(() =>
            bufferedWriteCursor(target.exec(query, ...bindings)),
          );
        };
      const value: unknown = Reflect.get(target, property, target);
      return value;
    },
  });
  const kv = new Proxy(storage.kv, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      return (...args: unknown[]): unknown => {
        const invoke = (): unknown => {
          const value: unknown = Reflect.apply(method, target, args);
          return value;
        };
        return property === "put" || property === "delete"
          ? sync(invoke)
          : invoke();
      };
    },
  });
  const transaction = <T extends DurableObjectTransaction>(target: T): T =>
    new Proxy(target, {
      get(native, property) {
        const method: unknown = Reflect.get(native, property, native);
        if (typeof method !== "function") return method;
        return (...args: unknown[]): unknown => {
          if (
            property === "put" ||
            property === "delete" ||
            property === "setAlarm" ||
            property === "deleteAlarm"
          )
            assertApplicationObjectAdmission(storage, getContext());
          const value: unknown = Reflect.apply(method, native, args);
          return value;
        };
      },
    });
  return new Proxy(storage, {
    get(target, property) {
      if (property === "sql") return sql;
      if (property === "kv") return kv;
      if (property === "transactionSync") return sync;
      if (property === "transaction")
        return <T>(work: (txn: DurableObjectTransaction) => Promise<T>) => {
          const context = getContext();
          return target.transaction((txn) =>
            transactions.run(
              { storage, operationId: context.operationId },
              async () => {
                open(context);
                const result = await work(transaction(txn));
                close(context);
                return result;
              },
            ),
          );
        };
      if (
        property === "deleteAll" ||
        property === "onNextSessionRestoreBookmark"
      )
        return () => {
          throw new Error("application-storage-reset-forbidden");
        };
      const method: unknown = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      return (...args: unknown[]): unknown => {
        if (
          property === "put" ||
          property === "delete" ||
          property === "setAlarm" ||
          property === "deleteAlarm"
        )
          assertApplicationObjectAdmission(storage, getContext());
        const value: unknown = Reflect.apply(method, target, args);
        return value;
      };
    },
  });
}
