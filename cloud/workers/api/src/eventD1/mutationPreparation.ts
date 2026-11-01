import {
  retainEventProgressRecord,
  type EventProgressDocument,
} from "../../../../runtime/eventProgressRecords.js";
import {
  isRecord,
  cloneJson,
  decodeJson,
  validateEventAggregate,
  exactKey,
  validatePrizeSelection,
  validateEventPrizeAssignment,
  parseStoredEventPrizeAssignment,
} from "./validation.ts";
import {
  EventD1Failure,
  type EventD1Connection,
  type EventMutationState,
  type ProfilePrizeMutationState,
  type EventMutationOptions,
  type ProgressOutboxSnapshot,
} from "./types.ts";
import {
  readEventRecord,
  readSelections,
  readProfileEventPrizes,
  readProfilePrizeMutationSnapshots,
  readEventProgressOutboxSnapshot,
  readEventProfileGameProjectionOutbox,
} from "./reads.ts";
import type { EventPersistenceMutation as EventMutation } from "../eventPersistenceCommands.ts";
import type { EventFieldMutation } from "../../../../runtime/eventCommands.js";
import type { EventRecordFields } from "@mons/shared/events";
import {
  readEventMutationSnapshots,
  requiredMutationSnapshot,
  validateEventMutationKeys,
  type EventMutationSnapshots,
} from "./mutationSnapshots.ts";

export type PreparedEventMutations = {
  snapshots: EventMutationSnapshots | null;
  progressOutboxSnapshot: EventMutationOptions["progressOutboxSnapshot"];
  progressDispatchSnapshots: ReadonlyMap<string, ProgressOutboxSnapshot>;
  telegramProjectionSnapshot: EventMutationOptions["telegramProjectionSnapshot"];
  eventStates: ReadonlyMap<string, EventMutationState>;
  profileStates: ReadonlyMap<string, ProfilePrizeMutationState>;
  progressUpdates: ReadonlyMap<string, EventProgressDocument<"pending"> | null>;
  progressDeadUpdates: ReadonlyMap<
    string,
    EventProgressDocument<"dead"> | null
  >;
  profileProjectionUpdates: ReadonlyMap<string, unknown>;
  telegramProjectionUpdates: ReadonlyMap<string, unknown>;
  telegramStateUpdates: ReadonlyMap<
    string,
    { generation?: unknown; state?: unknown }
  >;
};

function setNested(
  root: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): void {
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const existing = current[part];
    if (!isRecord(existing)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  const key = parts.at(-1);
  if (!key) throw new EventD1Failure("invalid-event-path");
  if (value === null) delete current[key];
  else current[key] = cloneJson(value);
}

function applyEventField(
  event: EventRecordFields,
  change: EventFieldMutation,
): void {
  switch (change.field) {
    case "createdAtMs":
      event.createdAtMs = change.value;
      break;
    case "endedAtMs":
      event.endedAtMs = change.value;
      break;
    case "participants":
      event.participants = cloneJson(change.value);
      break;
    case "startAtMs":
      event.startAtMs = change.value;
      break;
    case "startedAtMs":
      event.startedAtMs = change.value;
      break;
    case "status":
      event.status = change.value;
      break;
    case "winnerDisplayName":
      event.winnerDisplayName = change.value;
      break;
    case "winnerProfileId":
      event.winnerProfileId = change.value;
      break;
    case "currentRoundIndex":
      event.currentRoundIndex = change.value;
      break;
    case "bracketSize":
      event.bracketSize = change.value;
      break;
    case "roundCount":
      event.roundCount = change.value;
      break;
    case "rounds":
      event.rounds = cloneJson(change.value);
      break;
    case "thirdPlaceMatch":
      event.thirdPlaceMatch = cloneJson(change.value);
      break;
    case "updatedAtMs":
      event.updatedAtMs = change.value;
      break;
    case "prizeSelectionsLockedAtMs":
      event.prizeSelectionsLockedAtMs = change.value;
      break;
    case "prizeAssignments":
      event.prizeAssignments = cloneJson(change.value);
      break;
    case "isSundayMons":
      event.isSundayMons = change.value;
      break;
    case "telegramAnnouncements":
      event.telegramAnnouncements = cloneJson(change.value);
      break;
    default:
      throw new EventD1Failure("invalid-event-field");
  }
}

async function getEventMutationState(
  db: EventD1Connection,
  states: Map<string, EventMutationState>,
  eventId: string,
  snapshots: EventMutationSnapshots | null,
): Promise<EventMutationState> {
  let state = states.get(eventId);
  if (!state) {
    const stored = snapshots
      ? requiredMutationSnapshot(snapshots.events, eventId)
      : await readEventRecord(db, eventId);
    state = {
      current: stored?.event ?? null,
      next: stored ? cloneJson(stored.event) : null,
      originalSelections: null,
      pendingTransitionId: stored?.pendingTransitionId ?? null,
      revision: stored?.revision ?? 0,
      selections: null,
      selectionsChanged: false,
    };
    states.set(eventId, state);
  }
  return state;
}

async function ensureSelections(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
  snapshots: EventMutationSnapshots | null,
): Promise<Record<string, string>> {
  if (state.selections === null) {
    state.originalSelections = snapshots
      ? requiredMutationSnapshot(snapshots.selections, eventId)
      : await readSelections(db, eventId);
    state.selections = { ...state.originalSelections };
  }
  return state.selections;
}

function profilePrizeReadTargets(changes: readonly EventMutation[]) {
  const targets = new Map<string, Set<string>>();
  const fullProfiles = new Set<string>();
  for (const change of changes) {
    if (change.kind !== "profile-prize" && change.kind !== "profile-prizes")
      continue;
    const profileId = exactKey(change.profileId);
    if (!profileId) throw new EventD1Failure("invalid-event-path");
    if (change.kind === "profile-prizes") {
      fullProfiles.add(profileId);
      continue;
    }
    const eventId = exactKey(change.eventId);
    if (!eventId) throw new EventD1Failure("invalid-event-path");
    if (!eventId.isWellFormed()) fullProfiles.add(profileId);
    const eventIds = targets.get(profileId) || new Set<string>();
    eventIds.add(eventId);
    targets.set(profileId, eventIds);
  }
  for (const profileId of fullProfiles) targets.delete(profileId);
  return targets;
}

export async function prepareEventMutations(
  db: EventD1Connection,
  changes: readonly EventMutation[],
  options: EventMutationOptions,
): Promise<PreparedEventMutations> {
  const eventStates = new Map<string, EventMutationState>();
  const profileStates = new Map<string, ProfilePrizeMutationState>();
  const progressOutboxSnapshot = options.progressOutboxSnapshot;
  if (
    progressOutboxSnapshot &&
    (changes.length !== 1 ||
      changes[0]!.kind !== "progress-outbox" ||
      changes[0]!.outboxId !== progressOutboxSnapshot.outboxId)
  )
    throw new EventD1Failure("invalid-progress-outbox-snapshot-scope");
  const telegramProjectionSnapshot = options.telegramProjectionSnapshot;
  if (
    telegramProjectionSnapshot &&
    (changes.length !== 1 ||
      (changes[0]!.kind !== "telegram-state" &&
        changes[0]!.kind !== "telegram-generation") ||
      changes[0]!.eventId !== telegramProjectionSnapshot.eventId)
  )
    throw new EventD1Failure("invalid-telegram-projection-snapshot-scope");
  const eventSnapshot = options.eventSnapshot;
  if (eventSnapshot) {
    if (
      changes.length !== 1 ||
      !("eventId" in changes[0]!) ||
      changes[0]!.eventId !== eventSnapshot.eventId
    )
      throw new EventD1Failure("invalid-event-snapshot-scope");
    eventStates.set(eventSnapshot.eventId, {
      current: eventSnapshot.event,
      next: cloneJson(eventSnapshot.event),
      originalSelections: eventSnapshot.prizeSelections,
      pendingTransitionId: eventSnapshot.pendingTransitionId,
      revision: eventSnapshot.revision,
      selections: { ...eventSnapshot.prizeSelections },
      selectionsChanged: false,
    });
  }
  const snapshot = options.profilePrizeSnapshot;
  if (snapshot) {
    if (
      changes.length !== 1 ||
      changes[0]!.kind !== "profile-prize" ||
      changes[0]!.profileId !== snapshot.profileId ||
      changes[0]!.eventId !== snapshot.eventId
    )
      throw new EventD1Failure("invalid-profile-prize-snapshot-scope");
    const originalPrizes =
      snapshot.assignment === null
        ? {}
        : { [snapshot.eventId]: snapshot.assignment };
    profileStates.set(snapshot.profileId, {
      originalPrizes,
      prizes: Object.assign(Object.create(null), originalPrizes),
      revision: snapshot.revision,
    });
  }
  const profilePrizeSnapshots = await readProfilePrizeMutationSnapshots(
    db,
    snapshot ? new Map() : profilePrizeReadTargets(changes),
  );
  const snapshots = await readEventMutationSnapshots(db, changes, options);
  const progressUpdates = new Map<
    string,
    EventProgressDocument<"pending"> | null
  >();
  const progressDispatchSnapshots = new Map<string, ProgressOutboxSnapshot>();
  const progressDeadUpdates = new Map<
    string,
    EventProgressDocument<"dead"> | null
  >();
  const profileProjectionUpdates = new Map<string, unknown>();
  const telegramProjectionUpdates = new Map<string, unknown>();
  const telegramStateUpdates = new Map<
    string,
    { generation?: unknown; state?: unknown }
  >();

  for (const change of changes) {
    validateEventMutationKeys(change);
    const { value } = change;
    switch (change.kind) {
      case "event":
      case "event-field":
      case "event-participant":
      case "event-disqualification":
      case "event-round":
      case "event-match-status": {
        const eventId = exactKey(change.eventId);
        if (!eventId) throw new EventD1Failure("invalid-event-path");
        const state = await getEventMutationState(
          db,
          eventStates,
          eventId,
          snapshots,
        );
        if (change.kind === "event") {
          if (value === null)
            throw new EventD1Failure("event-deletion-unsupported");
          state.next = validateEventAggregate(eventId, value);
        } else {
          if (!state.next) throw new EventD1Failure("event-not-found");
          if (change.kind === "event-round") {
            if (change.value === null)
              delete state.next.rounds[change.roundKey];
            else state.next.rounds[change.roundKey] = cloneJson(change.value);
          }
          if (change.kind === "event-match-status") {
            const match =
              state.next.rounds[change.roundKey]?.matches[change.matchKey];
            if (!match) throw new EventD1Failure("event-match-not-found");
            match.status = change.value;
          }
          if (change.kind === "event-field")
            applyEventField(state.next, change);
          if (change.kind === "event-participant") {
            if (change.value === null)
              delete state.next.participants[change.profileId];
            else
              state.next.participants[change.profileId] = cloneJson(
                change.value,
              );
          }
          if (change.kind === "event-disqualification") {
            const match =
              change.roundKey === null
                ? state.next.thirdPlaceMatch
                : state.next.rounds[change.roundKey]?.matches[change.matchKey];
            if (!match) throw new EventD1Failure("event-match-not-found");
            match.winnerDisqualified = change.value;
          }
        }
        break;
      }
      case "prize-selections":
      case "prize-selection": {
        const eventId = exactKey(change.eventId);
        if (!eventId) throw new EventD1Failure("invalid-event-path");
        const state = await getEventMutationState(
          db,
          eventStates,
          eventId,
          snapshots,
        );
        if (!state.next) throw new EventD1Failure("event-not-found");
        const selections = await ensureSelections(
          db,
          eventId,
          state,
          snapshots,
        );
        if (change.kind === "prize-selections") {
          const replacement = value === null ? {} : value;
          if (!isRecord(replacement))
            throw new EventD1Failure("invalid-event-prize-selections");
          state.selections = Object.fromEntries(
            Object.entries(replacement).map(([profileId, prizeId]) => {
              const key = exactKey(profileId);
              if (!key)
                throw new EventD1Failure("invalid-event-prize-selection");
              return [key, validatePrizeSelection(eventId, prizeId)];
            }),
          );
        } else {
          const profileId = exactKey(change.profileId);
          if (!profileId) throw new EventD1Failure("invalid-event-path");
          if (value === null) delete selections[profileId];
          else selections[profileId] = validatePrizeSelection(eventId, value);
        }
        state.selectionsChanged = true;
        break;
      }
      case "profile-prizes":
      case "profile-prize": {
        const profileId = exactKey(change.profileId);
        if (!profileId) throw new EventD1Failure("invalid-event-path");
        let state = profileStates.get(profileId);
        if (!state) {
          const stored =
            profilePrizeSnapshots.get(profileId) ||
            (await readProfileEventPrizes(db, profileId));
          state = {
            originalPrizes: stored.prizes,
            prizes: Object.assign(Object.create(null), stored.prizes),
            revision: stored.revision,
          };
          profileStates.set(profileId, state);
        }
        if (change.kind === "profile-prizes") {
          const replacement = value === null ? {} : value;
          if (!isRecord(replacement))
            throw new EventD1Failure("invalid-profile-event-prizes");
          state.prizes = Object.fromEntries(
            Object.entries(replacement).map(([eventId, assignment]) => [
              eventId,
              validateEventPrizeAssignment(profileId, eventId, assignment),
            ]),
          );
        } else {
          const eventId = exactKey(change.eventId);
          if (!eventId) throw new EventD1Failure("invalid-event-path");
          if (value === null) delete state.prizes[eventId];
          else
            state.prizes[eventId] = options.allowStoredProfilePrizeAssignment
              ? parseStoredEventPrizeAssignment(profileId, eventId, value)
              : validateEventPrizeAssignment(profileId, eventId, value);
        }
        break;
      }
      case "progress-outbox": {
        const outboxId = exactKey(change.outboxId);
        progressUpdates.set(
          outboxId,
          change.value === null ? null : cloneJson(change.value),
        );
        progressDispatchSnapshots.delete(outboxId);
        break;
      }
      case "progress-dead":
        progressDeadUpdates.set(
          exactKey(change.outboxId),
          change.value === null ? null : cloneJson(change.value),
        );
        break;
      case "progress-dispatched": {
        const outboxId = exactKey(change.outboxId);
        const snapshot = await readEventProgressOutboxSnapshot(db, outboxId);
        const current =
          snapshot.recordJson === null
            ? null
            : retainEventProgressRecord(
                "pending",
                decodeJson(snapshot.recordJson),
              );
        if (!current) throw new EventD1Failure("event-progress-not-found");
        progressDispatchSnapshots.set(outboxId, snapshot);
        progressUpdates.set(outboxId, {
          ...cloneJson(current),
          lastQueuedAtMs: change.value,
        });
        break;
      }
      case "profile-game-outbox":
        profileProjectionUpdates.set(exactKey(change.eventId), value);
        break;
      case "profile-game-outbox-field":
      case "profile-game-outbox-cleanup": {
        const eventId = exactKey(change.eventId);
        const stored = profileProjectionUpdates.has(eventId)
          ? profileProjectionUpdates.get(eventId)
          : snapshots
            ? requiredMutationSnapshot(snapshots.profileGame, eventId)
            : await readEventProfileGameProjectionOutbox(db, eventId);
        const next = isRecord(stored) ? cloneJson(stored) : {};
        setNested(
          next,
          change.kind === "profile-game-outbox-field"
            ? [change.field]
            : ["cleanupOwnerProfileIds", exactKey(change.profileId)],
          value,
        );
        profileProjectionUpdates.set(eventId, next);
        break;
      }
      case "telegram-outbox":
        telegramProjectionUpdates.set(exactKey(change.eventId), value);
        break;
      case "telegram-state":
      case "telegram-generation": {
        const eventId = exactKey(change.eventId);
        const update = telegramStateUpdates.get(eventId) || {};
        if (change.kind === "telegram-state") update.state = value;
        else
          update.generation = change.increment
            ? { increment: change.value }
            : change.value;
        telegramStateUpdates.set(eventId, update);
        break;
      }
    }
  }

  if (options.transition) {
    const transitionEventId = exactKey(options.transition.eventId);
    const transitionId = exactKey(options.transition.transitionId);
    if (!transitionEventId || !transitionId) {
      throw new EventD1Failure("invalid-event-transition");
    }
    const state = await getEventMutationState(
      db,
      eventStates,
      transitionEventId,
      snapshots,
    );
    if (state.pendingTransitionId !== transitionId) {
      throw new EventD1Failure("event-transition-not-owned");
    }
  }

  return {
    snapshots,
    progressOutboxSnapshot,
    progressDispatchSnapshots,
    telegramProjectionSnapshot,
    eventStates,
    profileStates,
    progressUpdates,
    progressDeadUpdates,
    profileProjectionUpdates,
    telegramProjectionUpdates,
    telegramStateUpdates,
  };
}
