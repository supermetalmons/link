import type {
  EventCommand,
  EventCommitPlan,
} from "../../../runtime/eventCommands.js";
import type { EventGameplayRepository } from "./eventRepository.ts";
import type { EventCommitOptions } from "./eventStoreContracts.ts";

export type EventMutationReads = Pick<
  EventGameplayRepository,
  "readEvent" | "readEventProgressOutbox"
>;

export type PreparedEventMutation = {
  commands: EventCommitPlan;
  dispatch(): Promise<void>;
};

export function createEventMutationReads(
  repository: EventMutationReads,
  signal?: AbortSignal,
): EventMutationReads {
  const events = new Map<string, ReturnType<EventMutationReads["readEvent"]>>();
  return {
    readEvent(eventId) {
      let event = events.get(eventId);
      if (!event) {
        event = Promise.resolve().then(() =>
          repository.readEvent(eventId, signal),
        );
        events.set(eventId, event);
      }
      return event;
    },
    readEventProgressOutbox: (outboxId) =>
      repository.readEventProgressOutbox(outboxId, signal),
  };
}

export async function commitPreparedEventMutation(
  repository: Pick<EventGameplayRepository, "commitEventPlan">,
  updates: readonly EventCommand[],
  preparations: readonly (PreparedEventMutation | null)[],
  signal?: AbortSignal,
  schedule?: (work: Promise<void>) => void,
  options?: EventCommitOptions,
): Promise<void> {
  const prepared = preparations.filter(
    (value): value is PreparedEventMutation => value !== null,
  );
  await repository.commitEventPlan(
    prepared.length === 0
      ? updates
      : [...updates, ...prepared.flatMap(({ commands }) => commands)],
    signal,
    options,
  );
  if (prepared.length === 0) return;
  const dispatches = prepared.toReversed();
  if (schedule) {
    schedule(
      Promise.allSettled(
        dispatches.map((preparation) => preparation.dispatch()),
      ).then((results) => {
        for (const result of results)
          if (result.status === "rejected") throw result.reason;
      }),
    );
    return;
  }
  for (const preparation of dispatches) await preparation.dispatch();
}
