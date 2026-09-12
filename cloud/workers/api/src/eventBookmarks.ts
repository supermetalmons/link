export const MAX_EVENT_BOOKMARK_LENGTH = 2_048;

const PREFIX = "mons-d1-v1:";
const EPOCH = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const NATIVE_BOOKMARK = /^[A-Za-z0-9._~+/=-]+$/;

export function requireEventBookmarkEpoch(value: unknown): string {
  if (typeof value !== "string" || !EPOCH.test(value))
    throw new Error("event-bookmark-epoch-unavailable");
  return value.toLowerCase();
}

function validNativeBookmark(value: string): boolean {
  return (
    value.length > 0 &&
    NATIVE_BOOKMARK.test(value) &&
    value !== "first-primary" &&
    value !== "first-unconstrained"
  );
}

export function eventBookmarkConstraint(
  header: string | null | undefined,
  epoch: unknown,
): string {
  const prefix = `${PREFIX}${requireEventBookmarkEpoch(epoch)}:`;
  if (typeof header !== "string" || header.length > MAX_EVENT_BOOKMARK_LENGTH)
    return "first-primary";
  const value = header.trim();
  if (!value.startsWith(prefix)) return "first-primary";
  const native = value.slice(prefix.length);
  return validNativeBookmark(native) ? native : "first-primary";
}

export function scopeEventBookmark(
  native: string | null | undefined,
  epoch: unknown,
): string {
  const prefix = `${PREFIX}${requireEventBookmarkEpoch(epoch)}:`;
  if (
    typeof native !== "string" ||
    prefix.length + native.length > MAX_EVENT_BOOKMARK_LENGTH ||
    !validNativeBookmark(native)
  )
    throw new Error("event-bookmark-unavailable");
  return prefix + native;
}
