import { normalizeRecordKey } from "@mons/shared/ids";
import {
  notifyInviteRooms,
  type InviteRoomNotificationOptions,
} from "./inviteRoomNotifications.ts";

export type InviteSourceChanges = {
  metadataInviteIds: readonly string[];
  wagerInviteIds: readonly string[];
};

function validIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => normalizeRecordKey(id) === id);
}

export function notifyInviteSessionCommitted(
  env: Env,
  inviteIds: readonly string[],
  options: InviteRoomNotificationOptions = {},
): Promise<void> {
  return notifyInviteRooms(
    env,
    validIds(inviteIds),
    "notifySessionCommitted",
    "invite_session_notify_failed",
    options,
  );
}

export function notifyInviteWagersChanged(
  env: Env,
  inviteIds: readonly string[],
  options: InviteRoomNotificationOptions = {},
): Promise<void> {
  return notifyInviteRooms(
    env,
    validIds(inviteIds),
    "notifyWagersChanged",
    "invite_wagers_notify_failed",
    options,
  );
}

export async function notifyInviteSourceChanged(
  env: Env,
  changes: InviteSourceChanges,
): Promise<void> {
  const metadataIds = new Set(validIds(changes.metadataInviteIds));
  await Promise.all([
    notifyInviteRooms(
      env,
      [...metadataIds],
      "notifyMetadataChanged",
      "invite_metadata_notify_failed",
    ),
    notifyInviteRooms(
      env,
      validIds(changes.wagerInviteIds).filter(
        (inviteId) => !metadataIds.has(inviteId),
      ),
      "notifyWagersChanged",
      "invite_wagers_notify_failed",
    ),
  ]);
}
