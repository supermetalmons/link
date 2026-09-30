import { AsyncLocalStorage } from "node:async_hooks";

const databaseBindings = new Set<keyof Env>([
  "AUTH_STATE_DB",
  "EVENT_DB",
  "EVENT_PRIZE_WITHDRAWALS_DB",
  "PROFILE_DB",
  "PROFILE_GAMES_DB",
  "TELEGRAM_DB",
]);

export type D1CallMetrics = {
  calls: number;
  failedCalls: number;
  elapsedMs: number;
  metadataResults: number;
  callsWithoutMetadata: number;
  rowsRead: number | null;
  rowsWritten: number | null;
  sqlDurationMs: number | null;
};

type Phase = { durationMs: number; d1: D1CallMetrics };

export type D1TelemetrySummary = {
  durationMs: number;
  d1: D1CallMetrics;
  databases: Record<string, D1CallMetrics>;
  phases: Record<string, Phase>;
};

type Completion<T> = { ok: true; value: T } | { ok: false };
type Telemetry = {
  d1: D1CallMetrics;
  databases: Map<string, D1CallMetrics>;
  phases: Map<string, Phase>;
  closed: boolean;
  now: () => number;
};

const context = new AsyncLocalStorage<{
  telemetry: Telemetry;
  phase: string;
  task?: string;
}>();

function metrics(): D1CallMetrics {
  return {
    calls: 0,
    failedCalls: 0,
    elapsedMs: 0,
    metadataResults: 0,
    callsWithoutMetadata: 0,
    rowsRead: null,
    rowsWritten: null,
    sqlDurationMs: null,
  };
}

function phaseMetrics(telemetry: Telemetry, phase: string): Phase {
  let entry = telemetry.phases.get(phase);
  if (!entry) {
    entry = { durationMs: 0, d1: metrics() };
    telemetry.phases.set(phase, entry);
  }
  return entry;
}

export function measureD1Phase<T>(
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  const current = context.getStore();
  if (!current || current.telemetry.closed) return work();
  const { telemetry } = current;
  const entry = phaseMetrics(telemetry, phase);
  const startedAt = telemetry.now();
  return context.run({ ...current, phase }, async () => {
    try {
      return await work();
    } finally {
      if (!telemetry.closed)
        entry.durationMs += Math.max(0, telemetry.now() - startedAt);
    }
  });
}

export function measureD1Task<T>(
  task: string,
  work: () => Promise<T>,
): Promise<T> {
  const current = context.getStore();
  if (!current || current.telemetry.closed) return work();
  return context.run({ ...current, task }, () => measureD1Phase(task, work));
}

function readMetadata(value: unknown) {
  if (!value || typeof value !== "object" || !("meta" in value)) return null;
  const meta = value.meta;
  if (!meta || typeof meta !== "object") return null;
  const fields = meta as Record<string, unknown>;
  const timings = fields.timings;
  const duration =
    timings && typeof timings === "object" && "sql_duration_ms" in timings
      ? timings.sql_duration_ms
      : fields.duration;
  if (
    typeof fields.rows_read !== "number" ||
    !Number.isSafeInteger(fields.rows_read) ||
    fields.rows_read < 0 ||
    typeof fields.rows_written !== "number" ||
    !Number.isSafeInteger(fields.rows_written) ||
    fields.rows_written < 0 ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 0
  )
    return null;
  return {
    rowsRead: fields.rows_read,
    rowsWritten: fields.rows_written,
    sqlDurationMs: duration,
  };
}

function instrumentDatabase(
  db: D1Database,
  binding: string,
  telemetry: Telemetry,
): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const databaseMetrics = metrics();
  telemetry.databases.set(binding, databaseMetrics);
  const execute = async <T>(
    work: () => T | Promise<T>,
    metadata: "none" | "single" | "batch",
  ): Promise<T> => {
    if (telemetry.closed) return work();
    const phase = context.getStore();
    const entries = [
      telemetry.d1,
      databaseMetrics,
      phaseMetrics(
        telemetry,
        phase?.telemetry === telemetry ? phase.phase : "other",
      ).d1,
    ];
    if (
      phase?.telemetry === telemetry &&
      phase.task !== undefined &&
      phase.task !== phase.phase
    ) {
      entries.push(phaseMetrics(telemetry, phase.task).d1);
    }
    const startedAt = telemetry.now();
    for (const entry of entries) {
      entry.calls++;
      entry.callsWithoutMetadata++;
    }
    let completed = false;
    let value: T | undefined;
    try {
      value = await work();
      completed = true;
      return value;
    } finally {
      if (!telemetry.closed) {
        const elapsedMs = Math.max(0, telemetry.now() - startedAt);
        for (const entry of entries) {
          entry.elapsedMs += elapsedMs;
          if (!completed) entry.failedCalls++;
        }
        let results: ReturnType<typeof readMetadata>[] = [];
        try {
          if (completed && metadata !== "none") {
            results =
              metadata === "batch" && Array.isArray(value)
                ? value.map(readMetadata)
                : [readMetadata(value)];
          }
        } catch {}
        for (const entry of entries) {
          if (results.length && results.every((result) => result !== null))
            entry.callsWithoutMetadata--;
          for (const result of results) {
            if (!result) continue;
            entry.metadataResults++;
            entry.rowsRead = (entry.rowsRead ?? 0) + result.rowsRead;
            entry.rowsWritten = (entry.rowsWritten ?? 0) + result.rowsWritten;
            entry.sqlDurationMs =
              (entry.sqlDurationMs ?? 0) + result.sqlDurationMs;
          }
        }
      }
    }
  };
  const statement = (value: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(value, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => statement(target.bind(...values));
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          const work = () => Reflect.apply(method, target, args);
          if (property === "all" || property === "run")
            return execute(work, "single");
          if (property === "first" || property === "raw")
            return execute(work, "none");
          return work();
        };
      },
    });
    originals.set(wrapped, value);
    return wrapped;
  };
  const database = <T extends D1Database | D1DatabaseSession>(value: T): T =>
    new Proxy(value, {
      get(target, property) {
        if (property === "prepare")
          return (query: string) => statement(target.prepare(query));
        if (property === "batch")
          return (statements: D1PreparedStatement[]) =>
            execute(
              () =>
                target.batch(
                  statements.map((item) => originals.get(item) || item),
                ),
              "batch",
            );
        if (property === "withSession" && "withSession" in target)
          return (constraint?: string) =>
            database(target.withSession(constraint));
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          const work = () => Reflect.apply(method, target, args);
          return property === "exec" ? execute(work, "none") : work();
        };
      },
    });
  return database(db);
}

export async function collectD1Telemetry<T>(
  env: Env,
  work: (env: Env) => Promise<T>,
  {
    now = () => performance.now(),
    onComplete,
  }: {
    now?: () => number;
    onComplete: (
      summary: D1TelemetrySummary,
      completion: Completion<T>,
    ) => void;
  },
): Promise<T> {
  const telemetry: Telemetry = {
    d1: metrics(),
    databases: new Map(),
    phases: new Map(),
    closed: false,
    now,
  };
  const databases = new Map<PropertyKey, D1Database>();
  const measuredEnv = new Proxy(env, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!databaseBindings.has(property as keyof Env) || !value) return value;
      let wrapped = databases.get(property);
      if (!wrapped) {
        wrapped = instrumentDatabase(value, String(property), telemetry);
        databases.set(property, wrapped);
      }
      return wrapped;
    },
  });
  const startedAt = now();
  let completion: Completion<T> = { ok: false };
  try {
    const value = await context.run({ telemetry, phase: "other" }, () =>
      work(measuredEnv),
    );
    completion = { ok: true, value };
    return value;
  } finally {
    telemetry.closed = true;
    const durationMs = Math.max(0, now() - startedAt);
    try {
      onComplete(
        {
          durationMs,
          d1: { ...telemetry.d1 },
          databases: Object.fromEntries(
            Array.from(telemetry.databases, ([name, entry]) => [
              name,
              { ...entry },
            ]),
          ),
          phases: Object.fromEntries(
            Array.from(telemetry.phases, ([name, entry]) => [
              name,
              { durationMs: entry.durationMs, d1: { ...entry.d1 } },
            ]),
          ),
        },
        completion,
      );
    } catch {}
  }
}

export async function withD1OperationTelemetry<T>(
  operation: string,
  env: Env,
  work: (env: Env) => Promise<T>,
  {
    now = () => performance.now(),
    sample = () => Math.random() < 0.1,
    log = (record: Record<string, unknown>) =>
      console.info(JSON.stringify(record)),
  }: {
    now?: () => number;
    sample?: () => boolean;
    log?: (record: Record<string, unknown>) => void;
  } = {},
): Promise<T> {
  let sampled = false;
  try {
    sampled = sample();
  } catch {}
  const complete = (
    summary: D1TelemetrySummary | null,
    durationMs: number,
    completion: Completion<T>,
  ) => {
    const status =
      completion.ok && completion.value instanceof Response
        ? completion.value.status
        : undefined;
    if (!sampled && completion.ok && (status === undefined || status < 500))
      return;
    try {
      log({
        event: "d1_timing",
        operation,
        ...(status === undefined ? {} : { status }),
        outcome:
          !completion.ok || (status !== undefined && status >= 400)
            ? "failed"
            : "ok",
        durationMs,
        d1: summary?.d1 ?? null,
        ...(summary
          ? { databases: summary.databases, phases: summary.phases }
          : {}),
      });
    } catch {}
  };
  if (sampled)
    return collectD1Telemetry(env, work, {
      now,
      onComplete: (summary, completion) =>
        complete(summary, summary.durationMs, completion),
    });
  const startedAt = now();
  let completion: Completion<T> = { ok: false };
  try {
    const value = await work(env);
    completion = { ok: true, value };
    return value;
  } finally {
    complete(null, Math.max(0, now() - startedAt), completion);
  }
}
