import { normalizeRecordKey } from "@mons/shared/ids";
import {
  notifyInviteRooms,
  type InviteRoomNotificationOptions,
} from "./inviteRoomNotifications.ts";

const METADATA_FIELDS = new Set([
  "version",
  "hostId",
  "hostColor",
  "guestId",
  "hostRematches",
  "guestRematches",
  "automatchStateHint",
  "automatchCanceledAt",
  "automatchOperationIds",
  "eventId",
  "eventRoundIndex",
  "eventMatchKey",
  "eventOwned",
  "password",
]);

export function changedInviteMetadataIds(
  updates: Record<string, unknown>,
): string[] {
  const inviteIds = new Set<string>();
  for (const [path, value] of Object.entries(updates)) {
    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    if (parts[0] !== "invites") continue;
    if (
      parts.length === 1 &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      for (const inviteId of Object.keys(value)) {
        if (normalizeRecordKey(inviteId) === inviteId) inviteIds.add(inviteId);
      }
    } else if (
      normalizeRecordKey(parts[1]) === parts[1] &&
      (parts.length === 2 || METADATA_FIELDS.has(parts[2]))
    ) {
      inviteIds.add(parts[1]);
    }
  }
  return [...inviteIds];
}

export function notifyInviteMetadataChanged(
  env: Env,
  updates: Record<string, unknown>,
  options: InviteRoomNotificationOptions = {},
): Promise<void> {
  return notifyInviteRooms(
    env,
    changedInviteMetadataIds(updates),
    "notifyMetadataChanged",
    "invite_metadata_notify_failed",
    options,
  );
}
