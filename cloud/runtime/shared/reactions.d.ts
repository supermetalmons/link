// Generated from src/shared/reactions.ts. Run npm run generate:runtime.
import type {
  MatchPresentation,
  MatchPresentationSnapshot,
} from "./match-presentation.js";
export interface Reaction {
  uuid: string;
  variation: number;
  kind: string;
}
export interface InviteReaction extends Reaction {
  matchId: string;
}
export type InviteRoomSnapshot = {
  schemaVersion: 2;
  type: "snapshot";
  reactions: Record<string, InviteReaction>;
  presentation: MatchPresentationSnapshot;
};
export type InviteRoomReactionEvent = {
  schemaVersion: 2;
  type: "reaction";
  senderUid: string;
  reaction: InviteReaction;
};
export type InviteRoomPresentationEvent = {
  schemaVersion: 2;
  type: "presentation";
  presentation: MatchPresentation;
};
export type InviteRoomMessage =
  InviteRoomSnapshot | InviteRoomReactionEvent | InviteRoomPresentationEvent;
export type SendInviteReactionResponse = {
  ok: true;
};
declare const REACTION_PROTOCOL_VERSION = 2;
declare const REACTION_MAX_MESSAGE_BYTES = 4096;
declare const REACTION_HEARTBEAT_REQUEST = "ping";
declare const REACTION_HEARTBEAT_RESPONSE = "pong";
declare const REACTION_SOCKET_PROTOCOL = "mons-reactions-v2";
declare const REACTION_AUTH_PROTOCOL_PREFIX = "bearer.";
declare const FIXED_STICKER_IDS: readonly number[];
declare const STICKER_ID_WHITELIST: readonly number[];
declare const isReactionSocketToken: (value: unknown) => value is string;
declare const isInviteReaction: (value: unknown) => value is InviteReaction;
declare const isInviteReactionForInvite: (
  inviteId: string,
  value: unknown,
) => value is InviteReaction;
declare const isSendInviteReactionResponse: (
  value: unknown,
) => value is SendInviteReactionResponse;
declare function isInviteRoomMessage(
  value: unknown,
): value is InviteRoomMessage;
export {
  FIXED_STICKER_IDS,
  STICKER_ID_WHITELIST,
  REACTION_PROTOCOL_VERSION,
  REACTION_MAX_MESSAGE_BYTES,
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_SOCKET_PROTOCOL,
  REACTION_AUTH_PROTOCOL_PREFIX,
  isReactionSocketToken,
  isInviteReaction,
  isInviteReactionForInvite,
  isInviteRoomMessage,
  isSendInviteReactionResponse,
};
