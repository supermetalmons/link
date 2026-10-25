import {
  readEventDocument,
  readEventParticipantsDocument,
  readEventRoundDocument,
  type EventDocument,
  type EventParticipantsDocument,
  type EventRoundDocument,
} from "../../../runtime/events/documents.js";
import type { EventCommitPlan } from "../../../runtime/eventCommands.js";
import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import type {
  EventStore,
  EventCommitOptions,
} from "../src/eventStoreContracts.ts";
import type { EventPersistenceCommand } from "../src/eventPersistenceCommands.ts";

export function eventDocumentFixture<Source extends object>(
  value: Source,
): EventDocument & Source {
  const event = readEventDocument(value);
  if (!event) throw new TypeError("invalid event fixture");
  return Object.assign(event, value);
}

export function eventParticipantsFixture<Source extends object>(
  value: Source,
): EventParticipantsDocument & Source {
  const participants = readEventParticipantsDocument(value);
  if (!participants) throw new TypeError("invalid event participants fixture");
  return Object.assign(participants, value);
}

export function eventRoundFixture<Source extends object>(
  value: Source,
): EventRoundDocument & Source {
  const round = readEventRoundDocument(value);
  if (!round) throw new TypeError("invalid event round fixture");
  return Object.assign(round, value);
}

export function eventRecordFixture(value: unknown): Record<string, unknown> {
  const event = readEventDocument(value);
  if (!event) throw new TypeError("invalid event record fixture");
  return Object.fromEntries(Object.entries(event));
}

export function decodeEventCompatibilityPlanFixture(
  updates: Record<string, unknown>,
): EventCommitPlan {
  return invokeEventCompatibilityFixture(
    (plan: EventCommitPlan) => plan,
    decodeEventUpdates(updates),
  );
}

export function commitEventCompatibilityFixture(
  repository: Pick<EventStore, "commitEventPlan">,
  commands: readonly EventPersistenceCommand[],
  signal?: AbortSignal,
  options?: EventCommitOptions,
): Promise<void> {
  return Reflect.apply(repository.commitEventPlan, repository, [
    commands,
    signal,
    options,
  ]);
}

export function invokeEventCompatibilityFixture<
  Operation extends (...args: never[]) => unknown,
>(operation: Operation, ...args: unknown[]): ReturnType<Operation> {
  return Reflect.apply(operation, undefined, args);
}
