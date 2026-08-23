export const AUTH_RECOVERY_QUEUE_NAME = "mons-link-auth-recovery";
export const AUTH_RECOVERY_DLQ_NAME = "mons-link-auth-recovery-dlq";
const INITIAL_DELAY_SECONDS = 60;

export type AuthRecoveryTask = {
  kind: "auth-profile-recovery";
  profileId: string;
};

export function parseAuthRecoveryTask(value: unknown): AuthRecoveryTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const task = value as Record<string, unknown>;
  const profileId =
    typeof task.profileId === "string" ? task.profileId.trim() : "";
  return task.kind === "auth-profile-recovery" &&
    profileId &&
    !profileId.includes("/") &&
    Object.keys(task).length === 2
    ? { kind: "auth-profile-recovery", profileId }
    : null;
}

export async function enqueueAuthRecovery(
  env: Env,
  profileId: string,
): Promise<void> {
  await env.AUTH_RECOVERY_QUEUE.send(
    { kind: "auth-profile-recovery", profileId } satisfies AuthRecoveryTask,
    { delaySeconds: INITIAL_DELAY_SECONDS },
  );
}
