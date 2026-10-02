import { runRecoveryItems } from "./recoveryRunner.ts";
import {
  reportRecoveryItemFailure,
  type RecoveryFailureReporter,
} from "./recoveryReporting.ts";

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
  onFailure?: RecoveryFailureReporter<Entry>,
): Promise<{
  repairedTasks: Task[];
  removedCount: number;
  failures: Error[];
}> {
  const repairedTasks: Task[] = [];
  let removedCount = 0;
  const failures: Error[] = [];
  let index = 0;
  await runRecoveryItems(entries, async (entry) => {
    const itemIndex = index++;
    try {
      const result = await repair(entry);
      if (result?.kind === "repaired") {
        repairedTasks.push(result.task);
      } else if (result?.kind === "removed") {
        removedCount += 1;
      }
    } catch (error) {
      reportRecoveryItemFailure(onFailure, entry, error, itemIndex);
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
  onFailure?: RecoveryFailureReporter<T>,
): Promise<{ claimed: T[]; failure: Error | null; failures: Error[] }> {
  const claimed: T[] = [];
  const failures: Error[] = [];
  let index = 0;
  await runRecoveryItems(items, async (item) => {
    const itemIndex = index++;
    try {
      if (await claim(item)) {
        claimed.push(item);
      }
    } catch (error) {
      reportRecoveryItemFailure(onFailure, item, error, itemIndex);
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
  onClaimFailure,
}: {
  candidates: readonly Candidate[];
  claim: (candidate: Candidate) => Promise<boolean>;
  toTask: (candidate: Candidate) => Task;
  queue: Pick<Queue<Task>, "sendBatch">;
  initialTasks?: readonly Task[];
  fallbackErrorMessage: string;
  onClaimFailure?: RecoveryFailureReporter<Candidate>;
}): Promise<{
  sentCount: number;
  claimFailure: Error | null;
  claimFailures: Error[];
}> {
  const claims = await collectSuccessfulClaims(
    candidates,
    claim,
    fallbackErrorMessage,
    onClaimFailure,
  );
  const tasks = [...initialTasks, ...claims.claimed.map(toTask)];
  await sendQueueTasks(queue, tasks);
  return {
    sentCount: tasks.length,
    claimFailure: claims.failure,
    claimFailures: claims.failures,
  };
}
