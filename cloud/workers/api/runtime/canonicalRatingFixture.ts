import { createEmptyRatingPayload } from "../src/profileCanonical/contracts.ts";
import { ratingWriteRow } from "../src/profileCanonical/accountingRecords.ts";
import type { CanonicalRatingUpdateValue } from "../src/profileCanonical/types.ts";

export function canonicalRatingFixture(
  inviteId: string,
  options: {
    matchId?: string;
    eventId?: string;
    atMs?: number;
    profileState?: "pending" | "done";
    telegramState?: "pending" | "done";
    eventState?: "pending" | "done";
  } = {},
): CanonicalRatingUpdateValue {
  const matchId = options.matchId ?? "match";
  const atMs = options.atMs ?? 100;
  return {
    operationId: `${inviteId}__${matchId}`,
    inviteId,
    matchId,
    playerId: "player",
    opponentId: "opponent",
    playerProfileId: null,
    opponentProfileId: null,
    ownerUid: "owner",
    ownerToken: "token",
    status: "done",
    startedAtMs: atMs,
    updatedAtMs: atMs,
    leaseExpiresAtMs: atMs,
    completedAtMs: atMs,
    blockedAtMs: null,
    blockReason: null,
    payload: {
      ...createEmptyRatingPayload(),
      eventId: options.eventId ?? "event",
      eventOwned: true,
      isEventMatch: true,
    },
    profileGameProjectionState: options.profileState ?? "pending",
    profileGameProjectionUpdatedAtMs: 0,
    profileGameProjectionVersion: 1,
    telegramProjectionState: options.telegramState ?? "pending",
    telegramProjectionUpdatedAtMs: 0,
    telegramProjectionVersion: 1,
    eventProgressState: options.eventState ?? "pending",
    eventProgressUpdatedAtMs: 0,
    eventProgressVersion: 1,
  };
}

export function canonicalRatingInsert(
  db: D1Database,
  value: CanonicalRatingUpdateValue,
): D1PreparedStatement {
  const row = { ...ratingWriteRow(value), revision: 1 };
  return db
    .prepare(
      `INSERT INTO rating_updates_canonical (${Object.keys(row).join(", ")}) VALUES (${Object.keys(
        row,
      )
        .map(() => "?")
        .join(", ")})`,
    )
    .bind(...Object.values(row));
}
