import { AuthApiFailure } from "./authErrors.ts";

type WagerReservationStorageMode = "frozen" | "d1";

export type WagerReservationControl = {
  storageMode: WagerReservationStorageMode;
  freezeGeneration: number;
};

export type WagerReservationAdmission = {
  admissionId: string;
  freezeGeneration: number;
  expiresAtMs: number;
  writerEpoch: 1;
};

type ControlRow = {
  storage_mode: unknown;
  freeze_generation: unknown;
};

const ADMISSION_DURATION_MS = 15 * 60 * 1_000;

export class WagerReservationWritesDisabled extends AuthApiFailure {
  constructor() {
    super(503, "unavailable", "wager-reservation-writes-disabled");
  }
}

export function wagerReservationUnavailable(): AuthApiFailure {
  return new AuthApiFailure(
    503,
    "unavailable",
    "wager-reservation-unavailable",
  );
}

function parseWagerReservationGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw wagerReservationUnavailable();
  }
  return value;
}

export function parseWagerReservationControlRow(
  value: unknown,
): WagerReservationControl {
  const row = value as ControlRow | null | undefined;
  if (!row || (row.storage_mode !== "frozen" && row.storage_mode !== "d1")) {
    throw wagerReservationUnavailable();
  }
  return {
    storageMode: row.storage_mode,
    freezeGeneration: parseWagerReservationGeneration(row.freeze_generation),
  };
}

export async function readWagerReservationControl(
  db: D1Database,
): Promise<WagerReservationControl> {
  let row: ControlRow | null;
  try {
    row = await db
      .prepare(
        `SELECT storage_mode, freeze_generation
         FROM wager_reservation_runtime_control WHERE singleton = 1`,
      )
      .first<ControlRow>();
  } catch {
    throw wagerReservationUnavailable();
  }
  return parseWagerReservationControlRow(row);
}

export function wagerReservationAdmissionGuards(
  db: D1Database,
  admission: WagerReservationAdmission,
  now: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO wager_reservation_write_guards (singleton)
         SELECT 0 WHERE NOT EXISTS (
           SELECT 1 FROM wager_reservation_write_admissions AS admission
           JOIN wager_reservation_runtime_control AS reservation ON reservation.singleton = 1
           JOIN profile_canonical_control AS profile ON profile.singleton = 1
           JOIN wager_state_activation AS wager_state ON wager_state.singleton = 1
           WHERE admission.admission_id = ?
             AND admission.freeze_generation = ? AND admission.expires_at_ms > ?
             AND admission.writer_epoch = ? AND wager_state.activation_epoch = admission.writer_epoch
             AND admission.uncertain = 0
             AND reservation.storage_mode = 'd1'
             AND reservation.freeze_generation = admission.freeze_generation
             AND profile.state = 'active'
         )`,
      )
      .bind(
        admission.admissionId,
        admission.freezeGeneration,
        now,
        admission.writerEpoch,
      ),
  ];
}

export async function assertWagerReservationAdmission(
  db: D1Database,
  admission: WagerReservationAdmission,
  now: number,
): Promise<void> {
  try {
    await db.batch(wagerReservationAdmissionGuards(db, admission, now));
  } catch {
    const control = await readWagerReservationControl(db);
    if (
      control.storageMode === "frozen" ||
      control.freezeGeneration !== admission.freezeGeneration ||
      admission.expiresAtMs <= now
    ) {
      throw new WagerReservationWritesDisabled();
    }
    throw wagerReservationUnavailable();
  }
}

export async function acquireWagerReservationAdmission(
  db: D1Database,
  kind: string,
  now: number,
): Promise<WagerReservationAdmission> {
  const admissionId = crypto.randomUUID();
  const expiresAtMs = now + ADMISSION_DURATION_MS;
  const admissionFromRow = (
    row: Pick<ControlRow, "freeze_generation">,
  ): WagerReservationAdmission => ({
    admissionId,
    freezeGeneration: parseWagerReservationGeneration(row.freeze_generation),
    expiresAtMs,
    writerEpoch: 1,
  });
  try {
    const inserted = await db
      .prepare(
        `INSERT INTO wager_reservation_write_admissions (
           admission_id, freeze_generation, kind, created_at_ms, expires_at_ms, writer_epoch
         )
         SELECT ?, reservation.freeze_generation, ?, ?, ?, 1
         FROM wager_reservation_runtime_control AS reservation
         JOIN profile_canonical_control AS profile ON profile.singleton = 1
         JOIN wager_state_activation AS wager_state ON wager_state.singleton = 1
         WHERE reservation.singleton = 1 AND reservation.storage_mode = 'd1'
           AND typeof(reservation.freeze_generation) IN ('integer', 'real')
           AND reservation.freeze_generation BETWEEN 0 AND 9007199254740991
           AND reservation.freeze_generation = CAST(reservation.freeze_generation AS INTEGER)
           AND profile.state = 'active' AND wager_state.activation_epoch = 1
         RETURNING freeze_generation`,
      )
      .bind(admissionId, kind, now, expiresAtMs)
      .first<Pick<ControlRow, "freeze_generation">>();
    if (inserted) return admissionFromRow(inserted);
  } catch {}
  let stored: Pick<ControlRow, "freeze_generation"> | null = null;
  try {
    stored = await db
      .withSession("first-primary")
      .prepare(
        `SELECT freeze_generation FROM wager_reservation_write_admissions
         WHERE admission_id = ? AND kind = ? AND created_at_ms = ?
           AND expires_at_ms = ? AND writer_epoch = 1`,
      )
      .bind(admissionId, kind, now, expiresAtMs)
      .first<Pick<ControlRow, "freeze_generation">>();
  } catch {}
  if (stored) return admissionFromRow(stored);
  const latest = await readWagerReservationControl(db);
  if (latest.storageMode === "frozen")
    throw new WagerReservationWritesDisabled();
  throw wagerReservationUnavailable();
}

export async function releaseWagerReservationAdmission(
  db: D1Database,
  admission: WagerReservationAdmission,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM wager_reservation_write_admissions
       WHERE admission_id = ? AND freeze_generation = ? AND writer_epoch = ? AND uncertain = 0`,
    )
    .bind(
      admission.admissionId,
      admission.freezeGeneration,
      admission.writerEpoch,
    )
    .run();
}
