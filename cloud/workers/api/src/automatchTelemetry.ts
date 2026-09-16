import { AsyncLocalStorage } from "node:async_hooks";

type Outcome = "pending" | "matched" | "replay" | "recovery";
type Phase = { durationMs: number; d1Calls: number };
type Telemetry = {
  phases: Map<string, Phase>;
  outcomes: Set<Outcome>;
  d1Calls: number;
  finished: boolean;
  now: () => number;
};
const context = new AsyncLocalStorage<{
  telemetry: Telemetry;
  phase: string;
}>();

export async function measureAutomatchPhase<T>(
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  const current = context.getStore();
  if (!current || current.telemetry.finished) return work();
  const { telemetry } = current;
  const entry = telemetry.phases.get(phase) || { durationMs: 0, d1Calls: 0 };
  telemetry.phases.set(phase, entry);
  const startedAt = telemetry.now();
  try {
    return await context.run({ telemetry, phase }, work);
  } finally {
    entry.durationMs += Math.max(0, telemetry.now() - startedAt);
  }
}

export function markAutomatchOutcome(outcome: Outcome): void {
  context.getStore()?.telemetry.outcomes.add(outcome);
}

function instrumentDatabase(db: D1Database, telemetry: Telemetry): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const count = () => {
    if (telemetry.finished) return;
    telemetry.d1Calls++;
    const phase = context.getStore()?.phase || "other";
    const entry = telemetry.phases.get(phase) || { durationMs: 0, d1Calls: 0 };
    entry.d1Calls++;
    telemetry.phases.set(phase, entry);
  };
  const statement = (value: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(value, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => statement(target.bind(...values));
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (["first", "all", "run", "raw"].includes(String(property)))
            count();
          return Reflect.apply(method, target, args);
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
          return (statements: D1PreparedStatement[]) => {
            count();
            return target.batch(
              statements.map((item) => originals.get(item) || item),
            );
          };
        if (property === "withSession" && "withSession" in target)
          return (constraint?: string) =>
            database(target.withSession(constraint));
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (property === "exec") count();
          return Reflect.apply(method, target, args);
        };
      },
    });
  return database(db);
}

export async function withAutomatchTelemetry(
  env: Env,
  work: (env: Env) => Promise<Response>,
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
): Promise<Response> {
  const telemetry: Telemetry = {
    phases: new Map(),
    outcomes: new Set(),
    d1Calls: 0,
    finished: false,
    now,
  };
  const databases = new Map<PropertyKey, D1Database>();
  const measuredEnv = new Proxy(env, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !property.endsWith("_DB") || !value)
        return value;
      let wrapped = databases.get(property);
      if (!wrapped) {
        wrapped = instrumentDatabase(value, telemetry);
        databases.set(property, wrapped);
      }
      return wrapped;
    },
  });
  const startedAt = now();
  const response = await context.run({ telemetry, phase: "other" }, () =>
    work(measuredEnv),
  );
  telemetry.finished = true;
  const durationMs = Math.max(0, now() - startedAt);
  response.headers.set(
    "Server-Timing",
    [
      ...Array.from(
        telemetry.phases,
        ([name, entry]) => `${name};dur=${entry.durationMs.toFixed(1)}`,
      ),
      `total;dur=${durationMs.toFixed(1)}`,
      `d1;desc="${telemetry.d1Calls} calls"`,
    ].join(", "),
  );
  response.headers.set(
    "Access-Control-Expose-Headers",
    "Retry-After, Server-Timing",
  );
  const origin = response.headers.get("Access-Control-Allow-Origin");
  if (origin) response.headers.set("Timing-Allow-Origin", origin);
  if (sample())
    log({
      event: "automatch_timing",
      status: response.status,
      outcome:
        response.status >= 400
          ? "failed"
          : telemetry.outcomes.has("replay")
            ? "replay"
            : telemetry.outcomes.has("matched")
              ? "matched"
              : telemetry.outcomes.has("pending")
                ? "pending"
                : "failed",
      recovered: telemetry.outcomes.has("recovery"),
      durationMs,
      d1Calls: telemetry.d1Calls,
      phases: Object.fromEntries(telemetry.phases),
    });
  return response;
}
