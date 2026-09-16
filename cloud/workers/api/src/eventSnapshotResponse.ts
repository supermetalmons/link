import {
  MAX_EVENT_READ_RESPONSE_BYTES,
  eventSnapshotEtag,
  isEventSnapshotResponse,
  isEventSnapshotSeed,
  type EventSnapshotResponse,
  type EventSnapshotSeed,
} from "@mons/shared/events";
import { AuthApiFailure } from "./authErrors.ts";
import {
  requireEventBookmarkEpoch,
  scopeEventBookmark,
} from "./eventBookmarks.ts";
import {
  readEventSnapshotIfChanged,
  type ConditionalSnapshot,
} from "./eventD1.ts";

export const EVENT_SNAPSHOT_ENRICHMENT_TIMEOUT_MS = 1_000;

export type EventSnapshotSeedDependencies = {
  readEventSnapshotSeed?: (eventId: string) => Promise<EventSnapshotSeed>;
};

export function isBoundedEventResponse(value: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    MAX_EVENT_READ_RESPONSE_BYTES
  );
}

export async function readEventSnapshotResponse(
  session: D1DatabaseSession,
  eventId: string,
  revision: number | null = null,
): Promise<ConditionalSnapshot<EventSnapshotResponse>> {
  const result = await readEventSnapshotIfChanged(session, eventId, revision);
  if (result.notModified) return result;
  const snapshot: unknown = { ok: true, ...result.snapshot };
  if (!isEventSnapshotResponse(snapshot))
    throw new AuthApiFailure(503, "unavailable", "event-data-invalid");
  if (!isBoundedEventResponse(snapshot))
    throw new AuthApiFailure(503, "unavailable", "event-response-too-large");
  return { notModified: false, snapshot };
}

export async function readPrimaryEventSnapshotSeed(
  env: Env,
  eventId: string,
): Promise<EventSnapshotSeed> {
  const epoch = requireEventBookmarkEpoch(env.EVENT_DB_BOOKMARK_EPOCH);
  const session = env.EVENT_DB.withSession("first-primary");
  const result = await readEventSnapshotResponse(session, eventId);
  if (result.notModified) throw new Error("event-snapshot-unavailable");
  return {
    snapshot: result.snapshot,
    etag: eventSnapshotEtag(eventId, result.snapshot.revision),
    bookmark: scopeEventBookmark(session.getBookmark(), epoch),
  };
}

export async function readOptionalEventSnapshotSeed(
  env: Env,
  eventId: string,
  signal: AbortSignal,
  dependencies: EventSnapshotSeedDependencies = {},
): Promise<EventSnapshotSeed | null> {
  if (signal.aborted) return null;
  const deadline = Date.now() + EVENT_SNAPSHOT_ENRICHMENT_TIMEOUT_MS;
  let cancel: () => void = () => undefined;
  const cancellation = new Promise<null>((resolve) => {
    cancel = () => resolve(null);
  });
  const timer = setTimeout(cancel, EVENT_SNAPSHOT_ENRICHMENT_TIMEOUT_MS);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const seed = await Promise.race([
      Promise.resolve().then(() =>
        dependencies.readEventSnapshotSeed
          ? dependencies.readEventSnapshotSeed(eventId)
          : readPrimaryEventSnapshotSeed(env, eventId),
      ),
      cancellation,
    ]);
    return !signal.aborted &&
      Date.now() < deadline &&
      isEventSnapshotSeed(seed) &&
      seed.snapshot.eventId === eventId &&
      isBoundedEventResponse(seed.snapshot)
      ? seed
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
