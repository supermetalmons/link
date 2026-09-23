import { runRecoveryItems } from "./recoveryRunner.ts";

export async function sendQueueTasks<T>(
  queue: Pick<Queue<T>, "sendBatch">,
  tasks: readonly T[],
): Promise<void> {
  for (let index = 0; index < tasks.length; index += 100) {
    await queue.sendBatch(
      tasks.slice(index, index + 100).map((task) => ({ body: task })),
    );
  }
}

type ProjectionRepairResult<Task> =
  { kind: "changed" } | { kind: "removed" } | { kind: "repaired"; task: Task };

export async function collectProjectionRepairs<Entry, Task = never>(
  entries: readonly Entry[],
  repair: (entry: Entry) => Promise<ProjectionRepairResult<Task> | void>,
  fallbackErrorMessage: string,
): Promise<{
  repairedTasks: Task[];
  removedCount: number;
  failures: Error[];
}> {
  const repairedTasks: Task[] = [];
  let removedCount = 0;
  const failures: Error[] = [];
  await runRecoveryItems(entries, async (entry) => {
    try {
      const result = await repair(entry);
      if (result?.kind === "repaired") {
        repairedTasks.push(result.task);
      } else if (result?.kind === "removed") {
        removedCount += 1;
      }
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error(fallbackErrorMessage),
      );
    }
  });
  return { repairedTasks, removedCount, failures };
}

export async function collectSuccessfulClaims<T>(
  items: readonly T[],
  claim: (item: T) => Promise<boolean>,
  fallbackErrorMessage: string,
): Promise<{ claimed: T[]; failure: Error | null; failures: Error[] }> {
  const claimed: T[] = [];
  const failures: Error[] = [];
  await runRecoveryItems(items, async (item) => {
    try {
      if (await claim(item)) {
        claimed.push(item);
      }
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error(fallbackErrorMessage),
      );
    }
  });
  return { claimed, failure: failures[0] ?? null, failures };
}

export async function claimAndEnqueueProjectionTasks<Candidate, Task>({
  candidates,
  claim,
  toTask,
  queue,
  initialTasks = [],
  fallbackErrorMessage,
}: {
  candidates: readonly Candidate[];
  claim: (candidate: Candidate) => Promise<boolean>;
  toTask: (candidate: Candidate) => Task;
  queue: Pick<Queue<Task>, "sendBatch">;
  initialTasks?: readonly Task[];
  fallbackErrorMessage: string;
}): Promise<{
  sentCount: number;
  claimFailure: Error | null;
  claimFailures: Error[];
}> {
  const claims = await collectSuccessfulClaims(
    candidates,
    claim,
    fallbackErrorMessage,
  );
  const tasks = [...initialTasks, ...claims.claimed.map(toTask)];
  await sendQueueTasks(queue, tasks);
  return {
    sentCount: tasks.length,
    claimFailure: claims.failure,
    claimFailures: claims.failures,
  };
}
