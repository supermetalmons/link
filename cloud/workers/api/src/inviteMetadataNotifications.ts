import { normalizeFirebaseKey } from "@mons/shared/ids";

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
        if (normalizeFirebaseKey(inviteId) === inviteId)
          inviteIds.add(inviteId);
      }
    } else if (
      normalizeFirebaseKey(parts[1]) === parts[1] &&
      (parts.length === 2 || METADATA_FIELDS.has(parts[2]))
    ) {
      inviteIds.add(parts[1]);
    }
  }
  return [...inviteIds];
}

export async function notifyInviteMetadataChanged(
  env: Env,
  updates: Record<string, unknown>,
  {
    timeoutMs = 1_000,
    logFailure = () =>
      console.error({ event: "invite_metadata_notify_failed" }),
  }: {
    timeoutMs?: number;
    logFailure?: () => void;
  } = {},
): Promise<void> {
  const inviteIds = changedInviteMetadataIds(updates);
  if (!inviteIds.length || !env.INVITE_REACTIONS) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        inviteIds.map(async (inviteId) => {
          await env.INVITE_REACTIONS.getByName(inviteId).notifyMetadataChanged(
            inviteId,
          );
        }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("metadata-notify-timeout")),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    logFailure();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
