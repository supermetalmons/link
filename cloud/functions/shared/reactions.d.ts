export interface Reaction {
  uuid: string;
  variation: number;
  kind: string;
}

export interface InviteReaction extends Reaction {
  matchId: string;
}

export type InviteReactionSnapshot = {
  schemaVersion: 1;
  type: "snapshot";
  reactions: Record<string, InviteReaction>;
};

export type InviteReactionEvent = {
  schemaVersion: 1;
  type: "reaction";
  senderUid: string;
  reaction: InviteReaction;
};

export type InviteReactionMessage =
  InviteReactionSnapshot | InviteReactionEvent;
export type SendInviteReactionResponse = { ok: true };

export const REACTION_PROTOCOL_VERSION: 1;
export const REACTION_MAX_MESSAGE_BYTES: 4096;
export const REACTION_HEARTBEAT_REQUEST: "ping";
export const REACTION_HEARTBEAT_RESPONSE: "pong";
export const REACTION_SOCKET_PROTOCOL: "mons-reactions-v1";
export const REACTION_AUTH_PROTOCOL_PREFIX: "bearer.";
export const FIXED_STICKER_IDS: readonly number[];
export const STICKER_ID_WHITELIST: readonly number[];

export function isReaction(value: unknown): value is Reaction;
export function isReactionSocketToken(value: unknown): value is string;
export function isInviteReaction(value: unknown): value is InviteReaction;
export function isInviteReactionForInvite(
  inviteId: string,
  value: unknown,
): value is InviteReaction;
export function isInviteReactionMessage(
  value: unknown,
): value is InviteReactionMessage;
export function isSendInviteReactionResponse(
  value: unknown,
): value is SendInviteReactionResponse;
