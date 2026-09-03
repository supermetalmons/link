import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isEventPrizeId } from "@mons/shared/event-prizes";

type JsonRecord = Record<string, unknown>;
type MigrationPhase = "preview" | "stage" | "final";

type EventMigrationSnapshot = {
  eventProfileGameProjectionOutboxes: JsonRecord;
  eventProgressOutbox: JsonRecord;
  eventProgressOutboxDead: JsonRecord;
  eventPrizeSelections: Record<string, Record<string, string>>;
  eventTelegramProjectionGenerations: Record<string, number>;
  eventTelegramProjectionOutboxes: JsonRecord;
  eventTelegramProjections: JsonRecord;
  events: Record<string, JsonRecord>;
  profileEventPrizes: Record<string, Record<string, JsonRecord>>;
};

type SourceInspection = {
  activeEventLeases: number;
  activeProfileGameProjectionLeases: number;
  activeTelegramProjectionLeases: number;
  eventSyncThrottles: number;
};

type EventStorageControl = {
  freezeGeneration: number;
  previousStorageMode: "firebase" | "d1" | null;
  storageMode: "firebase" | "frozen" | "d1";
  verifiedImportGeneration: number | null;
};

type CompletedWithdrawalPrizeIdentity = {
  eventId: string;
  prizeId: string;
};

type MigrationOptions = {
  phase: MigrationPhase;
  project: string;
};

type MigrationDependencies = {
  eventWriteAdmissions(): number;
  importSql(path: string): void;
  log(message: string): void;
  now(): number;
  persistArtifacts(input: {
    exportedAtMs: number;
    phase: MigrationPhase;
    snapshot: EventMigrationSnapshot;
    sql: string;
  }): string;
  markFinalVerified(input: {
    freezeGeneration: number;
    sourceDigest: string;
    verifiedAtMs: number;
  }): void;
  readEventControl(): EventStorageControl;
  readCompletedWithdrawalPrizeIdentities(): CompletedWithdrawalPrizeIdentity[];
  readImportedSnapshot(): EventMigrationSnapshot;
  readProfileControl(): string;
  readSourceInspection(project: string, nowMs: number): SourceInspection;
  readSource(
    project: string,
    nowMs: number,
  ): {
    inspection: SourceInspection;
    snapshot: EventMigrationSnapshot;
  };
  readWithdrawalPendingCount(): number;
  readWithdrawalControl(): EventStorageControl;
};

const EVENT_DATABASE = "mons-link-events";
const PROFILE_DATABASE = "mons-link-profiles";
const WITHDRAWAL_DATABASE = "mons-link-event-prize-withdrawals";
const CANONICAL_FIREBASE_PROJECT = "mons-link";
const CANONICAL_FIREBASE_INSTANCE = "mons-link-default-rtdb";
const D1_MAX_SQL_STATEMENT_BYTES = 100_000;
const CONFIG_PATH = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV_PATH = "cloud/workers/api/release.env";
const FIREBASE_SOURCE_OVERRIDE_KEYS = new Set([
  "FIREBASE_CONFIG",
  "FIREBASE_DATABASE_EMULATOR_HOST",
  "FIREBASE_REALTIME_URL",
]);
const VALID_EVENT_STATUSES = new Set([
  "active",
  "dismissed",
  "ended",
  "scheduled",
]);

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function validKey(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return (
    bytes > 0 &&
    bytes <= 768 &&
    value.trim() === value &&
    !Array.from(value).some((character) => ".#$/[]".includes(character)) &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) || 0;
      return code > 0x1f && code !== 0x7f;
    })
  );
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalize(object[key])]),
  );
}

function snapshotDigest(snapshot: EventMigrationSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

function eventProgressOutboxId(eventId: string, sourceKey: string): string {
  return `ep_${createHash("sha256")
    .update(`${eventId}\n${sourceKey}`)
    .digest("hex")}`;
}

function objectRoot(value: unknown, message: string): JsonRecord {
  if (value === null || value === undefined) return {};
  const source = record(value);
  if (!source) throw new Error(message);
  return source;
}

function normalizeRtdbMap(value: unknown): unknown {
  if (value === null || value === undefined) return {};
  if (!Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null),
  );
}

function normalizeEvents(value: unknown): Record<string, JsonRecord> {
  const source = objectRoot(value, "invalid events export");
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([eventId, raw]) => {
        const event = record(raw);
        const normalizedEvent: JsonRecord | null = event
          ? {
              ...event,
              participants: normalizeRtdbMap(event.participants),
              rounds: normalizeRtdbMap(event.rounds),
            }
          : null;
        if (normalizedEvent && normalizedEvent.prizeAssignments == null) {
          delete normalizedEvent.prizeAssignments;
        } else if (normalizedEvent) {
          normalizedEvent.prizeAssignments = normalizeRtdbMap(
            normalizedEvent.prizeAssignments,
          );
        }
        const participants = normalizedEvent
          ? record(normalizedEvent.participants)
          : null;
        const rounds = normalizedEvent ? record(normalizedEvent.rounds) : null;
        if (
          !validKey(eventId) ||
          !normalizedEvent ||
          normalizedEvent.eventId !== eventId ||
          !VALID_EVENT_STATUSES.has(String(normalizedEvent.status)) ||
          !safeInteger(normalizedEvent.startAtMs) ||
          !safeInteger(normalizedEvent.updatedAtMs) ||
          !participants ||
          Object.keys(participants).length > 32 ||
          Object.entries(participants).some(
            ([profileId, participant]) =>
              !validKey(profileId) || !record(participant),
          ) ||
          !rounds ||
          Object.values(rounds).some((round) => !record(round)) ||
          (normalizedEvent.prizeAssignments !== undefined &&
            !record(normalizedEvent.prizeAssignments))
        ) {
          throw new Error("invalid event record");
        }
        return [eventId, normalizedEvent];
      }),
  );
}

function normalizePrizeSelections(
  value: unknown,
  events: Record<string, JsonRecord>,
): Record<string, Record<string, string>> {
  const source = objectRoot(value, "invalid event prize selections export");
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([eventId, raw]) => {
        const selections = record(raw);
        if (!validKey(eventId) || !events[eventId] || !selections) {
          throw new Error("invalid event prize selections record");
        }
        return [
          eventId,
          Object.fromEntries(
            Object.entries(selections)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([profileId, prizeId]) => {
                if (
                  !validKey(profileId) ||
                  typeof prizeId !== "string" ||
                  !validKey(prizeId) ||
                  !isEventPrizeId(eventId, prizeId)
                ) {
                  throw new Error("invalid event prize selection");
                }
                return [profileId, prizeId];
              }),
          ),
        ];
      }),
  );
}

function normalizeProfilePrizes(
  value: unknown,
  events: Record<string, JsonRecord>,
): Record<string, Record<string, JsonRecord>> {
  const source = objectRoot(value, "invalid profile event prizes export");
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([profileId, raw]) => {
        const assignments = record(raw);
        if (!validKey(profileId) || !assignments) {
          throw new Error("invalid profile event prize owner");
        }
        return [
          profileId,
          Object.fromEntries(
            Object.entries(assignments)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([eventId, assignmentRaw]) => {
                const assignment = record(assignmentRaw);
                if (
                  !validKey(eventId) ||
                  !events[eventId] ||
                  !assignment ||
                  assignment.eventId !== eventId ||
                  assignment.profileId !== profileId ||
                  !safeInteger(assignment.assignedAtMs) ||
                  (assignment.place !== 1 &&
                    assignment.place !== 2 &&
                    assignment.place !== 3) ||
                  typeof assignment.prizeId !== "string" ||
                  !validKey(assignment.prizeId) ||
                  !isEventPrizeId(eventId, assignment.prizeId)
                ) {
                  throw new Error("invalid profile event prize assignment");
                }
                return [eventId, assignment];
              }),
          ),
        ];
      }),
  );
}

function normalizeProgressOutbox(
  value: unknown,
  events: Record<string, JsonRecord>,
  dead: boolean,
): JsonRecord {
  const source = objectRoot(
    value,
    dead
      ? "invalid event progress dead export"
      : "invalid event progress outbox export",
  );
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([outboxId, raw]) => {
        const wrapper = record(raw);
        if (dead) {
          if (
            !validKey(outboxId) ||
            !wrapper ||
            !safeInteger(wrapper.deadAtMs)
          ) {
            throw new Error("invalid event progress record");
          }
          return [outboxId, wrapper];
        }
        const progress = wrapper;
        const normalizedProgress: JsonRecord | null = progress
          ? { ...progress, runAtMs: progress.runAtMs ?? null }
          : null;
        const eventId = normalizedProgress?.eventId;
        const sourceKey = normalizedProgress?.sourceKey;
        if (
          !validKey(outboxId) ||
          !wrapper ||
          !normalizedProgress ||
          normalizedProgress.schemaVersion !== 1 ||
          typeof eventId !== "string" ||
          !validKey(eventId) ||
          !events[eventId] ||
          typeof sourceKey !== "string" ||
          !sourceKey.trim() ||
          outboxId !== eventProgressOutboxId(eventId, sourceKey) ||
          typeof normalizedProgress.reason !== "string" ||
          !normalizedProgress.reason.trim() ||
          (normalizedProgress.runAtMs !== null &&
            !safeInteger(normalizedProgress.runAtMs)) ||
          !safeInteger(normalizedProgress.firstQueuedAtMs) ||
          !safeInteger(normalizedProgress.lastQueuedAtMs)
        ) {
          throw new Error("invalid event progress record");
        }
        return [outboxId, normalizedProgress];
      }),
  );
}

function normalizeProfileGameOutboxes(
  value: unknown,
  events: Record<string, JsonRecord>,
): JsonRecord {
  const source = objectRoot(
    value,
    "invalid event profile-game projection export",
  );
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([eventId, raw]) => {
        const outbox = record(raw);
        const cleanup =
          outbox?.cleanupOwnerProfileIds === undefined
            ? {}
            : record(outbox.cleanupOwnerProfileIds);
        if (
          !validKey(eventId) ||
          !events[eventId] ||
          !outbox ||
          outbox.schemaVersion !== 1 ||
          outbox.status !== "pending" ||
          typeof outbox.requestId !== "string" ||
          !validKey(outbox.requestId) ||
          !safeInteger(outbox.lastQueuedAtMs) ||
          !cleanup ||
          Object.entries(cleanup).some(
            ([profileId, included]) =>
              !validKey(profileId) || included !== true,
          )
        ) {
          throw new Error("invalid event profile-game projection record");
        }
        return [eventId, outbox];
      }),
  );
}

function normalizeTelegramOutboxes(
  value: unknown,
  events: Record<string, JsonRecord>,
): JsonRecord {
  const source = objectRoot(
    value,
    "invalid event Telegram projection outbox export",
  );
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([eventId, raw]) => {
        const outbox = record(raw);
        const status = outbox?.status;
        if (
          status === "dead" &&
          validKey(eventId) &&
          events[eventId] &&
          outbox &&
          safeInteger(outbox.deadAtMs)
        ) {
          return [eventId, outbox];
        }
        if (
          !validKey(eventId) ||
          !events[eventId] ||
          !outbox ||
          status !== "pending" ||
          outbox.schemaVersion !== 1 ||
          typeof outbox.requestId !== "string" ||
          !validKey(outbox.requestId) ||
          !safeInteger(outbox.firstQueuedAtMs) ||
          !safeInteger(outbox.updatedAtMs) ||
          outbox.updatedAtMs < outbox.firstQueuedAtMs
        ) {
          throw new Error("invalid event Telegram projection outbox record");
        }
        return [eventId, outbox];
      }),
  );
}

function normalizeTelegramProjectionState(
  projectionsValue: unknown,
  generationsValue: unknown,
  events: Record<string, JsonRecord>,
): {
  generations: Record<string, number>;
  projections: JsonRecord;
} {
  const projections = objectRoot(
    projectionsValue,
    "invalid event Telegram projection state export",
  );
  const generations = objectRoot(
    generationsValue,
    "invalid event Telegram projection generations export",
  );
  for (const [eventId, state] of Object.entries(projections)) {
    if (!validKey(eventId) || !events[eventId] || !record(state)) {
      throw new Error("invalid event Telegram projection state");
    }
  }
  for (const [eventId, generation] of Object.entries(generations)) {
    if (!validKey(eventId) || !events[eventId] || !safeInteger(generation)) {
      throw new Error("invalid event Telegram projection generation");
    }
  }
  return {
    projections: Object.fromEntries(
      Object.entries(projections).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    generations: Object.fromEntries(
      Object.entries(generations)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([eventId, generation]) => [eventId, Number(generation)]),
    ),
  };
}

function normalizeSnapshot(input: {
  eventProfileGameProjectionOutboxes: unknown;
  eventProgressOutbox: unknown;
  eventProgressOutboxDead: unknown;
  eventPrizeSelections: unknown;
  eventTelegramProjectionGenerations: unknown;
  eventTelegramProjectionOutboxes: unknown;
  eventTelegramProjections: unknown;
  events: unknown;
  profileEventPrizes: unknown;
}): EventMigrationSnapshot {
  const events = normalizeEvents(input.events);
  const telegramState = normalizeTelegramProjectionState(
    input.eventTelegramProjections,
    input.eventTelegramProjectionGenerations,
    events,
  );
  const eventProgressOutbox = normalizeProgressOutbox(
    input.eventProgressOutbox,
    events,
    false,
  );
  const eventProgressOutboxDead = normalizeProgressOutbox(
    input.eventProgressOutboxDead,
    events,
    true,
  );
  return {
    events,
    eventPrizeSelections: normalizePrizeSelections(
      input.eventPrizeSelections,
      events,
    ),
    profileEventPrizes: normalizeProfilePrizes(
      input.profileEventPrizes,
      events,
    ),
    eventProgressOutbox,
    eventProgressOutboxDead,
    eventProfileGameProjectionOutboxes: normalizeProfileGameOutboxes(
      input.eventProfileGameProjectionOutboxes,
      events,
    ),
    eventTelegramProjectionOutboxes: normalizeTelegramOutboxes(
      input.eventTelegramProjectionOutboxes,
      events,
    ),
    eventTelegramProjections: telegramState.projections,
    eventTelegramProjectionGenerations: telegramState.generations,
  };
}

function summarize(snapshot: EventMigrationSnapshot) {
  const events = Object.keys(snapshot.events).length;
  const selections = Object.values(snapshot.eventPrizeSelections).reduce(
    (total, value) => total + Object.keys(value).length,
    0,
  );
  const assignedPrizes = Object.values(snapshot.profileEventPrizes).reduce(
    (total, value) => total + Object.keys(value).length,
    0,
  );
  const supportRecords =
    Object.keys(snapshot.eventProgressOutbox).length +
    Object.keys(snapshot.eventProgressOutboxDead).length +
    Object.keys(snapshot.eventProfileGameProjectionOutboxes).length +
    Object.keys(snapshot.eventTelegramProjectionOutboxes).length +
    new Set([
      ...Object.keys(snapshot.eventTelegramProjections),
      ...Object.keys(snapshot.eventTelegramProjectionGenerations),
    ]).size;
  return {
    events,
    selections,
    assignedPrizes,
    supportRecords,
    digest: snapshotDigest(snapshot),
  };
}

function textHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function sqlText(value: string): string {
  return `CAST(X'${textHex(value)}' AS TEXT)`;
}

function buildImportSql(
  snapshot: EventMigrationSnapshot,
  exportedAtMs: number,
  phase: Exclude<MigrationPhase, "preview">,
  expectedFreezeGeneration: number | null = null,
): string {
  if (
    phase === "final" &&
    (!safeInteger(expectedFreezeGeneration) || expectedFreezeGeneration < 1)
  ) {
    throw new Error("final event import requires a freeze generation");
  }
  const requiredMode = phase === "stage" ? "firebase" : "frozen";
  const requiredPrevious = phase === "stage" ? "NULL" : "'firebase'";
  const generationGuard =
    phase === "final"
      ? `\n         AND freeze_generation = ${expectedFreezeGeneration}`
      : "";
  const statements = [
    `INSERT INTO event_transaction_guards (singleton)
     SELECT 0 WHERE NOT EXISTS (
       SELECT 1 FROM event_runtime_control
       WHERE singleton = 1 AND storage_mode = '${requiredMode}'
         AND previous_storage_mode IS ${requiredPrevious}${generationGuard}
         AND NOT EXISTS (SELECT 1 FROM event_write_admissions)
     );`,
    "UPDATE event_records SET pending_transition_id = NULL WHERE pending_transition_id IS NOT NULL;",
    "DELETE FROM event_transition_intents;",
    "DELETE FROM event_leases;",
    "DELETE FROM event_sync_throttles;",
    "DELETE FROM event_prize_selections;",
    "DELETE FROM profile_event_prizes;",
    "DELETE FROM profile_event_prize_revisions;",
    "DELETE FROM event_progress_outboxes;",
    "DELETE FROM event_profile_game_projection_outboxes;",
    "DELETE FROM event_telegram_projection_outboxes;",
    "DELETE FROM event_telegram_projection_state;",
    "DELETE FROM event_records;",
  ];
  for (const [eventId, event] of Object.entries(snapshot.events)) {
    statements.push(
      `INSERT INTO event_records (event_id, status, start_at_ms, updated_at_ms, revision, pending_transition_id, record_json) VALUES (${sqlText(eventId)}, ${sqlText(String(event.status))}, ${Number(event.startAtMs)}, ${Number(event.updatedAtMs)}, 1, NULL, ${sqlText(JSON.stringify(event))});`,
    );
  }
  for (const [eventId, selections] of Object.entries(
    snapshot.eventPrizeSelections,
  )) {
    for (const [profileId, prizeId] of Object.entries(selections)) {
      statements.push(
        `INSERT INTO event_prize_selections (event_id, profile_id, prize_id, updated_at_ms) VALUES (${sqlText(eventId)}, ${sqlText(profileId)}, ${sqlText(prizeId)}, ${exportedAtMs});`,
      );
    }
  }
  for (const [profileId, assignments] of Object.entries(
    snapshot.profileEventPrizes,
  )) {
    statements.push(
      `INSERT INTO profile_event_prize_revisions (profile_id, revision, updated_at_ms) VALUES (${sqlText(profileId)}, 1, ${exportedAtMs});`,
    );
    for (const [eventId, assignment] of Object.entries(assignments)) {
      statements.push(
        `INSERT INTO profile_event_prizes (profile_id, event_id, assignment_json, updated_at_ms) VALUES (${sqlText(profileId)}, ${sqlText(eventId)}, ${sqlText(JSON.stringify(assignment))}, ${exportedAtMs});`,
      );
    }
  }
  for (const [status, records] of [
    ["pending", snapshot.eventProgressOutbox],
    ["dead", snapshot.eventProgressOutboxDead],
  ] as const) {
    for (const [outboxId, raw] of Object.entries(records)) {
      const wrapper = record(raw) || {};
      const dead = status === "dead";
      const progress = dead ? record(wrapper.originalRecord) || {} : wrapper;
      const deadEventId =
        dead &&
        typeof progress.eventId === "string" &&
        validKey(progress.eventId) &&
        snapshot.events[progress.eventId]
          ? sqlText(progress.eventId)
          : "NULL";
      statements.push(
        `INSERT INTO event_progress_outboxes (outbox_id, event_id, status, run_at_ms, last_queued_at_ms, record_json) VALUES (${sqlText(outboxId)}, ${dead ? deadEventId : sqlText(String(progress.eventId))}, '${status}', ${dead || progress.runAtMs === null ? "NULL" : Number(progress.runAtMs)}, ${Number(dead ? wrapper.deadAtMs : progress.lastQueuedAtMs)}, ${sqlText(JSON.stringify(raw))});`,
      );
    }
  }
  for (const [eventId, raw] of Object.entries(
    snapshot.eventProfileGameProjectionOutboxes,
  )) {
    const outbox = record(raw) || {};
    statements.push(
      `INSERT INTO event_profile_game_projection_outboxes (event_id, request_id, status, last_queued_at_ms, record_json) VALUES (${sqlText(eventId)}, ${sqlText(String(outbox.requestId))}, ${sqlText(String(outbox.status))}, ${Number(outbox.lastQueuedAtMs)}, ${sqlText(JSON.stringify(outbox))});`,
    );
  }
  for (const [eventId, raw] of Object.entries(
    snapshot.eventTelegramProjectionOutboxes,
  )) {
    const outbox = record(raw) || {};
    const status = String(outbox.status);
    const dead = status === "dead";
    const requestId =
      typeof outbox.requestId === "string" && validKey(outbox.requestId)
        ? outbox.requestId
        : eventId;
    const firstQueuedAtMs = dead
      ? Number(outbox.deadAtMs)
      : Number(outbox.firstQueuedAtMs);
    const updatedAtMs = dead
      ? Number(outbox.deadAtMs)
      : Number(outbox.updatedAtMs);
    statements.push(
      `INSERT INTO event_telegram_projection_outboxes (event_id, request_id, status, first_queued_at_ms, updated_at_ms, record_json) VALUES (${sqlText(eventId)}, ${sqlText(requestId)}, ${sqlText(status)}, ${firstQueuedAtMs}, ${updatedAtMs}, ${sqlText(JSON.stringify(outbox))});`,
    );
  }
  const stateEventIds = Array.from(
    new Set([
      ...Object.keys(snapshot.eventTelegramProjections),
      ...Object.keys(snapshot.eventTelegramProjectionGenerations),
    ]),
  ).sort();
  for (const eventId of stateEventIds) {
    const state = record(snapshot.eventTelegramProjections[eventId]) || {};
    const generation =
      snapshot.eventTelegramProjectionGenerations[eventId] || 0;
    statements.push(
      `INSERT INTO event_telegram_projection_state (event_id, generation, state_json, updated_at_ms) VALUES (${sqlText(eventId)}, ${generation}, ${sqlText(JSON.stringify(state))}, ${exportedAtMs});`,
    );
  }
  const summary = summarize(snapshot);
  statements.push(
    `UPDATE event_runtime_control SET source_digest = ${sqlText(summary.digest)}, source_event_count = ${summary.events}, source_selection_count = ${summary.selections}, source_assignment_count = ${summary.assignedPrizes}, source_exported_at_ms = ${exportedAtMs}, verified_import_generation = NULL, updated_at_ms = ${exportedAtMs} WHERE singleton = 1 AND storage_mode = '${requiredMode}' AND previous_storage_mode IS ${requiredPrevious}${phase === "final" ? ` AND freeze_generation = ${expectedFreezeGeneration}` : ""};`,
  );
  if (
    statements.some(
      (statement) =>
        Buffer.byteLength(statement, "utf8") > D1_MAX_SQL_STATEMENT_BYTES,
    )
  ) {
    throw new Error("event import SQL statement exceeds D1 limit");
  }
  return `${statements.join("\n")}\n`;
}

function assertMigrationSource(
  options: MigrationOptions,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (options.phase === "preview") return;
  if (options.project !== CANONICAL_FIREBASE_PROJECT) {
    throw new Error("mutating event migration requires canonical source");
  }
  if (
    Object.keys(environment).some(
      (key) =>
        FIREBASE_SOURCE_OVERRIDE_KEYS.has(key) ||
        /^FIREBASE_(?:DATABASE|REALTIME|RTDB)_/.test(key),
    )
  ) {
    throw new Error("event migration source override is not allowed");
  }
}

function parseArgs(argv: string[]): MigrationOptions {
  let phase: MigrationPhase = "preview";
  let phaseSet = false;
  let project = "mons-link";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--preview" || arg === "--stage" || arg === "--final") {
      if (phaseSet) throw new Error("choose one event migration phase");
      phaseSet = true;
      phase = arg.slice(2) as MigrationPhase;
      continue;
    }
    if (arg === "--project") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("missing project");
      project = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  const options = { phase, project };
  if (phase !== "preview" && project !== CANONICAL_FIREBASE_PROJECT) {
    throw new Error("mutating event migration requires canonical source");
  }
  return options;
}

function sameControl(
  control: EventStorageControl,
  storageMode: EventStorageControl["storageMode"],
  previousStorageMode: EventStorageControl["previousStorageMode"],
): boolean {
  return (
    control.storageMode === storageMode &&
    control.previousStorageMode === previousStorageMode
  );
}

function assertImportAllowed(
  phase: Exclude<MigrationPhase, "preview">,
  input: {
    eventControl: EventStorageControl;
    eventWriteAdmissions: number;
    inspection: SourceInspection;
    profileControl: string;
    expectedFreezeGeneration: number | null;
    withdrawalPendingCount: number;
    withdrawalControl: EventStorageControl;
  },
): void {
  if (phase === "stage") {
    if (!sameControl(input.eventControl, "firebase", null)) {
      throw new Error("staged event import requires Firebase storage mode");
    }
    return;
  }
  if (!sameControl(input.eventControl, "frozen", "firebase")) {
    throw new Error("final event import requires frozen Firebase storage");
  }
  if (
    !safeInteger(input.expectedFreezeGeneration) ||
    input.expectedFreezeGeneration < 1 ||
    input.eventControl.freezeGeneration !== input.expectedFreezeGeneration
  ) {
    throw new Error("final event freeze generation changed");
  }
  if (input.eventWriteAdmissions !== 0) {
    throw new Error("final event export has write admissions");
  }
  if (input.profileControl !== "frozen") {
    throw new Error("final event import requires frozen profile storage");
  }
  if (!sameControl(input.withdrawalControl, "frozen", "d1")) {
    throw new Error("final event import requires frozen withdrawal storage");
  }
  if (
    input.inspection.activeEventLeases !== 0 ||
    input.inspection.activeProfileGameProjectionLeases !== 0 ||
    input.inspection.activeTelegramProjectionLeases !== 0 ||
    input.withdrawalPendingCount !== 0
  ) {
    throw new Error("final event export is not quiescent");
  }
}

function assertNoCompletedWithdrawalAssignments(
  snapshot: EventMigrationSnapshot,
  identities: readonly CompletedWithdrawalPrizeIdentity[],
): void {
  const completedByEvent = new Map<string, Set<string>>();
  for (const identity of identities) {
    if (!validKey(identity.eventId) || !validKey(identity.prizeId)) {
      throw new Error("invalid completed withdrawal identity");
    }
    const prizes = completedByEvent.get(identity.eventId) || new Set<string>();
    prizes.add(identity.prizeId);
    completedByEvent.set(identity.eventId, prizes);
  }
  for (const assignments of Object.values(snapshot.profileEventPrizes)) {
    for (const assignment of Object.values(assignments)) {
      const eventId = String(assignment.eventId);
      const prizeId = String(assignment.prizeId);
      if (completedByEvent.get(eventId)?.has(prizeId)) {
        throw new Error(
          "final event export contains a completed withdrawal assignment",
        );
      }
    }
  }
}

function verifyImportedSnapshot(
  expected: EventMigrationSnapshot,
  actual: EventMigrationSnapshot,
): ReturnType<typeof summarize> {
  const expectedSummary = summarize(expected);
  const actualSummary = summarize(actual);
  if (
    actualSummary.digest !== expectedSummary.digest ||
    actualSummary.events !== expectedSummary.events ||
    actualSummary.selections !== expectedSummary.selections ||
    actualSummary.assignedPrizes !== expectedSummary.assignedPrizes ||
    actualSummary.supportRecords !== expectedSummary.supportRecords
  ) {
    throw new Error("event D1 verification mismatch");
  }
  return actualSummary;
}

function migrateEvents(
  options: MigrationOptions,
  dependencies: MigrationDependencies,
): void {
  assertMigrationSource(options);
  const exportedAtMs = dependencies.now();
  let finalFreezeGeneration: number | null = null;
  const assertCurrentImportAllowed = (inspection: SourceInspection) => {
    const eventControl = dependencies.readEventControl();
    if (options.phase === "stage") {
      assertImportAllowed("stage", {
        eventControl,
        eventWriteAdmissions: 0,
        inspection,
        profileControl: "",
        expectedFreezeGeneration: null,
        withdrawalPendingCount: 0,
        withdrawalControl: {
          storageMode: "d1",
          previousStorageMode: null,
          freezeGeneration: 0,
          verifiedImportGeneration: null,
        },
      });
      return;
    }
    if (options.phase === "final") {
      assertImportAllowed("final", {
        eventWriteAdmissions: dependencies.eventWriteAdmissions(),
        eventControl,
        inspection,
        profileControl: dependencies.readProfileControl(),
        expectedFreezeGeneration: finalFreezeGeneration,
        withdrawalPendingCount: dependencies.readWithdrawalPendingCount(),
        withdrawalControl: dependencies.readWithdrawalControl(),
      });
    }
  };
  if (options.phase === "stage") {
    assertCurrentImportAllowed({
      activeEventLeases: 0,
      activeProfileGameProjectionLeases: 0,
      activeTelegramProjectionLeases: 0,
      eventSyncThrottles: 0,
    });
  } else if (options.phase === "final") {
    const eventControl = dependencies.readEventControl();
    finalFreezeGeneration = eventControl.freezeGeneration;
    const profileControl = dependencies.readProfileControl();
    const withdrawalControl = dependencies.readWithdrawalControl();
    const withdrawalPendingCount = dependencies.readWithdrawalPendingCount();
    const inspection = dependencies.readSourceInspection(
      options.project,
      exportedAtMs,
    );
    assertImportAllowed("final", {
      eventWriteAdmissions: dependencies.eventWriteAdmissions(),
      eventControl,
      inspection,
      profileControl,
      expectedFreezeGeneration: finalFreezeGeneration,
      withdrawalPendingCount,
      withdrawalControl,
    });
  }
  const source = dependencies.readSource(options.project, exportedAtMs);
  if (options.phase === "final") {
    assertNoCompletedWithdrawalAssignments(
      source.snapshot,
      dependencies.readCompletedWithdrawalPrizeIdentities(),
    );
  }
  const summary = summarize(source.snapshot);
  const sql = buildImportSql(
    source.snapshot,
    exportedAtMs,
    options.phase === "final" ? "final" : "stage",
    finalFreezeGeneration,
  );
  const runDirectory = dependencies.persistArtifacts({
    exportedAtMs,
    phase: options.phase,
    snapshot: source.snapshot,
    sql,
  });
  dependencies.log(
    JSON.stringify({
      phase: options.phase,
      ...summary,
      inspection: source.inspection,
      artifacts: runDirectory,
    }),
  );
  if (options.phase === "preview") return;
  assertCurrentImportAllowed(source.inspection);
  dependencies.importSql(resolve(runDirectory, "import.sql"));
  const imported = verifyImportedSnapshot(
    source.snapshot,
    dependencies.readImportedSnapshot(),
  );
  if (options.phase === "final") {
    const control = dependencies.readEventControl();
    if (
      !sameControl(control, "frozen", "firebase") ||
      control.freezeGeneration !== finalFreezeGeneration
    ) {
      throw new Error("final event verification lost frozen storage");
    }
    dependencies.markFinalVerified({
      freezeGeneration: finalFreezeGeneration,
      sourceDigest: imported.digest,
      verifiedAtMs: exportedAtMs,
    });
  }
  dependencies.log(
    JSON.stringify({ phase: options.phase, verified: true, ...imported }),
  );
}

function run(
  executable: string,
  args: string[],
  { maxBuffer = 64 * 1024 * 1024 }: { maxBuffer?: number } = {},
): string {
  const result = spawnSync(executable, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${executable} failed`);
  }
  return String(result.stdout);
}

function firebaseGet(project: string, path: string): unknown {
  return JSON.parse(
    run(
      resolve("node_modules/.bin/firebase"),
      firebaseDatabaseGetArgs(project, path),
    ),
  ) as unknown;
}

function firebaseDatabaseGetArgs(project: string, path: string): string[] {
  const args = ["database:get", path, "--project", project];
  if (project === CANONICAL_FIREBASE_PROJECT) {
    args.push("--instance", CANONICAL_FIREBASE_INSTANCE);
  }
  return args;
}

function countActiveLeases(value: unknown, nowMs: number): number {
  return Object.values(objectRoot(value, "invalid event lease export")).filter(
    (raw) => {
      const lease = record(raw);
      if (!lease || !safeInteger(lease.expiresAtMs)) {
        throw new Error("invalid event lease record");
      }
      return Number(lease.expiresAtMs) > nowMs;
    },
  ).length;
}

function readRemoteInspection(
  project: string,
  nowMs: number,
): SourceInspection {
  const eventLocks = firebaseGet(project, "/eventLocks");
  const eventTelegramProjectionLocks = firebaseGet(
    project,
    "/eventTelegramProjectionLocks",
  );
  const eventProfileGameProjectionLocks = firebaseGet(
    project,
    "/profileGameProjectionLocks/event",
  );
  const eventSyncThrottles = firebaseGet(project, "/eventSyncThrottles");
  return {
    activeEventLeases: countActiveLeases(eventLocks, nowMs),
    activeTelegramProjectionLeases: countActiveLeases(
      eventTelegramProjectionLocks,
      nowMs,
    ),
    activeProfileGameProjectionLeases: countActiveLeases(
      eventProfileGameProjectionLocks,
      nowMs,
    ),
    eventSyncThrottles: Object.keys(
      objectRoot(eventSyncThrottles, "invalid event throttles export"),
    ).length,
  };
}

function readRemoteSource(project: string, nowMs: number) {
  const values = Object.fromEntries(
    [
      ["events", "/events"],
      ["eventPrizeSelections", "/eventPrizeSelections"],
      ["profileEventPrizes", "/profileEventPrizes"],
      ["eventProgressOutbox", "/eventProgressOutbox"],
      ["eventProgressOutboxDead", "/eventProgressOutboxDead"],
      [
        "eventProfileGameProjectionOutboxes",
        "/profileGameProjectionOutbox/event",
      ],
      ["eventTelegramProjectionOutboxes", "/telegramProjectionOutbox/event"],
      ["eventTelegramProjections", "/eventTelegramProjections"],
      [
        "eventTelegramProjectionGenerations",
        "/eventTelegramProjectionGenerations",
      ],
      ["eventLocks", "/eventLocks"],
      ["eventTelegramProjectionLocks", "/eventTelegramProjectionLocks"],
      ["eventProfileGameProjectionLocks", "/profileGameProjectionLocks/event"],
      ["eventSyncThrottles", "/eventSyncThrottles"],
    ].map(([name, path]) => [name, firebaseGet(project, path)]),
  );
  return {
    snapshot: normalizeSnapshot(values as never),
    inspection: {
      activeEventLeases: countActiveLeases(values.eventLocks, nowMs),
      activeTelegramProjectionLeases: countActiveLeases(
        values.eventTelegramProjectionLocks,
        nowMs,
      ),
      activeProfileGameProjectionLeases: countActiveLeases(
        values.eventProfileGameProjectionLocks,
        nowMs,
      ),
      eventSyncThrottles: Object.keys(
        objectRoot(values.eventSyncThrottles, "invalid event throttles export"),
      ).length,
    },
  };
}

function wranglerArgs(database: string, args: string[]): string[] {
  return [
    "d1",
    "execute",
    database,
    "--remote",
    "--config",
    CONFIG_PATH,
    "--env-file",
    RELEASE_ENV_PATH,
    ...args,
  ];
}

function d1Rows(database: string, command: string): JsonRecord[] {
  const output = run(resolve("node_modules/.bin/wrangler"), [
    ...wranglerArgs(database, ["--command", command]),
    "--json",
  ]);
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error("invalid D1 JSON response");
  const entry = parsed.find(
    (value) => record(value) && Array.isArray(record(value)?.results),
  ) as JsonRecord | undefined;
  return entry && Array.isArray(entry.results)
    ? entry.results.filter((value): value is JsonRecord =>
        Boolean(record(value)),
      )
    : [];
}

function parseStorageControl(row: JsonRecord | undefined): EventStorageControl {
  const storageMode = row?.storage_mode;
  const previous = row?.previous_storage_mode;
  const freezeGeneration = Number(row?.freeze_generation || 0);
  const verifiedImportGeneration =
    row?.verified_import_generation === null ||
    row?.verified_import_generation === undefined
      ? null
      : Number(row.verified_import_generation);
  if (
    (storageMode !== "firebase" &&
      storageMode !== "frozen" &&
      storageMode !== "d1") ||
    (previous !== null &&
      previous !== undefined &&
      previous !== "firebase" &&
      previous !== "d1") ||
    !Number.isSafeInteger(freezeGeneration) ||
    freezeGeneration < 0 ||
    (verifiedImportGeneration !== null &&
      (!Number.isSafeInteger(verifiedImportGeneration) ||
        verifiedImportGeneration < 1))
  ) {
    throw new Error("invalid storage control");
  }
  return {
    freezeGeneration,
    storageMode,
    previousStorageMode: previous === undefined ? null : previous,
    verifiedImportGeneration,
  };
}

function readEventControl(): EventStorageControl {
  return parseStorageControl(
    d1Rows(
      EVENT_DATABASE,
      "SELECT storage_mode, previous_storage_mode, freeze_generation, verified_import_generation FROM event_runtime_control WHERE singleton = 1",
    )[0],
  );
}

function readWithdrawalControl(): EventStorageControl {
  return parseStorageControl(
    d1Rows(
      WITHDRAWAL_DATABASE,
      "SELECT storage_mode, previous_storage_mode FROM event_prize_withdrawal_runtime_control WHERE singleton = 1",
    )[0],
  );
}

function readEventWriteAdmissions(): number {
  const row = d1Rows(
    EVENT_DATABASE,
    "SELECT COUNT(*) AS write_admissions FROM event_write_admissions",
  )[0];
  const count = Number(row?.write_admissions);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid event write admission count");
  }
  return count;
}

function markFinalVerified({
  freezeGeneration,
  sourceDigest,
  verifiedAtMs,
}: Parameters<MigrationDependencies["markFinalVerified"]>[0]): void {
  const rows = d1Rows(
    EVENT_DATABASE,
    `UPDATE event_runtime_control SET verified_import_generation = freeze_generation, updated_at_ms = ${verifiedAtMs} WHERE singleton = 1 AND storage_mode = 'frozen' AND previous_storage_mode = 'firebase' AND freeze_generation = ${freezeGeneration} AND source_digest = ${sqlText(sourceDigest)} AND NOT EXISTS (SELECT 1 FROM event_write_admissions) RETURNING verified_import_generation`,
  );
  if (Number(rows[0]?.verified_import_generation) !== freezeGeneration) {
    throw new Error("final event verification could not be recorded");
  }
}

function readProfileControl(): string {
  return String(
    d1Rows(
      PROFILE_DATABASE,
      "SELECT state FROM profile_canonical_control WHERE singleton = 1",
    )[0]?.state || "",
  );
}

function readCompletedWithdrawalPrizeIdentities(): CompletedWithdrawalPrizeIdentity[] {
  return d1Rows(
    WITHDRAWAL_DATABASE,
    `SELECT event_id, prize_id FROM event_prize_withdrawals
     WHERE json_extract(record_json, '$.status') = 'completed'
     ORDER BY event_id, prize_id`,
  ).map((row) => {
    const eventId = row.event_id;
    const prizeId = row.prize_id;
    if (
      typeof eventId !== "string" ||
      typeof prizeId !== "string" ||
      !validKey(eventId) ||
      !validKey(prizeId)
    ) {
      throw new Error("invalid completed withdrawal identity");
    }
    return { eventId, prizeId };
  });
}

function readWithdrawalPendingCount(): number {
  const row = d1Rows(
    WITHDRAWAL_DATABASE,
    `SELECT COUNT(*) AS pending_withdrawals FROM event_prize_withdrawals
     WHERE json_extract(record_json, '$.status') IN ('processing', 'submitted')`,
  )[0];
  const count = Number(row?.pending_withdrawals);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid pending withdrawal count");
  }
  return count;
}

function readRemoteD1Snapshot(): EventMigrationSnapshot {
  const events = Object.fromEntries(
    d1Rows(
      EVENT_DATABASE,
      "SELECT event_id, record_json FROM event_records ORDER BY event_id",
    ).map((row) => [String(row.event_id), JSON.parse(String(row.record_json))]),
  );
  const eventPrizeSelections: Record<string, Record<string, string>> = {};
  for (const row of d1Rows(
    EVENT_DATABASE,
    "SELECT event_id, profile_id, prize_id FROM event_prize_selections ORDER BY event_id, profile_id",
  )) {
    const eventId = String(row.event_id);
    eventPrizeSelections[eventId] ||= {};
    eventPrizeSelections[eventId][String(row.profile_id)] = String(
      row.prize_id,
    );
  }
  const profileEventPrizes: Record<string, Record<string, JsonRecord>> = {};
  for (const row of d1Rows(
    EVENT_DATABASE,
    "SELECT profile_id, event_id, assignment_json FROM profile_event_prizes ORDER BY profile_id, event_id",
  )) {
    const profileId = String(row.profile_id);
    profileEventPrizes[profileId] ||= {};
    profileEventPrizes[profileId][String(row.event_id)] = JSON.parse(
      String(row.assignment_json),
    ) as JsonRecord;
  }
  const eventProgressOutbox: JsonRecord = {};
  const eventProgressOutboxDead: JsonRecord = {};
  for (const row of d1Rows(
    EVENT_DATABASE,
    "SELECT outbox_id, status, record_json FROM event_progress_outboxes ORDER BY outbox_id",
  )) {
    const target =
      row.status === "dead" ? eventProgressOutboxDead : eventProgressOutbox;
    target[String(row.outbox_id)] = JSON.parse(String(row.record_json));
  }
  const eventProfileGameProjectionOutboxes = Object.fromEntries(
    d1Rows(
      EVENT_DATABASE,
      "SELECT event_id, record_json FROM event_profile_game_projection_outboxes ORDER BY event_id",
    ).map((row) => [String(row.event_id), JSON.parse(String(row.record_json))]),
  );
  const eventTelegramProjectionOutboxes = Object.fromEntries(
    d1Rows(
      EVENT_DATABASE,
      "SELECT event_id, record_json FROM event_telegram_projection_outboxes ORDER BY event_id",
    ).map((row) => [String(row.event_id), JSON.parse(String(row.record_json))]),
  );
  const eventTelegramProjections: JsonRecord = {};
  const eventTelegramProjectionGenerations: Record<string, number> = {};
  for (const row of d1Rows(
    EVENT_DATABASE,
    "SELECT event_id, generation, state_json FROM event_telegram_projection_state ORDER BY event_id",
  )) {
    const eventId = String(row.event_id);
    const state = JSON.parse(String(row.state_json)) as JsonRecord;
    if (Object.keys(state).length > 0)
      eventTelegramProjections[eventId] = state;
    if (Number(row.generation) !== 0) {
      eventTelegramProjectionGenerations[eventId] = Number(row.generation);
    }
  }
  return normalizeSnapshot({
    events,
    eventPrizeSelections,
    profileEventPrizes,
    eventProgressOutbox,
    eventProgressOutboxDead,
    eventProfileGameProjectionOutboxes,
    eventTelegramProjectionOutboxes,
    eventTelegramProjections,
    eventTelegramProjectionGenerations,
  });
}

function persistArtifacts({
  exportedAtMs,
  phase,
  snapshot,
  sql,
}: {
  exportedAtMs: number;
  phase: MigrationPhase;
  snapshot: EventMigrationSnapshot;
  sql: string;
}): string {
  const runDirectory = resolve(
    ".cache",
    "event-migration",
    `${exportedAtMs}-${process.pid}`,
  );
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(runDirectory, "source.json"),
    `${JSON.stringify({ phase, snapshot })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(resolve(runDirectory, "import.sql"), sql, { mode: 0o600 });
  return runDirectory;
}

function createDefaultDependencies(): MigrationDependencies {
  return {
    eventWriteAdmissions: readEventWriteAdmissions,
    importSql: (path) => {
      run(
        resolve("node_modules/.bin/wrangler"),
        wranglerArgs(EVENT_DATABASE, ["--file", path, "--yes"]),
      );
    },
    log: console.log,
    markFinalVerified,
    now: Date.now,
    persistArtifacts,
    readCompletedWithdrawalPrizeIdentities,
    readEventControl,
    readImportedSnapshot: readRemoteD1Snapshot,
    readProfileControl,
    readSource: readRemoteSource,
    readSourceInspection: readRemoteInspection,
    readWithdrawalPendingCount,
    readWithdrawalControl,
  };
}

function execute(argv = process.argv.slice(2)): void {
  migrateEvents(parseArgs(argv), createDefaultDependencies());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "migration failed");
    process.exitCode = 1;
  }
}

export {
  assertImportAllowed,
  assertMigrationSource,
  buildImportSql,
  canonicalize,
  eventProgressOutboxId,
  execute,
  firebaseDatabaseGetArgs,
  migrateEvents,
  normalizeSnapshot,
  parseArgs,
  readRemoteD1Snapshot,
  snapshotDigest,
  summarize,
  verifyImportedSnapshot,
  type EventMigrationSnapshot,
  type EventStorageControl,
  type CompletedWithdrawalPrizeIdentity,
  type MigrationDependencies,
  type MigrationOptions,
  type SourceInspection,
};
