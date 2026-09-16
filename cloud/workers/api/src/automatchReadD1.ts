import {
  AUTOMATCH_RECORD_TABLES,
  decodeSnapshot,
  parseAutomatchRuntimeControlRow,
  prepareAutomatchRuntimeControlRead,
  type AutomatchRoot,
  type RecordRow,
} from "./automatchD1.ts";
import { prepareGameSessionResourceTransitionRead } from "./gameSessionTransitions.ts";
import {
  decodeInviteSourceSnapshot,
  InviteSourceFailure,
  parseInviteSourceControlRow,
  prepareInviteSourceControlRead,
  prepareInviteSourceSnapshotRead,
} from "./inviteSourceD1.ts";
import { AuthApiFailure } from "./authErrors.ts";
import { isSafeRecordKey } from "./recordKeys.ts";

export function assertAutomatchBackend(
  mode: ReturnType<typeof parseAutomatchRuntimeControlRow>,
): void {
  if (mode.backend !== "d1")
    throw new AuthApiFailure(
      503,
      "unavailable",
      "automatch-persistence-backend-retired",
    );
}

export async function readAutomatchResourceSnapshot(
  db: D1Database,
  resourceKey: string,
  root: AutomatchRoot | "invite",
  recordKey: string,
  signal?: AbortSignal,
) {
  if (!isSafeRecordKey(recordKey))
    throw new TypeError("invalid-automatch-record-key");
  signal?.throwIfAborted();
  const session = db.withSession("first-primary");
  const source =
    root === "invite"
      ? prepareInviteSourceSnapshotRead(session, recordKey)
      : session
          .prepare(
            `SELECT record_key, ${AUTOMATCH_RECORD_TABLES[root].valueColumn} AS payload_json,
        ${AUTOMATCH_RECORD_TABLES[root].revisionColumn} AS revision
        FROM ${AUTOMATCH_RECORD_TABLES[root].table} WHERE record_key = ?`,
          )
          .bind(recordKey);
  const [modeRows, pendingRows, sourceRows, inviteRows] = await session.batch([
    prepareAutomatchRuntimeControlRead(session),
    prepareGameSessionResourceTransitionRead(session, resourceKey),
    source,
    ...(root === "invite" ? [prepareInviteSourceControlRead(session)] : []),
  ]);
  signal?.throwIfAborted();
  const mode = parseAutomatchRuntimeControlRow(modeRows.results[0]);
  assertAutomatchBackend(mode);
  if (
    inviteRows &&
    parseInviteSourceControlRow(inviteRows.results[0]).backend !== "d1"
  )
    throw new InviteSourceFailure("invite-source-backend-retired");
  const pending = pendingRows.results[0];
  const row = sourceRows.results[0];
  const value = pending
    ? null
    : root === "invite"
      ? decodeInviteSourceSnapshot(recordKey, row).value
      : row
        ? decodeSnapshot(root, row as RecordRow).value
        : null;
  return { mode, pending, value };
}
