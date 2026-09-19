import { MAX_EVENT_PARTICIPANTS } from "@mons/shared/events";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { captureLoginMatchDiscovery } from "./loginMatchDiscoveryD1.ts";
import {
  parseAutomatchRuntimeControlRow,
  prepareAutomatchRuntimeControlRead,
} from "./automatchD1.ts";
import { assertAutomatchBackend } from "./automatchReadD1.ts";
import { assertNoGameSessionResourceTransition } from "./gameSessionTransitions.ts";
import {
  decodeInviteSourceSnapshot,
  InviteSourceFailure,
  parseInviteSourceControlRow,
  prepareInviteSourceControlRead,
} from "./inviteSourceD1.ts";

const EVENT_MATCH_DISCOVERY_CONCURRENCY = 4;

type EventMatchDiscoveryRepository = Pick<
  GameplayRepository,
  "readMatchRecord" | "readInviteMetadata"
>;

type EventMatchDiscoveryCoverageRow = {
  invite_id: string;
  source_json: string | null;
  revision: number | null;
  transition_id: string | null;
  host_invite_id: string | null;
  host_resolution: string | null;
  host_provenance: string | null;
  guest_invite_id: string | null;
  guest_resolution: string | null;
  guest_provenance: string | null;
};

function boundedInviteIds(input: readonly string[]): string[] {
  const inviteIds = [...new Set(input)];
  if (
    inviteIds.length > MAX_EVENT_PARTICIPANTS ||
    !inviteIds.every(isSafeRecordKey)
  ) {
    throw new Error("event-match-discovery-invalid-invites");
  }
  return inviteIds;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectionValues(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") {
    throw new Error("event-match-discovery-invalid-bracket");
  }
  const values = Object.values(value);
  if (values.length > MAX_EVENT_PARTICIPANTS) {
    throw new Error("event-match-discovery-invalid-bracket");
  }
  return values;
}

export function eventMatchInviteIds(event: Record<string, unknown>): string[] {
  const matches = collectionValues(event.rounds).flatMap((value) => {
    if (value === null || value === undefined) return [];
    const round = record(value);
    if (!round) throw new Error("event-match-discovery-invalid-bracket");
    return collectionValues(round.matches);
  });
  matches.push(event.thirdPlaceMatch);
  return matches.flatMap((value) => {
    if (value === null || value === undefined) return [];
    const match = record(value);
    if (!match) throw new Error("event-match-discovery-invalid-bracket");
    const inviteId = match.inviteId;
    if (inviteId === null || inviteId === undefined || inviteId === "")
      return [];
    if (typeof inviteId !== "string" || !isSafeRecordKey(inviteId)) {
      throw new Error("event-match-discovery-invalid-invite");
    }
    return [inviteId];
  });
}

export async function captureEventMatchDiscovery(
  db: D1Database,
  repository: EventMatchDiscoveryRepository,
  inputInviteIds: readonly string[],
  signal?: AbortSignal,
  nowMs = Date.now(),
): Promise<void> {
  const inviteIds = boundedInviteIds(inputInviteIds);
  for (
    let offset = 0;
    offset < inviteIds.length;
    offset += EVENT_MATCH_DISCOVERY_CONCURRENCY
  ) {
    signal?.throwIfAborted();
    const rows = await Promise.all(
      inviteIds
        .slice(offset, offset + EVENT_MATCH_DISCOVERY_CONCURRENCY)
        .map(async (inviteId) => {
          const invite = record(
            await repository.readInviteMetadata(inviteId, signal),
          );
          const hostId = invite?.hostId;
          const guestId = invite?.guestId;
          if (
            !isCanonicalLoginUid(hostId) ||
            !isCanonicalLoginUid(guestId) ||
            hostId === guestId
          ) {
            throw new Error("event-match-discovery-invite-unavailable");
          }
          return Promise.all(
            [hostId, guestId].map(async (loginUid) => {
              const match = await repository.readMatchRecord(
                { playerId: loginUid, matchId: inviteId },
                signal,
              );
              if (match === null || match === undefined) {
                throw new Error("event-match-discovery-match-unavailable");
              }
              return { loginUid, matchId: inviteId, inviteId };
            }),
          );
        }),
    );
    signal?.throwIfAborted();
    await captureLoginMatchDiscovery(db, rows.flat(), nowMs);
  }
}

export async function ensureEventMatchDiscovery(
  db: D1Database,
  repository: EventMatchDiscoveryRepository,
  inputInviteIds: readonly string[],
  signal?: AbortSignal,
  nowMs = Date.now(),
): Promise<void> {
  const inviteIds = boundedInviteIds(inputInviteIds);
  signal?.throwIfAborted();
  if (inviteIds.length === 0) return;
  const session = db.withSession("first-primary");
  const [modeRows, controlRows, coverageRows] = await session.batch([
    prepareAutomatchRuntimeControlRead(session),
    prepareInviteSourceControlRead(session),
    session
      .prepare(
        `WITH requested AS (
           SELECT value AS invite_id FROM json_each(?)
         )
         SELECT requested.invite_id, source.source_json, source.revision,
                transition.transition_id,
                host.invite_id AS host_invite_id,
                host.resolution AS host_resolution,
                host.provenance AS host_provenance,
                guest.invite_id AS guest_invite_id,
                guest.resolution AS guest_resolution,
                guest.provenance AS guest_provenance
         FROM requested
         LEFT JOIN invite_sources AS source ON source.invite_id = requested.invite_id
         LEFT JOIN game_session_transition_resources AS resource
           ON resource.resource_key = requested.invite_id
         LEFT JOIN game_session_transitions AS transition
           ON transition.transition_id = resource.transition_id
         LEFT JOIN login_match_discovery AS host
           ON host.login_uid = json_extract(source.source_json, '$.hostId')
          AND host.match_id = requested.invite_id
         LEFT JOIN login_match_discovery AS guest
           ON guest.login_uid = json_extract(source.source_json, '$.guestId')
          AND guest.match_id = requested.invite_id`,
      )
      .bind(JSON.stringify(inviteIds)),
  ]);
  signal?.throwIfAborted();
  assertAutomatchBackend(parseAutomatchRuntimeControlRow(modeRows.results[0]));
  if (parseInviteSourceControlRow(controlRows.results[0]).backend !== "d1") {
    throw new InviteSourceFailure("invite-source-backend-retired");
  }
  const rows = coverageRows.results as EventMatchDiscoveryCoverageRow[];
  if (
    rows.length !== inviteIds.length ||
    new Set(rows.map((row) => row.invite_id)).size !== inviteIds.length ||
    rows.some((row) => !inviteIds.includes(row.invite_id))
  ) {
    throw new Error("event-match-discovery-coverage-unavailable");
  }
  const incomplete = rows.flatMap((row) => {
    assertNoGameSessionResourceTransition(row.transition_id);
    const invite = decodeInviteSourceSnapshot(
      row.invite_id,
      row.source_json === null && row.revision === null ? null : row,
    ).value;
    const covered =
      isCanonicalLoginUid(invite?.hostId) &&
      isCanonicalLoginUid(invite?.guestId) &&
      invite.hostId !== invite.guestId &&
      row.host_invite_id === row.invite_id &&
      row.guest_invite_id === row.invite_id &&
      row.host_resolution === "resolved" &&
      row.guest_resolution === "resolved" &&
      row.host_provenance === "capture" &&
      row.guest_provenance === "capture";
    return covered ? [] : [row.invite_id];
  });
  await captureEventMatchDiscovery(db, repository, incomplete, signal, nowMs);
}
