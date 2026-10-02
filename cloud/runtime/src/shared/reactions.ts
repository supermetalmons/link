import type {
  MatchPresentation,
  MatchPresentationSnapshot,
} from "./match-presentation.js";
import { normalizeRecordKey } from "./ids.js";
import { VALID_REACTION_IDS } from "./nfts.js";
import { parseInviteMatchIndex } from "./rematches.js";
import {
  isMatchPresentation,
  isMatchPresentationSnapshot,
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

export type SendInviteReactionResponse = { ok: true };

const REACTION_PROTOCOL_VERSION = 2;
const REACTION_MAX_MESSAGE_BYTES = 4096;
const REACTION_HEARTBEAT_REQUEST = "ping";
const REACTION_HEARTBEAT_RESPONSE = "pong";
const REACTION_SOCKET_PROTOCOL = "mons-reactions-v2";
const REACTION_AUTH_PROTOCOL_PREFIX = "bearer.";
const FIXED_STICKER_IDS: readonly number[] = Object.freeze([
  900316, 900101, 900393, 90063, 900109, 900228, 900245, 900189, 900267, 900374,
  900347, 900382, 900429, 900225, 900999,
]);
const STICKER_ID_WHITELIST: readonly number[] = Object.freeze([
  ...VALID_REACTION_IDS,
  ...FIXED_STICKER_IDS,
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOICE_VARIATIONS = Object.freeze({
  yo: 4,
  gg: 2,
  wahoo: 1,
  drop: 1,
  slurp: 1,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
};

const isExactKey = (value: unknown): value is string =>
  typeof value === "string" && normalizeRecordKey(value) === value;

const isReactionSocketToken = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= REACTION_MAX_MESSAGE_BYTES &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

function hasReactionFields(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.uuid !== "string" ||
    !UUID_PATTERN.test(value.uuid) ||
    typeof value.kind !== "string" ||
    !Number.isSafeInteger(value.variation) ||
    (value.variation as number) < 1
  ) {
    return false;
  }
  return value.kind === "sticker"
    ? (STICKER_ID_WHITELIST as readonly unknown[]).includes(value.variation)
    : Object.hasOwn(VOICE_VARIATIONS, value.kind) &&
        (value.variation as number) <=
          VOICE_VARIATIONS[value.kind as keyof typeof VOICE_VARIATIONS];
}

const isInviteReaction = (value: unknown): value is InviteReaction =>
  hasReactionFields(value) &&
  hasExactKeys(value, ["uuid", "kind", "variation", "matchId"]) &&
  isExactKey(value.matchId);

const isInviteReactionForInvite = (
  inviteId: string,
  value: unknown,
): value is InviteReaction =>
  isExactKey(inviteId) &&
  isInviteReaction(value) &&
  parseInviteMatchIndex(inviteId, value.matchId) !== null;

const isSendInviteReactionResponse = (
  value: unknown,
): value is SendInviteReactionResponse =>
  isRecord(value) && value.ok === true && hasExactKeys(value, ["ok"]);

function isInviteRoomMessage(value: unknown): value is InviteRoomMessage {
  if (!isRecord(value) || value.schemaVersion !== REACTION_PROTOCOL_VERSION)
    return false;
  if (value.type === "presentation") {
    return (
      hasExactKeys(value, ["schemaVersion", "type", "presentation"]) &&
      isMatchPresentation(value.presentation)
    );
  }
  if (value.type === "snapshot") {
    return (
      hasExactKeys(value, [
        "schemaVersion",
        "type",
        "reactions",
        "presentation",
      ]) &&
      isRecord(value.reactions) &&
      Object.keys(value.reactions).length <= 2 &&
      Object.entries(value.reactions).every(
        ([senderUid, reaction]) =>
          isExactKey(senderUid) && isInviteReaction(reaction),
      ) &&
      isMatchPresentationSnapshot(value.presentation)
    );
  }
  return (
    value.type === "reaction" &&
    hasExactKeys(value, ["schemaVersion", "type", "senderUid", "reaction"]) &&
    isExactKey(value.senderUid) &&
    isInviteReaction(value.reaction)
  );
}

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
