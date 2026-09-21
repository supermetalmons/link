import {
  isRecord,
  cloneJson,
  validateEventAggregate,
  encodeJson,
  safeInteger,
  exactKey,
  validatePrizeSelection,
  validateEventPrizeAssignment,
  parseStoredEventPrizeAssignment,
  jsonValuesEqual,
  validateEventProgressOutbox,
  decodeJson,
  isJsonValue,
  validateProjectionOutbox,
} from "./validation.ts";
import {
  EventD1Failure,
  type EventD1Connection,
  type EventMutationState,
  type ProfilePrizeMutationState,
  type EventMutationOptions,
  type EventMutationResult,
  EventD1Conflict,
  type PublicEventMutationOptions,
  MAX_EVENT_TRANSACTION_ATTEMPTS,
} from "./types.ts";
import {
  readEventRecord,
  readSelections,
  readProfileEventPrizes,
  readEventProgressOutbox,
  readEventProgressOutboxSnapshot,
  readEventProfileGameProjectionOutbox,
  readEventTelegramProjectionState,
} from "./reads.ts";
import type { EventMutation } from "../../../../runtime/eventCommands.js";
import {
  eventWriteAdmissionGuard,
  eventLeaseGuard,
  eventMutationGuard,
  guardStatement,
  profileRevisionGuard,
  recordJsonGuard,
  progressOutboxSnapshotGuard,
  telegramStateRevisionGuard,
  rethrowEventBatchFailure,
} from "./guards.ts";
import { parseEventProgressOutbox } from "../eventProgressCodec.ts";

function setNested(
  root: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): void {
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const existing = current[part];
    if (!isRecord(existing)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  const key = parts.at(-1);
  if (!key) throw new EventD1Failure("invalid-event-path");
  if (value === null) delete current[key];
  else current[key] = cloneJson(value);
}

async function getEventMutationState(
  db: EventD1Connection,
  states: Map<string, EventMutationState>,
  eventId: string,
): Promise<EventMutationState> {
  let state = states.get(eventId);
  if (!state) {
    const stored = await readEventRecord(db, eventId);
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
): Promise<Record<string, string>> {
  if (state.selections === null) {
    state.originalSelections = await readSelections(db, eventId);
    state.selections = { ...state.originalSelections };
  }
  return state.selections;
}

async function readProfilePrizeMutationState(
  db: EventD1Connection,
  profileId: string,
): Promise<ProfilePrizeMutationState> {
  const snapshot = await readProfileEventPrizes(db, profileId);
  return {
    originalPrizes: snapshot.prizes,
    prizes: { ...snapshot.prizes },
    revision: snapshot.revision,
  };
}

function eventRecordStatement(
  db: EventD1Connection,
  eventId: string,
  state: EventMutationState,
  pendingTransitionId: string | null,
): D1PreparedStatement {
  if (!state.next) {
    return db
      .prepare("DELETE FROM event_records WHERE event_id = ?")
      .bind(eventId);
  }
  const event = validateEventAggregate(eventId, state.next);
  return db
    .prepare(
      `INSERT INTO event_records (
         event_id, status, start_at_ms, updated_at_ms, revision,
         pending_transition_id, record_json
       ) VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         status = excluded.status,
         start_at_ms = excluded.start_at_ms,
         updated_at_ms = excluded.updated_at_ms,
         revision = event_records.revision + 1,
         pending_transition_id = excluded.pending_transition_id,
         record_json = excluded.record_json`,
    )
    .bind(
      eventId,
      event.status,
      event.startAtMs,
      event.updatedAtMs,
      pendingTransitionId,
      encodeJson(event),
    );
}

export async function commitEventMutationsInternal(
  db: EventD1Connection,
  changes: readonly EventMutation[],
  options: EventMutationOptions,
): Promise<EventMutationResult> {
  const now = options.now || Date.now;
  const nowMs = safeInteger(now());
  const eventStates = new Map<string, EventMutationState>();
  const profileStates = new Map<string, ProfilePrizeMutationState>();
  const progressOutboxSnapshot = options.progressOutboxSnapshot;
  if (
    progressOutboxSnapshot &&
    (changes.length !== 1 ||
      changes[0].kind !== "progress-outbox" ||
      changes[0].outboxId !== progressOutboxSnapshot.outboxId)
  )
    throw new EventD1Failure("invalid-progress-outbox-snapshot-scope");
  const telegramProjectionSnapshot = options.telegramProjectionSnapshot;
  if (
    telegramProjectionSnapshot &&
    (changes.length !== 1 ||
      (changes[0].kind !== "telegram-state" &&
        changes[0].kind !== "telegram-generation") ||
      changes[0].eventId !== telegramProjectionSnapshot.eventId)
  )
    throw new EventD1Failure("invalid-telegram-projection-snapshot-scope");
  const eventSnapshot = options.eventSnapshot;
  if (eventSnapshot) {
    if (
      changes.length !== 1 ||
      !("eventId" in changes[0]) ||
      changes[0].eventId !== eventSnapshot.eventId
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
      changes[0].kind !== "profile-prize" ||
      changes[0].profileId !== snapshot.profileId ||
      changes[0].eventId !== snapshot.eventId
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
  const progressUpdates = new Map<string, unknown>();
  const progressDeadUpdates = new Map<string, unknown>();
  const profileProjectionUpdates = new Map<string, unknown>();
  const telegramProjectionUpdates = new Map<string, unknown>();
  const telegramStateUpdates = new Map<
    string,
    { generation?: unknown; state?: unknown }
  >();

  for (const change of changes) {
    for (const key of ["eventId", "profileId", "outboxId"] as const)
      if (key in change && !exactKey(change[key as keyof typeof change]))
        throw new EventD1Failure("invalid-event-path");
    if (
      "roundKey" in change &&
      change.roundKey !== null &&
      !exactKey(change.roundKey)
    )
      throw new EventD1Failure("invalid-event-path");
    if ("matchKey" in change && !exactKey(change.matchKey))
      throw new EventD1Failure("invalid-event-path");
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
        const state = await getEventMutationState(db, eventStates, eventId);
        if (change.kind === "event") {
          if (value === null)
            throw new EventD1Failure("event-deletion-unsupported");
          state.next = validateEventAggregate(eventId, value);
        } else {
          if (!state.next) throw new EventD1Failure("event-not-found");
          if (change.kind === "event-round")
            setNested(state.next, ["rounds", exactKey(change.roundKey)], value);
          if (change.kind === "event-match-status")
            setNested(
              state.next,
              [
                "rounds",
                exactKey(change.roundKey),
                "matches",
                exactKey(change.matchKey),
                "status",
              ],
              value,
            );
          if (change.kind === "event-field")
            setNested(state.next, [change.field], value);
          if (change.kind === "event-participant")
            setNested(
              state.next,
              ["participants", exactKey(change.profileId)],
              value,
            );
          if (change.kind === "event-disqualification")
            setNested(
              state.next,
              change.roundKey === null
                ? ["thirdPlaceMatch", "winnerDisqualified"]
                : [
                    "rounds",
                    exactKey(change.roundKey),
                    "matches",
                    exactKey(change.matchKey),
                    "winnerDisqualified",
                  ],
              value,
            );
        }
        break;
      }
      case "prize-selections":
      case "prize-selection": {
        const eventId = exactKey(change.eventId);
        if (!eventId) throw new EventD1Failure("invalid-event-path");
        const state = await getEventMutationState(db, eventStates, eventId);
        if (!state.next) throw new EventD1Failure("event-not-found");
        const selections = await ensureSelections(db, eventId, state);
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
          state = await readProfilePrizeMutationState(db, profileId);
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
      case "progress-outbox":
        progressUpdates.set(exactKey(change.outboxId), value);
        break;
      case "progress-dead":
        progressDeadUpdates.set(exactKey(change.outboxId), value);
        break;
      case "progress-dispatched": {
        const outboxId = exactKey(change.outboxId);
        const current = await readEventProgressOutbox(db, outboxId);
        if (!current) throw new EventD1Failure("event-progress-not-found");
        progressUpdates.set(outboxId, {
          ...cloneJson(current),
          lastQueuedAtMs: value,
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
    );
    if (state.pendingTransitionId !== transitionId) {
      throw new EventD1Failure("event-transition-not-owned");
    }
  }

  const guards: D1PreparedStatement[] = [];
  const mutations: D1PreparedStatement[] = [];
  const eventRevisions: Record<string, number> = {};
  const profilePrizeRevisions: Record<string, number> = {};

  guards.push(eventWriteAdmissionGuard(db, options.admission));
  if (options.eventLease) {
    guards.push(eventLeaseGuard(db, options.eventLease));
  }

  for (const [eventId, state] of eventStates) {
    if (
      state.pendingTransitionId &&
      (options.transition?.eventId !== eventId ||
        options.transition.transitionId !== state.pendingTransitionId)
    ) {
      throw new EventD1Failure("event-transition-pending");
    }
    const expected =
      options.expectedEventRevisions?.[eventId] ?? state.revision;
    if (expected !== state.revision) throw new EventD1Conflict();
    guards.push(eventMutationGuard(db, eventId, state));
    const transitionApplies = options.transition?.eventId === eventId;
    if (transitionApplies) {
      guards.push(
        guardStatement(
          db,
          `NOT EXISTS (
             SELECT 1 FROM event_transition_intents
             WHERE transition_id = ? AND event_id = ?
               AND expected_revision = ? AND status = 'pending'
           )`,
          [options.transition!.transitionId, eventId, expected],
          "invariant",
        ),
      );
    }
    mutations.push(
      eventRecordStatement(
        db,
        eventId,
        state,
        transitionApplies ? null : state.pendingTransitionId,
      ),
    );
    if (state.selectionsChanged) {
      const originalSelections = state.originalSelections || {};
      const selections = state.selections || {};
      for (const profileId of Object.keys(originalSelections)) {
        if (!Object.hasOwn(selections, profileId)) {
          mutations.push(
            db
              .prepare(
                "DELETE FROM event_prize_selections WHERE event_id = ? AND profile_id = ?",
              )
              .bind(eventId, profileId),
          );
        }
      }
      for (const [profileId, prizeId] of Object.entries(selections)) {
        if (
          Object.hasOwn(originalSelections, profileId) &&
          originalSelections[profileId] === prizeId
        ) {
          continue;
        }
        mutations.push(
          db
            .prepare(
              `INSERT INTO event_prize_selections (
                 event_id, profile_id, prize_id, updated_at_ms
               ) VALUES (?, ?, ?, ?)
               ON CONFLICT (event_id, profile_id) DO UPDATE SET
                 prize_id = excluded.prize_id,
                 updated_at_ms = excluded.updated_at_ms`,
            )
            .bind(eventId, profileId, prizeId, nowMs),
        );
      }
    }
    eventRevisions[eventId] = state.revision + 1;
  }

  for (const [profileId, state] of profileStates) {
    const expected =
      options.expectedProfilePrizeRevisions?.[profileId] ?? state.revision;
    if (expected !== state.revision) throw new EventD1Conflict();
    guards.push(profileRevisionGuard(db, profileId, expected));
    for (const eventId of Object.keys(state.originalPrizes)) {
      if (!Object.hasOwn(state.prizes, eventId)) {
        mutations.push(
          db
            .prepare(
              "DELETE FROM profile_event_prizes WHERE profile_id = ? AND event_id = ?",
            )
            .bind(profileId, eventId),
        );
      }
    }
    for (const [eventId, assignment] of Object.entries(state.prizes)) {
      if (
        Object.hasOwn(state.originalPrizes, eventId) &&
        jsonValuesEqual(state.originalPrizes[eventId], assignment)
      ) {
        continue;
      }
      mutations.push(
        db
          .prepare(
            `INSERT INTO profile_event_prizes (
               profile_id, event_id, assignment_json, updated_at_ms
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (profile_id, event_id) DO UPDATE SET
               assignment_json = excluded.assignment_json,
               updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(profileId, eventId, encodeJson(assignment), nowMs),
      );
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO profile_event_prize_revisions (
             profile_id, revision, updated_at_ms
           ) VALUES (?, 1, ?)
           ON CONFLICT (profile_id) DO UPDATE SET
             revision = profile_event_prize_revisions.revision + 1,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(profileId, nowMs),
    );
    profilePrizeRevisions[profileId] = state.revision + 1;
  }

  for (const [outboxId, raw] of progressUpdates) {
    if (Object.hasOwn(options.expectedRecords?.progress || {}, outboxId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_progress_outboxes",
          outboxId,
          options.expectedRecords!.progress![outboxId],
          "pending",
        ),
      );
    }
    if (raw === null) {
      if (progressOutboxSnapshot) {
        guards.push(progressOutboxSnapshotGuard(db, progressOutboxSnapshot));
      }
      mutations.push(
        db
          .prepare(
            `DELETE FROM event_progress_outboxes
             WHERE outbox_id = ? AND status = 'pending'`,
          )
          .bind(outboxId),
      );
      continue;
    }
    let record = validateEventProgressOutbox(outboxId, raw);
    const stored =
      progressOutboxSnapshot ??
      (await readEventProgressOutboxSnapshot(db, outboxId));
    guards.push(progressOutboxSnapshotGuard(db, stored));
    const previous =
      stored.recordJson !== null
        ? await parseEventProgressOutbox(
            outboxId,
            decodeJson(stored.recordJson),
          )
        : null;
    if (stored.recordJson !== null && !previous) {
      mutations.push(
        db
          .prepare(
            `INSERT INTO event_progress_outboxes (
               outbox_id, event_id, status, run_at_ms, last_queued_at_ms, record_json
             )
             SELECT outbox_id, event_id, 'dead', NULL, ?,
               json_object(
                 'deadAtMs', ?, 'originalRecord', json(record_json),
                 'reason', 'invalid-event-progress-outbox'
               )
             FROM event_progress_outboxes
             WHERE status = 'pending' AND outbox_id = ? AND record_json = ?
             ON CONFLICT (status, outbox_id) DO UPDATE SET
               event_id = excluded.event_id,
               run_at_ms = NULL,
               last_queued_at_ms = excluded.last_queued_at_ms,
               record_json = excluded.record_json`,
          )
          .bind(nowMs, nowMs, outboxId, stored.recordJson),
      );
    }
    if (
      previous &&
      (record.reason === "event-prize-announcement" ||
        record.reason === "sunday-mons-reminder") &&
      Number.isSafeInteger(record.firstQueuedAtMs)
    ) {
      record = {
        ...record,
        firstQueuedAtMs: Math.min(
          previous.outbox.firstQueuedAtMs,
          Number(record.firstQueuedAtMs),
        ),
      };
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_progress_outboxes (
             outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
             record_json
           ) VALUES (?, ?, 'pending', ?, ?, ?)
           ON CONFLICT (status, outbox_id) DO UPDATE SET
             event_id = excluded.event_id,
             status = 'pending',
             run_at_ms = excluded.run_at_ms,
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          outboxId,
          record.eventId,
          record.runAtMs,
          record.lastQueuedAtMs,
          encodeJson(record),
        ),
    );
  }

  for (const [outboxId, raw] of progressDeadUpdates) {
    if (Object.hasOwn(options.expectedRecords?.dead || {}, outboxId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_progress_outboxes",
          outboxId,
          options.expectedRecords!.dead![outboxId],
          "dead",
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'dead'",
          )
          .bind(outboxId),
      );
      continue;
    }
    if (!isRecord(raw) || !isJsonValue(raw)) {
      throw new EventD1Failure("invalid-event-progress-dead-letter");
    }
    const original = isRecord(raw.originalRecord) ? raw.originalRecord : null;
    const eventId = original ? exactKey(original.eventId) : "";
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_progress_outboxes (
             outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
             record_json
           ) VALUES (?, (
             SELECT event_id FROM event_records WHERE event_id = ?
           ), 'dead', NULL, ?, ?)
           ON CONFLICT (status, outbox_id) DO UPDATE SET
             event_id = excluded.event_id,
             status = 'dead',
             run_at_ms = NULL,
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          outboxId,
          eventId || null,
          safeInteger(raw.deadAtMs),
          encodeJson(raw),
        ),
    );
  }

  for (const [eventId, raw] of profileProjectionUpdates) {
    if (Object.hasOwn(options.expectedRecords?.profileGame || {}, eventId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_profile_game_projection_outboxes",
          eventId,
          options.expectedRecords!.profileGame![eventId],
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_profile_game_projection_outboxes WHERE event_id = ?",
          )
          .bind(eventId),
      );
      continue;
    }
    const record = validateProjectionOutbox("profile-game", eventId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_profile_game_projection_outboxes (
             event_id, request_id, status, last_queued_at_ms, record_json
           ) VALUES (?, ?, 'pending', ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             request_id = excluded.request_id,
             status = 'pending',
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          eventId,
          record.requestId,
          record.lastQueuedAtMs,
          encodeJson(record.raw),
        ),
    );
  }

  for (const [eventId, raw] of telegramProjectionUpdates) {
    if (Object.hasOwn(options.expectedRecords?.telegram || {}, eventId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_telegram_projection_outboxes",
          eventId,
          options.expectedRecords!.telegram![eventId],
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_telegram_projection_outboxes WHERE event_id = ?",
          )
          .bind(eventId),
      );
      continue;
    }
    const record = validateProjectionOutbox("telegram", eventId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_telegram_projection_outboxes (
             event_id, request_id, status, first_queued_at_ms, updated_at_ms,
             record_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             request_id = excluded.request_id,
             status = excluded.status,
             first_queued_at_ms = excluded.first_queued_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          eventId,
          record.requestId,
          record.status,
          record.firstQueuedAtMs,
          record.updatedAtMs,
          encodeJson(record.raw),
        ),
    );
  }

  for (const [eventId, update] of telegramStateUpdates) {
    const current = telegramProjectionSnapshot
      ? telegramProjectionSnapshot.current
      : await readEventTelegramProjectionState(db, eventId);
    const currentRevision = current?.revision || 0;
    const expectedRevision =
      options.expectedTelegramStateRevisions?.[eventId] ?? currentRevision;
    if (expectedRevision !== currentRevision) throw new EventD1Conflict();
    guards.push(telegramStateRevisionGuard(db, eventId, expectedRevision));
    let generation = current?.generation || 0;
    let state = current?.state || {};
    if (update.generation !== undefined) {
      const increment = isRecord(update.generation)
        ? update.generation.increment
        : undefined;
      generation =
        increment === undefined
          ? safeInteger(update.generation)
          : generation + safeInteger(increment);
    }
    if (update.state !== undefined) {
      if (update.state === null) {
        mutations.push(
          db
            .prepare(
              "DELETE FROM event_telegram_projection_state WHERE event_id = ?",
            )
            .bind(eventId),
        );
        continue;
      }
      if (!isRecord(update.state) || !isJsonValue(update.state)) {
        throw new EventD1Failure("invalid-event-telegram-projection-state");
      }
      state = cloneJson(update.state);
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_telegram_projection_state (
             event_id, generation, revision, state_json, updated_at_ms
           ) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             generation = excluded.generation,
             revision = event_telegram_projection_state.revision + 1,
             state_json = excluded.state_json,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(eventId, generation, encodeJson(state), nowMs),
    );
  }

  if (options.transition) {
    mutations.push(
      db
        .prepare(
          `DELETE FROM event_transition_intents
           WHERE transition_id = ? AND event_id = ? AND status = 'pending'`,
        )
        .bind(options.transition.transitionId, options.transition.eventId),
    );
  }
  if (mutations.length === 0) return { eventRevisions, profilePrizeRevisions };
  try {
    await db.batch([...guards, ...mutations]);
  } catch (error) {
    await rethrowEventBatchFailure(db, error, options);
  }
  return { eventRevisions, profilePrizeRevisions };
}

export async function commitEventMutations(
  db: EventD1Connection,
  changes: readonly EventMutation[],
  options: PublicEventMutationOptions,
): Promise<EventMutationResult> {
  const canRetry =
    changes.length > 0 &&
    changes.every(
      (change) => change.kind === "progress-outbox" && change.value !== null,
    ) &&
    !options.expectedRecords &&
    !options.expectedEventRevisions &&
    !options.expectedProfilePrizeRevisions &&
    !options.expectedTelegramStateRevisions &&
    !options.eventLease &&
    !options.transition;
  const attempts = canRetry ? MAX_EVENT_TRANSACTION_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await commitEventMutationsInternal(db, changes, options);
    } catch (error) {
      if (!(error instanceof EventD1Conflict) || attempt + 1 === attempts)
        throw error;
    }
  }
  throw new EventD1Conflict();
}
