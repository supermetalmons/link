import { APPLICATION_DATABASE_BINDINGS } from "./applicationDataControl.ts";
import { isApplicationReadSql } from "./applicationD1.ts";

function forbidden(): never {
  throw new Error("application-read-only-operation");
}

function readOnlyApplicationDatabase(database: D1Database): D1Database {
  const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrapStatement = (
    statement: D1PreparedStatement,
  ): D1PreparedStatement => {
    const guarded = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values));
        if (
          property !== "all" &&
          property !== "run" &&
          property !== "first" &&
          property !== "raw"
        )
          forbidden();
        const method: unknown = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]): unknown =>
          Reflect.apply(method, target, args);
      },
    });
    statements.set(guarded, statement);
    return guarded;
  };
  const wrap = <T extends D1Database | D1DatabaseSession>(owner: T): T =>
    new Proxy(owner, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (!isApplicationReadSql(sql)) forbidden();
            return wrapStatement(target.prepare(sql));
          };
        if (property === "batch")
          return (inputs: D1PreparedStatement[]) => {
            const native = inputs.map((statement) => {
              const value = statements.get(statement);
              if (!value) forbidden();
              return value;
            });
            return target.batch(native);
          };
        if (property === "withSession" && "withSession" in target)
          return (constraint?: string) => wrap(target.withSession(constraint));
        if (property === "exec") return forbidden;
        if (property !== "dump" && property !== "getBookmark") forbidden();
        const method: unknown = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]): unknown =>
          Reflect.apply(method, target, args);
      },
    });
  return wrap(database);
}

export function readOnlyApplicationEnv(env: Env): Env {
  const databases = new Map<string, D1Database>();
  return new Proxy(env, {
    get(target, property) {
      const binding = APPLICATION_DATABASE_BINDINGS.find(
        (binding) => binding === property,
      );
      if (binding) {
        let database = databases.get(binding);
        if (!database) {
          database = readOnlyApplicationDatabase(target[binding]);
          databases.set(binding, database);
        }
        return database;
      }
      const value: unknown = Reflect.get(target, property, target);
      if (
        (typeof value === "object" && value !== null) ||
        typeof value === "function"
      )
        forbidden();
      return value;
    },
  });
}
