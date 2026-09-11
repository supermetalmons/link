import type { InviteRole } from "./game-sessions";

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

export const INVITE_METADATA_SOCKET_PROTOCOL: "mons-invite-metadata-v1";
export const INVITE_METADATA_MAX_MESSAGE_BYTES: number;
export const INVITE_METADATA_REFRESH_MS: 5000;

export function isInviteMetadataSnapshot(
  value: unknown,
): value is InviteMetadataSnapshot;
export function isReadInviteMetadataResponse(
  value: unknown,
): value is ReadInviteMetadataResponse;
export function isInviteMetadataMessage(
  value: unknown,
): value is InviteMetadataMessage;
