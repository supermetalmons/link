import {
  ApplicationDataUnavailable,
  applicationWriteBatch,
  type ApplicationWriteContext,
} from "./applicationDataControl.ts";

export function isApplicationReadSql(sql: string): boolean {
  const words: string[] = [];
  let depth = 0;
  let offset = 0;
  let terminated = false;
  while (offset < sql.length) {
    const character = sql[offset];
    if (character === undefined) break;
    if (/\s/.test(character)) {
      offset++;
      continue;
    }
    if (sql.startsWith("--", offset)) {
      const end = sql.indexOf("\n", offset + 2);
      offset = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end < 0) return false;
      offset = end + 2;
      continue;
    }
    if (terminated) return false;
    if (
      character === "'" ||
      character === '"' ||
      character === "`" ||
      character === "["
    ) {
      const quote = character === "[" ? "]" : character;
      offset++;
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset] !== quote) {
          offset++;
          continue;
        }
        offset++;
        if (quote !== "]" && sql[offset] === quote) {
          offset++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) return false;
      continue;
    }
    if (character === "(") {
      depth++;
      offset++;
      continue;
    }
    if (character === ")") {
      if (--depth < 0) return false;
      offset++;
      continue;
    }
    if (character === ";") {
      if (depth !== 0) return false;
      terminated = true;
      offset++;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(offset))?.[0];
    if (word) {
      if (depth === 0) words.push(word.toUpperCase());
      offset += word.length;
      continue;
    }
    if (depth === 0 && character === "=") words.push("=");
    offset++;
  }
  if (depth !== 0) return false;
  if (words[0] === "SELECT") return true;
  if (words[0] === "EXPLAIN") return true;
  if (words[0] === "WITH") {
    const command = words
      .slice(1)
      .find((word) =>
        ["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE"].includes(word),
      );
    return command === "SELECT";
  }
  return false;
}

export function fenceApplicationDatabase(
  database: D1Database,
  context: ApplicationWriteContext | (() => ApplicationWriteContext),
): D1Database {
  type Statement = { native: D1PreparedStatement; writes: boolean };
  const statements = new WeakMap<D1PreparedStatement, Statement>();
  const unwrap = (statement: D1PreparedStatement): Statement => {
    const record = statements.get(statement);
    if (!record) throw new ApplicationDataUnavailable();
    return record;
  };
  const execute = async <T>(
    owner: D1Database | D1DatabaseSession,
    inputs: readonly Statement[],
  ): Promise<D1Result<T>[]> => {
    const raw = inputs.map((statement) => statement.native);
    if (!inputs.some((statement) => statement.writes))
      return owner.batch<T>(raw);
    const result = await owner.batch<T>(
      applicationWriteBatch(
        owner,
        typeof context === "function" ? context() : context,
        raw,
      ),
    );
    if (result.length !== inputs.length + 2)
      throw new ApplicationDataUnavailable();
    return result.slice(1, -1);
  };
  const prepare = (
    owner: D1Database | D1DatabaseSession,
    native: D1PreparedStatement,
    writes: boolean,
  ): D1PreparedStatement => {
    const result = async (): Promise<D1Result<unknown>> => {
      const rows = await execute(owner, [{ native, writes }]);
      const first = rows[0];
      if (!first) throw new ApplicationDataUnavailable();
      return first;
    };
    const wrapped = new Proxy(native, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            prepare(owner, target.bind(...values), writes);
        if (writes && (property === "all" || property === "run")) return result;
        if (writes && property === "first")
          return async (column?: string): Promise<unknown> => {
            const row = (await result()).results[0];
            if (row === undefined) return null;
            if (column === undefined) return row;
            if (
              row === null ||
              typeof row !== "object" ||
              !Object.hasOwn(row, column)
            )
              throw new ApplicationDataUnavailable();
            const value: unknown = Reflect.get(row, column);
            return value;
          };
        if (writes && property === "raw")
          return () => {
            throw new Error("application-write-raw-unsupported");
          };
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });
    statements.set(wrapped, { native, writes });
    return wrapped;
  };
  const wrap = <T extends D1Database | D1DatabaseSession>(owner: T): T =>
    new Proxy(owner, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) =>
            prepare(target, target.prepare(sql), !isApplicationReadSql(sql));
        if (property === "batch")
          return (inputs: D1PreparedStatement[]) =>
            execute(target, inputs.map(unwrap));
        if (property === "withSession" && "withSession" in target)
          return (constraint?: string) => wrap(target.withSession(constraint));
        if (property === "exec")
          return () => {
            throw new Error("application-exec-unsupported");
          };
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });
  return wrap(database);
}
