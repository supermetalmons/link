import { canonicalReceiptJson, sha256Hex } from "../src/canonicalJson.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "../src/recordKeys.ts";
import type {
  MatchStateClaimTimerRequest,
  MatchStateMoveRequest,
  MatchStateStartTimerRequest,
  MatchStateSurrenderRequest,
} from "../src/matchStateTypes.ts";
import type {
  MatchStateCreateWireRequest,
  MatchStateEventEffectsWireRequest,
} from "../src/matchStateWire.ts";

export type TimerWriterMutation =
  | { kind: "create"; request: MatchStateCreateWireRequest }
  | { kind: "move"; request: MatchStateMoveRequest }
  | { kind: "surrender"; request: MatchStateSurrenderRequest }
  | { kind: "start-timer"; request: MatchStateStartTimerRequest }
  | { kind: "claim-timer"; request: MatchStateClaimTimerRequest }
  | { kind: "event-effects"; request: MatchStateEventEffectsWireRequest }
  | { kind: "alarm"; request: { objectId: string } };

export type TimerHandoffIdentity = {
  schemaVersion: 1;
  handoffId: string;
  inviteId: string;
  objectId: string;
};

export type TimerHandoffOwnership = {
  actorUid: string;
  matchId: string;
  opponentUid: string | null;
};

export type TimerHandoffMarker = {
  matchId: string;
  playerId: string;
  opponentId: string;
  turnNumber: number;
  deadlineAtMs: number;
  updatedAtMs: number;
};

export type TimerHandoffSnapshot = TimerHandoffIdentity & {
  ownership: TimerHandoffOwnership[];
  ownershipDigest: string;
  markers: TimerHandoffMarker[];
  snapshotDigest: string;
  d1FenceReceiptDigest: string;
};

export type TimerHandoffCopyReceipt = TimerHandoffIdentity & {
  ownershipDigest: string;
  snapshotDigest: string;
  revision: number;
  markerCount: number;
  receiptDigest: string;
};

export type TimerHandoffAcknowledgement = TimerHandoffIdentity & {
  ownershipDigest: string;
  snapshotDigest: string;
  receiptDigest: string;
  deletionAckDigest: string;
};

export type TimerHandoffBegin = TimerHandoffIdentity & {
  expectedRevision: number;
};

export type TimerHandoffEmptyIdentity = {
  schemaVersion: 1;
  cleanupId: string;
  handoffId: string;
  objectId: string;
};

export type TimerHandoffEmptyReceipt = TimerHandoffEmptyIdentity & {
  kind: "empty-local-layout";
  revision: number;
  routingDigest: string;
  receiptDigest: string;
};

export type TimerHandoffPhase =
  "open" | "draining" | "copying" | "copied" | "sealing-empty";

export type TimerHandoffInspection = {
  schemaVersion: 1;
  inviteId: string | null;
  objectId: string;
  revision: number;
  phase: TimerHandoffPhase;
  handoffId: string | null;
  ownership: TimerHandoffOwnership[];
  pendingWriters: {
    writerId: string;
    revision: number;
    incarnation: string;
    kind: string;
    mutationId: string;
    inputDigest: string;
    outcome: "unknown" | "committed" | "completed" | "failed";
    currentIncarnation: boolean;
  }[];
  receipt: TimerHandoffCopyReceipt | null;
  acknowledgement: TimerHandoffAcknowledgement | null;
  emptySeal: TimerHandoffEmptyReceipt | null;
};

function invalid(): never {
  throw new TypeError("invalid-timer-handoff-record");
}

function object(value: unknown, fields: readonly string[]) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const row: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  if (
    Object.keys(row).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(row, field))
  )
    return invalid();
  return row;
}

function key(value: unknown): string {
  if (typeof value !== "string" || !isSafeRecordKey(value)) return invalid();
  return value;
}

function actor(value: unknown): string {
  if (typeof value !== "string" || !isCanonicalLoginUid(value))
    return invalid();
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    return invalid();
  return value as number;
}

export function timerHandoffDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    return invalid();
  return value;
}

const IDENTITY_FIELDS = ["schemaVersion", "handoffId", "inviteId", "objectId"];

function identity(row: Record<string, unknown>): TimerHandoffIdentity {
  if (
    row.schemaVersion !== 1 ||
    typeof row.objectId !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.objectId)
  )
    return invalid();
  return {
    schemaVersion: 1,
    handoffId: key(row.handoffId),
    inviteId: key(row.inviteId),
    objectId: row.objectId,
  };
}

export function parseTimerHandoffIdentity(
  value: unknown,
): TimerHandoffIdentity {
  return identity(object(value, IDENTITY_FIELDS));
}

export function parseTimerHandoffBegin(value: unknown): TimerHandoffBegin {
  const row = object(value, [...IDENTITY_FIELDS, "expectedRevision"]);
  return { ...identity(row), expectedRevision: integer(row.expectedRevision) };
}

export function parseTimerHandoffOwnership(
  value: unknown,
): TimerHandoffOwnership[] {
  if (!Array.isArray(value)) return invalid();
  const entries = value.map((item: unknown) => {
    const row = object(item, ["actorUid", "matchId", "opponentUid"]);
    const entry = {
      actorUid: actor(row.actorUid),
      matchId: key(row.matchId),
      opponentUid: row.opponentUid === null ? null : actor(row.opponentUid),
    };
    if (entry.actorUid === entry.opponentUid) return invalid();
    return entry;
  });
  entries.sort((left, right) =>
    left.matchId < right.matchId
      ? -1
      : left.matchId > right.matchId
        ? 1
        : left.actorUid < right.actorUid
          ? -1
          : left.actorUid > right.actorUid
            ? 1
            : 0,
  );
  const keys = new Set(
    entries.map((entry) => JSON.stringify([entry.matchId, entry.actorUid])),
  );
  if (keys.size !== entries.length) return invalid();
  for (const entry of entries) {
    const group = entries.filter((other) => other.matchId === entry.matchId);
    if (group.length === 1 && entry.opponentUid === null) continue;
    if (
      group.length !== 2 ||
      entry.opponentUid === null ||
      !group.some(
        (other) =>
          other.actorUid === entry.opponentUid &&
          other.opponentUid === entry.actorUid,
      )
    )
      return invalid();
  }
  return entries;
}

export function parseTimerHandoffMarkers(value: unknown): TimerHandoffMarker[] {
  if (!Array.isArray(value)) return invalid();
  const entries = value.map((item: unknown) => {
    const row = object(item, [
      "matchId",
      "playerId",
      "opponentId",
      "turnNumber",
      "deadlineAtMs",
      "updatedAtMs",
    ]);
    const entry = {
      matchId: key(row.matchId),
      playerId: actor(row.playerId),
      opponentId: actor(row.opponentId),
      turnNumber: integer(row.turnNumber),
      deadlineAtMs: integer(row.deadlineAtMs, 1),
      updatedAtMs: integer(row.updatedAtMs),
    };
    if (entry.playerId === entry.opponentId) return invalid();
    return entry;
  });
  entries.sort((left, right) =>
    left.matchId < right.matchId
      ? -1
      : left.matchId > right.matchId
        ? 1
        : left.playerId < right.playerId
          ? -1
          : left.playerId > right.playerId
            ? 1
            : 0,
  );
  if (
    new Set(
      entries.map((entry) => JSON.stringify([entry.matchId, entry.playerId])),
    ).size !== entries.length
  )
    return invalid();
  return entries;
}

export function timerHandoffJson(value: unknown): string {
  return canonicalReceiptJson(value, invalid);
}

export function hashTimerHandoff(value: unknown): Promise<string> {
  return sha256Hex(timerHandoffJson(value));
}

export async function timerHandoffOwnershipDigest(
  input: TimerHandoffIdentity,
  ownership: readonly TimerHandoffOwnership[],
): Promise<string> {
  return hashTimerHandoff({
    ...parseTimerHandoffIdentity(input),
    ownership: parseTimerHandoffOwnership(ownership),
  });
}

export async function timerHandoffSnapshotDigest(
  ownershipDigest: string,
  markers: readonly TimerHandoffMarker[],
): Promise<string> {
  return hashTimerHandoff({
    schemaVersion: 1,
    ownershipDigest: timerHandoffDigest(ownershipDigest),
    markers: parseTimerHandoffMarkers(markers),
  });
}

export function parseTimerHandoffSnapshot(
  value: unknown,
): TimerHandoffSnapshot {
  const row = object(value, [
    ...IDENTITY_FIELDS,
    "ownership",
    "ownershipDigest",
    "markers",
    "snapshotDigest",
    "d1FenceReceiptDigest",
  ]);
  const ownership = parseTimerHandoffOwnership(row.ownership);
  const markers = parseTimerHandoffMarkers(row.markers);
  for (const marker of markers)
    if (
      !ownership.some(
        (entry) =>
          entry.matchId === marker.matchId &&
          entry.actorUid === marker.playerId &&
          entry.opponentUid === marker.opponentId,
      )
    )
      return invalid();
  return {
    ...identity(row),
    ownership,
    markers,
    ownershipDigest: timerHandoffDigest(row.ownershipDigest),
    snapshotDigest: timerHandoffDigest(row.snapshotDigest),
    d1FenceReceiptDigest: timerHandoffDigest(row.d1FenceReceiptDigest),
  };
}

export function parseTimerHandoffCopyReceipt(
  value: unknown,
): TimerHandoffCopyReceipt {
  const row = object(value, [
    ...IDENTITY_FIELDS,
    "ownershipDigest",
    "snapshotDigest",
    "revision",
    "markerCount",
    "receiptDigest",
  ]);
  return {
    ...identity(row),
    ownershipDigest: timerHandoffDigest(row.ownershipDigest),
    snapshotDigest: timerHandoffDigest(row.snapshotDigest),
    revision: integer(row.revision, 1),
    markerCount: integer(row.markerCount),
    receiptDigest: timerHandoffDigest(row.receiptDigest),
  };
}

export async function timerHandoffCopyReceipt(
  value: Omit<TimerHandoffCopyReceipt, "receiptDigest">,
): Promise<TimerHandoffCopyReceipt> {
  const receiptDigest = await hashTimerHandoff(value);
  return parseTimerHandoffCopyReceipt({ ...value, receiptDigest });
}

export function parseTimerHandoffAcknowledgement(
  value: unknown,
): TimerHandoffAcknowledgement {
  const row = object(value, [
    ...IDENTITY_FIELDS,
    "ownershipDigest",
    "snapshotDigest",
    "receiptDigest",
    "deletionAckDigest",
  ]);
  return {
    ...identity(row),
    ownershipDigest: timerHandoffDigest(row.ownershipDigest),
    snapshotDigest: timerHandoffDigest(row.snapshotDigest),
    receiptDigest: timerHandoffDigest(row.receiptDigest),
    deletionAckDigest: timerHandoffDigest(row.deletionAckDigest),
  };
}

export function parseTimerHandoffEmptyIdentity(
  value: unknown,
): TimerHandoffEmptyIdentity {
  const row = object(value, [
    "schemaVersion",
    "cleanupId",
    "handoffId",
    "objectId",
  ]);
  if (
    row.schemaVersion !== 1 ||
    typeof row.objectId !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.objectId)
  )
    return invalid();
  return {
    schemaVersion: 1,
    cleanupId: key(row.cleanupId),
    handoffId: key(row.handoffId),
    objectId: row.objectId,
  };
}

export function parseTimerHandoffEmptyReceipt(
  value: unknown,
): TimerHandoffEmptyReceipt {
  const row = object(value, [
    "schemaVersion",
    "cleanupId",
    "handoffId",
    "objectId",
    "kind",
    "revision",
    "routingDigest",
    "receiptDigest",
  ]);
  if (row.kind !== "empty-local-layout") return invalid();
  return {
    ...parseTimerHandoffEmptyIdentity({
      schemaVersion: row.schemaVersion,
      cleanupId: row.cleanupId,
      handoffId: row.handoffId,
      objectId: row.objectId,
    }),
    kind: "empty-local-layout",
    revision: integer(row.revision, 1),
    routingDigest: timerHandoffDigest(row.routingDigest),
    receiptDigest: timerHandoffDigest(row.receiptDigest),
  };
}
