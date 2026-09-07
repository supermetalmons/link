import { normalizeFirebaseKey } from "@mons/shared/ids";
import { changedInviteMetadataIds } from "./inviteMetadataNotifications.ts";
import {
  notifyInviteRooms,
  type InviteRoomNotificationOptions,
} from "./inviteRoomNotifications.ts";

const WAGER_SOURCE_FIELDS = new Set([
  "wagers",
  "hostId",
  "guestId",
  "password",
]);

export function changedInviteWagersIds(
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
        if (normalizeFirebaseKey(inviteId) === inviteId)
          inviteIds.add(inviteId);
      }
    } else if (
      normalizeFirebaseKey(parts[1]) === parts[1] &&
      (parts.length === 2 || WAGER_SOURCE_FIELDS.has(parts[2]))
    ) {
      inviteIds.add(parts[1]);
    }
  }
  return [...inviteIds];
}

export function notifyInviteWagersChanged(
  env: Env,
  updates: Record<string, unknown>,
  options: InviteRoomNotificationOptions = {},
): Promise<void> {
  return notifyInviteRooms(
    env,
    changedInviteWagersIds(updates),
    "notifyWagersChanged",
    "invite_wagers_notify_failed",
    options,
  );
}

export async function notifyInviteSourceChanged(
  env: Env,
  updates: Record<string, unknown>,
  metadataCommitted: boolean,
): Promise<void> {
  const metadataIds = new Set(
    metadataCommitted ? changedInviteMetadataIds(updates) : [],
  );
  await Promise.all([
    notifyInviteRooms(
      env,
      [...metadataIds],
      "notifyMetadataChanged",
      "invite_metadata_notify_failed",
    ),
    notifyInviteRooms(
      env,
      changedInviteWagersIds(updates).filter(
        (inviteId) => !metadataIds.has(inviteId),
      ),
      "notifyWagersChanged",
      "invite_wagers_notify_failed",
    ),
  ]);
}
