import { isSessionId } from "@mons/shared/session-auth";
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

declare const retainedAttachment: unique symbol;
declare const retainedKey: unique symbol;
export type RetainedSocketAttachment = {
  readonly [retainedAttachment]: true;
};
export type RetainedInviteKey = { readonly [retainedKey]: "invite" };
export type RetainedMatchKey = { readonly [retainedKey]: "match" };
export type SocketMatchKey = string | RetainedMatchKey;
export type SocketInviteKey = string | RetainedInviteKey;

type AttachmentFields = {
  channel?: unknown;
  schemaVersion?: unknown;
  authenticated?: unknown;
  sid?: unknown;
  authExpiresAtMs?: unknown;
  inviteId?: unknown;
  matchId?: unknown;
  role?: unknown;
  actorUid?: unknown;
};

function fields(value: RetainedSocketAttachment): AttachmentFields {
  const retained: unknown = value;
  return retained as AttachmentFields;
}

export function readSocketAttachment(
  socket: Pick<WebSocket, "deserializeAttachment">,
): RetainedSocketAttachment {
  const value: unknown = socket.deserializeAttachment();
  return value as RetainedSocketAttachment;
}

export function readOptionalSocketAttachment(
  socket: Pick<WebSocket, "deserializeAttachment"> | undefined,
): RetainedSocketAttachment {
  const value: unknown = socket?.deserializeAttachment();
  return value as RetainedSocketAttachment;
}

export function socketAttachmentChannel(
  value: RetainedSocketAttachment,
): unknown {
  return fields(value)?.channel;
}

export function socketAttachmentSchemaVersion(
  value: RetainedSocketAttachment,
): unknown {
  return fields(value)?.schemaVersion;
}

export function socketAttachmentMatchKey(
  value: RetainedSocketAttachment,
): RetainedMatchKey {
  return fields(value).matchId as RetainedMatchKey;
}

export function readSocketMatchGroupKey(
  socket: Pick<WebSocket, "deserializeAttachment">,
): RetainedMatchKey {
  const { matchId } = socket.deserializeAttachment() as { matchId: unknown };
  return matchId as RetainedMatchKey;
}

export function socketAttachmentInviteKey(
  value: RetainedSocketAttachment,
): RetainedInviteKey {
  return fields(value)?.inviteId as RetainedInviteKey;
}

export function socketAttachmentMatches(
  value: RetainedSocketAttachment,
  matchId: SocketMatchKey,
): boolean {
  return fields(value).matchId === matchId;
}

export function unsupportedReactionAttachment(
  value: RetainedSocketAttachment,
): boolean {
  const attachment = fields(value);
  return (
    (attachment?.channel === undefined || attachment.channel === "reaction") &&
    attachment?.schemaVersion !== 2
  );
}

export function socketAttachmentRequiresSession(
  value: RetainedSocketAttachment,
  tags: () => string[],
): boolean {
  const attachment = fields(value);
  return (
    attachment?.authenticated === true || tags().some(isParticipantSocketTag)
  );
}

export function socketAttachmentSessionCurrent(
  value: RetainedSocketAttachment,
): boolean {
  const attachment = fields(value);
  return (
    attachment?.authenticated === true &&
    isSessionId(attachment.sid) &&
    Number.isSafeInteger(attachment.authExpiresAtMs) &&
    (attachment.authExpiresAtMs as number) > Date.now()
  );
}

export function nextSocketAttachmentExpiry(
  next: number | null,
  value: RetainedSocketAttachment,
): number | null {
  const attachment = fields(value);
  return attachment?.authenticated === true
    ? Math.min(next ?? Infinity, attachment.authExpiresAtMs as number)
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
> = {
  (attachment: InviteSocketAccess, source: Source): boolean;
  (attachment: RetainedSocketAttachment, source: Source): unknown;
};

export function retainedSocketCanReceiveInvite(
  value: InviteSocketAccess | RetainedSocketAttachment,
  source: InviteSocketAccessSource,
): unknown {
  const retained: unknown = value;
  const attachment = retained as AttachmentFields;
  if (attachment.role === "host") {
    return (
      attachment.authenticated && attachment.actorUid === source.snapshot.hostId
    );
  }
  if (attachment.role === "guest") {
    return (
      attachment.authenticated &&
      source.snapshot.guestId !== null &&
      attachment.actorUid === source.snapshot.guestId
    );
  }
  return (
    source.snapshot.guestId !== null ||
    (attachment.authenticated && !source.passwordProtected)
  );
}

export function untrimmedSocketInviteKey(inviteId: SocketInviteKey): boolean {
  return inviteId !== (inviteId as unknown as { trim(): unknown }).trim();
}

export function untrimmedSocketMatchKey(matchId: SocketMatchKey): boolean {
  return matchId !== (matchId as unknown as { trim(): unknown }).trim();
}

export function socketMatchKeyBinding(matchId: SocketMatchKey): unknown {
  return matchId;
}
