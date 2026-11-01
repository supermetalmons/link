import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import { parseInviteMatchIndex } from "@mons/shared/rematches";
import { isTimerClaim } from "@mons/shared/timers";
import { readMatchDocument } from "./matchRecordCodec.ts";

function invalid(): never {
  throw new TypeError("match-state-invalid-event-effects");
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  const row = Object.fromEntries(Object.entries(value));
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  )
    invalid();
  return row;
}
function key(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !isSafeRecordKey(value)
  )
    invalid();
  return value;
}
function actor(value: unknown): string {
  if (!isCanonicalLoginUid(value)) invalid();
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 128) invalid();
  return value;
}
function unique(values: string[]): void {
  if (new Set(values).size !== values.length) invalid();
}

export function parseMatchStateEventEffects(value: unknown) {
  const row = exact(value, [
    "schemaVersion",
    "inviteId",
    "epoch",
    "operationId",
    "creations",
    "terminalTimers",
    "claims",
  ]);
  if (
    row.schemaVersion !== 1 ||
    typeof row.epoch !== "number" ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1
  )
    invalid();
  const inviteId = key(row.inviteId);
  const matchId = (value: unknown) => {
    const id = key(value);
    if (parseInviteMatchIndex(inviteId, id) === null) invalid();
    return id;
  };
  const creations = list(row.creations).map((value) => {
    const creation = exact(value, ["matchId", "playerId", "value", "marker"]);
    const document = readMatchDocument(creation.value);
    if (!document) invalid();
    return {
      matchId: matchId(creation.matchId),
      playerId: actor(creation.playerId),
      value: document,
      marker: key(creation.marker),
    };
  });
  const terminalTimers = list(row.terminalTimers).map((value) => {
    const timer = exact(value, ["matchId", "playerId"]);
    return { matchId: matchId(timer.matchId), playerId: actor(timer.playerId) };
  });
  const claims = list(row.claims).map((value) => {
    const entry = exact(value, ["matchId", "playerId", "opponentId", "claim"]);
    const claim = entry.claim;
    if (
      !isTimerClaim(claim) ||
      claim.status !== "claimed" ||
      claim.inviteId !== inviteId ||
      claim.playerId !== entry.playerId ||
      claim.opponentId !== entry.opponentId
    )
      invalid();
    return {
      matchId: matchId(entry.matchId),
      playerId: actor(entry.playerId),
      opponentId: actor(entry.opponentId),
      claim,
    };
  });
  unique(
    creations.map((entry) => JSON.stringify([entry.matchId, entry.playerId])),
  );
  unique(
    terminalTimers.map((entry) =>
      JSON.stringify([entry.matchId, entry.playerId]),
    ),
  );
  unique(claims.map((entry) => entry.matchId));
  return structuredClone({
    schemaVersion: 1 as const,
    inviteId,
    epoch: row.epoch,
    operationId: key(row.operationId),
    creations,
    terminalTimers,
    claims,
  });
}
