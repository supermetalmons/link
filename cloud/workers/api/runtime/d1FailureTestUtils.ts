export function observeD1FailureDatabase(
  db: D1Database,
  options: {
    beforeBatch?: (attempt: number) => Promise<void>;
    beforeWriteBatch?: (attempt: number) => Promise<void>;
    afterRead?: (query: string) => Promise<void>;
    diagnosticFailure?: Error;
  } = {},
) {
  const batches: D1PreparedStatement[][] = [];
  const readBatches: D1PreparedStatement[][] = [];
  const writeBatches: D1PreparedStatement[][] = [];
  const errors: unknown[] = [];
  const sessions: D1SessionBookmark[] = [];
  const prepared = new WeakMap<
    D1PreparedStatement,
    { query: string; statement: D1PreparedStatement }
  >();
  const wrap = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        if (property === "first")
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.first, target, args);
            await options.afterRead?.(query);
            return result;
          };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    prepared.set(wrapped, { query, statement });
    return wrapped;
  };
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => wrap(target.prepare(query), query);
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches.push(statements);
          const queries = statements.map((statement) =>
            prepared.get(statement),
          );
          const readOnly = queries.every(
            (value) => value && /^\s*SELECT\b/i.test(value.query),
          );
          if (readOnly) readBatches.push(statements);
          else writeBatches.push(statements);
          await options.beforeBatch?.(batches.length);
          if (!readOnly) await options.beforeWriteBatch?.(writeBatches.length);
          try {
            const results = await target.batch(
              statements.map(
                (statement) => prepared.get(statement)?.statement ?? statement,
              ),
            );
            if (readOnly)
              for (const value of queries)
                await options.afterRead?.(value!.query);
            return results;
          } catch (error) {
            errors.push(error);
            throw error;
          }
        };
      }
      if (property === "withSession") {
        return (constraint: D1SessionBookmark) => {
          sessions.push(constraint);
          if (options.diagnosticFailure) throw options.diagnosticFailure;
          return target.withSession(constraint);
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { database, batches, readBatches, writeBatches, errors, sessions };
}
