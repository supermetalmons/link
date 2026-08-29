import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import { isSafeOperationId } from "./operationIds.ts";

export const PROFILE_GAME_PROJECTION_QUEUE_NAME =
  "mons-link-profile-game-projection";
export const PROFILE_GAME_PROJECTION_SCHEMA_VERSION = 1;

export type RatingProfileGameProjectionTask = {
  kind: "rating-profile-game-projection";
  operationId: string;
};

export type AutomatchProfileGameProjectionTask = {
  kind: "automatch-profile-game-projection";
  inviteId: string;
  requestId: string;
};

export type EventProfileGameProjectionTask = {
  kind: "event-profile-game-projection";
  eventId: string;
  requestId: string;
};

export type ProfileLinkProfileGameProjectionTask = {
  kind: "profile-link-profile-game-projection";
  loginUid: string;
  requestId: string;
};

export type ProfileGameProjectionTask =
  | AutomatchProfileGameProjectionTask
  | EventProfileGameProjectionTask
  | ProfileLinkProfileGameProjectionTask
  | RatingProfileGameProjectionTask;

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

export function parseProfileGameProjectionTask(
  value: unknown,
): ProfileGameProjectionTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const task = value as Record<string, unknown>;
  if (
    exactKeys(task, ["kind", "inviteId", "requestId"]) &&
    task.kind === "automatch-profile-game-projection" &&
    typeof task.inviteId === "string" &&
    isSafeFirebaseKey(task.inviteId) &&
    typeof task.requestId === "string" &&
    isSafeFirebaseKey(task.requestId)
  ) {
    return {
      kind: task.kind,
      inviteId: task.inviteId,
      requestId: task.requestId,
    };
  }
  if (
    exactKeys(task, ["kind", "loginUid", "requestId"]) &&
    task.kind === "profile-link-profile-game-projection" &&
    typeof task.loginUid === "string" &&
    isSafeFirebaseKey(task.loginUid) &&
    typeof task.requestId === "string" &&
    isSafeFirebaseKey(task.requestId)
  ) {
    return {
      kind: task.kind,
      loginUid: task.loginUid,
      requestId: task.requestId,
    };
  }
  if (
    exactKeys(task, ["kind", "eventId", "requestId"]) &&
    task.kind === "event-profile-game-projection" &&
    typeof task.eventId === "string" &&
    isSafeFirebaseKey(task.eventId) &&
    typeof task.requestId === "string" &&
    isSafeFirebaseKey(task.requestId)
  ) {
    return {
      kind: task.kind,
      eventId: task.eventId,
      requestId: task.requestId,
    };
  }
  return exactKeys(task, ["kind", "operationId"]) &&
    task.kind === "rating-profile-game-projection" &&
    isSafeOperationId(task.operationId)
    ? { kind: task.kind, operationId: task.operationId }
    : null;
}
