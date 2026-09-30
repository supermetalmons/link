import { summarizeError } from "./errorSummary.ts";
import { measureD1Task } from "./d1Telemetry.ts";

type ScheduledTask = {
  name: string;
  run: () => Promise<unknown>;
};

export async function runScheduledTasks(
  tasks: readonly ScheduledTask[],
  {
    scheduledTime,
    now = Date.now,
    logger = console,
  }: {
    scheduledTime: number;
    now?: () => number;
    logger?: Pick<Console, "error">;
  },
): Promise<void> {
  const durations: number[] = [];
  const results = await Promise.allSettled(
    tasks.map(async (task, index) => {
      const startedAtMs = now();
      try {
        await measureD1Task(task.name, () => task.run());
      } finally {
        durations[index] = Math.max(0, now() - startedAtMs);
      }
    }),
  );
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    logger.error(
      JSON.stringify({
        event: "scheduled_task_failed",
        task: tasks[index].name,
        durationMs: durations[index],
        scheduledTime,
        code:
          result.reason instanceof Error ? result.reason.message : "unknown",
        error: summarizeError(result.reason),
      }),
    );
  }
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}
