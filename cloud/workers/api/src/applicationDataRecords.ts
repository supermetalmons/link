export const APPLICATION_DATABASE_BINDINGS = [
  "PROFILE_GAMES_DB",
  "PROFILE_DB",
  "AUTH_STATE_DB",
  "EVENT_DB",
  "EVENT_PRIZE_WITHDRAWALS_DB",
  "TELEGRAM_DB",
] as const;

export type ApplicationDatabaseBinding =
  (typeof APPLICATION_DATABASE_BINDINGS)[number];
export type ApplicationDataPhase =
  "active" | "closing" | "closed" | "verifying";
export type ApplicationDataControl = {
  generation: number;
  dataEpoch: 0 | 1;
  phase: ApplicationDataPhase;
  migrationId: string | null;
};

export type ApplicationWriteContext = {
  generation: number;
  dataEpoch: 0 | 1;
  operationId: string;
} & ({ kind: "business" } | { kind: "migration"; migrationId: string });

export class ApplicationDataUnavailable extends Error {
  constructor() {
    super("application-data-unavailable");
  }
}

export function isApplicationIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    Array.from(value).every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}

export function parseApplicationWriteContext(
  value: unknown,
): ApplicationWriteContext {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("kind" in value) ||
    !("generation" in value) ||
    !("dataEpoch" in value) ||
    !("operationId" in value) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    (value.dataEpoch !== 0 && value.dataEpoch !== 1) ||
    !isApplicationIdentifier(value.operationId)
  )
    throw new ApplicationDataUnavailable();
  if (value.kind === "business" && Object.keys(value).length === 4)
    return {
      kind: "business",
      generation: value.generation,
      dataEpoch: value.dataEpoch,
      operationId: value.operationId,
    };
  if (
    value.kind === "migration" &&
    Object.keys(value).length === 5 &&
    "migrationId" in value &&
    isApplicationIdentifier(value.migrationId)
  )
    return {
      kind: "migration",
      generation: value.generation,
      dataEpoch: value.dataEpoch,
      operationId: value.operationId,
      migrationId: value.migrationId,
    };
  throw new ApplicationDataUnavailable();
}

export function parseApplicationDataControl(
  value: unknown,
): ApplicationDataControl {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !("singleton" in value) ||
    value.singleton !== 1 ||
    !("generation" in value) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !("data_epoch" in value) ||
    (value.data_epoch !== 0 && value.data_epoch !== 1) ||
    !("phase" in value) ||
    (value.phase !== "active" &&
      value.phase !== "closing" &&
      value.phase !== "closed" &&
      value.phase !== "verifying") ||
    !("migration_id" in value) ||
    (value.migration_id !== null &&
      !isApplicationIdentifier(value.migration_id)) ||
    (value.phase !== "active" && value.migration_id === null)
  )
    throw new ApplicationDataUnavailable();
  return {
    generation: value.generation,
    dataEpoch: value.data_epoch,
    phase: value.phase,
    migrationId: value.migration_id,
  };
}
