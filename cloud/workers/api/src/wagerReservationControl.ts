import { AuthApiFailure } from "./authErrors.ts";

export type WagerReservationStorageMode = "frozen" | "d1";

export type WagerReservationControl = {
  storageMode: WagerReservationStorageMode;
  freezeGeneration: number;
};

export type WagerReservationAdmission = {
  admissionId: string;
  freezeGeneration: number;
  expiresAtMs: number;
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
  if (
    !row ||
    (row.storage_mode !== "frozen" && row.storage_mode !== "d1") ||
    typeof row.freeze_generation !== "number" ||
    !Number.isSafeInteger(row.freeze_generation) ||
    row.freeze_generation < 0
  ) {
    throw wagerReservationUnavailable();
  }
  return {
    storageMode: row.storage_mode,
    freezeGeneration: row.freeze_generation,
  };
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
           WHERE admission.admission_id = ?
             AND admission.freeze_generation = ? AND admission.expires_at_ms > ?
             AND admission.uncertain = 0
             AND reservation.storage_mode = 'd1'
             AND reservation.freeze_generation = admission.freeze_generation
             AND profile.state = 'active'
         )`,
      )
      .bind(admission.admissionId, admission.freezeGeneration, now),
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
  const control = await readWagerReservationControl(db);
  if (control.storageMode === "frozen")
    throw new WagerReservationWritesDisabled();
  const admission: WagerReservationAdmission = {
    admissionId: crypto.randomUUID(),
    freezeGeneration: control.freezeGeneration,
    expiresAtMs: now + ADMISSION_DURATION_MS,
  };
  try {
    await db
      .prepare(
        `INSERT INTO wager_reservation_write_admissions (
           admission_id, freeze_generation, kind, created_at_ms, expires_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        admission.admissionId,
        admission.freezeGeneration,
        kind,
        now,
        admission.expiresAtMs,
      )
      .run();
  } catch {
    const stored = await db
      .prepare(
        `SELECT admission_id FROM wager_reservation_write_admissions
         WHERE admission_id = ? AND freeze_generation = ?`,
      )
      .bind(admission.admissionId, admission.freezeGeneration)
      .first<{ admission_id: string }>()
      .catch(() => null);
    if (!stored) {
      const latest = await readWagerReservationControl(db);
      if (latest.storageMode === "frozen")
        throw new WagerReservationWritesDisabled();
      throw wagerReservationUnavailable();
    }
  }
  return admission;
}

export async function releaseWagerReservationAdmission(
  db: D1Database,
  admission: WagerReservationAdmission,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM wager_reservation_write_admissions
       WHERE admission_id = ? AND freeze_generation = ? AND uncertain = 0`,
    )
    .bind(admission.admissionId, admission.freezeGeneration)
    .run();
}
