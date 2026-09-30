import type { InviteRole } from "./game-sessions.js";
import { normalizeRecordKey } from "./ids.js";
import { GAME_SESSION_OPERATION_ID_PATTERN } from "./game-sessions.js";

export type InviteMetadataSnapshot = {
  inviteId: string;
  revision: number;
  hostId: string;
  guestId: string | null;
  hostColor: "white" | "black";
  hostRematches: string;
  guestRematches: string;
  automatchStateHint: "pending" | "matched" | "canceled" | null;
  eventId: string | null;
  eventOwned: boolean;
};

export type InviteMetadataViewer = {
  role: InviteRole;
  actorUid: string | null;
  automatchOperationId: string | null;
};

export type ReadInviteMetadataResponse = {
  ok: true;
  snapshot: InviteMetadataSnapshot;
  viewer: InviteMetadataViewer;
};

export type InviteMetadataMessage = {
  schemaVersion: 1;
  type: "snapshot";
  snapshot: InviteMetadataSnapshot;
};

const INVITE_METADATA_SOCKET_PROTOCOL = "mons-invite-metadata-v1";
const INVITE_METADATA_MAX_MESSAGE_BYTES: number = 1024 * 1024 + 16 * 1024;
const INVITE_METADATA_REFRESH_MS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const isKey = (value: unknown): value is string =>
  typeof value === "string" && normalizeRecordKey(value) === value;
const isUid = (value: unknown): value is string =>
  isKey(value) && value.length <= 128;

function isInviteMetadataSnapshot(
  value: unknown,
): value is InviteMetadataSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "inviteId",
      "revision",
      "hostId",
      "guestId",
      "hostColor",
      "hostRematches",
      "guestRematches",
      "automatchStateHint",
      "eventId",
      "eventOwned",
    ]) &&
    isKey(value.inviteId) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    isUid(value.hostId) &&
    (value.guestId === null ||
      (isUid(value.guestId) && value.guestId !== value.hostId)) &&
    (value.hostColor === "white" || value.hostColor === "black") &&
    typeof value.hostRematches === "string" &&
    typeof value.guestRematches === "string" &&
    value.hostRematches.length <= INVITE_METADATA_MAX_MESSAGE_BYTES &&
    value.guestRematches.length <= INVITE_METADATA_MAX_MESSAGE_BYTES &&
    ([null, "pending", "matched", "canceled"] as readonly unknown[]).includes(
      value.automatchStateHint,
    ) &&
    (value.eventId === null || isKey(value.eventId)) &&
    typeof value.eventOwned === "boolean"
  );
}

function isReadInviteMetadataResponse(
  value: unknown,
): value is ReadInviteMetadataResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "snapshot", "viewer"]) ||
    value.ok !== true ||
    !isInviteMetadataSnapshot(value.snapshot) ||
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, ["role", "actorUid", "automatchOperationId"])
  ) {
    return false;
  }
  const { role, actorUid, automatchOperationId } = value.viewer;
  return (
    ((role === "watch" && actorUid === null) ||
      (role === "host" && actorUid === value.snapshot.hostId) ||
      (role === "guest" &&
        value.snapshot.guestId !== null &&
        actorUid === value.snapshot.guestId)) &&
    (automatchOperationId === null ||
      (typeof automatchOperationId === "string" &&
        GAME_SESSION_OPERATION_ID_PATTERN.test(automatchOperationId)))
  );
}

function isInviteMetadataMessage(
  value: unknown,
): value is InviteMetadataMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "type", "snapshot"]) &&
    value.schemaVersion === 1 &&
    value.type === "snapshot" &&
    isInviteMetadataSnapshot(value.snapshot)
  );
}

export {
  INVITE_METADATA_SOCKET_PROTOCOL,
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_REFRESH_MS,
  isInviteMetadataSnapshot,
  isReadInviteMetadataResponse,
  isInviteMetadataMessage,
};
