import { isSessionId } from "@mons/shared/session-auth";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import type { SocketSession } from "./socketSession.ts";
import { isParticipantSocketTag, type SocketRole } from "./socketTags.ts";

export type InviteChannel = "metadata" | "wagers";
export type InviteSocketAttachment = {
  channel: InviteChannel;
  schemaVersion: 1;
  inviteId: string;
  role: SocketRole;
  actorUid: string | null;
} & SocketSession;
export type MatchSocketAttachment = {
  channel: "matches";
  schemaVersion: 1;
  inviteId: string;
  matchId: string;
  role: SocketRole;
  actorUid: string | null;
} & SocketSession;
export type ReactionSocketAttachment = {
  channel: "reaction";
  schemaVersion: 2;
  matchId: string;
} & SocketSession;
export type RoomSocketAttachment =
  InviteSocketAttachment | MatchSocketAttachment | ReactionSocketAttachment;
export type SocketAttachment = RoomSocketAttachment | null;
export type SocketMatchKey = string | null;
export type SocketInviteKey = string | null;

export function decodeSocketAttachment(value: unknown): SocketAttachment {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const row = Object.fromEntries(Object.entries(value));
  const session: SocketSession | null =
    row.authenticated === false
      ? { authenticated: false }
      : row.authenticated === true &&
          isSessionId(row.sid) &&
          typeof row.authExpiresAtMs === "number" &&
          Number.isSafeInteger(row.authExpiresAtMs) &&
          row.authExpiresAtMs > 0
        ? {
            authenticated: true,
            sid: row.sid,
            authExpiresAtMs: row.authExpiresAtMs,
          }
        : null;
  if (!session) return null;
  const sessionKeys = session.authenticated
    ? ["authenticated", "sid", "authExpiresAtMs"]
    : ["authenticated"];
  const keys =
    row.channel === "reaction"
      ? ["channel", "schemaVersion", "matchId", ...sessionKeys]
      : [
          "channel",
          "schemaVersion",
          "inviteId",
          "role",
          "actorUid",
          ...sessionKeys,
          ...(row.channel === "matches" ? ["matchId"] : []),
        ];
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key))
  )
    return null;
  if (row.channel === "reaction")
    return row.schemaVersion === 2 && isSafeRecordKey(row.matchId)
      ? {
          channel: row.channel,
          schemaVersion: 2,
          matchId: row.matchId,
          ...session,
        }
      : null;
  if (
    (row.channel !== "matches" &&
      row.channel !== "metadata" &&
      row.channel !== "wagers") ||
    row.schemaVersion !== 1 ||
    !isSafeRecordKey(row.inviteId) ||
    (row.role !== "host" && row.role !== "guest" && row.role !== "spectator") ||
    (row.role === "spectator"
      ? row.actorUid !== null
      : !session.authenticated || !isCanonicalLoginUid(row.actorUid))
  )
    return null;
  const actorUid = typeof row.actorUid === "string" ? row.actorUid : null;
  if (row.channel === "matches")
    return isSafeRecordKey(row.matchId)
      ? {
          channel: row.channel,
          schemaVersion: 1,
          inviteId: row.inviteId,
          matchId: row.matchId,
          role: row.role,
          actorUid,
          ...session,
        }
      : null;
  return {
    channel: row.channel,
    schemaVersion: 1,
    inviteId: row.inviteId,
    role: row.role,
    actorUid,
    ...session,
  };
}
export function readSocketAttachment(
  socket: Pick<WebSocket, "deserializeAttachment">,
): SocketAttachment {
  try {
    return decodeSocketAttachment(socket.deserializeAttachment());
  } catch {
    return null;
  }
}
export function readOptionalSocketAttachment(
  socket: Pick<WebSocket, "deserializeAttachment"> | undefined,
): SocketAttachment {
  return socket ? readSocketAttachment(socket) : null;
}
export function socketAttachmentChannel(
  value: SocketAttachment,
): RoomSocketAttachment["channel"] | null {
  return value?.channel ?? null;
}
export function socketAttachmentSchemaVersion(
  value: SocketAttachment,
): 1 | 2 | null {
  return value?.schemaVersion ?? null;
}
export function socketAttachmentMatchKey(
  value: SocketAttachment,
): SocketMatchKey {
  return value && "matchId" in value ? value.matchId : null;
}
export function readSocketMatchGroupKey(
  socket: Pick<WebSocket, "deserializeAttachment">,
): SocketMatchKey {
  return socketAttachmentMatchKey(readSocketAttachment(socket));
}
export function socketAttachmentInviteKey(
  value: SocketAttachment,
): SocketInviteKey {
  return value && "inviteId" in value ? value.inviteId : null;
}
export function socketAttachmentMatches(
  value: SocketAttachment,
  matchId: SocketMatchKey,
): boolean {
  return value !== null && "matchId" in value && value.matchId === matchId;
}
export function unsupportedReactionAttachment(
  value: SocketAttachment,
): boolean {
  return value === null;
}
export function socketAttachmentRequiresSession(
  value: SocketAttachment,
  tags: () => string[],
): boolean {
  return value?.authenticated === true || tags().some(isParticipantSocketTag);
}
export function socketAttachmentSessionCurrent(
  value: SocketAttachment,
): boolean {
  return value?.authenticated === true && value.authExpiresAtMs > Date.now();
}
export function nextSocketAttachmentExpiry(
  next: number | null,
  value: SocketAttachment,
): number | null {
  return value?.authenticated === true
    ? Math.min(next ?? Infinity, value.authExpiresAtMs)
    : next;
}

export type InviteSocketAccess = Pick<
  InviteSocketAttachment,
  "role" | "actorUid" | "authenticated"
>;
export type InviteSocketAccessSource = {
  snapshot: { hostId: string; guestId: string | null };
  passwordProtected: boolean;
};
export type InviteSocketAccessPolicy<
  Source extends InviteSocketAccessSource = InviteSocketAccessSource,
> = (
  attachment: InviteSocketAccess | SocketAttachment,
  source: Source,
) => boolean;
export function socketCanReceiveInvite(
  attachment: InviteSocketAccess | SocketAttachment,
  source: InviteSocketAccessSource,
): boolean {
  if (attachment === null || !("role" in attachment)) return false;
  if (attachment.role === "host")
    return (
      attachment.authenticated && attachment.actorUid === source.snapshot.hostId
    );
  if (attachment.role === "guest")
    return (
      attachment.authenticated &&
      source.snapshot.guestId !== null &&
      attachment.actorUid === source.snapshot.guestId
    );
  return (
    source.snapshot.guestId !== null ||
    (attachment.authenticated && !source.passwordProtected)
  );
}
export function untrimmedSocketInviteKey(inviteId: SocketInviteKey): boolean {
  return inviteId === null || inviteId !== inviteId.trim();
}
export function untrimmedSocketMatchKey(matchId: SocketMatchKey): boolean {
  return matchId === null || matchId !== matchId.trim();
}
export function socketMatchKeyBinding(matchId: SocketMatchKey): string | null {
  return matchId;
}
