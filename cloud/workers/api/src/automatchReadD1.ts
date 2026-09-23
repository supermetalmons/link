import {
  AUTOMATCH_RECORD_TABLES,
  decodeSnapshot,
  parseAutomatchRuntimeControlRow,
  prepareAutomatchRuntimeControlRead,
  type AutomatchRoot,
  type RecordRow,
} from "./automatchD1.ts";
import {
  assertNoGameSessionResourceTransition,
  prepareGameSessionResourceTransitionRead,
} from "./gameSessionTransitions.ts";
import {
  decodeInviteSourceSnapshot,
  InviteSourceFailure,
  parseInviteSourceControlRow,
  prepareInviteSourceControlRead,
  prepareInviteSourceSnapshotRead,
} from "./inviteSourceD1.ts";
import { AuthApiFailure } from "./authErrors.ts";
import { isSafeRecordKey } from "./recordKeys.ts";

const MAX_INVITE_METADATA_READS = 32;

type InviteMetadataRow = {
  invite_id: string;
  source_invite_id: string | null;
  source_json: string | null;
  revision: number | null;
  transition_id: string | null;
};

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

export async function readInviteMetadataMany(
  db: D1Database,
  inviteIds: readonly string[],
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown> | null>> {
  if (
    !Array.isArray(inviteIds) ||
    inviteIds.length > MAX_INVITE_METADATA_READS
  ) {
    throw new TypeError("invalid-invite-metadata-read-batch");
  }
  for (const inviteId of inviteIds) {
    if (!isSafeRecordKey(inviteId))
      throw new TypeError("invalid-automatch-record-key");
  }
  signal?.throwIfAborted();
  if (inviteIds.length === 0) return [];
  const requested = new Set(inviteIds);
  const session = db.withSession("first-primary");
  const [modeRows, controlRows, sourceRows] = await session.batch([
    prepareAutomatchRuntimeControlRead(session),
    prepareInviteSourceControlRead(session),
    session
      .prepare(
        `WITH requested AS (
           SELECT value AS invite_id FROM json_each(?)
         )
         SELECT requested.invite_id, source.invite_id AS source_invite_id,
                source.source_json, source.revision, transition.transition_id
         FROM requested
         LEFT JOIN invite_sources AS source
           ON source.invite_id = requested.invite_id
         LEFT JOIN game_session_transition_resources AS resource
           ON resource.resource_key = requested.invite_id
         LEFT JOIN game_session_transitions AS transition
           ON transition.transition_id = resource.transition_id`,
      )
      .bind(JSON.stringify([...requested])),
  ]);
  signal?.throwIfAborted();
  assertAutomatchBackend(parseAutomatchRuntimeControlRow(modeRows.results[0]));
  if (parseInviteSourceControlRow(controlRows.results[0]).backend !== "d1") {
    throw new InviteSourceFailure("invite-source-backend-retired");
  }
  const rows = sourceRows.results as InviteMetadataRow[];
  const rowsById = new Map(rows.map((row) => [row.invite_id, row]));
  if (
    rows.length !== requested.size ||
    rowsById.size !== requested.size ||
    rows.some(
      (row) =>
        !requested.has(row.invite_id) ||
        (row.source_invite_id === null
          ? row.source_json !== null || row.revision !== null
          : row.source_invite_id !== row.invite_id),
    )
  ) {
    throw new InviteSourceFailure("invite-source-corrupt");
  }
  return inviteIds.map((inviteId) => {
    const row = rowsById.get(inviteId);
    if (!row) throw new InviteSourceFailure("invite-source-corrupt");
    assertNoGameSessionResourceTransition(
      row.transition_id === null ? null : row,
    );
    return decodeInviteSourceSnapshot(
      inviteId,
      row.source_invite_id === null ? null : row,
    ).value;
  });
}
