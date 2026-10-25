import type { QueueProducer } from "./queueProducers.ts";
import { collectRecoveryItems } from "./recoveryRunner.ts";
import {
  reportRecoveryItemFailure,
  type RecoveryFailureReporter,
} from "./recoveryReporting.ts";

export async function sendQueueTasks<T>(
  queue: Pick<QueueProducer<T>, "sendBatch">,
  tasks: readonly T[],
): Promise<void> {
  for (let index = 0; index < tasks.length; index += 100) {
    await queue.sendBatch(
      tasks.slice(index, index + 100).map((task) => ({ body: task })),
    );
  }
}

type ProjectionScanEntry<Candidate, Invalid extends { kind: "invalid" }> =
  | { kind: "candidate"; value: Candidate }
  | Invalid
  | { kind: "failure"; error: unknown };

type ProjectionScanPhase = "inspect" | "claim" | "quarantine";

export async function recoverAndEnqueueProjectionScan<
  Candidate,
  Invalid extends { kind: "invalid" },
  Task extends object,
>({
  entries,
  queue,
  concurrency = 1,
  quarantine,
  processCandidate,
  onFailure,
}: {
  entries: readonly ProjectionScanEntry<Candidate, Invalid>[];
  queue: Pick<QueueProducer<Task>, "sendBatch">;
  concurrency?: number;
  quarantine: (entry: Invalid) => Promise<void>;
  processCandidate: (
    candidate: Candidate,
    setPhase: (phase: "claim" | "quarantine") => void,
  ) => Promise<Task | undefined>;
  onFailure?: (
    entry: ProjectionScanEntry<Candidate, Invalid>,
    error: unknown,
    index: number,
    phase: ProjectionScanPhase,
  ) => void;
}): Promise<{
  sentCount: number;
  failures: Array<{
    item: ProjectionScanEntry<Candidate, Invalid>;
    index: number;
    error: unknown;
  }>;
}> {
  const { successes, failures } = await collectRecoveryItems(
    entries,
    async (entry, index) => {
      let phase: ProjectionScanPhase = "inspect";
      try {
        if (entry.kind === "failure") throw entry.error;
        if (entry.kind === "invalid") {
          phase = "quarantine";
          await quarantine(entry);
          return;
        }
        phase = "claim";
        return await processCandidate(entry.value, (nextPhase) => {
          phase = nextPhase;
        });
      } catch (error) {
        reportRecoveryItemFailure(
          (item, failure, itemIndex) =>
            onFailure?.(item, failure, itemIndex, phase),
          entry,
          error,
          index,
        );
        throw error;
      }
    },
    { concurrency },
  );
  const tasks = successes.flatMap(({ value }) =>
    value === undefined ? [] : [value],
  );
  await sendQueueTasks(queue, tasks);
  return { sentCount: tasks.length, failures };
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
  const { successes, failures } = await collectRecoveryItems(entries, repair, {
    onFailure,
  });
  return {
    repairedTasks: successes.flatMap(({ value }) =>
      value?.kind === "repaired" ? [value.task] : [],
    ),
    removedCount: successes.filter(({ value }) => value?.kind === "removed")
      .length,
    failures: failures.map(({ error }) =>
      error instanceof Error ? error : new Error(fallbackErrorMessage),
    ),
  };
}

export async function collectSuccessfulClaims<T>(
  items: readonly T[],
  claim: (item: T) => Promise<boolean>,
  fallbackErrorMessage: string,
  onFailure?: RecoveryFailureReporter<T>,
): Promise<{ claimed: T[]; failure: Error | null; failures: Error[] }> {
  const { successes, failures: itemFailures } = await collectRecoveryItems(
    items,
    claim,
    { onFailure },
  );
  const failures = itemFailures.map(({ error }) =>
    error instanceof Error ? error : new Error(fallbackErrorMessage),
  );
  return {
    claimed: successes.flatMap(({ item, value }) => (value ? [item] : [])),
    failure: failures[0] ?? null,
    failures,
  };
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
  queue: Pick<QueueProducer<Task>, "sendBatch">;
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
