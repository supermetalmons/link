import { isSafeFirestoreDocumentId } from "./firebaseKeys.ts";

export const PROFILE_GAME_PROJECTION_QUEUE_NAME =
  "mons-link-profile-game-projection";
export const PROFILE_GAME_PROJECTION_SCHEMA_VERSION = 1;

export type RatingProfileGameProjectionTask = {
  kind: "rating-profile-game-projection";
  operationId: string;
};

export type ProfileGameProjectionTask = RatingProfileGameProjectionTask;

export function parseProfileGameProjectionTask(
  value: unknown,
): ProfileGameProjectionTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const task = value as Record<string, unknown>;
  const keys = Object.keys(task);
  return keys.length === 2 &&
    keys.includes("kind") &&
    keys.includes("operationId") &&
    task.kind === "rating-profile-game-projection" &&
    isSafeFirestoreDocumentId(task.operationId)
    ? { kind: task.kind, operationId: task.operationId }
    : null;
}
