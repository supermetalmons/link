import { MAX_EVENT_PARTICIPANTS } from "@mons/shared/events";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";
import { captureLoginMatchDiscovery } from "./loginMatchDiscoveryD1.ts";

const EVENT_MATCH_DISCOVERY_CONCURRENCY = 4;

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

export function isPlayerMatchPath(path: string): boolean {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  return parts[0] === "players" && parts[2] === "matches" && parts.length === 4;
}

export function eventMatchCreationInviteIds(
  updates: Readonly<Record<string, unknown>>,
): string[] {
  return Object.entries(updates).flatMap(([path, value]) =>
    isPlayerMatchPath(path) && value !== null
      ? [path.replace(/^\/+|\/+$/g, "").split("/")[3]]
      : [],
  );
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
    if (typeof inviteId !== "string" || !isSafeFirebaseKey(inviteId)) {
      throw new Error("event-match-discovery-invalid-invite");
    }
    return [inviteId];
  });
}

export async function captureEventMatchDiscovery(
  db: D1Database,
  read: FirebaseRtdbClient["getPath"],
  inputInviteIds: readonly string[],
  signal?: AbortSignal,
  nowMs = Date.now(),
): Promise<void> {
  const inviteIds = [...new Set(inputInviteIds)];
  if (
    inviteIds.length > MAX_EVENT_PARTICIPANTS ||
    !inviteIds.every(isSafeFirebaseKey)
  ) {
    throw new Error("event-match-discovery-invalid-invites");
  }
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
            await read(`invites/${inviteId}`, undefined, signal),
          );
          const hostId = invite?.hostId;
          const guestId = invite?.guestId;
          if (
            !isCanonicalFirebaseUid(hostId) ||
            !isCanonicalFirebaseUid(guestId) ||
            hostId === guestId
          ) {
            throw new Error("event-match-discovery-invite-unavailable");
          }
          return Promise.all(
            [hostId, guestId].map(async (loginUid) => {
              const match = await read(
                `players/${loginUid}/matches/${inviteId}`,
                { shallow: true },
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
