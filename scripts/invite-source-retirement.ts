import type { SqlRunner } from "./manage-wager-state.ts";

export async function assertFirebaseInviteSourceAvailable(
  run: SqlRunner,
): Promise<void> {
  const database = "mons-link-profile-games";
  const tables = await run(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invite_source_control'",
    database,
  );
  if (tables.length === 0) return;
  if (tables.length !== 1)
    throw new Error("invalid invite-source schema evidence");
  const rows = await run(
    "SELECT backend FROM invite_source_control WHERE singleton = 1",
    database,
  );
  if (
    rows.length !== 1 ||
    (rows[0].backend !== "rtdb" && rows[0].backend !== "d1")
  )
    throw new Error(
      "invite-source control is missing or invalid; refusing a Firebase source scan",
    );
  if (rows[0].backend === "d1")
    throw new Error(
      "Firebase invite-source scans are retired after D1 activation; retained Firebase data is not a migration source",
    );
}
