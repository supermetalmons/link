import {
  hashTimerHandoff,
  parseTimerHandoffAcknowledgement,
  parseTimerHandoffCopyReceipt,
  parseTimerHandoffIdentity,
  parseTimerHandoffMarkers,
  parseTimerHandoffOwnership,
  parseTimerHandoffSnapshot,
  timerHandoffJson,
  timerHandoffOwnershipDigest,
  timerHandoffSnapshotDigest,
  type TimerHandoffAcknowledgement,
  type TimerHandoffCopyReceipt,
  type TimerHandoffIdentity,
  type TimerHandoffOwnership,
  type TimerHandoffSnapshot,
} from "./timerHandoffReceiptFixture.ts";
import { isSafeRecordKey } from "../src/recordKeys.ts";

type Database = Pick<D1Database, "prepare" | "batch">;
type HandoffRow = {
  handoff_id: string;
  invite_id: string;
  object_id: string;
  ownership_digest: string;
  ownership_json: string;
  markers_json: string;
  phase: "copying" | "local";
  snapshot_digest: string | null;
  copy_receipt_json: string | null;
  copy_receipt_digest: string | null;
  acknowledgement_json: string | null;
};

export const UNFENCED_MATCH_TIMER_SQL = `NOT EXISTS (
  SELECT 1 FROM timer_storage_handoff_owners timer_owner
  WHERE timer_owner.actor_uid = match_timer_starts_canonical.player_id
    AND timer_owner.match_id = match_timer_starts_canonical.match_id
) AND NOT EXISTS (
  SELECT 1 FROM match_state_routes_canonical timer_route
  JOIN timer_storage_handoffs timer_handoff ON timer_handoff.invite_id = timer_route.invite_id
  WHERE timer_route.actor_uid = match_timer_starts_canonical.player_id
    AND timer_route.match_id = match_timer_starts_canonical.match_id
)`;

const ACTIVE_CONTROL_SQL = `EXISTS (
  SELECT 1 FROM application_data_control
  WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active'
) AND EXISTS (
  SELECT 1 FROM match_state_control
  WHERE singleton = 1 AND backend = 'durable' AND state = 'active'
)`;

function invalid(): never {
  throw new Error("timer-handoff-d1-conflict");
}

function guard(db: Database, condition: string, ...bindings: unknown[]) {
  return db
    .prepare(
      `SELECT CASE WHEN ${condition} THEN 1 ELSE json('timer-handoff-d1-conflict') END AS verified`,
    )
    .bind(...bindings);
}

function same(left: unknown, right: unknown): void {
  if (timerHandoffJson(left) !== timerHandoffJson(right)) invalid();
}

function rowIdentity(row: HandoffRow): TimerHandoffIdentity {
  return parseTimerHandoffIdentity({
    schemaVersion: 1,
    handoffId: row.handoff_id,
    inviteId: row.invite_id,
    objectId: row.object_id,
  });
}

async function snapshotFromRow(row: HandoffRow): Promise<TimerHandoffSnapshot> {
  const identity = rowIdentity(row);
  const ownership = parseTimerHandoffOwnership(JSON.parse(row.ownership_json));
  const markers = parseTimerHandoffMarkers(JSON.parse(row.markers_json));
  const ownershipDigest = await timerHandoffOwnershipDigest(
    identity,
    ownership,
  );
  if (ownershipDigest !== row.ownership_digest) invalid();
  const snapshotDigest = await timerHandoffSnapshotDigest(
    ownershipDigest,
    markers,
  );
  if (row.snapshot_digest !== null && row.snapshot_digest !== snapshotDigest)
    invalid();
  return parseTimerHandoffSnapshot({
    ...identity,
    ownership,
    ownershipDigest,
    markers,
    snapshotDigest,
    d1FenceReceiptDigest: await hashTimerHandoff({
      ...identity,
      ownershipDigest,
      snapshotDigest,
    }),
  });
}

async function readHandoff(db: Database, handoffId: string) {
  return db
    .prepare("SELECT * FROM timer_storage_handoffs WHERE handoff_id = ?")
    .bind(handoffId)
    .first<HandoffRow>();
}

export async function fenceTimerHandoffD1(
  db: Database,
  input: TimerHandoffIdentity,
  expectedOwnership: readonly TimerHandoffOwnership[],
): Promise<TimerHandoffSnapshot> {
  const identity = parseTimerHandoffIdentity(input);
  const ownership = parseTimerHandoffOwnership(expectedOwnership);
  const ownershipJson = timerHandoffJson(ownership);
  const ownershipDigest = await timerHandoffOwnershipDigest(
    identity,
    ownership,
  );
  const statements = [
    guard(db, ACTIVE_CONTROL_SQL),
    db
      .prepare(
        `INSERT INTO timer_storage_handoffs
          (handoff_id, invite_id, object_id, ownership_digest, ownership_json, markers_json, phase)
        SELECT ?, ?, ?, ?, ?, (
          SELECT json_group_array(json(marker)) FROM (
            SELECT json_object(
              'matchId', timer.match_id, 'playerId', timer.player_id,
              'opponentId', timer.opponent_id, 'turnNumber', timer.turn_number,
              'deadlineAtMs', timer.deadline_at_ms, 'updatedAtMs', timer.updated_at_ms
            ) AS marker
            FROM match_timer_starts_canonical timer
            WHERE EXISTS (SELECT 1 FROM json_each(?) owner
              WHERE json_extract(owner.value, '$.actorUid') = timer.player_id
                AND json_extract(owner.value, '$.matchId') = timer.match_id)
            ORDER BY timer.match_id, timer.player_id
          )
        ), 'copying'
        ON CONFLICT(handoff_id) DO NOTHING`,
      )
      .bind(
        identity.handoffId,
        identity.inviteId,
        identity.objectId,
        ownershipDigest,
        ownershipJson,
        ownershipJson,
      ),
    guard(
      db,
      `EXISTS (SELECT 1 FROM timer_storage_handoffs
        WHERE handoff_id = ? AND invite_id = ? AND object_id = ?
          AND ownership_digest = ? AND ownership_json = ?)`,
      identity.handoffId,
      identity.inviteId,
      identity.objectId,
      ownershipDigest,
      ownershipJson,
    ),
    guard(
      db,
      `NOT EXISTS (
        SELECT 1 FROM match_state_routes_canonical route
        WHERE route.invite_id = ? AND (
          route.kind != 'durable' OR route.epoch != (SELECT epoch FROM match_state_control WHERE singleton = 1)
          OR NOT EXISTS (SELECT 1 FROM json_each(?) owner
            WHERE json_extract(owner.value, '$.actorUid') = route.actor_uid
              AND json_extract(owner.value, '$.matchId') = route.match_id)
        )
      ) AND NOT EXISTS (
        SELECT 1 FROM json_each(?) owner WHERE NOT EXISTS (
          SELECT 1 FROM match_state_routes_canonical route
          WHERE route.actor_uid = json_extract(owner.value, '$.actorUid')
            AND route.match_id = json_extract(owner.value, '$.matchId')
            AND route.kind = 'durable' AND route.invite_id = ?
            AND route.epoch = (SELECT epoch FROM match_state_control WHERE singleton = 1)
        )
      )`,
      identity.inviteId,
      ownershipJson,
      ownershipJson,
      identity.inviteId,
    ),
    guard(
      db,
      `NOT EXISTS (
        SELECT 1 FROM timer_storage_handoffs handoff, json_each(handoff.markers_json) marker
        WHERE handoff.handoff_id = ? AND NOT EXISTS (
          SELECT 1 FROM json_each(handoff.ownership_json) owner
          WHERE json_extract(owner.value, '$.actorUid') = json_extract(marker.value, '$.playerId')
            AND json_extract(owner.value, '$.matchId') = json_extract(marker.value, '$.matchId')
            AND json_extract(owner.value, '$.opponentUid') = json_extract(marker.value, '$.opponentId')
        )
      )`,
      identity.handoffId,
    ),
    db
      .prepare(
        `INSERT INTO timer_storage_handoff_owners(actor_uid, match_id, opponent_uid, handoff_id, route_epoch)
        SELECT json_extract(owner.value, '$.actorUid'), json_extract(owner.value, '$.matchId'),
          json_extract(owner.value, '$.opponentUid'), handoff.handoff_id, route.epoch
        FROM timer_storage_handoffs handoff, json_each(handoff.ownership_json) owner
        JOIN match_state_routes_canonical route ON route.actor_uid = json_extract(owner.value, '$.actorUid')
          AND route.match_id = json_extract(owner.value, '$.matchId')
        WHERE handoff.handoff_id = ? AND handoff.phase = 'copying'
        ON CONFLICT(actor_uid, match_id) DO NOTHING`,
      )
      .bind(identity.handoffId),
    guard(
      db,
      `NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
        SELECT 1 FROM timer_storage_handoff_owners owner
        WHERE owner.actor_uid = json_extract(expected.value, '$.actorUid')
          AND owner.match_id = json_extract(expected.value, '$.matchId')
          AND owner.opponent_uid IS json_extract(expected.value, '$.opponentUid')
          AND owner.handoff_id = ?
      ))`,
      ownershipJson,
      identity.handoffId,
    ),
    db
      .prepare("SELECT * FROM timer_storage_handoffs WHERE handoff_id = ?")
      .bind(identity.handoffId),
  ];
  const result = await db.batch<HandoffRow>(statements);
  const row = result.at(-1)?.results[0];
  if (!row) invalid();
  return snapshotFromRow(row);
}

async function verifiedReceipt(input: TimerHandoffCopyReceipt) {
  const receipt = parseTimerHandoffCopyReceipt(input);
  const { receiptDigest, ...payload } = receipt;
  if ((await hashTimerHandoff(payload)) !== receiptDigest) invalid();
  return receipt;
}

export async function completeTimerHandoffD1(
  db: Database,
  input: TimerHandoffCopyReceipt,
): Promise<TimerHandoffAcknowledgement> {
  const receipt = await verifiedReceipt(input);
  const row = await readHandoff(db, receipt.handoffId);
  if (!row) invalid();
  const snapshot = await snapshotFromRow(row);
  const {
    receiptDigest,
    revision: _revision,
    markerCount,
    ...receiptScope
  } = receipt;
  same(receiptScope, {
    ...rowIdentity(row),
    ownershipDigest: snapshot.ownershipDigest,
    snapshotDigest: snapshot.snapshotDigest,
  });
  if (markerCount !== snapshot.markers.length) invalid();
  const payload = { ...receiptScope, receiptDigest };
  const acknowledgement = parseTimerHandoffAcknowledgement({
    ...payload,
    deletionAckDigest: await hashTimerHandoff(payload),
  });
  if (row.phase === "local") {
    same(JSON.parse(row.copy_receipt_json ?? "null"), receipt);
    same(JSON.parse(row.acknowledgement_json ?? "null"), acknowledgement);
    return acknowledgement;
  }
  await db.batch([
    guard(db, ACTIVE_CONTROL_SQL),
    db
      .prepare(
        `UPDATE timer_storage_handoffs SET snapshot_digest = ?, copy_receipt_json = ?, copy_receipt_digest = ?
        WHERE handoff_id = ? AND phase = 'copying'`,
      )
      .bind(
        snapshot.snapshotDigest,
        timerHandoffJson(receipt),
        receiptDigest,
        receipt.handoffId,
      ),
    guard(
      db,
      `EXISTS (SELECT 1 FROM timer_storage_handoffs WHERE handoff_id = ? AND phase = 'copying'
        AND snapshot_digest = ? AND copy_receipt_digest = ? AND copy_receipt_json = ?)`,
      receipt.handoffId,
      snapshot.snapshotDigest,
      receiptDigest,
      timerHandoffJson(receipt),
    ),
    guard(
      db,
      `(SELECT COUNT(*) FROM match_timer_starts_canonical timer
        JOIN timer_storage_handoff_owners owner ON owner.actor_uid = timer.player_id AND owner.match_id = timer.match_id
        WHERE owner.handoff_id = ?) = ? AND NOT EXISTS (
        SELECT 1 FROM timer_storage_handoffs handoff, json_each(handoff.markers_json) marker
        WHERE handoff.handoff_id = ? AND NOT EXISTS (
          SELECT 1 FROM match_timer_starts_canonical timer
          WHERE timer.player_id = json_extract(marker.value, '$.playerId')
            AND timer.match_id = json_extract(marker.value, '$.matchId')
            AND timer.opponent_id = json_extract(marker.value, '$.opponentId')
            AND timer.turn_number = json_extract(marker.value, '$.turnNumber')
            AND timer.deadline_at_ms = json_extract(marker.value, '$.deadlineAtMs')
            AND timer.updated_at_ms = json_extract(marker.value, '$.updatedAtMs')
        )
      )`,
      receipt.handoffId,
      markerCount,
      receipt.handoffId,
    ),
    db
      .prepare(
        "INSERT INTO timer_storage_handoff_delete_context VALUES (1, ?, ?, ?)",
      )
      .bind(receipt.handoffId, receiptDigest, snapshot.snapshotDigest),
    db
      .prepare(
        `DELETE FROM match_timer_starts_canonical WHERE EXISTS (
          SELECT 1 FROM timer_storage_handoff_owners owner
          WHERE owner.actor_uid = match_timer_starts_canonical.player_id
            AND owner.match_id = match_timer_starts_canonical.match_id AND owner.handoff_id = ?
        )`,
      )
      .bind(receipt.handoffId),
    guard(
      db,
      `NOT EXISTS (SELECT 1 FROM match_timer_starts_canonical timer
        JOIN timer_storage_handoff_owners owner ON owner.actor_uid = timer.player_id AND owner.match_id = timer.match_id
        WHERE owner.handoff_id = ?)`,
      receipt.handoffId,
    ),
    db
      .prepare(
        "DELETE FROM timer_storage_handoff_delete_context WHERE singleton = 1 AND handoff_id = ?",
      )
      .bind(receipt.handoffId),
    db
      .prepare(
        `UPDATE timer_storage_handoffs SET phase = 'local', acknowledgement_json = ?
        WHERE handoff_id = ? AND phase = 'copying' AND copy_receipt_digest = ?`,
      )
      .bind(
        timerHandoffJson(acknowledgement),
        receipt.handoffId,
        receiptDigest,
      ),
  ]);
  return acknowledgement;
}

export async function readTimerHandoffAcknowledgement(
  db: Database,
  input: TimerHandoffCopyReceipt,
): Promise<TimerHandoffAcknowledgement | null> {
  const receipt = await verifiedReceipt(input);
  const row = await readHandoff(db, receipt.handoffId);
  if (!row || row.phase !== "local") return null;
  same(JSON.parse(row.copy_receipt_json ?? "null"), receipt);
  const acknowledgement = parseTimerHandoffAcknowledgement(
    JSON.parse(row.acknowledgement_json ?? "null"),
  );
  const { deletionAckDigest, ...payload } = acknowledgement;
  if ((await hashTimerHandoff(payload)) !== deletionAckDigest) invalid();
  same(payload, {
    ...rowIdentity(row),
    ownershipDigest: receipt.ownershipDigest,
    snapshotDigest: receipt.snapshotDigest,
    receiptDigest: receipt.receiptDigest,
  });
  return acknowledgement;
}

export type EmptyTimerHandoffRoutingEvidence = {
  schemaVersion: 1;
  generation: 3;
  dataEpoch: 1;
  routeEpoch: number;
  inviteIds: string[];
  routeCount: number;
  timerCount: number;
  unroutedTimerCount: 0;
  routingDigest: string;
};

const EMPTY_ROUTING_PAGE_SIZE = 256;
const MAX_EMPTY_ROUTING_INVITES = 20_000;
const INVITE_COUNT_SQL = `(SELECT COUNT(DISTINCT invite_id) FROM match_state_routes_canonical WHERE kind = 'durable')`;

export async function readEmptyTimerHandoffRoutingEvidence(
  db: Database,
): Promise<EmptyTimerHandoffRoutingEvidence> {
  const initialCount = await db
    .prepare(`SELECT ${INVITE_COUNT_SQL} AS count`)
    .first<number>("count");
  if (
    initialCount === null ||
    !Number.isSafeInteger(initialCount) ||
    initialCount < 0 ||
    initialCount > MAX_EMPTY_ROUTING_INVITES
  )
    invalid();
  const pageCount = Math.min(
    Math.ceil(MAX_EMPTY_ROUTING_INVITES / EMPTY_ROUTING_PAGE_SIZE),
    Math.ceil(initialCount / EMPTY_ROUTING_PAGE_SIZE) + 1,
  );
  const statements = [
    guard(
      db,
      `${ACTIVE_CONTROL_SQL} AND ${INVITE_COUNT_SQL} <= ? AND ${INVITE_COUNT_SQL} <= ?
      AND NOT EXISTS (SELECT 1 FROM match_state_routes_canonical
        WHERE kind = 'durable' AND epoch != (SELECT epoch FROM match_state_control WHERE singleton = 1))`,
      MAX_EMPTY_ROUTING_INVITES,
      pageCount * EMPTY_ROUTING_PAGE_SIZE,
    ),
    ...Array.from({ length: pageCount }, (_, page) =>
      db
        .prepare(
          "SELECT DISTINCT invite_id FROM match_state_routes_canonical WHERE kind = 'durable' ORDER BY invite_id LIMIT ? OFFSET ?",
        )
        .bind(EMPTY_ROUTING_PAGE_SIZE, page * EMPTY_ROUTING_PAGE_SIZE),
    ),
    db.prepare(`SELECT
      (SELECT epoch FROM match_state_control WHERE singleton = 1) AS route_epoch,
      ${INVITE_COUNT_SQL} AS invite_count,
      (SELECT COUNT(*) FROM match_state_routes_canonical WHERE kind = 'durable') AS route_count,
      (SELECT COUNT(*) FROM match_timer_starts_canonical) AS timer_count,
      (SELECT COUNT(*) FROM match_timer_starts_canonical timer WHERE NOT EXISTS (
        SELECT 1 FROM match_state_routes_canonical player
        JOIN match_state_routes_canonical opponent ON opponent.match_id = player.match_id AND opponent.invite_id = player.invite_id
        WHERE player.actor_uid = timer.player_id AND player.match_id = timer.match_id AND player.kind = 'durable'
          AND opponent.actor_uid = timer.opponent_id AND opponent.kind = 'durable'
          AND player.epoch = (SELECT epoch FROM match_state_control WHERE singleton = 1)
          AND opponent.epoch = player.epoch
      )) AS unrouted_timer_count`),
  ];
  const results = await db.batch<Record<string, unknown>>(statements);
  if (results.length !== statements.length) invalid();
  const counts = results.at(-1)?.results[0];
  if (!counts) invalid();
  const integer = (field: string, minimum = 0): number => {
    const value = counts[field];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum
    )
      invalid();
    return value;
  };
  const routeEpoch = integer("route_epoch", 1);
  const inviteCount = integer("invite_count");
  const routeCount = integer("route_count");
  const timerCount = integer("timer_count");
  if (integer("unrouted_timer_count") !== 0)
    throw new Error("empty-timer-handoff-unrouted-timers");
  const inviteIds: string[] = [];
  for (const page of results.slice(1, -1)) {
    if (page.results.length > EMPTY_ROUTING_PAGE_SIZE) invalid();
    for (const row of page.results) {
      if (typeof row.invite_id !== "string" || !isSafeRecordKey(row.invite_id))
        invalid();
      inviteIds.push(row.invite_id);
    }
  }
  if (
    inviteIds.length !== inviteCount ||
    inviteIds.length > MAX_EMPTY_ROUTING_INVITES ||
    new Set(inviteIds).size !== inviteCount
  )
    invalid();
  const evidence = {
    schemaVersion: 1 as const,
    generation: 3 as const,
    dataEpoch: 1 as const,
    routeEpoch,
    inviteIds,
    routeCount,
    timerCount,
    unroutedTimerCount: 0 as const,
  };
  return { ...evidence, routingDigest: await hashTimerHandoff(evidence) };
}
