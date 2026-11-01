import { readInviteDocument } from "@mons/shared/invite-records";
import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  isInviteMetadataSnapshot,
  type InviteMetadataSnapshot,
} from "@mons/shared/invite-metadata";

export type InviteMetadataReadResult =
  | {
      status: "ok";
      snapshot: InviteMetadataSnapshot;
      passwordProtected: boolean;
      automatchOperationIds: Record<string, string>;
    }
  | { status: "missing" | "invalid" };

export function normalizeInviteMetadata(
  inviteId: string,
  value: unknown,
): InviteMetadataReadResult {
  if (value === null || value === undefined) return { status: "missing" };
  const invite = readInviteDocument(value);
  if (!invite) return { status: "invalid" };
  const snapshot: InviteMetadataSnapshot = {
    inviteId,
    revision: 0,
    hostId: invite.hostId,
    guestId: invite.guestId,
    hostColor: invite.hostColor,
    hostRematches: invite.hostRematches,
    guestRematches: invite.guestRematches,
    automatchStateHint: invite.automatchStateHint,
    eventId: invite.eventId,
    eventOwned: invite.eventOwned,
  };
  if (
    !isInviteMetadataSnapshot(snapshot) ||
    new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, type: "snapshot", snapshot }),
    ).byteLength > INVITE_METADATA_MAX_MESSAGE_BYTES
  )
    return { status: "invalid" };
  return {
    status: "ok",
    snapshot,
    passwordProtected: invite.password !== null,
    automatchOperationIds: structuredClone(invite.automatchOperationIds),
  };
}
