// Generated from src/shared/invite-metadata.ts. Run npm run generate:runtime.
import type { InviteRole } from "./game-sessions.js";
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
declare const INVITE_METADATA_SOCKET_PROTOCOL = "mons-invite-metadata-v1";
declare const INVITE_METADATA_MAX_MESSAGE_BYTES: number;
declare const INVITE_METADATA_REFRESH_MS = 5000;
declare function isInviteMetadataSnapshot(
  value: unknown,
): value is InviteMetadataSnapshot;
declare function isReadInviteMetadataResponse(
  value: unknown,
): value is ReadInviteMetadataResponse;
declare function isInviteMetadataMessage(
  value: unknown,
): value is InviteMetadataMessage;
export {
  INVITE_METADATA_SOCKET_PROTOCOL,
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_REFRESH_MS,
  isInviteMetadataSnapshot,
  isReadInviteMetadataResponse,
  isInviteMetadataMessage,
};
