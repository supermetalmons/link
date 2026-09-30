import { AsyncLocalStorage } from "node:async_hooks";
import { collectD1Telemetry, type D1TelemetrySummary } from "./d1Telemetry.ts";

export { measureD1Phase as measureAutomatchPhase } from "./d1Telemetry.ts";

type Outcome = "pending" | "matched" | "replay" | "recovery";
const context = new AsyncLocalStorage<{
  outcomes: Set<Outcome>;
  closed: boolean;
}>();

export function markAutomatchOutcome(outcome: Outcome): void {
  const current = context.getStore();
  if (current && !current.closed) current.outcomes.add(outcome);
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
  const current = { outcomes: new Set<Outcome>(), closed: false };
  let sampled = false;
  try {
    sampled = sample();
  } catch {}
  let summary: D1TelemetrySummary | undefined;
  const emit = (telemetry: D1TelemetrySummary, response?: Response) => {
    if (!sampled && response && response.status < 500) return;
    try {
      log({
        event: "automatch_timing",
        ...(response ? { status: response.status } : {}),
        outcome:
          !response || response.status >= 400
            ? "failed"
            : current.outcomes.has("replay")
              ? "replay"
              : current.outcomes.has("matched")
                ? "matched"
                : current.outcomes.has("pending")
                  ? "pending"
                  : "failed",
        recovered: current.outcomes.has("recovery"),
        durationMs: telemetry.durationMs,
        d1Calls: telemetry.d1.calls,
        phases: Object.fromEntries(
          Object.entries(telemetry.phases).map(([name, entry]) => [
            name,
            {
              durationMs: entry.durationMs,
              d1Calls: entry.d1.calls,
              d1: entry.d1,
            },
          ]),
        ),
        d1: telemetry.d1,
        databases: telemetry.databases,
      });
    } catch {}
  };
  const response = await context.run(current, () =>
    collectD1Telemetry(env, work, {
      now,
      onComplete: (telemetry, completion) => {
        current.closed = true;
        summary = telemetry;
        if (!completion.ok) emit(telemetry);
      },
    }),
  );
  if (!summary) return response;
  response.headers.set(
    "Server-Timing",
    [
      ...Object.entries(summary.phases).map(
        ([name, entry]) => `${name};dur=${entry.durationMs.toFixed(1)}`,
      ),
      `total;dur=${summary.durationMs.toFixed(1)}`,
      `d1;desc="${summary.d1.calls} calls"`,
    ].join(", "),
  );
  response.headers.set(
    "Access-Control-Expose-Headers",
    "Retry-After, Server-Timing",
  );
  const origin = response.headers.get("Access-Control-Allow-Origin");
  if (origin) response.headers.set("Timing-Allow-Origin", origin);
  emit(summary, response);
  return response;
}
