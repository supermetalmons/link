export type InviteRoomNotificationOptions = {
  timeoutMs?: number;
  logFailure?: () => void;
};

export async function notifyInviteRooms(
  env: Env,
  inviteIds: string[],
  method: "notifyMetadataChanged" | "notifyWagersChanged",
  failureEvent: string,
  {
    timeoutMs = 1_000,
    logFailure = () => console.error({ event: failureEvent }),
  }: InviteRoomNotificationOptions = {},
): Promise<void> {
  if (!inviteIds.length || !env.INVITE_REACTIONS) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        inviteIds.map(async (inviteId) => {
          await env.INVITE_REACTIONS.getByName(inviteId)[method](inviteId);
        }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("invite-notify-timeout")),
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
