import { requireEventBookmarkEpoch } from "./eventBookmarks.ts";
import { isSafeRecordKey } from "./recordKeys.ts";

type EventUpdateNotificationEnvironment = {
  EVENT_DB_BOOKMARK_EPOCH: string;
  EVENT_UPDATES?: {
    getByName(eventId: string): {
      notifyEventChanged(
        eventId: string,
        epoch: string,
        revision: number,
      ): Promise<void>;
    };
  };
};

export async function notifyEventUpdates(
  env: EventUpdateNotificationEnvironment,
  eventRevisions: Readonly<Record<string, number>>,
  {
    timeoutMs = 1_000,
    logFailure = () => console.error({ event: "event_updates_notify_failed" }),
  }: { timeoutMs?: number; logFailure?: () => void } = {},
): Promise<void> {
  const updates = Object.entries(eventRevisions).filter(
    ([eventId, revision]) =>
      isSafeRecordKey(eventId) &&
      eventId === eventId.trim() &&
      Number.isSafeInteger(revision) &&
      revision > 0,
  );
  const namespace = env.EVENT_UPDATES;
  if (updates.length === 0 || !namespace) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const epoch = requireEventBookmarkEpoch(env.EVENT_DB_BOOKMARK_EPOCH);
    await Promise.race([
      Promise.all(
        updates.map(async ([eventId, revision]) => {
          await namespace
            .getByName(eventId)
            .notifyEventChanged(eventId, epoch, revision);
        }),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("event-updates-notify-timeout")),
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
