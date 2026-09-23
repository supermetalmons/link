import type { EventMutation } from "../../../../runtime/eventCommands.js";
import {
  EventD1Failure,
  type DecodedEventRow,
  type EventD1Connection,
  type EventMutationOptions,
  type EventOutboxRecord,
  type EventRow,
  type ProgressOutboxSnapshot,
  type TelegramProjectionState,
} from "./types.ts";
import { decodeEventRow, exactKey } from "./validation.ts";
import {
  decodeProjectionOutboxRow,
  decodeTelegramProjectionStateRow,
  prepareEventProgressOutboxRead,
  prepareEventRecordRead,
  prepareProjectionOutboxRead,
  prepareSelectionsRead,
  prepareTelegramProjectionStateRead,
  selectionsFromRows,
} from "./reads.ts";

const MUTATION_SNAPSHOT_READ_BATCH_SIZE = 40;

export type EventMutationSnapshots = {
  events: ReadonlyMap<string, DecodedEventRow | null>;
  selections: ReadonlyMap<string, Record<string, string>>;
  progress: ReadonlyMap<string, ProgressOutboxSnapshot>;
  profileGame: ReadonlyMap<string, EventOutboxRecord | null>;
  telegram: ReadonlyMap<string, TelegramProjectionState | null>;
};

export function requiredMutationSnapshot<T>(
  snapshots: ReadonlyMap<string, T>,
  key: string,
): T {
  const value = snapshots.get(key);
  if (value === undefined)
    throw new EventD1Failure("event-mutation-snapshot-missing");
  return value;
}

export function validateEventMutationKeys(change: EventMutation): void {
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
}

export async function readEventMutationSnapshots(
  db: EventD1Connection,
  changes: readonly EventMutation[],
  options: EventMutationOptions,
): Promise<EventMutationSnapshots | null> {
  if (changes.some((change) => change.kind === "progress-dispatched"))
    return null;

  const eventIds = new Set<string>();
  const selectionIds = new Set<string>();
  const progressUpdates = new Map<string, unknown>();
  const profileGameIds = new Set<string>();
  const initializedProfileGameIds = new Set<string>();
  const telegramIds = new Set<string>();
  for (const change of changes) {
    validateEventMutationKeys(change);
    switch (change.kind) {
      case "event":
      case "event-field":
      case "event-participant":
      case "event-disqualification":
      case "event-round":
      case "event-match-status":
        eventIds.add(change.eventId);
        break;
      case "prize-selections":
      case "prize-selection":
        eventIds.add(change.eventId);
        selectionIds.add(change.eventId);
        break;
      case "progress-outbox":
        progressUpdates.set(change.outboxId, change.value);
        break;
      case "profile-game-outbox":
        initializedProfileGameIds.add(change.eventId);
        break;
      case "profile-game-outbox-field":
      case "profile-game-outbox-cleanup":
        if (!initializedProfileGameIds.has(change.eventId))
          profileGameIds.add(change.eventId);
        initializedProfileGameIds.add(change.eventId);
        break;
      case "telegram-state":
      case "telegram-generation":
        telegramIds.add(change.eventId);
        break;
    }
  }
  if (options.transition) {
    if (
      !exactKey(options.transition.eventId) ||
      !exactKey(options.transition.transitionId)
    )
      throw new EventD1Failure("invalid-event-transition");
    eventIds.add(options.transition.eventId);
  }
  if (options.eventSnapshot) {
    eventIds.delete(options.eventSnapshot.eventId);
    selectionIds.delete(options.eventSnapshot.eventId);
  }

  const events = new Map<string, DecodedEventRow | null>();
  const selections = new Map<string, Record<string, string>>();
  const progress = new Map<string, ProgressOutboxSnapshot>();
  const profileGame = new Map<string, EventOutboxRecord | null>();
  const telegram = new Map<string, TelegramProjectionState | null>();
  const reads: Array<{
    statement: D1PreparedStatement;
    accept: (rows: unknown[]) => void;
  }> = [];
  for (const eventId of eventIds) {
    reads.push({
      statement: prepareEventRecordRead(db, eventId),
      accept(rows) {
        const row = rows[0] as EventRow | undefined;
        events.set(eventId, row ? decodeEventRow(row) : null);
      },
    });
  }
  for (const eventId of selectionIds) {
    reads.push({
      statement: prepareSelectionsRead(db, eventId),
      accept(rows) {
        selections.set(
          eventId,
          selectionsFromRows(
            eventId,
            rows as Array<{ prize_id: string; profile_id: string }>,
          ),
        );
      },
    });
  }
  for (const [outboxId, value] of progressUpdates) {
    if (options.progressOutboxSnapshot) {
      progress.set(outboxId, options.progressOutboxSnapshot);
    } else if (value !== null) {
      reads.push({
        statement: prepareEventProgressOutboxRead(db, outboxId),
        accept(rows) {
          const row = rows[0] as { record_json: string } | undefined;
          progress.set(outboxId, {
            outboxId,
            recordJson: row ? row.record_json : null,
          });
        },
      });
    }
  }
  for (const eventId of profileGameIds) {
    reads.push({
      statement: prepareProjectionOutboxRead(
        db,
        "event_profile_game_projection_outboxes",
        eventId,
      ),
      accept(rows) {
        profileGame.set(
          eventId,
          decodeProjectionOutboxRow(
            rows[0] as { record_json: string } | undefined,
          ),
        );
      },
    });
  }
  for (const eventId of telegramIds) {
    if (options.telegramProjectionSnapshot) {
      telegram.set(eventId, options.telegramProjectionSnapshot.current);
    } else {
      reads.push({
        statement: prepareTelegramProjectionStateRead(db, eventId),
        accept(rows) {
          telegram.set(
            eventId,
            decodeTelegramProjectionStateRow(
              rows[0] as
                | { generation: number; revision: number; state_json: string }
                | undefined,
            ),
          );
        },
      });
    }
  }
  for (
    let offset = 0;
    offset < reads.length;
    offset += MUTATION_SNAPSHOT_READ_BATCH_SIZE
  ) {
    const batch = reads.slice(
      offset,
      offset + MUTATION_SNAPSHOT_READ_BATCH_SIZE,
    );
    const results = await db.batch(batch.map(({ statement }) => statement));
    for (const [index, read] of batch.entries()) {
      const result = results[index];
      if (!result) throw new EventD1Failure();
      read.accept(result.results);
    }
  }
  return { events, selections, progress, profileGame, telegram };
}
