import { isSafeFirestoreDocumentId } from "./firebaseKeys.ts";

export const PROFILE_READ_PROJECTION_QUEUE_NAME =
  "mons-link-profile-projection";

export type ProfileReadProjectionTask = {
  profileId: string;
};

export type ProfileReadProjectionQueueTask = ProfileReadProjectionTask;

export function parseProfileReadProjectionTask(
  value: unknown,
): ProfileReadProjectionTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const profileId = (value as Record<string, unknown>).profileId;
  return isSafeFirestoreDocumentId(profileId) ? { profileId } : null;
}
